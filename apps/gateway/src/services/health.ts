/**
 * Periodic health checks.
 *
 * Watches the things that silently stop a paid, on-chain service: an operator account out
 * of HBAR so no message can be submitted, a relayer out of gas so no registry write lands,
 * a settler out of USDC allowance, a degraded consensus transport, or a rising 5xx rate.
 * Each check raises a throttled alert rather than logging into the void.
 */
import { createPublicClient, erc20Abi, formatEther, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { config } from '../config.ts';
import { raiseAlert } from './alerts.ts';
import { ledger, ledgerDegraded } from './ledger.ts';

export interface HealthSnapshot {
  at: number;
  consensus: { kind: string; degraded: string | null; hbar?: number };
  relayer?: { address: string; eth: string; usdc: string };
  errors: { total: number; last5xx: number; rate: string };
  alertsRaised: number;
  ok: boolean;
  problems: string[];
}

/** Thresholds below which the service will soon stop working, not merely look untidy. */
const MIN_HBAR = Number(process.env.MIN_HBAR ?? 5);
const MIN_ETH = Number(process.env.MIN_ETH ?? 0.005);
const MIN_USDC = Number(process.env.MIN_USDC ?? 1);

let requestCount = 0;
let errorCount = 0;
let last: HealthSnapshot | null = null;
let timer: NodeJS.Timeout | null = null;

export function noteRequest(): void { requestCount += 1; }
export function noteServerError(): void { errorCount += 1; }

export function lastHealth(): HealthSnapshot | null { return last; }

function chain() { return config.x402.chainId === base.id ? base : baseSepolia; }

async function hbarBalance(): Promise<number | undefined> {
  if (!config.hedera.accountId) return undefined;
  try {
    const res = await fetch(`${config.hedera.mirrorRest}/api/v1/accounts/${config.hedera.accountId}`);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { balance?: { balance?: number } };
    return (json.balance?.balance ?? 0) / 1e8;
  } catch { return undefined; }
}

export async function runHealthCheck(): Promise<HealthSnapshot> {
  const problems: string[] = [];
  const snapshot: HealthSnapshot = {
    at: Date.now(),
    consensus: { kind: ledger().kind, degraded: ledgerDegraded() },
    errors: {
      total: requestCount,
      last5xx: errorCount,
      rate: requestCount ? `${((errorCount / requestCount) * 100).toFixed(2)}%` : '0%',
    },
    alertsRaised: 0,
    ok: true,
    problems,
  };

  // 1. consensus transport degraded — messages are not reaching the chain we advertise
  if (snapshot.consensus.degraded) {
    problems.push('consensus transport degraded to the local ledger');
    raiseAlert({
      severity: 'critical',
      kind: 'consensus.degraded',
      title: 'Consensus transport degraded — messages are NOT on Hedera',
      detail: `The gateway is configured for Hedera but fell back to the local ledger: ${snapshot.consensus.degraded}`,
      meta: { configured: config.hedera.network, account: config.hedera.accountId },
    });
  }

  // 2. operator HBAR — no HBAR means no topic creation and no message submission
  if (ledger().kind === 'hedera') {
    const hbar = await hbarBalance();
    snapshot.consensus.hbar = hbar;
    if (hbar !== undefined && hbar < MIN_HBAR) {
      problems.push(`operator HBAR low (${hbar.toFixed(2)})`);
      raiseAlert({
        severity: hbar < 1 ? 'critical' : 'warning',
        kind: 'hedera.low_balance',
        title: `Hedera operator balance low: ${hbar.toFixed(2)} HBAR`,
        detail: `Account ${config.hedera.accountId} is below the ${MIN_HBAR} HBAR threshold. Message submission and topic creation will start failing.`,
        meta: { account: config.hedera.accountId, hbar, threshold: MIN_HBAR },
      });
    }
  }

  // 3. relayer gas and settler USDC — no gas means registry writes silently stop
  const relayerKey = config.registry.relayerPrivateKey ?? config.x402.settlerPrivateKey;
  if (relayerKey) {
    try {
      const account = privateKeyToAccount(relayerKey);
      const client = createPublicClient({ chain: chain(), transport: http(config.x402.rpcUrl) });
      const [wei, usdcRaw] = await Promise.all([
        client.getBalance({ address: account.address }),
        client.readContract({ address: config.x402.asset, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }).catch(() => 0n),
      ]);
      const eth = formatEther(wei);
      const usdc = formatUnits(usdcRaw as bigint, 6);
      snapshot.relayer = { address: account.address, eth, usdc };

      if (Number(eth) < MIN_ETH) {
        problems.push(`relayer gas low (${Number(eth).toFixed(5)} ETH)`);
        raiseAlert({
          severity: Number(eth) === 0 ? 'critical' : 'warning',
          kind: 'relayer.low_gas',
          title: `Relayer gas low: ${Number(eth).toFixed(5)} ETH`,
          detail: `${account.address} is below ${MIN_ETH} ETH on ${chain().name}. Registry writes and self-settled payments will fail.`,
          meta: { address: account.address, eth, threshold: MIN_ETH, chain: chain().name },
        });
      }
      if (Number(usdc) < MIN_USDC) {
        problems.push(`relayer USDC low (${usdc})`);
        raiseAlert({
          severity: 'info',
          kind: 'relayer.low_usdc',
          title: `Relayer USDC low: ${usdc}`,
          detail: `${account.address} holds less than ${MIN_USDC} USDC. This only matters if it also funds test agents.`,
          meta: { address: account.address, usdc },
        });
      }
    } catch (err) {
      problems.push(`could not read relayer balances: ${(err as Error).message}`);
    }
  }

  // 4. error rate — a spike means clients are being turned away
  if (requestCount >= 20 && errorCount / requestCount > 0.1) {
    problems.push(`5xx rate ${snapshot.errors.rate}`);
    raiseAlert({
      severity: 'critical',
      kind: 'gateway.error_rate',
      title: `Gateway error rate ${snapshot.errors.rate}`,
      detail: `${errorCount} server errors out of ${requestCount} requests since start.`,
      meta: snapshot.errors,
    });
  }

  snapshot.ok = problems.length === 0;
  last = snapshot;
  return snapshot;
}

export function startHealthMonitor(intervalMs = Number(process.env.HEALTH_INTERVAL_MS ?? 5 * 60_000)): void {
  if (timer) return;
  // Run once shortly after boot so a misconfiguration surfaces immediately, then on a timer.
  setTimeout(() => void runHealthCheck().catch(() => undefined), 5_000);
  timer = setInterval(() => void runHealthCheck().catch(() => undefined), intervalMs);
  timer.unref();
}

export function stopHealthMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
