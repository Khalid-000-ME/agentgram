/**
 * PQXDH handshake + Double Ratchet session (PRD D1, §7.2).
 *
 * Initiator:  DH1=IK_a·SPK_b  DH2=EK_a·IK_b  DH3=EK_a·SPK_b  DH4=EK_a·OPK_b  (+ ML-KEM ss)
 * Responder derives the same root key from the handshake header.
 * Ongoing messages use a symmetric-key + DH ratchet: forward secrecy and
 * post-compromise security, so a leaked key never opens the on-chain archive.
 */
import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import {
  SUITE, SUITE_PQ, aeadOpenDet, aeadSealDet, b64, concat, ed25519, hmac, kdf, kdfPair, pad,
  randomBytes, sha512, unpad, utf8, x25519, type Bytes,
} from './primitives.ts';
import type { IdentityKeys, KeyStoreState, PrekeyBundle } from './identity.ts';
import { identityFromStore } from './identity.ts';
import { deriveAgentId, deriveDeviceId } from './ids.ts';

export interface HandshakeHeader {
  /** initiator identity key (ed25519, base64) */ ik: string;
  /** initiator ephemeral X25519 public key */    ek: string;
  /** initiator identity X25519 public key */     ikx: string;
  /** responder signed-prekey id used */          spkId: number;
  /** responder one-time-prekey id used */        opkId?: number;
  /** responder pq prekey id + ML-KEM ciphertext */ pq?: { id: number; ct: string };
  suite: string;
}

export interface RatchetHeader {
  /** current sending ratchet public key */ dh: string;
  /** previous chain length */              pn: number;
  /** message number in current chain */     n: number;
}

export interface SessionState {
  version: 1;
  cid: string;
  role: 'initiator' | 'responder';
  peerAgentId: string;
  peerDeviceId: string;
  peerEd25519Pk: string;
  /** conversation salt (sealed mode) */
  convSalt?: string;
  rootKey: string;
  sendChainKey: string | null;
  recvChainKey: string | null;
  dhSendSk: string; dhSendPk: string;
  dhRecvPk: string | null;
  sendN: number; recvN: number; prevSendN: number;
  /** skipped message keys, "dhPk:n" -> messageKey, for out-of-order delivery */
  skipped: Record<string, string>;
  /** pending handshake header to attach to the first outbound message */
  pendingHandshake: HandshakeHeader | null;
  suite: string;
}

const MAX_SKIP = 1000;
const KDF_RK = 'AGL/ratchet/root/v1';
const KDF_CK = 'AGL/ratchet/chain/v1';
const KDF_MK = 'AGL/ratchet/msg/v1';
const KDF_ROOT_INIT = 'AGL/pqxdh/root/v1';

function dh(sk: Bytes, pk: Bytes): Bytes { return x25519.getSharedSecret(sk, pk); }

/** Initiator side of PQXDH: derive the root key and the header to publish. */
export function initiateSession(
  me: IdentityKeys,
  bundle: PrekeyBundle,
  cid: string,
  opts: { convSalt?: Bytes; pq?: boolean } = {},
): SessionState {
  const ekSk = x25519.utils.randomPrivateKey();
  const ekPk = x25519.getPublicKey(ekSk);
  const spkPk = b64.dec(bundle.signedPrekey.pk);
  const peerIkx = b64.dec(bundle.x25519Pk);

  const dhs: Bytes[] = [dh(me.x25519Sk, spkPk), dh(ekSk, peerIkx), dh(ekSk, spkPk)];
  if (bundle.oneTimePrekey) dhs.push(dh(ekSk, b64.dec(bundle.oneTimePrekey.pk)));

  let pqField: HandshakeHeader['pq'];
  const usePq = opts.pq !== false && !!bundle.pqPrekey;
  if (usePq && bundle.pqPrekey) {
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(b64.dec(bundle.pqPrekey.pk));
    dhs.push(sharedSecret);
    pqField = { id: bundle.pqPrekey.id, ct: b64.enc(cipherText) };
  }

  const rootKey = kdf(concat(...dhs), KDF_ROOT_INIT, 32);
  const suite = usePq ? SUITE_PQ : SUITE;

  const header: HandshakeHeader = {
    ik: b64.enc(me.ed25519Pk),
    ikx: b64.enc(me.x25519Pk),
    ek: b64.enc(ekPk),
    spkId: bundle.signedPrekey.id,
    opkId: bundle.oneTimePrekey?.id,
    pq: pqField,
    suite,
  };

  // Initiator immediately performs a DH ratchet step against the responder's signed prekey,
  // so the very first message already has its own chain.
  const dhSendSk = x25519.utils.randomPrivateKey();
  const state: SessionState = {
    version: 1, cid, role: 'initiator',
    peerAgentId: bundle.agentId, peerDeviceId: bundle.deviceId, peerEd25519Pk: bundle.ed25519Pk,
    convSalt: opts.convSalt ? b64.enc(opts.convSalt) : undefined,
    rootKey: b64.enc(rootKey),
    sendChainKey: null, recvChainKey: null,
    dhSendSk: b64.enc(dhSendSk), dhSendPk: b64.enc(x25519.getPublicKey(dhSendSk)),
    dhRecvPk: b64.enc(spkPk),
    sendN: 0, recvN: 0, prevSendN: 0, skipped: {},
    pendingHandshake: header, suite,
  };
  dhRatchetSend(state);
  return state;
}

