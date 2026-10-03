/**
 * Operator console API.
 *
 * Powers the UI at /ui: health, alert configuration and history, a one-click alerting
 * toggle, and a server-side end-to-end test so the whole stack can be exercised from a
 * browser without wiring up an agent by hand.
 *
 * Gated by a bearer token, because the e2e test spends real testnet USDC and the toggle
 * controls production alerting. The token is generated at boot if unset.
 */
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { AgentLineError, fromAtomic } from '@agentline/protocol';
import { chainMode, config, paymentMode, registryMode } from '../config.ts';
import { handler } from '../lib/http.ts';
import { store } from '../lib/store.ts';
import {
  alertConfig, alertHistory, mailConfigIssue, raiseAlert, sendTestAlert, setAlertsEnabled,
  transportDescription, transportKind,
} from '../services/alerts.ts';
import { lastHealth, runHealthCheck } from '../services/health.ts';
import { reset as resetPlayground, sendMessage, state as playgroundState } from '../services/playground.ts';
import {
  askQuestion, closeQuestion, generalFeedback, listAnnouncements, publishAnnouncement, results,
} from '../services/community.ts';
import { ledger, ledgerDegraded } from '../services/ledger.ts';
import { registry } from '../services/registry.ts';

export const adminRouter = Router();

let token = process.env.ADMIN_TOKEN ?? '';

export function adminToken(): string {
  if (!token) token = randomBytes(16).toString('base64url');
  return token;
}

/** Bearer auth for every admin route. Read-only endpoints are still gated: the console
 *  exposes wallet addresses and balances, which is not public information. */
adminRouter.use((req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const supplied = header.replace(/^Bearer\s+/i, '') || String(req.query.token ?? '');
  if (supplied !== adminToken()) {
    next(new AgentLineError('forbidden', 'admin token required — see the gateway startup log'));
    return;
  }
  next();
});

adminRouter.get('/overview', handler(async (_req, res) => {
  const cfg = alertConfig();
  const health = lastHealth();
  res.json({
    service: { version: '0.1.0', env: config.env, publicUrl: config.publicUrl, uptimeSeconds: Math.floor(process.uptime()) },
    modes: {
      consensus: ledger().kind === 'hedera' ? 'hedera' : ledgerDegraded() ? 'local (degraded from hedera)' : 'local',
      configuredConsensus: chainMode(),
      registry: registryMode(),
      payments: paymentMode(),
    },
    consensus: {
      ...ledger().info(),
      degradedFrom: ledgerDegraded() ?? undefined,
      mirror: config.hedera.mirrorRest,
      explorer: ledger().kind === 'hedera' ? `https://hashscan.io/${config.hedera.network}` : undefined,
      shardTopics: store.db.sealedShardTopics,
    },
    registry: {
      ...registry.info(),
      explorer: registry.address
        ? `https://${config.registry.chainId === 8453 ? 'basescan.org' : 'sepolia.basescan.org'}/address/${registry.address}`
        : undefined,
    },
    payments: {
      network: config.x402.network,
      caip2: config.x402.caip2,
      asset: config.x402.asset,
      payTo: config.x402.payTo || null,
      facilitator: config.x402.facilitatorUrl,
      selfSettleFallback: !!config.x402.settlerPrivateKey,
    },
    alerts: {
      ...cfg,
      transport: transportKind(),
      transportDescription: transportDescription(),
      deliverable: transportKind() !== 'none',
      configIssue: mailConfigIssue(),
      recent: alertHistory(25),
    },
    health,
    stats: {
      ...store.db.stats,
      revenue: fromAtomic(BigInt(store.db.stats.revenueAtomic)),
      agents: Object.keys(store.db.agents).length,
      conversations: Object.keys(store.db.conversations).length,
      groups: Object.keys(store.db.groups).length,
      channels: Object.keys(store.db.channels).length,
    },
  });
}));

/** The single-click toggle. */
adminRouter.post('/alerts/toggle', handler(async (req, res) => {
  const body = (req.body ?? {}) as { enabled?: boolean };
  const desired = typeof body.enabled === 'boolean' ? body.enabled : !alertConfig().enabled;
  const cfg = setAlertsEnabled(desired);
  res.json({ ...cfg, transport: transportKind(), transportDescription: transportDescription() });
}));

adminRouter.post('/alerts/test', handler(async (_req, res) => {
  const result = await sendTestAlert();
  res.status(result.ok ? 200 : 502).json({
    ...result,
    hint: result.ok
      ? `Check the inbox of ${result.to}.`
      : 'Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS (a Gmail app password works) or RESEND_API_KEY, then restart.',
  });
}));

