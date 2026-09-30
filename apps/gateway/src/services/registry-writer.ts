/**
 * Registry write pipeline.
 *
 * The naive approach — serialize every contract write through one promise chain — is
 * correct for one write at a time and wrong under load: throughput collapses to one
 * confirmation per write (~2–4 s), and concurrent callers on a single account collide on
 * the nonce, so writes get dropped or silently replaced.
 *
 * This pipeline fixes both:
 *
 *  - **Lanes.** Each relayer key is an independent nonce stream, drained in parallel. Set
 *    RELAYER_PRIVATE_KEYS to a comma-separated list to widen the pipe.
 *  - **Deterministic partitioning.** A write is assigned to a lane by hashing its entity
 *    id, so dependent writes for the same agent (register → publish prekeys) keep their
 *    order, while unrelated agents proceed concurrently.
 *  - **Pipelined submission.** Within a lane we await the *broadcast*, not the receipt, and
 *    track the nonce locally. Confirmations are collected separately, so a lane submits at
 *    RPC latency rather than block latency.
 *  - **Classified retries.** "Already exists" is success (the contract is idempotent for
 *    our purposes). Nonce desync resyncs and retries. RPC or funding failures keep the
 *    write in an encrypted durable buffer and retry with backoff instead of dropping it.
 *  - **Gas bumping.** A transaction that does not confirm is resubmitted at the same nonce
 *    with higher fees, rather than wedging the lane behind it.
 */
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { config } from '../config.ts';
import { raiseAlert } from './alerts.ts';
import { resetNonce, withNonce } from './nonce-manager.ts';
import { WriteBuffer, decodeArgs, encodeArgs, type PendingWrite } from './write-buffer.ts';

export interface WriteResult {
  ok: boolean;
  txHash?: string;
  /** the write is queued for retry rather than lost */
  queued?: boolean;
  /** already present on-chain; nothing to do */
  idempotent?: boolean;
  error?: string;
}

export interface WriterStats {
  lanes: number;
  relayers: string[];
  queued: number;
  inFlight: number;
  confirmed: number;
  idempotent: number;
  retrying: number;
  deadLettered: number;
  lastError?: string;
  paused: boolean;
}

type Classification = 'confirmed' | 'idempotent' | 'nonce_desync' | 'underpriced' | 'no_funds' | 'rpc_down' | 'reverted';

const MAX_ATTEMPTS = Number(process.env.REGISTRY_MAX_ATTEMPTS ?? 8);
const CONFIRM_TIMEOUT_MS = Number(process.env.REGISTRY_CONFIRM_TIMEOUT_MS ?? 45_000);
const MAX_IN_FLIGHT_PER_LANE = Number(process.env.REGISTRY_MAX_IN_FLIGHT ?? 8);

/** Reverts that mean "the desired state is already on-chain", which is a success for us. */
const IDEMPOTENT_REVERTS = [/AlreadyExists/i, /already exists/i, /HandleTaken/i];

function classify(err: Error): Classification {
  const m = `${err.message}`.toLowerCase();
  if (IDEMPOTENT_REVERTS.some((re) => re.test(err.message))) return 'idempotent';
  if (/nonce too low|nonce has already been used|already known|invalid nonce|nonce too high/.test(m)) return 'nonce_desync';
  if (/replacement transaction underpriced|underpriced|fee too low|max fee per gas less than/.test(m)) return 'underpriced';
  if (/insufficient funds|gas required exceeds/.test(m)) return 'no_funds';
  if (/fetch failed|timeout|socket|econn|enotfound|network|503|502|504|429|rate limit|service unavailable/.test(m)) return 'rpc_down';
  return 'reverted';
}

interface Lane {
  index: number;
  account: ReturnType<typeof privateKeyToAccount>;
  wallet: any;
  inFlight: number;
}

export class RegistryWriter {
  private publicClient: any = null;
  private lanes: Lane[] = [];
  private buffer: WriteBuffer;
  private stats = { confirmed: 0, idempotent: 0, deadLettered: 0, lastError: undefined as string | undefined };
  private retryTimer: NodeJS.Timeout | null = null;
  private paused = false;

  constructor(private abi: Abi, private address?: Address) {
    this.buffer = new WriteBuffer();
    this.initLanes();
    if (this.enabled) this.startRetryLoop();
  }

  private relayerKeys(): Hex[] {
    const list = process.env.RELAYER_PRIVATE_KEYS ?? '';
    const keys = list.split(',').map((k) => k.trim()).filter(Boolean);
    if (!keys.length && config.registry.relayerPrivateKey) keys.push(config.registry.relayerPrivateKey);
    return keys.map((k) => {
      const hex = k.replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('RELAYER_PRIVATE_KEYS contains a malformed key');
      return `0x${hex}` as Hex;
    });
  }

