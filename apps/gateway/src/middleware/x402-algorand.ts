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
 * Build one route entry.
 *
 * `extra` carries the USDC asset id and the challenge tag; the tag is what the competition
 * leaderboard filters on, so a missing tag means the endpoint simply never appears.
 */
function route(opts: {
  name: string;
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
    extensions: declareDiscoveryExtension({
      name: opts.name,
      // The catalog filters on these; the challenge tag has to be here as well as in `extra`.
      tags: [config.algorand.challengeTag, 'agents', 'messaging', 'encryption'],
      description: opts.description,
      ...(opts.input
        ? { bodyType: 'json', input: opts.input, inputSchema: opts.inputSchema }
        : {}),
      output: { example: opts.example },
    } as never),
  };
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
