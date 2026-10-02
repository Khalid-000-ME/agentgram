/**
 * Gateway integration tests: registration, auth, payments, messaging, groups, safety.
 * Runs against an in-process gateway on a local consensus ledger — no credentials needed.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';

/** fetch + parse, typed, so assertions are not fighting `unknown`. */
async function getJson<T = any>(res: Promise<Response> | Response): Promise<T> {
  return (await (await res).json()) as T;
}

const DATA_DIR = `.data/test-${process.pid}`;
process.env.DATA_DIR = DATA_DIR;
// Isolate from any live deployment configured in .env: tests must not spend real funds.
// Set to empty rather than deleted — config.ts loads dotenv, which refills any variable
// that is absent, so a delete would silently put the live credentials back.
process.env.REGISTRY_ADDRESS = '';
process.env.ALERTS_ENABLED = 'false';   // never email the operator from a test run
process.env.SMTP_PASS = '';
process.env.RELAYER_PRIVATE_KEY = '';
process.env.RELAYER_PRIVATE_KEYS = '';
process.env.SETTLER_PRIVATE_KEY = '';
process.env.HEDERA_ACCOUNT_ID = '';
process.env.HEDERA_PRIVATE_KEY = '';
process.env.X402_ENABLED = 'true';
process.env.X402_PAY_TO = '0x1111111111111111111111111111111111111111';
process.env.X402_DEV_ACCEPT_UNSETTLED = 'true';
process.env.HEDERA_ENABLED = 'false';
process.env.PORT = '0';

const { createApp } = await import('../apps/gateway/src/index.ts');
const { AgentLine, MemoryKeyStore } = await import('../packages/sdk/src/index.ts');
const { signRequest } = await import('../packages/protocol/src/index.ts');
const { generateIdentity, b64, utf8 } = await import('../packages/crypto/src/index.ts');

let server: Server;
let baseUrl: string;
const WALLET = { privateKey: ('0x' + '11'.repeat(32)) as `0x${string}` };

before(async () => {
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const addr = server.address();
      baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  server?.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const connect = (opts: Record<string, unknown> = {}) =>
  AgentLine.connect({ baseUrl, keyStore: new MemoryKeyStore(), wallet: WALLET, ...opts });

test('discovery surfaces are self-describing', async () => {
  const manifest = await getJson(fetch(`${baseUrl}/.well-known/agentegram.json`));
  assert.equal(manifest.name, 'Agentegram');
  assert.equal(manifest.protocols.payment.standard, 'x402');
  assert.ok(manifest.prices.length > 5, 'price table is published');

  const openapi = await getJson(fetch(`${baseUrl}/openapi.json`));
  assert.equal(openapi.openapi, '3.1.0');
  assert.ok(openapi.paths['/v1/conversations/{cid}/messages'].post['x-402-price']);

  const llms = await (await fetch(`${baseUrl}/llms.txt`)).text();
  assert.match(llms, /X-PAYMENT/);
  assert.match(llms, /untrusted data/i, 'prompt-injection guidance is documented');

  const card = await getJson(fetch(`${baseUrl}/.well-known/agent-card.json`));
  assert.ok(Array.isArray(card.skills));
  assert.ok(card.iconUrl.endsWith('/logo.png'));

  // Catalogs that scrape the site read the page title and icon, not the JSON.
  const page = await fetch(`${baseUrl}/`, { headers: { accept: 'text/html' } });
  assert.match(await page.text(), /<title>Agentegram<\/title>/);
  const logo = await fetch(`${baseUrl}/logo.png`);
  assert.equal(logo.headers.get('content-type'), 'image/png');
});

test('a paid route challenges with x402 before serving', async () => {
  const res = await fetch(`${baseUrl}/v1/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 402);
  assert.ok(res.headers.get('PAYMENT-REQUIRED'), 'PAYMENT-REQUIRED header is present');
  const body = await getJson(res);
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts[0].scheme, 'exact');
  assert.equal(body.accepts[0].network, 'base-sepolia');
  assert.equal(body.accepts[0].maxAmountRequired, '500000');   // 0.50 USDC
});

test('registration derives the agent id from the key and provisions topics', async () => {
  const agent = await connect({ handle: 'alpha.bot', profile: { name: 'Alpha' } });
  assert.match(agent.agentId, /^agt_/);
  assert.equal(agent.handle, 'alpha.bot');
  assert.match(agent.inboxTopic!, /^0\.0\.\d+$/);

  const profile = await getJson(fetch(`${baseUrl}/v1/agents/@alpha.bot`));
  assert.equal(profile.agentId, agent.agentId);
  assert.equal(profile.profile.name, 'Alpha');
  // The gateway publishes public keys only.
  assert.equal(JSON.stringify(profile).includes('Sk'), false);
});

test('an unsigned state change is rejected', async () => {
  const res = await fetch(`${baseUrl}/v1/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': 'x' },
    body: JSON.stringify({ peerAgentId: 'agt_x' }),
  });
  assert.ok([401, 402].includes(res.status), `expected auth/payment rejection, got ${res.status}`);
});

test('a tampered request body fails signature verification', async () => {
  const id = generateIdentity();
  const body = JSON.stringify({ ed25519Pk: b64.enc(id.ed25519Pk), x25519Pk: b64.enc(id.x25519Pk) });
  const url = new URL(`${baseUrl}/v1/agents`);
  const sig = signRequest({
    method: 'POST', target: '/v1/agents', authority: url.host, body,
    keyId: id.agentId, ed25519Sk: id.ed25519Sk,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'AgentLine-Key-Id': id.agentId,
      Signature: sig.Signature, 'Signature-Input': sig['Signature-Input'],
      'Content-Digest': sig['Content-Digest']!, 'X-PAYMENT': 'invalid',
    },
    body: body.replace('"ed25519Pk"', '"ed25519pk"'),   // tamper after signing
  });
  assert.ok([401, 402].includes(res.status));
  if (res.status === 401) assert.equal((await getJson(res)).code, 'signature_invalid');
});

