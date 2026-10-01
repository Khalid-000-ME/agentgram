/**
 * Notification fan-out (PRD §4.1 Notifier, §7.4).
 *
 * The agent's HCS inbox topic is the source of truth — an agent can subscribe to it via a
 * mirror node and never talk to us again. These are the convenience paths layered on top:
 * SSE/WS streams and HMAC-signed webhooks. Low-priority notices are batched to save fees.
 */
import { createHmac } from 'node:crypto';
import { encode } from 'cbor-x';
import { NOTICE_BATCH_MS, type InboxNotice } from '@agentline/protocol';
import { store } from '../lib/store.ts';
import { ledger } from './ledger.ts';
import { pushLocal, totalSubscribers } from './inbox-stream.ts';

const pending = new Map<string, InboxNotice[]>();
const timers = new Map<string, NodeJS.Timeout>();

export function subscriberCount(_agentId: string): number {
  return totalSubscribers();
}

/**
 * Publish a notice to an agent's inbox.
 *
 * `high`/`normal` priority notices go to the inbox topic immediately; `low` ones
 * (receipts, typing-equivalents) are batched per NOTICE_BATCH_MS so a busy conversation
 * does not pay one HCS fee per receipt.
 */
export async function notify(agentId: string, notice: InboxNotice): Promise<void> {
  if (notice.prio === 'low') {
    const queue = pending.get(agentId) ?? [];
    queue.push(notice);
    pending.set(agentId, queue);
    if (!timers.has(agentId)) {
      timers.set(agentId, setTimeout(() => void flush(agentId), NOTICE_BATCH_MS));
    }
    return;
  }
  await publish(agentId, [notice]);
}

async function flush(agentId: string): Promise<void> {
  timers.delete(agentId);
  const queue = pending.get(agentId);
  pending.delete(agentId);
  if (queue?.length) await publish(agentId, queue);
}

async function publish(agentId: string, notices: InboxNotice[]): Promise<void> {
  const agent = store.agent(agentId);
  if (!agent?.inboxTopic) return;
  const payload = notices.length === 1 ? notices[0] : { v: 1, items: notices };
  try {
    const result = await ledger().submit(agent.inboxTopic, encode(payload));
    const list = store.notices(agentId);
    for (const n of notices) list.push({ seq: result.seq, notice: n, at: Date.now() });
    if (list.length > 2000) list.splice(0, list.length - 2000);
    store.save();
    // Fast path: if this instance also holds the recipient's stream, deliver now rather
    // than waiting for the mirror node to index the topic. Keyed by the topic sequence
    // number so the chain tail will not deliver it twice.
    for (const n of notices) pushLocal(agentId, n, result.seq);
  } catch (err) {
    console.error(`[notifier] inbox submit failed for ${agentId}:`, (err as Error).message);
  }
  void deliverWebhook(agentId, notices);
}

async function deliverWebhook(agentId: string, notices: InboxNotice[]): Promise<void> {
  const hook = store.agent(agentId)?.webhook;
  if (!hook || hook.expiresAt < Date.now()) return;
  const body = JSON.stringify({ v: 1, agentId, notices });
  const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'AgentLine-Signature': `sha256=${signature}`,
        'AgentLine-Delivery': String(Date.now()),
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    console.warn(`[notifier] webhook delivery failed for ${agentId}:`, (err as Error).message);
  }
}

/** SSRF protection for agent-supplied webhook URLs (S7). */
export function validateWebhookUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(process.env.ALLOW_HTTP_WEBHOOKS === 'true' && url.protocol === 'http:')) {
    throw new Error('webhook URL must be https');
  }
  const host = url.hostname.toLowerCase();
  const blocked = [
    /^localhost$/, /^127\./, /^0\./, /^10\./, /^192\.168\./, /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[01])\./, /^\[?::1\]?$/, /^\[?fd[0-9a-f]{2}:/, /\.internal$/, /\.local$/,
  ];
  if (process.env.ALLOW_HTTP_WEBHOOKS !== 'true' && blocked.some((re) => re.test(host))) {
    throw new Error('webhook URL resolves to a private or loopback address');
  }
  return url;
}

export async function flushAll(): Promise<void> {
  for (const agentId of [...pending.keys()]) {
    const t = timers.get(agentId);
    if (t) { clearTimeout(t); timers.delete(agentId); }
    await flush(agentId);
  }
}
