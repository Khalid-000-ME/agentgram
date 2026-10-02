/**
 * Encrypted on-chain checkpoints of the gateway's state.
 *
 * The gateway runs where the filesystem may be wiped at any restart (Render's free tier
 * spins an idle service down and starts a fresh container). Without this, a restart forgets
 * every registered agent and conversation route even though the facts are on-chain, and an
 * agent that paid to register gets `agent_not_found` on its next send.
 *
 * So the state is checkpointed to a Hedera topic: gzipped, sealed with XChaCha20-Poly1305
 * under a key only this deployment derives, and split into chunks that each fit one HCS
 * message. On boot, if local state is empty, the newest complete checkpoint is read back
 * from the mirror node and restored.
 *
 * What is NOT checkpointed, and why: the message index (every message is already on its
 * conversation topic and is re-indexed from there), inbox notices (on each agent's inbox
 * topic), the payment log and idempotency cache (operational, short-lived). That keeps a
 * checkpoint to the identity and routing state that cannot be cheaply re-derived.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { aeadOpen, aeadSeal, kdf, utf8 } from '@agentline/crypto';
import { chainMode, config } from '../config.ts';
import { store } from '../lib/store.ts';
import { raiseAlert } from './alerts.ts';
import { ledger } from './ledger.ts';
import { reindexConversation } from './relay.ts';

const MAGIC = utf8.enc('AGCP');
const HEADER = 4 + 8 + 2 + 2;           // magic, checkpoint id, chunk index, chunk count
const CHUNK = 1000 - HEADER;            // keeps every message under the 1024-byte HCS limit
const EXCLUDED = ['messages', 'notices', 'payments', 'idempotency'] as const;

let lastVersion = -1;
let running: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

export function checkpointTopic(): string | undefined {
  return process.env.CHECKPOINT_TOPIC_ID || (store.db as unknown as { checkpointTopic?: string }).checkpointTopic;
}

function key(): Uint8Array {
  const secret = process.env.CHECKPOINT_KEY ?? process.env.SHARD_TAG_KEY ?? config.hedera.privateKey ?? 'agentgram-dev';
  return kdf(utf8.enc(secret), 'AGL/checkpoint/v1');
}

const enabled = () => chainMode() === 'hedera';

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b;
}

/** Serialise, compress, seal and chunk the current state. */
function encode(id: number): Uint8Array[] {
  const snap: Record<string, unknown> = { ...store.db };
  for (const k of EXCLUDED) delete snap[k];
  const sealed = aeadSeal(key(), gzipSync(Buffer.from(JSON.stringify(snap))));
  const count = Math.ceil(sealed.length / CHUNK);
  if (count > 0xffff) throw new Error(`state too large to checkpoint (${sealed.length} bytes)`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const body = sealed.subarray(i * CHUNK, (i + 1) * CHUNK);
    const msg = new Uint8Array(HEADER + body.length);
    const dv = new DataView(msg.buffer);
    msg.set(MAGIC, 0); msg.set(u64(id), 4); dv.setUint16(12, i); dv.setUint16(14, count); msg.set(body, HEADER);
    out.push(msg);
  }
  return out;
}

async function ensureTopic(): Promise<string> {
  const existing = checkpointTopic();
  if (existing) return existing;
  const id = await ledger().createTopic('agentgram:checkpoints');
  (store.db as unknown as { checkpointTopic?: string }).checkpointTopic = id;
  console.warn(`[checkpoint] created topic ${id} — set CHECKPOINT_TOPIC_ID=${id} so a restart can find it`);
  raiseAlert({
    severity: 'warning', kind: 'checkpoint.topic_unpinned',
    title: `Set CHECKPOINT_TOPIC_ID=${id}`,
    detail: 'State checkpoints are being written, but without this variable a fresh container cannot find them to restore.',
  });
  return id;
}

