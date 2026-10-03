/**
 * Message requests, blocking and franked abuse reports.
 *
 * Reporting is the one place content can reach us — and only because the *recipient*
 * chooses to reveal it along with the franking key, which lets us prove the sender really
 * sent that body. Unreported messages stay opaque.
 */
import { Router } from 'express';
import { randomId, utf8, verifyFrankingJson } from '@agentline/crypto';
import { AgentLineError, decodeEnvelope } from '@agentline/protocol';
import { handler, requireFields } from '../lib/http.ts';
import { store, type ReportRecord } from '../lib/store.ts';
import { requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { b64 } from '@agentline/crypto';

export const safetyRouter = Router();

/* -------------------------------------------------------------- message requests */

safetyRouter.get('/requests', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  const items = Object.values(store.db.requests)
    .filter((r) => r.to === me && r.state === 'pending')
    .map((r) => ({
      cid: r.cid, from: r.from, firstSeq: r.firstSeq, createdAt: r.createdAt,
      fromProfile: store.agent(r.from)?.profile,
    }));
  res.json({ count: items.length, requests: items });
}));

for (const action of ['accept', 'decline'] as const) {
  safetyRouter.post(`/requests/:cid\\:${action}`, requireSignature(), handler<AuthedRequest>(async (req, res) => {
    const me = req.agentId!;
    const key = `${me}|${req.params.cid}`;
    const request = store.db.requests[key];
    if (!request) throw new AgentLineError('not_found', `no pending request for ${req.params.cid}`);
    request.state = action === 'accept' ? 'accepted' : 'declined';
    if (action === 'accept') store.addContact(me, request.from);
    else store.db.blocks[me] = Array.from(new Set([...(store.db.blocks[me] ?? []), request.from]));
    store.save();
    res.json({
      cid: request.cid, state: request.state, from: request.from,
      note: action === 'decline' ? 'The sender was also added to your block list.' : undefined,
    });
  }));
}

/* -------------------------------------------------------------- blocks */

safetyRouter.post('/blocks', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  const body = requireFields(req.body as Record<string, any>, ['agentId']);
  const target = store.resolve(body.agentId)?.agentId ?? body.agentId;
  const list = (store.db.blocks[me] ??= []);
  if (!list.includes(target)) list.push(target);
  store.save();
  res.status(201).json({ blocked: list, note: 'The relayer will refuse to carry messages from this agent to you.' });
}));

safetyRouter.get('/blocks', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  res.json({ blocked: store.db.blocks[req.agentId!] ?? [] });
}));

safetyRouter.delete('/blocks/:agentId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  store.db.blocks[me] = (store.db.blocks[me] ?? []).filter((a) => a !== req.params.agentId);
  store.save();
  res.json({ blocked: store.db.blocks[me] });
}));

/* -------------------------------------------------------------- franked reports */

safetyRouter.post('/reports', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  const body = requireFields(req.body as Record<string, any>, ['cid', 'reason', 'evidence']);
  const conv = store.db.conversations[body.cid];
  if (!conv) throw new AgentLineError('not_found', `unknown conversation ${body.cid}`);

  const indexed = store.messages(body.cid);
  const evidence: ReportRecord['evidence'] = [];

  for (const item of body.evidence as Array<{ seq: number; body: unknown; frankKey: string; msgId?: string }>) {
    const message = indexed.find((m) => m.seq === item.seq);
    let tagMatches = false;
    if (message) {
      try {
        const envelope = decodeEnvelope(b64.dec(message.envelope));
        // Verify the revealed plaintext against the franking tag committed on-chain.
        tagMatches = !!envelope.ft && verifyFrankingJson(item.frankKey, item.body, envelope.ft);
      } catch { tagMatches = false; }
    }
    evidence.push({ msgId: item.msgId ?? `seq:${item.seq}`, body: item.body, frankKey: item.frankKey, tagMatches });
  }

  const verified = evidence.length > 0 && evidence.every((e) => e.tagMatches);
  const reportId = randomId('rpt', 16);
  const reported = String(body.reportedAgentId ?? store.db.requests[`${me}|${body.cid}`]?.from ?? '');

  store.db.reports[reportId] = {
    reportId, reporter: me, reported, cid: body.cid,
    msgIds: evidence.map((e) => e.msgId), verified, reason: String(body.reason),
    evidence, createdAt: Date.now(),
  };
  if (body.block !== false && reported) {
    store.db.blocks[me] = Array.from(new Set([...(store.db.blocks[me] ?? []), reported]));
  }
  store.save();

  res.status(201).json({
    reportId, verified, checked: evidence.length,
    note: verified
      ? 'Franking tags matched the on-chain commitments: the reported content is cryptographically attributable to the sender.'
      : 'One or more franking tags did not match — the revealed content cannot be attributed to the sender.',
  });
}));

safetyRouter.get('/reports/:reportId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const report = store.db.reports[req.params.reportId];
  if (!report) throw new AgentLineError('not_found', 'unknown report');
  if (report.reporter !== req.agentId) throw new AgentLineError('forbidden', 'not your report');
  res.json(report);
}));

/* -------------------------------------------------------------- safety number */

safetyRouter.get('/agents/:agentId/safety-number', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = store.agent(req.agentId!);
  const peer = store.resolve(req.params.agentId);
  if (!me || !peer) throw new AgentLineError('agent_not_found', 'both agents must be registered');
  const { safetyNumber } = await import('@agentline/crypto');
  const { registry } = await import('../services/registry.ts');
  const onchain = await registry.verifyIdentityKey(peer.agentId, peer.ed25519Pk);
  res.json({
    peer: peer.agentId,
    safetyNumber: safetyNumber(b64.dec(me.ed25519Pk), b64.dec(peer.ed25519Pk)),
    peerKeyEpoch: peer.keyEpoch,
    onchainKeyCheck: onchain,
    note: 'Compare this code with your peer out of band. Recompute it yourself from both identity keys — do not trust this endpoint alone.',
  });
}));

export { utf8 };
