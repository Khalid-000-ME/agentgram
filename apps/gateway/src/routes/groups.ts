/**
 * Groups, invites and channels.
 *
 * The contract holds a membership Merkle root, the admin set and the epoch; the roster
 * itself and all content stay encrypted. Membership changes bump the epoch, which is what
 * locks removed members out of later messages.
 */
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import {
  b64, deriveChannelId, deriveCommunityId, deriveGroupId, keccak_256, hexs, membersRoot, randomId, utf8,
} from '@agentline/crypto';
import { AgentLineError } from '@agentline/protocol';
import { config } from '../config.ts';
import { handler, ok, replayIfKnown, requireFields } from '../lib/http.ts';
import { store, type ChannelRecord, type ConversationRecord, type GroupRecord } from '../lib/store.ts';
import { requireSignature, type AuthedRequest } from '../middleware/auth.ts';
import { requirePayment } from '../middleware/x402.ts';
import { registry } from '../services/registry.ts';
import { topicForConversation } from '../services/relay.ts';
import { notify } from '../services/notifier.ts';

export const groupsRouter = Router();

function groupView(g: GroupRecord) {
  const conv = store.db.conversations[g.cid];
  return {
    groupId: g.groupId, cid: g.cid, topicId: g.topicId, name: g.name, creator: g.creator,
    members: g.members, admins: g.admins, memberCount: g.members.length, epoch: g.epoch,
    membersRoot: g.membersRoot, settings: g.settings, createdAt: g.createdAt, registryTx: g.registryTx,
    lastSeq: conv?.lastSeq ?? 0,
  };
}

/* -------------------------------------------------------------- create */

groupsRouter.post(
  '/groups',
  requirePayment((req) => ({ routeKey: 'POST /v1/groups', agentId: req.headers['agentline-key-id'] as string })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    if (replayIfKnown(req, res)) return;
    const me = req.agentId!;
    const body = (req.body ?? {}) as Record<string, any>;
    const requested: string[] = Array.isArray(body.members) ? body.members : [];
    const members = Array.from(new Set([me, ...requested.map((m) => store.resolve(m)?.agentId).filter(Boolean) as string[]]));
    if (members.length > config.limits.maxGroupMembers) {
      throw new AgentLineError('validation_failed', `group exceeds the ${config.limits.maxGroupMembers}-member limit`);
    }

    const groupId = deriveGroupId(me, new Uint8Array(randomBytes(16)));
    const cid = groupId.replace('grp_', 'cnv_');
    const { topicId } = await topicForConversation({ cid, kind: 'group', mode: 'open' });
    const root = membersRoot(members);

    const group: GroupRecord = {
      groupId, cid, topicId, creator: me, members, admins: [me], epoch: 0, membersRoot: root,
      settings: {
        onlyAdminsSend: !!body.onlyAdminsSend,
        adminsAddOnly: !!body.adminsAddOnly,
        sealedMembership: !!body.sealedMembership,
      },
      name: body.name, createdAt: Date.now(),
    };
    const conv: ConversationRecord = {
      cid, kind: 'group', mode: 'open', topicId, participants: members, groupId,
      createdAt: Date.now(), lastSeq: 0, messageCount: 0,
      settings: { onlyAdminsSend: group.settings.onlyAdminsSend },
    };

    store.db.groups[groupId] = group;
    store.db.conversations[cid] = conv;
    for (const m of members) (store.db.convsOfAgent[m] ??= []).push(cid);
    store.save();

    const settingsBits = (group.settings.onlyAdminsSend ? 1 : 0) | (group.settings.adminsAddOnly ? 2 : 0)
      | (group.settings.sealedMembership ? 4 : 0);
    const tx = await registry.createGroup({ groupId, creator: me, topicId, membersRoot: root, members, settings: settingsBits });
    if (tx) { group.registryTx = tx; store.save(); }

    // Every invitee gets an inbox notice so it can fetch the sender-key distribution.
    await Promise.all(members.filter((m) => m !== me).map((m) => notify(m, {
      v: 1, t: 'group_invite', c: cid, topic: topicId, seq: 0, from: me, prio: 'high',
    })));

    ok(req, res, 201, {
      ...groupView(group),
      next: 'Distribute your sender key to each member over your pairwise sessions (message type "sender_key"), then send to this cid.',
    });
  }),
);

groupsRouter.get('/groups/:groupId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const g = store.db.groups[req.params.groupId];
  if (!g) throw new AgentLineError('not_found', `unknown group ${req.params.groupId}`);
  if (!g.members.includes(req.agentId!)) throw new AgentLineError('forbidden', 'not a member of this group');
  res.json(groupView(g));
}));

/* -------------------------------------------------------------- membership */

function requireAdmin(g: GroupRecord, me: string): void {
  if (!g.admins.includes(me)) throw new AgentLineError('forbidden', 'only group admins can do this');
}