/** Write a checkpoint if the state changed since the last one. */
export async function checkpoint(opts: { force?: boolean } = {}): Promise<{ chunks: number } | null> {
  if (!enabled()) return null;
  if (!opts.force && store.version === lastVersion) return null;
  if (running) { await running; if (!opts.force && store.version === lastVersion) return null; }

  let result: { chunks: number } | null = null;
  running = (async () => {
    const version = store.version;
    const topic = await ensureTopic();
    const chunks = encode(Date.now());
    // HCS has no account nonce to serialise on, so chunks go out in parallel, a few at a time.
    for (let i = 0; i < chunks.length; i += 8) {
      await Promise.all(chunks.slice(i, i + 8).map((c) => ledger().submit(topic, c)));
    }
    lastVersion = version;
    result = { chunks: chunks.length };
  })();
  try {
    await running;
  } catch (err) {
    raiseAlert({
      severity: 'warning', kind: 'checkpoint.failed',
      title: 'State checkpoint failed — will retry',
      detail: `Writing the encrypted state checkpoint to Hedera failed: ${(err as Error).message}`,
    });
  } finally {
    running = null;
  }
  return result;
}

interface Chunk { i: number; n: number; data: Uint8Array }

/** Read the newest complete checkpoint back from the mirror node. */
async function fetchLatest(topic: string): Promise<Uint8Array | null> {
  const groups = new Map<string, Chunk[]>();
  let url: string | null = `${config.hedera.mirrorRest}/api/v1/topics/${topic}/messages?order=desc&limit=100`;
  for (let page = 0; url && page < 40; page++) {
    const res: Response = await fetch(url);
    if (!res.ok) throw new Error(`mirror node ${res.status}`);
    const json = (await res.json()) as { messages?: Array<{ message: string }>; links?: { next?: string | null } };
    for (const m of json.messages ?? []) {
      const raw = new Uint8Array(Buffer.from(m.message, 'base64'));
      if (raw.length < HEADER || utf8.dec(raw.subarray(0, 4)) !== 'AGCP') continue;
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const id = dv.getBigUint64(4).toString();
      const list = groups.get(id) ?? [];
      list.push({ i: dv.getUint16(12), n: dv.getUint16(14), data: raw.subarray(HEADER) });
      groups.set(id, list);
    }
    // Newest first: return as soon as the newest checkpoint seen so far is complete.
    const ids = [...groups.keys()].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));
    for (const id of ids) {
      const list = groups.get(id)!;
      const n = list[0].n;
      const seen = new Map(list.map((c) => [c.i, c]));
      if (seen.size === n) {
        return Buffer.concat([...Array(n).keys()].map((i) => seen.get(i)!.data));
      }
    }
    url = json.links?.next ? `${config.hedera.mirrorRest}${json.links.next}` : null;
  }
  return null;
}

/**
 * Restore state on a cold start. Only runs when the local store is empty, so a restart
 * with a surviving disk never overwrites newer local state with an older checkpoint.
 */
export async function restoreIfEmpty(): Promise<{ restored: boolean; agents?: number; reason?: string }> {
  if (!enabled()) return { restored: false, reason: 'not on Hedera' };
  if (Object.keys(store.db.agents).length) return { restored: false, reason: 'local state present' };
  const topic = checkpointTopic();
  if (!topic) return { restored: false, reason: 'CHECKPOINT_TOPIC_ID not set' };

  const sealed = await fetchLatest(topic);
  if (!sealed) return { restored: false, reason: 'no complete checkpoint on the topic yet' };
  const snap = JSON.parse(gunzipSync(Buffer.from(aeadOpen(key(), sealed))).toString('utf8'));
  Object.assign(store.db, snap);
  store.save();
  lastVersion = store.version;

  // Messages live on their conversation topics; rebuild the read index in the background.
  void (async () => {
    for (const cid of Object.keys(store.db.conversations)) {
      try { await reindexConversation(cid, { limit: 100 }); } catch { /* retried on next read */ }
    }
  })();
  return { restored: true, agents: Object.keys(store.db.agents).length };
}

export function startCheckpoints(intervalMs = Number(process.env.CHECKPOINT_INTERVAL_MS ?? 90_000)): void {
  if (!enabled() || timer) return;
  timer = setInterval(() => void checkpoint(), intervalMs);
  timer.unref();
}
