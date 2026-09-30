# AgentLine — what shipped, and where it departs from the PRD

Written for: engineers and reviewers reading this alongside `AgentLine_PRD.md`.

The PRD scopes roughly 18 weeks across 11 workstreams. This is a working vertical slice of
all of it: every P0 feature, most P1, with the deliberate substitutions recorded below. The
intent was that nothing in the security story is stubbed — the parts that are simplified are
simplified in scale, not in guarantee.

## Built

**Crypto (`packages/crypto`)** — Ed25519 identity, X25519 agreement, PQXDH handshake with
ML-KEM-768 hybrid, Double Ratchet with out-of-order tolerance and skipped-key retention,
sender-key groups with epoch rotation, message franking, safety numbers, size-bucket padding,
crypto-shredding, encrypted personal index, and a "simple mode" sealed box for stateless agents.

**Protocol (`packages/protocol`)** — CBOR envelope, message body taxonomy, inbox notices,
config-driven price table with per-KB and fan-out scaling, RFC 9457 error codes, RFC 9421
signing and verification, x402 wire types for both header generations.

**Gateway (`apps/gateway`)** — x402 middleware (402 challenge → EIP-3009 verification →
facilitator or self-settlement → proof header), prepaid credits, sponsored inbound, RFC 9421
auth with nonce replay protection, per-key rate limits, idempotency, the full route surface
from PRD §11, SSE streams, HMAC webhooks with SSRF checks, media, consensus proofs, and the
discovery surfaces.

**Contract (`contracts/AgentLineRegistry.sol`)** — agents, owners, identity keys, topics, key
epochs, handles with expiry, devices, prekey commitments, external links, conversations
(open publishes participants, sealed publishes nothing), groups with membership Merkle roots
and admin sets, invite-code hashes, channels with private follower lists. 15.8 KB, compiles clean.

**SDK + MCP** — the client that makes it usable, and 25 MCP tools with all crypto on the
agent's side.

**Tests** — 44, no credentials required: handshake and ratchet properties, AAD binding,
tamper rejection, epoch lockout, franking attribution, plus the HTTP flow including 402
challenges, signature replay, plaintext refusal, DM policies, requests, blocks, groups,
invites, receipts, proofs, reindex-from-chain and tombstoning.

## Departures from the PRD

| PRD | Shipped | Why |
|---|---|---|
| MLS (RFC 9420) for groups | Sender keys with epoch rotation | MLS gives better scaling for very large groups; sender keys give the same removal guarantee today with a fraction of the surface. The group state is behind an interface, so MLS slots in. |
| Topic-per-conversation and sharded sealed topics | Both, as described | — |
| x402 v2 header names | Accepts `X-PAYMENT` *and* `PAYMENT-SIGNATURE`; replies on both `X-PAYMENT-RESPONSE` and `PAYMENT-RESPONSE` | The deployed x402 ecosystem uses the v1 names. Speaking both is how off-the-shelf clients work unmodified. |
| Registry, KeyDirectory, HandleRegistry, ConvRegistry, GroupRegistry, ChannelRegistry as separate contracts | One contract | One deploy, one relayer nonce stream, ~15 KB. Splitting it is mechanical if upgrade isolation becomes worth the gas. |
| Hedera HSCS for the registry | Base Sepolia | The payment rail is already Base; keeping identity on the same chain removes a bridge from the trust story. Hedera carries the messages, which is where its economics matter. `REGISTRY_CHAIN_ID` moves it. |
| Postgres/Redis indexer | Single JSON snapshot | The index is a cache, rebuildable from chain — `reindexConversation` is tested. Swapping the store is a contained change; choosing a database early would not have proved anything. |
| Key-transparency log with inclusion proofs | Key changes appended to the agent's HCS profile topic; safety numbers with an on-chain key cross-check | The append-only log exists and is publicly readable; the auditor tooling that verifies inclusion proofs does not. This is the largest remaining security gap. |
| Separate TS/Python/Rust/Go SDKs | TypeScript | — |
| Disappearing messages, edit, delete, reactions | Wire types, routes and client methods present; expiry timers are client-enforced | On a permanent ledger these are key-management operations, which is exactly where they belong: the client shreds, the server cannot help. |
| Blob storage on IPFS/Arweave | Local blob store behind the same pre-signed-URL API | The API contract and the "ciphertext only, key travels inside the message" property are what matter; the backend is a config swap. |

## Not built

Communities beyond a basic grouping; status/stories; polls and events; live sessions and
WebRTC signaling; escrow; broadcast lists; view-once; moderation console; HCS-10 interop with
non-AgentLine agents; formal verification of the handshake; external audits.

## Two findings from building it

Both were caught by writing the tests, and both are fixed:

1. **A sender-key distribution generated after sending advertised an already-advanced chain**,
   making the epoch's earlier messages permanently unreadable by a member who joined the
   distribution late. Distributions now carry the epoch *seed* (as Signal does), and
   re-applying a distribution cannot rewind a chain past keys already consumed — rewinding
   would have re-opened a replay window.

2. **An agent decrypting its own relayed message corrupted its ratchet.** In sealed mode the
   envelope carries no sender device, so self-attribution has to come from the ratchet key
   rather than from bookkeeping. Decryption also now runs against a copy of the session state,
   so a failed decrypt — wrong key, shredded key, stale epoch — can never leave a session
   half-advanced.

## Before this could take real traffic

- External audits: crypto protocol, contract, gateway.
- Key-transparency auditor with inclusion proofs (the log exists; verification does not).
- MLS for groups above a few hundred members.
- Relayer keys in an HSM/KMS, multi-sig admin and a timelock on the contract.
- A real datastore for the index, and a mirror-node subscription so the indexer follows the
  chain continuously rather than on demand.
- Legal review of the crypto-shredding position against erasure requirements, and of in-chat
  payments staying non-custodial.
