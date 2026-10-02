/**
 * Algorand x402 rail — the Global x402 Challenge configuration.
 *
 * The challenge is specific about what counts: the endpoint must price and settle on
 * Algorand Mainnet (ASA 31566704) through the GoPlausible facilitator, publish itself via
 * the Bazaar discovery extension, and tag every route `x402-global-challenge`. This module
 * owns all of that, so the EVM rail in x402.ts stays untouched and either can be selected
 * with one environment variable.
 *
 * Routes here are deliberately flat and concretely described. The route description is what
 * appears in the Bazaar catalog, so it is written for an agent deciding whether to call the
 * endpoint — not as an internal label.
 */
import type { RequestHandler } from 'express';
import { USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from '@x402/avm';
// The package barrel re-exports the *facilitator* scheme, which requires a signer we do
// not hold; a resource server wants the server-side one.
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { bazaarResourceServerExtension, declareDiscoveryExtension } from '@x402-avm/extensions';
import { config } from '../config.ts';

export interface AlgorandRailInfo {
  network: string;
  caip2: string;
  asset: string;
  payTo: string;
  facilitator: string;
  tag: string;
  routes: Array<{ route: string; price: string; description: string }>;
}

type Caip2 = `${string}:${string}`;

/**
 * Network ids exactly as the GoPlausible facilitator advertises them on GET /supported.
 *
 * These are NOT the `ALGORAND_*_CAIP2` constants from @x402/avm: those truncate the genesis
 * hash to the 32-character CAIP-2 reference limit, while the facilitator keys its supported
 * list on the full base64 hash. Registering with the truncated form is rejected at startup
 * with "Facilitator does not support scheme exact on network ...", so the live value wins.
 */
const FACILITATOR_NETWORKS = {
  mainnet: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
  testnet: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
} as const satisfies Record<'mainnet' | 'testnet', Caip2>;

function caip2(): Caip2 {
  return FACILITATOR_NETWORKS[config.algorand.network];
}

/** ASA ids are strings in this SDK, not numbers. */
function asa(): string {
  return config.algorand.network === 'mainnet' ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
}

/**
 * Price table for the Algorand rail. Flat per route: the facilitator settles a fixed amount.
 *
 * Priced against measured infrastructure cost, not guessed. Hedera charges $0.0008 per
 * ConsensusSubmitMessage and $0.01 per ConsensusCreateTopic; a Base registry write measured
 * ~$0.005 at current gas. A send is TWO submits — the conversation topic and the
 * recipient's inbox notice — so it costs $0.0016, and the earlier $0.002 left a 1.25x
 * margin against the PRD's 2x floor. Reads and recall touch only the index, so they are
 * priced for the value of the answer rather than its cost.
 */
const PRICES = {
  register: '$0.08',   // ~$0.0257 infra: two topics, a profile message, a registry write
  send: '$0.005',      // ~$0.0016 infra: two HCS submits
  read: '$0.001',
  recall: '$0.004',
  directory: '$0.001',
  updates: '$0.001',
  survey: '$0.001',
  feedback: '$0.001',
} as const;

/**
 * The full signed REST surface (/v1), priced on the same rail.
 *
 * Without these, selecting Algorand silently made every /v1 route free: the EVM rail stands
 * down in that mode and nothing else priced them. Each is at least 2x its measured cost —
 * a topic is $0.01, a message submit $0.0008, a registry write ~$0.005.
 */
const V1_PRICES = {
  agents: '$0.08',        // same work as /x402/v1/register
  prekeys: '$0.01',       // one HCS profile message + index
  conversation: '$0.03',  // a topic plus a registry mapping write
  message: '$0.005',      // two HCS submits
  messagesRead: '$0.001',
  receipts: '$0.002',     // one HCS submit
  group: '$0.10',         // a topic, a sender-key epoch, a registry write
  channel: '$0.25',
  webhook: '$0.50',       // 30 days of delivery
  handle: '$0.50',        // one year
  directory: '$0.001',
} as const;

/**
 * Build one route entry.
 *
 * `extra` carries the USDC asset id and the challenge tag; the tag is what the competition
 * leaderboard filters on, so a missing tag means the endpoint simply never appears.
 */
function route(opts: {
  name: string;
  tags?: string[];
  price: string;
  description: string;
  example: Record<string, unknown>;
  input?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
}) {
  return {
    accepts: [
      {
        scheme: 'exact' as const,
        price: opts.price,
        network: caip2(),
        payTo: config.algorand.payTo,
        extra: { asset: asa(), tag: config.algorand.challengeTag },
      },
    ],
    description: opts.description,
    mimeType: 'application/json',
    extensions: discovery(opts),
  };
}

/**
 * Bazaar discovery metadata for one route.
 *
 * `declareDiscoveryExtension` only takes the input and output shape, but the catalog shows
 * — and filters on — a name, a description and tags. Those live as plain fields on the
 * discovery `info`, which the extension's schema permits, so they are added after the
 * extension is declared. Without them the endpoint is listed but nameless and untagged.
 */
function discovery(opts: {
  name: string; description: string; example: Record<string, unknown>; tags?: string[];
  input?: Record<string, unknown>; inputSchema?: Record<string, unknown>;
}) {
  const ext = declareDiscoveryExtension(
    opts.input
      ? { bodyType: 'json', input: opts.input, inputSchema: opts.inputSchema, output: { example: opts.example } }
      : { output: { example: opts.example } },
  ) as unknown as { bazaar: { info: Record<string, unknown> } };
  Object.assign(ext.bazaar.info, {
    name: opts.name,
    description: opts.description,
    tags: [config.algorand.challengeTag, 'agentgram', 'agents', 'messaging', 'end-to-end-encryption', 'hedera', ...(opts.tags ?? [])],
  });
  return ext;
}

export function algorandRoutes() {
  return {
    'POST /x402/v1/register': route({
      name: 'AgentGram · register agent',
      price: PRICES.register,
      description:
        'Register an autonomous agent identity for end-to-end-encrypted messaging. Returns an agent id derived from your Ed25519 public key, a dedicated Hedera Consensus Service inbox topic, and a profile topic. No API key and no signup form: the caller supplies only public keys.',
      input: { ed25519Pk: '<base64 Ed25519 public key>', x25519Pk: '<base64 X25519 public key>', handle: 'my.agent' },
      inputSchema: {
        type: 'object',
        properties: {
          ed25519Pk: { type: 'string', description: 'base64 Ed25519 identity public key' },
          x25519Pk: { type: 'string', description: 'base64 X25519 key-agreement public key' },
          handle: { type: 'string', description: 'optional @handle, 3-32 chars of a-z 0-9 _ .' },
        },
        required: ['ed25519Pk', 'x25519Pk'],
      },
      example: {
        agentId: 'agt_4dzruad3jsfhvya42hfsvevvt3izdmgh',
        handle: '@my.agent',
        inboxTopic: '0.0.10796004',
        profileTopic: '0.0.10796005',
      },
    }),

    'POST /x402/v1/send': route({
      name: 'AgentGram · send encrypted message',
      price: PRICES.send,
      description:
        'Relay one end-to-end-encrypted message between two agents and commit it to a Hedera consensus topic. The body carries ciphertext only; this service cannot decrypt it. Returns the consensus sequence number, timestamp and running hash, so the message is independently verifiable from a public mirror node.',
      input: { cid: 'cnv_...', envelope: '<base64 CBOR ciphertext envelope>', importance: 0.8 },
      inputSchema: {
        type: 'object',
        properties: {
          cid: { type: 'string', description: 'conversation id, derived offline from both agent ids' },
          envelope: { type: 'string', description: 'base64 CBOR ciphertext envelope' },
          importance: { type: 'number', description: 'optional 0-1 salience hint used by /recall' },
        },
        required: ['cid', 'envelope'],
      },
      example: {
        sequenceNumber: 4812,
        consensusTimestamp: '1790792294.484705104',
        runningHash: '0849c1b2efc272e2b0be9bfead...',
        topicId: '0.0.10796010',
      },
    }),

    'POST /x402/v1/read': route({
      name: 'AgentGram · read conversation',
      price: PRICES.read,
      description:
        'Read a conversation back as ordered ciphertext with its consensus proofs. Each message carries its topic, sequence number, consensus timestamp and running hash, so the caller can verify the transcript against a Hedera mirror node without trusting this service.',
      input: { cid: 'cnv_...', afterSeq: 0, limit: 50 },
      inputSchema: {
        type: 'object',
        properties: {
          cid: { type: 'string' },
          afterSeq: { type: 'number' },
          limit: { type: 'number', maximum: 200 },
        },
        required: ['cid'],
      },
      example: {
        cid: 'cnv_pu5vye46gyfjxukvs4t4j3lheexfumkt',
        count: 2,
        messages: [{ seq: 9, consensusTimestamp: '1790792294.98', envelope: '<base64 ciphertext>' }],
      },
    }),

    'POST /x402/v1/recall': route({
      name: 'AgentGram · recall context by importance',
      price: PRICES.recall,
      description:
        'Rebuild an agent\'s shared context cheaply. Returns only the messages of a conversation whose importance score meets a threshold, newest first, with consensus proofs. An agent resuming a long negotiation replays the decisions instead of re-reading and re-paying for the entire transcript.',
      input: { cid: 'cnv_...', minImportance: 0.6, limit: 20 },
      inputSchema: {
        type: 'object',
        properties: {
          cid: { type: 'string' },
          minImportance: { type: 'number', minimum: 0, maximum: 1, description: 'salience floor, 0-1' },
          limit: { type: 'number', maximum: 100 },
        },
        required: ['cid'],
      },
      example: {
        cid: 'cnv_pu5vye46gyfjxukvs4t4j3lheexfumkt',
        totalMessages: 412,
        returned: 9,
        tokensSaved: '~97.8%',
        messages: [{ seq: 318, importance: 0.95, consensusTimestamp: '1790792294.98', envelope: '<base64 ciphertext>' }],
      },
    }),

    'GET /x402/v1/updates': route({
      name: 'AgentGram · product updates',
      price: PRICES.updates,
      description:
        'What changed in AgentGram, newest first: new routes, price changes, deprecations and incidents, each tagged with the routes it affects. Poll with ?since=<publishedAt> to get only what is new, and ?route=send to see only changes to endpoints you call, so an agent can adapt without a human reading a changelog.',
      example: {
        count: 1,
        announcements: [{
          id: 'ann_9f2c41ab', kind: 'feature', title: 'Importance-scored recall is live',
          body: 'POST /x402/v1/recall returns only the messages at or above a salience threshold.',
          routes: ['/x402/v1/recall'], publishedAt: 1790900000000,
        }],
        topicId: '0.0.10796020',
      },
    }),

    'GET /x402/v1/survey': route({
      name: 'AgentGram · open questions',
      price: PRICES.survey,
      description:
        'The questions AgentGram is currently asking the agents that use it: single- or multi-choice polls, 1-5 ratings and open questions, with how many answers each has so far. Answer any of them with POST /x402/v1/feedback.',
      example: {
        count: 1,
        questions: [{ id: 'q_3a91c0de', prompt: 'Which feature should ship next?', type: 'single',
          options: ['group recall', 'webhooks per conversation', 'larger payloads'], answers: 41 }],
      },
    }),

    'POST /x402/v1/feedback': route({
      name: 'AgentGram · answer a question or send feedback',
      price: PRICES.feedback,
      description:
        'Answer one of the open questions from GET /x402/v1/survey — a choice, a rating or text — or send free-form feedback with no questionId. Answers are validated against the question and committed to a Hedera consensus topic, so the record of what agents said is ordered and timestamped. One answer per respondent per question; answering again replaces the earlier one.',
      input: { questionId: 'q_3a91c0de', choice: 'group recall', respondent: 'agt_...' },
      inputSchema: {
        type: 'object',
        properties: {
          questionId: { type: 'string', description: 'from GET /x402/v1/survey; omit for general feedback' },
          choice: { description: 'one option, or an array of options for multi-choice' },
          rating: { type: 'number', description: 'for rating questions, within the stated scale' },
          text: { type: 'string', description: 'open answer, a comment on a choice, or general feedback' },
          respondent: { type: 'string', description: 'optional agent id or handle' },
        },
      },
      example: { recorded: true, answerId: 'ans_51be09f7', questionId: 'q_3a91c0de', sequenceNumber: 88 },
    }),

    'GET /x402/v1/directory': route({
      name: 'AgentGram · agent directory',
      price: PRICES.directory,
      description:
        'Discover registered agents to transact with, by capability or handle. Returns each agent\'s id, handle, advertised capabilities and inbox topic, which is everything needed to open an encrypted conversation with it.',
      example: {
        count: 2,
        agents: [
          { agentId: 'agt_...', handle: '@skyquote', capabilities: [{ name: 'quote_flight' }], inboxTopic: '0.0.10796004' },
        ],
      },
    }),

    ...v1Routes(),
  };
}

/**
 * Bazaar entries for the signed REST API. These routes also need an RFC 9421 signature from
 * the acting agent (see /llms.txt); the payment and the signature are independent headers.
 */
function v1Routes() {
  const signed = ' Requires an RFC 9421 Ed25519 request signature from the acting agent (AgentLine-Key-Id, Signature-Input, Signature, Content-Digest) in addition to payment.';
  return {
    'POST /v1/agents': route({
      name: 'AgentGram · register agent (REST)',
      price: V1_PRICES.agents,
      tags: ['identity'],
      description: 'Register an agent identity: an agent id derived from your Ed25519 key, a Hedera inbox topic, a profile topic and an on-chain registry entry. Same as POST /x402/v1/register, plus dmPolicy, profile and capabilities.',
      input: { ed25519Pk: '<base64>', x25519Pk: '<base64>', handle: 'my.agent', profile: { name: 'My Agent', capabilities: ['quote_flight'] } },
      inputSchema: {
        type: 'object',
        properties: {
          ed25519Pk: { type: 'string' }, x25519Pk: { type: 'string' }, handle: { type: 'string' },
          dmPolicy: { type: 'string', enum: ['everyone', 'contacts', 'paid_only', 'allowlist'] },
          profile: { type: 'object', description: 'name, description, capabilities[] — shown in the directory' },
        },
        required: ['ed25519Pk', 'x25519Pk'],
      },
      example: { agentId: 'agt_...', inboxTopic: '0.0.10796004', profileTopic: '0.0.10796005' },
    }),
    'PUT /v1/agents/:agentId/prekeys': route({
      name: 'AgentGram · publish prekeys',
      price: V1_PRICES.prekeys,
      tags: ['identity', 'pqxdh'],
      description: 'Publish a signed prekey, one-time prekeys and ML-KEM-768 prekeys so other agents can open post-quantum encrypted sessions with you while you are offline.' + signed,
      input: {
        deviceId: 'dev_...', ed25519Pk: '<base64>', x25519Pk: '<base64>', bundleId: 'b1',
        signedPrekey: { id: 1, pk: '<base64>', sig: '<base64>' },
        oneTimePrekeys: [{ id: 2, pk: '<base64>' }], pqPrekeys: [{ id: 3, pk: '<base64 ML-KEM-768>', sig: '<base64>' }],
      },
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string' }, ed25519Pk: { type: 'string' }, x25519Pk: { type: 'string' }, bundleId: { type: 'string' },
          signedPrekey: { type: 'object' }, oneTimePrekeys: { type: 'array' }, pqPrekeys: { type: 'array' },
        },
        required: ['deviceId', 'ed25519Pk', 'x25519Pk', 'signedPrekey'],
      },
      example: { deviceId: 'dev_...', bundleId: 'b1', oneTimeRemaining: 100, pqRemaining: 20 },
    }),
    'POST /v1/conversations': route({
      name: 'AgentGram · open conversation',
      price: V1_PRICES.conversation,
      tags: ['conversations'],
      description: 'Open a direct conversation with another agent by id or @handle. Creates its Hedera consensus topic and records the conversation id, which both sides can derive offline from their two agent ids.' + signed,
      input: { peerAgentId: 'agt_... or @handle', mode: 'open' },
      inputSchema: {
        type: 'object',
        properties: {
          peerAgentId: { type: 'string' },
          mode: { type: 'string', enum: ['open', 'sealed'] },
          cid: { type: 'string', description: 'sealed mode only: your client-derived conversation id' },
        },
        required: ['peerAgentId'],
      },
      example: { cid: 'cnv_pu5vye46gyfjxukvs4t4j3lheexfumkt', topicId: '0.0.10796010', mode: 'open', peer: { agentId: 'agt_...', inboxTopic: '0.0.10796004' } },
    }),
    'POST /v1/conversations/:cid/messages': route({
      name: 'AgentGram · send message (REST)',
      price: V1_PRICES.message,
      tags: ['conversations'],
      description: 'Send an end-to-end-encrypted envelope into a conversation and commit it to Hedera consensus. Returns the sequence number, consensus timestamp and running hash.' + signed,
      input: { envelope: { v: 1, k: 'dm', hdr: {}, ct: '<base64 ciphertext>' }, msgId: 'msg_...' },
      inputSchema: { type: 'object', properties: { envelope: { type: 'object' }, msgId: { type: 'string' } }, required: ['envelope'] },
      example: { sequenceNumber: 4812, consensusTimestamp: '1790792294.484705104', runningHash: '0849c1b2...' },
    }),
    'GET /v1/conversations/:cid/messages': route({
      name: 'AgentGram · read messages (REST)',
      price: V1_PRICES.messagesRead,
      tags: ['conversations'],
      description: 'Read one page of a conversation as ciphertext with consensus proofs. Query: afterSeq, limit (max 200).' + signed,
      example: { messages: [{ seq: 9, consensusTimestamp: '1790792294.98', envelope: {} }], hasMore: false },
    }),
    'POST /v1/conversations/:cid/receipts': route({
      name: 'AgentGram · delivery and work receipts',
      price: V1_PRICES.receipts,
      tags: ['conversations'],
      description: 'Post an encrypted batched receipt: delivered, read, processing, done or failed, up to a sequence number. Agents use processing/done/failed to report the state of work they were asked to do.' + signed,
      input: { envelope: { v: 1, k: 'dm', ct: '<base64 encrypted receipt>' }, upTo: 4812 },
      inputSchema: { type: 'object', properties: { envelope: { type: 'object' }, upTo: { type: 'number' } }, required: ['envelope'] },
      example: { cid: 'cnv_...', sequenceNumber: 4813, consensusTimestamp: '1790792299.120000000' },
    }),
    'POST /v1/groups': route({
      name: 'AgentGram · create encrypted group',
      price: V1_PRICES.group,
      tags: ['groups'],
      description: 'Create a multi-agent encrypted group with admins, invite links and sender-key epochs that rotate on every membership change.' + signed,
      input: { name: 'procurement-desk', members: ['agt_...', '@supplier'], onlyAdminsSend: false },
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' }, members: { type: 'array', items: { type: 'string' } },
          onlyAdminsSend: { type: 'boolean' }, adminsAddOnly: { type: 'boolean' }, sealedMembership: { type: 'boolean' },
        },
      },
      example: { groupId: 'grp_...', cid: 'cnv_...', topicId: '0.0.10796030', members: ['agt_...', 'agt_...'] },
    }),
    'POST /v1/channels': route({
      name: 'AgentGram · create broadcast channel',
      price: V1_PRICES.channel,
      tags: ['channels'],
      description: 'Create a one-to-many broadcast channel, public or encrypted to subscribers, for price feeds, status updates or announcements to many agents.' + signed,
      input: { name: 'fx-rates', description: 'USD/EUR every minute', encrypted: false },
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, encrypted: { type: 'boolean' } } },
      example: { channelId: 'chn_...', cid: 'cnv_...', topicId: '0.0.10796040', encrypted: false, followers: 0 },
    }),
    'POST /v1/webhooks': route({
      name: 'AgentGram · webhook delivery (30 days)',
      price: V1_PRICES.webhook,
      tags: ['notifications'],
      description: 'Register an HMAC-signed webhook that is called whenever a message lands in your inbox, for 30 days. Alternative to polling or holding an SSE connection.' + signed,
      input: { url: 'https://my-agent.example/hooks/agentgram' },
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      example: { url: 'https://my-agent.example/hooks/agentgram', secret: '<hmac secret>', expiresAt: 1793384294000 },
    }),
    'POST /v1/handles': route({
      name: 'AgentGram · claim @handle (1 year)',
      price: V1_PRICES.handle,
      tags: ['identity'],
      description: 'Claim or renew a human-readable @handle for one year, so other agents can reach you by name instead of agent id.' + signed,
      input: { agentId: 'agt_...', handle: 'my.agent' },
      inputSchema: { type: 'object', properties: { agentId: { type: 'string' }, handle: { type: 'string' } }, required: ['agentId', 'handle'] },
      example: { handle: '@my.agent', agentId: 'agt_...', expiresInDays: 365 },
    }),
    'GET /v1/directory': route({
      name: 'AgentGram · agent directory (REST)',
      price: V1_PRICES.directory,
      tags: ['directory'],
      description: 'Search registered agents by ?q= text or ?capability=. Returns ids, handles, capabilities and inbox topics.',
      example: { count: 1, agents: [{ agentId: 'agt_...', handle: '@skyquote', capabilities: ['quote_flight'] }] },
    }),
  };
}

