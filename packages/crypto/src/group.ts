/**
 * Group E2EE via sender keys (PRD §6.4).
 *
 * MLS (RFC 9420) is the v1-GA target; this is the interoperable stepping stone that
 * ships today: each member has a sender-key chain, distributed to every other member
 * over the pairwise Double Ratchet sessions (so distribution inherits forward secrecy),
 * and rotated on every membership change — which is what gives removed members
 * forward secrecy for later epochs.
 */
import {
  aeadOpenDet, aeadSealDet, b64, concat, hmac, keccak_256, pad, randomBytes, sha512, unpad, utf8,
  type Bytes,
} from './primitives.ts';
import { decodeId } from './ids.ts';

export interface SenderKeyState {
  chainKey: string;
  n: number;
}

/**
 * The state a sender publishes for an epoch.
 *
 * It is the *start* of the epoch's chain, snapshotted when the epoch opens, not the
 * sender's current position. A member who receives the distribution late can therefore
 * still read every message of that epoch — while forward secrecy across epochs is
 * untouched, which is the property that makes member removal meaningful.
 */
export interface EpochSeed {
  chainKey: string;
  n: number;
}

export interface GroupState {
  version: 1;
  groupId: string;
  epoch: number;
  members: string[];              // agentIds
  admins: string[];
  /** our own sending chain for this epoch */
  own: SenderKeyState;
  /** immutable seed of our current epoch, republished on every distribution */
  ownSeed: EpochSeed;
  /** per-member receiving chains: agentId -> state */
  peers: Record<string, SenderKeyState>;
  /** skipped keys for out-of-order group messages: "agentId:epoch:n" -> key */
  skipped: Record<string, string>;
}

const CK = 'AGL/group/chain/v1';
const MK = 'AGL/group/msg/v1';

export function newSenderKey(): SenderKeyState {
  return { chainKey: b64.enc(randomBytes(32)), n: 0 };
}

export function createGroup(groupId: string, creator: string, members: string[]): GroupState {
  const all = Array.from(new Set([creator, ...members]));
  const own = newSenderKey();
  return {
    version: 1, groupId, epoch: 0, members: all, admins: [creator],
    own, ownSeed: { ...own }, peers: {}, skipped: {},
  };
}

/** A sender-key distribution message — delivered to each member inside a pairwise session. */
export interface SenderKeyDistribution {
  groupId: string;
  epoch: number;
  from: string;
  chainKey: string;
  n: number;
  members: string[];
  admins: string[];
}

export function distribution(g: GroupState, from: string): SenderKeyDistribution {
  const seed = g.ownSeed ?? g.own;
  return {
    groupId: g.groupId, epoch: g.epoch, from,
    chainKey: seed.chainKey, n: seed.n,
    members: g.members, admins: g.admins,
  };
}

export function acceptDistribution(g: GroupState, d: SenderKeyDistribution): void {
  if (d.groupId !== g.groupId) throw new Error('group: distribution for a different group');
  if (d.epoch < g.epoch) return;                       // stale
  const freshEpoch = d.epoch > g.epoch;
  if (freshEpoch) { g.epoch = d.epoch; g.skipped = {}; }
  g.members = d.members; g.admins = d.admins;
  const existing = g.peers[d.from];
  // `freshEpoch` is set above when d.epoch advanced us. Within the *same* epoch a re-sent
  // distribution must not rewind a chain we have already advanced: that would re-derive
  // consumed keys and open a replay window.
  if (freshEpoch || !existing || existing.n <= d.n) {
    g.peers[d.from] = { chainKey: d.chainKey, n: d.n };
  }
}

/** Membership change: bump the epoch and rotate our sender key (removed members lock out). */
export function rotateEpoch(g: GroupState, members: string[], admins?: string[]): GroupState {
  g.epoch += 1;
  g.members = Array.from(new Set(members));
  if (admins) g.admins = admins;
  g.own = newSenderKey();
  g.ownSeed = { ...g.own };
  g.peers = {};
  g.skipped = {};
  return g;
}

function step(chainKey: Bytes): { next: Bytes; key: Bytes } {
  return {
    next: hmac(sha512, chainKey, utf8.enc(CK)).slice(0, 32),
    key: hmac(sha512, chainKey, utf8.enc(MK)).slice(0, 32),
  };
}

export interface GroupCiphertext { epoch: number; n: number; ct: string }

export function groupEncrypt(g: GroupState, plaintext: Bytes, aad?: Bytes): GroupCiphertext {
  const { next, key } = step(b64.dec(g.own.chainKey));
  const n = g.own.n;
  g.own = { chainKey: b64.enc(next), n: n + 1 };
  const bind = concat(utf8.enc(`${g.groupId}:${g.epoch}:${n}`), aad ?? new Uint8Array(0));
  return { epoch: g.epoch, n, ct: b64.enc(aeadSealDet(key, pad(plaintext), bind)) };
}

export function groupDecrypt(g: GroupState, from: string, msg: GroupCiphertext, aad?: Bytes): Bytes {
  const bind = concat(utf8.enc(`${g.groupId}:${msg.epoch}:${msg.n}`), aad ?? new Uint8Array(0));
  const skipKey = `${from}:${msg.epoch}:${msg.n}`;
  const saved = g.skipped[skipKey];
  if (saved) {
    delete g.skipped[skipKey];
    return unpad(aeadOpenDet(b64.dec(saved), b64.dec(msg.ct), bind));
  }
  const peer = g.peers[from];
  if (!peer) throw new Error(`group: no sender key from ${from} (need distribution for epoch ${msg.epoch})`);
  if (msg.n < peer.n) throw new Error('group: message key already consumed (replay?)');
  let chain = b64.dec(peer.chainKey);
  let n = peer.n;
  let key: Bytes | null = null;
  while (n <= msg.n) {
    const s = step(chain);
    chain = s.next;
    if (n === msg.n) key = s.key;
    else g.skipped[`${from}:${msg.epoch}:${n}`] = b64.enc(s.key);
    n += 1;
  }
  g.peers[from] = { chainKey: b64.enc(chain), n };
  return unpad(aeadOpenDet(key!, b64.dec(msg.ct), bind));
}

/** Membership Merkle root committed on-chain (PRD §5.1 / §7.6). */
export function membersRoot(members: string[]): `0x${string}` {
  const leaves = [...members].sort().map((m) => keccak_256(concat(utf8.enc('AGL/LEAF/v1'), decodeId(m))));
  if (!leaves.length) return ('0x' + '00'.repeat(32)) as `0x${string}`;
  let level = leaves;
  while (level.length > 1) {
    const next: Bytes[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? keccak_256(concat(level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return ('0x' + Buffer.from(level[0]).toString('hex')) as `0x${string}`;
}
