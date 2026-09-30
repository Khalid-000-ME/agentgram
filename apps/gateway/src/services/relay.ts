/**
 * Relayer + indexer (PRD §4.1).
 *
 * The relayer submits ciphertext envelopes to HCS on an agent's behalf (agents may also
 * self-submit and pay HBAR themselves — the protocol works without us). The indexer keeps
 * a read-optimised view of what it submitted or observed, always rebuildable from chain.
 */
import { createHmac } from 'node:crypto';
import { b64, utf8 } from '@agentline/crypto';
import {
  AgentLineError, decodeEnvelope, encodeEnvelope, type Envelope, type InboxNotice,
} from '@agentline/protocol';
import { config } from '../config.ts';
import { store, type ConversationRecord, type MessageRecord } from '../lib/store.ts';
import { chunkPayload, ledger, shardFor, type SubmitResult } from './ledger.ts';
import { notify } from './notifier.ts';
import { raiseAlert } from './alerts.ts';

/** Provision (or reuse) the HCS topic that carries a conversation. */
export async function topicForConversation(opts: {
  cid: string;
  kind: 'dm' | 'group' | 'channel';
  mode: 'open' | 'sealed';
}): Promise<{ topicId: string; tag?: string }> {
  // Sealed DMs share a small pool of topics: cheaper, and it hides which topic belongs to
  // which pair of agents. Open conversations and groups get a dedicated topic.
  if (opts.mode === 'sealed' && opts.kind === 'dm') {
    const shards = Math.max(1, config.hedera.sealedShards);
    while (store.db.sealedShardTopics.length < shards) {
      const topicId = await ledger().createTopic(`agentline:sealed-shard:${store.db.sealedShardTopics.length}`);
      store.db.sealedShardTopics.push(topicId);
      store.save();
    }
    const topicId = store.db.sealedShardTopics[shardFor(opts.cid, shards)];
    return { topicId, tag: blindedTag(opts.cid) };
  }
  const topicId = await ledger().createTopic(`agentline:${opts.kind}:${opts.cid}`);
  return { topicId };
}

/** 16-byte routing tag so clients can filter a shared topic without revealing the cid. */
export function blindedTag(cid: string): string {
  const key = process.env.SHARD_TAG_KEY ?? 'agentline-shard-tag';
  return b64.enc(new Uint8Array(createHmac('sha256', key).update(cid).digest()).slice(0, 16));
}

export interface SubmitEnvelopeResult extends SubmitResult {
  msgId?: string;
  chunked: boolean;
}

/** Submit one envelope (chunking if needed) and index the result. */
export async function submitEnvelope(
  conv: ConversationRecord,
  envelope: Envelope,
  meta: { msgId?: string; sender?: string } = {},
): Promise<SubmitEnvelopeResult> {
  const payload = encodeEnvelope(envelope);
  if (payload.length > config.limits.maxChunkedBytes) {
    throw new AgentLineError('envelope_too_large',
      `envelope is ${payload.length} B; max ${config.limits.maxChunkedBytes} B — send large payloads as an encrypted blob reference`,
      { size: payload.length, limit: config.limits.maxChunkedBytes });
  }

  const chunks = chunkPayload(payload);
  let last: SubmitResult | null = null;
  const chunkGroup = meta.msgId ?? b64.enc(new Uint8Array(8));
  try {
    for (let i = 0; i < chunks.length; i++) {
      const framed = chunks.length === 1
        ? chunks[i]
        : encodeEnvelope({ ...envelope, ct: b64.enc(chunks[i]), ch: [i, chunks.length, chunkGroup] });
      last = await ledger().submit(conv.topicId, framed);
    }
  } catch (err) {
    // A failed submit means a paid message did not reach consensus — the operator has to
    // know immediately, because the caller was already charged.
    raiseAlert({
      severity: 'critical',
      kind: 'hcs.submit_failed',
      title: 'Message could not be submitted to consensus',
      detail: `Submitting to topic ${conv.topicId} failed: ${(err as Error).message}`,
      meta: { topicId: conv.topicId, cid: conv.cid, ledger: ledger().kind, bytes: payload.length },
    });
    throw new AgentLineError('chain_unavailable', `consensus submit failed: ${(err as Error).message}`);
  }

  const record: MessageRecord = {
    cid: conv.cid,
    topicId: conv.topicId,
    seq: last!.seq,
    consensusTimestamp: last!.consensusTimestamp,
    runningHash: last!.runningHash,
    envelope: b64.enc(payload),
    size: payload.length,
    msgId: meta.msgId,
    senderDeviceId: envelope.sd,
    sender: meta.sender,
    receivedAt: Date.now(),
  };
  index(conv, record);
  return { ...last!, msgId: meta.msgId, chunked: chunks.length > 1 };
}

