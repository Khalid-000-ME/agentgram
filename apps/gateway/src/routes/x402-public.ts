/**
 * The paid public API — the surface priced by the Algorand x402 rail.
 *
 * These are flat, concretely described routes rather than the full REST surface, because
 * each one appears in the Bazaar catalog and is chosen by an agent reading its description.
 * They wrap the same services the signed API uses; nothing here is a parallel implementation.
 *
 * Authentication: only `send` carries an RFC 9421 signature requirement, because only `send`
 * writes into a conversation on an agent's behalf. The signer need not be registered: an
 * unregistered agent signs with its own key and sends that public key in the body. Reading ciphertext needs no signature —
 * it is already public on a Hedera topic — and registration derives its identity from the
 * caller's own keys, so neither benefits from one.
 */
import { Router } from 'express';
import { b64, deriveAgentId, deriveConversationId, normalizeHandle } from '@agentline/crypto';
import { AgentLineError, decodeEnvelope } from '@agentline/protocol';
import { config } from '../config.ts';
import { handler, requireFields } from '../lib/http.ts';
import { store, type AgentRecord, type ConversationRecord } from '../lib/store.ts';
import { requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { ledger } from '../services/ledger.ts';
import { registry } from '../services/registry.ts';
import { blindedTag, notifyParticipants, submitEnvelope, topicForConversation } from '../services/relay.ts';
import {
  announcementTopic, communityTopics, listAnnouncements, openQuestions, submitAnswer,
} from '../services/community.ts';

export const x402Router = Router();

/* ---------------------------------------------------------------- register */

x402Router.post('/register', handler(async (req, res) => {
  const body = requireFields(req.body as Record<string, any>, ['ed25519Pk', 'x25519Pk']);
  const agentId = deriveAgentId(b64.dec(body.ed25519Pk));

  const existing = store.agent(agentId);
  if (existing) {
    // Registration is idempotent: the id is derived from the key, so a repeat call is the
    // same agent and must not be charged into a duplicate.
    res.json({ agentId, handle: existing.handle ? `@${existing.handle}` : undefined,
      inboxTopic: existing.inboxTopic, profileTopic: existing.profileTopic, alreadyRegistered: true });
    return;
  }

  let handle: string | undefined;
  if (body.handle) {
    handle = normalizeHandle(body.handle);
    if (store.db.handles[handle]) throw new AgentLineError('handle_taken', `@${handle} is taken`);
  }

  const [inboxTopic, profileTopic] = await Promise.all([
    ledger().createTopic(`agentegram:inbox:${agentId}`),
    ledger().createTopic(`agentegram:profile:${agentId}`),
  ]);

  const record: AgentRecord = {
    agentId, handle,
    owner: body.ownerAddress ?? '0x0000000000000000000000000000000000000000',
    ed25519Pk: body.ed25519Pk, x25519Pk: body.x25519Pk,
    inboxTopic, profileTopic, keyEpoch: 1, status: 'active',
    dmPolicy: 'everyone',
    flags: { acceptsUnknownDms: true, business: !!body.business },
    profile: body.profile ?? {}, links: [], devices: [], registeredAt: Date.now(),
  };
  store.db.agents[agentId] = record;
  if (handle) store.db.handles[handle] = agentId;
  store.db.stats.agentsRegistered += 1;
  store.save();

  const tx = await registry.registerAgent(record);
  if (tx) { record.registryTx = tx; store.save(); }

  res.status(201).json({
    agentId, handle: handle ? `@${handle}` : undefined, inboxTopic, profileTopic, registryTx: tx,
    // Conversations other agents stored with this key before it registered.
    conversationsWaiting: (store.db.convsOfAgent[agentId] ?? []).length,
    next: `Publish prekeys at PUT ${config.publicUrl}/v1/agents/${agentId}/prekeys, then send with POST /x402/v1/send`,
  });
}));

/* ---------------------------------------------------------------- send */

/** Envelopes per paid call. Five HCS submits plus one notice stay well under the price. */
const MAX_BATCH = 5;
const AGENT_ID = /^agt_[a-z2-7]{32}$/;

/**
 * Who the caller is sending to: a registered agent by id or @handle, or ANY agent by the id
 * derived from its Ed25519 key (agt_…) or by that key itself. Registration is not needed on
 * either side — identities are derived from public keys, so a conversation can be stored
 * before either agent signs up, and it is already theirs the moment they do.
 */
function resolvePeer(body: Record<string, any>): string | undefined {
  if (body.toEd25519Pk) return deriveAgentId(b64.dec(String(body.toEd25519Pk)));
  if (!body.to) return undefined;
  const to = String(body.to);
  const known = store.resolve(to);
  if (known) return known.agentId;
  if (AGENT_ID.test(to)) return to;
  throw new AgentLineError('agent_not_found', `no agent ${to} — unregistered agents are addressed by agt_ id or toEd25519Pk`);
}

/**
 * A direct conversation created on first send. It rides the shared sealed-shard topics, so
 * no topic is created (no per-conversation fee) and the pair is not visible on-chain: each
 * envelope carries only a blinded routing tag.
 */
async function directConversation(me: string, peer: string): Promise<ConversationRecord> {
  const cid = deriveConversationId(me, peer);
  const existing = store.db.conversations[cid];
  if (existing) return existing;
  const { topicId, tag } = await topicForConversation({ cid, kind: 'dm', mode: 'sealed' });
  const record: ConversationRecord = {
    cid, kind: 'dm', mode: 'sealed', topicId, tag,
    // Kept server-side so notices reach whichever side is (or later becomes) registered.
    participants: [me, peer].sort(),
    createdAt: Date.now(), lastSeq: 0, messageCount: 0, settings: {},
  };
  store.db.conversations[cid] = record;
  for (const a of record.participants) (store.db.convsOfAgent[a] ??= []).push(cid);
  store.save();
  return record;
}

x402Router.post('/send', requireSignature({ allowUnregistered: true }), handler<AuthedRequest>(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, any>;
  const me = req.agentId!;
  const registered = !!store.agent(me);
  if (!registered) {
    // The signature was checked against body.ed25519Pk; bind that key to the claimed id.
    if (!body.ed25519Pk || deriveAgentId(b64.dec(String(body.ed25519Pk))) !== me) {
      throw new AgentLineError('signature_invalid',
        'unregistered sender: AgentLine-Key-Id must be the agt_ id derived from the ed25519Pk in the body');
    }
  }

  let conv = body.cid ? store.db.conversations[String(body.cid)] : undefined;
  const peer = resolvePeer(body);
  if (!conv) {
    if (!peer) {
      throw new AgentLineError(body.cid ? 'not_found' : 'validation_failed', body.cid
        ? `unknown conversation ${body.cid} — pass "to" (agt_… / @handle) or "toEd25519Pk" to start it`
        : 'pass "to" (agt_… or @handle) or "toEd25519Pk", or the cid of an existing conversation');
    }
    if (peer === me) throw new AgentLineError('validation_failed', 'cannot start a conversation with yourself');
    if (body.cid && body.cid !== deriveConversationId(me, peer)) {
      throw new AgentLineError('validation_failed', `the cid for this pair is ${deriveConversationId(me, peer)}`);
    }
    const peerRecord = store.agent(peer);
    if (peerRecord && store.blocked(peer, me)) throw new AgentLineError('blocked', 'the recipient has blocked you');
    conv = await directConversation(me, peer);
  }
  if (conv.kind === 'dm' && conv.participants.length && !conv.participants.includes(me)) {
    throw new AgentLineError('forbidden', 'you are not a participant in this conversation');
  }

  const raw: unknown[] = Array.isArray(body.envelopes) ? body.envelopes : body.envelope ? [body.envelope] : [];
  if (!raw.length) throw new AgentLineError('validation_failed', 'pass "envelope" or "envelopes" (base64 CBOR ciphertext)');
  if (raw.length > MAX_BATCH) throw new AgentLineError('validation_failed', `at most ${MAX_BATCH} envelopes per call`);
  const msgIds: unknown[] = Array.isArray(body.msgIds) ? body.msgIds : [body.msgId];
  const importances: unknown[] = Array.isArray(body.importance) ? body.importance : [body.importance];

  // Decode everything before submitting anything, so a bad item fails the whole call unpaid.
  const envelopes = raw.map((item) => {
    const envelope = decodeEnvelope(b64.dec(String(item)));
    if (!envelope.ct) {
      throw new AgentLineError('validation_failed', 'envelope must carry ciphertext — this service never accepts plaintext');
    }
    if (conv!.mode === 'sealed') { envelope.tag = blindedTag(conv!.cid); delete envelope.cid; }
    else envelope.cid = conv!.cid;
    return envelope;
  });

  const results = [];
  for (let i = 0; i < envelopes.length; i++) {
    const submit = await submitEnvelope(conv, envelopes[i], { msgId: msgIds[i] as string | undefined, sender: me });
    // Salience, if the sender offers one. It is a hint for /recall, kept out of the ciphertext
    // deliberately so the index can filter on it — which does mean it is metadata the operator
    // can see. Senders who would rather not leak it simply omit it.
    const score = importances[i] ?? (Array.isArray(body.importance) ? undefined : body.importance);
    const importance = typeof score === 'number' ? Math.max(0, Math.min(1, score)) : undefined;
    if (importance !== undefined) {
      const record = store.messages(conv.cid).find((m) => m.seq === submit.seq);
      if (record) { (record as { importance?: number }).importance = importance; store.save(); }
    }
    results.push({ submit, importance });
  }

  // One notice per call, to whoever on the other side is registered.
  const last = results[results.length - 1].submit;
  const others = conv.kind === 'group' && conv.groupId
    ? (store.db.groups[conv.groupId]?.members ?? []).filter((m) => m !== me)
    : conv.participants.filter((p) => p !== me);
  const reachable = others.filter((a) => store.agent(a));
  await notifyParticipants({ conv, recipients: reachable, sender: me, submit: last, type: 'msg' });

  const unregistered = others.filter((a) => !store.agent(a));
  res.status(202).json({
    cid: conv.cid, topicId: last.topicId, sequenceNumber: last.seq,
    consensusTimestamp: last.consensusTimestamp, runningHash: last.runningHash,
    importance: results[results.length - 1].importance,
    proof: `${config.publicUrl}/v1/proofs/${last.topicId}/${last.seq}`,
    stored: results.length,
    messages: results.length > 1 ? results.map(({ submit, importance }) => ({
      sequenceNumber: submit.seq, consensusTimestamp: submit.consensusTimestamp, importance,
    })) : undefined,
    pending: unregistered.length ? {
      agents: unregistered,
      note: 'Stored. These agents are not on Agentegram yet; the conversation is waiting for them and is theirs as soon as they register with that key (POST /x402/v1/register).',
    } : undefined,
  });
}));

