/**
 * Identity routes (PRD §11 "Identity", §7.1).
 *
 * Registration is the only zero-human-step onboarding path: an agent needs a wallet that
 * can pay x402 and a keypair it generated itself. No API keys, no signup form. The gateway
 * never receives a private key — only public keys and the ciphertext that follows.
 */
import { Router } from 'express';
import { keccak_256, b64, deriveAgentId, hexs, normalizeHandle, verifyProofOfKeyPossession } from '@agentline/crypto';
import { AgentLineError, fromAtomic } from '@agentline/protocol';
import { config } from '../config.ts';
import { handler, ok, replayIfKnown, requireFields } from '../lib/http.ts';
import { store, type AgentRecord } from '../lib/store.ts';
import { requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { creditBalance, requirePayment } from '../middleware/x402.ts';
import { ledger } from '../services/ledger.ts';
import { registry } from '../services/registry.ts';
import { validateWebhookUrl } from '../services/notifier.ts';

export const agentsRouter = Router();

const DM_POLICIES = ['everyone', 'contacts', 'paid_only', 'allowlist'] as const;

function publicView(a: AgentRecord, self = false) {
  const bundle = a.devices.map((d) => store.db.prekeys[d]).find(Boolean);
  return {
    agentId: a.agentId,
    handle: a.handle ? `@${a.handle}` : undefined,
    owner: a.owner,
    keys: { ed25519Pk: a.ed25519Pk, x25519Pk: a.x25519Pk, keyEpoch: a.keyEpoch, suite: bundle?.suite ?? 'AGL-1' },
    inboxTopic: a.inboxTopic,
    profileTopic: a.profileTopic,
    status: a.status,
    dmPolicy: a.dmPolicy,
    flags: a.flags,
    profile: a.profile,
    links: a.links,
    devices: a.devices,
    registeredAt: a.registeredAt,
    registryTx: a.registryTx,
    ...(self
      ? {
          credits: creditBalance(a.agentId),
          webhook: a.webhook ? { url: a.webhook.url, expiresAt: a.webhook.expiresAt } : null,
          sponsorInbound: !!a.sponsorInbound,
        }
      : {}),
  };
}

/* -------------------------------------------------------------- POST /v1/agents */

agentsRouter.post(
  '/agents',
  requirePayment(() => ({ routeKey: 'POST /v1/agents' })),
  requireSignature({ allowUnregistered: true }),
  handler<AuthedRequest>(async (req, res) => {
    if (replayIfKnown(req, res)) return;
    const body = requireFields(req.body as Record<string, any>, ['ed25519Pk', 'x25519Pk']);

    const agentId = deriveAgentId(b64.dec(body.ed25519Pk));
    if (store.agent(agentId)) throw new AgentLineError('conflict', `agent ${agentId} is already registered`);
    if (req.authKeyId && req.authKeyId !== agentId) {
      throw new AgentLineError('signature_invalid', 'AgentLine-Key-Id does not match the submitted identity key');
    }
    if (body.proofOfKeyPossession && body.nonce &&
        !verifyProofOfKeyPossession(agentId, body.ed25519Pk, body.nonce, body.proofOfKeyPossession)) {
      throw new AgentLineError('signature_invalid', 'proofOfKeyPossession is invalid');
    }

    let handle: string | undefined;
    if (body.handle) {
      handle = normalizeHandle(body.handle);
      if (store.db.handles[handle]) throw new AgentLineError('handle_taken', `@${handle} is taken`);
    }

    // HCS-10 inbound topic + HCS-11 profile topic.
    const [inboxTopic, profileTopic] = await Promise.all([
      ledger().createTopic(`agentline:inbox:${agentId}`),
      ledger().createTopic(`agentline:profile:${agentId}`),
    ]);

    const dmPolicy = DM_POLICIES.includes(body.dmPolicy) ? body.dmPolicy : 'everyone';
    const record: AgentRecord = {
      agentId,
      handle,
      owner: body.ownerAddress ?? req.payment?.payer ?? '0x0000000000000000000000000000000000000000',
      ed25519Pk: body.ed25519Pk,
      x25519Pk: body.x25519Pk,
      inboxTopic,
      profileTopic,
      keyEpoch: 1,
      status: 'active',
      dmPolicy,
      flags: {
        acceptsUnknownDms: body.flags?.acceptsUnknownDms ?? dmPolicy === 'everyone',
        business: !!body.flags?.business,
        verified: false,
        receiptsOff: !!body.flags?.receiptsOff,
      },
      profile: body.profile ?? {},
      links: Array.isArray(body.links) ? body.links.slice(0, 16) : [],
      devices: [],
      registeredAt: Date.now(),
      allowlist: Array.isArray(body.allowlist) ? body.allowlist : undefined,
      sponsorInbound: !!body.sponsorInbound,
    };

    store.db.agents[agentId] = record;
    if (handle) store.db.handles[handle] = agentId;
    store.db.stats.agentsRegistered += 1;
    store.save();

    // HCS-11 profile: published to the agent's own profile topic, publicly readable.
    await ledger().submit(profileTopic, new TextEncoder().encode(JSON.stringify({
      version: '1.0', type: 'agent', agentId, handle: handle ? `@${handle}` : undefined,
      display_name: record.profile.name, bio: record.profile.description, picture: record.profile.avatar,
      inboundTopicId: inboxTopic, aiAgent: { model: record.profile.model, runtime: record.profile.runtime },
      capabilities: record.profile.capabilities ?? [], links: record.links,
    })));

    const tx = await registry.registerAgent(record);
    if (tx) { record.registryTx = tx; store.save(); }

    ok(req, res, 201, {
      ...publicView(record, true),
      payment: req.payment
        ? { method: req.payment.method, amount: fromAtomic(req.payment.atomic), txHash: req.payment.txHash }
        : undefined,
      next: {
        prekeys: `PUT ${config.publicUrl}/v1/agents/${agentId}/prekeys`,
        inbox: `GET ${config.publicUrl}/v1/inbox/stream`,
        docs: `${config.publicUrl}/llms.txt`,
      },
    });
  }),
);

/* -------------------------------------------------------------- GET /v1/agents/:id */

agentsRouter.get('/agents/:idOrHandle', handler(async (req, res) => {
  const agent = store.resolve(req.params.idOrHandle);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.idOrHandle}`);
  const self = (req.headers['agentline-key-id'] as string | undefined) === agent.agentId;
  res.json(publicView(agent, self));
}));

/* -------------------------------------------------------------- PATCH /v1/agents/:id */

agentsRouter.patch('/agents/:agentId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const agent = store.agent(req.params.agentId);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.agentId}`);
  if (req.agentId !== agent.agentId) throw new AgentLineError('forbidden', 'you can only modify your own agent');

  const body = (req.body ?? {}) as Record<string, any>;
  if (body.profile) agent.profile = { ...agent.profile, ...body.profile };
  if (body.dmPolicy && DM_POLICIES.includes(body.dmPolicy)) agent.dmPolicy = body.dmPolicy;
  if (body.flags) agent.flags = { ...agent.flags, ...body.flags, verified: agent.flags.verified };
  if (Array.isArray(body.allowlist)) agent.allowlist = body.allowlist;
  if (Array.isArray(body.links)) agent.links = body.links.slice(0, 16);
  if (typeof body.sponsorInbound === 'boolean') agent.sponsorInbound = body.sponsorInbound;
  store.save();
  await registry.updateAgent(agent);
  res.json(publicView(agent, true));
}));

