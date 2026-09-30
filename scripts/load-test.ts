/**
 * Concurrency check: register N agents simultaneously and verify every one landed
 * on-chain. This is the test the single-queue design failed — parallel callers on one
 * relayer account collide on the nonce and writes get dropped or replaced.
 *
 *   npx tsx scripts/load-test.ts [agents] [messages-per-pair]
 */
import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { AgentLine, MemoryKeyStore } from '@agentline/sdk';
import { idToBytes32 } from '@agentline/crypto';

const BASE = process.env.AGENTLINE_URL ?? 'http://localhost:8402';
const REGISTRY = process.env.REGISTRY_ADDRESS as `0x${string}`;
const abi = JSON.parse(readFileSync('contracts/out/AgentLineRegistry.sol/AgentLineRegistry.json', 'utf8')).abi;

async function main() {
  const count = Number(process.argv[2] ?? 8);
  const perPair = Number(process.argv[3] ?? 2);
  const wallet = { privateKey: process.env.DEMO_PRIVATE_KEY as `0x${string}` };
  const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });

  console.log(`\nRegistering ${count} agents concurrently against ${BASE}\n`);
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      AgentLine.connect({
        baseUrl: BASE, keyStore: new MemoryKeyStore(), wallet,
        handle: `load.${Date.now().toString(36)}.${i}`,
        profile: { name: `Load agent ${i}` },
      })),
  );
  const elapsed = (Date.now() - t0) / 1000;
  const agents = settled.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<AgentLine>).value);
  const failures = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

  console.log(`registered ${agents.length}/${count} in ${elapsed.toFixed(1)}s  (${(agents.length / elapsed).toFixed(2)}/s)`);
  for (const f of failures.slice(0, 5)) console.log(`  FAILED: ${f.reason?.message?.slice(0, 120)}`);

  // Give buffered writes a chance to drain before auditing the chain.
  console.log('\nwaiting for the write pipeline to drain…');
  for (let i = 0; i < 24; i++) {
    const stats = await (await fetch(`${BASE}/v1/status`)).json() as any;
    const q = stats.registryWrites?.queued ?? 0;
    if (q === 0) break;
    process.stdout.write(`  queued=${q}\r`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log('\nauditing every agent against the registry contract:\n');
  let onchain = 0;
  const missing: string[] = [];
  for (const agent of agents) {
    const record = await pub.readContract({ address: REGISTRY, abi, functionName: 'getAgent', args: [idToBytes32(agent.agentId)] }) as any;
    const present = record?.owner && !/^0x0+$/.test(record.owner) && Number(record.status) === 1;
    if (present) onchain += 1; else missing.push(agent.agentId);
  }
  console.log(`  on-chain: ${onchain}/${agents.length}`);
  if (missing.length) {
    console.log('  MISSING (dropped or still queued):');
    for (const m of missing.slice(0, 10)) console.log(`    ${m}`);
  }

  // Duplicate detection: the same agent id must map to exactly one record, and a repeated
  // registration must be rejected rather than creating a second entry.
  console.log('\nreplay check — re-registering an existing identity must not duplicate:');
  if (agents[0]) {
    const before = await pub.readContract({ address: REGISTRY, abi, functionName: 'getAgent', args: [idToBytes32(agents[0].agentId)] }) as any;
    let rejected = false;
    try {
      await agents[0].request('POST', '/v1/agents', {
        ed25519Pk: (agents[0] as any).state?.keys?.ed25519Pk, x25519Pk: (agents[0] as any).state?.keys?.x25519Pk,
      });
    } catch { rejected = true; }
    const after = await pub.readContract({ address: REGISTRY, abi, functionName: 'getAgent', args: [idToBytes32(agents[0].agentId)] }) as any;
    console.log(`  duplicate rejected: ${rejected}`);
    console.log(`  registeredAt unchanged: ${String(before.registeredAt) === String(after.registeredAt)}`);
    console.log(`  keyEpoch unchanged: ${String(before.keyEpoch) === String(after.keyEpoch)}`);
  }

  if (perPair > 0 && agents.length >= 2) {
    console.log(`\nconcurrent messaging: ${perPair} message(s) between ${Math.floor(agents.length / 2)} pairs\n`);
    const t1 = Date.now();
    const sends = await Promise.allSettled(
      Array.from({ length: Math.floor(agents.length / 2) }, async (_, i) => {
        const a = agents[i * 2], b = agents[i * 2 + 1];
        const cid = await a.openConversation(b.agentId, { mode: 'sealed' });
        for (let m = 0; m < perPair; m++) await a.send(cid, `load message ${m} from pair ${i}`);
        await b.syncConversations();
        const got = await b.read(cid);
        return got.filter((x) => x.message.type === 'text').length;
      }),
    );
    const ok = sends.filter((s) => s.status === 'fulfilled');
    const decrypted = ok.reduce((n, s) => n + (s as PromiseFulfilledResult<number>).value, 0);
    const expected = Math.floor(agents.length / 2) * perPair;
    console.log(`  pairs ok: ${ok.length}/${Math.floor(agents.length / 2)}`);
    console.log(`  messages decrypted by recipients: ${decrypted}/${expected}`);
    console.log(`  elapsed ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    for (const f of sends.filter((s) => s.status === 'rejected').slice(0, 3)) {
      console.log(`  FAILED: ${(f as PromiseRejectedResult).reason?.message?.slice(0, 140)}`);
    }
  }

  const final = await (await fetch(`${BASE}/v1/status`)).json() as any;
  console.log('\nwrite pipeline:', JSON.stringify(final.registryWrites));
  console.log(`\nverdict: ${onchain === agents.length && agents.length === count ? 'PASS — every registration landed on-chain, none dropped' : 'CHECK — see missing/failures above'}`);
}

main().catch((e) => { console.error('\nLOAD TEST FAILED:', e.message); process.exit(1); });
