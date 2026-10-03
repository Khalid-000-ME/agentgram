/**
 * x402 client side.
 *
 * On a 402, read the requirements, sign an EIP-3009 `transferWithAuthorization` for the
 * requested amount, and retry with the X-PAYMENT header. The agent's wallet signs; nothing
 * custodial happens here.
 */
import { createWalletClient, http, type Account, type Hex, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { encodeHeaderJson, type PaymentPayload, type PaymentRequirements, type PaymentRequiredBody } from '@agentline/protocol';

export interface Payer {
  address: string;
  /** Produce the X-PAYMENT header value for these requirements. */
  pay(requirements: PaymentRequirements): Promise<string>;
}

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export class WalletPayer implements Payer {
  private account: Account;
  private client: WalletClient;
  private chainId: number;

  constructor(opts: { privateKey: Hex; rpcUrl?: string; chainId?: number }) {
    this.account = privateKeyToAccount(opts.privateKey);
    this.chainId = opts.chainId ?? baseSepolia.id;
    const chain = this.chainId === base.id ? base : baseSepolia;
    this.client = createWalletClient({
      account: this.account, chain,
      transport: http(opts.rpcUrl ?? (this.chainId === base.id ? 'https://mainnet.base.org' : 'https://sepolia.base.org')),
    });
  }

  get address(): string { return this.account.address; }

  async pay(req: PaymentRequirements): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.account.address,
      to: req.payTo as `0x${string}`,
      value: req.maxAmountRequired,
      validAfter: String(now - 60),
      validBefore: String(now + Math.max(60, req.maxTimeoutSeconds)),
      nonce: randomNonce(),
    };
    const signature = await this.client.signTypedData({
      account: this.account,
      domain: {
        name: req.extra?.name ?? 'USDC',
        version: req.extra?.version ?? '2',
        chainId: this.chainId,
        verifyingContract: req.asset as `0x${string}`,
      },
      types: TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    const payload: PaymentPayload = {
      x402Version: 1, scheme: 'exact', network: req.network,
      payload: { signature, authorization },
    };
    return encodeHeaderJson(payload);
  }
}

/** For tests and local runs: satisfies the flow without a funded wallet. */
export class NullPayer implements Payer {
  readonly address = '0x0000000000000000000000000000000000000000';
  async pay(): Promise<string> {
    throw new Error('this agent has no payer configured — pass { privateKey } or buy credits first');
  }
}

function randomNonce(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Buffer.from(b).toString('hex')}` as Hex;
}

export function pickRequirements(body: PaymentRequiredBody, network?: string): PaymentRequirements {
  const accepts = body.accepts ?? [];
  const match = network ? accepts.find((a) => a.network === network) : undefined;
  const chosen = match ?? accepts[0];
  if (!chosen) throw new Error('402 response contained no payment requirements');
  return chosen;
}
