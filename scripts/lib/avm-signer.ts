/**
 * Wallet signers for the operator scripts.
 *
 * Accepts either recovery-phrase format Pera produces: the classic 25-word Algorand mnemonic,
 * or the newer 24-word BIP39 phrase of an HD wallet. The phrase is read by the caller from the
 * environment; nothing here prints or stores it.
 */
import { toClientAvmSigner } from '@x402/avm';
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

export async function signerFromPhrase(raw: string): Promise<ClientAvmSigner> {
  const words = raw.trim().toLowerCase().split(/\s+/);
  if (words.length === 25) return toClientAvmSigner(await secretKeyFromMnemonic(words.join(' ')));
  if (words.length === 24 && validateMnemonic(words.join(' '), wordlist)) return hdSigner(words.join(' '));
  throw new Error(`expected a 25-word Algorand phrase or a 24-word Pera HD phrase, got ${words.length} words`);
}

/** Strip every word of the recovery phrase from anything we print, error messages included. */
export function redact(text: string): string {
  const words = (process.env.AVM_MNEMONIC ?? '').trim().split(/\s+/).filter((w) => w.length > 2);
  return words.reduce((t, w) => t.replace(new RegExp(`\\b${w}\\b`, 'gi'), '•••'), text);
}