  private initLanes(): void {
    const keys = this.relayerKeys();
    if (!keys.length || !this.address) return;
    const chain = this.chainDef();
    this.lanes = keys.map((key, index) => {
      const account = privateKeyToAccount(key);
      return {
        index,
        account,
        wallet: createWalletClient({ account, chain, transport: http(config.registry.rpcUrl) }),
        inFlight: 0,
      };
    });
    if (this.lanes.length > 1) {
      console.log(`[registry] ${this.lanes.length} relayer lanes: ${this.lanes.map((l) => l.account.address.slice(0, 10)).join(', ')}`);
    }
  }

  private chainDef() { return config.registry.chainId === base.id ? base : baseSepolia; }

  private client() {
    if (!this.publicClient) {
      this.publicClient = createPublicClient({ chain: this.chainDef(), transport: http(config.registry.rpcUrl) });
    }
    return this.publicClient;
  }

  get enabled(): boolean { return this.lanes.length > 0 && !!this.address; }

  get relayerAddresses(): string[] { return this.lanes.map((l) => l.account.address); }

  /** Same partition always lands on the same lane, preserving per-entity ordering. */
  private laneFor(partition: string): Lane {
    if (this.lanes.length === 1) return this.lanes[0];
    const h = keccak256(toHex(partition));
    const n = parseInt(h.slice(2, 10), 16);
    return this.lanes[n % this.lanes.length];
  }

  /**
   * Enqueue a write. Resolves once the transaction is broadcast and confirmed, or — if the
   * chain is unreachable — once the write is safely buffered for retry. It never throws:
   * the caller has already been paid and must get a useful response either way.
   */
  async submit(fn: string, args: unknown[], partition: string): Promise<WriteResult> {
    if (!this.enabled) return { ok: false, error: 'registry writes are not configured' };

    const write: PendingWrite = {
      id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      fn,
      args: encodeArgs(args),
      partition,
      attempts: 0,
      firstQueuedAt: Date.now(),
    };
    this.buffer.add(write);
    return this.attempt(write);
  }

  private async attempt(write: PendingWrite): Promise<WriteResult> {
    const lane = this.laneFor(write.partition);

    // Back-pressure: hold off rather than flooding a lane past what the RPC will accept.
    while (lane.inFlight >= MAX_IN_FLIGHT_PER_LANE) {
      await new Promise((r) => setTimeout(r, 150));
    }

    write.attempts += 1;
    write.lastAttemptAt = Date.now();
    lane.inFlight += 1;

    try {
      const args = decodeArgs(write.args);
      // The shared nonce manager is the single authority for this account, so a settlement
      // transaction from the same wallet can never be assigned the same nonce.
      const hash = await withNonce(this.client(), lane.account.address, async (nonce) => {
        write.nonce = nonce;
        return (await lane.wallet.writeContract({
          address: this.address!,
          abi: this.abi,
          functionName: write.fn,
          args: args as never,
          chain: this.chainDef(),
          account: lane.account,
          nonce,
        })) as Hex;
      });
      write.txHash = hash;
      this.buffer.update(write);

      const receipt = await this.confirm(lane, write, hash);
      if (receipt === 'confirmed') {
        this.stats.confirmed += 1;
        this.buffer.remove(write.id);
        return { ok: true, txHash: hash };
      }
      // reverted on-chain: classify against the contract's idempotent reverts
      const reason = await this.revertReason(hash);
      if (IDEMPOTENT_REVERTS.some((re) => re.test(reason))) {
        this.stats.idempotent += 1;
        this.buffer.remove(write.id);
        return { ok: true, txHash: hash, idempotent: true };
      }
      return this.handleFailure(lane, write, new Error(`transaction reverted: ${reason}`));
    } catch (err) {
      return this.handleFailure(lane, write, err as Error);
    } finally {
      lane.inFlight -= 1;
    }
  }

  /** Wait for a receipt, bumping fees at the same nonce if it stalls. */
  private async confirm(lane: Lane, write: PendingWrite, hash: Hex): Promise<'confirmed' | 'reverted'> {
    try {
      const receipt = await this.client().waitForTransactionReceipt({ hash, confirmations: 1, timeout: CONFIRM_TIMEOUT_MS });
      return receipt.status === 'success' ? 'confirmed' : 'reverted';
    } catch (err) {
      if (!/timed out|timeout/i.test((err as Error).message)) throw err;
      // Stuck in the mempool. Resubmitting at the same nonce with higher fees either
      // replaces it or reveals that the original already landed.
      console.warn(`[registry] ${write.fn} nonce ${write.nonce} stalled; bumping fees`);
      const bumped = await this.resubmitBumped(lane, write);
      const receipt = await this.client().waitForTransactionReceipt({ hash: bumped, confirmations: 1, timeout: CONFIRM_TIMEOUT_MS });
      write.txHash = bumped;
      return receipt.status === 'success' ? 'confirmed' : 'reverted';
    }
  }