adminRouter.patch('/alerts/config', handler(async (req, res) => {
  const body = (req.body ?? {}) as { to?: string; throttleMinutes?: number; minSeverity?: string };
  const cfg = alertConfig();
  if (body.to) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.to)) throw new AgentLineError('validation_failed', 'not a valid email address');
    cfg.to = body.to;
  }
  if (body.throttleMinutes !== undefined) cfg.throttleMinutes = Math.max(1, Number(body.throttleMinutes));
  if (body.minSeverity && ['info', 'warning', 'critical'].includes(body.minSeverity)) {
    cfg.minSeverity = body.minSeverity as 'info' | 'warning' | 'critical';
  }
  store.save();
  res.json(cfg);
}));

adminRouter.post('/health/check', handler(async (_req, res) => {
  res.json(await runHealthCheck());
}));

/** Deliberately raise an alert, to prove the detection path end to end. */
adminRouter.post('/alerts/simulate', handler(async (req, res) => {
  const body = (req.body ?? {}) as { severity?: 'info' | 'warning' | 'critical' };
  const alert = raiseAlert({
    severity: body.severity ?? 'critical',
    kind: 'operator.simulated_incident',
    title: 'Simulated incident (triggered from the console)',
    detail: 'An operator triggered this from the AgentLine console to verify that real incidents are detected, recorded and delivered.',
    meta: { triggeredAt: new Date().toISOString() },
  });
  res.json(alert);
}));

/* ---------------------------------------------------------------- message playground */

adminRouter.get('/chat', handler(async (_req, res) => {
  res.json(await playgroundState());
}));

/**
 * Send a message between two in-memory test agents and return the transcript, including
 * what the recipient decrypted and what the chain actually stored. This is the operator's
 * proof that message transfer works, not a simulation of it.
 */
adminRouter.post('/chat', handler(async (req, res) => {
  const body = (req.body ?? {}) as { text?: string; from?: 'A' | 'B' };
  const text = String(body.text ?? '').trim();
  if (!text) throw new AgentLineError('validation_failed', 'text is required');
  if (text.length > 800) throw new AgentLineError('validation_failed', 'keep console messages under 800 characters');
  const from = body.from === 'B' ? 'B' : 'A';
  try {
    await sendMessage(text, from);
  } catch (err) {
    raiseAlert({
      severity: 'critical',
      kind: 'playground.send_failed',
      title: 'Console message send failed',
      detail: `A message sent from the operator console did not complete: ${(err as Error).message}`,
    });
    throw err;
  }
  res.json(await playgroundState());
}));

adminRouter.post('/chat/reset', handler(async (_req, res) => {
  resetPlayground();
  res.json({ ok: true, note: 'Test agents discarded. The next message creates a fresh pair and conversation.' });
}));

/**
 * Server-side end-to-end test.
 *
 * Runs two real agents against this gateway: register, publish prekeys, open a sealed
 * conversation, send an encrypted message, decrypt it on the other side, and read back what
 * was actually stored. Returns a step log plus the chain artifacts, so the browser can show
 * that the message on-chain is unreadable.
 *
 * This spends real testnet USDC, which is why it sits behind the admin token.
 */
