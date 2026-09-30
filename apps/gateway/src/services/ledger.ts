/**
 * Consensus ledger abstraction (PRD D3, §4.1 Relayer).
 *
 * Messages and inbox notices go to Hedera Consensus Service topics: fixed low fees,
 * total ordering, consensus timestamps, free public reads from mirror nodes.
 *
 * Two implementations with identical semantics:
 *   HederaLedger — real HCS via @hashgraph/sdk + mirror node REST.
 *   LocalLedger  — file-backed ordered log used when no Hedera credentials are present,
 *                  so the whole system (and the test suite) runs offline. Sequence
 *                  numbers, consensus timestamps and running hashes behave the same way,
 *                  which keeps the proof format identical.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainMode, config } from '../config.ts';

export interface SubmitResult {
  topicId: string;
  seq: number;
  consensusTimestamp: string;
  runningHash: string;
  txId?: string;
  chunks?: number;
}

export interface LedgerMessage {
  topicId: string;
  seq: number;
  consensusTimestamp: string;
  runningHash: string;
  contents: Uint8Array;
}

export interface Ledger {
  readonly kind: 'hedera' | 'local';
  createTopic(memo: string, opts?: { submitKeyed?: boolean }): Promise<string>;
  submit(topicId: string, payload: Uint8Array): Promise<SubmitResult>;
  read(topicId: string, opts?: { afterSeq?: number; limit?: number }): Promise<LedgerMessage[]>;
  get(topicId: string, seq: number): Promise<LedgerMessage | null>;
  info(): Record<string, unknown>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ local ledger */

interface LocalTopic { topicId: string; memo: string; messages: LocalMessage[]; runningHash: string }
interface LocalMessage { seq: number; ts: string; hash: string; b64: string }

class LocalLedger implements Ledger {
  readonly kind = 'local' as const;
  private path: string;
  private topics: Record<string, LocalTopic> = {};
  private nextNum = 1000;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir = config.dataDir) {
    this.path = join(dataDir, 'ledger.json');
    if (existsSync(this.path)) {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      this.topics = raw.topics ?? {};
      this.nextNum = raw.nextNum ?? 1000;
    }
  }

  private persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      mkdirSync(config.dataDir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ topics: this.topics, nextNum: this.nextNum }));
      renameSync(tmp, this.path);
    }, 200);
  }

  async createTopic(memo: string): Promise<string> {
    const topicId = `0.0.${this.nextNum++}`;
    this.topics[topicId] = { topicId, memo, messages: [], runningHash: '00'.repeat(48) };
    this.persist();
    return topicId;
  }

  async submit(topicId: string, payload: Uint8Array): Promise<SubmitResult> {
    const t = this.topics[topicId] ?? (this.topics[topicId] = {
      topicId, memo: 'auto', messages: [], runningHash: '00'.repeat(48),
    });
    const seq = t.messages.length + 1;
    const now = Date.now();
    const consensusTimestamp = `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, '0')}000000`;
    // Running hash chains each message to its predecessor, mirroring HCS semantics.
    const runningHash = createHash('sha384')
      .update(Buffer.from(t.runningHash, 'hex'))
      .update(Buffer.from(`${topicId}|${seq}|${consensusTimestamp}`))
      .update(payload)
      .digest('hex');
    t.runningHash = runningHash;
    t.messages.push({ seq, ts: consensusTimestamp, hash: runningHash, b64: Buffer.from(payload).toString('base64') });
    this.persist();
    return { topicId, seq, consensusTimestamp, runningHash };
  }

  async read(topicId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<LedgerMessage[]> {
    const t = this.topics[topicId];
    if (!t) return [];
    const after = opts.afterSeq ?? 0;
    return t.messages
      .filter((m) => m.seq > after)
      .slice(0, opts.limit ?? 100)
      .map((m) => this.toMessage(topicId, m));
  }

  async get(topicId: string, seq: number): Promise<LedgerMessage | null> {
    const m = this.topics[topicId]?.messages.find((x) => x.seq === seq);
    return m ? this.toMessage(topicId, m) : null;
  }

  private toMessage(topicId: string, m: LocalMessage): LedgerMessage {
    return {
      topicId, seq: m.seq, consensusTimestamp: m.ts, runningHash: m.hash,
      contents: new Uint8Array(Buffer.from(m.b64, 'base64')),
    };
  }

  info(): Record<string, unknown> {
    return {
      kind: 'local',
      note: 'Local consensus ledger — no Hedera credentials configured. Same ordering/timestamp/proof semantics; set HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY for real HCS.',
      topics: Object.keys(this.topics).length,
      messages: Object.values(this.topics).reduce((n, t) => n + t.messages.length, 0),
    };
  }

  async close(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(this.path, JSON.stringify({ topics: this.topics, nextNum: this.nextNum }));
  }
}

/* ------------------------------------------------------------------ hedera ledger */

class HederaLedger implements Ledger {
  readonly kind = 'hedera' as const;
  private client: any;
  private sdk: any;
  private ready: Promise<void>;
  private topicCache = new Map<string, { seq: number }>();

  constructor() { this.ready = this.init(); }

