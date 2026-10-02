/**
 * Make one real Algorand Mainnet payment against the live endpoint.
 *
 * The Global x402 Challenge requires exactly this: "You've made one real Mainnet payment
 * against your endpoint end-to-end" and "the USDC landed in your payTo address". Running
 * this once satisfies it, and every later run adds to the usage the leaderboard ranks on.
 *
 *   AVM_MNEMONIC="your 25 words" npx tsx scripts/pay-mainnet.ts [route]
 *
 * route defaults to `updates`: $0.01 and it returns real content, so the request succeeds and
 * the payment settles (x402 only settles a successful response — paying for a 404 does not
 * count). Others: survey, directory, read, recall.
 *
 * The mnemonic is read from the environment and never written anywhere. Keep it out of
 * shell history — put it in .env, which this repo gitignores, or prefix the command with a
 * space if your shell is configured to skip those.
 */
import 'dotenv/config';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { ExactAvmScheme } from '@x402/avm';
import { redact, signerFromPhrase } from './lib/avm-signer.ts';

/** Must match what the facilitator advertises on GET /supported, not the truncated SDK constant. */
const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;
const BASE = (process.env.AGENTEGRAM_URL ?? 'https://agentgram.onrender.com').replace(/\/$/, '');

const ROUTES: Record<string, { path: string; method: string; body?: unknown; price: string }> = {
  updates:   { path: '/x402/v1/updates',   method: 'GET',  price: '$0.01' },
  survey:    { path: '/x402/v1/survey',    method: 'GET',  price: '$0.01' },
  read:      { path: '/x402/v1/read',      method: 'POST', body: { cid: 'cnv_probe', limit: 1 }, price: '$0.01' },
  directory: { path: '/x402/v1/directory', method: 'GET',  price: '$0.01' },
  recall:    { path: '/x402/v1/recall',    method: 'POST', body: { cid: 'cnv_probe', minImportance: 0.6 }, price: '$0.01' },
  send:      { path: '/x402/v1/send',      method: 'POST', body: { cid: 'cnv_probe', envelope: '' }, price: '$0.01' },
};

async function main() {
  const mnemonic = process.env.AVM_MNEMONIC;
  if (!mnemonic) {
    throw new Error('AVM_MNEMONIC is not set — put your 25-word Algorand mnemonic in .env (gitignored)');
  }
  const name = (process.argv[2] ?? 'updates').toLowerCase();
  const route = ROUTES[name];
  if (!route) throw new Error(`unknown route "${name}". One of: ${Object.keys(ROUTES).join(', ')}`);

  const signer = await signerFromPhrase(mnemonic);
  const expected = process.env.AVM_ADDRESS?.trim();
  if (expected && signer.address === expected) {
    console.log('note: paying from the payTo address itself — a self-transfer still settles on-chain');
  }
  console.log(`paying from  ${signer.address}`);
  console.log(`endpoint     ${BASE}${route.path}  (${route.price})`);

  const client = new x402Client();
  client.register(MAINNET, new ExactAvmScheme(signer));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPayment(`${BASE}${route.path}`, {
    method: route.method,
    ...(route.body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) } : {}),
  });

  console.log(`\nHTTP ${res.status}`);
  const settle = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
  if (settle) {
    console.log('payment settled:', JSON.stringify(settle, null, 2));
  } else {
    console.log('no settlement header returned — the request may not have been charged');
  }

  const text = await res.text();
  console.log('\nresponse body:', text.slice(0, 500));

  if (res.ok && settle) {
    console.log('\n✓ A real Mainnet payment completed end to end.');
    console.log('  Confirm the USDC landed:');
    console.log(`  https://allo.info/account/${process.env.AVM_ADDRESS ?? '<your payTo>'}`);
    console.log('  And that the endpoint is listed: https://facilitator.goplausible.xyz/discovery/resources');
  }
}

main().catch((err) => { console.error('\n✗', redact(String(err?.message ?? err))); process.exit(1); });
