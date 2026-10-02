/**
 * Gateway state: indexer read models, caches and operational records.
 *
 * Everything here is either (a) rebuildable from Hedera + the registry contract, or
 * (b) operational metadata we are allowed to hold (PRD §4.1 "Indexer", S12). No
 * plaintext, no private keys, no ratchet state ever lands in this store.
 *
 * Backed by a single JSON snapshot on disk — deliberately simple and inspectable; the
 * indexer can rebuild it from chain at any time, which is the property that matters.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';

export interface AgentRecord {
  agentId: string;
  handle?: string;
  owner: string;
  ed25519Pk: string;
  x25519Pk: string;
  inboxTopic: string;
  profileTopic: string;
  keyEpoch: number;
  status: 'active' | 'suspended' | 'deleted';
  dmPolicy: 'everyone' | 'contacts' | 'paid_only' | 'allowlist';
  flags: { business?: boolean; verified?: boolean; acceptsUnknownDms?: boolean; receiptsOff?: boolean };
  profile: {
    name?: string; description?: string; avatar?: string; model?: string; runtime?: string;
    operator?: string; capabilities?: Array<Record<string, unknown>>; a2aCard?: string;
  };
  links: Array<{ kind: string; value: string }>;
  devices: string[];
  registeredAt: number;
  registryTx?: string;
  allowlist?: string[];
  webhook?: { url: string; secret: string; expiresAt: number };
  sponsorInbound?: boolean;
}

export interface PrekeyRecord {
  agentId: string;
  deviceId: string;
  suite: string;
  ed25519Pk: string;
  x25519Pk: string;
  signedPrekey: { id: number; pk: string; sig: string };
  oneTimePrekeys: Array<{ id: number; pk: string }>;
  pqPrekeys: Array<{ id: number; pk: string; sig: string }>;
  bundleId: string;
  keyEpoch: number;
  updatedAt: number;
}

export interface ConversationRecord {
  cid: string;
  kind: 'dm' | 'group' | 'channel';
  mode: 'open' | 'sealed';
  topicId: string;
  /** routing tag for sharded sealed topics */
  tag?: string;
  participants: string[];        // empty in sealed mode
  groupId?: string;
  channelId?: string;
  createdAt: number;
  lastSeq: number;
  messageCount: number;
  settings: { disappearAfter?: number; onlyAdminsSend?: boolean };
  registryTx?: string;
}

export interface MessageRecord {
  cid: string;
  topicId: string;
  seq: number;
  consensusTimestamp: string;
  runningHash?: string;
  /** ciphertext envelope, base64 CBOR — the gateway cannot read inside it */
  envelope: string;
  size: number;
  msgId?: string;
  senderDeviceId: string | null;
  sender?: string;
  receivedAt: number;
  chunk?: [number, number, string];
}

export interface GroupRecord {
  groupId: string;
  cid: string;
  topicId: string;
  creator: string;
  members: string[];
  admins: string[];
  epoch: number;
  membersRoot: string;
  settings: { onlyAdminsSend?: boolean; adminsAddOnly?: boolean; sealedMembership?: boolean };
  name?: string;
  createdAt: number;
  registryTx?: string;
}

export interface ChannelRecord {
  channelId: string;
  cid: string;
  topicId: string;
  owner: string;
  encrypted: boolean;
  followers: string[];
  name?: string;
  description?: string;
  createdAt: number;
  registryTx?: string;
}

export interface RequestRecord {
  cid: string;
  from: string;
  to: string;
  firstSeq: number;
  createdAt: number;
  state: 'pending' | 'accepted' | 'declined';
}

export interface ReportRecord {
  reportId: string;
  reporter: string;
  reported: string;
  cid: string;
  msgIds: string[];
  verified: boolean;
  reason: string;
  evidence: Array<{ msgId: string; body: unknown; frankKey: string; tagMatches: boolean }>;
  createdAt: number;
}

export interface MediaRecord {
  mediaId: string;
  owner: string;
  size: number;
  sha256?: string;
  mime?: string;
  uri: string;
  uploadedAt: number;
  expiresAt?: number;
}

export interface CreditRecord { balance: string; updatedAt: number; spent: string }

export interface PaymentRecord {
  txHash?: string;
  payer?: string;
  amount: string;
  route: string;
  agentId?: string;
  at: number;
  settled: boolean;
  nonce?: string;
}

