/**
 * Console message playground.
 *
 * Keeps a pair of throwaway test agents alive for the lifetime of the gateway process so
 * an operator can type a message in the browser and watch it make the full round trip:
 * encrypted locally, paid for, submitted to consensus, and decrypted by the other side.
 *
 * Two deliberate constraints:
 *  - These agents live **in memory only**. Their private keys are never written to disk and
 *    never leave this process, exactly like any other agent's. A restart means a new pair.
 *  - They are ordinary agents using the public API and paying real x402 charges. Nothing
 *    here is a shortcut around encryption or payment, so a green transcript is real evidence
 *    the production path works — not a mock.
 */
import { b64 } from '@agentline/crypto';
import { decodeEnvelope } from '@agentline/protocol';
import type { AgentLine } from '@agentline/sdk';
import { config } from '../config.ts';
import { store } from '../lib/store.ts';
import { ledger } from './ledger.ts';

export interface TranscriptEntry {
  seq: number;
  consensusTimestamp: string;
  /** which test agent sent it */
  from: 'A' | 'B';
  fromAgentId: string;
  type: string;
  /** the plaintext as the *recipient* decrypted it — proof the transfer worked */
  decrypted: unknown;
  decryptedBy: 'A' | 'B' | null;
  /** what the gateway and the chain actually hold */
  ciphertextPreview: string;
  ciphertextBytes: number;
  conversationReference: string;
  senderDevice: string;
  /** whether the recipient's decryption matched what the sender sent */
  verified: boolean;
  payment?: { method: string; amount: string; route?: string; txHash?: string };
}

export interface PlaygroundState {
  ready: boolean;
  agentA?: { agentId: string; handle?: string; inboxTopic?: string };
  agentB?: { agentId: string; handle?: string; inboxTopic?: string };
  cid?: string;
  topicId?: string;
  mode?: string;
  safetyNumber?: string;
  safetyNumbersMatch?: boolean;
  transcript: TranscriptEntry[];
  links?: { mirrorNode?: string; hashscan?: string };
  spentUsdc: string;
}

let a: AgentLine | null = null;
let b: AgentLine | null = null;
let cid: string | null = null;
let transcript: TranscriptEntry[] = [];
let safety: { value: string; match: boolean } | null = null;
let spent = 0;
let initializing: Promise<void> | null = null;

function label(agentId: string): 'A' | 'B' | null {
  if (a && agentId === a.agentId) return 'A';
  if (b && agentId === b.agentId) return 'B';
  return null;
}

async function ensure(): Promise<void> {
  if (a && b && cid) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const { AgentLine, MemoryKeyStore } = await import('@agentline/sdk');
    const walletKey = (process.env.DEMO_PRIVATE_KEY ?? process.env.SETTLER_PRIVATE_KEY) as `0x${string}` | undefined;
    const wallet = walletKey ? { privateKey: walletKey } : undefined;
    // Loopback: the playground is a client of this same gateway, over the real HTTP API.
    const baseUrl = `http://127.0.0.1:${config.port}`;
    const suffix = Date.now().toString(36);

    a = await AgentLine.connect({
      baseUrl, keyStore: new MemoryKeyStore(), wallet,
      handle: `console.a.${suffix}`,
      profile: { name: 'Console Agent A', description: 'in-memory test agent for the operator console' },
    });
    b = await AgentLine.connect({
      baseUrl, keyStore: new MemoryKeyStore(), wallet,
      handle: `console.b.${suffix}`,
      profile: { name: 'Console Agent B', description: 'in-memory test agent for the operator console' },
    });

    const sa = await a.safetyNumberFor(b.agentId);
    const sb = await b.safetyNumberFor(a.agentId);
    safety = { value: sa, match: sa === sb };

    cid = await a.openConversation(b.agentId, { mode: 'sealed' });
    await b.syncConversations();
    transcript = [];
    spent = 0;
  })();

  try { await initializing; } finally { initializing = null; }
}

