/**
 * Encrypted personal index.
 *
 * Contacts, sealed conversation list, broadcast lists, labels, pins, mutes, archive,
 * starred messages and the block list — encrypted with a key derived from the agent's
 * identity secret and stored as an opaque blob. Lets a stateless agent restart, or a
 * second device sync, without the gateway ever reading it.
 */
import { aeadOpen, aeadSeal, b64, kdf, utf8, type Bytes } from './primitives.ts';

export interface ContactEntry {
  agentId: string;
  handle?: string;
  label?: string[];
  verified?: boolean;
  safetyNumber?: string;
  addedAt: number;
}

export interface ConversationEntry {
  cid: string;
  mode: 'open' | 'sealed';
  kind: 'dm' | 'group' | 'channel';
  peerAgentId?: string;
  groupId?: string;
  convSalt?: string;
  topicId?: string;
  tag?: string;
  lastSeq?: number;
  lastReadSeq?: number;
  archived?: boolean;
  muted?: boolean;
  pinned?: boolean;
  labels?: string[];
  disappearAfter?: number;
  createdAt: number;
}

export interface PersonalIndex {
  version: 1;
  updatedAt: number;
  contacts: Record<string, ContactEntry>;
  conversations: Record<string, ConversationEntry>;
  blocked: string[];
  broadcastLists: Record<string, { name: string; members: string[] }>;
  starred: string[];
  /** opaque per-conversation session state, encrypted along with the rest */
  sessions: Record<string, unknown>;
  groups: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export function emptyIndex(): PersonalIndex {
  return {
    version: 1, updatedAt: Date.now(), contacts: {}, conversations: {}, blocked: [],
    broadcastLists: {}, starred: [], sessions: {}, groups: {}, meta: {},
  };
}

export function indexKey(identitySecret: Bytes): Bytes {
  return kdf(identitySecret, 'AGL/personal-index/v1');
}

export function sealIndex(identitySecret: Bytes, index: PersonalIndex): string {
  index.updatedAt = Date.now();
  return b64.enc(aeadSeal(indexKey(identitySecret), utf8.enc(JSON.stringify(index))));
}

export function openIndex(identitySecret: Bytes, blob: string): PersonalIndex {
  return JSON.parse(utf8.dec(aeadOpen(indexKey(identitySecret), b64.dec(blob)))) as PersonalIndex;
}

/** HMAC-blinded conversation tag for sealed notifications. */
export function inboxNotifyKey(identitySecret: Bytes): Bytes {
  return kdf(identitySecret, 'AGL/inbox-notify/v1');
}
