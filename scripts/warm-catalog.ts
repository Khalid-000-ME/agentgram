/**
 * List every paid route in the x402 Bazaar by making one real, successful call to each.
 *
 * The facilitator adds a resource to its catalog only after it settles a payment for it, and
 * x402 settles only successful (2xx) responses. So a route nobody has paid for yet is
 * invisible to agents browsing the catalog. This walks the whole product once, the way a new
 * agent would — two agents register, publish prekeys, open a conversation, message, read,
 * recall, form a group — so each route settles exactly once.
 *
 *   npx tsx scripts/warm-catalog.ts            # everything up to $0.10 a call
 *   npx tsx scripts/warm-catalog.ts --all      # also channels ($0.25), webhooks and handles ($0.50)
 *   npx tsx scripts/warm-catalog.ts --dry-run  # show the plan and the cost, pay nothing
 *
 * Reads AVM_MNEMONIC (25-word or 24-word Pera phrase) from the environment and never prints
 * it. Paying from the payTo address itself moves no money: the USDC comes straight back, and
 * the facilitator sponsors the network fee. The run only needs the balance to cover the
 * single largest call.
 *
 * Agent keys are kept in .data/warmup so a re-run reuses the same two agents instead of
 * registering new ones.
 */
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentLine, FileKeyStore } from '../packages/sdk/src/index.ts';
import { algorandFetch } from '../packages/sdk/src/algorand.ts';
import { b64, generateIdentity } from '@agentline/crypto';
import { redact, signerFromPhrase } from './lib/avm-signer.ts';

const BASE = (process.env.AGENTGRAM_URL ?? 'https://agentgram.onrender.com').replace(/\/$/, '');
const USDC = 31566704;
const ALL = process.argv.includes('--all');
const DRY = process.argv.includes('--dry-run');
const DIR = join(process.cwd(), '.data', 'warmup');

interface Step { route: string; price: number; run: () => Promise<unknown> }

async function usdcBalance(address: string): Promise<number> {
  const res = await fetch(`https://mainnet-api.algonode.cloud/v2/accounts/${address}/assets/${USDC}`);
  if (!res.ok) return 0;
  const body = await res.json() as { 'asset-holding'?: { amount: number } };
  return (body['asset-holding']?.amount ?? 0) / 1e6;
}

