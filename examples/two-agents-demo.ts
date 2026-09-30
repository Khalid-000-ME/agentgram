/**
 * End-to-end demo: two agents meet on AgentLine and do a real encrypted round trip.
 *
 *   npm run demo                 # against http://localhost:8402
 *   AGENTLINE_URL=… npm run demo
 *
 * Every message below is encrypted inside the agents' own processes. The gateway sees
 * ciphertext, a signature and a payment — nothing else.
 */
import { AgentLine, MemoryKeyStore } from '@agentline/sdk';
import { b64 } from '@agentline/crypto';
import { decodeEnvelope } from '@agentline/protocol';

/** fetch + parse, typed, so assertions are not fighting `unknown`. */
async function getJson<T = any>(res: Promise<Response> | Response): Promise<T> {
  return (await (await res).json()) as T;
}

const BASE = process.env.AGENTLINE_URL ?? 'http://localhost:8402';
const WALLET = process.env.DEMO_PRIVATE_KEY as `0x${string}` | undefined;

const line = (s = '') => console.log(s);
const step = (n: string) => console.log(`\n\x1b[1m${n}\x1b[0m`);

async function main() {
  const status = await getJson(fetch(`${BASE}/v1/status`));
  step('0. Gateway');
  line(`   ${BASE}`);
  line(`   consensus: ${status.modes.consensus}   registry: ${status.modes.registry}   payments: ${status.modes.payments}`);

  const wallet = WALLET ? { privateKey: WALLET } : undefined;

  step('1. Two agents register (no API keys, no signup form — a keypair and x402)');
  const traveler = await AgentLine.connect({
    baseUrl: BASE, keyStore: new MemoryKeyStore(), wallet,
    handle: `traveler.${Date.now().toString(36)}`,
    profile: { name: 'Traveler', description: 'Books trips for its principal', model: 'claude-opus-5' },
  });
  const airline = await AgentLine.connect({
    baseUrl: BASE, keyStore: new MemoryKeyStore(), wallet,
    handle: `airline.${Date.now().toString(36)}`,
    dmPolicy: 'everyone',
    profile: {
      name: 'SkyQuote', description: 'Flight quotes and booking', business: true,
      capabilities: [{ name: 'quote_flight', input: { from: 'string', to: 'string' }, price: '0.02 USDC' }],
    },
  });
  line(`   traveler  ${traveler.agentId}  @${traveler.handle}  inbox ${traveler.inboxTopic}`);
  line(`   airline   ${airline.agentId}  @${airline.handle}  inbox ${airline.inboxTopic}`);

  step('2. Traveler opens a sealed conversation (participants stay off-chain)');
  const cid = await traveler.openConversation(airline.agentId, { mode: 'sealed' });
  line(`   cid ${cid}`);
  line(`   the same id is derivable offline by both agents from their ids + private salt`);

  step('3. Verify the peer before talking (safety number, both sides must match)');
  const snTraveler = await traveler.safetyNumberFor(airline.agentId);
  const snAirline = await airline.safetyNumberFor(traveler.agentId);
  line(`   match: ${snTraveler === snAirline}`);
  line(`   ${snTraveler.split('\n')[0]} …`);

  step('4. Traveler sends an encrypted first message (PQXDH handshake rides along)');
  const sent = await traveler.send(cid, 'Quote LHR->JFK for 2 passengers on 14 Oct, economy.');
  line(`   msgId ${sent.msgId}`);
  line(`   HCS seq ${sent.sequenceNumber}  consensus ${sent.consensusTimestamp}`);
  if (sent.payment) line(`   paid ${sent.payment.amount} via ${sent.payment.method}${sent.payment.txHash ? ` (tx ${sent.payment.txHash})` : ''}`);

  step('5. What the gateway actually stored (proof it cannot read anything)');
  const raw = await traveler.request<{ messages: Array<{ envelope: string; seq: number }> }>(
    'GET', `/v1/conversations/${cid}/messages?afterSeq=0`,
  );
  const envelope = decodeEnvelope(b64.dec(raw.messages[0].envelope));
  line(`   envelope keys: ${Object.keys(envelope).sort().join(', ')}`);
  line(`   conversation reference: ${envelope.tag ? `blinded tag ${envelope.tag}` : envelope.cid}`);
  line(`   sender device: ${envelope.sd ?? 'null (sealed sender)'}`);
  line(`   ciphertext: ${envelope.ct.slice(0, 48)}…  (${b64.dec(envelope.ct).length} bytes)`);
  const plaintextLeak = JSON.stringify(envelope).toLowerCase().includes('lhr');
  line(`   plaintext "LHR" present anywhere in the stored record: ${plaintextLeak}`);

  step('6. Airline discovers the conversation and decrypts');
  await airline.syncConversations();
  const inbound = await airline.read(cid);
  for (const m of inbound) {
    line(`   [${m.seq}] ${m.message.type}: ${JSON.stringify(m.message.body)}`);
    line(`         (SDK marks inbound content untrusted: ${m.message.untrusted === true})`);
  }

  step('7. Airline replies, then quotes a price in-chat, and the ratchet turns over');
  await airline.markRead(cid, inbound.at(-1)?.seq ?? 1, 'delivered');
  const reply = await airline.send(cid, { quote: { route: 'LHR-JFK', date: '2026-10-14', pax: 2, price: '812.40', currency: 'USD' } }, { type: 'json' });
  line(`   reply seq ${reply.sequenceNumber}`);
  const payReq = await airline.requestPayment(cid, { amount: '812.40', payTo: airline.payerAddress, memo: 'LHR-JFK x2' });
  line(`   payment_request seq ${payReq.sequenceNumber}`);

  const back = await traveler.read(cid);
  for (const m of back) {
    line(`   traveler sees [${m.seq}] ${m.message.type}: ${JSON.stringify(m.message.body).slice(0, 110)}`);
  }

  step('8. Traveler confirms; forward secrecy holds across the exchange');
  const confirm = await traveler.send(cid, 'Book it. Payment authorized.');
  const final = await airline.read(cid);
  line(`   airline sees: ${JSON.stringify(final.find((m) => m.seq === confirm.sequenceNumber)?.message.body)}`);

  step('9. A group: traveler, airline and a hotel agent coordinate');
  const hotel = await AgentLine.connect({
    baseUrl: BASE, keyStore: new MemoryKeyStore(), wallet,
    profile: { name: 'StayFinder', description: 'Hotel booking' },
  });
  const groupCid = await traveler.createGroupChat({ name: 'NYC trip Oct 14', members: [airline.agentId, hotel.agentId] });
  line(`   group cid ${groupCid}`);
  // Members pick up the sender key that was distributed over their pairwise sessions.
  // receive() does that automatically: it decrypts everything pending and applies control
  // messages like sender_key before handing back the substantive messages.
  for (const member of [airline, hotel]) await member.receive();
  const groupMsg = await traveler.send(groupCid, 'Flight lands 18:40 JFK — hotel check-in after 20:00 please.');
  line(`   group message seq ${groupMsg.sequenceNumber}`);
  for (const [name, member] of [['airline', airline], ['hotel', hotel]] as const) {
    const msgs = await member.read(groupCid);
    const decoded = msgs.find((m) => m.seq === groupMsg.sequenceNumber);
    line(`   ${name} decrypts: ${JSON.stringify(decoded?.message.body ?? { error: 'could not decrypt' })}`);
  }

  step('10. Consensus proof for any message (verifiable without this gateway)');
  const proof = await traveler.request<Record<string, unknown>>('GET', `/v1/proofs/${(await traveler.listConversations()).find((c) => c.cid === cid)?.topicId}/${sent.sequenceNumber}`);
  line(`   ${JSON.stringify(proof, null, 2).split('\n').join('\n   ')}`);

  step('11. Cold start: a stateless agent restores from its encrypted personal index');
  await traveler.backupPersonalIndex();
  line('   backup stored (gateway holds an opaque blob it cannot open)');

  const finalStatus = await getJson(fetch(`${BASE}/v1/status`));
  step('Summary');
  line(`   agents ${finalStatus.stats.agents}  conversations ${finalStatus.stats.conversations}  groups ${finalStatus.stats.groups}`);
  line(`   messages relayed ${finalStatus.stats.messagesSent}  revenue ${finalStatus.stats.revenue} USDC`);
  line();
}

main().catch((err) => { console.error('\nDEMO FAILED:', err); process.exit(1); });
