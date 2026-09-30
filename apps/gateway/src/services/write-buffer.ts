/**
 * Durable, encrypted buffer for pending chain writes.
 *
 * When an RPC is down we must not drop a write that a caller already paid for, and we must
 * not lose it across a restart. So pending writes are persisted — but encrypted at rest,
 * because the queue is a metadata trove (which agent registered when, who joined which
 * group) even though it contains no message content and no agent keys.
 *
 * The key is derived from the relayer secret, so it is bound to the deployment without
 * introducing another secret to manage. Losing it only costs the pending queue, which is
 * exactly the kind of state that is safe to lose loudly.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aeadOpen, aeadSeal, b64, kdf, utf8 } from '@agentline/crypto';
import { config } from '../config.ts';

export interface PendingWrite {
  id: string;
  fn: string;
  /** JSON-encoded args (bigints stringified) */
  args: string;
  /** keeps dependent writes for one entity in order */
  partition: string;
  attempts: number;
  firstQueuedAt: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** set once broadcast, so a restart can check the chain instead of resubmitting blindly */
  txHash?: string;
  nonce?: number;
}

const FILE = 'write-buffer.enc';

function bufferKey(): Uint8Array {
  const secret = process.env.WRITE_BUFFER_KEY
    ?? config.registry.relayerPrivateKey
    ?? config.x402.settlerPrivateKey
    ?? 'agentline-write-buffer-dev';
  return kdf(utf8.enc(secret), 'AGL/write-buffer/v1');
}

export class WriteBuffer {
  private path: string;
  private items = new Map<string, PendingWrite>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir = config.dataDir) {
    this.path = join(dataDir, FILE);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const sealed = b64.dec(readFileSync(this.path, 'utf8').trim());
      const items = JSON.parse(utf8.dec(aeadOpen(bufferKey(), sealed))) as PendingWrite[];
      for (const item of items) this.items.set(item.id, item);
      if (items.length) console.log(`[write-buffer] recovered ${items.length} pending chain write(s) from disk`);
    } catch (err) {
      // A buffer we cannot decrypt is a buffer we cannot honour; say so rather than
      // pretending the queue is empty.
      console.error(`[write-buffer] could not read ${this.path}: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      try {
        mkdirSync(config.dataDir, { recursive: true });
        const sealed = aeadSeal(bufferKey(), utf8.enc(JSON.stringify([...this.items.values()])));
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, b64.enc(sealed), { mode: 0o600 });
        renameSync(tmp, this.path);
      } catch (err) {
        console.error(`[write-buffer] persist failed: ${(err as Error).message}`);
      }
    }, 200);
  }

  add(write: PendingWrite): void { this.items.set(write.id, write); this.persist(); }
  update(write: PendingWrite): void { this.items.set(write.id, write); this.persist(); }
  remove(id: string): void { if (this.items.delete(id)) this.persist(); }

  all(): PendingWrite[] { return [...this.items.values()]; }
  get size(): number { return this.items.size; }

  /** Oldest-first, so a backlog drains in the order callers were charged. */
  pendingFor(partitionFilter: (partition: string) => boolean): PendingWrite[] {
    return this.all()
      .filter((w) => partitionFilter(w.partition))
      .sort((a, b) => a.firstQueuedAt - b.firstQueuedAt);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = true;
    try {
      mkdirSync(config.dataDir, { recursive: true });
      const sealed = aeadSeal(bufferKey(), utf8.enc(JSON.stringify([...this.items.values()])));
      writeFileSync(this.path, b64.enc(sealed), { mode: 0o600 });
    } catch { /* best effort on shutdown */ }
  }
}

/** JSON round-trip that survives bigint args (topic numbers, durations). */
export function encodeArgs(args: unknown[]): string {
  return JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? { __bigint: v.toString() } : v));
}

export function decodeArgs(json: string): unknown[] {
  return JSON.parse(json, (_k, v) =>
    v && typeof v === 'object' && '__bigint' in v ? BigInt((v as { __bigint: string }).__bigint) : v) as unknown[];
}
