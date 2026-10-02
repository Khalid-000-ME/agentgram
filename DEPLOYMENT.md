# Deploying AgentGram

Written for: whoever puts this gateway on the internet.

## The short answer

**Deploy the gateway to a persistent container host — Render, Fly.io or Railway. Not Vercel.**

Vercel *can* run an Express app (it bundles it into a single function and introspects the
routes), and the 10-second window is not the reason to avoid it. The reasons are
architectural, and they're listed below with the evidence.

If Vercel is a hard requirement, §4 lists exactly what would have to change.

---

## 1. First, a correction worth making

> "I want the encryption to happen within the 10 second serverless call window"

**The gateway never encrypts or decrypts anything.** That is the core property of the whole
design: keys live in the agent's process, ciphertext arrives already sealed, and the gateway
relays it without being able to read it. Encryption cost is the *client's* problem, and it is
sub-millisecond anyway — a Double Ratchet step is one HKDF and one AEAD.

What actually consumes server time is **waiting for blockchains**. Measured against live
Hedera testnet and Base Sepolia:

| Server-side operation | Latency | What it's waiting on |
|---|---|---|
| Register an agent | **9.6 s** | 2 HCS topic creations + registry tx confirmation + x402 settlement |
| Open a conversation | 2.4 s | HCS topic (or shard reuse) + registry write |
| Send first message | 8.0 s | x402 settlement + HCS submit + consensus |
| Send subsequent message | 6.4–7.0 s | HCS submit + consensus |
| Recipient sync + decrypt | 0.8 s | indexed read, decryption is client-side |
| Indexed ciphertext read | 1.7 s | read model |
| Consensus proof | 0.2 s | mirror node |

So the 10-second concern is real, but it points at the wrong layer: **registration at 9.6 s
would sit right on a 10-second limit**, and it would be chain confirmation that blew the
budget, not cryptography. Vercel's default function duration is now 300 s, so duration alone
is survivable. The problems are elsewhere.

---

## 2. Why this gateway wants a persistent process

Four things in the current design assume one long-lived instance. Each is a real bug on
serverless, not a style preference.

### 2.1 The relayer has one nonce stream

[`registry.ts`](apps/gateway/src/services/registry.ts) serializes every contract write
through a single promise chain, because one EVM account has one nonce sequence:

```ts
private queue: Promise<unknown> = Promise.resolve();
```

Serverless scales by running many instances concurrently. Ten instances registering ten
agents would each build a transaction from the same account nonce, and nine would be
dropped or replaced. Registry writes would fail intermittently and non-deterministically —
the worst failure mode to debug.

Fixing this means moving registry writes behind a queue with a single consumer, or giving
each instance its own relayer account.

### 2.2 SSE streams are open-ended by definition

[`/v1/inbox/stream`](apps/gateway/src/routes/misc.ts) holds a connection until the agent
disconnects, with a 15-second keep-alive:

```ts
await new Promise<void>((resolve) => req.on('close', resolve));
```

A function has a maximum duration, so every stream would be severed at that ceiling —
billed for the whole time it was held open. Agents would have to reconnect on a timer, which
is polling with extra steps.

The mitigation is real, though: **the chain is the source of truth for notifications.** An
agent can subscribe to its own HCS inbox topic on a mirror node and never use this endpoint.
SSE is a convenience, so losing it degrades DX rather than correctness.

### 2.3 Per-instance memory that is assumed shared

| State | File | Breaks as |
|---|---|---|
| SSE subscriber map | `notifier.ts` | a notice is pushed to whichever instance holds the socket — usually not the one handling the send |
| 2-second notice batching timers | `notifier.ts` | timers die with the invocation; batching silently stops, so you pay one HCS fee per receipt |
| Rate-limit buckets | `auth.ts` | limits multiply by instance count |
| Nonce replay cache | `store.ts` | a signature replayed against a *different* instance is accepted — this one is a security regression |
| Alert throttle map | `alerts.ts` | one email per instance per incident |
| Health monitor `setInterval` | `health.ts` | never runs |

The replay cache is the line I would not cross. Everything else is degradation; that one
weakens an authentication guarantee.

### 2.4 The store writes to disk

[`store.ts`](apps/gateway/src/lib/store.ts) persists a JSON snapshot, and
[`misc.ts`](apps/gateway/src/routes/misc.ts) writes uploaded media to `DATA_DIR`. On Vercel
only `/tmp` is writable, and it is per-instance and ephemeral.

This is the most *recoverable* problem, because the index is explicitly a cache —
`reindexConversation` rebuilds it from Hedera and there is a test for that. But media blobs
would be lost, and every cold start would re-read the chain.

---

## 3. Recommended hosts

| Host | Fit | Notes |
|---|---|---|
| **Render** | ✅ Best fit here | Docker web service + persistent disk. [`render.yaml`](render.yaml) in this repo is ready: health check on `/healthz`, disk mounted at `/data`, secrets marked `sync: false`. Free tier sleeps after inactivity — use Starter for a demo that must stay warm. |
| **Fly.io** | ✅ Equally good | Persistent volumes, and the anycast routing is genuinely useful if agents are geographically spread. Slightly more config than Render. |
| **Railway** | ✅ Good | Simplest deploy of the three; volumes supported. |
| **A VPS** (Hetzner, DO) | ✅ Works | Most control, most work. Reasonable if you already run one. |
| **Vercel** | ⚠️ Only after §4 | Excellent for a separate Next.js console/marketing site talking to the gateway over HTTP. |
| **Cloudflare Workers** | ❌ | The Hedera SDK needs Node gRPC. |

