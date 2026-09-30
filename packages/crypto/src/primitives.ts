/**
 * AgentLine crypto primitives.
 *
 * Suite: AGL-1
 *   sign     Ed25519
 *   kex      X25519  (+ optional ML-KEM-768 hybrid -> AGL-1-PQ)
 *   kdf      HKDF-SHA-512
 *   aead     XChaCha20-Poly1305
 *   hash     keccak256 (ids) / SHA-512 (kdf) / SHA-256 (blobs)
 */
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { hmac } from '@noble/hashes/hmac';
import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes } from '@noble/hashes/utils';
import { base32nopad, base64, base64urlnopad, hex } from '@scure/base';

export { ed25519, x25519, xchacha20poly1305, sha256, sha512, keccak_256, hmac, randomBytes };

export const SUITE = 'AGL-1';
export const SUITE_PQ = 'AGL-1-PQ';

export type Bytes = Uint8Array;

/* ---------- encoding helpers ---------- */
export const b64 = {
  enc: (b: Bytes) => base64.encode(b),
  dec: (s: string) => base64.decode(s),
};
export const b64u = {
  enc: (b: Bytes) => base64urlnopad.encode(b),
  dec: (s: string) => base64urlnopad.decode(s),
};
export const b32 = {
  enc: (b: Bytes) => base32nopad.encode(b).toLowerCase(),
  dec: (s: string) => base32nopad.decode(s.toUpperCase()),
};
export const hexs = {
  enc: (b: Bytes) => '0x' + hex.encode(b),
  dec: (s: string) => hex.decode(s.startsWith('0x') ? s.slice(2) : s),
};
export const utf8 = {
  enc: (s: string) => new TextEncoder().encode(s),
  dec: (b: Bytes) => new TextDecoder().decode(b),
};

export function concat(...arrays: Bytes[]): Bytes {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) { out.set(a, o); o += a.length; }
  return out;
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- KDF ---------- */
export function kdf(ikm: Bytes, info: string, len = 32, salt?: Bytes): Bytes {
  return hkdf(sha512, ikm, salt ?? new Uint8Array(64), utf8.enc(info), len);
}

/** Split a 64-byte KDF output into two 32-byte keys. */
export function kdfPair(ikm: Bytes, info: string, salt?: Bytes): [Bytes, Bytes] {
  const out = kdf(ikm, info, 64, salt);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/* ---------- AEAD ---------- */
export const NONCE_LEN = 24;

export function aeadSeal(key: Bytes, plaintext: Bytes, aad?: Bytes): Bytes {
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return concat(nonce, ct);
}

export function aeadOpen(key: Bytes, sealed: Bytes, aad?: Bytes): Bytes {
  if (sealed.length < NONCE_LEN + 16) throw new Error('aead: ciphertext too short');
  const nonce = sealed.slice(0, NONCE_LEN);
  return xchacha20poly1305(key, nonce, aad).decrypt(sealed.slice(NONCE_LEN));
}

/** Deterministic AEAD for ratchet message keys (nonce derived from the key). */
export function aeadSealDet(key: Bytes, plaintext: Bytes, aad?: Bytes): Bytes {
  const nonce = kdf(key, 'AGL/nonce/v1', NONCE_LEN);
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function aeadOpenDet(key: Bytes, ct: Bytes, aad?: Bytes): Bytes {
  const nonce = kdf(key, 'AGL/nonce/v1', NONCE_LEN);
  return xchacha20poly1305(key, nonce, aad).decrypt(ct);
}

/* ---------- padding (S6: bucket ciphertext sizes to reduce length leakage) ---------- */
const BUCKETS = [128, 256, 512, 1024, 4096, 16384, 65536];

export function pad(data: Bytes): Bytes {
  const needed = data.length + 4;
  const bucket = BUCKETS.find((b) => b >= needed) ?? needed;
  const out = new Uint8Array(bucket);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(data, 4);
  return out;
}

export function unpad(padded: Bytes): Bytes {
  if (padded.length < 4) throw new Error('unpad: too short');
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (len > padded.length - 4) throw new Error('unpad: bad length prefix');
  return padded.slice(4, 4 + len);
}

/* ---------- sealed box (Simple mode: no forward secrecy, stateless) ---------- */
export function sealTo(recipientX25519Pub: Bytes, plaintext: Bytes, aad?: Bytes): Bytes {
  const ephSk = x25519.utils.randomPrivateKey();
  const ephPk = x25519.getPublicKey(ephSk);
  const shared = x25519.getSharedSecret(ephSk, recipientX25519Pub);
  const key = kdf(concat(shared, ephPk, recipientX25519Pub), 'AGL/sealedbox/v1');
  return concat(ephPk, aeadSeal(key, pad(plaintext), aad));
}

export function openSealed(recipientX25519Sk: Bytes, sealed: Bytes, aad?: Bytes): Bytes {
  const ephPk = sealed.slice(0, 32);
  const shared = x25519.getSharedSecret(recipientX25519Sk, ephPk);
  const recipientPk = x25519.getPublicKey(recipientX25519Sk);
  const key = kdf(concat(shared, ephPk, recipientPk), 'AGL/sealedbox/v1');
  return unpad(aeadOpen(key, sealed.slice(32), aad));
}
