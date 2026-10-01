/**
 * The paid public API — the surface priced by the Algorand x402 rail.
 *
 * These are flat, concretely described routes rather than the full REST surface, because
 * each one appears in the Bazaar catalog and is chosen by an agent reading its description.
 * They wrap the same services the signed API uses; nothing here is a parallel implementation.
 *
 * Authentication: only `send` carries an RFC 9421 signature requirement, because only `send`
 * writes into a conversation on an agent's behalf. Reading ciphertext needs no signature —
 * it is already public on a Hedera topic — and registration derives its identity from the
 * caller's own keys, so neither benefits from one.
 */
import { Router } from 'express';
import { b64, deriveAgentId, normalizeHandle } from '@agentline/crypto';
import { AgentLineError, decodeEnvelope } from '@agentline/protocol';
import { config } from '../config.ts';
import { handler, requireFields } from '../lib/http.ts';
import { store, type AgentRecord } from '../lib/store.ts';
import { requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { ledger } from '../services/ledger.ts';
import { registry } from '../services/registry.ts';
import { blindedTag, notifyParticipants, submitEnvelope } from '../services/relay.ts';

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
    ledger().createTopic(`agentgram:inbox:${agentId}`),
    ledger().createTopic(`agentgram:profile:${agentId}`),
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
    next: `Publish prekeys at PUT ${config.publicUrl}/v1/agents/${agentId}/prekeys, then send with POST /x402/v1/send`,
  });
}));

/* ---------------------------------------------------------------- send */

x402Router.post('/send', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const body = requireFields(req.body as Record<string, any>, ['cid', 'envelope']);
  const conv = store.db.conversations[body.cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${body.cid} — open it first`);

  const bytes = b64.dec(body.envelope);
  const envelope = decodeEnvelope(bytes);
  if (!envelope.ct) {
    throw new AgentLineError('validation_failed', 'envelope must carry ciphertext — this service never accepts plaintext');
  }
  if (conv.mode === 'sealed') { envelope.tag = blindedTag(conv.cid); delete envelope.cid; }
  else envelope.cid = conv.cid;

  const me = req.agentId!;
  const submit = await submitEnvelope(conv, envelope, { msgId: body.msgId, sender: me });

  // Salience, if the sender offers one. It is a hint for /recall, kept out of the ciphertext
  // deliberately so the index can filter on it — which does mean it is metadata the operator
  // can see. Senders who would rather not leak it simply omit it.
  const importance = typeof body.importance === 'number'
    ? Math.max(0, Math.min(1, body.importance))
    : undefined;
  if (importance !== undefined) {
    const record = store.messages(conv.cid).find((m) => m.seq === submit.seq);
    if (record) { (record as { importance?: number }).importance = importance; store.save(); }
  }

  const recipients = conv.kind === 'group' && conv.groupId
    ? (store.db.groups[conv.groupId]?.members ?? []).filter((m) => m !== me)
    : conv.participants.filter((p) => p !== me);
  await notifyParticipants({ conv, recipients, sender: me, submit, type: 'msg' });

  res.status(202).json({
    cid: conv.cid, topicId: submit.topicId, sequenceNumber: submit.seq,
    consensusTimestamp: submit.consensusTimestamp, runningHash: submit.runningHash,
    importance,
    proof: `${config.publicUrl}/v1/proofs/${submit.topicId}/${submit.seq}`,
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
