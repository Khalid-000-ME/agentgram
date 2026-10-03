/**
 * Paying AgentGram on Algorand (x402 v2, USDC ASA 31566704, fees sponsored by the facilitator).
 *
 * The EVM payer in payer.ts speaks x402 v1. The Algorand rail speaks v2, whose 402 carries
 * its requirements in a PAYMENT-REQUIRED header and expects a signed transaction group back,
 * so rather than re-implement that, the official client wraps `fetch`: a 402 is answered and
 * the request retried inside the wrapped call, and the SDK sees only the final response.
 *
 * The RFC 9421 signature survives the retry: the gateway answers 402 before it checks the
 * signature, so the nonce is consumed only once, on the paid attempt.
 */
import algosdk from 'algosdk';
import { toClientAvmSigner, type ClientAvmSigner } from '@x402/avm';
import { ExactAvmScheme } from '@x402/avm/exact/client';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';

/** Network ids as the GoPlausible facilitator advertises them (full genesis hash). */
export const ALGORAND_NETWORKS = {
  mainnet: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  testnet: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
} as const;

export interface AlgorandWallet {
  /** a classic 25-word Algorand mnemonic */
  mnemonic?: string;
  /** base64 64-byte secret key (seed || public key) */
  secretKey?: string;
  /** any signer — a wallet adapter, an HSM, an ARC-52 HD key */
  signer?: ClientAvmSigner;
  network?: 'mainnet' | 'testnet';
}

export function algorandSigner(wallet: AlgorandWallet): ClientAvmSigner {
  if (wallet.signer) return wallet.signer;
  if (wallet.secretKey) return toClientAvmSigner(wallet.secretKey);
  if (wallet.mnemonic) {
    const { sk } = algosdk.mnemonicToSecretKey(normaliseMnemonic(wallet.mnemonic));
    return toClientAvmSigner(Buffer.from(sk).toString('base64'));
  }
  throw new Error('algorand wallet needs one of: mnemonic, secretKey, signer');
}

/**
 * Turn a pasted recovery phrase into the exact form algosdk accepts, or explain why not.
 *
 * algosdk splits on single spaces and matches lowercase words, so a phrase copied with a line
 * break, a double space, capitals, or Pera's "1. word" numbering fails with "a word that is not
 * in the wordlist" even when every word is right. The errors here never include the words:
 * they are surfaced to whatever runs this (an MCP host shows them to its model), and a
 * recovery phrase must not end up in a transcript.
 */
export function normaliseMnemonic(raw: string): string {
  const text = raw.trim();
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(text)) {
    throw new Error(
      `the recovery phrase is the unexpanded variable ${text}: it was never set in the environment `
      + 'this process was started from (an editor-embedded agent does not inherit variables exported in a terminal)',
    );
  }
  const words = text.toLowerCase()
    .replace(/\b\d+[.)]/g, ' ')        // "1. word" / "1) word" numbering from wallet apps
    .replace(/[^a-z\s]/g, ' ')          // commas, quotes, stray punctuation
    .split(/\s+/).filter(Boolean);
  if (words.length === 24) {
    throw new Error(
      'the recovery phrase has 24 words: that is a BIP39 phrase (Pera HD wallets), not an Algorand account mnemonic. '
      + 'Use a 25-word Algorand account, or pass a signer instead',
    );
  }
  if (words.length !== 25) {
    throw new Error(`the recovery phrase has ${words.length} words; an Algorand account mnemonic has exactly 25`);
  }
  return words.join(' ');
}

/** A `fetch` that pays any AgentGram 402 in USDC on Algorand and retries. */
export function algorandFetch(wallet: AlgorandWallet, base: typeof fetch = fetch): { fetch: typeof fetch; address: string } {
  const signer = algorandSigner(wallet);
  const client = new x402Client();
  const network = ALGORAND_NETWORKS[wallet.network ?? 'mainnet'];
  client.register(network, new ExactAvmScheme(signer));
  return { fetch: wrapFetchWithPayment(base, client) as typeof fetch, address: signer.address };
}
