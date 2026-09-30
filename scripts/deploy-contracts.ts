/**
 * Deploy AgentLineRegistry to Base Sepolia (or any configured EVM chain).
 *
 *   RELAYER_PRIVATE_KEY=0x… npm run contracts:deploy
 *
 * Prints the address to put in REGISTRY_ADDRESS. The deployer becomes admin and the first
 * authorised relayer; add more with setRelayer.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

const artifactPath = 'contracts/out/AgentLineRegistry.sol/AgentLineRegistry.json';

async function main() {
  const pk = (process.env.RELAYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY) as Hex | undefined;
  if (!pk) throw new Error('set RELAYER_PRIVATE_KEY (the deployer, which also becomes admin + relayer)');
  if (!existsSync(artifactPath)) throw new Error(`missing ${artifactPath} — run: npm run contracts:build`);

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const bytecode = (artifact.bytecode?.object ?? artifact.bytecode) as Hex;
  const chainId = Number(process.env.REGISTRY_CHAIN_ID ?? 84532);
  const chain = chainId === base.id ? base : baseSepolia;
  const rpcUrl = process.env.REGISTRY_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL
    ?? (chainId === base.id ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer ${account.address}`);
  console.log(`chain    ${chain.name} (${chainId}) via ${rpcUrl}`);
  console.log(`balance  ${formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error(`deployer has no ETH on ${chain.name}. Fund it first — Base Sepolia faucet: https://www.alchemy.com/faucets/base-sepolia`);
  }

  console.log('\ndeploying AgentLineRegistry…');
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode, args: [], chain, account });
  console.log(`tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deployment reverted');

  const address = receipt.contractAddress;
  console.log(`\n✓ AgentLineRegistry deployed at ${address}`);
  console.log(`  gas used ${receipt.gasUsed}`);
  console.log(`  explorer https://${chainId === base.id ? 'basescan.org' : 'sepolia.basescan.org'}/address/${address}`);

  // Sanity check: the deployer must be an authorised relayer, or gateway writes will revert.
  const isRelayer = await publicClient.readContract({
    address, abi: artifact.abi, functionName: 'relayer', args: [account.address],
  });
  console.log(`  deployer is relayer: ${isRelayer}`);

  writeEnv('REGISTRY_ADDRESS', address);
  console.log(`\nWrote REGISTRY_ADDRESS to .env. Restart the gateway to switch the registry to on-chain mode.`);
}

function writeEnv(key: string, value: string): void {
  const path = '.env';
  let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const line = `${key}=${value}`;
  content = new RegExp(`^${key}=.*$`, 'm').test(content)
    ? content.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${content.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(path, content);
}

main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
