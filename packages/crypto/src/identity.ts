/**
 * Agent identity, devices and prekey bundles.
 * Private keys live only in the agent's process — never sent to the gateway (S1).
 */
import { ml_kem768 } from '@noble/post-quantum/ml-kem';
import {
  SUITE, SUITE_PQ, b64, concat, ed25519, keccak_256, randomBytes, utf8, x25519,
  type Bytes,
} from './primitives.ts';
import { deriveAgentId, deriveDeviceId, deriveKeyBundleId } from './ids.ts';

export interface IdentityKeys {
  agentId: string;
  deviceId: string;
  ed25519Sk: Bytes; ed25519Pk: Bytes;   // signing (identity)
  x25519Sk: Bytes;  x25519Pk: Bytes;    // key agreement (identity)
}

export interface Prekey { id: number; sk: Bytes; pk: Bytes }

export interface PqPrekey { id: number; sk: Bytes; pk: Bytes }

/** Everything an agent must persist to keep its identity across restarts. */
export interface KeyStoreState {
  version: 1;
  agentId: string;
  deviceId: string;
  ed25519Sk: string; ed25519Pk: string;
  x25519Sk: string;  x25519Pk: string;
  signedPrekey: { id: number; sk: string; pk: string; sig: string; createdAt: number } | null;
  oneTimePrekeys: Record<number, string>;      // id -> secret key
  pqPrekeys: Record<number, string>;           // id -> ML-KEM secret key
  nextPrekeyId: number;
}

/** Public bundle published to the gateway/chain so others can start sessions offline. */
export interface PrekeyBundle {
  suite: string;
  agentId: string;
  deviceId: string;
  bundleId: string;
  ed25519Pk: string;
  x25519Pk: string;
  signedPrekey: { id: number; pk: string; sig: string };
  oneTimePrekey?: { id: number; pk: string };
  pqPrekey?: { id: number; pk: string; sig: string };
  keyEpoch: number;
}

export function generateIdentity(): IdentityKeys {
  const ed25519Sk = ed25519.utils.randomPrivateKey();
  const ed25519Pk = ed25519.getPublicKey(ed25519Sk);
  const x25519Sk = x25519.utils.randomPrivateKey();
  const x25519Pk = x25519.getPublicKey(x25519Sk);
  const agentId = deriveAgentId(ed25519Pk);
  return { agentId, deviceId: deriveDeviceId(agentId, ed25519Pk), ed25519Sk, ed25519Pk, x25519Sk, x25519Pk };
}

export function generateDeviceIdentity(agentId: string): IdentityKeys {
  const id = generateIdentity();
  return { ...id, agentId, deviceId: deriveDeviceId(agentId, id.ed25519Pk) };
}

export function newKeyStore(id: IdentityKeys = generateIdentity()): KeyStoreState {
  return {
    version: 1,
    agentId: id.agentId,
    deviceId: id.deviceId,
    ed25519Sk: b64.enc(id.ed25519Sk), ed25519Pk: b64.enc(id.ed25519Pk),
    x25519Sk: b64.enc(id.x25519Sk),   x25519Pk: b64.enc(id.x25519Pk),
    signedPrekey: null, oneTimePrekeys: {}, pqPrekeys: {}, nextPrekeyId: 1,
  };
}

export function identityFromStore(s: KeyStoreState): IdentityKeys {
  return {
    agentId: s.agentId, deviceId: s.deviceId,
    ed25519Sk: b64.dec(s.ed25519Sk), ed25519Pk: b64.dec(s.ed25519Pk),
    x25519Sk: b64.dec(s.x25519Sk),   x25519Pk: b64.dec(s.x25519Pk),
  };
}

const SPK_CTX = utf8.enc('AGL/SPK/v1');
const PQPK_CTX = utf8.enc('AGL/PQPK/v1');

/** Rotate the signed prekey (SDK does this weekly). */
export function rotateSignedPrekey(store: KeyStoreState): KeyStoreState {
  const id = identityFromStore(store);
  const sk = x25519.utils.randomPrivateKey();
  const pk = x25519.getPublicKey(sk);
  const prekeyId = store.nextPrekeyId++;
  const sig = ed25519.sign(concat(SPK_CTX, pk), id.ed25519Sk);
  store.signedPrekey = { id: prekeyId, sk: b64.enc(sk), pk: b64.enc(pk), sig: b64.enc(sig), createdAt: Date.now() };
  return store;
}

/** Generate `count` one-time prekeys; returns their public halves for publication. */
export function generateOneTimePrekeys(store: KeyStoreState, count = 100): Array<{ id: number; pk: string }> {
  const out: Array<{ id: number; pk: string }> = [];
  for (let i = 0; i < count; i++) {
    const sk = x25519.utils.randomPrivateKey();
    const id = store.nextPrekeyId++;
    store.oneTimePrekeys[id] = b64.enc(sk);
    out.push({ id, pk: b64.enc(x25519.getPublicKey(sk)) });
  }
  return out;
}