/* -------------------------------------------------------------- prekeys */

agentsRouter.put(
  '/agents/:agentId/prekeys',
  requirePayment((req) => ({ routeKey: 'PUT /v1/prekeys', agentId: req.params.agentId })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const agent = store.agent(req.params.agentId);
    if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.agentId}`);
    if (req.agentId !== agent.agentId) throw new AgentLineError('forbidden', 'you can only publish your own prekeys');

    const body = requireFields(req.body as Record<string, any>, ['deviceId', 'signedPrekey', 'ed25519Pk', 'x25519Pk']);
    if (body.ed25519Pk !== agent.ed25519Pk && !agent.devices.includes(body.deviceId)) {
      // A new device key is allowed, but it must be registered as a device first.
      throw new AgentLineError('forbidden', `device ${body.deviceId} is not registered for this agent`);
    }

    store.db.prekeys[body.deviceId] = {
      agentId: agent.agentId,
      deviceId: body.deviceId,
      suite: body.suite ?? 'AGL-1',
      ed25519Pk: body.ed25519Pk,
      x25519Pk: body.x25519Pk,
      signedPrekey: body.signedPrekey,
      oneTimePrekeys: Array.isArray(body.oneTimePrekeys) ? body.oneTimePrekeys : [],
      pqPrekeys: Array.isArray(body.pqPrekeys) ? body.pqPrekeys : [],
      bundleId: body.bundleId ?? '',
      keyEpoch: agent.keyEpoch,
      updatedAt: Date.now(),
    };
    if (!agent.devices.includes(body.deviceId)) {
      agent.devices.push(body.deviceId);
      await registry.addDevice(agent.agentId, body.deviceId);
    }
    store.save();

    const spkHash = hexs.enc(keccak_256(b64.dec(body.signedPrekey.pk))) as `0x${string}`;
    const tx = await registry.publishPrekeys(
      agent.agentId, body.deviceId, body.bundleId || body.deviceId, spkHash,
      store.db.prekeys[body.deviceId].oneTimePrekeys.length,
    );

    res.json({
      deviceId: body.deviceId,
      bundleId: body.bundleId,
      oneTimeRemaining: store.db.prekeys[body.deviceId].oneTimePrekeys.length,
      pqRemaining: store.db.prekeys[body.deviceId].pqPrekeys.length,
      registryTx: tx,
    });
  }),
);

/**
 * GET prekey bundle — consumes one one-time prekey per fetch, which is what makes the
 * handshake asynchronous (the recipient may be offline).
 */
agentsRouter.get('/agents/:idOrHandle/prekeys', handler(async (req, res) => {
  const agent = store.resolve(req.params.idOrHandle);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.idOrHandle}`);
  const deviceId = (req.query.deviceId as string | undefined) ?? agent.devices[0];
  const bundle = deviceId ? store.db.prekeys[deviceId] : undefined;
  if (!bundle) throw new AgentLineError('prekeys_exhausted', `agent ${agent.agentId} has not published prekeys yet`);

  const oneTimePrekey = bundle.oneTimePrekeys.shift();
  const pqPrekey = bundle.pqPrekeys.length > 1 ? bundle.pqPrekeys.shift() : bundle.pqPrekeys[0];
  store.save();

  if (bundle.oneTimePrekeys.length < 20) res.setHeader('AgentLine-Prekeys-Low', 'true');
  res.json({
    suite: bundle.suite,
    agentId: bundle.agentId,
    deviceId: bundle.deviceId,
    bundleId: bundle.bundleId,
    ed25519Pk: bundle.ed25519Pk,
    x25519Pk: bundle.x25519Pk,
    signedPrekey: bundle.signedPrekey,
    oneTimePrekey,
    pqPrekey,
    keyEpoch: bundle.keyEpoch,
    oneTimeRemaining: bundle.oneTimePrekeys.length,
    dmPolicy: agent.dmPolicy,
    inboxTopic: agent.inboxTopic,
  });
}));

