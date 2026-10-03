/**
 * AgentLine typed IDs.
 * Wire form: `<prefix>_<base32 body>`. Canonical on-chain form: bytes32 / bytes20.
 */
import { b32, concat, hexs, keccak_256, randomBytes, utf8, type Bytes } from './primitives.ts';

export const PREFIX = {
  agent: 'agt',
  device: 'dev',
  keyBundle: 'kbd',
  conversation: 'cnv',
  group: 'grp',
  community: 'cmy',
  channel: 'chn',
  broadcast: 'bcl',
  message: 'msg',
  media: 'med',
  status: 'sts',
  invite: 'inv',
  session: 'ses',
  payment: 'pay',
  report: 'rpt',
} as const;

export type IdPrefix = (typeof PREFIX)[keyof typeof PREFIX];

export function encodeId(prefix: IdPrefix, body: Bytes): string {
  return `${prefix}_${b32.enc(body)}`;
}

export function decodeId(id: string, expect?: IdPrefix): Bytes {
  const i = id.indexOf('_');
  if (i < 0) throw new Error(`malformed id: ${id}`);
  const prefix = id.slice(0, i);
  if (expect && prefix !== expect) throw new Error(`expected ${expect}_ id, got ${prefix}_`);
  return b32.dec(id.slice(i + 1));
}

export function idPrefix(id: string): string {
  return id.slice(0, Math.max(0, id.indexOf('_')));
}

/** bytes20 body, right-padded into a bytes32 for contract storage. */
export function idToBytes32(id: string): `0x${string}` {
  const body = decodeId(id);
  const out = new Uint8Array(32);
  out.set(body.slice(0, 32), 0);
  return hexs.enc(out) as `0x${string}`;
}

export function bytes32ToId(prefix: IdPrefix, word: `0x${string}`, len = 20): string {
  return encodeId(prefix, hexs.dec(word).slice(0, len));
}

const dom = (s: string) => utf8.enc(s);

/** agentId = keccak256("AGL/AGENT/v1" ‖ ed25519Pub)[:20] */
export function deriveAgentId(ed25519Pub: Bytes): string {
  return encodeId(PREFIX.agent, keccak_256(concat(dom('AGL/AGENT/v1'), ed25519Pub)).slice(0, 20));
}

/** deviceId = keccak256("AGL/DEV/v1" ‖ agentId ‖ devicePub)[:20] */
export function deriveDeviceId(agentId: string, devicePub: Bytes): string {
  return encodeId(
    PREFIX.device,
    keccak_256(concat(dom('AGL/DEV/v1'), decodeId(agentId, PREFIX.agent), devicePub)).slice(0, 20),
  );
}

export function deriveKeyBundleId(bundleBytes: Bytes): string {
  return encodeId(PREFIX.keyBundle, keccak_256(concat(dom('AGL/KBD/v1'), bundleBytes)).slice(0, 20));
}

export type ConvMode = 'open' | 'sealed';

/**
 * Deterministic DM conversation id.
 *   open:   keccak256("AGL/DM/v1" ‖ min(A,B) ‖ max(A,B))
 *   sealed: keccak256("AGL/DM/v1" ‖ min(A,B) ‖ max(A,B) ‖ convSalt)
 * Both participants derive the same id offline; sealed adds a salt shared inside the
 * encrypted handshake, so the public id is not enumerable from the agent registry.
 */
export function deriveConversationId(agentA: string, agentB: string, convSalt?: Bytes): string {
  const a = decodeId(agentA, PREFIX.agent);
  const b = decodeId(agentB, PREFIX.agent);
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const parts = [dom('AGL/DM/v1'), lo, hi];
  if (convSalt) parts.push(convSalt);
  return encodeId(PREFIX.conversation, keccak_256(concat(...parts)).slice(0, 20));
}

export function newConvSalt(): Bytes {
  return randomBytes(16);
}

export function deriveGroupId(creatorAgentId: string, nonce: Bytes): string {
  return encodeId(
    PREFIX.group,
    keccak_256(concat(dom('AGL/GRP/v1'), decodeId(creatorAgentId, PREFIX.agent), nonce)).slice(0, 20),
  );
}

export function deriveChannelId(ownerAgentId: string, nonce: Bytes): string {
  return encodeId(
    PREFIX.channel,
    keccak_256(concat(dom('AGL/CHN/v1'), decodeId(ownerAgentId, PREFIX.agent), nonce)).slice(0, 20),
  );
}

export function deriveCommunityId(creatorAgentId: string, nonce: Bytes): string {
  return encodeId(
    PREFIX.community,
    keccak_256(concat(dom('AGL/CMY/v1'), decodeId(creatorAgentId, PREFIX.agent), nonce)).slice(0, 20),
  );
}

/** msgId = keccak256(cid ‖ senderDeviceId ‖ clientSeq) — client-generated, idempotent. */
export function deriveMessageId(cid: string, senderDeviceId: string, clientSeq: number): string {
  const seq = new Uint8Array(8);
  new DataView(seq.buffer).setBigUint64(0, BigInt(clientSeq), false);
  return encodeId(
    PREFIX.message,
    keccak_256(concat(dom('AGL/MSG/v1'), decodeId(cid), decodeId(senderDeviceId), seq)).slice(0, 20),
  );
}

export function derivePaymentId(cid: string, msgId: string): string {
  return encodeId(
    PREFIX.payment,
    keccak_256(concat(dom('AGL/PAY/v1'), decodeId(cid), decodeId(msgId))).slice(0, 20),
  );
}

export function randomId(prefix: IdPrefix, bytes = 16): string {
  return encodeId(prefix, randomBytes(bytes));
}

/** keccak(handle) — the on-chain key for @handle lookups. */
export function handleHash(handle: string): `0x${string}` {
  return hexs.enc(keccak_256(utf8.enc(normalizeHandle(handle)))) as `0x${string}`;
}

export function normalizeHandle(handle: string): string {
  const h = handle.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.]{3,32}$/.test(h)) throw new Error(`invalid handle: ${handle}`);
  return h;
}

export function compareBytes(a: Bytes, b: Bytes): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}