adminRouter.post('/e2e', handler(async (_req, res) => {
  const steps: Array<{ step: string; ok: boolean; detail: string; meta?: Record<string, unknown> }> = [];
  const note = (step: string, ok: boolean, detail: string, meta?: Record<string, unknown>) =>
    steps.push({ step, ok, detail, meta });

  const { AgentLine, MemoryKeyStore } = await import('@agentline/sdk');
  const { b64 } = await import('@agentline/crypto');
  const { decodeEnvelope } = await import('@agentline/protocol');

  const walletKey = (process.env.DEMO_PRIVATE_KEY ?? process.env.SETTLER_PRIVATE_KEY) as `0x${string}` | undefined;
  const wallet = walletKey ? { privateKey: walletKey } : undefined;
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const secret = `console e2e ${Date.now().toString(36)} — flight LHR->JFK`;

  try {
    const suffix = Date.now().toString(36);
    const alice = await AgentLine.connect({
      baseUrl, keyStore: new MemoryKeyStore(), wallet,
      handle: `console.a.${suffix}`, profile: { name: 'Console Test A' },
    });
    note('register agent A', true, `${alice.agentId} @${alice.handle}`, { inboxTopic: alice.inboxTopic });

    const bob = await AgentLine.connect({
      baseUrl, keyStore: new MemoryKeyStore(), wallet,
      handle: `console.b.${suffix}`, profile: { name: 'Console Test B' },
    });
    note('register agent B', true, `${bob.agentId} @${bob.handle}`, { inboxTopic: bob.inboxTopic });

    const safetyA = await alice.safetyNumberFor(bob.agentId);
    const safetyB = await bob.safetyNumberFor(alice.agentId);
    note('verify peer identity', safetyA === safetyB,
      safetyA === safetyB ? 'safety numbers match on both sides' : 'MISMATCH — possible key substitution',
      { safetyNumber: safetyA.split('\n')[0] });

    const sent = await alice.send(bob.agentId, secret);
    note('send encrypted message', true,
      `HCS seq ${sent.sequenceNumber} at consensus ${sent.consensusTimestamp}`,
      { ...sent.payment, cid: sent.cid, runningHash: sent.runningHash });

    const stored = await alice.request<{ topicId: string; messages: Array<{ envelope: string; seq: number }> }>(
      'GET', `/v1/conversations/${sent.cid}/messages?afterSeq=0`);
    const envelope = decodeEnvelope(b64.dec(stored.messages[0].envelope));
    const leaks = JSON.stringify(envelope).includes('LHR');
    note('confirm the gateway cannot read it', !leaks,
      leaks ? 'PLAINTEXT LEAK — investigate immediately' : 'stored record contains ciphertext only',
      {
        envelopeFields: Object.keys(envelope).sort().join(', '),
        conversationReference: envelope.tag ? `blinded tag ${envelope.tag}` : envelope.cid,
        senderDevice: envelope.sd ?? 'null (sealed sender)',
        ciphertextBytes: b64.dec(envelope.ct).length,
        topicId: stored.topicId,
      });

    await bob.syncConversations();
    const received = await bob.read(sent.cid);
    const text = received.find((m) => m.message.type === 'text');
    const body = text?.message.body as { text?: string } | undefined;
    note('recipient decrypts', body?.text === secret,
      body?.text === secret ? `decrypted: "${body?.text}"` : `decryption failed (${received.length} message(s) fetched)`);

    await bob.markRead(sent.cid, sent.sequenceNumber, 'done');
    note('receipt posted', true, 'recipient reported work state "done"');

    const conv = (await alice.listConversations()).find((c) => c.cid === sent.cid);
    const proof = await alice.request<Record<string, unknown>>('GET', `/v1/proofs/${conv?.topicId}/${sent.sequenceNumber}`);
    note('consensus proof', true, 'message is independently verifiable', proof);

    const mirror = ledger().kind === 'hedera'
      ? `${config.hedera.mirrorRest}/api/v1/topics/${conv?.topicId}/messages`
      : undefined;
    const hashscan = ledger().kind === 'hedera'
      ? `https://hashscan.io/${config.hedera.network}/topic/${conv?.topicId}`
      : undefined;

    res.json({
      ok: steps.every((s) => s.ok),
      steps,
      artifacts: {
        cid: sent.cid,
        topicId: conv?.topicId,
        mirrorNode: mirror,
        hashscan,
        registryExplorer: registry.address
          ? `https://sepolia.basescan.org/address/${registry.address}`
          : undefined,
        settlementTx: sent.payment?.txHash
          ? `https://sepolia.basescan.org/tx/${sent.payment.txHash}`
          : undefined,
      },
    });
  } catch (err) {
    note('failed', false, (err as Error).message);
    // A broken happy path in production is exactly what the operator needs to hear about.
    raiseAlert({
      severity: 'critical',
      kind: 'e2e.failed',
      title: 'End-to-end test failed',
      detail: `The console end-to-end test could not complete: ${(err as Error).message}`,
      meta: { steps: steps.map((s) => `${s.ok ? 'ok' : 'FAIL'} ${s.step}`) },
    });
    res.status(500).json({ ok: false, steps, error: (err as Error).message });
  }
}));

/* ---------------------------------------------------------------- announcements & surveys */

adminRouter.get('/community', handler(async (_req, res) => {
  res.json({ announcements: listAnnouncements({ limit: 50 }), questions: results(), feedback: generalFeedback(30) });
}));

adminRouter.post('/announcements', handler(async (req, res) => {
  res.status(201).json(await publishAnnouncement(req.body ?? {}));
}));

adminRouter.post('/questions', handler(async (req, res) => {
  res.status(201).json(await askQuestion(req.body ?? {}));
}));

adminRouter.post('/questions/:id/close', handler(async (req, res) => {
  res.json(await closeQuestion(req.params.id));
}));

adminRouter.get('/questions/:id/results', handler(async (req, res) => {
  const [r] = results(req.params.id);
  if (!r) throw new AgentLineError('not_found', `no question ${req.params.id}`);
  res.json(r);
}));