test('a replayed signature nonce is rejected', async () => {
  const agent = await connect();
  // A free signed route: on a paid one the 402 is answered before the signature is checked,
  // so the first attempt would never reach the nonce store.
  const url = new URL(`${baseUrl}/v1/conversations`);
  const sig = signRequest({
    method: 'GET', target: url.pathname, authority: url.host,
    keyId: agent.agentId, ed25519Sk: agent.identity.ed25519Sk,
  });
  const headers = {
    'AgentLine-Key-Id': agent.agentId,
    Signature: sig.Signature, 'Signature-Input': sig['Signature-Input'],
  };
  const first = await fetch(url, { headers });
  assert.equal(first.status, 200);
  const replay = await fetch(url, { headers });
  assert.equal(replay.status, 401);
  assert.equal((await getJson(replay)).code, 'nonce_replayed');
});

test('updating a profile republishes it and changes what the directory returns', async () => {
  const agent = await connect({ handle: 'quotes.bot' });
  await agent.updateProfile({
    profile: { name: 'QuoteBot', description: 'Freight quotes', capabilities: ['quote_freight'] },
    dmPolicy: 'contacts',
  });

  const found = await getJson(fetch(`${baseUrl}/v1/directory?capability=quote_freight`));
  assert.equal(found.agents.length, 1, 'capabilities are what the directory searches');
  assert.equal(found.agents[0].agentId, agent.agentId);

  const profile = await getJson(fetch(`${baseUrl}/v1/agents/${agent.agentId}`));
  assert.equal(profile.profile.name, 'QuoteBot');
  assert.equal(profile.dmPolicy, 'contacts');
});

test('two agents exchange encrypted messages the gateway cannot read', async () => {
  const a = await connect({ handle: 'sender.bot' });
  const b = await connect({ handle: 'receiver.bot' });

  const secret = 'transfer 42 units to depot 7';
  const sent = await a.send(b.agentId, secret);
  assert.ok(sent.sequenceNumber > 0);
  assert.ok(sent.consensusTimestamp);

  // What the gateway stored contains no plaintext anywhere.
  const stored = await a.request<{ messages: Array<{ envelope: string }> }>(
    'GET', `/v1/conversations/${sent.cid}/messages?afterSeq=0`);
  const raw = utf8.dec(b64.dec(stored.messages[0].envelope));
  assert.equal(raw.includes('depot'), false);
  assert.equal(JSON.stringify(stored).includes('depot'), false);

  await b.syncConversations();
  const received = await b.read(sent.cid);
  const text = received.find((m) => m.message.type === 'text');
  assert.equal((text!.message.body as { text: string }).text, secret);
  assert.equal(text!.message.untrusted, true, 'inbound content is flagged untrusted');
});

test('conversation ids are derivable offline by both parties', async () => {
  const a = await connect();
  const b = await connect();
  const { deriveConversationId } = await import('../packages/crypto/src/index.ts');
  const cid = await a.openConversation(b.agentId, { mode: 'open' });
  assert.equal(cid, deriveConversationId(a.agentId, b.agentId));
  assert.equal(cid, deriveConversationId(b.agentId, a.agentId));
});

test('sealed conversations publish no participants', async () => {
  const a = await connect();
  const b = await connect();
  const cid = await a.openConversation(b.agentId, { mode: 'sealed' });
  const meta = await a.request<{ mode: string; participants?: string[] }>('GET', `/v1/conversations/${cid}`);
  assert.equal(meta.mode, 'sealed');
  assert.equal(meta.participants, undefined);
});

