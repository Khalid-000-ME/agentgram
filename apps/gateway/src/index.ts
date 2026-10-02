/**
 * Agentegram gateway (PRD §4).
 *
 * Stateless HTTP surface in front of Hedera Consensus Service and the registry contract:
 * x402 pricing, RFC 9421 agent authentication, validation, relaying, indexing and
 * notification fan-out. It holds no plaintext and no agent keys, so an operator — us
 * included — cannot read a single message.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { join } from 'node:path';
import { AgentLineError } from '@agentline/protocol';
import { chainMode, config, paymentMode, registryMode } from './config.ts';
import { store } from './lib/store.ts';
import { adminRouter, adminToken } from './routes/admin.ts';
import { x402Router } from './routes/x402-public.ts';
import { algorandInfo, algorandPaymentMiddleware } from './middleware/x402-algorand.ts';
import { agentsRouter } from './routes/agents.ts';
import { conversationsRouter } from './routes/conversations.ts';
import { discoveryRouter } from './routes/discovery.ts';
import { groupsRouter } from './routes/groups.ts';
import { healthProbe, miscRouter } from './routes/misc.ts';
import { safetyRouter } from './routes/safety.ts';
import { flushAll } from './services/notifier.ts';
import { ledger, verifyLedger } from './services/ledger.ts';
import { noteRequest, noteServerError, startHealthMonitor } from './services/health.ts';
import { checkpoint, checkpointTopic, restoreIfEmpty, startCheckpoints } from './services/checkpoint.ts';
import { alertConfig, raiseAlert, transportDescription } from './services/alerts.ts';

/**
 * @param opts.unpaidPublicApi tests only: mount /x402/v1 without the Algorand rail, so the
 *   handlers can be exercised offline. Never set in production — the routes would be free.
 */
export function createApp(opts: { unpaidPublicApi?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // The raw body is required for Content-Digest verification, so capture it while parsing.
  app.use(express.json({
    limit: config.limits.maxBodyBytes,
    verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf); },
  }));
  app.use(express.raw({ type: 'application/octet-stream', limit: 64 * 1024 * 1024, verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));

  // CORS, ahead of the payment middleware: browser-based payers (wallet web apps, the
  // GoPlausible Universal Client) must be able to read the 402 challenge and the settlement
  // header cross-origin, and a preflight must never be answered with a 402.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers',
      'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Link, Agentegram-Version');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',
        'Content-Type, Accept, PAYMENT-SIGNATURE, X-PAYMENT, Signature, Signature-Input, Content-Digest, AgentLine-Key-Id, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    noteRequest();
    res.setHeader('Agentegram-Version', '0.2.0');
    // Agents discover the protocol from the response itself, not from tribal knowledge.
    res.setHeader('Link', `<${config.publicUrl}/llms.txt>; rel="service-doc", <${config.publicUrl}/.well-known/agentegram.json>; rel="service-desc"`);
    next();
  });

  // Operator console: a static page that drives the admin API below. `redirect: false`
  // keeps /ui from bouncing to /ui/, which would drop the ?token= query string.
  const publicDir = join(import.meta.dirname, '../public');
  app.get('/ui', (_req, res) => res.sendFile(join(publicDir, 'index.html')));
  app.use('/ui', express.static(publicDir, { redirect: false }));

  // Platforms probe /healthz at the root; /v1/healthz is the same handler.
  app.get('/healthz', healthProbe);

  // The Algorand rail prices and settles the public paid surface. Mounted before the
  // routes it protects, and only when selected, so the EVM rail is never also in play.
  if (config.algorand.enabled) {
    app.use(algorandPaymentMiddleware());
    app.use('/x402/v1', x402Router);
  } else if (opts.unpaidPublicApi) {
    app.use('/x402/v1', x402Router);
  }

  app.use(discoveryRouter);
  app.use('/v1/admin', adminRouter);
  app.use('/v1', agentsRouter);
  app.use('/v1', conversationsRouter);
  app.use('/v1', groupsRouter);
  app.use('/v1', safetyRouter);
  app.use('/v1', miscRouter);

  app.use((req, res) => {
    res.status(404).type('application/problem+json').json({
      type: 'https://agentline.dev/errors/not_found',
      title: 'not found', status: 404, code: 'not_found',
      detail: `no route ${req.method} ${req.path}`,
      hint: `See ${config.publicUrl}/llms.txt for the full API.`,
    });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof AgentLineError) {
      res.status(err.status).type('application/problem+json').json(err.toProblem(req.originalUrl));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const syntax = err instanceof SyntaxError || /JSON/i.test(message);
    const problem = new AgentLineError(
      syntax ? 'validation_failed' : 'internal',
      syntax ? `malformed JSON body: ${message}` : message,
    );
    if (!syntax) {
      console.error('[gateway] unhandled:', err);
      noteServerError();
      // An unhandled exception is a bug by definition; the operator should see it without
      // reading logs.
      raiseAlert({
        severity: 'critical',
        kind: 'gateway.unhandled_error',
        title: `Unhandled error on ${req.method} ${req.path}`,
        detail: message.slice(0, 500),
        meta: { method: req.method, path: req.path, stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined },
      });
    }
    res.status(problem.status).type('application/problem+json').json(problem.toProblem(req.originalUrl));
  });

  return app;
}