interface Snapshot {
  version: 1;
  agents: Record<string, AgentRecord>;
  handles: Record<string, string>;
  prekeys: Record<string, PrekeyRecord>;                 // deviceId -> bundle
  conversations: Record<string, ConversationRecord>;
  convsOfAgent: Record<string, string[]>;
  messages: Record<string, MessageRecord[]>;             // cid -> ordered messages
  notices: Record<string, Array<{ seq: number; notice: unknown; at: number }>>;  // agentId -> inbox
  groups: Record<string, GroupRecord>;
  channels: Record<string, ChannelRecord>;
  invites: Record<string, { groupId: string; expiresAt: number; usesLeft: number }>;
  requests: Record<string, RequestRecord>;
  blocks: Record<string, string[]>;                      // agentId -> blocked agentIds
  contacts: Record<string, string[]>;                    // agentId -> known peers (server-visible hint)
  reports: Record<string, ReportRecord>;
  media: Record<string, MediaRecord>;
  credits: Record<string, CreditRecord>;
  payments: PaymentRecord[];
  usedNonces: Record<string, number>;
  paymentNonces: Record<string, number>;
  idempotency: Record<string, { at: number; response: unknown }>;
  sealedShardTopics: string[];
  indexCheckpoints: Record<string, number>;
  personalIndex: Record<string, { blob: string; updatedAt: number }>;
  stats: { messagesSent: number; agentsRegistered: number; revenueAtomic: string };
}

function empty(): Snapshot {
  return {
    version: 1, agents: {}, handles: {}, prekeys: {}, conversations: {}, convsOfAgent: {},
    messages: {}, notices: {}, groups: {}, channels: {}, invites: {}, requests: {}, blocks: {},
    contacts: {}, reports: {}, media: {}, credits: {}, payments: [], usedNonces: {},
    paymentNonces: {}, idempotency: {}, sealedShardTopics: [], indexCheckpoints: {},
    personalIndex: {}, stats: { messagesSent: 0, agentsRegistered: 0, revenueAtomic: '0' },
  };
}

class Store {
  db: Snapshot = empty();
  private path: string;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  /** bumped on every mutation; the checkpointer compares it to decide whether to run */
  version = 0;

  constructor(dataDir = config.dataDir) {
    this.path = join(dataDir, 'gateway.json');
    this.load();
  }

  load(): void {
    try {
      if (existsSync(this.path)) {
        this.db = { ...empty(), ...(JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot) };
      }
    } catch (err) {
      console.error('[store] snapshot unreadable, starting empty:', (err as Error).message);
      this.db = empty();
    }
  }

  /** Coalesced async persistence; the snapshot is a cache, so losing a few ms is safe. */
  save(): void {
    this.version += 1;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.flush();
    }, 250);
  }

  flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.db));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('[store] save failed:', (err as Error).message);
    }
  }

  reset(): void { this.db = empty(); this.save(); }

  /* ---- small helpers used across routes ---- */

  agent(agentId: string): AgentRecord | undefined { return this.db.agents[agentId]; }

  agentByHandle(handle: string): AgentRecord | undefined {
    const id = this.db.handles[handle.replace(/^@/, '').toLowerCase()];
    return id ? this.db.agents[id] : undefined;
  }

  resolve(idOrHandle: string): AgentRecord | undefined {
    return idOrHandle.startsWith('@') ? this.agentByHandle(idOrHandle) : this.agent(idOrHandle);
  }

  messages(cid: string): MessageRecord[] { return (this.db.messages[cid] ??= []); }

  notices(agentId: string) { return (this.db.notices[agentId] ??= []); }

  blocked(by: string, who: string): boolean { return (this.db.blocks[by] ?? []).includes(who); }

  isContact(owner: string, peer: string): boolean { return (this.db.contacts[owner] ?? []).includes(peer); }

  addContact(owner: string, peer: string): void {
    const list = (this.db.contacts[owner] ??= []);
    if (!list.includes(peer)) { list.push(peer); this.save(); }
  }

  credits(agentId: string): CreditRecord {
    return (this.db.credits[agentId] ??= { balance: '0', updatedAt: Date.now(), spent: '0' });
  }

  /** Single-use nonce cache for RFC 9421 replay protection (S2). */
  consumeNonce(key: string, ttlSeconds = 300): boolean {
    const now = Date.now();
    for (const [k, at] of Object.entries(this.db.usedNonces)) {
      if (now - at > ttlSeconds * 1000) delete this.db.usedNonces[k];
    }
    if (this.db.usedNonces[key]) return false;
    this.db.usedNonces[key] = now;
    this.save();
    return true;
  }

  idempotent<T>(key: string): T | undefined {
    const hit = this.db.idempotency[key];
    return hit ? (hit.response as T) : undefined;
  }

  rememberIdempotent(key: string, response: unknown): void {
    this.db.idempotency[key] = { at: Date.now(), response };
    this.save();
  }

  recordRevenue(atomic: bigint): void {
    this.db.stats.revenueAtomic = (BigInt(this.db.stats.revenueAtomic) + atomic).toString();
  }
}

export const store = new Store();
export type { Snapshot };