  private async init(): Promise<void> {
    const sdk = await import('@hashgraph/sdk');
    this.sdk = sdk;
    const { Client, PrivateKey, AccountId } = sdk;
    const net = config.hedera.network;
    this.client = net === 'mainnet' ? Client.forMainnet() : net === 'previewnet' ? Client.forPreviewnet() : Client.forTestnet();
    const key = parsePrivateKey(sdk, config.hedera.privateKey!);
    this.client.setOperator(AccountId.fromString(config.hedera.accountId!), key);
    this.client.setDefaultMaxTransactionFee(new sdk.Hbar(2));
  }

  async createTopic(memo: string, opts: { submitKeyed?: boolean } = {}): Promise<string> {
    await this.ready;
    const { TopicCreateTransaction } = this.sdk;
    let tx = new TopicCreateTransaction().setTopicMemo(memo.slice(0, 100));
    if (opts.submitKeyed) tx = tx.setSubmitKey(this.client.operatorPublicKey);
    const resp = await tx.execute(this.client);
    const receipt = await resp.getReceipt(this.client);
    return receipt.topicId!.toString();
  }

  async submit(topicId: string, payload: Uint8Array): Promise<SubmitResult> {
    await this.ready;
    const { TopicMessageSubmitTransaction } = this.sdk;
    const resp = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(payload)
      .execute(this.client);
    const receipt = await resp.getReceipt(this.client);
    const record = await resp.getRecord(this.client);
    const seq = Number(receipt.topicSequenceNumber?.toString() ?? 0);
    const runningHash = Buffer.from(receipt.topicRunningHash ?? new Uint8Array()).toString('hex');
    const consensus = record.consensusTimestamp;
    const consensusTimestamp = consensus
      ? `${consensus.seconds.toString()}.${String(consensus.nanos.toString()).padStart(9, '0')}`
      : `${Math.floor(Date.now() / 1000)}.000000000`;
    this.topicCache.set(topicId, { seq });
    return { topicId, seq, consensusTimestamp, runningHash, txId: resp.transactionId.toString() };
  }

  /** Mirror-node reads are free and public — exactly the trustless path agents can use. */
  async read(topicId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<LedgerMessage[]> {
    const url = new URL(`${config.hedera.mirrorRest}/api/v1/topics/${topicId}/messages`);
    url.searchParams.set('limit', String(Math.min(opts.limit ?? 100, 100)));
    url.searchParams.set('order', 'asc');
    if (opts.afterSeq) url.searchParams.set('sequencenumber', `gt:${opts.afterSeq}`);
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`mirror node ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { messages?: any[] };
    return (json.messages ?? []).map((m) => ({
      topicId,
      seq: Number(m.sequence_number),
      consensusTimestamp: String(m.consensus_timestamp),
      runningHash: String(m.running_hash ?? ''),
      contents: new Uint8Array(Buffer.from(String(m.message), 'base64')),
    }));
  }

  async get(topicId: string, seq: number): Promise<LedgerMessage | null> {
    const res = await fetch(`${config.hedera.mirrorRest}/api/v1/topics/${topicId}/messages/${seq}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mirror node ${res.status}`);
    const m = (await res.json()) as any;
    return {
      topicId, seq: Number(m.sequence_number), consensusTimestamp: String(m.consensus_timestamp),
      runningHash: String(m.running_hash ?? ''),
      contents: new Uint8Array(Buffer.from(String(m.message), 'base64')),
    };
  }

  info(): Record<string, unknown> {
    return {
      kind: 'hedera',
      network: config.hedera.network,
      operator: config.hedera.accountId,
      mirror: config.hedera.mirrorRest,
    };
  }

  async close(): Promise<void> { try { this.client?.close(); } catch { /* already closed */ } }
}

function parsePrivateKey(sdk: any, raw: string): any {
  const { PrivateKey } = sdk;
  const attempts = [
    () => PrivateKey.fromStringDer(raw),
    () => PrivateKey.fromStringECDSA(raw),
    () => PrivateKey.fromStringED25519(raw),
    () => PrivateKey.fromString(raw),
  ];
  for (const attempt of attempts) {
    try { return attempt(); } catch { /* try the next encoding */ }
  }
  throw new Error('HEDERA_PRIVATE_KEY is not a recognised DER/ECDSA/ED25519 key');
}

/* ------------------------------------------------------------------ chunking */

export const CHUNK_PAYLOAD = 900;

/** Split oversized payloads across consecutive HCS messages (PRD §6.2 "Large payloads"). */
export function chunkPayload(payload: Uint8Array, max = CHUNK_PAYLOAD): Uint8Array[] {
  if (payload.length <= max) return [payload];
  const chunks: Uint8Array[] = [];
  for (let o = 0; o < payload.length; o += max) chunks.push(payload.slice(o, o + max));
  return chunks;
}

let instance: Ledger | null = null;

export function ledger(): Ledger {
  if (!instance) instance = chainMode() === 'hedera' ? new HederaLedger() : new LocalLedger();
  return instance;
}

export function resetLedger(): void { instance = null; }

/** Shared topics for sealed DMs: shard = H(cid) mod N hides which topic belongs to whom. */
export function shardFor(cid: string, shards: number): number {
  const h = createHash('sha256').update(cid).digest();
  return h.readUInt32BE(0) % Math.max(1, shards);
}