/** Post-quantum (ML-KEM-768) prekeys for the PQXDH hybrid handshake. */
export function generatePqPrekeys(store: KeyStoreState, count = 20): Array<{ id: number; pk: string; sig: string }> {
  const id = identityFromStore(store);
  const out: Array<{ id: number; pk: string; sig: string }> = [];
  for (let i = 0; i < count; i++) {
    const kp = ml_kem768.keygen();
    const pid = store.nextPrekeyId++;
    store.pqPrekeys[pid] = b64.enc(kp.secretKey);
    out.push({
      id: pid,
      pk: b64.enc(kp.publicKey),
      sig: b64.enc(ed25519.sign(concat(PQPK_CTX, kp.publicKey), id.ed25519Sk)),
    });
  }
  return out;
}

export interface PublishablePrekeys {
  agentId: string;
  deviceId: string;
  suite: string;
  ed25519Pk: string;
  x25519Pk: string;
  signedPrekey: { id: number; pk: string; sig: string };
  oneTimePrekeys: Array<{ id: number; pk: string }>;
  pqPrekeys: Array<{ id: number; pk: string; sig: string }>;
  bundleId: string;
}

export function publishablePrekeys(
  store: KeyStoreState,
  opts: { oneTime?: number; pq?: number } = {},
): PublishablePrekeys {
  if (!store.signedPrekey) rotateSignedPrekey(store);
  const spk = store.signedPrekey!;
  const oneTimePrekeys = generateOneTimePrekeys(store, opts.oneTime ?? 100);
  const pqPrekeys = generatePqPrekeys(store, opts.pq ?? 10);
  const material = concat(
    b64.dec(store.ed25519Pk), b64.dec(store.x25519Pk), b64.dec(spk.pk),
    ...oneTimePrekeys.map((k) => b64.dec(k.pk)),
  );
  return {
    agentId: store.agentId,
    deviceId: store.deviceId,
    suite: pqPrekeys.length ? SUITE_PQ : SUITE,
    ed25519Pk: store.ed25519Pk,
    x25519Pk: store.x25519Pk,
    signedPrekey: { id: spk.id, pk: spk.pk, sig: spk.sig },
    oneTimePrekeys,
    pqPrekeys,
    bundleId: deriveKeyBundleId(material),
  };
}

/** Verify a fetched bundle against the agent's on-chain identity key. */
export function verifyPrekeyBundle(bundle: PrekeyBundle, expectedEd25519Pk?: string): void {
  const ik = b64.dec(bundle.ed25519Pk);
  if (deriveAgentId(ik) !== bundle.agentId) throw new Error('bundle: agentId does not match identity key');
  if (expectedEd25519Pk && expectedEd25519Pk !== bundle.ed25519Pk) {
    throw new Error('bundle: identity key differs from registry (possible key substitution)');
  }
  const spkOk = ed25519.verify(b64.dec(bundle.signedPrekey.sig), concat(SPK_CTX, b64.dec(bundle.signedPrekey.pk)), ik);
  if (!spkOk) throw new Error('bundle: signed prekey signature invalid');
  if (bundle.pqPrekey) {
    const pqOk = ed25519.verify(b64.dec(bundle.pqPrekey.sig), concat(PQPK_CTX, b64.dec(bundle.pqPrekey.pk)), ik);
    if (!pqOk) throw new Error('bundle: pq prekey signature invalid');
  }
}

/**
 * Safety number / security code: a short fingerprint of both identity keys
 * that two agents can compare out of band to detect a MITM key swap.
 */
export function safetyNumber(myEd25519Pk: Bytes, theirEd25519Pk: Bytes): string {
  const [a, b] = [myEd25519Pk, theirEd25519Pk].sort((x, y) => b64.enc(x).localeCompare(b64.enc(y)));
  const digest = keccak_256(concat(utf8.enc('AGL/SAFETY/v1'), a, b));
  let out = '';
  for (let i = 0; i < 12; i++) {
    const n = (digest[i * 2] << 8 | digest[i * 2 + 1]) % 100000;
    out += String(n).padStart(5, '0') + (i % 4 === 3 && i !== 11 ? '\n' : ' ');
  }
  return out.trim();
}

export function proofOfKeyPossession(id: IdentityKeys, nonce: string): string {
  return b64.enc(ed25519.sign(utf8.enc(`AGL/POP/v1:${id.agentId}:${nonce}`), id.ed25519Sk));
}

export function verifyProofOfKeyPossession(agentId: string, ed25519Pk: string, nonce: string, sig: string): boolean {
  try {
    return ed25519.verify(b64.dec(sig), utf8.enc(`AGL/POP/v1:${agentId}:${nonce}`), b64.dec(ed25519Pk));
  } catch { return false; }
}
