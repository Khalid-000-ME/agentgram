import 'dotenv/config';
import { NETWORKS } from '@agentline/protocol';

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Accept an EVM private key with or without the 0x prefix. Wallets and faucets export it
 * both ways, and viem only accepts the prefixed form — so normalise rather than fail with
 * an opaque error deep inside a signing call.
 */
function evmKey(v: string | undefined): `0x${string}` | undefined {
  if (!v) return undefined;
  const hex = v.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`invalid EVM private key: expected 64 hex characters, got ${hex.length}`);
  }
  return `0x${hex}` as `0x${string}`;
}

const network = process.env.X402_NETWORK ?? 'base-sepolia';
const net = NETWORKS[network];
if (!net) throw new Error(`unsupported X402_NETWORK: ${network}`);

export const config = {
  port: Number(process.env.PORT ?? 8402),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8402}`).replace(/\/$/, ''),
  dataDir: process.env.DATA_DIR ?? '.data',
  env: process.env.NODE_ENV ?? 'development',

  /* ---- x402 payments (Base Sepolia by default) ---- */
  x402: {
    enabled: bool(process.env.X402_ENABLED, true),
    /** When true, a valid-looking but unsettled payment is accepted (demo/testing only). */
    devAcceptUnsettled: bool(process.env.X402_DEV_ACCEPT_UNSETTLED, false),
    network,
    caip2: net.caip2,
    chainId: net.chainId,
    asset: (process.env.X402_ASSET ?? net.usdc) as `0x${string}`,
    assetName: process.env.X402_ASSET_NAME ?? net.usdcName,
    assetVersion: process.env.X402_ASSET_VERSION ?? net.usdcVersion,
    payTo: (process.env.X402_PAY_TO ?? '') as `0x${string}`,
    facilitatorUrl: process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
    /** 'facilitator' (default when a URL is set) or 'direct' to always self-settle. */
    settleMode: (process.env.X402_SETTLE_MODE ?? '') as '' | 'facilitator' | 'direct',
    /** Optional: settle EIP-3009 authorizations ourselves instead of via a facilitator. */
    settlerPrivateKey: evmKey(process.env.SETTLER_PRIVATE_KEY),
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    maxTimeoutSeconds: Number(process.env.X402_MAX_TIMEOUT ?? 120),
  },

  /* ---- Hedera Consensus Service (message + notification transport) ---- */
  hedera: {
    enabled: bool(process.env.HEDERA_ENABLED, true),
    network: process.env.HEDERA_NETWORK ?? 'testnet',
    accountId: process.env.HEDERA_ACCOUNT_ID,
    privateKey: process.env.HEDERA_PRIVATE_KEY,
    mirrorRest: process.env.HEDERA_MIRROR_REST ??
      (process.env.HEDERA_NETWORK === 'mainnet'
        ? 'https://mainnet.mirrornode.hedera.com'
        : 'https://testnet.mirrornode.hedera.com'),
    /** Number of shared topics used for sealed DMs (PRD §5.4). */
    sealedShards: Number(process.env.HEDERA_SEALED_SHARDS ?? 4),
  },

  /* ---- Registry contract (Base Sepolia by default) ---- */
  registry: {
    address: process.env.REGISTRY_ADDRESS as `0x${string}` | undefined,
    rpcUrl: process.env.REGISTRY_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org',
    chainId: Number(process.env.REGISTRY_CHAIN_ID ?? net.chainId),
    relayerPrivateKey: evmKey(process.env.RELAYER_PRIVATE_KEY),
    /** Mirror registry writes locally as well, so reads work while a tx is pending. */
    writeThrough: bool(process.env.REGISTRY_WRITE_THROUGH, true),
  },

  limits: {
    maxEnvelopeBytes: Number(process.env.MAX_ENVELOPE_BYTES ?? 1024),
    maxChunkedBytes: Number(process.env.MAX_CHUNKED_BYTES ?? 20 * 1024),
    maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 512 * 1024),
    rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600),
    firstContactPerHour: Number(process.env.FIRST_CONTACT_PER_HOUR ?? 60),
    maxGroupMembers: Number(process.env.MAX_GROUP_MEMBERS ?? 1024),
  },

  /** Metadata minimization (S12): how long request metadata is retained. */
  retentionDays: Number(process.env.RETENTION_DAYS ?? 7),
} as const;

export type Config = typeof config;

export function chainMode(): 'hedera' | 'local' {
  return config.hedera.enabled && config.hedera.accountId && config.hedera.privateKey ? 'hedera' : 'local';
}

export function registryMode(): 'onchain' | 'local' {
  return config.registry.address && config.registry.relayerPrivateKey ? 'onchain' : 'local';
}

/**
 * How verified payments get settled.
 *
 * A facilitator is preferred when one is configured because it costs us no gas; a settler
 * key then serves as the fallback path (see settle() in middleware/x402.ts). Set
 * X402_SETTLE_MODE=direct to always submit transfers ourselves.
 */
export function paymentMode(): 'settle' | 'facilitator' | 'verify-only' | 'disabled' {
  if (!config.x402.enabled) return 'disabled';
  if (config.x402.devAcceptUnsettled) return 'verify-only';
  if (config.x402.settleMode === 'direct') {
    if (!config.x402.settlerPrivateKey) throw new Error('X402_SETTLE_MODE=direct requires SETTLER_PRIVATE_KEY');
    return 'settle';
  }
  if (config.x402.facilitatorUrl) return 'facilitator';
  if (config.x402.settlerPrivateKey) return 'settle';
  return 'verify-only';
}
