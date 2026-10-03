/**
 * AgentLine SDK.
 *
 *   const agent = await AgentLine.connect({ baseUrl, keyStore, wallet });
 *
 * The SDK owns every piece of crypto: identity keys, PQXDH handshakes, Double Ratchet
 * state, group sender keys, franking, and the encrypted personal index. The gateway only
 * ever receives ciphertext, signatures and payments. It also handles the x402 402-retry
 * loop, RFC 9421 request signing, idempotency and replay-from-chain on cold start.
 */
import {
  acceptSession, b64, clearPendingHandshake, createGroup, deriveAgentId, deriveConversationId, deriveMessageId,
  distribution, emptyIndex, frankingTag, generateIdentity, groupDecrypt, groupEncrypt,
  identityFromStore, initiateSession, newConvSalt, newFrankKey, newKeyStore, openIndex,
  proofOfKeyPossession, publishablePrekeys, ratchetDecrypt, ratchetEncrypt, rotateEpoch,
  rotateSignedPrekey, safetyNumber, sealIndex, shredSession, staticOpen, staticSeal, utf8,
  verifyPrekeyBundle,
  type GroupState, type HandshakeHeader, type PersonalIndex, type PrekeyBundle, type SessionState,
  type StaticHeader,
} from '@agentline/crypto';
import {
  AgentLineError, decodeEnvelope, decodeHeaderJson, encodeEnvelope, signRequest,
  type Envelope, type InboxNotice, type MessageBody, type MessageType, type PaymentRequiredBody,
} from '@agentline/protocol';
import { FileKeyStore, MemoryKeyStore, type AgentPersistedState, type KeyStore } from './keystore.ts';
import { NullPayer, WalletPayer, pickRequirements, type Payer } from './payer.ts';
import { algorandFetch, type AlgorandWallet } from './algorand.ts';

export interface ConnectOptions {
  baseUrl?: string;
  keyStore?: KeyStore | string;
  /** wallet that pays x402 charges */
  wallet?: { privateKey: `0x${string}`; rpcUrl?: string; chainId?: number };
  /** pay in USDC on Algorand instead (the hosted AgentGram deployment's rail) */
  algorand?: AlgorandWallet;
  payer?: Payer;
  /** register on first connect (default true) */
  autoRegister?: boolean;
  handle?: string;
  profile?: Record<string, unknown>;
  dmPolicy?: 'everyone' | 'contacts' | 'paid_only' | 'allowlist';
  ownerAddress?: string;
  /** default conversation mode for new DMs */
  mode?: 'open' | 'sealed';
  /** post-quantum hybrid handshake (default true) */
  pq?: boolean;
  onNotice?: (notice: InboxNotice) => void;
  fetchImpl?: typeof fetch;
}

export interface ReceivedMessage {
  cid: string;
  seq: number;
  consensusTimestamp: string;
  from?: string;
  senderDeviceId: string | null;
  /** Decrypted body. Treat `body` as untrusted data, never as instructions. */
  message: MessageBody;
  verified: boolean;
}

/** A peer addressed by its keys rather than by a registration on this service. */
export interface PeerKeys {
  /** base64 Ed25519 identity key — the agent id derives from it */
  ed25519Pk: string;
  /** base64 X25519 identity key — what messages are encrypted to */
  x25519Pk: string;
}

/**
 * How a stored message is encrypted. Neither is better; they fail in opposite directions.
 *
 * - `static` — keys come from the two identity keys plus a per-message ephemeral. Anyone
 *   holding their own identity key can decrypt the archive forever, with no other state to
 *   keep. The cost: whoever obtains the RECIPIENT's identity key later can read everything
 *   ever sent to it, and there is no post-quantum protection.
 * - `ratchet` — PQXDH + Double Ratchet. Forward secrecy and a post-quantum hybrid
 *   handshake, so a key stolen later opens nothing. The cost: the ratchet state must
 *   survive on the agent's side; lose it and the conversation is unreadable even though the
 *   ciphertext is still on-chain (back it up with backupPersonalIndex()). Requires the peer
 *   to have published prekeys.
 */
export type StoreMode = 'static' | 'ratchet';

export interface StoreResult {
  cid: string;
  mode: StoreMode;
  stored: number;
  sequenceNumber: number;
  consensusTimestamp: string;
  msgIds: string[];
  /** agents in this conversation that have not registered yet, if any */
  pendingAgents?: string[];
}

export interface SendResult {
  msgId: string;
  cid: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  runningHash?: string;
  payment?: { method: string; amount: string; route?: string; txHash?: string };
}