/** Responder side of PQXDH: reconstruct the root key from the handshake header. */
export function acceptSession(
  store: KeyStoreState,
  header: HandshakeHeader,
  cid: string,
  peerDeviceId: string,
): SessionState {
  const me = identityFromStore(store);
  const spk = store.signedPrekey;
  if (!spk || spk.id !== header.spkId) throw new Error('handshake: unknown signed prekey id');
  const spkSk = b64.dec(spk.sk);
  const peerIk = b64.dec(header.ik);
  const peerIkx = b64.dec(header.ikx);
  const ek = b64.dec(header.ek);

  const dhs: Bytes[] = [dh(spkSk, peerIkx), dh(me.x25519Sk, ek), dh(spkSk, ek)];
  if (header.opkId !== undefined) {
    const opkSk = store.oneTimePrekeys[header.opkId];
    if (!opkSk) throw new Error('handshake: one-time prekey already consumed or unknown');
    dhs.push(dh(b64.dec(opkSk), ek));
    delete store.oneTimePrekeys[header.opkId];   // one-time: burn on use
  }
  if (header.pq) {
    const pqSk = store.pqPrekeys[header.pq.id];
    if (!pqSk) throw new Error('handshake: pq prekey unknown');
    dhs.push(ml_kem768.decapsulate(b64.dec(header.pq.ct), b64.dec(pqSk)));
  }

  const rootKey = kdf(concat(...dhs), KDF_ROOT_INIT, 32);
  // The initiator's identity key is in the handshake, and agent ids are derived from it —
  // so the responder learns who is calling without trusting the transport to tell it.
  const peerAgentId = deriveAgentId(peerIk);
  return {
    version: 1, cid, role: 'responder',
    peerAgentId,
    peerDeviceId: peerDeviceId && peerDeviceId !== 'dev_unknown' ? peerDeviceId : deriveDeviceId(peerAgentId, peerIk),
    peerEd25519Pk: header.ik,
    rootKey: b64.enc(rootKey),
    sendChainKey: null, recvChainKey: null,
    dhSendSk: spk.sk, dhSendPk: spk.pk,
    dhRecvPk: null,
    sendN: 0, recvN: 0, prevSendN: 0, skipped: {},
    pendingHandshake: null, suite: header.suite,
  };
}

function dhRatchetSend(s: SessionState): void {
  const shared = dh(b64.dec(s.dhSendSk), b64.dec(s.dhRecvPk!));
  const [rk, ck] = kdfPair(shared, KDF_RK, b64.dec(s.rootKey));
  s.rootKey = b64.enc(rk);
  s.sendChainKey = b64.enc(ck);
  s.prevSendN = s.sendN;
  s.sendN = 0;
}

function dhRatchetRecv(s: SessionState, theirDhPk: Bytes): void {
  // step 1: receiving chain from their new key and our current key
  {
    const shared = dh(b64.dec(s.dhSendSk), theirDhPk);
    const [rk, ck] = kdfPair(shared, KDF_RK, b64.dec(s.rootKey));
    s.rootKey = b64.enc(rk);
    s.recvChainKey = b64.enc(ck);
  }
  s.dhRecvPk = b64.enc(theirDhPk);
  s.recvN = 0;
  // step 2: fresh sending chain with a brand-new ratchet key
  const sk = x25519.utils.randomPrivateKey();
  s.dhSendSk = b64.enc(sk);
  s.dhSendPk = b64.enc(x25519.getPublicKey(sk));
  dhRatchetSend(s);
}

function chainStep(chainKey: Bytes): { nextChainKey: Bytes; messageKey: Bytes } {
  return {
    nextChainKey: hmac(sha512, chainKey, utf8.enc(KDF_CK)).slice(0, 32),
    messageKey: hmac(sha512, chainKey, utf8.enc(KDF_MK)).slice(0, 32),
  };
}