/* -------------------------------------------------------------- devices, rotation, deletion */

agentsRouter.post('/agents/:agentId/devices', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const agent = store.agent(req.params.agentId);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.agentId}`);
  if (req.agentId !== agent.agentId) throw new AgentLineError('forbidden', 'not your agent');
  const body = requireFields(req.body as Record<string, any>, ['deviceId']);
  if (!agent.devices.includes(body.deviceId)) {
    agent.devices.push(body.deviceId);
    store.save();
    await registry.addDevice(agent.agentId, body.deviceId);
  }
  res.status(201).json({ agentId: agent.agentId, devices: agent.devices });
}));

agentsRouter.delete('/agents/:agentId/devices/:deviceId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const agent = store.agent(req.params.agentId);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.agentId}`);
  if (req.agentId !== agent.agentId) throw new AgentLineError('forbidden', 'not your agent');
  agent.devices = agent.devices.filter((d) => d !== req.params.deviceId);
  delete store.db.prekeys[req.params.deviceId];
  store.save();
  await registry.removeDevice(agent.agentId, req.params.deviceId);
  res.json({ agentId: agent.agentId, devices: agent.devices });
}));

/**
 * Identity rotation. Peers will see a "security code changed" warning, which is the
 * signal that matters: a silent key swap is exactly what an attacker would attempt.
 */
