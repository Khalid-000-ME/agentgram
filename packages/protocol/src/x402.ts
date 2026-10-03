/**
 * x402 wire types.
 *
 * This implementation speaks both header generations so that off-the-shelf clients work:
 *   - v1 (widely deployed):  request `X-PAYMENT`,           response `X-PAYMENT-RESPONSE`
 *   - v2:                   request `PAYMENT-SIGNATURE`,   response `PAYMENT-RESPONSE`,
 *                            challenge echoed in `PAYMENT-REQUIRED`
 * The 402 body always carries the machine-readable `accepts` array, which is what agents
 * and the x402 client libraries actually parse.
 */
export const X402_VERSION = 1;

export const HEADERS = {
  paymentRequired: 'PAYMENT-REQUIRED',
  paymentSignatureV2: 'PAYMENT-SIGNATURE',
  paymentV1: 'X-PAYMENT',
  paymentResponseV2: 'PAYMENT-RESPONSE',
  paymentResponseV1: 'X-PAYMENT-RESPONSE',
} as const;

export interface PaymentRequirements {
  scheme: 'exact' | 'upto';
  /** x402 network name, e.g. "base-sepolia" */
  network: string;
  /** CAIP-2 form, e.g. "eip155:84532" */
  caip2: string;
  maxAmountRequired: string;      // atomic units
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;                  // token contract
  extra?: { name: string; version: string };
}

export interface PaymentRequiredBody {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

/** EIP-3009 `transferWithAuthorization` payload, the `exact` scheme on EVM networks. */
export interface ExactEvmAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: 'exact' | 'upto';
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: ExactEvmAuthorization;
  };
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeHeaderJson<T>(header: string): T {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
}

/** Networks we can price and settle on. Base Sepolia is the default test network. */
export const NETWORKS: Record<string, { caip2: string; chainId: number; usdc: `0x${string}`; usdcName: string; usdcVersion: string }> = {
  'base-sepolia': {
    caip2: 'eip155:84532', chainId: 84532,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcName: 'USDC', usdcVersion: '2',
  },
  base: {
    caip2: 'eip155:8453', chainId: 8453,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    usdcName: 'USD Coin', usdcVersion: '2',
  },
};