export async function start(port = config.port) {
  const app = createApp();
  // Verify the ledger at boot: credential problems should surface here, not on a user's
  // first message. Falls back to the local ledger (loudly) if Hedera is unusable.
  const { degraded } = await verifyLedger();
  const info = ledger().info();
  if (degraded) {
    raiseAlert({
      severity: 'critical',
      kind: 'consensus.degraded',
      title: 'Gateway started on the local ledger — Hedera is configured but unusable',
      detail: degraded,
      meta: { configuredNetwork: config.hedera.network, account: config.hedera.accountId },
    });
  }
  startHealthMonitor();

  // A fresh container starts with an empty disk; bring identity and routing state back from
  // the encrypted on-chain checkpoint before taking traffic.
  try {
    const r = await Promise.race([
      restoreIfEmpty(),
      new Promise<{ restored: false; reason: string }>((resolve) =>
        setTimeout(() => resolve({ restored: false, reason: 'timed out after 25s' }), 25_000)),
    ]);
    if (r.restored) console.log(`  restored state from checkpoint topic ${checkpointTopic()} (${(r as { agents?: number }).agents} agents)`);
    else console.log(`  checkpoint restore skipped: ${r.reason}`);
  } catch (err) {
    console.error(`  checkpoint restore failed: ${(err as Error).message}`);
    raiseAlert({ severity: 'critical', kind: 'checkpoint.restore_failed', title: 'Could not restore state on boot',
      detail: (err as Error).message });
  }
  startCheckpoints();
  const server = app.listen(port, () => {
    console.log(`\n  Agentegram gateway  ->  http://localhost:${port}`);
    console.log(`  consensus: ${chainMode()}   registry: ${registryMode()}   payments: ${paymentMode()}`);
    if (config.algorand.enabled) {
      const a = algorandInfo();
      console.log(`  algorand: ${a.network} · USDC ASA ${a.asset} · payTo ${a.payTo}`);
      console.log(`  facilitator: ${a.facilitator}   tag: ${a.tag}`);
      console.log(`  paid routes: ${a.routes.map((r) => r.route.split(' ')[1]).join(', ')}`);
    }
    if (degraded) console.log('  warning: running on the local consensus ledger — Hedera is configured but unusable');
    else if (chainMode() === 'local') console.log('  note: local consensus ledger in use (no Hedera credentials configured)');
    if (paymentMode() === 'verify-only') console.log('  note: payments verified but not settled (no facilitator/settler configured)');
    if (!config.x402.payTo && paymentMode() !== 'disabled') console.log('  warning: X402_PAY_TO is unset — paid routes will fail until you set it');
    const alerts = alertConfig();
    console.log(`  alerts: ${alerts.enabled ? 'on' : 'off'} -> ${alerts.to}  (${transportDescription()})`);
    console.log(`  console: http://localhost:${port}/ui?token=${adminToken()}`);
    console.log(`  docs: http://localhost:${port}/llms.txt   status: http://localhost:${port}/v1/status\n`);
  });

  const shutdown = async () => {
    console.log('\n[gateway] shutting down…');
    await flushAll();
    store.flush();
    // The platform may wipe the disk after this; get the latest state on-chain first.
    await Promise.race([checkpoint({ force: false }), new Promise((r) => setTimeout(r, 20_000))]);
    await ledger().close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { app, server, info };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => { console.error(err); process.exit(1); });
}