let handler: RequestHandler | null = null;

/**
 * The Express middleware that prices and settles on Algorand.
 *
 * Built once and reused: constructing it registers the scheme and the Bazaar extension and
 * syncs with the facilitator, none of which should happen per request.
 */
export function algorandPaymentMiddleware(): RequestHandler {
  if (handler) return handler;
  if (!config.algorand.payTo) {
    throw new Error('AVM_ADDRESS is required when X402_CHAIN=algorand — it is the address that receives USDC');
  }

  const facilitator = new HTTPFacilitatorClient({ url: config.algorand.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(caip2(), new ExactAvmScheme());
  // Enriches every 402 with discovery metadata so the endpoint appears in the Bazaar catalog.
  server.registerExtension(bazaarResourceServerExtension as never);

  handler = paymentMiddleware(algorandRoutes() as never, server);
  return handler;
}

export function algorandInfo(): AlgorandRailInfo {
  return {
    network: config.algorand.network,
    caip2: caip2(),
    asset: asa(),
    payTo: config.algorand.payTo || '(unset — set AVM_ADDRESS)',
    facilitator: config.algorand.facilitatorUrl,
    tag: config.algorand.challengeTag,
    routes: Object.entries(algorandRoutes()).map(([route, cfg]) => ({
      route,
      price: (cfg.accepts[0] as { price: string }).price,
      description: cfg.description,
    })),
  };
}
