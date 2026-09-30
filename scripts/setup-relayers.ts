/**
 * Provision additional relayer lanes for high-throughput registry writes.
 *
 *   npx tsx scripts/setup-relayers.ts [count]
 *
 * One EVM account has one nonce stream, so a single relayer caps registry throughput at
 * roughly one confirmation per write. Each extra lane is an independent account, and the
 * writer partitions work across them by entity id (keeping per-agent ordering intact).
 *
 * Each new account needs two things, and missing either fails in a confusing way:
 *   1. gas, or its transactions cannot be paid for;
 *   2. authorisation on the contract (`setRelayer`), or every write reverts NotAuthorized.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const FUND_PER_LANE = process.env.LANE_FUNDING_ETH ?? '0.02';

function normalise(key: string): Hex {
  const hex = key.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('malformed private key');
  return `0x${hex}` as Hex;
}

async function main() {
  const count = Number(process.argv[2] ?? 3);
  const adminKey = process.env.RELAYER_PRIVATE_KEY;
  const registry = process.env.REGISTRY_ADDRESS as `0x${string}` | undefined;
  if (!adminKey) throw new Error('RELAYER_PRIVATE_KEY (the contract admin) must be set');
  if (!registry) throw new Error('REGISTRY_ADDRESS must be set — deploy the contract first');

  const abi = JSON.parse(readFileSync('contracts/out/AgentLineRegistry.sol/AgentLineRegistry.json', 'utf8')).abi;
  const chain = Number(process.env.REGISTRY_CHAIN_ID ?? 84532) === base.id ? base : baseSepolia;
  const rpcUrl = process.env.REGISTRY_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';

  const admin = privateKeyToAccount(normalise(adminKey));
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });

  const onchainAdmin = await pub.readContract({ address: registry, abi, functionName: 'admin' });
  if (String(onchainAdmin).toLowerCase() !== admin.address.toLowerCase()) {
    throw new Error(`RELAYER_PRIVATE_KEY is not the contract admin (${onchainAdmin}) — only the admin can authorise lanes`);
  }

  // Reuse lanes already in .env so this script is idempotent.
  let env = readFileSync('.env', 'utf8');
  const existing = (/^RELAYER_PRIVATE_KEYS=(.*)$/m.exec(env)?.[1] ?? '')
    .split(',').map((k) => k.trim()).filter(Boolean);
  const keys: Hex[] = existing.length ? existing.map(normalise) : [normalise(adminKey)];

  while (keys.length < count + 1) keys.push(generatePrivateKey());

  const balance = await pub.getBalance({ address: admin.address });
  console.log(`admin ${admin.address} holds ${formatEther(balance)} ETH`);
  console.log(`provisioning ${keys.length} lane(s) on ${chain.name}\n`);

  for (const [i, key] of keys.entries()) {
    const account = privateKeyToAccount(key);
    const isAdmin = account.address.toLowerCase() === admin.address.toLowerCase();
    const [gas, authorised] = await Promise.all([
      pub.getBalance({ address: account.address }),
      pub.readContract({ address: registry, abi, functionName: 'relayer', args: [account.address] }) as Promise<boolean>,
    ]);
    console.log(`lane ${i}  ${account.address}  ${formatEther(gas)} ETH  authorised=${authorised}${isAdmin ? '  (admin)' : ''}`);

    if (!isAdmin && gas < parseEther(FUND_PER_LANE) / 2n) {
      const hash = await wallet.sendTransaction({ to: account.address, value: parseEther(FUND_PER_LANE), chain, account: admin });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`         funded with ${FUND_PER_LANE} ETH (${hash})`);
    }
    if (!authorised) {
      const hash = await wallet.writeContract({
        address: registry, abi, functionName: 'setRelayer', args: [account.address, true], chain, account: admin,
      });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`         authorised on the registry (${hash})`);
    }
  }

  const line = `RELAYER_PRIVATE_KEYS=${keys.join(',')}`;
  env = /^RELAYER_PRIVATE_KEYS=.*$/m.test(env)
    ? env.replace(/^RELAYER_PRIVATE_KEYS=.*$/m, line)
    : env.replace(/\n?$/, '\n') + line + '\n';
  writeFileSync('.env', env);

  console.log(`\n✓ ${keys.length} lanes ready. RELAYER_PRIVATE_KEYS written to .env — restart the gateway.`);
  console.log('  Each lane is an independent nonce stream; writes are partitioned by entity id,');
  console.log('  so dependent writes for one agent stay ordered while different agents run in parallel.');
}

main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
