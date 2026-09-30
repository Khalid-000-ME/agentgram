/**
 * On-chain envelope (PRD §8.1) — the only thing that ever reaches HCS.
 *
 * Encoded as CBOR to stay under the ~1 KB single-transaction budget. Contains no
 * plaintext: `ct` is the AEAD ciphertext, `hdr` the ratchet header, `hs` the optional
 * handshake, `ft` the franking tag. In sealed mode `cid` is replaced by a blinded `tag`
 * and the sender device is omitted (sealed sender) — the signature moves inside `ct`.
 */
import { decode, encode } from 'cbor-x';

export interface RatchetHeaderWire { dh: string; pn: number; n: number }

export interface Envelope {
  /** envelope version */ v: 1;
  /** conversation id (open mode) */ cid?: string;
  /** blinded conversation tag (sealed mode) */ tag?: string;
  /** conversation kind */ k: 'dm' | 'grp' | 'chn';
  /** sender device id — null for sealed sender */ sd: string | null;
  /** ratchet header (dm) or group framing {epoch,n} */ hdr: RatchetHeaderWire | { epoch: number; n: number };
  /** X3DH/PQXDH handshake, first message only */ hs?: unknown | null;
  /** AEAD ciphertext, base64 */ ct: string;
  /** Ed25519 signature over the canonical envelope bytes — omitted in sealed sender */ sig?: string | null;
  /** franking tag (§8.4) */ ft?: string;
  /** chunking for payloads > 1 tx: [index, total, chunkGroupId] */ ch?: [number, number, string];
}

/** Bytes that a sender signs / that AEAD is bound to (everything except `sig`). */
export function signingBytes(e: Envelope): Uint8Array {
  const { sig, ...rest } = e;
  return encode(canonical(rest as unknown as Record<string, unknown>));
}

export function encodeEnvelope(e: Envelope): Uint8Array {
  return encode(canonical(e as unknown as Record<string, unknown>));
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const e = decode(bytes) as Envelope;
  if (e.v !== 1) throw new Error(`unsupported envelope version: ${(e as any).v}`);
  if (!e.cid && !e.tag) throw new Error('envelope: needs cid or tag');
  if (typeof e.ct !== 'string') throw new Error('envelope: missing ciphertext');
  return e;
}

/** Deterministic key ordering so both sides hash identical bytes. */
function canonical<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = (obj as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
      ? canonical(v as Record<string, unknown>)
      : v;
  }
  return out as T;
}

export const MAX_ENVELOPE_BYTES = 1024;
export const MAX_CHUNKED_BYTES = 20 * 1024;
/** HCS caps a single submitted message; above this the SDK must chunk or use a blob. */
export const HCS_MESSAGE_LIMIT = 1024;

export function envelopeSize(e: Envelope): number {
  return encodeEnvelope(e).length;
}
