/**
 * Conversations and messages.
 *
 * The gateway validates, prices, relays and indexes — it never decrypts. Every message
 * body reaching these handlers is an opaque ciphertext envelope; the only fields the
 * gateway reads are routing metadata it is allowed to see.
 */
import { Router } from 'express';
import { b64, deriveConversationId } from '@agentline/crypto';
import {
  AgentLineError, decodeEnvelope, fromAtomic, type Envelope,
} from '@agentline/protocol';
import { config } from '../config.ts';
import { handler, ok, replayIfKnown, requireFields } from '../lib/http.ts';
import { store, type ConversationRecord } from '../lib/store.ts';
import { rateLimit, requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { requirePayment } from '../middleware/x402.ts';
import {
  blindedTag, notifyParticipants, proofFor, reindexConversation, submitEnvelope, topicForConversation,
} from '../services/relay.ts';
import { registry } from '../services/registry.ts';

export const conversationsRouter = Router();

/** Who may DM whom. */
function checkDmPolicy(from: string, to: string): { firstContact: boolean } {
  const recipient = store.agent(to);
  if (!recipient) throw new AgentLineError('agent_not_found', `no agent ${to}`);
  if (recipient.status !== 'active') throw new AgentLineError('agent_not_found', `agent ${to} is ${recipient.status}`);
  if (store.blocked(to, from)) throw new AgentLineError('blocked', 'the recipient has blocked you');
  if (store.blocked(from, to)) throw new AgentLineError('blocked', 'you have blocked this recipient');

  const known = store.isContact(to, from);
  switch (recipient.dmPolicy) {
    case 'contacts':
      if (!known) throw new AgentLineError('dm_policy_denied', `${to} only accepts messages from existing contacts`);
      break;
    case 'allowlist':
      if (!(recipient.allowlist ?? []).includes(from)) {
        throw new AgentLineError('dm_policy_denied', `${to} only accepts messages from its allowlist`);
      }
      break;
    case 'paid_only':
    case 'everyone':
    default:
      break;
  }
  return { firstContact: !known };
}

function conversationView(c: ConversationRecord, viewer?: string) {
  return {
    cid: c.cid,
    kind: c.kind,
    mode: c.mode,
    topicId: c.topicId,
    tag: c.tag,
    participants: c.mode === 'open' ? c.participants : undefined,
    groupId: c.groupId,
    channelId: c.channelId,
    lastSeq: c.lastSeq,
    messageCount: c.messageCount,
    settings: c.settings,
    createdAt: c.createdAt,
    registryTx: c.registryTx,
    unread: viewer ? unreadFor(c, viewer) : undefined,
  };
}

const lastRead = new Map<string, number>();

function unreadFor(c: ConversationRecord, viewer: string): number {
  const seen = lastRead.get(`${viewer}|${c.cid}`) ?? 0;
  return Math.max(0, c.lastSeq - seen);
}

/* -------------------------------------------------------------- POST /v1/conversations */

conversationsRouter.post(
  '/conversations',
  requirePayment((req) => ({ routeKey: 'POST /v1/conversations', agentId: req.headers['agentline-key-id'] as string })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    if (replayIfKnown(req, res)) return;
    const body = requireFields(req.body as Record<string, any>, ['peerAgentId']);
    const me = req.agentId!;
    const peerRef = String(body.peerAgentId);
    const peer = store.resolve(peerRef);
    if (!peer) throw new AgentLineError('agent_not_found', `no agent ${peerRef}`);

    const mode: 'open' | 'sealed' = body.mode === 'open' ? 'open' : 'sealed';
    checkDmPolicy(me, peer.agentId);

    // In sealed mode the client derives the cid with a salt it never reveals to us; we
    // accept the client-supplied cid and can only see an opaque identifier.
    const cid = mode === 'open'
      ? deriveConversationId(me, peer.agentId)
      : (body.cid as string | undefined);
    if (!cid) {
      throw new AgentLineError('validation_failed',
        'sealed conversations require a client-derived cid (keccak over the sorted agent ids plus your private convSalt)');
    }
    if (mode === 'open' && body.cid && body.cid !== cid) {
      throw new AgentLineError('validation_failed', `open-mode cid must be ${cid}`);
    }

    const existing = store.db.conversations[cid];
    if (existing) {
      ok(req, res, 200, { ...conversationView(existing, me), alreadyOpen: true });
      return;
    }

    const { topicId, tag } = await topicForConversation({ cid, kind: 'dm', mode });
    const record: ConversationRecord = {
      cid, kind: 'dm', mode, topicId, tag,
      participants: mode === 'open' ? [me, peer.agentId].sort() : [],
      createdAt: Date.now(), lastSeq: 0, messageCount: 0,
      settings: body.disappearAfter ? { disappearAfter: Number(body.disappearAfter) } : {},
    };
    store.db.conversations[cid] = record;
    if (mode === 'open') {
      for (const p of record.participants) (store.db.convsOfAgent[p] ??= []).push(cid);
    } else {
      // Sealed: we still need to route notices, so keep the pair privately, server-side
      // only, and never publish it on-chain or in any API response.
      (store.db.convsOfAgent[me] ??= []).push(cid);
      (store.db.convsOfAgent[peer.agentId] ??= []).push(cid);
    }
    store.save();

    const tx = await registry.openConversation({
      cid, a: me, b: peer.agentId, topicId, kind: 0, mode, tag,
    });
    if (tx) { record.registryTx = tx; store.save(); }

    ok(req, res, 201, {
      ...conversationView(record, me),
      peer: { agentId: peer.agentId, handle: peer.handle ? `@${peer.handle}` : undefined, inboxTopic: peer.inboxTopic },
      hint: mode === 'sealed'
        ? 'Sealed mode: participants are not published on-chain. Keep convSalt in your encrypted personal index or you cannot re-derive this cid.'
        : 'Open mode: the cid is derivable by anyone from both agent ids.',
    });
  }),
);