async function main() {
  const phrase = process.env.AVM_MNEMONIC;
  if (!phrase) throw new Error('AVM_MNEMONIC is not set — put the paying wallet\'s phrase in .env (gitignored)');
  const signer = await signerFromPhrase(phrase);
  const self = signer.address === process.env.AVM_ADDRESS?.trim();
  const balance = await usdcBalance(signer.address);
  console.log(`endpoint  ${BASE}`);
  console.log(`payer     ${signer.address}${self ? '  (the payTo address — payments come straight back)' : ''}`);
  console.log(`balance   $${balance.toFixed(4)} USDC\n`);

  mkdirSync(DIR, { recursive: true });
  const algorand = { signer, network: 'mainnet' as const };
  const connect = (name: string, capability: string) => AgentLine.connect({
    baseUrl: BASE,
    keyStore: new FileKeyStore(join(DIR, `${name}.json`)),
    algorand,
    profile: { name: `AgentGram ${name}`, description: 'Reference agent used to exercise every AgentGram route', capabilities: [capability] },
    autoRegister: false,
  });

  // Steps share these, filled as the walk proceeds.
  let alice!: AgentLine; let bob!: AgentLine; let cid = '';
  const call = <T>(agent: AgentLine, method: string, path: string, body?: unknown) => agent.request<T>(method, path, body);
  const raw = async (method: string, path: string, body?: unknown) => {
    // The flat routes that need no signature are called as any x402 client would.
    const res = await algorandFetch(algorand).fetch(`${BASE}${path}`, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<Record<string, any>>;
  };

  const steps: Step[] = [
    { route: 'POST /v1/agents + PUT prekeys (alice)', price: 0.09, run: async () => { alice = await connect('alice', 'reference'); if (!alice.inboxTopic) await alice.register(); return alice.agentId; } },
    { route: 'POST /v1/agents + PUT prekeys (bob)', price: 0.09, run: async () => { bob = await connect('bob', 'reference'); if (!bob.inboxTopic) await bob.register(); return bob.agentId; } },
    { route: 'POST /v1/conversations', price: 0.03, run: async () => { cid = await alice.openConversation(bob.agentId, { mode: 'open' }); return cid; } },
    { route: 'POST /v1/conversations/:cid/messages', price: 0.005, run: async () => (await alice.send(cid, 'hello from the AgentGram reference agents')).sequenceNumber },
    { route: 'GET /v1/conversations/:cid/messages', price: 0.001, run: async () => (await bob.read(cid)).length },
    { route: 'POST /v1/conversations/:cid/receipts', price: 0.002, run: async () => { await bob.markRead(cid, 1, 'read'); return 'ok'; } },
    { route: 'GET /v1/directory', price: 0.001, run: async () => (await call<{ count: number }>(alice, 'GET', '/v1/directory?q=agentgram')).count },
    { route: 'POST /x402/v1/send', price: 0.005, run: async () => {
      // A fresh ratchet message from alice, re-submitted through the flat route.
      const page = await call<{ messages: Array<{ envelope: string }> }>(alice, 'POST', '/x402/v1/read', { cid, limit: 1 });
      const envelope = page.messages[0]?.envelope;
      if (!envelope) throw new Error('no envelope to send');
      return (await call<{ sequenceNumber: number }>(alice, 'POST', '/x402/v1/send', { cid, envelope, importance: 0.9 })).sequenceNumber;
    } },
    { route: 'POST /x402/v1/read', price: 0.001, run: async () => (await raw('POST', '/x402/v1/read', { cid })).count },
    { route: 'POST /x402/v1/recall', price: 0.004, run: async () => (await raw('POST', '/x402/v1/recall', { cid, minImportance: 0.5 })).returned },
    { route: 'GET /x402/v1/directory', price: 0.001, run: async () => (await raw('GET', '/x402/v1/directory?capability=reference')).count },
    { route: 'POST /x402/v1/feedback', price: 0.001, run: async () => (await raw('POST', '/x402/v1/feedback', { text: 'Reference agents walked every route successfully.', respondent: alice.agentId })).answerId },
    { route: 'POST /x402/v1/register', price: 0.08, run: async () => {
      const id = generateIdentity();
      return (await raw('POST', '/x402/v1/register', { ed25519Pk: b64.enc(id.ed25519Pk), x25519Pk: b64.enc(id.x25519Pk) })).agentId;
    } },
    { route: 'POST /v1/groups', price: 0.10, run: async () => alice.createGroupChat({ name: 'agentgram-reference', members: [bob.agentId] }) },
    ...(ALL ? [
      { route: 'POST /v1/channels', price: 0.25, run: async () => (await call<{ channelId: string }>(alice, 'POST', '/v1/channels', { name: 'agentgram-status', description: 'AgentGram status feed' })).channelId },
      { route: 'POST /v1/webhooks', price: 0.5, run: async () => (await call<{ expiresAt: number }>(bob, 'POST', '/v1/webhooks', { url: 'https://example.com/agentgram-reference-webhook' })).expiresAt },
      { route: 'POST /v1/handles/:handle', price: 0.5, run: async () => { await alice.claimHandle('agentgram'); return '@agentgram'; } },
    ] : []),
  ];

  const total = steps.reduce((n, s) => n + s.price, 0);
  const largest = Math.max(...steps.map((s) => s.price));
  console.log(`${steps.length} steps · $${total.toFixed(3)} in payments${self ? ' (returned to you)' : ''} · largest single call $${largest}`);
  if (DRY) { for (const s of steps) console.log(`  ${s.route.padEnd(44)} $${s.price}`); return; }
  if (balance < (self ? largest : total)) {
    throw new Error(`balance $${balance.toFixed(4)} is below the $${(self ? largest : total).toFixed(3)} this run needs`);
  }

  let ok = 0;
  for (const s of steps) {
    try {
      const out = await s.run();
      ok++;
      console.log(`  ✓ ${s.route.padEnd(44)} $${s.price}  ${String(out).slice(0, 48)}`);
    } catch (err) {
      console.log(`  ✗ ${s.route.padEnd(44)} ${redact(String((err as Error)?.message ?? err)).slice(0, 160)}`);
    }
  }
  console.log(`\n${ok}/${steps.length} routes settled. The catalog updates within a few minutes:`);
  console.log('  https://facilitator.goplausible.xyz/discovery/resources');
}

main().catch((err) => { console.error('\n✗', redact(String(err?.message ?? err))); process.exit(1); });
