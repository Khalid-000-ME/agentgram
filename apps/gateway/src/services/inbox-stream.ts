/**
 * Per-agent inbox stream, driven by the chain.
 *
 * The first version pushed notices from an in-process subscriber map. That is wrong in two
 * ways once there is more than one gateway instance: a notice is delivered by whichever
 * instance handled the *send*, while the stream is held by whichever instance the
 * *recipient* connected to — usually not the same one — and nothing recovers a notice
 * emitted while the recipient was briefly disconnected.
 *
 * So the stream tails the agent's own HCS inbox topic instead. That topic contains only
 * notices addressed to that agent, which makes "deliver to exactly one agent" a property
 * of the transport rather than something the gateway has to enforce correctly. Any instance
 * can serve any agent's stream, a reconnect resumes from the last sequence number the
 * client saw, and an agent that does not trust us can read the identical feed straight from
 * a mirror node.
 *
 * A local fast path is layered on top purely for latency: when the sending instance is also
 * the one holding the socket, the notice is pushed immediately and de-duplicated against the
 * chain tail by sequence number.
 */
import type { Response } from 'express';
import { decode } from 'cbor-x';
import type { InboxNotice } from '@agentline/protocol';
import { store } from '../lib/store.ts';
import { ledger } from './ledger.ts';

const POLL_INTERVAL_MS = Number(process.env.INBOX_POLL_MS ?? 2500);
const KEEPALIVE_MS = 15_000;

interface Connection {
  agentId: string;
  inboxTopic: string;
  res: Response;
  /** highest inbox-topic sequence number already sent to this client */
  lastSeq: number;
  /** de-duplicates the local fast path against the chain tail */
  sent: Set<number>;
  closed: boolean;
}

const connections = new Map<string, Set<Connection>>();

export function localSubscriberCount(agentId: string): number {
  return connections.get(agentId)?.size ?? 0;
}

export function totalSubscribers(): number {
  let n = 0;
  for (const set of connections.values()) n += set.size;
  return n;
}

function write(conn: Connection, event: string, data: unknown): void {
  if (conn.closed) return;
  try {
    conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    conn.closed = true;
  }
}

/**
 * Emit a notice to one agent's open streams, if this instance holds any.
 *
 * `seq` is the inbox-topic sequence number, which is what makes de-duplication against the
 * chain tail exact rather than heuristic.
 */
export function pushLocal(agentId: string, notice: InboxNotice, seq: number): void {
  const set = connections.get(agentId);
  if (!set?.size) return;
  for (const conn of set) {
    if (conn.sent.has(seq)) continue;
    conn.sent.add(seq);
    if (seq > conn.lastSeq) conn.lastSeq = seq;
    write(conn, 'notice', notice);
  }
}

/** Decode one inbox-topic message into the notices it carries (single or batched). */
function decodeNotices(contents: Uint8Array): InboxNotice[] {
  try {
    const payload = decode(contents) as InboxNotice | { v: 1; items: InboxNotice[] };
    if (payload && typeof payload === 'object' && 'items' in payload && Array.isArray(payload.items)) {
      return payload.items;
    }
    return [payload as InboxNotice];
  } catch {
    return [];
  }
}

/**
 * Open a stream for one agent. Returns when the client disconnects.
 *
 * `fromSeq` lets a reconnecting client resume exactly where it left off, so a dropped
 * connection does not lose notices.
 */
export async function streamInbox(agentId: string, res: Response, fromSeq?: number): Promise<void> {
  const agent = store.agent(agentId);
  const inboxTopic = agent?.inboxTopic;
  if (!inboxTopic) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'agent has no inbox topic' })}\n\n`);
    res.end();
    return;
  }

  // Default to "only what arrives from now on", so a long-lived agent reconnecting does not
  // replay its entire history. Pass ?fromSeq=0 to replay from the beginning.
  let startSeq = fromSeq;
  if (startSeq === undefined) {
    const known = store.notices(agentId);
    startSeq = known.length ? Math.max(...known.map((n) => n.seq)) : 0;
  }

  const conn: Connection = { agentId, inboxTopic, res, lastSeq: startSeq, sent: new Set(), closed: false };
  const set = connections.get(agentId) ?? new Set<Connection>();
  set.add(conn);
  connections.set(agentId, set);

  write(conn, 'open', {
    agentId,
    inboxTopic,
    fromSeq: startSeq,
    transport: ledger().kind,
    note: 'This stream tails your own HCS inbox topic. Only notices addressed to you appear here. '
      + 'You can read the identical feed directly from a mirror node without this gateway.',
  });

  const keepAlive = setInterval(() => {
    if (conn.closed) return;
    try { conn.res.write(': ping\n\n'); } catch { conn.closed = true; }
  }, KEEPALIVE_MS);

  // Tail the topic. Polling the mirror node keeps this instance-independent; the local fast
  // path above covers the latency gap between consensus and mirror indexing.
  const poll = setInterval(() => {
    if (conn.closed) return;
    void (async () => {
      try {
        const messages = await ledger().read(conn.inboxTopic, { afterSeq: conn.lastSeq, limit: 50 });
        for (const message of messages) {
          if (conn.sent.has(message.seq)) { conn.lastSeq = Math.max(conn.lastSeq, message.seq); continue; }
          conn.sent.add(message.seq);
          conn.lastSeq = Math.max(conn.lastSeq, message.seq);
          for (const notice of decodeNotices(message.contents)) write(conn, 'notice', notice);
        }
        // Keep the de-duplication set from growing without bound on a long-lived stream.
        if (conn.sent.size > 500) {
          const keep = [...conn.sent].sort((a, b) => b - a).slice(0, 200);
          conn.sent = new Set(keep);
        }
      } catch (err) {
        // A mirror hiccup must not kill the stream; the next tick retries.
        write(conn, 'lag', { reason: (err as Error).message.slice(0, 160) });
      }
    })();
  }, POLL_INTERVAL_MS);

  const cleanup = () => {
    conn.closed = true;
    clearInterval(keepAlive);
    clearInterval(poll);
    set.delete(conn);
    if (!set.size) connections.delete(agentId);
  };

  await new Promise<void>((resolve) => {
    res.on('close', () => { cleanup(); resolve(); });
    res.on('error', () => { cleanup(); resolve(); });
  });
}

export function closeAllStreams(): void {
  for (const set of connections.values()) {
    for (const conn of set) {
      conn.closed = true;
      try { conn.res.end(); } catch { /* already gone */ }
    }
  }
  connections.clear();
}
