/**
 * Media uploads, inbox streaming, billing and status (PRD §6.10, §7.4, §9.3, §15).
 */
import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomId } from '@agentline/crypto';
import { AgentLineError, fromAtomic, toAtomic } from '@agentline/protocol';
import { chainMode, config, paymentMode, registryMode } from '../config.ts';
import { handler, requireFields } from '../lib/http.ts';
import { store } from '../lib/store.ts';
import { requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { addCredits, creditBalance, requirePayment } from '../middleware/x402.ts';
import { ledger, ledgerDegraded } from '../services/ledger.ts';
import { registry } from '../services/registry.ts';
import { subscriberCount } from '../services/notifier.ts';
import { streamInbox, totalSubscribers } from '../services/inbox-stream.ts';

export const miscRouter = Router();

/* -------------------------------------------------------------- media */

const blobDir = () => join(config.dataDir, 'blobs');

/**
 * Pre-signed upload for already-encrypted media. The client encrypts locally with a random
 * key, uploads the ciphertext here, and sends {mediaId, uri, sha256, key} *inside* the
 * E2EE message — so this service stores bytes it cannot read.
 */
miscRouter.post(
  '/media/uploads',
  requirePayment((req) => ({
    routeKey: 'POST /v1/media/uploads',
    bytes: Number((req.body as any)?.size ?? 0),
    agentId: req.headers['agentline-key-id'] as string,
  })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const body = requireFields(req.body as Record<string, any>, ['size']);
    const size = Number(body.size);
    if (size > 64 * 1024 * 1024) throw new AgentLineError('validation_failed', 'media larger than 64 MiB must be uploaded to your own blob store');
    const mediaId = randomId('med', 16);
    const token = randomBytes(24).toString('base64url');
    store.db.media[mediaId] = {
      mediaId, owner: req.agentId!, size, mime: body.mime, uploadedAt: Date.now(),
      uri: `${config.publicUrl}/v1/media/${mediaId}`,
      expiresAt: body.retentionDays ? Date.now() + Number(body.retentionDays) * 86400_000 : undefined,
    };
    store.save();
    res.status(201).json({
      mediaId,
      uploadUrl: `${config.publicUrl}/v1/media/${mediaId}?token=${token}`,
      uri: store.db.media[mediaId].uri,
      method: 'PUT',
      maxBytes: size,
      note: 'Upload ciphertext only. Send {mediaId, uri, sha256, key, mime, size} inside the encrypted message body — never the key to this API.',
    });
  }),
);

miscRouter.put('/media/:mediaId', handler(async (req, res) => {
  const record = store.db.media[req.params.mediaId];
  if (!record) throw new AgentLineError('not_found', 'unknown mediaId');
  const raw = (req as { rawBody?: Buffer }).rawBody;
  if (!raw?.length) throw new AgentLineError('validation_failed', 'empty body');
  mkdirSync(blobDir(), { recursive: true });
  writeFileSync(join(blobDir(), record.mediaId), raw);
  record.sha256 = createHash('sha256').update(raw).digest('hex');
  record.size = raw.length;
  store.save();
  res.json({ mediaId: record.mediaId, sha256: record.sha256, size: record.size, uri: record.uri });
}));

miscRouter.get('/media/:mediaId', handler(async (req, res) => {
  const record = store.db.media[req.params.mediaId];
  if (!record) throw new AgentLineError('not_found', 'unknown mediaId');
  if (record.expiresAt && record.expiresAt < Date.now()) throw new AgentLineError('not_found', 'media retention expired');
  const path = join(blobDir(), record.mediaId);
  if (!existsSync(path)) throw new AgentLineError('not_found', 'media not uploaded yet');
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('AgentLine-Media-Sha256', record.sha256 ?? '');
  res.send(readFileSync(path));
}));

/* -------------------------------------------------------------- inbox */

miscRouter.get('/inbox', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  const after = Number(req.query.afterSeq ?? 0);
  const notices = store.notices(me).filter((n) => n.seq > after).slice(0, Number(req.query.limit ?? 100));
  const agent = store.agent(me);
  res.json({
    agentId: me,
    inboxTopic: agent?.inboxTopic,
    count: notices.length,
    notices,
    trustless: agent?.inboxTopic
      ? `${config.hedera.mirrorRest}/api/v1/topics/${agent.inboxTopic}/messages`
      : undefined,
  });
}));

