/**
 * The public send route: storing conversations between agents that are not registered.
 * Payment is the Algorand rail's job and is not exercised here; the handlers are mounted
 * unpaid so identity, conversation derivation and authorization can be tested offline.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';

const DATA_DIR = `.data/test-send-${process.pid}`;
process.env.DATA_DIR = DATA_DIR;
// Empty rather than deleted: config.ts loads dotenv, which would refill a deleted variable.
process.env.REGISTRY_ADDRESS = '';
process.env.ALERTS_ENABLED = 'false';
process.env.SMTP_PASS = '';
process.env.RELAYER_PRIVATE_KEY = '';
process.env.RELAYER_PRIVATE_KEYS = '';
process.env.SETTLER_PRIVATE_KEY = '';
process.env.HEDERA_ACCOUNT_ID = '';
process.env.HEDERA_PRIVATE_KEY = '';
process.env.HEDERA_ENABLED = 'false';
process.env.X402_CHAIN = '';
process.env.PORT = '0';

const { createApp } = await import('../apps/gateway/src/index.ts');
const { signRequest, encodeEnvelope } = await import('../packages/protocol/src/index.ts');
const { generateIdentity, deriveConversationId, b64 } = await import('../packages/crypto/src/index.ts');

type Identity = ReturnType<typeof generateIdentity>;
let server: Server;
let base: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createApp({ unpaidPublicApi: true }).listen(0, () => {
      const addr = server.address();
      base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const envelope = (cid: string, text: string) =>
  b64.enc(encodeEnvelope({ v: 1, k: 'dm', cid, ct: b64.enc(new TextEncoder().encode(text)) } as never));

/** A signed send from `who`, who is not registered and so carries its public key. */
async function send(who: Identity, body: Record<string, unknown>, opts: { keyId?: string } = {}) {
  const url = new URL(`${base}/x402/v1/send`);
  const payload = JSON.stringify({ ed25519Pk: b64.enc(who.ed25519Pk), ...body });
  const sig = signRequest({
    method: 'POST', target: url.pathname, authority: url.host, body: payload,
    keyId: opts.keyId ?? who.agentId, ed25519Sk: who.ed25519Sk,
  });
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...sig }, body: payload });
  return { status: res.status, body: await res.json() as any };
}

const alice = generateIdentity();
const bob = generateIdentity();
const carol = generateIdentity();
const cid = deriveConversationId(alice.agentId, bob.agentId);

test('an unregistered agent stores a batch for another unregistered agent', async () => {
  const r = await send(alice, { to: bob.agentId, envelopes: [envelope(cid, 'one'), envelope(cid, 'two')], importance: 0.9 });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.cid, cid, 'the cid is the pair\'s derivable id');
  assert.equal(r.body.stored, 2);
  assert.deepEqual(r.body.pending.agents, [bob.agentId]);
});

test('the peer can be addressed by public key and lands in the same conversation', async () => {
  const r = await send(bob, { toEd25519Pk: b64.enc(alice.ed25519Pk), envelope: envelope(cid, 'three') });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.cid, cid);
});

test('a third agent cannot write into the pair\'s conversation', async () => {
  const r = await send(carol, { cid, envelope: envelope(cid, 'intrusion') });
  assert.equal(r.status, 403);
});

test('an unregistered sender cannot claim another agent\'s id', async () => {
  // Signed by carol's key, which is in the body, but claiming to be alice.
  const r = await send(carol, { to: bob.agentId, envelope: envelope(cid, 'spoof') }, { keyId: alice.agentId });
  assert.equal(r.status, 401);
});

test('more than five envelopes in one call is refused', async () => {
  const r = await send(alice, { cid, envelopes: Array.from({ length: 6 }, (_, i) => envelope(cid, String(i))) });
  assert.equal(r.status, 422);
});

test('registering later finds the conversation waiting, with its history', async () => {
  const reg = await fetch(`${base}/x402/v1/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ed25519Pk: b64.enc(bob.ed25519Pk), x25519Pk: b64.enc(bob.x25519Pk) }),
  });
  const body = await reg.json() as any;
  assert.equal(reg.status, 201, JSON.stringify(body));
  assert.equal(body.agentId, bob.agentId);
  assert.equal(body.conversationsWaiting, 1);

  const read = await fetch(`${base}/x402/v1/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid }),
  });
  const page = await read.json() as any;
  assert.equal(page.count, 3);
});

/* ------------------------------------------------------------------ SDK, no accounts */

const { AgentLine, MemoryKeyStore } = await import('../packages/sdk/src/index.ts');

test('the SDK stores and reads a conversation with neither agent registered', async () => {
  const connect = (ks: InstanceType<typeof MemoryKeyStore>) =>
    AgentLine.connect({ baseUrl: base, keyStore: ks, autoRegister: false });
  const dana = await connect(new MemoryKeyStore());
  const eli = await connect(new MemoryKeyStore());

  const danaKeys = { ed25519Pk: b64.enc(dana.identity.ed25519Pk), x25519Pk: b64.enc(dana.identity.x25519Pk) };
  const eliKeys = { ed25519Pk: b64.enc(eli.identity.ed25519Pk), x25519Pk: b64.enc(eli.identity.x25519Pk) };

  const stored = await dana.store(eliKeys, ['terms: 2 ALGO per call', { offer: 'accepted' }], { importance: [0.9, 0.95] });
  assert.equal(stored.stored, 2);
  assert.deepEqual(stored.pendingAgents, [eli.agentId]);

  // Both sides derive the same conversation id with no help from the service.
  assert.equal(eli.conversationWith(danaKeys), stored.cid);

  const inbox = await eli.readStored(danaKeys);
  assert.equal(inbox.length, 2, 'both messages decrypt');
  assert.equal((inbox[0].message.body as any).text, 'terms: 2 ALGO per call');
  assert.equal(inbox[0].from, dana.agentId, 'the sender is identified from its key');
  assert.deepEqual(inbox[1].message.body, { offer: 'accepted' });

  // The sender does not re-read its own messages as inbound.
  assert.equal((await dana.readStored(eliKeys)).length, 0);

  // A reply flows back into the same conversation, and recall returns only what was scored.
  await eli.store(danaKeys, 'countersigned', { importance: 0.9 });
  const recalled = await dana.recall(eliKeys, { minImportance: 0.8 });
  assert.equal(recalled.messages.length, 1);
  assert.equal((recalled.messages[0].message.body as any).text, 'countersigned');
  assert.equal(recalled.totalMessages, 3);
});

test('an outsider on the same topic cannot read the pair\'s messages', async () => {
  const mallory = await AgentLine.connect({ baseUrl: base, keyStore: new MemoryKeyStore(), autoRegister: false });
  const dana = await AgentLine.connect({ baseUrl: base, keyStore: new MemoryKeyStore(), autoRegister: false });
  const victim = await AgentLine.connect({ baseUrl: base, keyStore: new MemoryKeyStore(), autoRegister: false });
  const victimKeys = { ed25519Pk: b64.enc(victim.identity.ed25519Pk), x25519Pk: b64.enc(victim.identity.x25519Pk) };

  const { cid } = await dana.store(victimKeys, 'private terms');
  assert.equal((await mallory.readStored({ cid })).length, 0, 'ciphertext stays opaque to a third party');
});
