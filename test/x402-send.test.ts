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