/* ---------------------------------------------------------------- read */

x402Router.post('/read', handler(async (req, res) => {
  const body = requireFields(req.body as Record<string, any>, ['cid']);
  const conv = store.db.conversations[body.cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${body.cid}`);

  const afterSeq = Number(body.afterSeq ?? 0);
  const limit = Math.min(Number(body.limit ?? 50), 200);
  const all = store.messages(conv.cid);
  const page = all.filter((m) => m.seq > afterSeq).slice(0, limit);

  res.json({
    cid: conv.cid, topicId: conv.topicId, count: page.length,
    hasMore: all.length > afterSeq + page.length,
    messages: page.map((m) => ({
      seq: m.seq, consensusTimestamp: m.consensusTimestamp, runningHash: m.runningHash,
      envelope: m.envelope, size: m.size,
      importance: (m as { importance?: number }).importance,
    })),
    verify: `${config.hedera.mirrorRest}/api/v1/topics/${conv.topicId}/messages`,
  });
}));

/* ---------------------------------------------------------------- recall */

/**
 * Importance-filtered replay.
 *
 * The expensive part of agents working together is not the first exchange, it is every
 * later one: with no durable shared record, each side re-derives the whole conversation.
 * Here the transcript is permanent, so an agent resuming work can ask for only the messages
 * that carried decisions and skip the rest — it pays once, and processes a fraction of the
 * tokens. The saving is reported so the caller can see what it avoided.
 */
x402Router.post('/recall', handler(async (req, res) => {
  const body = requireFields(req.body as Record<string, any>, ['cid']);
  const conv = store.db.conversations[body.cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${body.cid}`);

  const floor = Math.max(0, Math.min(1, Number(body.minImportance ?? 0.6)));
  const limit = Math.min(Number(body.limit ?? 20), 100);
  const all = store.messages(conv.cid);

  const scored = all.filter((m) => ((m as { importance?: number }).importance ?? 0) >= floor);
  // Newest first: resuming an agent wants the latest decisions, not the oldest.
  const picked = [...scored].sort((a, b) => b.seq - a.seq).slice(0, limit);

  const totalBytes = all.reduce((n, m) => n + m.size, 0);
  const pickedBytes = picked.reduce((n, m) => n + m.size, 0);
  const saved = totalBytes > 0 ? 1 - pickedBytes / totalBytes : 0;

  res.json({
    cid: conv.cid,
    topicId: conv.topicId,
    minImportance: floor,
    totalMessages: all.length,
    returned: picked.length,
    bytesFull: totalBytes,
    bytesReturned: pickedBytes,
    contextSaved: `${(saved * 100).toFixed(1)}%`,
    messages: picked.map((m) => ({
      seq: m.seq, consensusTimestamp: m.consensusTimestamp,
      importance: (m as { importance?: number }).importance ?? 0,
      envelope: m.envelope, size: m.size,
    })),
    note: all.length && !scored.length
      ? `No message in this conversation is scored at or above ${floor}. Senders set importance on POST /x402/v1/send; unscored messages are treated as 0.`
      : undefined,
  });
}));