  private async resubmitBumped(lane: Lane, write: PendingWrite): Promise<Hex> {
    const fees = await this.client().estimateFeesPerGas();
    const bump = (v: bigint | undefined) => (v === undefined ? undefined : (v * 150n) / 100n);
    return (await lane.wallet.writeContract({
      address: this.address!,
      abi: this.abi,
      functionName: write.fn,
      args: decodeArgs(write.args) as never,
      chain: this.chainDef(),
      account: lane.account,
      nonce: write.nonce!,
      maxFeePerGas: bump(fees.maxFeePerGas),
      maxPriorityFeePerGas: bump(fees.maxPriorityFeePerGas),
    })) as Hex;
  }

  private async revertReason(hash: Hex): Promise<string> {
    try {
      const tx = await this.client().getTransaction({ hash });
      await this.client().call({ to: tx.to, data: tx.input, value: tx.value, account: tx.from, blockNumber: tx.blockNumber });
      return 'unknown';
    } catch (err) {
      return (err as Error).message.split('\n')[0];
    }
  }

  private async handleFailure(lane: Lane, write: PendingWrite, err: Error): Promise<WriteResult> {
    const kind = classify(err);
    write.lastError = `${kind}: ${err.message.split('\n')[0]}`.slice(0, 300);
    this.stats.lastError = write.lastError;
    this.buffer.update(write);

    switch (kind) {
      case 'idempotent':
        // Desired state already on-chain; nothing was lost.
        this.stats.idempotent += 1;
        this.buffer.remove(write.id);
        return { ok: true, idempotent: true };

      case 'nonce_desync':
      case 'underpriced':
        // Our view of the account drifted from the chain's. Resync and retry promptly.
        resetNonce(lane.account.address);
        if (write.attempts < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * write.attempts));
          return this.attempt(write);
        }
        break;

      case 'rpc_down':
      case 'no_funds':
        // Not our caller's fault and not fixable by retrying immediately. Keep it buffered;
        // the retry loop will drain it once the dependency recovers.
        if (kind === 'no_funds') {
          raiseAlert({
            severity: 'critical',
            kind: 'registry.no_funds',
            title: 'Relayer is out of gas — registry writes are queued, not lost',
            detail: `${lane.account.address} cannot pay for ${write.fn}. ${this.buffer.size} write(s) are buffered and will be retried once funded.`,
            meta: { relayer: lane.account.address, queued: this.buffer.size },
          });
        }
        return { ok: false, queued: true, error: write.lastError };

      case 'reverted':
        break;
    }

    if (write.attempts >= MAX_ATTEMPTS) {
      this.stats.deadLettered += 1;
      this.buffer.remove(write.id);
      raiseAlert({
        severity: 'critical',
        kind: `registry.dead_letter.${write.fn}`,
        title: `Registry write permanently failed: ${write.fn}`,
        detail: `Gave up after ${write.attempts} attempts. On-chain state is now behind the gateway's view. Last error: ${write.lastError}`,
        meta: { fn: write.fn, partition: write.partition, attempts: write.attempts, txHash: write.txHash },
      });
      return { ok: false, error: write.lastError };
    }
    return { ok: false, queued: true, error: write.lastError };
  }

  /** Drain buffered writes in the background; this is what makes an RPC outage survivable. */
  private startRetryLoop(): void {
    const intervalMs = Number(process.env.REGISTRY_RETRY_INTERVAL_MS ?? 15_000);
    this.retryTimer = setInterval(() => void this.drain().catch(() => undefined), intervalMs);
    this.retryTimer.unref();
  }

  async drain(): Promise<number> {
    if (!this.enabled || this.paused) return 0;
    const now = Date.now();
    const due = this.buffer.all().filter((w) => {
      if (!w.lastAttemptAt) return true;
      const backoff = Math.min(60_000, 2 ** Math.min(w.attempts, 6) * 1000);
      return now - w.lastAttemptAt > backoff;
    });
    if (!due.length) return 0;
    console.log(`[registry] retrying ${due.length} buffered write(s)`);
    let drained = 0;
    for (const write of due) {
      const result = await this.attempt(write);
      if (result.ok) drained += 1;
    }
    return drained;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  statistics(): WriterStats {
    return {
      lanes: this.lanes.length,
      relayers: this.relayerAddresses,
      queued: this.buffer.size,
      inFlight: this.lanes.reduce((n, l) => n + l.inFlight, 0),
      confirmed: this.stats.confirmed,
      idempotent: this.stats.idempotent,
      retrying: this.buffer.all().filter((w) => w.attempts > 0).length,
      deadLettered: this.stats.deadLettered,
      lastError: this.stats.lastError,
      paused: this.paused,
    };
  }

  shutdown(): void {
    if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
    this.buffer.flush();
  }
}