/**
 * SSE stream of this agent's inbox — and only this agent's.
 *
 * Backed by a tail of the caller's own HCS inbox topic, so delivery is scoped to one agent
 * by the transport rather than by gateway bookkeeping, works no matter which instance holds
 * the socket, and resumes from `fromSeq` after a reconnect.
 */
miscRouter.get('/inbox/stream', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const fromSeq = req.query.fromSeq !== undefined ? Number(req.query.fromSeq) : undefined;
  await streamInbox(me, res, Number.isFinite(fromSeq) ? fromSeq : undefined);
}));

/* -------------------------------------------------------------- billing */

miscRouter.get('/billing/balance', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  res.json({ agentId: me, ...creditBalance(me), currency: config.x402.assetName, network: config.x402.network });
}));

/**
 * Prepaid credits (PRD §9.3): one x402 payment buys a balance, so a high-volume agent
 * avoids per-message settlement latency.
 */
miscRouter.post(
  '/billing/credits',
  requirePayment((req) => ({
    routeKey: 'POST /v1/billing/credits',
    amount: String((req.body as any)?.amount ?? '1.00'),
    agentId: undefined,   // never pay for credits with credits
  })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const me = req.agentId!;
    const amount = String((req.body as any)?.amount ?? '1.00');
    if (req.payment?.method !== 'x402' && paymentMode() !== 'disabled') {
      throw new AgentLineError('payment_required', 'credits must be bought with an x402 payment');
    }
    addCredits(me, toAtomic(amount));
    res.status(201).json({
      agentId: me, added: amount, ...creditBalance(me),
      txHash: req.payment?.txHash,
      note: 'Credits are spent automatically by later paid routes before an x402 challenge is issued.',
    });
  }),
);

miscRouter.post('/billing/sponsor', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const agent = store.agent(req.agentId!);
  if (!agent) throw new AgentLineError('agent_not_found', 'register first');
  agent.sponsorInbound = (req.body as any)?.sponsorInbound !== false;
  store.save();
  res.json({
    agentId: agent.agentId, sponsorInbound: agent.sponsorInbound,
    note: agent.sponsorInbound
      ? 'Your credits now pay for inbound first-contact messages, so customers can message you for free.'
      : 'Sponsorship disabled; senders pay their own first-contact fee.',
  });
}));

/* -------------------------------------------------------------- platform probes */

/**
 * Liveness/readiness probe for the hosting platform (Render, Fly, Kubernetes).
 *
 * Unauthenticated and cheap by design: it reports whether this instance can serve, not
 * operational detail. 503 while the consensus transport is unusable, so a load balancer
 * stops sending traffic to an instance that cannot actually deliver messages.
 */
export const healthProbe = handler(async (_req, res) => {
  const degraded = ledgerDegraded();
  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    consensus: ledger().kind,
    uptimeSeconds: Math.floor(process.uptime()),
    reason: degraded ?? undefined,
  });
});

miscRouter.get('/healthz', healthProbe);

/* -------------------------------------------------------------- status */

miscRouter.get('/status', handler(async (_req, res) => {
  res.json({
    service: 'Agentegram',
    version: '0.2.0',
    time: new Date().toISOString(),
    // Report the transport actually in use, not the one configured: a degraded gateway
    // that claims to be on Hedera is worse than one that admits it fell back.
    modes: {
      consensus: ledger().kind === 'hedera' ? 'hedera' : ledgerDegraded() ? 'local (degraded from hedera)' : 'local',
      configuredConsensus: chainMode(),
      registry: registryMode(),
      payments: paymentMode(),
    },
    consensus: { ...ledger().info(), degradedFrom: ledgerDegraded() ?? undefined },
    registryWrites: registry.writerStats() ?? undefined,
    registry: registry.info(),
    payments: config.algorand.enabled
      ? { rail: 'algorand', ...(await import('../middleware/x402-algorand.ts')).algorandInfo() }
      : {
          rail: 'evm',
          network: config.x402.network, caip2: config.x402.caip2, asset: config.x402.asset,
          payTo: config.x402.payTo || null, facilitator: config.x402.facilitatorUrl,
        },
    stats: {
      ...store.db.stats,
      revenue: fromAtomic(BigInt(store.db.stats.revenueAtomic)),
      agents: Object.keys(store.db.agents).length,
      conversations: Object.keys(store.db.conversations).length,
      groups: Object.keys(store.db.groups).length,
      channels: Object.keys(store.db.channels).length,
      liveStreams: totalSubscribers(),
    },
  });
}));