/** Send a message as one agent and record what the other actually decrypted. */
export async function sendMessage(text: string, from: 'A' | 'B' = 'A'): Promise<TranscriptEntry[]> {
  await ensure();
  const sender = from === 'A' ? a! : b!;
  const recipient = from === 'A' ? b! : a!;

  const sent = await sender.send(cid!, text);
  if (sent.payment?.amount) spent += Number(sent.payment.amount);

  // The recipient does the decrypting, exactly as a real peer would: fetch the ciphertext
  // from the chain-backed index and open it with its own ratchet state.
  await recipient.syncConversations();
  const received = await recipient.read(cid!);

  // Pull the raw stored envelope so the transcript can show what the operator (and anyone
  // reading the public topic) actually sees.
  const stored = await sender.request<{ messages: Array<{ seq: number; envelope: string; consensusTimestamp: string; senderDeviceId: string | null }> }>(
    'GET', `/v1/conversations/${cid}/messages?afterSeq=${Math.max(0, sent.sequenceNumber - 1)}&limit=5`);
  const raw = stored.messages.find((m) => m.seq === sent.sequenceNumber);

  let entry: TranscriptEntry = {
    seq: sent.sequenceNumber,
    consensusTimestamp: sent.consensusTimestamp,
    from,
    fromAgentId: sender.agentId,
    type: 'text',
    decrypted: null,
    decryptedBy: null,
    ciphertextPreview: '',
    ciphertextBytes: 0,
    conversationReference: '',
    senderDevice: '',
    verified: false,
    payment: sent.payment,
  };

  if (raw) {
    const envelope = decodeEnvelope(b64.dec(raw.envelope));
    entry.ciphertextPreview = envelope.ct.slice(0, 64);
    entry.ciphertextBytes = b64.dec(envelope.ct).length;
    entry.conversationReference = envelope.tag ? `blinded tag ${envelope.tag}` : (envelope.cid ?? '—');
    entry.senderDevice = envelope.sd ?? 'null (sealed sender)';
  }

  const match = received.find((m) => m.seq === sent.sequenceNumber);
  if (match) {
    entry.type = match.message.type;
    entry.decrypted = match.message.body;
    entry.decryptedBy = from === 'A' ? 'B' : 'A';
    entry.verified = (match.message.body as { text?: string })?.text === text;
  }

  transcript.push(entry);

  // Any other messages the recipient picked up (receipts, etc.) are recorded too, so the
  // transcript reflects everything that crossed the wire rather than just the happy path.
  for (const m of received) {
    if (m.seq === sent.sequenceNumber) continue;
    if (transcript.some((t) => t.seq === m.seq)) continue;
    const who = label(m.from ?? '');
    transcript.push({
      seq: m.seq,
      consensusTimestamp: m.consensusTimestamp,
      from: who ?? (from === 'A' ? 'B' : 'A'),
      fromAgentId: m.from ?? '',
      type: m.message.type,
      decrypted: m.message.body,
      decryptedBy: from === 'A' ? 'B' : 'A',
      ciphertextPreview: '',
      ciphertextBytes: 0,
      conversationReference: '',
      senderDevice: m.senderDeviceId ?? 'null (sealed sender)',
      verified: m.verified,
    });
  }

  transcript.sort((x, y) => x.seq - y.seq);
  return transcript;
}

export async function state(): Promise<PlaygroundState> {
  const conv = cid ? store.db.conversations[cid] : undefined;
  const topicId = conv?.topicId;
  return {
    ready: !!(a && b && cid),
    agentA: a ? { agentId: a.agentId, handle: a.handle, inboxTopic: a.inboxTopic } : undefined,
    agentB: b ? { agentId: b.agentId, handle: b.handle, inboxTopic: b.inboxTopic } : undefined,
    cid: cid ?? undefined,
    topicId,
    mode: conv?.mode,
    safetyNumber: safety?.value,
    safetyNumbersMatch: safety?.match,
    transcript,
    links: topicId && ledger().kind === 'hedera' ? {
      mirrorNode: `${config.hedera.mirrorRest}/api/v1/topics/${topicId}/messages`,
      hashscan: `https://hashscan.io/${config.hedera.network}/topic/${topicId}`,
    } : undefined,
    spentUsdc: spent.toFixed(6),
  };
}

/** Drop the pair and start a fresh conversation. Keys are simply discarded. */
export function reset(): void {
  a = null; b = null; cid = null; transcript = []; safety = null; spent = 0;
}
