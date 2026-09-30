/**
 * Configuration check: what is wired up, what is still missing, and exactly what to do next.
 *   npm run doctor
 */
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createPublicClient, formatEther, formatUnits, http, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { chainMode, config, paymentMode, registryMode } from '../apps/gateway/src/config.ts';

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

async function main() {
  console.log('\nAgentLine configuration check\n');

  console.log('Contracts');
  existsSync('contracts/out/AgentLineRegistry.sol/AgentLineRegistry.json')
    ? ok('registry artifact compiled')
    : bad('registry not compiled — run: npm run contracts:build');

  console.log('\nRegistry (identity + mappings)');
  if (registryMode() === 'onchain') {
    ok(`on-chain at ${config.registry.address} (chain ${config.registry.chainId})`);
  } else {
    warn('local mirror only — set REGISTRY_ADDRESS and RELAYER_PRIVATE_KEY to write on-chain');
    if (!config.registry.address) console.log('      missing REGISTRY_ADDRESS (run: npm run contracts:deploy)');
    if (!config.registry.relayerPrivateKey) console.log('      missing RELAYER_PRIVATE_KEY');
  }

  console.log('\nConsensus transport (messages + notifications)');
  if (chainMode() === 'hedera') {
    ok(`Hedera ${config.hedera.network} as ${config.hedera.accountId}`);
    try {
      const res = await fetch(`${config.hedera.mirrorRest}/api/v1/accounts/${config.hedera.accountId}`);
      if (res.ok) {
        const json = (await res.json()) as { balance?: { balance?: number } };
        const tinybars = json.balance?.balance ?? 0;
        const hbar = tinybars / 1e8;
        hbar > 1 ? ok(`operator balance ${hbar.toFixed(2)} HBAR`) : warn(`operator balance ${hbar.toFixed(4)} HBAR — top up, topic creation needs fees`);
      } else warn(`mirror node lookup returned ${res.status}`);
    } catch (err) { warn(`could not reach mirror node: ${(err as Error).message}`); }
  } else {
    warn('local consensus ledger — set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY for real HCS');
    console.log('      testnet account: https://portal.hedera.com (free)');
  }

  console.log('\nx402 payments');
  const mode = paymentMode();
  if (mode === 'disabled') warn('payments disabled (X402_ENABLED=false) — every route is free');
  else {
    config.x402.payTo ? ok(`receiving to ${config.x402.payTo}`) : bad('X402_PAY_TO is unset — paid routes will fail');
    ok(`network ${config.x402.network} (${config.x402.caip2}), asset ${config.x402.asset}`);
    if (mode === 'settle') ok('settling directly with SETTLER_PRIVATE_KEY');
    else if (mode === 'facilitator') ok(`settling via facilitator ${config.x402.facilitatorUrl}`);
    else warn('verify-only: payment authorizations are verified but never settled (X402_DEV_ACCEPT_UNSETTLED=true)');
  }

  const chain = config.x402.chainId === base.id ? base : baseSepolia;
  for (const [label, pk] of [['relayer', config.registry.relayerPrivateKey], ['settler', config.x402.settlerPrivateKey]] as const) {
    if (!pk) continue;
    try {
      const account = privateKeyToAccount(pk);
      const client = createPublicClient({ chain, transport: http(config.x402.rpcUrl) });
      const [eth, usdc] = await Promise.all([
        client.getBalance({ address: account.address }),
        client.readContract({ address: config.x402.asset, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }).catch(() => 0n),
      ]);
      const gasNote = eth === 0n ? ' (no gas! fund it)' : '';
      console.log(`\n${label} wallet ${account.address}`);
      console.log(`  ${formatEther(eth)} ETH${gasNote}, ${formatUnits(usdc as bigint, 6)} USDC on ${chain.name}`);
      if (eth === 0n) console.log('  faucet: https://www.alchemy.com/faucets/base-sepolia');
    } catch (err) { bad(`${label} key unusable: ${(err as Error).message}`); }
  }

  console.log(`\nGateway will start in: consensus=${chainMode()} registry=${registryMode()} payments=${paymentMode()}`);
  console.log('Everything above can be left unset for a local demo — the gateway degrades to a local');
  console.log('consensus ledger and a local registry mirror, and the protocol behaves identically.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