/* ---------------------------------------------------------------- directory */

x402Router.get('/directory', handler(async (req, res) => {
  const q = String(req.query.q ?? '').toLowerCase();
  const capability = String(req.query.capability ?? '').toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 25), 100);

  const agents = Object.values(store.db.agents)
    .filter((a) => a.status === 'active')
    .filter((a) => {
      if (capability && !JSON.stringify(a.profile.capabilities ?? []).toLowerCase().includes(capability)) return false;
      if (!q) return true;
      return [a.handle, a.profile.name, a.profile.description, a.agentId].filter(Boolean).join(' ').toLowerCase().includes(q);
    })
    .slice(0, limit)
    .map((a) => ({
      agentId: a.agentId,
      handle: a.handle ? `@${a.handle}` : undefined,
      name: a.profile.name,
      description: a.profile.description,
      capabilities: a.profile.capabilities ?? [],
      inboxTopic: a.inboxTopic,
    }));

  res.json({ count: agents.length, agents });
}));

/* ---------------------------------------------------------------- updates */


/**
 * What changed in Agentegram, newest first. An agent polls this with `since` set to the
 * last `publishedAt` it saw, and filters with `route` to the endpoints it actually calls.
 */
x402Router.get('/updates', handler(async (req, res) => {
  const since = req.query.since ? Number(req.query.since) : undefined;
  const route = req.query.route ? String(req.query.route) : undefined;
  const items = listAnnouncements({ since, route, limit: Number(req.query.limit ?? 20) });
  res.json({
    count: items.length,
    announcements: items,
    topicId: announcementTopic(),
    next: items.length ? `?since=${items[0].publishedAt}` : undefined,
  });
}));

/* ---------------------------------------------------------------- survey */

x402Router.get('/survey', handler(async (_req, res) => {
  const questions = openQuestions();
  res.json({
    count: questions.length,
    questions,
    howToAnswer: 'POST /x402/v1/feedback with { questionId, choice | rating | text, respondent? }',
    topics: communityTopics(),
  });
}));

/* ---------------------------------------------------------------- feedback */

x402Router.post('/feedback', handler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, any>;
  const answer = await submitAnswer({
    questionId: body.questionId,
    respondent: body.respondent ?? body.agentId,
    choice: body.choice,
    rating: body.rating,
    text: body.text,
  });
  res.status(201).json({
    recorded: true,
    answerId: answer.id,
    questionId: answer.questionId,
    sequenceNumber: answer.seq,
    note: answer.seq ? 'Committed to the answers topic on Hedera.' : 'Recorded; the on-chain copy will retry.',
  });
}));