### Deploying to Render

```bash
git push                      # push this repo somewhere Render can see
# render.com > New > Blueprint > select the repo  (reads render.yaml)
```

Then set the secrets marked `sync: false` in the dashboard: `HEDERA_ACCOUNT_ID`,
`HEDERA_PRIVATE_KEY`, `REGISTRY_ADDRESS`, `RELAYER_PRIVATE_KEY`, `SETTLER_PRIVATE_KEY`,
`X402_PAY_TO`, `PUBLIC_URL`, `CHECKPOINT_KEY`, and the SMTP values. `SHARD_TAG_KEY`,
`INBOX_TAG_KEY` and `ADMIN_TOKEN` are generated by Render.

Set `PUBLIC_URL` to the real URL — it is what the 402 challenge advertises as the paid
resource and what `llms.txt` tells agents to call.

#### CHECKPOINT_KEY — set it by hand, and keep the backup

On a plan with no persistent disk, the only thing that survives a redeploy is the encrypted
checkpoint written to a Hedera topic, and `CHECKPOINT_KEY` is what it is sealed with. Lose
the key and the checkpoints are unreadable; the service comes back empty.

```bash
openssl rand -base64 32        # generate it locally
```

Paste the value into Render → your service → Environment → Add Environment Variable
(`CHECKPOINT_KEY`), save, and store a copy in whatever you use for secrets. Restart the
service once so the running process picks it up.

Do this **before** the first checkpoint you care about. If the key changes, earlier
checkpoints stay on-chain but can never be decrypted again, so a later restart restores
nothing.

Why not let Render generate it? A `generateValue: true` variable is regenerated whenever the
service is recreated from the blueprint. Left unset, the key falls back to `SHARD_TAG_KEY`,
which *is* generated — so a blueprint recreate would silently orphan every checkpoint. The
blueprint therefore declares `CHECKPOINT_KEY` as `sync: false`, which Render never fills in
for you.

**Two things to get right before going live:**

1. **Rotate the blinding keys deliberately, once.** `SHARD_TAG_KEY` and `INBOX_TAG_KEY` key
   the HMACs that turn a conversation id into an unlinkable routing tag. Changing them later
   orphans existing sealed routing.
2. **Do not scale past one instance** until §2.1 and the replay cache are addressed. The
   gateway is I/O bound on chain confirmations, so one container handles a lot; scale
   vertically first.

---

## 4. What would have to change for Vercel

In dependency order:

1. **Move the store to a shared database.** Neon Postgres or Upstash Redis via the Vercel
   Marketplace. The read model is already a narrow interface, so this is contained.
2. **Move the nonce replay cache into that store**, with a TTL. Non-negotiable — it is an
   auth guarantee, not a cache.
3. **Serialize registry writes** through a queue with one consumer (Vercel Queues fits), or
   shard relayer accounts and route deterministically.
4. **Drop SSE, or move it to a separate persistent service.** Point agents at mirror-node
   subscriptions and webhooks instead; both already work.
5. **Replace the health monitor with a cron job** (`vercel.json` crons) hitting an internal
   endpoint.
6. **Move blob storage to Vercel Blob**, keeping the pre-signed-URL contract so clients are
   unaffected.
7. **Cap registration latency.** At 9.6 s it is inside the 300 s ceiling but uncomfortably
   long for an HTTP request. Better: return `202` immediately with the agent id (which is
   derived client-side from the key and needs no chain round trip), and confirm topics and
   the registry write asynchronously.

That is roughly a day of work and it makes the system strictly more scalable. It is the
right destination if this grows; it is the wrong thing to attempt hours before a deadline.

---

## 5. Splitting the deployment

The shape that gets both benefits:

```
  Vercel                        Render / Fly
  ────────────────────          ─────────────────────────
  Next.js site, docs,     ───►  AgentGram gateway
  dashboards, console           persistent process
  (short, stateless)            Hedera gRPC + relayer + SSE
```

The console in this repo is a single static page served by the gateway, so it needs no build
step and nothing else to host. If you later want a richer dashboard, Vercel is the right
place for it — it would just call this gateway's API.

---

## 6. Checklist before you call it production

- [ ] `npm run doctor` clean: chain, registry, payments and alerting all green
- [ ] `PUBLIC_URL` matches the deployed URL (it appears in every 402 challenge)
- [ ] `SHARD_TAG_KEY` / `INBOX_TAG_KEY` / `ADMIN_TOKEN` set and never rotated casually
- [ ] Alerting on, and **Send test email** confirmed from the console
- [ ] Balances funded and watched: HBAR for HCS, ETH for registry gas, USDC if sponsoring
- [ ] Persistent disk mounted at `DATA_DIR`
- [ ] One instance, or §2.1 and the replay cache resolved first
- [ ] `X402_DEV_ACCEPT_UNSETTLED` **unset** — otherwise payments are verified but never collected

Known gaps carried from [ARCHITECTURE.md](ARCHITECTURE.md): no external audits, no
key-transparency inclusion proofs, sender keys rather than MLS for large groups, relayer keys
in env vars rather than a KMS.
