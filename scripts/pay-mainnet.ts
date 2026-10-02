/**
 * Make one real Algorand Mainnet payment against the live endpoint.
 *
 * The Global x402 Challenge requires exactly this: "You've made one real Mainnet payment
 * against your endpoint end-to-end" and "the USDC landed in your payTo address". Running
 * this once satisfies it, and every later run adds to the usage the leaderboard ranks on.
 *
 *   AVM_MNEMONIC="your 25 words" npx tsx scripts/pay-mainnet.ts [route]
 *
 * route defaults to `updates`: $0.001 and it returns real content, so the request succeeds and
 * the payment settles (x402 only settles a successful response — paying for a 404 does not
 * count). Others: survey, directory, read, recall.
 *
 * The mnemonic is read from the environment and never written anywhere. Keep it out of
 * shell history — put it in .env, which this repo gitignores, or prefix the command with a
 * space if your shell is configured to skip those.
 */
import 'dotenv/config';
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch';
import { toClientAvmSigner, ExactAvmScheme } from '@x402/avm';
import {
  ed25519SigningKeyFromWrappedSecret,
  type WrappedEd25519Seed,
} from '@algorandfoundation/algokit-utils/crypto';
import { seedFromMnemonic } from '@algorandfoundation/algokit-utils/algo25';
import { peikertXHdWalletGenerator } from '@algorandfoundation/algokit-utils/crypto';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import algosdk from 'algosdk';
import type { ClientAvmSigner } from '@x402/avm';

/** Must match what the facilitator advertises on GET /supported, not the truncated SDK constant. */
const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;
const BASE = (process.env.AGENTGRAM_URL ?? 'https://agentgram.onrender.com').replace(/\/$/, '');

const ROUTES: Record<string, { path: string; method: string; body?: unknown; price: string }> = {
  updates:   { path: '/x402/v1/updates',   method: 'GET',  price: '$0.001' },
  survey:    { path: '/x402/v1/survey',    method: 'GET',  price: '$0.001' },
  read:      { path: '/x402/v1/read',      method: 'POST', body: { cid: 'cnv_probe', limit: 1 }, price: '$0.001' },
  directory: { path: '/x402/v1/directory', method: 'GET',  price: '$0.001' },
  recall:    { path: '/x402/v1/recall',    method: 'POST', body: { cid: 'cnv_probe', minImportance: 0.6 }, price: '$0.004' },
  send:      { path: '/x402/v1/send',      method: 'POST', body: { cid: 'cnv_probe', envelope: '' }, price: '$0.005' },
};

async function secretKeyFromMnemonic(mnemonic: string): Promise<string> {
  const seed = seedFromMnemonic(mnemonic.trim());
  const seedCopy = new Uint8Array(seed);
  const wrappedSeed: WrappedEd25519Seed = {
    unwrapEd25519Seed: async () => seed,
    wrapEd25519Seed: async () => {},
  };
  const wrapped = await ed25519SigningKeyFromWrappedSecret(wrappedSeed);
  return Buffer.concat([Buffer.from(seedCopy), Buffer.from(wrapped.ed25519Pubkey)]).toString('base64');
}

/**
 * A signer for Pera's newer HD wallets, whose recovery phrase is 24 BIP39 words rather than
 * the classic 25. Their keys are derived with BIP32-Ed25519 (the Peikert variant, ARC-52),
 * which yields an extended key that cannot be converted to the 64-byte seed
 * `toClientAvmSigner` expects — so this signs through the HD signer directly instead.
 */
async function hdSigner(phrase: string, account = 0, index = 0): Promise<ClientAvmSigner> {
  const { accountGenerator } = await peikertXHdWalletGenerator(mnemonicToSeedSync(phrase));
  const key = await accountGenerator(account, index);
  const address = algosdk.encodeAddress(key.ed25519Pubkey);
  return {
    address,
    async signTransactions(txns: Uint8Array[], indexesToSign?: number[]) {
      return Promise.all(txns.map(async (bytes, i) => {
        if (indexesToSign && !indexesToSign.includes(i)) return null;
        const txn = algosdk.decodeUnsignedTransaction(bytes);
        return txn.attachSignature(address, await key.rawEd25519Signer(txn.bytesToSign()));
      }));
    },
  };
}

async function signerFromPhrase(raw: string): Promise<ClientAvmSigner> {
  const words = raw.trim().toLowerCase().split(/\s+/);
  if (words.length === 25) return toClientAvmSigner(await secretKeyFromMnemonic(words.join(' ')));
  if (words.length === 24 && validateMnemonic(words.join(' '), wordlist)) return hdSigner(words.join(' '));
  throw new Error(`expected a 25-word Algorand phrase or a 24-word Pera HD phrase, got ${words.length} words`);
}

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

/** Strip every word of the recovery phrase from anything we print, error messages included. */
function redact(text: string): string {
  const words = (process.env.AVM_MNEMONIC ?? '').trim().split(/\s+/).filter((w) => w.length > 2);
  return words.reduce((t, w) => t.replace(new RegExp(`\\b${w}\\b`, 'gi'), '•••'), text);
}

main().catch((err) => { console.error('\n✗', redact(String(err?.message ?? err))); process.exit(1); });
