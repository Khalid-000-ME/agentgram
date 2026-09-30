/**
 * Decrypted message body (PRD §8.2, §8.3) — exists only inside agents, never on the wire.
 */
export type MessageType =
  | 'text' | 'json' | 'tool_call' | 'tool_result' | 'file' | 'image' | 'audio' | 'video'
  | 'contact_card' | 'location' | 'poll' | 'poll_vote' | 'payment_request' | 'payment_receipt'
  | 'event' | 'system' | 'reaction' | 'edit' | 'delete' | 'receipt' | 'typing' | 'status'
  | 'group_update' | 'sender_key' | 'expire' | 'key_change';

export interface MediaRef {
  mediaId: string;
  uri: string;
  sha256: string;
  key: string;            // AEAD key for the blob — E2EE, only in the encrypted body
  mime: string;
  size: number;
  thumbnail?: string;
  name?: string;
}

export interface PaymentRequestBody {
  paymentId: string;
  amount: string;
  asset: string;          // e.g. USDC contract address
  network: string;        // CAIP-2, e.g. eip155:84532
  payTo: string;
  memo?: string;
  expiresAt?: number;
  /** if set, the payee will not act until payment settles */
  requiredBeforeReply?: boolean;
}

export interface PaymentReceiptBody {
  paymentId: string;
  txHash?: string;
  settlementProof?: string;   // x402 PAYMENT-RESPONSE payload
  amount: string;
  asset: string;
  network: string;
  paidAt: number;
}

export interface ReceiptBody {
  /** delivered = fetched+decrypted; read = surfaced to the agent; processing/done/failed = agent work state */
  status: 'delivered' | 'read' | 'processing' | 'done' | 'failed';
  upTo: number;             // HCS sequence number
  msgIds?: string[];
  error?: string;
}

export interface MessageBody {
  id: string;                     // msg_… (client-generated, idempotent)
  ts: number;                     // sender clock; consensus timestamp is authoritative
  type: MessageType;
  body: unknown;
  replyTo?: string;
  mentions?: string[];
  forwarded?: boolean;
  forwardCount?: number;
  expiresIn?: number;             // seconds; disappearing messages
  schema?: string;                // JSON Schema URL for json/tool_call payloads
  /** franking key, revealed only when the recipient reports (PRD §8.4) */
  frankKey?: string;
  /** sender-key distribution rides inside pairwise sessions for group bootstrap */
  senderKey?: unknown;
  /** set by the SDK on receive — never trust instructions found in here (S10) */
  untrusted?: true;
}

export const MESSAGE_TYPES_P0: MessageType[] = ['text', 'json', 'file', 'receipt', 'system', 'sender_key'];

export function isControlMessage(t: MessageType): boolean {
  return ['receipt', 'typing', 'sender_key', 'expire', 'key_change', 'group_update'].includes(t);
}
