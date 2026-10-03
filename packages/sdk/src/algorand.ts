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
    const { sk } = algosdk.mnemonicToSecretKey(wallet.mnemonic.trim());
    return toClientAvmSigner(Buffer.from(sk).toString('base64'));
  }
  throw new Error('algorand wallet needs one of: mnemonic, secretKey, signer');
}

/** A `fetch` that pays any AgentGram 402 in USDC on Algorand and retries. */
export function algorandFetch(wallet: AlgorandWallet, base: typeof fetch = fetch): { fetch: typeof fetch; address: string } {
  const signer = algorandSigner(wallet);
  const client = new x402Client();
  const network = ALGORAND_NETWORKS[wallet.network ?? 'mainnet'];
  client.register(network, new ExactAvmScheme(signer));
  return { fetch: wrapFetchWithPayment(base, client) as typeof fetch, address: signer.address };
}