async function commit(g: GroupRecord, actor: string, added: string[], removed: string[]) {
  g.epoch += 1;
  g.membersRoot = membersRoot(g.members);
  const conv = store.db.conversations[g.cid];
  if (conv) conv.participants = g.members;
  for (const m of added) (store.db.convsOfAgent[m] ??= []).push(g.cid);
  for (const m of removed) {
    store.db.convsOfAgent[m] = (store.db.convsOfAgent[m] ?? []).filter((c) => c !== g.cid);
  }
  store.save();
  const tx = await registry.commitMembership({
    groupId: g.groupId, actor, added, removed,
    membersRoot: g.membersRoot as `0x${string}`, memberCount: g.members.length,
  });
  if (tx) { g.registryTx = tx; store.save(); }
  await Promise.all(g.members.filter((m) => m !== actor).map((m) => notify(m, {
    v: 1, t: 'group_update', c: g.cid, topic: g.topicId, seq: g.epoch, from: actor, prio: 'high',
  })));
  return tx;
}

groupsRouter.post('/groups/:groupId/members', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const g = store.db.groups[req.params.groupId];
  if (!g) throw new AgentLineError('not_found', `unknown group ${req.params.groupId}`);
  const me = req.agentId!;
  if (g.settings.adminsAddOnly || !g.members.includes(me)) requireAdmin(g, me);
  const body = requireFields(req.body as Record<string, any>, ['members']);
  const toAdd = (body.members as string[])
    .map((m) => store.resolve(m)?.agentId)
    .filter((m): m is string => !!m && !g.members.includes(m));
  if (!toAdd.length) throw new AgentLineError('validation_failed', 'no new members to add');
  if (g.members.length + toAdd.length > config.limits.maxGroupMembers) {
    throw new AgentLineError('validation_failed', `group exceeds the ${config.limits.maxGroupMembers}-member limit`);
  }
  g.members.push(...toAdd);
  const tx = await commit(g, me, toAdd, []);
  res.status(201).json({
    ...groupView(g), added: toAdd, registryTx: tx,
    next: 'Rotate your group epoch key and send a fresh sender_key distribution to all members.',
  });
}));

groupsRouter.delete('/groups/:groupId/members/:agentId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const g = store.db.groups[req.params.groupId];
  if (!g) throw new AgentLineError('not_found', `unknown group ${req.params.groupId}`);
  const me = req.agentId!;
  const target = req.params.agentId;
  const leaving = target === me;
  if (!leaving) requireAdmin(g, me);
  if (!g.members.includes(target)) throw new AgentLineError('not_found', `${target} is not a member`);

  g.members = g.members.filter((m) => m !== target);
  g.admins = g.admins.filter((m) => m !== target);
  const tx = await commit(g, me, [], [target]);
  res.json({
    ...groupView(g), removed: target, left: leaving, registryTx: tx,
    next: 'Remaining members must rotate the group epoch so the removed member cannot read future messages.',
  });
}));

groupsRouter.patch('/groups/:groupId', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const g = store.db.groups[req.params.groupId];
  if (!g) throw new AgentLineError('not_found', `unknown group ${req.params.groupId}`);
  requireAdmin(g, req.agentId!);
  const body = (req.body ?? {}) as Record<string, any>;
  if (body.name !== undefined) g.name = body.name;
  if (body.onlyAdminsSend !== undefined) g.settings.onlyAdminsSend = !!body.onlyAdminsSend;
  if (body.adminsAddOnly !== undefined) g.settings.adminsAddOnly = !!body.adminsAddOnly;
  if (Array.isArray(body.promote)) for (const a of body.promote) if (g.members.includes(a) && !g.admins.includes(a)) g.admins.push(a);
  if (Array.isArray(body.demote)) g.admins = g.admins.filter((a) => a === g.creator || !body.demote.includes(a));
  const conv = store.db.conversations[g.cid];
  if (conv) conv.settings.onlyAdminsSend = g.settings.onlyAdminsSend;
  store.save();
  res.json(groupView(g));
}));

/* -------------------------------------------------------------- invites */

groupsRouter.post('/groups/:groupId/invites', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const g = store.db.groups[req.params.groupId];
  if (!g) throw new AgentLineError('not_found', `unknown group ${req.params.groupId}`);
  requireAdmin(g, req.agentId!);
  const body = (req.body ?? {}) as Record<string, any>;
  const code = randomId('inv', 16);
  const expiresAt = Date.now() + Number(body.ttlSeconds ?? 7 * 24 * 3600) * 1000;
  const usesLeft = Number(body.maxUses ?? 10);
  // Only the hash is stored on-chain; the code itself is a bearer secret.
  const inviteHash = hexs.enc(keccak_256(utf8.enc(code))) as `0x${string}`;
  store.db.invites[code] = { groupId: g.groupId, expiresAt, usesLeft };
  store.save();
  const tx = await registry.createInvite(g.groupId, req.agentId!, inviteHash, Math.floor(expiresAt / 1000), usesLeft);
  res.status(201).json({
    code, link: `agentline://join/${code}`, url: `${config.publicUrl}/v1/invites/${code}:join`,
    expiresAt, maxUses: usesLeft, registryTx: tx,
  });
}));

