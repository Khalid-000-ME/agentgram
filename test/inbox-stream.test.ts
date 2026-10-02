/**
 * Inbox isolation: a notice must reach exactly the agent it is addressed to, and no other
 * open stream — the property that makes "deliver to only the other agent" true rather than
 * merely intended.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rmSync } from 'node:fs';
import type { Server } from 'node:http';

const DATA_DIR = `.data/test-stream-${process.pid}`;
process.env.DATA_DIR = DATA_DIR;
process.env.X402_ENABLED = 'false';
process.env.HEDERA_ENABLED = 'false';
process.env.ALERTS_ENABLED = 'false';
process.env.INBOX_POLL_MS = '400';
// Isolate from any live deployment configured in .env: these tests must not spend gas.
// Set to empty rather than deleted — dotenv refills absent variables from .env.
process.env.REGISTRY_ADDRESS = '';
process.env.RELAYER_PRIVATE_KEY = '';
process.env.RELAYER_PRIVATE_KEYS = '';
process.env.SETTLER_PRIVATE_KEY = '';

const { createApp } = await import('../apps/gateway/src/index.ts');
const { AgentLine, MemoryKeyStore } = await import('../packages/sdk/src/index.ts');

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const addr = server.address();
      baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

const connect = () => AgentLine.connect({ baseUrl, keyStore: new MemoryKeyStore() });

/**
 * Collect notices from an agent's SSE stream.
 *
 * Resolves as soon as `expect` notices have arrived, otherwise at the deadline. Waiting on
 * the condition rather than a fixed sleep keeps these tests from going flaky when the whole
 * suite runs concurrently and everything is a little slower.
 */
function listen(
  agent: Awaited<ReturnType<typeof connect>>,
  ms: number,
  expect = 0,
): Promise<unknown[]> {
  return new Promise((resolve) => {
    const received: unknown[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolve(received);
    };
    const stop = agent.streamInbox((n) => {
      received.push(n);
      if (expect > 0 && received.length >= expect) finish();
    });
    const timer = setTimeout(finish, ms);
  });
}

test('a notice reaches only the addressed agent', async () => {
  const alice = await connect();
  const bob = await connect();
  const carol = await connect();

  // Everyone listens; only Bob is messaged.
  const [bobHeard, carolHeard] = await Promise.all([
    listen(bob, 20_000, 1),
    listen(carol, 20_000),          // expects nothing, so it must run the full window
    (async () => {
      await new Promise((r) => setTimeout(r, 600));
      await alice.send(bob.agentId, 'for bob only');
    })(),
  ]);

  assert.ok(bobHeard.length >= 1, `Bob should have received a notice, got ${bobHeard.length}`);
  assert.equal(carolHeard.length, 0, `Carol must receive nothing, got ${JSON.stringify(carolHeard)}`);
});

test('the sender does not receive its own notice', async () => {
  const alice = await connect();
  const bob = await connect();

  const [aliceHeard] = await Promise.all([
    listen(alice, 6000),            // expects nothing; the window is the assertion
    (async () => {
      await new Promise((r) => setTimeout(r, 500));
      await alice.send(bob.agentId, 'outbound');
    })(),
  ]);
  assert.equal(aliceHeard.length, 0, `sender must not be notified of its own message, got ${JSON.stringify(aliceHeard)}`);
});

test('a notice carries no plaintext and no sender in sealed mode', async () => {
  const alice = await connect();
  const bob = await connect();

  const [heard] = await Promise.all([
    listen(bob, 20_000, 1),
    (async () => {
      await new Promise((r) => setTimeout(r, 600));
      await alice.send(bob.agentId, 'secret cargo manifest');
    })(),
  ]);

  assert.ok(heard.length >= 1);
  const serialised = JSON.stringify(heard);
  assert.equal(serialised.includes('cargo'), false, 'notice must not carry message content');
  assert.equal(serialised.includes(alice.agentId), false, 'sealed mode must not reveal the sender');
});

test('a reconnecting stream resumes without replaying everything', async () => {
  const alice = await connect();
  const bob = await connect();
  await alice.send(bob.agentId, 'first');
  await new Promise((r) => setTimeout(r, 800));

  // A fresh stream with no fromSeq starts from "now", not from the beginning of history.
  const afterFirst = await listen(bob, 1800);
  assert.equal(afterFirst.length, 0, `expected no replay of earlier notices, got ${afterFirst.length}`);

  // A new message still arrives.
  const [heard] = await Promise.all([
    listen(bob, 20_000, 1),
    (async () => { await new Promise((r) => setTimeout(r, 500)); await alice.send(bob.agentId, 'second'); })(),
  ]);
  assert.ok(heard.length >= 1, 'a new notice must arrive on the reconnected stream');
});

test('two streams for the same agent both receive its notices', async () => {
  const alice = await connect();
  const bob = await connect();

  const [first, second] = await Promise.all([
    listen(bob, 25_000, 1),
    listen(bob, 25_000, 1),
    (async () => { await new Promise((r) => setTimeout(r, 700)); await alice.send(bob.agentId, 'multi-device'); })(),
  ]);
  assert.ok(first.length >= 1 && second.length >= 1,
    `both of an agent's devices should be notified, got ${first.length} and ${second.length}`);
});
