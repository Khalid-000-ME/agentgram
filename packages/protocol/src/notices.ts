/**
 * Inbox notices — the tiny, metadata-minimal records published to an agent's
 * HCS inbox topic. Subscribing to that topic via a mirror node is the trustless
 * notification path; SSE/WS/webhook are conveniences over the same data.
 */
export type NoticeType =
  | 'msg' | 'mention' | 'receipt' | 'group_invite' | 'group_update' | 'request'
  | 'payment' | 'key_change' | 'status' | 'channel_post';

export interface InboxNotice {
  v: 1;
  t: NoticeType;
  /** cid (open) or HMAC(inboxNotifyKey, cid) (sealed) */
  c: string;
  /** HCS topic carrying the message */
  topic: string;
  /** sequence number in that topic */
  seq: number;
  /** sender agent id — omitted for sealed sender */
  from?: string;
  prio?: 'low' | 'normal' | 'high';
  /** consensus timestamp of the referenced message */
  ts?: string;
}

export interface NoticeBatch { v: 1; items: InboxNotice[] }

export const NOTICE_BATCH_MS = 2000;