groupsRouter.post('/invites/:code\\:join', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const invite = store.db.invites[req.params.code];
  if (!invite) throw new AgentLineError('not_found', 'invite code is unknown');
  if (invite.expiresAt < Date.now()) throw new AgentLineError('forbidden', 'invite code has expired');
  if (invite.usesLeft <= 0) throw new AgentLineError('forbidden', 'invite code is exhausted');
  const g = store.db.groups[invite.groupId];
  if (!g) throw new AgentLineError('not_found', 'group no longer exists');
  const me = req.agentId!;
  if (g.members.includes(me)) { res.json({ ...groupView(g), alreadyMember: true }); return; }

  invite.usesLeft -= 1;
  g.members.push(me);
  store.save();
  const inviteHash = hexs.enc(keccak_256(utf8.enc(req.params.code))) as `0x${string}`;
  await registry.redeemInvite(inviteHash, me, membersRoot(g.members) as `0x${string}`, g.members.length);
  await commit(g, me, [me], []);
  res.status(201).json({ ...groupView(g), joined: true });
}));

/* -------------------------------------------------------------- channels */

groupsRouter.post(
  '/channels',
  requirePayment((req) => ({ routeKey: 'POST /v1/channels', agentId: req.headers['agentline-key-id'] as string })),
  requireSignature(),
  handler<AuthedRequest>(async (req, res) => {
    const me = req.agentId!;
    const body = (req.body ?? {}) as Record<string, any>;
    const channelId = deriveChannelId(me, new Uint8Array(randomBytes(16)));
    const cid = channelId.replace('chn_', 'cnv_');
    const { topicId } = await topicForConversation({ cid, kind: 'channel', mode: 'open' });

    const channel: ChannelRecord = {
      channelId, cid, topicId, owner: me, encrypted: !!body.encrypted, followers: [],
      name: body.name, description: body.description, createdAt: Date.now(),
    };
    store.db.channels[channelId] = channel;
    store.db.conversations[cid] = {
      cid, kind: 'channel', mode: 'open', topicId, participants: [me], channelId,
      createdAt: Date.now(), lastSeq: 0, messageCount: 0, settings: {},
    };
    (store.db.convsOfAgent[me] ??= []).push(cid);
    store.save();
    const tx = await registry.createChannel(channelId, me, topicId, channel.encrypted);
    res.status(201).json({
      channelId, cid, topicId, owner: me, encrypted: channel.encrypted, followers: 0, registryTx: tx,
      note: channel.encrypted
        ? 'Subscriber-encrypted channel: distribute the epoch key only to paying followers.'
        : 'Public channel: posts are signed but readable by anyone reading the topic.',
    });
  }),
);

groupsRouter.post('/channels/:channelId\\:follow', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const c = store.db.channels[req.params.channelId];
  if (!c) throw new AgentLineError('not_found', `unknown channel ${req.params.channelId}`);
  const me = req.agentId!;
  const following = (req.body as any)?.following !== false;
  c.followers = following ? Array.from(new Set([...c.followers, me])) : c.followers.filter((f) => f !== me);
  const cids = (store.db.convsOfAgent[me] ??= []);
  if (following && !cids.includes(c.cid)) cids.push(c.cid);
  if (!following) store.db.convsOfAgent[me] = cids.filter((x) => x !== c.cid);
  store.save();
  await registry.setFollowing(c.channelId, me, following);
  // Follower identities stay private; only the count is public (like WhatsApp Channels).
  res.json({ channelId: c.channelId, cid: c.cid, following, followerCount: c.followers.length });
}));

groupsRouter.get('/channels/:channelId', handler(async (req, res) => {
  const c = store.db.channels[req.params.channelId];
  if (!c) throw new AgentLineError('not_found', `unknown channel ${req.params.channelId}`);
  res.json({
    channelId: c.channelId, cid: c.cid, topicId: c.topicId, owner: c.owner, name: c.name,
    description: c.description, encrypted: c.encrypted, followerCount: c.followers.length, createdAt: c.createdAt,
  });
}));

/* -------------------------------------------------------------- communities */

groupsRouter.post('/communities', requireSignature(), handler<AuthedRequest>(async (req, res) => {
  const me = req.agentId!;
  const agent = store.agent(me);
  if (!agent) throw new AgentLineError('agent_not_found', 'register first');
  const body = (req.body ?? {}) as Record<string, any>;
  const communityId = deriveCommunityId(me, new Uint8Array(randomBytes(16)));
  // A community is an umbrella over groups the caller already administers.
  const groupIds: string[] = (Array.isArray(body.groups) ? body.groups : [])
    .filter((g: string) => store.db.groups[g]?.admins.includes(me));

  const communities = ((agent.profile as Record<string, unknown>).communities ??= []) as unknown[];
  communities.push({ communityId, name: body.name, groups: groupIds, createdAt: Date.now() });
  store.save();

  res.status(201).json({
    communityId, name: body.name, groups: groupIds, owner: me,
    note: 'Communities group existing groups under one umbrella; each group keeps its own encryption epoch.',
  });
}));