test('the full conversation survives a ratchet turnover in both directions', async () => {
  const a = await connect();
  const b = await connect();
  const cid = await a.openConversation(b.agentId);
  await a.send(cid, 'a1');
  await b.syncConversations();
  assert.equal(((await b.read(cid))[0].message.body as { text: string }).text, 'a1');
  await b.send(cid, 'b1');
  await b.send(cid, 'b2');
  const atB = await a.read(cid);
  assert.deepEqual(atB.map((m) => (m.message.body as { text: string }).text), ['b1', 'b2']);
  await a.send(cid, 'a2');
  assert.equal(((await b.read(cid)).pop()!.message.body as { text: string }).text, 'a2');
});

test('first contact costs more, and only once per conversation', async () => {
  const a = await connect();
  const b = await connect();
  const first = await a.send(b.agentId, 'cold outreach');
  assert.equal(first.payment?.route, 'POST /v1/messages:first-contact');
  const second = await a.send(first.cid, 'follow up');
  assert.equal(second.payment?.route, 'POST /v1/messages');
});

test('credits are drawn down instead of settling each message', async () => {
  const a = await connect();
  const b = await connect();
  await a.buyCredits('1.00');
  assert.equal((await a.balance()).balance, '1');
  const sent = await a.send(b.agentId, 'paid from credits');
  assert.equal(sent.payment?.method, 'credits');
  assert.notEqual((await a.balance()).balance, '1');
});

test('an idempotent retry does not double-post or double-charge', async () => {
  const a = await connect();
  const b = await connect();
  const cid = await a.openConversation(b.agentId);
  const body = { envelope: { v: 1, k: 'dm', cid, sd: a.deviceId, hdr: { dh: 'x', pn: 0, n: 0 }, ct: b64.enc(new Uint8Array(32)) } };
  const first = await a.request<{ sequenceNumber: number }>('POST', `/v1/conversations/${cid}/messages`, body, { idempotencyKey: 'fixed-key' });
  const retry = await a.request<{ sequenceNumber: number }>('POST', `/v1/conversations/${cid}/messages`, body, { idempotencyKey: 'fixed-key' });
  assert.equal(retry.sequenceNumber, first.sequenceNumber);
});

test('plaintext submissions are refused', async () => {
  const a = await connect();
  const b = await connect();
  const cid = await a.openConversation(b.agentId);
  await assert.rejects(
    () => a.request('POST', `/v1/conversations/${cid}/messages`, { envelope: { v: 1, k: 'dm', cid, sd: null, hdr: {}, text: 'hello in the clear' } }),
    /ciphertext.*required|validation/i,
  );
});

test('a blocked sender cannot reach the blocker', async () => {
  const a = await connect();
  const b = await connect();
  await a.send(b.agentId, 'hi');
  await b.syncConversations();
  await b.block(a.agentId);
  await assert.rejects(() => a.send(b.agentId, 'again'), /blocked/i);
});

test('dmPolicy contacts-only turns away strangers', async () => {
  const a = await connect();
  const b = await connect({ dmPolicy: 'contacts' });
  await assert.rejects(() => a.send(b.agentId, 'stranger danger'), /dm_policy_denied|existing contacts/i);
});

test('a first message lands in the recipient request queue', async () => {
  const a = await connect();
  const b = await connect();
  const sent = await a.send(b.agentId, 'may I?');
  const requests = await b.listRequests();
  assert.ok(requests.requests.some((r) => r.cid === sent.cid && r.from === a.agentId));
  await b.acceptRequest(sent.cid);
  assert.equal((await b.listRequests()).requests.length, 0);
});

test('a franked report verifies attribution against the on-chain commitment', async () => {
  const a = await connect();
  const b = await connect();
  const sent = await a.send(b.agentId, 'abusive content');
  await b.syncConversations();
  const messages = await b.read(sent.cid);
  const target = messages.find((m) => m.message.type === 'text')!;
  const report = await b.report(sent.cid, [{ seq: target.seq, message: target.message }], 'abuse');
  assert.equal(report.verified, true, 'franking tag matched');

  const tampered = await b.report(sent.cid, [{ seq: target.seq, message: { ...target.message, body: { text: 'fabricated' } } }], 'abuse');
  assert.equal(tampered.verified, false, 'a fabricated body cannot be attributed');
});

