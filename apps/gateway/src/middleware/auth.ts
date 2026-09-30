/**
 * Agent authentication (PRD D5, S2).
 *
 * Verifies the RFC 9421 HTTP Message Signature against the Ed25519 identity key the agent
 * registered on-chain, with a ≤60 s clock-skew window and a single-use nonce cache. The
 * payer wallet and the acting agent are deliberately independent, so this — not the x402
 * payment — is what authorises a state change.
 */
import type { NextFunction, Response } from 'express';
import { b64, idPrefix } from '@agentline/crypto';
import { AgentLineError, nonceKey, verifyRequestSignature } from '@agentline/protocol';
import { store } from '../lib/store.ts';
import type { PaidRequest } from './x402.ts';

export interface AuthedRequest extends PaidRequest {
  agentId?: string;
  deviceId?: string;
  authKeyId?: string;
}

function headerMap(req: AuthedRequest): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Resolve the signing key: an agent's identity key, or one of its device keys. */
function lookupKey(keyId: string): { agentId: string; deviceId?: string; ed25519Pk: string } | null {
  const prefix = idPrefix(keyId);
  if (prefix === 'agt') {
    const agent = store.agent(keyId);
    return agent ? { agentId: agent.agentId, ed25519Pk: agent.ed25519Pk } : null;
  }
  if (prefix === 'dev') {
    const bundle = store.db.prekeys[keyId];
    if (!bundle) return null;
    return { agentId: bundle.agentId, deviceId: keyId, ed25519Pk: bundle.ed25519Pk };
  }
  return null;
}

export interface AuthOptions {
  /** allow requests from agents that are not yet registered (registration itself) */
  allowUnregistered?: boolean;
  /** verify the signature if present but do not require it */
  optional?: boolean;
}

export function requireSignature(opts: AuthOptions = {}) {
  return function authMiddleware(req: AuthedRequest, _res: Response, next: NextFunction): void {
    const headers = headerMap(req);
    const authority = (headers['host'] ?? '').toLowerCase();

    if (!headers['signature'] && opts.optional) { next(); return; }

    const keyId = headers['agentline-key-id'] ?? '';
    let ed25519Pk: string | undefined;
    let agentId: string | undefined;
    let deviceId: string | undefined;

    const known = keyId ? lookupKey(keyId) : null;
    if (known) {
      ({ agentId, deviceId } = known);
      ed25519Pk = known.ed25519Pk;
      const agent = store.agent(known.agentId);
      if (agent?.status === 'deleted') {
        next(new AgentLineError('agent_not_found', 'agent has been tombstoned'));
        return;
      }
    } else if (opts.allowUnregistered) {
      // Registration: the key travels in the body and is bound to the agentId by derivation.
      ed25519Pk = (req.body as { ed25519Pk?: string } | undefined)?.ed25519Pk;
      agentId = keyId || undefined;
    }

    if (!ed25519Pk) {
      next(new AgentLineError(
        known === null && keyId ? 'agent_not_found' : 'signature_invalid',
        keyId ? `unknown signing key: ${keyId}` : 'missing AgentLine-Key-Id header',
      ));
      return;
    }

    const result = verifyRequestSignature({
      method: req.method,
      target: req.originalUrl,
      authority,
      headers,
      rawBody: req.rawBody ? new Uint8Array(req.rawBody) : new Uint8Array(0),
      ed25519Pk: b64.dec(ed25519Pk),
    });

    if (!result.ok) {
      const code = result.reason === 'stale' ? 'nonce_replayed' : 'signature_invalid';
      next(new AgentLineError(code, `request signature ${result.reason}`, { reason: result.reason }));
      return;
    }

    if (!store.consumeNonce(nonceKey(result.keyId, result.nonce))) {
      next(new AgentLineError('nonce_replayed', 'this signature nonce has already been used'));
      return;
    }

    req.agentId = agentId ?? result.keyId;
    req.deviceId = deviceId;
    req.authKeyId = result.keyId;
    next();
  };
}

/** Coarse per-key rate limiting (S11). */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(perMinute: number, keyFn?: (req: AuthedRequest) => string) {
  return function rateLimiter(req: AuthedRequest, res: Response, next: NextFunction): void {
    const key = keyFn?.(req) ?? req.agentId ?? req.ip ?? 'anon';
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      next(); return;
    }
    bucket.count += 1;
    if (bucket.count > perMinute) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      next(new AgentLineError('rate_limited', `rate limit of ${perMinute}/min exceeded`));
      return;
    }
    next();
  };
}
