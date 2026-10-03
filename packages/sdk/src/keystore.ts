/**
 * Key storage. Private keys and ratchet state never leave the agent's process.
 * File and memory stores ship here; the interface is the extension point for an OS
 * keychain, a KMS/HSM or a TEE.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GroupState, KeyStoreState, PersonalIndex, SessionState } from '@agentline/crypto';

export interface AgentPersistedState {
  keys: KeyStoreState;
  sessions: Record<string, SessionState>;
  groups: Record<string, GroupState>;
  index: PersonalIndex;
  /** server-assigned facts worth caching between runs */
  meta: {
    inboxTopic?: string;
    profileTopic?: string;
    handle?: string;
    lastInboxSeq?: number;
    clientSeq?: number;
    registered?: boolean;
  };
}

export interface KeyStore {
  load(): Promise<AgentPersistedState | null>;
  save(state: AgentPersistedState): Promise<void>;
}

export class FileKeyStore implements KeyStore {
  constructor(private path: string) {}

  async load(): Promise<AgentPersistedState | null> {
    if (!existsSync(this.path)) return null;
    return JSON.parse(readFileSync(this.path, 'utf8')) as AgentPersistedState;
  }

  async save(state: AgentPersistedState): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class MemoryKeyStore implements KeyStore {
  private state: AgentPersistedState | null = null;
  async load(): Promise<AgentPersistedState | null> { return this.state; }
  async save(state: AgentPersistedState): Promise<void> { this.state = JSON.parse(JSON.stringify(state)); }
}