/* -------------------------------------------------------------- GET /v1/conversations */

conversationsRouter.get('/conversations', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  const cids = store.db.convsOfAgent[me] ?? [];
  const list = cids
    .map((cid) => store.db.conversations[cid])
    .filter(Boolean)
    .map((c) => conversationView(c, me));
  res.json({ count: list.length, conversations: list });
}));

conversationsRouter.get('/conversations/:cid', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const conv = store.db.conversations[req.params.cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${req.params.cid}`);
  assertMember(conv, req.agentId!);
  res.json(conversationView(conv, req.agentId!));
}));

function assertMember(conv: ConversationRecord, agentId: string): void {
  const routed = store.db.convsOfAgent[agentId] ?? [];
  if (routed.includes(conv.cid)) return;
  if (conv.participants.includes(agentId)) return;
  if (conv.groupId && store.db.groups[conv.groupId]?.members.includes(agentId)) return;
  if (conv.channelId && store.db.channels[conv.channelId]?.owner === agentId) return;
  throw new AgentLineError('forbidden', 'you are not a participant in this conversation');
}

/* -------------------------------------------------------------- send a message */

function envelopeFrom(body: Record<string, any>): { envelope: Envelope; bytes: number } {
  const raw = body.envelope;
  if (!raw) throw new AgentLineError('validation_failed', 'envelope is required');
  let envelope: Envelope;
  if (typeof raw === 'string') {
    const bytes = b64.dec(raw);
    envelope = decodeEnvelope(bytes);
    return { envelope, bytes: bytes.length };
  }
  envelope = raw as Envelope;
  if (envelope.v !== 1) throw new AgentLineError('validation_failed', 'envelope.v must be 1');
  if (typeof envelope.ct !== 'string' || !envelope.ct) {
    throw new AgentLineError('validation_failed', 'envelope.ct (ciphertext) is required — the gateway never accepts plaintext');
  }
  return { envelope, bytes: Buffer.byteLength(JSON.stringify(envelope)) };
}

conversationsRouter.post(
  '/conversations/:cid/messages',
  rateLimit(config.limits.rateLimitPerMinute, (req) => (req.headers['agentline-key-id'] as string) ?? req.ip ?? 'anon'),
  requirePayment((req) => {
    const cid = req.params.cid;
    const conv = store.db.conversations[cid];
    const me = req.headers['agentline-key-id'] as string | undefined;
    const bytes = Number(req.headers['content-length'] ?? 0);
    // First contact costs more (anti-spam stamp); a business agent may sponsor it. The
    // stamp is per conversation, not per message: it exists to price out cold-outreach
    // spam, not to tax an ongoing exchange.
    const recipients = recipientsOf(conv, me);
    const alreadySpoke = !!conv && store.messages(cid).some((m) => m.sender === me);
    const firstContact = !!me && !alreadySpoke && recipients.some((r) => !store.isContact(r, me));
    const sponsor = recipients.map((r) => store.agent(r)).find((a) => a?.sponsorInbound)?.agentId;
    if (conv?.kind === 'group') {
      return { routeKey: 'POST /v1/groups/messages', members: recipients.length + 1, agentId: me, bytes };
    }
    return {
      routeKey: firstContact ? 'POST /v1/messages:first-contact' : 'POST /v1/messages',
      bytes, agentId: me, sponsorAgentId: sponsor,
    };
  }),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    if (replayIfKnown(req, res)) return;
    const me = req.agentId!;
    const conv = store.db.conversations[req.params.cid];
    if (!conv) throw new AgentLineError('not_found', `unknown conversation ${req.params.cid} — open it first`);
    assertMember(conv, me);

    const body = req.body as Record<string, any>;
    const { envelope, bytes } = envelopeFrom(body);
    if (bytes > config.limits.maxChunkedBytes) {
      throw new AgentLineError('envelope_too_large',
        `envelope is ${bytes} B; inline limit is ${config.limits.maxEnvelopeBytes} B and chunked limit ${config.limits.maxChunkedBytes} B. Larger payloads: upload an encrypted blob and send its reference inside the ciphertext.`);
    }

    // Routing consistency: sealed conversations must carry the blinded tag, open ones the cid.
    if (conv.mode === 'sealed') {
      if (!envelope.tag) envelope.tag = blindedTag(conv.cid);
      delete envelope.cid;
    } else {
      envelope.cid = conv.cid;
    }

    const recipients = recipientsOf(conv, me);
    for (const to of recipients) {
      if (conv.kind === 'dm') checkDmPolicy(me, to);
      else if (store.blocked(to, me)) throw new AgentLineError('blocked', `${to} has blocked you`);
    }

    const group = conv.groupId ? store.db.groups[conv.groupId] : undefined;
    if (group?.settings.onlyAdminsSend && !group.admins.includes(me)) {
      throw new AgentLineError('forbidden', 'this group is announcements-only; only admins can send');
    }

    const submit = await submitEnvelope(conv, envelope, { msgId: body.msgId, sender: me });

    // Message requests: a first contact lands in the recipient's Requests queue.
    for (const to of recipients) {
      if (conv.kind === 'dm' && !store.isContact(to, me)) {
        const key = `${to}|${conv.cid}`;
        if (!store.db.requests[key]) {
          store.db.requests[key] = {
            cid: conv.cid, from: me, to, firstSeq: submit.seq, createdAt: Date.now(), state: 'pending',
          };
          store.save();
        }
      }
    }
    store.addContact(me, recipients[0] ?? me);

    await notifyParticipants({
      conv, recipients, sender: me, submit,
      type: 'msg',
      prio: body.priority === 'low' ? 'low' : 'normal',
      mentions: Array.isArray(body.mentions) ? body.mentions : undefined,
    });

    ok(req, res, 202, {
      msgId: body.msgId,
      cid: conv.cid,
      topicId: submit.topicId,
      sequenceNumber: submit.seq,
      consensusTimestamp: submit.consensusTimestamp,
      runningHash: submit.runningHash,
      chunked: submit.chunked,
      size: bytes,
      payment: req.payment
        ? { method: req.payment.method, amount: fromAtomic(req.payment.atomic), route: req.payment.routeKey, txHash: req.payment.txHash }
        : undefined,
      proof: `${config.publicUrl}/v1/proofs/${submit.topicId}/${submit.seq}`,
    });
  }),
);

function recipientsOf(conv: ConversationRecord | undefined, me: string | undefined): string[] {
  if (!conv || !me) return [];
  if (conv.kind === 'group' && conv.groupId) {
    return (store.db.groups[conv.groupId]?.members ?? []).filter((m) => m !== me);
  }
  if (conv.kind === 'channel' && conv.channelId) {
    return store.db.channels[conv.channelId]?.followers ?? [];
  }
  if (conv.participants.length) return conv.participants.filter((p) => p !== me);
  // Sealed DM: participants are not public, but we hold the private routing pair.
  return Object.entries(store.db.convsOfAgent)
    .filter(([agentId, cids]) => agentId !== me && cids.includes(conv.cid))
    .map(([agentId]) => agentId);
}

/* -------------------------------------------------------------- read messages */

conversationsRouter.get(
  '/conversations/:cid/messages',
  requirePayment((req) => ({ routeKey: 'GET /v1/messages', agentId: req.headers['agentline-key-id'] as string })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const conv = store.db.conversations[req.params.cid];
    if (!conv) throw new AgentLineError('not_found', `unknown conversation ${req.params.cid}`);
    assertMember(conv, req.agentId!);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    if (req.query.reindex === 'true') await reindexConversation(conv.cid, { limit: 200 });

    const all = store.messages(conv.cid);
    const page = all.filter((m) => m.seq > afterSeq).slice(0, limit);

    res.json({
      cid: conv.cid,
      topicId: conv.topicId,
      mode: conv.mode,
      count: page.length,
      hasMore: all.some((m) => m.seq > (page.at(-1)?.seq ?? afterSeq)),
      // Ciphertext only: decrypting is the client's job and the client's alone.
      messages: page.map((m) => ({
        seq: m.seq,
        consensusTimestamp: m.consensusTimestamp,
        runningHash: m.runningHash,
        envelope: m.envelope,
        size: m.size,
        senderDeviceId: m.senderDeviceId,
        msgId: m.msgId,
      })),
      verify: {
        note: 'Every message carries its HCS topic, sequence number, consensus timestamp and running hash so you can verify it against a mirror node without trusting this gateway.',
        mirror: `${config.hedera.mirrorRest}/api/v1/topics/${conv.topicId}/messages`,
      },
    });
  }),
);

/* -------------------------------------------------------------- receipts */

conversationsRouter.post(
  '/conversations/:cid/receipts',
  requirePayment((req) => ({ routeKey: 'POST /v1/receipts', agentId: req.headers['agentline-key-id'] as string })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const conv = store.db.conversations[req.params.cid];
    if (!conv) throw new AgentLineError('not_found', `unknown conversation ${req.params.cid}`);
    const me = req.agentId!;
    assertMember(conv, me);
    const body = requireFields(req.body as Record<string, any>, ['envelope']);

    // Receipts are themselves encrypted messages — the gateway learns only "a receipt
    // happened", never which message or what state.
    const { envelope } = envelopeFrom(body);
    if (conv.mode === 'sealed') { envelope.tag = blindedTag(conv.cid); delete envelope.cid; }
    else envelope.cid = conv.cid;

    const submit = await submitEnvelope(conv, envelope, { sender: me });
    lastRead.set(`${me}|${conv.cid}`, Math.max(lastRead.get(`${me}|${conv.cid}`) ?? 0, Number(body.upTo ?? conv.lastSeq)));

    const recipients = recipientsOf(conv, me).filter((r) => !store.agent(r)?.flags.receiptsOff);
    await notifyParticipants({ conv, recipients, sender: me, submit, type: 'receipt', prio: 'low' });

    res.status(202).json({ cid: conv.cid, sequenceNumber: submit.seq, consensusTimestamp: submit.consensusTimestamp });
  }),
);

/* -------------------------------------------------------------- settings */

conversationsRouter.patch('/conversations/:cid/settings', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const conv = store.db.conversations[req.params.cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${req.params.cid}`);
  assertMember(conv, req.agentId!);
  const body = (req.body ?? {}) as Record<string, any>;
  if (body.disappearAfter !== undefined) {
    conv.settings.disappearAfter = body.disappearAfter === null ? undefined : Number(body.disappearAfter);
  }
  store.save();
  res.json({
    cid: conv.cid, settings: conv.settings,
    note: conv.settings.disappearAfter
      ? 'Disappearing messages are enforced by both clients shredding message keys on expiry; on-chain ciphertext remains but becomes unreadable.'
      : undefined,
  });
}));

/* -------------------------------------------------------------- proofs */

conversationsRouter.get('/proofs/:topicId/:seq', handler(async (req, res) => {
  res.json(await proofFor(req.params.topicId, Number(req.params.seq)));
}));

/* -------------------------------------------------------------- encrypted personal index */

conversationsRouter.put('/personal-index', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const body = requireFields(req.body as Record<string, any>, ['blob']);
  if (typeof body.blob !== 'string' || body.blob.length > 4 * 1024 * 1024) {
    throw new AgentLineError('validation_failed', 'blob must be a base64 string under 4 MiB');
  }
  store.db.personalIndex[req.agentId!] = { blob: body.blob, updatedAt: Date.now() };
  store.save();
  res.json({ agentId: req.agentId, updatedAt: store.db.personalIndex[req.agentId!].updatedAt, bytes: body.blob.length });
}));

conversationsRouter.get('/personal-index', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const entry = store.db.personalIndex[req.agentId!];
  if (!entry) throw new AgentLineError('not_found', 'no personal index stored yet');
  res.json({ agentId: req.agentId, ...entry });
}));

export { checkDmPolicy, recipientsOf, conversationView, assertMember, envelopeFrom, lastRead };