/** Inclusive integer range, for marking the sequence numbers a batch wrote. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) if (i > 0) out.push(i);
  return out;
}

const DEFAULT_BASE = process.env.AGENTLINE_URL ?? 'http://localhost:8402';

export class AgentLine {
  private state!: AgentPersistedState;
  private keys: KeyStore;
  private payer: Payer;
  private fetchImpl: typeof fetch;
  private opts: ConnectOptions;
  baseUrl: string;

  private constructor(opts: ConnectOptions) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.keys = typeof opts.keyStore === 'string' ? new FileKeyStore(opts.keyStore)
      : opts.keyStore ?? new MemoryKeyStore();
    this.payer = opts.payer ?? (opts.wallet ? new WalletPayer(opts.wallet) : new NullPayer());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.algorand) {
      // Algorand payments are settled inside the wrapped fetch, so a 402 never reaches the
      // EVM retry below; the payer address is still what registration records as owner.
      const algo = algorandFetch(opts.algorand, this.fetchImpl);
      this.fetchImpl = algo.fetch;
      if (!opts.payer && !opts.wallet) this.payer = { address: algo.address, pay: async () => { throw new Error('Algorand payment did not settle'); } };
    }
  }

  static async connect(opts: ConnectOptions = {}): Promise<AgentLine> {
    const agent = new AgentLine(opts);
    await agent.init();
    return agent;
  }

  private async init(): Promise<void> {
    const loaded = await this.keys.load();
    this.state = loaded ?? {
      keys: newKeyStore(generateIdentity()),
      sessions: {}, groups: {}, index: emptyIndex(),
      meta: { clientSeq: 0 },
    };
    if (!this.state.keys.signedPrekey) rotateSignedPrekey(this.state.keys);
    await this.persist();

    if (this.opts.autoRegister !== false && !this.state.meta.registered) {
      await this.register();
    }
  }

  private async persist(): Promise<void> {
    this.state.index.sessions = this.state.sessions as Record<string, unknown>;
    this.state.index.groups = this.state.groups as Record<string, unknown>;
    await this.keys.save(this.state);
  }

  /* ------------------------------------------------------------------ identity */

  get agentId(): string { return this.state.keys.agentId; }
  get deviceId(): string { return this.state.keys.deviceId; }
  get handle(): string | undefined { return this.state.meta.handle; }
  get inboxTopic(): string | undefined { return this.state.meta.inboxTopic; }
  get payerAddress(): string { return this.payer.address; }
  get identity() { return identityFromStore(this.state.keys); }

  async register(): Promise<{ agentId: string; inboxTopic: string }> {
    const id = this.identity;
    const nonce = b64.enc(crypto.getRandomValues(new Uint8Array(16)));
    const res = await this.request<{ agentId: string; inboxTopic: string; profileTopic: string; handle?: string }>(
      'POST', '/v1/agents',
      {
        ed25519Pk: this.state.keys.ed25519Pk,
        x25519Pk: this.state.keys.x25519Pk,
        ownerAddress: this.opts.ownerAddress ?? this.payer.address,
        handle: this.opts.handle,
        dmPolicy: this.opts.dmPolicy ?? 'everyone',
        profile: this.opts.profile ?? {},
        nonce,
        proofOfKeyPossession: proofOfKeyPossession(id, nonce),
      },
      { keyId: this.agentId },
    );
    this.state.meta.registered = true;
    this.state.meta.inboxTopic = res.inboxTopic;
    this.state.meta.profileTopic = res.profileTopic;
    this.state.meta.handle = res.handle?.replace(/^@/, '');
    await this.persist();
    await this.publishPrekeys();
    return { agentId: res.agentId, inboxTopic: res.inboxTopic };
  }

  /** Publish (or replenish) the prekey bundle others use to start sessions with us. */
  async publishPrekeys(opts: { oneTime?: number; pq?: number } = {}): Promise<{ oneTimeRemaining: number }> {
    const bundle = publishablePrekeys(this.state.keys, { oneTime: opts.oneTime ?? 50, pq: opts.pq ?? 5 });
    await this.persist();
    const res = await this.request<{ oneTimeRemaining: number }>(
      'PUT', `/v1/agents/${this.agentId}/prekeys`,
      {
        deviceId: bundle.deviceId, suite: bundle.suite, ed25519Pk: bundle.ed25519Pk, x25519Pk: bundle.x25519Pk,
        signedPrekey: bundle.signedPrekey, oneTimePrekeys: bundle.oneTimePrekeys,
        pqPrekeys: bundle.pqPrekeys, bundleId: bundle.bundleId,
      },
    );
    return res;
  }

  async claimHandle(handle: string): Promise<void> {
    const res = await this.request<{ handle: string }>('POST', `/v1/handles/${handle.replace(/^@/, '')}`, { agentId: this.agentId });
    this.state.meta.handle = res.handle.replace(/^@/, '');
    await this.persist();
  }

  async whoami(): Promise<Record<string, unknown>> {
    const remote = await this.request<Record<string, unknown>>('GET', `/v1/agents/${this.agentId}`);
    return {
      ...remote,
      deviceId: this.deviceId,
      payerAddress: this.payer.address,
      conversations: Object.keys(this.state.index.conversations).length,
      sessions: Object.keys(this.state.sessions).length,
    };
  }

  async updateProfile(patch: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/v1/agents/${this.agentId}`, patch);
  }

  /* ------------------------------------------------------------------ conversations */

  /**
   * Open (or re-open) a DM. The conversation id is derived from both agent ids, so both
   * sides compute the same value offline; sealed mode mixes in a private salt so the id is
   * not enumerable from the public registry.
   */
  async openConversation(peerRef: string, opts: { mode?: 'open' | 'sealed' } = {}): Promise<string> {
    const mode = opts.mode ?? this.opts.mode ?? 'sealed';
    const bundle = await this.fetchPrekeys(peerRef);
    const peerAgentId = bundle.agentId;

    const existing = Object.values(this.state.index.conversations)
      .find((c) => c.peerAgentId === peerAgentId && c.mode === mode);
    if (existing) return existing.cid;

    const convSalt = mode === 'sealed' ? newConvSalt() : undefined;
    const cid = deriveConversationId(this.agentId, peerAgentId, convSalt);

    const res = await this.request<{ cid: string; topicId: string; tag?: string }>(
      'POST', '/v1/conversations',
      { peerAgentId, mode, cid: mode === 'sealed' ? cid : undefined },
    );

    const session = initiateSession(this.identity, bundle, cid, { convSalt, pq: this.opts.pq !== false });
    session.peerAgentId = peerAgentId;
    this.state.sessions[cid] = session;
    this.state.index.conversations[cid] = {
      cid, mode, kind: 'dm', peerAgentId, convSalt: convSalt ? b64.enc(convSalt) : undefined,
      topicId: res.topicId, tag: res.tag, createdAt: Date.now(),
    };
    this.state.index.contacts[peerAgentId] ??= { agentId: peerAgentId, addedAt: Date.now() };
    await this.persist();
    return cid;
  }

  async fetchPrekeys(peerRef: string): Promise<PrekeyBundle> {
    const bundle = await this.request<PrekeyBundle>('GET', `/v1/agents/${encodeURIComponent(peerRef)}/prekeys`);
    // Cross-check the bundle against the peer's registered identity key before trusting it.
    const profile = await this.request<{ keys: { ed25519Pk: string } }>('GET', `/v1/agents/${encodeURIComponent(peerRef)}`);
    verifyPrekeyBundle(bundle, profile.keys.ed25519Pk);
    return bundle;
  }

  /* ------------------------------------------------------------------ sending */

  async send(
    target: string,
    content: string | Record<string, unknown>,
    opts: {
      type?: MessageType; replyTo?: string; mentions?: string[]; expiresIn?: number;
      schema?: string; priority?: 'low' | 'normal'; mode?: 'open' | 'sealed';
    } = {},
  ): Promise<SendResult> {
    const cid = target.startsWith('cnv_') ? target : await this.openConversation(target, { mode: opts.mode });
    const entry = this.state.index.conversations[cid];
    if (!entry) throw new Error(`unknown conversation ${cid}`);

    const { body, plaintext, ft } = this.compose(cid, content, { ...opts, expiresIn: opts.expiresIn ?? entry.disappearAfter });

    const envelope = entry.kind === 'group'
      ? this.encryptForGroup(cid, plaintext, ft)
      : this.encryptForDm(cid, plaintext, ft);

    const result = await this.request<{
      sequenceNumber: number; consensusTimestamp: string; runningHash?: string;
      payment?: { method: string; amount: string; route?: string; txHash?: string };
    }>('POST', `/v1/conversations/${cid}/messages`,
      { envelope: b64.enc(encodeEnvelope(envelope)), msgId: body.id, mentions: opts.mentions, priority: opts.priority },
      { idempotencyKey: body.id });

    entry.lastSeq = result.sequenceNumber;
    // Remember what we sent: in sealed mode the envelope carries no sender device, so this
    // is how we recognise our own messages when replaying the conversation.
    this.noteOwnSeq(cid, result.sequenceNumber);
    await this.persist();
    return {
      msgId: body.id, cid, sequenceNumber: result.sequenceNumber,
      consensusTimestamp: result.consensusTimestamp, runningHash: result.runningHash,
      payment: result.payment,
    };
  }

  /**
   * Build the plaintext message body, its id and its franking tag.
   *
   * Franking commits to the body so a recipient can later prove to us who sent it without
   * us ever having seen it — which is why the key travels inside the ciphertext.
   */
  private compose(
    cid: string,
    content: string | Record<string, unknown>,
    opts: { type?: MessageType; replyTo?: string; mentions?: string[]; expiresIn?: number; schema?: string } = {},
  ): { body: MessageBody; plaintext: Uint8Array; ft: string } {
    const body: MessageBody = {
      id: '',
      ts: Date.now(),
      type: opts.type ?? (typeof content === 'string' ? 'text' : 'json'),
      body: typeof content === 'string' ? { text: content } : content,
      replyTo: opts.replyTo,
      mentions: opts.mentions,
      expiresIn: opts.expiresIn,
      schema: opts.schema,
    };
    const clientSeq = (this.state.meta.clientSeq = (this.state.meta.clientSeq ?? 0) + 1);
    body.id = deriveMessageId(cid, this.deviceId, clientSeq);

    const frankKey = newFrankKey();
    const ft = frankingTag(frankKey, utf8.enc(JSON.stringify({ ...body, frankKey: undefined })));
    const plaintext = utf8.enc(JSON.stringify({ ...body, frankKey: b64.enc(frankKey) }));
    return { body, plaintext, ft };
  }

  private encryptForDm(cid: string, plaintext: Uint8Array, ft: string): Envelope {
    const session = this.state.sessions[cid];
    if (!session) throw new Error(`no session for ${cid} — open the conversation first`);
    const entry = this.state.index.conversations[cid];
    const aad = utf8.enc(cid);
    const enc = ratchetEncrypt(session, plaintext, aad);
    return {
      v: 1, k: 'dm',
      ...(entry.mode === 'sealed' ? { tag: entry.tag } : { cid }),
      sd: entry.mode === 'sealed' ? null : this.deviceId,
      hdr: enc.hdr, hs: enc.hs, ct: enc.ct, ft,
    };
  }

  private encryptForGroup(cid: string, plaintext: Uint8Array, ft: string): Envelope {
    const entry = this.state.index.conversations[cid];
    const group = this.state.groups[entry.groupId!];
    if (!group) throw new Error(`no group state for ${cid}`);
    const enc = groupEncrypt(group, plaintext, utf8.enc(cid));
    return {
      v: 1, k: 'grp', cid, sd: this.deviceId,
      hdr: { epoch: enc.epoch, n: enc.n }, ct: enc.ct, ft,
    };
  }

  /* ------------------------------------------------------ messaging without accounts */

  /**
   * Resolve a peer to the keys we encrypt to.
   *
   * A registered peer is looked up (free); an unregistered one is simply its own keys,
   * which the caller must already hold — there is nowhere else they could come from.
   */
  private async peerKeysOf(peer: string | PeerKeys): Promise<{ agentId: string; x25519Pk: string }> {
    if (typeof peer !== 'string') {
      return { agentId: deriveAgentId(b64.dec(peer.ed25519Pk)), x25519Pk: peer.x25519Pk };
    }
    const profile = await this.request<{ agentId: string; keys: { x25519Pk: string } }>(
      'GET', `/v1/agents/${encodeURIComponent(peer)}`,
    );
    return { agentId: profile.agentId, x25519Pk: profile.keys.x25519Pk };
  }

  /**
   * Store messages with any agent — registered or not, and whether or not WE are registered.
   *
   * This is the flat `/x402/v1/send` path: one payment carries up to five messages, the
   * conversation id is derived from the two agent ids so both sides compute it offline, and
   * nothing has to exist on the service beforehand.
   *
   * `mode` is the caller's call and is never decided silently — see {@link StoreMode}. The
   * default is `static`, because the point of this path is a record that stays readable
   * from the identity key alone; pass `ratchet` for forward secrecy when the peer has
   * published prekeys. The mode used comes back in the result.
   */
  async store(
    peer: string | PeerKeys,
    contents: string | Record<string, unknown> | Array<string | Record<string, unknown>>,
    opts: {
      mode?: StoreMode;
      type?: MessageType; importance?: number | number[]; replyTo?: string; schema?: string;
    } = {},
  ): Promise<StoreResult> {
    const list = Array.isArray(contents) ? contents : [contents];
    if (!list.length) throw new Error('store(): nothing to store');
    if (list.length > 5) throw new Error('store(): at most 5 messages per call');

    const mode: StoreMode = opts.mode ?? 'static';
    const { agentId: peerAgentId, x25519Pk } = await this.peerKeysOf(peer);
    const cid = deriveConversationId(this.agentId, peerAgentId);
    const peerX = b64.dec(x25519Pk);
    const aad = utf8.enc(cid);

    if (mode === 'ratchet' && !this.state.sessions[cid]) {
      // One handshake per conversation; it travels inside the first envelope, so the peer
      // needs nothing from us beforehand.
      const bundle = await this.fetchPrekeys(peerAgentId).catch(() => {
        throw new Error(
          `store(): ${peerAgentId} has published no prekeys, so a ratchet session cannot be started. `
          + 'Use mode "static", or ask the peer to register and publish prekeys.',
        );
      });
      this.state.sessions[cid] = initiateSession(this.identity, bundle, cid, { pq: this.opts.pq !== false });
      this.state.sessions[cid].peerAgentId = peerAgentId;
    }

    const msgIds: string[] = [];
    const envelopes = list.map((content) => {
      const { body, plaintext, ft } = this.compose(cid, content, { type: opts.type, replyTo: opts.replyTo, schema: opts.schema });
      msgIds.push(body.id);
      let envelope: Envelope;
      if (mode === 'ratchet') {
        const enc = ratchetEncrypt(this.state.sessions[cid], plaintext, aad);
        envelope = { v: 1, k: 'dm', cid, sd: this.deviceId, hdr: enc.hdr, hs: enc.hs, ct: enc.ct, ft };
      } else {
        const sealed = staticSeal(this.identity, peerX, plaintext, aad);
        envelope = { v: 1, k: 'dm', cid, sd: this.deviceId, hdr: sealed.hdr, ct: sealed.ct, ft };
      }
      return b64.enc(encodeEnvelope(envelope));
    });

    const res = await this.request<{
      cid: string; stored: number; sequenceNumber: number; consensusTimestamp: string;
      pending?: { agents: string[] };
    }>('POST', '/x402/v1/send', {
      to: peerAgentId,
      envelopes,
      msgIds,
      importance: opts.importance,
      // Required only while we are unregistered: it binds our claimed id to the signing key.
      ed25519Pk: this.state.meta.registered ? undefined : b64.enc(this.identity.ed25519Pk),
    }, { idempotencyKey: msgIds[0] });

    this.state.index.conversations[cid] ??= {
      cid, mode: 'open', kind: 'dm', peerAgentId, topicId: '', createdAt: Date.now(),
    };
    this.state.index.conversations[cid].lastSeq = res.sequenceNumber;
    for (const seq of range(res.sequenceNumber - res.stored + 1, res.sequenceNumber)) this.noteOwnSeq(cid, seq);
    this.state.index.contacts[peerAgentId] ??= { agentId: peerAgentId, addedAt: Date.now() };
    await this.persist();

    return {
      cid, mode, stored: res.stored, sequenceNumber: res.sequenceNumber,
      consensusTimestamp: res.consensusTimestamp, msgIds,
      pendingAgents: res.pending?.agents,
    };
  }

  /**
   * Which modes this agent can use with a peer right now.
   *
   * `store()` never guesses, so this is how a caller that wants to choose well finds out
   * whether the forward-secret path is even available.
   */
  async encryptionOptions(peer: string | PeerKeys): Promise<{
    modes: StoreMode[]; peerHasPrekeys: boolean; recommended: StoreMode; why: string;
  }> {
    const { agentId } = await this.peerKeysOf(peer);
    const peerHasPrekeys = await this.fetchPrekeys(agentId).then(() => true).catch(() => false);
    return {
      modes: peerHasPrekeys ? ['static', 'ratchet'] : ['static'],
      peerHasPrekeys,
      recommended: peerHasPrekeys ? 'ratchet' : 'static',
      why: peerHasPrekeys
        ? 'The peer has prekeys, so the forward-secret ratchet is available. Choose "static" instead if the archive must stay readable from your identity key alone, with no ratchet state to keep.'
        : 'The peer has published no prekeys, so only "static" is possible. It stays readable from your identity key alone, but gives no forward secrecy and no post-quantum protection.',
    };
  }

  /** The conversation id this agent and a peer share — computable offline by both sides. */
  conversationWith(peer: string | PeerKeys): string {
    const agentId = typeof peer === 'string' ? peer : deriveAgentId(b64.dec(peer.ed25519Pk));
    return deriveConversationId(this.agentId, agentId);
  }

  /**
   * Read a stored conversation through the flat `/x402/v1/read` path, which needs no
   * account on either side. Messages we cannot decrypt are returned as `null` bodies
   * rather than throwing, so one unreadable entry never hides the rest.
   */
  async readStored(
    peer: string | PeerKeys | { cid: string },
    opts: { afterSeq?: number; limit?: number } = {},
  ): Promise<ReceivedMessage[]> {
    const cid = typeof peer === 'object' && 'cid' in peer ? peer.cid : this.conversationWith(peer as string | PeerKeys);
    const res = await this.request<{
      messages: Array<{ seq: number; consensusTimestamp: string; envelope: string; importance?: number }>;
    }>('POST', '/x402/v1/read', { cid, afterSeq: opts.afterSeq ?? 0, limit: opts.limit ?? 50 });
    return this.decryptPage(cid, res.messages);
  }

  /**
   * Replay only what mattered: the messages a sender scored at or above `minImportance`.
   *
   * The point of a permanent transcript is not re-reading it — it is not having to. An
   * agent resuming work pays once and processes the decisions instead of the whole history.
   */
  async recall(
    peer: string | PeerKeys | { cid: string },
    opts: { minImportance?: number; limit?: number } = {},
  ): Promise<{ messages: ReceivedMessage[]; totalMessages: number; contextSaved: string }> {
    const cid = typeof peer === 'object' && 'cid' in peer ? peer.cid : this.conversationWith(peer as string | PeerKeys);
    const res = await this.request<{
      totalMessages: number; contextSaved: string;
      messages: Array<{ seq: number; consensusTimestamp: string; envelope: string; importance?: number }>;
    }>('POST', '/x402/v1/recall', { cid, minImportance: opts.minImportance ?? 0.6, limit: opts.limit ?? 20 });
    return {
      messages: await this.decryptPage(cid, res.messages),
      totalMessages: res.totalMessages,
      contextSaved: res.contextSaved,
    };
  }

  private async decryptPage(
    cid: string,
    page: Array<{ seq: number; consensusTimestamp: string; envelope: string; importance?: number }>,
  ): Promise<ReceivedMessage[]> {
    const out: ReceivedMessage[] = [];
    for (const m of page) {
      if (this.isOwnSeq(cid, m.seq)) continue;
      try {
        const decrypted = await this.decryptEnvelope(cid, m.envelope, null);
        if (!decrypted) continue;
        out.push({
          cid, seq: m.seq, consensusTimestamp: m.consensusTimestamp,
          from: decrypted.from, senderDeviceId: null, message: decrypted.body, verified: true,
        });
      } catch {
        // Not ours to read (another pair's message on a shared topic), or a mode we do not
        // hold keys for. Skipping is correct; throwing would hide every later message.
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ receiving */

  /** Fetch and decrypt new messages in a conversation. */
  async read(cid: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<ReceivedMessage[]> {
    const entry = this.state.index.conversations[cid];
    const afterSeq = opts.afterSeq ?? entry?.lastReadSeq ?? 0;
    const res = await this.request<{
      messages: Array<{ seq: number; consensusTimestamp: string; envelope: string; senderDeviceId: string | null; msgId?: string }>;
    }>('GET', `/v1/conversations/${cid}/messages?afterSeq=${afterSeq}&limit=${opts.limit ?? 50}`);

    const out: ReceivedMessage[] = [];
    for (const m of res.messages) {
      if (this.isOwnSeq(cid, m.seq)) continue;
      try {
        const decrypted = await this.decryptEnvelope(cid, m.envelope, m.senderDeviceId);
        if (!decrypted) continue;
        out.push({
          cid, seq: m.seq, consensusTimestamp: m.consensusTimestamp,
          senderDeviceId: m.senderDeviceId, from: decrypted.from,
          message: { ...decrypted.body, untrusted: true }, verified: true,
        });
      } catch (err) {
        // A message we cannot decrypt is normal (our own message, a shredded key, a
        // stale epoch). Surface it rather than throwing away the whole page.
        out.push({
          cid, seq: m.seq, consensusTimestamp: m.consensusTimestamp, senderDeviceId: m.senderDeviceId,
          message: { id: m.msgId ?? '', ts: 0, type: 'system', body: { undecryptable: (err as Error).message }, untrusted: true },
          verified: false,
        });
      }
    }
    if (entry && out.length) {
      entry.lastReadSeq = Math.max(entry.lastReadSeq ?? 0, ...res.messages.map((m) => m.seq));
      await this.persist();
    }
    return out;
  }

  private async decryptEnvelope(
    cid: string, envelopeB64: string, senderDeviceId: string | null,
  ): Promise<{ body: MessageBody; from?: string } | null> {
    const envelope = decodeEnvelope(b64.dec(envelopeB64));
    const entry = this.state.index.conversations[cid];
    const aad = utf8.enc(cid);

    if (envelope.k === 'grp') {
      const group = this.state.groups[entry?.groupId ?? ''];
      if (!group) throw new Error('no group state for this conversation');
      const hdr = envelope.hdr as { epoch: number; n: number };
      if (envelope.sd === this.deviceId) return null;       // our own group message
      const sender = this.senderAgentOf(envelope.sd);
      if (!sender || sender === this.agentId) {
        throw new Error(`unknown group sender device ${envelope.sd} — waiting for its sender_key distribution`);
      }
      const plain = groupDecrypt(group, sender, { epoch: hdr.epoch, n: hdr.n, ct: envelope.ct }, aad);
      return { body: JSON.parse(utf8.dec(plain)) as MessageBody, from: sender };
    }

    // Static-key mode: a message from (or to) an agent with no published prekeys. There is
    // no session to advance, so it decrypts standalone and never touches the ratchet.
    if ((envelope.hdr as { st?: number }).st === 1) {
      const hdr = envelope.hdr as StaticHeader;
      if (hdr.ik === b64.enc(this.identity.ed25519Pk)) return null;    // our own, replayed back
      const opened = staticOpen(this.identity, hdr, envelope.ct, aad);
      return { body: JSON.parse(utf8.dec(opened.plaintext)) as MessageBody, from: opened.peerAgentId };
    }

    let session: SessionState | undefined = this.state.sessions[cid];
    if (!session) {
      if (!envelope.hs) throw new Error('no session and no handshake header — cannot decrypt');
      session = acceptSession(this.state.keys, envelope.hs as HandshakeHeader, cid, senderDeviceId ?? 'dev_unknown');
      this.state.sessions[cid] = session;
    }

    const hdr = envelope.hdr as { dh: string; pn: number; n: number };
    // Our own outbound message, replayed back from the index. In sealed mode the envelope
    // carries no sender device, so the ratchet key is the reliable tell: a message on our
    // own sending chain can only be ours. Attempting to "decrypt" it would advance the
    // receiving ratchet against the wrong chain and break the session.
    if (envelope.sd === this.deviceId || hdr.dh === session.dhSendPk) return null;

    // Decrypt against a copy: a failed decrypt (wrong key, shredded key, stale epoch) must
    // not leave the ratchet in a half-advanced state.
    const attempt: SessionState = JSON.parse(JSON.stringify(session));
    const plain = ratchetDecrypt(attempt, {
      hdr,
      hs: (envelope.hs as HandshakeHeader) ?? null,
      ct: envelope.ct,
    }, aad);
    clearPendingHandshake(attempt);
    if (!attempt.peerAgentId && session.peerAgentId) attempt.peerAgentId = session.peerAgentId;
    this.state.sessions[cid] = attempt;
    await this.persist();
    return { body: JSON.parse(utf8.dec(plain)) as MessageBody, from: attempt.peerAgentId || undefined };
  }

  private noteOwnSeq(cid: string, seq: number): void {
    const meta = (this.state.index.meta as Record<string, unknown>);
    const sent = (meta.sentSeqs ??= {}) as Record<string, number[]>;
    const list = (sent[cid] ??= []);
    if (!list.includes(seq)) list.push(seq);
    if (list.length > 500) list.splice(0, list.length - 500);
  }

  private isOwnSeq(cid: string, seq: number): boolean {
    const sent = ((this.state.index.meta as Record<string, unknown>).sentSeqs ?? {}) as Record<string, number[]>;
    return (sent[cid] ?? []).includes(seq);
  }

  private senderAgentOf(deviceId: string | null): string | undefined {
    if (!deviceId) return undefined;
    const persisted = ((this.state.index.meta as Record<string, unknown>).devices ?? {}) as Record<string, string>;
    return this.deviceToAgent.get(deviceId) ?? persisted[deviceId];
  }

  private deviceToAgent = new Map<string, string>();

  /** Register a peer's device so group messages from it can be attributed. */
  noteDevice(agentId: string, deviceId: string): void {
    this.deviceToAgent.set(deviceId, agentId);
    const devices = ((this.state.index.meta as Record<string, unknown>).devices ??= {}) as Record<string, string>;
    devices[deviceId] = agentId;
  }

  /**
   * Inbox-driven receive loop. Waits for notices (SSE), fetches the referenced
   * conversations, decrypts, and returns what arrived. This is the primitive an agent loop
   * actually needs: "block until someone talks to me, with a timeout".
   */
  async waitForMessages(opts: { timeoutMs?: number; max?: number } = {}): Promise<ReceivedMessage[]> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const collected: ReceivedMessage[] = [];

    while (Date.now() < deadline) {
      const notices = await this.pollInbox();
      const cids = new Set<string>();
      for (const n of notices) {
        const cid = this.resolveNoticeCid(n);
        if (cid) cids.add(cid);
      }
      for (const cid of cids) {
        collected.push(...(await this.read(cid)));
        if (opts.max && collected.length >= opts.max) return collected;
      }
      if (collected.length) return collected;
      await new Promise((r) => setTimeout(r, 500));
    }
    return collected;
  }

  async pollInbox(): Promise<InboxNotice[]> {
    const res = await this.request<{ notices: Array<{ seq: number; notice: InboxNotice }> }>(
      'GET', `/v1/inbox?afterSeq=${this.state.meta.lastInboxSeq ?? 0}`,
    );
    const notices = res.notices.map((n) => n.notice);
    if (res.notices.length) {
      this.state.meta.lastInboxSeq = Math.max(...res.notices.map((n) => n.seq));
      await this.persist();
    }
    for (const n of notices) this.opts.onNotice?.(n);
    return notices;
  }

  /** Map a notice back to a conversation — blinded tags resolve only locally. */
  private resolveNoticeCid(notice: InboxNotice): string | null {
    if (this.state.index.conversations[notice.c]) return notice.c;
    for (const entry of Object.values(this.state.index.conversations)) {
      if (entry.tag === notice.c) return entry.cid;
    }
    // Sealed notice for a conversation we have not indexed yet (someone messaged us
    // first): fall back to asking the gateway which conversations route to us.
    return null;
  }

  /**
   * Process everything waiting across all conversations: decrypt, auto-apply group sender
   * keys, and return the substantive messages. This is the one call a simple agent loop needs.
   */
  async receive(opts: { markDelivered?: boolean } = {}): Promise<ReceivedMessage[]> {
    await this.syncConversations();
    const out: ReceivedMessage[] = [];
    for (const conv of Object.values(this.state.index.conversations)) {
      let messages: ReceivedMessage[];
      try { messages = await this.read(conv.cid); } catch { continue; }
      for (const m of messages) {
        if (m.message.type === 'sender_key' && m.from) {
          await this.applySenderKey(m.from, m.message.body as Record<string, any>);
          continue;
        }
        if (m.message.type === 'receipt') continue;
        out.push(m);
      }
      if (opts.markDelivered && messages.length) {
        const top = Math.max(...messages.map((m) => m.seq));
        try { await this.markRead(conv.cid, top, 'delivered'); } catch { /* receipts are best effort */ }
      }
    }
    return out;
  }

  /** Discover conversations opened *by* peers (first contact from someone else). */
  async syncConversations(): Promise<string[]> {
    const res = await this.request<{ conversations: Array<{ cid: string; mode: 'open' | 'sealed'; kind: 'dm' | 'group' | 'channel'; topicId: string; tag?: string; participants?: string[]; groupId?: string }> }>(
      'GET', '/v1/conversations',
    );
    const added: string[] = [];
    for (const c of res.conversations) {
      if (this.state.index.conversations[c.cid]) continue;
      this.state.index.conversations[c.cid] = {
        cid: c.cid, mode: c.mode, kind: c.kind, topicId: c.topicId, tag: c.tag,
        peerAgentId: c.participants?.find((p) => p !== this.agentId),
        groupId: c.groupId, createdAt: Date.now(),
      };
      added.push(c.cid);
    }
    if (added.length) await this.persist();
    return added;
  }

  async listConversations() {
    return Object.values(this.state.index.conversations);
  }

  /* ------------------------------------------------------------------ receipts */

  async markRead(cid: string, upTo: number, status: 'delivered' | 'read' | 'processing' | 'done' | 'failed' = 'read'): Promise<void> {
    const entry = this.state.index.conversations[cid];
    if (!entry) throw new Error(`unknown conversation ${cid}`);
    const body: MessageBody = {
      id: deriveMessageId(cid, this.deviceId, (this.state.meta.clientSeq = (this.state.meta.clientSeq ?? 0) + 1)),
      ts: Date.now(), type: 'receipt', body: { status, upTo },
    };
    const plaintext = utf8.enc(JSON.stringify(body));
    const ft = frankingTag(newFrankKey(), plaintext);
    const envelope = entry.kind === 'group'
      ? this.encryptForGroup(cid, plaintext, ft)
      : this.encryptForDm(cid, plaintext, ft);
    const res = await this.request<{ sequenceNumber?: number }>('POST', `/v1/conversations/${cid}/receipts`, {
      envelope: b64.enc(encodeEnvelope(envelope)), upTo,
    });
    if (res.sequenceNumber) this.noteOwnSeq(cid, res.sequenceNumber);
    entry.lastReadSeq = Math.max(entry.lastReadSeq ?? 0, upTo);
    await this.persist();
  }

  /* ------------------------------------------------------------------ reactions, edits, deletes */

  react(cid: string, targetMsgId: string, label: string) {
    return this.send(cid, { target: targetMsgId, label }, { type: 'reaction' });
  }

  reply(target: string, text: string, replyTo: string) {
    return this.send(target, text, { replyTo });
  }

  editMessage(cid: string, targetMsgId: string, text: string) {
    return this.send(cid, { target: targetMsgId, text }, { type: 'edit' });
  }

  /** Delete for everyone: publish a tombstone and shred the local key material. */
  async deleteMessage(cid: string, targetMsgId: string): Promise<SendResult> {
    const result = await this.send(cid, { target: targetMsgId }, { type: 'delete' });
    const session = this.state.sessions[cid];
    if (session) { session.skipped = {}; await this.persist(); }
    return result;
  }

  /* ------------------------------------------------------------------ groups */

  async createGroupChat(opts: { name?: string; members: string[]; onlyAdminsSend?: boolean }): Promise<string> {
    const res = await this.request<{ groupId: string; cid: string; topicId: string; members: string[] }>(
      'POST', '/v1/groups', { name: opts.name, members: opts.members, onlyAdminsSend: opts.onlyAdminsSend },
    );
    const group = createGroup(res.groupId, this.agentId, res.members.filter((m) => m !== this.agentId));
    this.state.groups[res.groupId] = group;
    this.state.index.conversations[res.cid] = {
      cid: res.cid, mode: 'open', kind: 'group', groupId: res.groupId, topicId: res.topicId, createdAt: Date.now(),
    };
    await this.persist();
    await this.distributeSenderKey(res.groupId);
    return res.cid;
  }

  /** Send our group sender key to every member over the pairwise (ratcheted) sessions. */
  async distributeSenderKey(groupId: string): Promise<void> {
    const group = this.state.groups[groupId];
    if (!group) throw new Error(`no group state for ${groupId}`);
    const payload = distribution(group, this.agentId);
    await Promise.all(group.members.filter((m) => m !== this.agentId).map(async (member) => {
      try {
        await this.send(member, { ...payload, deviceId: this.deviceId }, { type: 'sender_key' });
      } catch (err) {
        console.warn(`[agentline] sender-key distribution to ${member} failed:`, (err as Error).message);
      }
    }));
  }

  /** Apply a sender_key message received from a group peer. */
  async applySenderKey(from: string, payload: Record<string, any>): Promise<void> {
    const groupId = payload.groupId as string;
    const group = this.state.groups[groupId] ?? createGroup(groupId, from, payload.members ?? []);
    const { acceptDistribution } = await import('@agentline/crypto');
    acceptDistribution(group, {
      groupId, epoch: payload.epoch, from, chainKey: payload.chainKey, n: payload.n,
      members: payload.members ?? group.members, admins: payload.admins ?? group.admins,
    });
    this.state.groups[groupId] = group;
    if (payload.deviceId) this.noteDevice(from, payload.deviceId);
    const cid = groupId.replace('grp_', 'cnv_');
    this.state.index.conversations[cid] ??= {
      cid, mode: 'open', kind: 'group', groupId, createdAt: Date.now(),
    };
    await this.persist();
  }

  async addGroupMembers(groupId: string, members: string[]): Promise<void> {
    const res = await this.request<{ members: string[] }>('POST', `/v1/groups/${groupId}/members`, { members });
    const group = this.state.groups[groupId];
    if (group) {
      rotateEpoch(group, res.members);
      await this.persist();
      await this.distributeSenderKey(groupId);
    }
  }

  async removeGroupMember(groupId: string, agentId: string): Promise<void> {
    const res = await this.request<{ members: string[] }>('DELETE', `/v1/groups/${groupId}/members/${agentId}`);
    const group = this.state.groups[groupId];
    if (group) {
      // New epoch + new sender key: the removed member cannot read anything after this.
      rotateEpoch(group, res.members);
      await this.persist();
      await this.distributeSenderKey(groupId);
    }
  }

  async createInvite(groupId: string, opts: { maxUses?: number; ttlSeconds?: number } = {}) {
    return this.request<{ code: string; link: string; expiresAt: number }>(
      'POST', `/v1/groups/${groupId}/invites`, opts,
    );
  }

  async joinWithInvite(code: string) {
    const res = await this.request<{ groupId: string; cid: string; topicId: string; members: string[] }>(
      'POST', `/v1/invites/${code}:join`, {},
    );
    this.state.groups[res.groupId] ??= createGroup(res.groupId, res.members[0], res.members);
    this.state.index.conversations[res.cid] ??= {
      cid: res.cid, mode: 'open', kind: 'group', groupId: res.groupId, topicId: res.topicId, createdAt: Date.now(),
    };
    await this.persist();
    await this.distributeSenderKey(res.groupId);
    return res;
  }

  /* ------------------------------------------------------------------ safety */

  async listRequests() {
    return this.request<{ requests: Array<{ cid: string; from: string; firstSeq: number }> }>('GET', '/v1/requests');
  }

  async acceptRequest(cid: string) { return this.request('POST', `/v1/requests/${cid}:accept`, {}); }
  async declineRequest(cid: string) { return this.request('POST', `/v1/requests/${cid}:decline`, {}); }
  async block(agentId: string) { return this.request('POST', '/v1/blocks', { agentId }); }

  /** Report a message by revealing its body and franking key. */
  async report(cid: string, evidence: Array<{ seq: number; message: MessageBody }>, reason: string) {
    return this.request<{ reportId: string; verified: boolean }>('POST', '/v1/reports', {
      cid, reason,
      evidence: evidence.map((e) => ({
        seq: e.seq,
        body: { ...e.message, frankKey: undefined, untrusted: undefined },
        frankKey: e.message.frankKey,
        msgId: e.message.id,
      })),
    });
  }

  async safetyNumberFor(peerAgentId: string): Promise<string> {
    const peer = await this.request<{ keys: { ed25519Pk: string } }>('GET', `/v1/agents/${peerAgentId}`);
    return safetyNumber(this.identity.ed25519Pk, b64.dec(peer.keys.ed25519Pk));
  }

  /* ------------------------------------------------------------------ payments in chat */

  async requestPayment(target: string, opts: { amount: string; asset?: string; network?: string; payTo: string; memo?: string }) {
    const { derivePaymentId } = await import('@agentline/crypto');
    const cid = target.startsWith('cnv_') ? target : await this.openConversation(target);
    const msgId = deriveMessageId(cid, this.deviceId, (this.state.meta.clientSeq ?? 0) + 1);
    return this.send(cid, {
      paymentId: derivePaymentId(cid, msgId),
      amount: opts.amount,
      asset: opts.asset ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: opts.network ?? 'eip155:84532',
      payTo: opts.payTo,
      memo: opts.memo,
    }, { type: 'payment_request' });
  }

  async sendPaymentReceipt(cid: string, paymentId: string, txHash: string, amount: string) {
    return this.send(cid, { paymentId, txHash, amount, asset: 'USDC', network: 'eip155:84532', paidAt: Date.now() }, { type: 'payment_receipt' });
  }

  /* ------------------------------------------------------------------ billing */

  async buyCredits(amount: string) {
    return this.request<{ balance: string }>('POST', '/v1/billing/credits', { amount });
  }

  async balance() {
    return this.request<{ balance: string; spent: string }>('GET', '/v1/billing/balance');
  }

  /* ------------------------------------------------------------------ backup */

  /** Encrypted backup of the personal index (contacts, conversation list, session state). */
  async backupPersonalIndex(): Promise<{ bytes: number }> {
    const blob = sealIndex(this.identity.ed25519Sk, this.state.index as PersonalIndex);
    return this.request<{ bytes: number }>('PUT', '/v1/personal-index', { blob });
  }

  async restorePersonalIndex(): Promise<void> {
    const res = await this.request<{ blob: string }>('GET', '/v1/personal-index');
    const index = openIndex(this.identity.ed25519Sk, res.blob);
    this.state.index = index;
    this.state.sessions = (index.sessions ?? {}) as Record<string, SessionState>;
    this.state.groups = (index.groups ?? {}) as Record<string, GroupState>;
    await this.persist();
  }

  /** Crypto-shred a conversation: ciphertext stays on-chain, keys are destroyed. */
  async shred(cid: string): Promise<void> {
    const session = this.state.sessions[cid];
    if (session) shredSession(session);
    delete this.state.sessions[cid];
    delete this.state.index.conversations[cid];
    await this.persist();
  }

  /* ------------------------------------------------------------------ transport */

  /**
   * Signed, priced HTTP. Handles the x402 402-retry, RFC 9421 signing, idempotency and
   * problem+json errors in one place so callers never think about any of it.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { keyId?: string; idempotencyKey?: string; retryPayment?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const keyId = opts.keyId ?? this.agentId;

    const doFetch = async (paymentHeader?: string): Promise<Response> => {
      const sig = signRequest({
        method, target: url.pathname + (url.search || ''), authority: url.host,
        body: payload, keyId, ed25519Sk: this.identity.ed25519Sk,
      });
      const headers: Record<string, string> = {
        accept: 'application/json',
        'AgentLine-Key-Id': keyId,
        Signature: sig.Signature,
        'Signature-Input': sig['Signature-Input'],
      };
      if (sig['Content-Digest']) headers['Content-Digest'] = sig['Content-Digest'];
      if (payload) headers['content-type'] = 'application/json';
      if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
      if (paymentHeader) headers['X-PAYMENT'] = paymentHeader;
      return this.fetchImpl(url.toString(), { method, headers, body: payload || undefined });
    };

    let res = await doFetch();

    if (res.status === 402 && opts.retryPayment !== false) {
      const challenge = (await res.json()) as PaymentRequiredBody;
      const requirements = pickRequirements(challenge, undefined);
      const header = await this.payer.pay(requirements);
      res = await doFetch(header);
    }

    if (!res.ok) {
      const text = await res.text();
      let problem: { code?: string; detail?: string; title?: string } = {};
      try { problem = JSON.parse(text); } catch { problem = { detail: text.slice(0, 300) }; }
      throw new AgentLineError(
        (problem.code as never) ?? 'internal',
        `${method} ${path} -> ${res.status}: ${problem.detail ?? problem.title ?? text.slice(0, 200)}`,
      );
    }

    const paymentProof = res.headers.get('x-payment-response') ?? res.headers.get('payment-response');
    const json = res.status === 204 ? ({} as T) : ((await res.json()) as T);
    if (paymentProof && typeof json === 'object' && json) {
      try { (json as Record<string, unknown>).paymentProof = decodeHeaderJson(paymentProof); } catch { /* opaque proof */ }
    }
    return json;
  }

  /**
   * Live SSE stream of inbox notices. Returns a stop function.
   *
   * Only `notice` events reach `onNotice`. The stream also carries control frames — `open`
   * on connect and `lag` when the mirror node hiccups — which are surfaced separately so a
   * caller counting notices is never confused by them.
   */
  streamInbox(
    onNotice: (n: InboxNotice) => void,
    opts: { fromSeq?: number; onControl?: (event: string, data: unknown) => void } = {},
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      const query = opts.fromSeq !== undefined ? `?fromSeq=${opts.fromSeq}` : '';
      const url = `${this.baseUrl}/v1/inbox/stream${query}`;
      const sig = signRequest({
        method: 'GET', target: `/v1/inbox/stream${query}`, authority: new URL(this.baseUrl).host,
        keyId: this.agentId, ed25519Sk: this.identity.ed25519Sk,
      });
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            accept: 'text/event-stream', 'AgentLine-Key-Id': this.agentId,
            Signature: sig.Signature, 'Signature-Input': sig['Signature-Input'],
          },
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const lines = frame.split('\n');
            const event = lines.find((l) => l.startsWith('event: '))?.slice(7).trim() ?? 'message';
            const dataLine = lines.find((l) => l.startsWith('data: '));
            if (!dataLine) continue;   // comment/keepalive frame
            let payload: unknown;
            try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
            if (event === 'notice') onNotice(payload as InboxNotice);
            else opts.onControl?.(event, payload);
          }
        }
      } catch { /* stream closed */ }
    })();
    return () => controller.abort();
  }

  async close(): Promise<void> { await this.persist(); }
}

export { FileKeyStore, MemoryKeyStore, WalletPayer, NullPayer };
export { algorandFetch, algorandSigner, ALGORAND_NETWORKS, type AlgorandWallet } from './algorand.ts';