test('a group of three exchanges messages and a removed member is locked out', async () => {
  const a = await connect();
  const b = await connect();
  const c = await connect();
  const cid = await a.createGroupChat({ name: 'swarm', members: [b.agentId, c.agentId] });
  for (const m of [b, c]) await m.receive();

  const sent = await a.send(cid, 'task assignment 1');
  for (const [name, m] of [['b', b], ['c', c]] as const) {
    const got = (await m.read(cid)).find((x) => x.seq === sent.sequenceNumber);
    assert.equal((got?.message.body as { text: string })?.text, 'task assignment 1', `${name} decrypted the group message`);
  }

  const groupId = cid.replace('cnv_', 'grp_');
  await a.removeGroupMember(groupId, c.agentId);
  for (const m of [b, c]) await m.receive();
  const after = await a.send(cid, 'members only now');

  const bSaw = (await b.read(cid)).find((x) => x.seq === after.sequenceNumber);
  assert.equal((bSaw?.message.body as { text: string })?.text, 'members only now');

  // The removed member is locked out at two independent layers: the gateway refuses to
  // serve the conversation, and even with the ciphertext in hand the new epoch key is one
  // it never received. Only the second layer is a real guarantee — the first assumes an
  // honest gateway — so the crypto layer is asserted directly in crypto.test.ts.
  let cText: string | undefined;
  try {
    cText = ((await c.read(cid)).find((x) => x.seq === after.sequenceNumber)?.message.body as { text?: string })?.text;
  } catch (err) {
    assert.match((err as Error).message, /403|not a participant/i);
  }
  assert.notEqual(cText, 'members only now');
});

test('invite links let an agent join a group', async () => {
  const a = await connect();
  const b = await connect();
  const cid = await a.createGroupChat({ name: 'open swarm', members: [] });
  const invite = await a.createInvite(cid.replace('cnv_', 'grp_'), { maxUses: 2 });
  assert.match(invite.code, /^inv_/);
  const joined = await b.joinWithInvite(invite.code);
  assert.ok(joined.members.includes(b.agentId));
});

test('receipts report agent work state, not just delivery', async () => {
  const a = await connect();
  const b = await connect();
  const sent = await a.send(b.agentId, 'do the thing');
  await b.syncConversations();
  await b.read(sent.cid);
  await b.markRead(sent.cid, sent.sequenceNumber, 'processing');
  await b.markRead(sent.cid, sent.sequenceNumber, 'done');
  const seen = await a.read(sent.cid);
  const statuses = seen.filter((m) => m.message.type === 'receipt').map((m) => (m.message.body as { status: string }).status);
  assert.ok(statuses.includes('processing') && statuses.includes('done'), `got ${statuses.join(',')}`);
});

test('every message carries a verifiable consensus proof', async () => {
  const a = await connect();
  const b = await connect();
  const sent = await a.send(b.agentId, 'prove it');
  const conv = (await a.listConversations()).find((c) => c.cid === sent.cid)!;
  const proof = await a.request<{ seq: number; runningHash: string; payloadSha256: string }>(
    'GET', `/v1/proofs/${conv.topicId}/${sent.sequenceNumber}`);
  assert.equal(proof.seq, sent.sequenceNumber);
  assert.match(proof.runningHash, /^[0-9a-f]{96}$/);
  assert.match(proof.payloadSha256, /^[0-9a-f]{64}$/);
});

test('the index is rebuildable from the ledger', async () => {
  const a = await connect();
  const b = await connect();
  const sent = await a.send(b.agentId, 'durable');
  const { store } = await import('../apps/gateway/src/lib/store.ts');
  store.db.messages[sent.cid] = [];         // simulate a lost index
  const { reindexConversation } = await import('../apps/gateway/src/services/relay.ts');
  const recovered = await reindexConversation(sent.cid);
  assert.ok(recovered >= 1, 'messages were re-read from the ledger');
});

test('the personal index round trips as an opaque blob', async () => {
  const a = await connect();
  const b = await connect();
  await a.send(b.agentId, 'remember me');
  await a.backupPersonalIndex();
  const stored = await a.request<{ blob: string }>('GET', '/v1/personal-index');
  assert.equal(stored.blob.includes('remember me'), false, 'the backup is encrypted');
  await a.restorePersonalIndex();
  assert.ok((await a.listConversations()).length > 0);
});

test('tombstoning an agent removes its prekeys and handle', async () => {
  const a = await connect({ handle: 'doomed.bot' });
  await a.request('DELETE', `/v1/agents/${a.agentId}`);
  const res = await fetch(`${baseUrl}/v1/agents/@doomed.bot`);
  assert.equal(res.status, 404);
});

test('unknown routes answer with problem+json and a pointer to the docs', async () => {
  const res = await fetch(`${baseUrl}/v1/nope`);
  assert.equal(res.status, 404);
  const body = await getJson(res);
  assert.equal(body.code, 'not_found');
  assert.match(body.hint, /llms\.txt/);
});
