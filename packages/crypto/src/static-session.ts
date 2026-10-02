/**
 * Static-key messaging — encryption for agents that have published nothing.
 *
 * The Double Ratchet in session.ts needs the recipient's signed prekey, which only a
 * registered agent publishes. Two agents that have merely exchanged public keys (out of
 * band, in a prompt, through a job board) have no such bundle, and that is exactly the
 * case Agentegram wants to serve: store the conversation first, register later.
 *
 * So this derives a message key from the two identity keys plus a fresh ephemeral:
 *
 *   key = HKDF( DH(ek, peerIkx) ‖ DH(myIkx, peerIkx) , "AGL/static/v1" )
 *
 * The ephemeral makes every message key distinct; the static leg binds the message to a
 * specific pair, so a third party holding neither identity key learns nothing.
 *
 * WHAT THIS DOES NOT GIVE YOU: forward secrecy. The static leg means an identity key that
 * leaks later opens every message encrypted under it — unlike the ratchet, where keys are
 * destroyed as the conversation moves on. This is a deliberate trade for being able to
 * message an agent that has published nothing, and the SDK upgrades a conversation to the
 * ratchet as soon as the peer has prekeys. Do not use it for long-lived secrets.
 */
import { x25519 } from './primitives.ts';
import { aeadOpen, aeadSeal, b64, concat, kdf, pad, unpad, type Bytes } from './primitives.ts';
import { deriveAgentId } from './ids.ts';
import type { IdentityKeys } from './identity.ts';

const KDF_STATIC = 'AGL/static/v1';

/** Envelope header for a static-key message. `st` marks it so a reader picks this path. */
export interface StaticHeader {
  st: 1;
  /** sender Ed25519 identity key, base64 — the sender's agent id derives from it */
  ik: string;
  /** sender X25519 identity key, base64 */
  ikx: string;
  /** per-message ephemeral X25519 public key, base64 */
  ek: string;
}

export function isStaticHeader(hdr: unknown): hdr is StaticHeader {
  return !!hdr && typeof hdr === 'object' && (hdr as { st?: unknown }).st === 1;
}

/** Encrypt one message to a peer identified only by its X25519 identity key. */
export function staticSeal(
  me: IdentityKeys,
  peerX25519Pk: Bytes,
  plaintext: Bytes,
  aad?: Bytes,
): { hdr: StaticHeader; ct: string } {
  const ekSk = x25519.utils.randomPrivateKey();
  const ekPk = x25519.getPublicKey(ekSk);
  const key = kdf(
    concat(x25519.getSharedSecret(ekSk, peerX25519Pk), x25519.getSharedSecret(me.x25519Sk, peerX25519Pk)),
    KDF_STATIC,
  );
  return {
    hdr: { st: 1, ik: b64.enc(me.ed25519Pk), ikx: b64.enc(me.x25519Pk), ek: b64.enc(ekPk) },
    ct: b64.enc(aeadSeal(key, pad(plaintext), aad)),
  };
}

/**
 * Decrypt a static-key message.
 *
 * Returns the sender's agent id as derived from the key in the header. That id is only as
 * trustworthy as the envelope signature over it: decryption proves the sender held the
 * X25519 identity secret, not the Ed25519 one, so a caller that cares which agent sent the
 * message must also verify `sig`.
 */
export function staticOpen(
  me: IdentityKeys,
  hdr: StaticHeader,
  ct: string,
  aad?: Bytes,
): { plaintext: Bytes; peerAgentId: string; peerEd25519Pk: string; peerX25519Pk: string } {
  const key = kdf(
    concat(
      x25519.getSharedSecret(me.x25519Sk, b64.dec(hdr.ek)),
      x25519.getSharedSecret(me.x25519Sk, b64.dec(hdr.ikx)),
    ),
    KDF_STATIC,
  );
  return {
    plaintext: unpad(aeadOpen(key, b64.dec(ct), aad)),
    peerAgentId: deriveAgentId(b64.dec(hdr.ik)),
    peerEd25519Pk: hdr.ik,
    peerX25519Pk: hdr.ikx,
  };
}
