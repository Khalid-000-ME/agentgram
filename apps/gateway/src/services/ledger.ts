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
  /** set when credentials are unusable, so the caller can fall back to the local ledger */
  initError: Error | null = null;

  constructor() {
    this.ready = this.init().catch((err) => {
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    });
  }

  async probe(): Promise<Error | null> {
    try { await this.ready; return null; } catch (err) { return err as Error; }
  }

  private async init(): Promise<void> {
    const sdk = await import('@hashgraph/sdk');
    this.sdk = sdk;
    const { Client, PrivateKey, AccountId } = sdk;
    const net = config.hedera.network;
    this.client = net === 'mainnet' ? Client.forMainnet() : net === 'previewnet' ? Client.forPreviewnet() : Client.forTestnet();
    const key = await resolveOperatorKey(sdk, config.hedera.accountId!, config.hedera.privateKey!, config.hedera.mirrorRest);
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

/**
 * Parse a Hedera private key from any of the forms the portal and wallets hand out.
 *
 * Two traps this exists to avoid:
 *  - A DER *public* key looks plausible and is a common copy/paste mistake; it parses as
 *    nothing useful and would otherwise surface much later as INVALID_SIGNATURE.
 *  - Several encodings will happily parse the same bytes as a different key type, so
 *    "it parsed" is not evidence it is the right key. Callers verify the derived public
 *    key against the account (see assertOperatorKey).
 */
export function parsePrivateKey(sdk: any, raw: string): any {
  const { PrivateKey } = sdk;
  const key = raw.trim();
  const hex = key.replace(/^0x/i, '').toLowerCase();

  // DER public-key wrappers: ED25519 302a300506032b6570…, ECDSA secp256k1 3056301006…
  if (/^302a300506032b6570/.test(hex) || /^3056301006072a8648ce3d020106052b8104000a/.test(hex)) {
    throw new Error(
      'HEDERA_PRIVATE_KEY looks like a PUBLIC key (DER public-key prefix). Copy the private key instead — '
      + 'on portal.hedera.com it is the "DER Encoded Private Key" (starts 302e0201003005…) or the raw 64-hex-character key.',
    );
  }

  const attempts: Array<[string, () => any]> = [
    ['DER', () => PrivateKey.fromStringDer(key)],
    ['ECDSA', () => PrivateKey.fromStringECDSA(key)],
    ['ED25519', () => PrivateKey.fromStringED25519(key)],
    ['generic', () => PrivateKey.fromString(key)],
  ];
  const parsed: Array<[string, any]> = [];
  for (const [label, attempt] of attempts) {
    try { parsed.push([label, attempt()]); } catch { /* try the next encoding */ }
  }
  if (!parsed.length) {
    throw new Error(
      `HEDERA_PRIVATE_KEY (${hex.length} hex chars) is not a recognised Hedera key. Expected the DER private key `
      + '(96 hex chars, starts 302e0201003005…) or a raw 64-hex-character ED25519/ECDSA key.',
    );
  }
  return { candidates: parsed, primary: parsed[0][1] };
}

/**
 * Confirm the configured key actually controls the configured account, by comparing the
 * derived public key with what the mirror node reports. Getting this wrong is otherwise
 * only visible as INVALID_SIGNATURE on the first real transaction.
 */
export async function resolveOperatorKey(sdk: any, accountId: string, raw: string, mirrorRest: string): Promise<any> {
  const { candidates, primary } = parsePrivateKey(sdk, raw);

  let accountKey: string | undefined;
  try {
    const res = await fetch(`${mirrorRest}/api/v1/accounts/${accountId}`);
    if (res.ok) accountKey = ((await res.json()) as any)?.key?.key?.toLowerCase();
  } catch { /* offline: fall back to the first parse */ }
  if (!accountKey) return primary;

  for (const [label, key] of candidates as Array<[string, any]>) {
    const derived = key.publicKey.toStringRaw().toLowerCase();
    if (derived === accountKey) {
      if (label !== (candidates as Array<[string, any]>)[0][0]) {
        console.log(`[hedera] key interpreted as ${label} to match account ${accountId}`);
      }
      return key;
    }
  }
  throw new Error(
    `HEDERA_PRIVATE_KEY does not control HEDERA_ACCOUNT_ID ${accountId}: the account's public key is `
    + `${accountKey.slice(0, 16)}… but this key derives a different one. Check that both values come from the same account.`,
  );
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
let degraded: string | null = null;

export function ledger(): Ledger {
  if (!instance) instance = chainMode() === 'hedera' ? new HederaLedger() : new LocalLedger();
  return instance;
}

/**
 * Confirm the configured ledger actually works before serving traffic.
 *
 * If Hedera credentials are unusable we fall back to the local ledger rather than failing
 * every request: the protocol semantics are identical, and a messaging service that stays
 * up in a degraded mode beats one that refuses to start. The reason is logged and reported
 * by /v1/status, so the degradation is never silent.
 */
export async function verifyLedger(): Promise<{ kind: string; degraded: string | null }> {
  const current = ledger();
  if (current instanceof HederaLedger) {
    const err = await current.probe();
    if (err) {
      degraded = err.message;
      console.error(`\n  [ledger] Hedera unavailable: ${err.message}`);
      console.error('  [ledger] falling back to the local consensus ledger for this run.\n');
      instance = new LocalLedger();
    }
  }
  return { kind: ledger().kind, degraded };
}

export function ledgerDegraded(): string | null { return degraded; }

export function resetLedger(): void { instance = null; degraded = null; }

/** Shared topics for sealed DMs: shard = H(cid) mod N hides which topic belongs to whom. */
export function shardFor(cid: string, shards: number): number {
  const h = createHash('sha256').update(cid).digest();
  return h.readUInt32BE(0) % Math.max(1, shards);
}
