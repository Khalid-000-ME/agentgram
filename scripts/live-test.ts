/**
 * Live testnet verification: real x402 USDC settlement on Base Sepolia, real registry
 * writes, and a real encrypted round trip. Reports chain artifacts you can open in a block
 * explorer / mirror node.
 *
 *   npx tsx scripts/live-test.ts
 */
import 'dotenv/config';
import { createPublicClient, erc20Abi, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { AgentLine, MemoryKeyStore } from '@agentline/sdk';
import { idToBytes32 } from '@agentline/crypto';

const BASE = process.env.AGENTLINE_URL ?? 'http://localhost:8402';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const REGISTRY = process.env.REGISTRY_ADDRESS as `0x${string}`;
const abi = JSON.parse(readFileSync('contracts/out/AgentLineRegistry.sol/AgentLineRegistry.json', 'utf8')).abi;

const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const line = (s = '') => console.log(`   ${s}`);

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
const usdcOf = async (a: `0x${string}`) =>
  formatUnits((await pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })) as bigint, 6);

async function main() {
  const payerKey = process.env.DEMO_PRIVATE_KEY as `0x${string}`;
  if (!payerKey) throw new Error('DEMO_PRIVATE_KEY is not set');
  const payer = privateKeyToAccount(payerKey);
  const payTo = process.env.X402_PAY_TO as `0x${string}`;

  step('0. Chain wiring');
  const status = await (await fetch(`${BASE}/v1/status`)).json() as any;
  line(`gateway modes      ${JSON.stringify(status.modes)}`);
  line(`registry contract  ${REGISTRY}`);
  line(`payer wallet       ${payer.address}`);
  line(`paying to          ${payTo}`);
  const payerBefore = await usdcOf(payer.address);
  const payeeBefore = await usdcOf(payTo);
  line(`USDC before        payer ${payerBefore} / payee ${payeeBefore}`);

  step('1. Register an agent — 0.50 USDC settled through x402');
  const handle = `live.${Date.now().toString(36)}`;
  const agent = await AgentLine.connect({
    baseUrl: BASE, keyStore: new MemoryKeyStore(), wallet: { privateKey: payerKey },
    handle, profile: { name: 'LiveTest', description: 'testnet verification agent' },
  });
  line(`agentId    ${agent.agentId}`);
  line(`handle     @${agent.handle}`);
  line(`inboxTopic ${agent.inboxTopic}`);

  step('2. Read that agent back from the registry contract on Base Sepolia');
  let onchain: any;
  for (let i = 0; i < 10; i++) {
    onchain = await pub.readContract({ address: REGISTRY, abi, functionName: 'getAgent', args: [idToBytes32(agent.agentId)] });
    if (onchain?.owner && !/^0x0+$/.test(onchain.owner)) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!onchain?.owner || /^0x0+$/.test(onchain.owner)) {
    line('! not yet visible on-chain (registry tx may still be pending)');
  } else {
    line(`owner        ${onchain.owner}`);
    line(`ed25519 key  ${onchain.ed25519IdentityKey}`);
    line(`inbox topic  ${onchain.inboxTopic}`);
    line(`keyEpoch     ${onchain.keyEpoch}   status ${onchain.status} (1=ACTIVE)`);
    const resolved = await pub.readContract({ address: REGISTRY, abi, functionName: 'agentByHandleHash', args: [(await import('@agentline/crypto')).handleHash(handle)] });
    line(`@${handle} resolves on-chain to ${resolved === idToBytes32(agent.agentId) ? 'this agent ✓' : String(resolved)}`);
  }

  step('3. Second agent, then a real encrypted message (paid per request)');
  const peer = await AgentLine.connect({
    baseUrl: BASE, keyStore: new MemoryKeyStore(), wallet: { privateKey: payerKey },
    profile: { name: 'LivePeer' },
  });
  line(`peer ${peer.agentId}`);
  const sent = await agent.send(peer.agentId, 'live testnet message — encrypted client-side');
  line(`sent seq ${sent.sequenceNumber} at consensus ${sent.consensusTimestamp}`);
  line(`payment  ${JSON.stringify(sent.payment)}`);

  await peer.syncConversations();
  const got = await peer.read(sent.cid);
  const text = got.find((m) => m.message.type === 'text');
  line(`peer decrypted: ${JSON.stringify(text?.message.body)}`);

  step('4. USDC actually moved');
  const payerAfter = await usdcOf(payer.address);
  const payeeAfter = await usdcOf(payTo);
  line(`payer ${payerBefore} -> ${payerAfter}`);
  line(`payee ${payeeBefore} -> ${payeeAfter}`);
  const moved = Number(payerBefore) - Number(payerAfter);
  line(moved > 0 ? `✓ ${moved.toFixed(6)} USDC settled on-chain` : '! no on-chain movement yet (see settlement mode below)');

  step('5. Chain artifacts');
  const final = await (await fetch(`${BASE}/v1/status`)).json() as any;
  line(`registry      https://sepolia.basescan.org/address/${REGISTRY}`);
  line(`payee wallet  https://sepolia.basescan.org/address/${payTo}`);
  line(`consensus     ${final.consensus.kind}${final.consensus.degradedFrom ? ' (degraded)' : ''}`);
  line(`revenue       ${final.stats.revenue} USDC over ${final.stats.messagesSent} messages`);
}

main().catch((err) => { console.error('\nLIVE TEST FAILED:', err.message); process.exit(1); });
