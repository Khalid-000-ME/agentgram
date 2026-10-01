/**
 * x402 payment middleware (PRD §9).
 *
 * Flow: an unpaid call gets `402` with machine-readable payment requirements; the agent
 * retries with a signed EIP-3009 `transferWithAuthorization` authorization; we verify it
 * (signature, asset, amount, recipient, validity window, unused nonce), settle it — via a
 * facilitator or directly with our own settler key — and return the settlement proof.
 *
 * Header compatibility: request payloads are read from `X-PAYMENT` (widely deployed) or
 * `PAYMENT-SIGNATURE` (PRD wording); proofs go back in both response header names.
 */
import type { NextFunction, Request, Response } from 'express';
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, verifyTypedData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import {
  AgentLineError, HEADERS, X402_VERSION, decodeHeaderJson, encodeHeaderJson, fromAtomic, quote,
  describe as describePrice,
  type PaymentPayload, type PaymentRequirements, type PaymentRequiredBody, type SettleResponse,
} from '@agentline/protocol';
import { config, paymentMode } from '../config.ts';
import { store } from '../lib/store.ts';
import { raiseAlert } from '../services/alerts.ts';
import { resetNonce, withNonce } from '../services/nonce-manager.ts';

/**
 * Pull the useful line out of a viem contract error.
 *
 * viem puts the revert reason several lines into the message, so the usual
 * `.split('\n')[0]` throws away the only part that tells a caller what to do — "insufficient
 * balance" and "nonce collision" are very different problems and must not both surface as
 * "transaction reverted".
 */
function revertMessage(err: unknown): string {
  const full = err instanceof Error ? err.message : String(err);
  const reason = /reverted with the following reason:\s*\n?\s*(.+)/i.exec(full)?.[1]?.trim();
  if (reason) return reason;
  const short = /(?:Details|Error):\s*(.+)/i.exec(full)?.[1]?.trim();
  return (short ?? full.split('\n')[0]).slice(0, 200);
}

/** Map a settlement failure to something the caller can act on. */
function settlementHint(reason: string): string | undefined {
  const r = reason.toLowerCase();
  if (/insufficient balance|transfer amount exceeds balance|exceeds balance/.test(r)) {
    return 'The payer wallet does not hold enough USDC for this request. Top it up and retry.';
  }
  if (/authorization is used|invalid authorization state/.test(r)) {
    return 'This payment authorization was already spent. Sign a fresh one and retry.';
  }
  if (/authorization is not yet valid|invalid authorization/.test(r)) {
    return 'The authorization validity window does not cover now — check the payer clock.';
  }
  if (/insufficient funds/.test(r)) {
    return 'The gateway settler wallet is out of gas; this is an operator problem, not yours.';
  }
  return undefined;
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const USDC_3009_ABI = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
]);

export interface PaymentContext {
  /** price-table key, e.g. "POST /v1/messages" */
  routeKey: string;
  bytes?: number;
  members?: number;
  /** explicit amount (credits top-ups) */
  amount?: string;
  /** an agent whose prepaid credits may cover this call */
  agentId?: string;
  /** a business agent sponsoring inbound messages to itself (PRD §9.3) */
  sponsorAgentId?: string;
}

export interface PaidRequest extends Request {
  payment?: {
    method: 'x402' | 'credits' | 'sponsored' | 'disabled';
    atomic: bigint;
    routeKey: string;
    payer?: string;
    txHash?: string;
    proof?: string;
  };
  rawBody?: Buffer;
  agentId?: string;
  deviceId?: string;
}

function chain() { return config.x402.chainId === base.id ? base : baseSepolia; }

function publicClient() {
  return createPublicClient({ chain: chain(), transport: http(config.x402.rpcUrl) });
}

export function requirementsFor(routeKey: string, atomic: bigint, resource: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: config.x402.network,
    caip2: config.x402.caip2,
    maxAmountRequired: atomic.toString(),
    resource,
    description: describePrice(routeKey),
    mimeType: 'application/json',
    payTo: config.x402.payTo,
    maxTimeoutSeconds: config.x402.maxTimeoutSeconds,
    asset: config.x402.asset,
    extra: { name: config.x402.assetName, version: config.x402.assetVersion },
  };
}

