/**
 * One nonce authority per EVM account, process-wide.
 *
 * An account has exactly one nonce sequence, so anything that broadcasts from it must
 * agree on the next value. Two independent trackers on the same address — say a registry
 * write pipeline and an x402 settlement path that happen to share a wallet — will assign
 * the same nonce to different transactions, and one silently replaces the other. That is
 * precisely how a paid request ends up with no on-chain effect.
 *
 * So nonce assignment is centralised here, keyed by address. Acquisition and broadcast are
 * serialised per account (cheap: one RPC round trip), while confirmations happen in
 * parallel, which is what keeps throughput up.
 */
export type SendWithNonce<T> = (nonce: number) => Promise<T>;

interface AccountState {
  /** next nonce to hand out; null until synced from the chain */
  next: number | null;
  /** serialises acquire+broadcast for this account */
  chain: Promise<unknown>;
  inFlight: number;
}

const accounts = new Map<string, AccountState>();

function stateFor(address: string): AccountState {
  const key = address.toLowerCase();
  let s = accounts.get(key);
  if (!s) { s = { next: null, chain: Promise.resolve(), inFlight: 0 }; accounts.set(key, s); }
  return s;
}

/** Force a resync from the chain on the next send (after a nonce error or a restart). */
export function resetNonce(address: string): void {
  stateFor(address).next = null;
}

export function nonceStats(): Array<{ address: string; next: number | null; inFlight: number }> {
  return [...accounts.entries()].map(([address, s]) => ({ address, next: s.next, inFlight: s.inFlight }));
}

const NONCE_ERROR = /nonce too low|nonce has already been used|already known|invalid nonce|nonce too high|replacement transaction underpriced/i;

export function isNonceError(err: unknown): boolean {
  return err instanceof Error && NONCE_ERROR.test(err.message);
}

/**
 * Run `send` with the next nonce for `address`, serialised against every other sender on
 * that account. On a nonce error the local view is discarded and the send is retried
 * against a freshly read value.
 */
export async function withNonce<T>(
  publicClient: { getTransactionCount: (args: { address: `0x${string}`; blockTag: 'pending' }) => Promise<number> },
  address: `0x${string}`,
  send: SendWithNonce<T>,
  opts: { retries?: number } = {},
): Promise<T> {
  const state = stateFor(address);
  const retries = opts.retries ?? 3;

  const run = async (): Promise<T> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (state.next === null) {
        state.next = await publicClient.getTransactionCount({ address, blockTag: 'pending' });
      }
      const nonce = state.next!;
      try {
        const result = await send(nonce);
        // Only advance once the broadcast is accepted; a rejected send must not burn a nonce.
        state.next = nonce + 1;
        return result;
      } catch (err) {
        if (isNonceError(err) && attempt < retries) {
          state.next = null;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error('exhausted nonce retries');
  };

  // Chain onto this account's queue so acquire+broadcast never interleave.
  const queued = state.chain.then(run, run);
  state.chain = queued.catch(() => undefined);
  state.inFlight += 1;
  try {
    return await queued;
  } finally {
    state.inFlight -= 1;
  }
}