/**
 * Canonical header bytes for AEAD binding.
 *
 * The header travels through CBOR, which re-orders object keys, so binding to
 * JSON.stringify(hdr) would break on the wire. Serialize the fields explicitly instead.
 */
function headerBytes(hdr: RatchetHeader): Bytes {
  return utf8.enc(`AGL/hdr/v1|${hdr.dh}|${hdr.pn}|${hdr.n}`);
}

export interface EncryptedMessage {
  hdr: RatchetHeader;
  hs: HandshakeHeader | null;
  ct: string;
}

/** Encrypt a message body for this session. `aad` binds the ciphertext to the envelope. */
export function ratchetEncrypt(s: SessionState, plaintext: Bytes, aad?: Bytes): EncryptedMessage {
  if (!s.sendChainKey) {
    if (!s.dhRecvPk) throw new Error('session: cannot send before receiving the first message');
    dhRatchetSend(s);
  }
  const { nextChainKey, messageKey } = chainStep(b64.dec(s.sendChainKey!));
  s.sendChainKey = b64.enc(nextChainKey);
  const hdr: RatchetHeader = { dh: s.dhSendPk, pn: s.prevSendN, n: s.sendN };
  s.sendN += 1;
  const hs = s.pendingHandshake;
  const headerAad = concat(headerBytes(hdr), aad ?? new Uint8Array(0));
  const ct = aeadSealDet(messageKey, pad(plaintext), headerAad);
  return { hdr, hs, ct: b64.enc(ct) };
}

/** Called by the sender once the peer has replied, so the handshake stops being attached. */
export function clearPendingHandshake(s: SessionState): void { s.pendingHandshake = null; }

export function ratchetDecrypt(s: SessionState, msg: EncryptedMessage, aad?: Bytes): Bytes {
  const theirDh = b64.dec(msg.hdr.dh);
  const skipKey = `${msg.hdr.dh}:${msg.hdr.n}`;

  const saved = s.skipped[skipKey];
  if (saved) {
    delete s.skipped[skipKey];
    return openWith(b64.dec(saved), msg, aad);
  }

  if (s.dhRecvPk !== msg.hdr.dh) {
    if (s.recvChainKey && s.dhRecvPk) skipMessageKeys(s, msg.hdr.pn);
    dhRatchetRecv(s, theirDh);
  }
  skipMessageKeys(s, msg.hdr.n);

  const { nextChainKey, messageKey } = chainStep(b64.dec(s.recvChainKey!));
  s.recvChainKey = b64.enc(nextChainKey);
  s.recvN += 1;
  return openWith(messageKey, msg, aad);
}

function openWith(messageKey: Bytes, msg: EncryptedMessage, aad?: Bytes): Bytes {
  const headerAad = concat(headerBytes(msg.hdr), aad ?? new Uint8Array(0));
  return unpad(aeadOpenDet(messageKey, b64.dec(msg.ct), headerAad));
}

function skipMessageKeys(s: SessionState, until: number): void {
  if (!s.recvChainKey) return;
  if (until - s.recvN > MAX_SKIP) throw new Error('session: too many skipped messages');
  while (s.recvN < until) {
    const { nextChainKey, messageKey } = chainStep(b64.dec(s.recvChainKey));
    s.recvChainKey = b64.enc(nextChainKey);
    s.skipped[`${s.dhRecvPk}:${s.recvN}`] = b64.enc(messageKey);
    s.recvN += 1;
  }
}

/** Crypto-shredding (PRD D6): drop retained keys so ciphertext becomes unreadable forever. */
export function shredSession(s: SessionState): void {
  s.skipped = {};
  s.recvChainKey = null;
  s.sendChainKey = null;
  s.rootKey = b64.enc(randomBytes(32));
}

export function shredSkipped(s: SessionState, upToDhPk?: string): void {
  for (const k of Object.keys(s.skipped)) if (!upToDhPk || k.startsWith(upToDhPk)) delete s.skipped[k];
}

/* ---------- Simple mode (stateless agents, no forward secrecy — PRD D1) ---------- */
export { sealTo as simpleSeal, openSealed as simpleOpen } from './primitives.ts';

export function signBytes(sk: Bytes, data: Bytes): string { return b64.enc(ed25519.sign(data, sk)); }
export function verifyBytes(pk: string, sig: string, data: Bytes): boolean {
  try { return ed25519.verify(b64.dec(sig), data, b64.dec(pk)); } catch { return false; }
}
