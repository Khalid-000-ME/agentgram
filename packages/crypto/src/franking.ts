/**
 * Message franking (PRD §8.4): verifiable abuse reports that do not break E2EE.
 *
 * The sender commits to the plaintext with ft = HMAC(frankKey, body) and puts ft in the
 * public envelope; frankKey travels *inside* the ciphertext. A recipient who reports
 * reveals (body, frankKey); a moderator recomputes ft and compares it with the on-chain
 * value — proving the sender really sent that body, while unreported messages stay opaque.
 */
import { b64, equalBytes, hmac, randomBytes, sha256, utf8, type Bytes } from './primitives.ts';

export function newFrankKey(): Bytes { return randomBytes(32); }

export function frankingTag(frankKey: Bytes, body: Bytes): string {
  return b64.enc(hmac(sha256, frankKey, body).slice(0, 16));
}

export function verifyFranking(frankKeyB64: string, body: Bytes, tag: string): boolean {
  try {
    return equalBytes(b64.dec(frankingTag(b64.dec(frankKeyB64), body)), b64.dec(tag));
  } catch { return false; }
}

export function verifyFrankingJson(frankKeyB64: string, body: unknown, tag: string): boolean {
  return verifyFranking(frankKeyB64, utf8.enc(JSON.stringify(body)), tag);
}
