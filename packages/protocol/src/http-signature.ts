/**
 * HTTP Message Signatures, RFC 9421.
 *
 * x402 proves that *someone paid*; it does not prove *which agent* is acting. Every
 * state-changing request therefore also carries an Ed25519 signature over the request
 * covered components, verified against the agent's registered identity key. Nonce +
 * created timestamp give replay protection (≤ 60 s skew, single-use nonce).
 */
import { b64, ed25519, keccak_256, randomBytes, sha256, utf8 } from '@agentline/crypto';

export const MAX_CLOCK_SKEW_SECONDS = 60;

export interface SignRequestInput {
  method: string;
  /** path + query, e.g. /v1/conversations/cnv_x/messages */
  target: string;
  /** authority (host[:port]) */
  authority: string;
  body?: string | Uint8Array;
  keyId: string;              // agentId or deviceId
  ed25519Sk: Uint8Array;
  created?: number;
  nonce?: string;
}

export interface SignatureHeaders {
  Signature: string;
  'Signature-Input': string;
  'Content-Digest'?: string;
  'AgentLine-Key-Id': string;
}

const COMPONENTS = ['@method', '@path', '@authority'] as const;

function contentDigest(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? utf8.enc(body) : body;
  return `sha-256=:${b64.enc(sha256(bytes))}:`;
}

/** Build the RFC 9421 signature base string. */
export function signatureBase(input: {
  method: string; target: string; authority: string; digest?: string; created: number; nonce: string; keyId: string;
}): string {
  const path = input.target.split('?')[0];
  const lines = [
    `"@method": ${input.method.toUpperCase()}`,
    `"@path": ${path}`,
    `"@authority": ${input.authority.toLowerCase()}`,
  ];
  if (input.digest) lines.push(`"content-digest": ${input.digest}`);
  const covered = input.digest
    ? `("@method" "@path" "@authority" "content-digest")`
    : `("@method" "@path" "@authority")`;
  const params = `${covered};created=${input.created};nonce="${input.nonce}";keyid="${input.keyId}";alg="ed25519"`;
  lines.push(`"@signature-params": ${params}`);
  return lines.join('\n');
}

export function signRequest(input: SignRequestInput): SignatureHeaders {
  const created = input.created ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? b64.enc(randomBytes(16));
  const digest = input.body !== undefined && input.body !== '' ? contentDigest(input.body) : undefined;
  const base = signatureBase({ ...input, digest, created, nonce });
  const sig = ed25519.sign(utf8.enc(base), input.ed25519Sk);
  const covered = digest
    ? `("@method" "@path" "@authority" "content-digest")`
    : `("@method" "@path" "@authority")`;
  const headers: SignatureHeaders = {
    Signature: `agl=:${b64.enc(sig)}:`,
    'Signature-Input': `agl=${covered};created=${created};nonce="${nonce}";keyid="${input.keyId}";alg="ed25519"`,
    'AgentLine-Key-Id': input.keyId,
  };
  if (digest) headers['Content-Digest'] = digest;
  return headers;
}

export interface ParsedSignature {
  sig: Uint8Array;
  created: number;
  nonce: string;
  keyId: string;
  covered: string[];
  hasDigest: boolean;
}

export function parseSignatureHeaders(headers: Record<string, string | undefined>): ParsedSignature | null {
  const sigHeader = headers['signature'] ?? headers['Signature'];
  const inputHeader = headers['signature-input'] ?? headers['Signature-Input'];
  if (!sigHeader || !inputHeader) return null;

  const sigMatch = /(?:^|,)\s*([A-Za-z0-9_-]+)=:([^:]+):/.exec(sigHeader);
  if (!sigMatch) return null;
  const label = sigMatch[1];
  const sig = b64.dec(sigMatch[2]);

  const inputRe = new RegExp(`(?:^|,)\\s*${label}=\\(([^)]*)\\)([^,]*)`);
  const inMatch = inputRe.exec(inputHeader);
  if (!inMatch) return null;
  const covered = inMatch[1].split(/\s+/).map((s) => s.replace(/"/g, '')).filter(Boolean);
  const params = inMatch[2];
  const created = Number(/created=(\d+)/.exec(params)?.[1] ?? 0);
  const nonce = /nonce="([^"]*)"/.exec(params)?.[1] ?? '';
  const keyId = /keyid="([^"]*)"/.exec(params)?.[1] ?? '';
  return { sig, created, nonce, keyId, covered, hasDigest: covered.includes('content-digest') };
}

export interface VerifyInput {
  method: string;
  target: string;
  authority: string;
  headers: Record<string, string | undefined>;
  rawBody?: Uint8Array;
  ed25519Pk: Uint8Array;
  now?: number;
}

export type VerifyResult =
  | { ok: true; keyId: string; nonce: string; created: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'digest_mismatch' | 'bad_signature' };

export function verifyRequestSignature(input: VerifyInput): VerifyResult {
  const parsed = parseSignatureHeaders(input.headers);
  if (!parsed) return { ok: false, reason: 'missing' };
  if (!parsed.keyId || !parsed.created) return { ok: false, reason: 'malformed' };

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.created) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'stale' };

  let digest: string | undefined;
  if (parsed.hasDigest) {
    const presented = input.headers['content-digest'] ?? input.headers['Content-Digest'];
    if (!presented) return { ok: false, reason: 'malformed' };
    const expected = contentDigest(input.rawBody ?? new Uint8Array(0));
    if (presented.trim() !== expected) return { ok: false, reason: 'digest_mismatch' };
    digest = presented.trim();
  }

  const base = signatureBase({
    method: input.method, target: input.target, authority: input.authority,
    digest, created: parsed.created, nonce: parsed.nonce, keyId: parsed.keyId,
  });
  const ok = ed25519.verify(parsed.sig, utf8.enc(base), input.ed25519Pk);
  return ok
    ? { ok: true, keyId: parsed.keyId, nonce: parsed.nonce, created: parsed.created }
    : { ok: false, reason: 'bad_signature' };
}

/** Stable fingerprint used to key the replay-protection nonce cache. */
export function nonceKey(keyId: string, nonce: string): string {
  return b64.enc(keccak_256(utf8.enc(`${keyId}|${nonce}`)).slice(0, 16));
}