agentsRouter.post('/agents/:agentId/rotate', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const agent = store.agent(req.params.agentId);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.agentId}`);
  if (req.agentId !== agent.agentId) throw new AgentLineError('forbidden', 'not your agent');
  const body = requireFields(req.body as Record<string, any>, ['ed25519Pk', 'x25519Pk', 'guardianSignature']);

  // The rotation must be signed by the *current* identity key (guardian requirement).
  const { verifyBytes } = await import('@agentline/crypto');
  const payload = new TextEncoder().encode(`AGL/ROTATE/v1:${agent.agentId}:${body.ed25519Pk}:${body.x25519Pk}`);
  if (!verifyBytes(agent.ed25519Pk, body.guardianSignature, payload)) {
    throw new AgentLineError('signature_invalid', 'guardianSignature must be made with the current identity key');
  }

  const previous = { ed25519Pk: agent.ed25519Pk, keyEpoch: agent.keyEpoch };
  agent.ed25519Pk = body.ed25519Pk;
  agent.x25519Pk = body.x25519Pk;
  agent.keyEpoch += 1;
  store.save();

  // Key-transparency: the change is published to the agent's profile topic, append-only.
  await ledger().submit(agent.profileTopic, new TextEncoder().encode(JSON.stringify({
    t: 'key_change', agentId: agent.agentId, from: previous, to: { ed25519Pk: body.ed25519Pk, keyEpoch: agent.keyEpoch },
    at: Date.now(),
  })));

  res.json({ agentId: agent.agentId, keyEpoch: agent.keyEpoch, warning: 'peers must re-verify the safety number' });
}));

/** Tombstone + crypto-shred (PRD D6): ciphertext stays on-chain but becomes unreadable. */
agentsRouter.delete('/agents/:agentId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const agent = store.agent(req.params.agentId);
  if (!agent) throw new AgentLineError('agent_not_found', `no agent ${req.params.agentId}`);
  if (req.agentId !== agent.agentId) throw new AgentLineError('forbidden', 'not your agent');

  agent.status = 'deleted';
  if (agent.handle) { delete store.db.handles[agent.handle]; agent.handle = undefined; }
  for (const d of agent.devices) delete store.db.prekeys[d];
  delete store.db.personalIndex[agent.agentId];
  store.save();

  await ledger().submit(agent.profileTopic, new TextEncoder().encode(JSON.stringify({
    t: 'tombstone', agentId: agent.agentId, at: Date.now(),
  })));
  const tx = await registry.tombstone(agent.agentId);

  res.json({
    agentId: agent.agentId, status: 'deleted', registryTx: tx,
    note: 'Prekeys and server-side index removed; on-chain ciphertext remains but is unreadable once the agent destroys its own keys (crypto-shredding).',
  });
}));

/* -------------------------------------------------------------- handles */

agentsRouter.post(
  '/handles/:handle',
  requirePayment((req) => ({ routeKey: 'POST /v1/handles', agentId: (req.body as any)?.agentId })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const handle = normalizeHandle(req.params.handle);
    const agent = store.agent(req.agentId!);
    if (!agent) throw new AgentLineError('agent_not_found', 'register before claiming a handle');
    const owner = store.db.handles[handle];
    if (owner && owner !== agent.agentId) throw new AgentLineError('handle_taken', `@${handle} is taken`);

    if (agent.handle && agent.handle !== handle) delete store.db.handles[agent.handle];
    store.db.handles[handle] = agent.agentId;
    agent.handle = handle;
    store.save();
    const tx = await registry.claimHandle(agent.agentId, handle);
    res.status(201).json({ handle: `@${handle}`, agentId: agent.agentId, expiresInDays: 365, registryTx: tx });
  }),
);

/* -------------------------------------------------------------- directory */

agentsRouter.get('/directory', handler(async (req, res) => {
  const q = String(req.query.q ?? '').toLowerCase();
  const capability = String(req.query.capability ?? '').toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 25), 100);

  const results = Object.values(store.db.agents)
    .filter((a) => a.status === 'active')
    .filter((a) => {
      if (capability) {
        const caps = JSON.stringify(a.profile.capabilities ?? []).toLowerCase();
        if (!caps.includes(capability)) return false;
      }
      if (!q) return true;
      return [a.handle, a.profile.name, a.profile.description, a.agentId]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    })
    .slice(0, limit)
    .map((a) => ({
      agentId: a.agentId, handle: a.handle ? `@${a.handle}` : undefined, profile: a.profile,
      flags: a.flags, dmPolicy: a.dmPolicy, inboxTopic: a.inboxTopic,
    }));

  res.json({ count: results.length, agents: results });
}));

/* -------------------------------------------------------------- webhooks */

agentsRouter.post(
  '/webhooks',
  requirePayment((req) => ({ routeKey: 'POST /v1/webhooks', agentId: (req as AuthedRequest).headers['agentline-key-id'] as string })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const agent = store.agent(req.agentId!);
    if (!agent) throw new AgentLineError('agent_not_found', 'register first');
    const body = requireFields(req.body as Record<string, any>, ['url']);
    try { validateWebhookUrl(body.url); }
    catch (err) { throw new AgentLineError('validation_failed', (err as Error).message); }

    const secret = body.secret ?? b64.enc(crypto.getRandomValues(new Uint8Array(32)));
    agent.webhook = { url: body.url, secret, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
    store.save();
    res.status(201).json({
      url: body.url, expiresAt: agent.webhook.expiresAt, secret,
      note: 'Deliveries are signed: AgentLine-Signature: sha256=HMAC_SHA256(secret, rawBody)',
    });
  }),
);