export function index(conv: ConversationRecord, record: MessageRecord): void {
  store.messages(conv.cid).push(record);
  conv.lastSeq = record.seq;
  conv.messageCount += 1;
  store.db.conversations[conv.cid] = conv;
  store.db.stats.messagesSent += 1;
  store.save();
}

/** Notify every participant except the sender (sealed mode blinds cid and omits sender). */
export async function notifyParticipants(opts: {
  conv: ConversationRecord;
  recipients: string[];
  sender?: string;
  submit: SubmitResult;
  type: InboxNotice['t'];
  prio?: InboxNotice['prio'];
  mentions?: string[];
}): Promise<void> {
  const sealed = opts.conv.mode === 'sealed';
  await Promise.all(opts.recipients.map(async (to) => {
    if (to === opts.sender) return;
    const notice: InboxNotice = {
      v: 1,
      t: opts.mentions?.includes(to) ? 'mention' : opts.type,
      c: sealed ? inboxTag(to, opts.conv.cid) : opts.conv.cid,
      topic: opts.submit.topicId,
      seq: opts.submit.seq,
      from: sealed ? undefined : opts.sender,
      prio: opts.prio ?? 'normal',
      ts: opts.submit.consensusTimestamp,
    };
    await notify(to, notice);
  }));
}

/**
 * Per-recipient blinded conversation reference.
 *
 * Only the recipient can link this back to a cid, because it is keyed on a value derived
 * from their own inbox topic rather than on anything a third party can enumerate.
 */
export function inboxTag(agentId: string, cid: string): string {
  const agent = store.agent(agentId);
  const key = `${agent?.inboxTopic ?? agentId}|${process.env.INBOX_TAG_KEY ?? 'agentline-inbox'}`;
  return b64.enc(new Uint8Array(createHmac('sha256', key).update(cid).digest()).slice(0, 16));
}

/**
 * Backfill the index for a conversation straight from the ledger (PRD §5.5).
 * This is what makes the gateway disposable: state is re-derived, never owned.
 */
export async function reindexConversation(cid: string, opts: { limit?: number } = {}): Promise<number> {
  const conv = store.db.conversations[cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${cid}`);
  const known = new Set(store.messages(cid).map((m) => m.seq));
  const tag = conv.tag;
  const fetched = await ledger().read(conv.topicId, { afterSeq: 0, limit: opts.limit ?? 100 });
  let added = 0;
  for (const m of fetched) {
    if (known.has(m.seq)) continue;
    let env: Envelope;
    try { env = decodeEnvelope(m.contents); } catch { continue; }
    // On a shared sealed topic, keep only the envelopes tagged for this conversation.
    if (tag ? env.tag !== tag : env.cid !== cid) continue;
    store.messages(cid).push({
      cid, topicId: conv.topicId, seq: m.seq, consensusTimestamp: m.consensusTimestamp,
      runningHash: m.runningHash, envelope: b64.enc(m.contents), size: m.contents.length,
      senderDeviceId: env.sd, receivedAt: Date.now(), chunk: env.ch,
    });
    added += 1;
  }
  store.messages(cid).sort((a, b) => a.seq - b.seq);
  conv.lastSeq = Math.max(conv.lastSeq, ...store.messages(cid).map((m) => m.seq), 0);
  store.save();
  return added;
}

/** Consensus proof bundle for an indexed message (PRD §11 /v1/proofs). */
export async function proofFor(topicId: string, seq: number): Promise<{
  topicId: string; seq: number; consensusTimestamp: string; runningHash: string;
  payloadSha256: string; source: string; mirrorUrl?: string;
}> {
  const msg = await ledger().get(topicId, seq);
  if (!msg) throw new AgentLineError('not_found', `no message at ${topicId}#${seq}`);
  const { createHash } = await import('node:crypto');
  return {
    topicId, seq, consensusTimestamp: msg.consensusTimestamp, runningHash: msg.runningHash,
    payloadSha256: createHash('sha256').update(msg.contents).digest('hex'),
    source: ledger().kind,
    mirrorUrl: ledger().kind === 'hedera'
      ? `${config.hedera.mirrorRest}/api/v1/topics/${topicId}/messages/${seq}`
      : undefined,
  };
}

export { utf8 };