function paymentRequired(res: Response, routeKey: string, atomic: bigint, resource: string, error?: string): void {
  const requirements = requirementsFor(routeKey, atomic, resource);
  const body: PaymentRequiredBody = { x402Version: X402_VERSION, error, accepts: [requirements] };
  const diagnosis = error ? settlementHint(error) : undefined;
  res.setHeader(HEADERS.paymentRequired, encodeHeaderJson(body));
  res.setHeader('Cache-Control', 'no-store');
  res.status(402).json({
    ...body,
    // Human/LLM-readable hint so an agent reading the error can act without extra docs.
    hint: diagnosis
      ?? `Pay ${fromAtomic(atomic)} ${config.x402.assetName} on ${config.x402.network} to ${config.x402.payTo}, then retry with the X-PAYMENT header (base64 JSON x402 payment payload).`,
    ...(diagnosis ? { diagnosis } : {}),
  });
}

function readPaymentHeader(req: Request): string | undefined {
  const h = req.headers;
  return (h['x-payment'] as string | undefined)
    ?? (h['payment-signature'] as string | undefined)
    ?? undefined;
}

/** Cryptographically check the authorization before spending gas on settlement. */
async function verifyAuthorization(payload: PaymentPayload, required: PaymentRequirements): Promise<void> {
  const auth = payload.payload?.authorization;
  const signature = payload.payload?.signature;
  if (!auth || !signature) throw new AgentLineError('payment_invalid', 'payment payload missing authorization or signature');
  if (payload.scheme !== 'exact') throw new AgentLineError('payment_invalid', `unsupported scheme: ${payload.scheme}`);
  if (payload.network !== required.network) {
    throw new AgentLineError('payment_invalid', `wrong network: expected ${required.network}, got ${payload.network}`);
  }
  if (auth.to.toLowerCase() !== required.payTo.toLowerCase()) {
    throw new AgentLineError('payment_invalid', 'authorization pays the wrong recipient');
  }
  if (BigInt(auth.value) < BigInt(required.maxAmountRequired)) {
    throw new AgentLineError('payment_invalid',
      `insufficient amount: need ${required.maxAmountRequired}, got ${auth.value}`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now) throw new AgentLineError('payment_invalid', 'authorization not yet valid');
  if (Number(auth.validBefore) <= now + 3) throw new AgentLineError('payment_invalid', 'authorization expired');

  if (store.db.paymentNonces[auth.nonce.toLowerCase()]) {
    throw new AgentLineError('payment_invalid', 'authorization nonce already used');
  }

  const valid = await verifyTypedData({
    address: auth.from,
    domain: {
      name: required.extra?.name ?? config.x402.assetName,
      version: required.extra?.version ?? config.x402.assetVersion,
      chainId: config.x402.chainId,
      verifyingContract: required.asset as Address,
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from, to: auth.to, value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce,
    },
    signature,
  });
  if (!valid) throw new AgentLineError('payment_invalid', 'EIP-3009 signature does not recover to the payer');
}

async function settleViaFacilitator(payload: PaymentPayload, required: PaymentRequirements): Promise<SettleResponse> {
  const body = JSON.stringify({
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: { ...required, caip2: undefined },
  });
  const res = await fetch(`${config.x402.facilitatorUrl.replace(/\/$/, '')}/settle`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  const text = await res.text();
  if (!res.ok) return { success: false, network: required.network, errorReason: `facilitator ${res.status}: ${text.slice(0, 200)}` };
  try {
    const json = JSON.parse(text) as SettleResponse & { txHash?: string };
    return { ...json, transaction: json.transaction ?? json.txHash };
  } catch {
    return { success: false, network: required.network, errorReason: 'facilitator returned non-JSON' };
  }
}

/**
 * Settle ourselves: submit the payer's authorization to USDC's transferWithAuthorization.
 *
 * Under concurrent load this is where a naive implementation breaks: many payments arrive
 * at once, all settled from one settler wallet, and independently-assigned nonces collide
 * so some transfers silently replace others. Nonce assignment therefore goes through the
 * shared per-account manager — the same authority the registry writer uses, which matters
 * because the settler and the relayer are often the same wallet.
 */
async function settleDirect(payload: PaymentPayload, required: PaymentRequirements): Promise<SettleResponse> {
  const account = privateKeyToAccount(config.x402.settlerPrivateKey!);
  const wallet = createWalletClient({ account, chain: chain(), transport: http(config.x402.rpcUrl) });
  const client = publicClient();
  const a = payload.payload.authorization;
  try {
    // EIP-3009 authorizations are single-use on-chain. If this one is already consumed the
    // payment has landed, and reporting failure would charge the caller twice.
    const already = await client.readContract({
      address: required.asset as Address, abi: USDC_3009_ABI, functionName: 'authorizationState',
      args: [a.from, a.nonce],
    });
    if (already) {
      return { success: true, network: required.network, payer: a.from, errorReason: 'authorization already used on-chain' };
    }

    const hash = await withNonce(client, account.address, (nonce) => wallet.writeContract({
      address: required.asset as Address, abi: USDC_3009_ABI, functionName: 'transferWithAuthorization',
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, payload.payload.signature],
      chain: chain(), account, nonce,
    }));

    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    return {
      success: receipt.status === 'success', transaction: hash, network: required.network, payer: a.from,
      errorReason: receipt.status === 'success' ? undefined : 'transaction reverted on-chain',
    };
  } catch (err) {
    const message = revertMessage(err);
    if (/nonce/i.test(message)) resetNonce(account.address);
    // A transfer whose authorization was consumed while we were submitting still means the
    // money moved.
    if (/authorization is used|invalid authorization state/i.test(message)) {
      return { success: true, network: required.network, payer: a.from, errorReason: 'authorization consumed concurrently' };
    }
    return { success: false, network: required.network, errorReason: message };
  }
}

/**
 * Settle a verified authorization.
 *
 * Preference order, and why: a facilitator costs us no gas, so try it first; public RPCs
 * and shared facilitators fail transiently, so retry a couple of times; and if a settler
 * key is configured, fall back to submitting the transfer ourselves rather than making the
 * caller redo a payment that was already cryptographically valid.
 */
async function settle(payload: PaymentPayload, required: PaymentRequirements): Promise<SettleResponse> {
  const mode = paymentMode();
  if (mode === 'verify-only') {
    return { success: true, network: required.network, payer: payload.payload.authorization.from };
  }

  const attempts: Array<() => Promise<SettleResponse>> = [];
  if (mode === 'facilitator') {
    attempts.push(() => settleViaFacilitator(payload, required));
    attempts.push(() => settleViaFacilitator(payload, required));
    if (config.x402.settlerPrivateKey) attempts.push(() => settleDirect(payload, required));
  } else {
    attempts.push(() => settleDirect(payload, required));
    attempts.push(() => settleDirect(payload, required));
    if (config.x402.facilitatorUrl) attempts.push(() => settleViaFacilitator(payload, required));
  }

  let last: SettleResponse = { success: false, network: required.network, errorReason: 'no settlement attempted' };
  for (let i = 0; i < attempts.length; i++) {
    last = await attempts[i]();
    if (last.success) {
      if (i > 0) {
        console.warn(`[x402] settled on attempt ${i + 1}`);
        raiseAlert({
          severity: 'info',
          kind: 'x402.settlement_retried',
          title: `Payment settled only on attempt ${i + 1}`,
          detail: `The primary settlement path is unreliable. Last error before success: ${last.errorReason ?? 'unknown'}`,
          meta: { attempt: i + 1, mode, network: required.network },
        });
      }
      return last;
    }
    // An authorization already consumed on-chain means the payment did land: treat it as
    // settled rather than charging the caller twice.
    if (/already used/i.test(last.errorReason ?? '')) {
      return { ...last, success: true };
    }
    console.warn(`[x402] settlement attempt ${i + 1} failed: ${last.errorReason}`);
    if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  // Every path failed: the service is now refusing paid requests, i.e. it is down for
  // revenue purposes even though it is answering HTTP.
  // A payer with an empty wallet is their problem, not an outage. Alerting on it would
  // bury the operator in noise the moment a single agent runs dry.
  const payerFault = /insufficient balance|exceeds balance|authorization is used|not yet valid/i.test(last.errorReason ?? '');
  if (!payerFault) {
    raiseAlert({
      severity: 'critical',
      kind: 'x402.settlement_failed',
      title: 'Payment settlement is failing — paid routes are unusable',
      detail: `All ${attempts.length} settlement attempts failed. Last error: ${last.errorReason ?? 'unknown'}`,
      meta: { mode, network: required.network, facilitator: config.x402.facilitatorUrl, asset: required.asset },
    });
  }
  return last;
}

/**
 * Price and collect payment for a route. Resolution order:
 *   1. prepaid credits held by the calling agent (avoids per-message settlement latency)
 *   2. a sponsoring agent's credits (business agent pays for inbound)
 *   3. an x402 payment on this request
 */
export function requirePayment(ctxFn: (req: PaidRequest) => PaymentContext) {
  return async function x402Middleware(req: PaidRequest, res: Response, next: NextFunction): Promise<void> {
    const ctx = ctxFn(req);
    let atomic: bigint;
    try {
      atomic = quote(ctx.routeKey, ctx);
    } catch (err) {
      next(err); return;
    }

    if (paymentMode() === 'disabled') {
      req.payment = { method: 'disabled', atomic: 0n, routeKey: ctx.routeKey };
      next(); return;
    }
    if (paymentMode() === 'algorand') {
      // The Algorand rail prices the public surface up front; charging again here would
      // bill the caller twice for one request.
      req.payment = { method: 'disabled', atomic: 0n, routeKey: ctx.routeKey };
      next(); return;
    }
    if (atomic === 0n) {
      req.payment = { method: 'x402', atomic: 0n, routeKey: ctx.routeKey };
      next(); return;
    }

    // 1 & 2: credits
    for (const payerAgent of [ctx.agentId, ctx.sponsorAgentId]) {
      if (!payerAgent) continue;
      const credits = store.credits(payerAgent);
      if (BigInt(credits.balance) >= atomic) {
        credits.balance = (BigInt(credits.balance) - atomic).toString();
        credits.spent = (BigInt(credits.spent) + atomic).toString();
        credits.updatedAt = Date.now();
        store.recordRevenue(atomic);
        store.save();
        req.payment = {
          method: payerAgent === ctx.agentId ? 'credits' : 'sponsored',
          atomic, routeKey: ctx.routeKey, payer: payerAgent,
        };
        res.setHeader('AgentLine-Credits-Remaining', fromAtomic(BigInt(credits.balance)));
        next(); return;
      }
    }

    const resource = `${config.publicUrl}${req.originalUrl.split('?')[0]}`;
    const header = readPaymentHeader(req);
    if (!header) {
      if (!config.x402.payTo) {
        // Misconfiguration must not look like a client error.
        next(new AgentLineError('internal', 'X402_PAY_TO is not configured on this gateway'));
        return;
      }
      paymentRequired(res, ctx.routeKey, atomic, resource);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = decodeHeaderJson<PaymentPayload>(header);
    } catch {
      paymentRequired(res, ctx.routeKey, atomic, resource, 'payment header is not base64 JSON');
      return;
    }

    const required = requirementsFor(ctx.routeKey, atomic, resource);
    try {
      await verifyAuthorization(payload, required);
    } catch (err) {
      const message = err instanceof AgentLineError ? err.message : 'payment verification failed';
      paymentRequired(res, ctx.routeKey, atomic, resource, message);
      return;
    }

    const settlement = await settle(payload, required);

    if (!settlement.success) {
      if (config.x402.devAcceptUnsettled) {
        console.warn('[x402] settlement failed but X402_DEV_ACCEPT_UNSETTLED is on:', settlement.errorReason);
      } else {
        paymentRequired(res, ctx.routeKey, atomic, resource, settlement.errorReason ?? 'settlement failed');
        return;
      }
    }

    // Burn the authorization nonce so the same payment cannot fund two requests.
    store.db.paymentNonces[payload.payload.authorization.nonce.toLowerCase()] = Date.now();
    store.db.payments.push({
      txHash: settlement.transaction, payer: settlement.payer ?? payload.payload.authorization.from,
      amount: atomic.toString(), route: ctx.routeKey, agentId: ctx.agentId, at: Date.now(),
      settled: settlement.success, nonce: payload.payload.authorization.nonce,
    });
    if (store.db.payments.length > 5000) store.db.payments.splice(0, 1000);
    store.recordRevenue(atomic);
    store.save();

    const proof = encodeHeaderJson({
      success: settlement.success, transaction: settlement.transaction ?? null,
      network: settlement.network, payer: settlement.payer ?? payload.payload.authorization.from,
    });
    res.setHeader(HEADERS.paymentResponseV1, proof);
    res.setHeader(HEADERS.paymentResponseV2, proof);
    req.payment = {
      method: 'x402', atomic, routeKey: ctx.routeKey,
      payer: settlement.payer ?? payload.payload.authorization.from,
      txHash: settlement.transaction, proof,
    };
    next();
  };
}

/** Top up prepaid credits from a settled x402 payment. */
export function creditBalance(agentId: string): { balance: string; spent: string } {
  const c = store.credits(agentId);
  return { balance: fromAtomic(BigInt(c.balance)), spent: fromAtomic(BigInt(c.spent)) };
}

export function addCredits(agentId: string, atomic: bigint): void {
  const c = store.credits(agentId);
  c.balance = (BigInt(c.balance) + atomic).toString();
  c.updatedAt = Date.now();
  store.save();
}

export { fromAtomic, quote };
