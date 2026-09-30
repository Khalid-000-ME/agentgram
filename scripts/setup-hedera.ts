/**
 * Verify Hedera credentials and pre-provision the shared topics used for sealed DMs.
 *
 *   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=… npm run hedera:setup
 *
 * Creating the shard topics up front keeps the first user-facing request off the slow path.
 */
import 'dotenv/config';
import { config } from '../apps/gateway/src/config.ts';
import { ledger, resetLedger } from '../apps/gateway/src/services/ledger.ts';
import { store } from '../apps/gateway/src/lib/store.ts';

async function main() {
  if (!config.hedera.accountId || !config.hedera.privateKey) {
    throw new Error('set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY (testnet account: https://portal.hedera.com)');
  }
  resetLedger();
  const l = ledger();
  console.log('ledger:', l.info());
  if (l.kind !== 'hedera') throw new Error('ledger did not initialise in Hedera mode — check your credentials');

  console.log('\ncreating a probe topic to verify the operator can pay fees…');
  const probe = await l.createTopic('agentline:setup-probe');
  console.log(`✓ topic ${probe}`);

  const submit = await l.submit(probe, new TextEncoder().encode(JSON.stringify({ t: 'setup', at: Date.now() })));
  console.log(`✓ submitted message seq ${submit.seq} at consensus ${submit.consensusTimestamp}`);
  console.log(`  tx ${submit.txId}`);

  console.log('\nreading it back from the mirror node (this is the trustless read path)…');
  // Mirror nodes lag consensus by a few seconds; retry rather than fail on a cold index.
  let messages: Awaited<ReturnType<typeof l.read>> = [];
  for (let attempt = 0; attempt < 10 && !messages.length; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try { messages = await l.read(probe, { limit: 5 }); } catch { /* not indexed yet */ }
  }
  console.log(messages.length ? `✓ mirror node returned ${messages.length} message(s)` : '! mirror node has not indexed it yet (normal; it will appear shortly)');

  const shards = Math.max(1, config.hedera.sealedShards);
  console.log(`\nprovisioning ${shards} shared topic(s) for sealed DMs…`);
  store.db.sealedShardTopics = [];
  for (let i = 0; i < shards; i++) {
    const topicId = await l.createTopic(`agentline:sealed-shard:${i}`);
    store.db.sealedShardTopics.push(topicId);
    console.log(`  shard ${i}: ${topicId}`);
  }
  store.flush();
  await l.close();

  console.log(`\n✓ Hedera is wired up (${config.hedera.network}). Messages will now go to real HCS topics.`);
  console.log(`  mirror node: ${config.hedera.mirrorRest}`);
}

main().catch((err) => { console.error(`\n✗ ${err.message}`); process.exit(1); });
