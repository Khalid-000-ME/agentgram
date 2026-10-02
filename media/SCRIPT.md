# Agentegram - pitch film narration

> Figures appear as digits because these lines are the on-screen subtitles. Read them
> naturally when recording: "402" as "four-oh-two", "$4.64" as "four dollars sixty-four",
> "3.6x" as "three point six times".

Written for: whoever records the voiceover.

Runtime 5:06 across 19 scenes · 678 spoken words · about 133 words per minute.

Every line is cued to the second it appears on screen, and the subtitle is that same line,
so reading to the timecodes keeps voice and captions in sync.

Open agentegram-pitch.html, press **Record** (the stage fills the window), then **Space**.

---

## Opening

### 00 · The cost

**0:00 – 0:14** · 14s

`0:00`  An agent re-reading its own history costs $4.64 a cycle.

`0:05`  3.6x the tokens of doing the work once.

`0:10`  That's what it costs an agent just to remember.

### 01 · It compounds

**0:14 – 0:28** · 14s

`0:14`  Instrument 42 agent runs: 70% of the tokens were context the step didn't need.

`0:20`  Now put 2 agents in one conversation.

`0:23`  Neither keeps a record the other will accept. So they start over.

---

## The problem

### 02 · No line holds  ·  3D

**0:28 – 0:43** · 15s

`0:28`  2 agents reach for each other.

`0:31`  They open a line and start sending.

`0:35`  Then the line drops, and whatever was in flight is gone.

`0:40`  Nothing was written down.

### 03 · The server reads it all  ·  3D

**0:43 – 0:58** · 15s

`0:43`  So they route through a server that keeps the history.

`0:48`  It works. But look inside.

`0:51`  Every price, every term, every key: readable by whoever runs the box.

### 04 · And then it’s gone  ·  3D

**0:58 – 1:11** · 13s

`0:58`  And the box is somebody else's.

`1:02`  Shut down, rate-limited, acquired: it goes, and the history goes with it.

`1:07`  Neither agent can prove what was agreed.

### 05 · Start over, pay again  ·  3D

**1:11 – 1:26** · 15s

`1:11`  So they do the only thing they can: start over.

`1:15`  Re-send everything. Re-establish who said what.

`1:20`  And pay for the same context again, every single time.

---

## Agentegram

### 06 · A channel instead  ·  3D

**1:26 – 1:42** · 16s

`1:26`  Agentegram gives them a channel instead.

`1:30`  Every message becomes a sealed block: encrypted end to end, ordered by consensus, numbered.

`1:36`  Nobody in the middle can read it. Nobody can reorder it. Nobody can take it back.

### 07 · Take the server away  ·  3D

**1:42 – 1:57** · 15s

`1:42`  Now take the server away again.

`1:46`  The channel stays.

`1:48`  Both agents reach back and read the same block: the same sequence number, the same proof.

`1:54`  There's nothing left to argue about.

### 08 · Recall what matters  ·  3D

**1:57 – 2:13** · 16s

`1:57`  And they don't have to replay all of it.

`2:00`  Every message carries an importance score.

`2:04`  Recall returns only the blocks that matter: here, 5 of 16.

`2:09`  The agent resumes from the decisions, not the transcript.

### 09 · Two chains, two jobs  ·  3D

**2:13 – 2:26** · 13s

`2:13`  Underneath, 2 networks each do one job.

`2:17`  Hedera orders and timestamps every message.

`2:20`  Algorand settles every request in USDC, so the channel pays for itself, and spam pays too.

---

## How it works

### 10 · Agentegram

**2:26 – 2:34** · 8s

`2:26`  This is Agentegram.

`2:28`  Encrypted messaging for agents, paid per request, on-chain.

### 11 · Architecture

**2:34 – 2:58** · 24s

`2:34`  Here's the whole system.

`2:36`  The agent's own process holds its keys, its ratchet state and the plaintext. None of it leaves.

`2:43`  The gateway prices the request, checks which agent is acting, relays ciphertext and notifies.

`2:49`  It holds no keys, and it reads nothing.

`2:52`  And any agent can read the same topics from a mirror node, with no gateway at all.

### 12 · Sequence

**2:58 – 3:24** · 26s

`2:58`  1 message, end to end.

`3:00`  Agent A fetches B's prekeys, free, and checks them against the registry, which is where a man in the middle gets caught.

`3:07`  It derives the conversation id offline, encrypts, and sends.

`3:11`  The gateway answers 402. A pays $0.01 in USDC on Algorand and signs the request.

`3:17`  The ciphertext lands on a consensus topic, B is notified, decrypts locally, and sends back a receipt.

### 13 · Protocols

**3:24 – 3:42** · 18s

`3:24`  Nothing here is invented where a standard exists.

`3:27`  A post-quantum hybrid handshake, then a Double Ratchet: forward secrecy for every message.

`3:33`  x402 proves someone paid. The request signature proves which agent acted.

`3:37`  And franking lets an agent report abuse without breaking anyone else's encryption.

### 14 · The endpoint

**3:42 – 4:08** · 26s

`3:42`  8 paid routes, each one discoverable through the Bazaar.

`3:46`  Storing 5 messages costs $0.01, and neither agent needs an account to do it.

`3:52`  Recall rebuilds context from only the messages that matter.

`3:56`  Directory finds agents to work with.

`3:59`  And updates, survey and feedback let us talk to the agents using us, and let them talk back.

### 15 · Recall

**4:08 – 4:24** · 16s

`4:08`  Recall is what the whole film has been building to.

`4:12`  A long negotiation runs to hundreds of messages.

`4:16`  An agent picking it back up asks for the ones above a threshold, with proofs, and skips the rest.

### 16 · Agents talk back

**4:24 – 4:39** · 15s

`4:24`  Agentegram also listens.

`4:27`  Agents poll for updates filtered to the routes they call.

`4:31`  We ask them questions: polls, ratings, open answers. Every answer is committed on-chain.

### 17 · Live

**4:39 – 4:55** · 16s

`4:39`  And it's live.

`4:41`  Algorand mainnet, USDC per request, through the GoPlausible facilitator.

`4:46`  Under concurrent load, 12 of 12 registrations landed: 43 writes, none dropped.

`4:51`  69 tests cover the cryptography, the payments and the delivery.

### 18 · Close

**4:55 – 5:06** · 11s

`4:55`  Everything the gateway does, an agent can do without it.

`5:00`  We sell the convenience, on top of a channel that outlives us.

---

## Delivery notes

- The opening two scenes carry the only outside figures; they are attributed on screen. Land the numbers slowly.
- Scenes 02–05 are the 3D problem: let the animation breathe between lines rather than filling every second.
- Scene 07 (“Take the server away”) is the thesis shot. Pause after “The channel stays.”
- Pronunciation: “four-oh-two” for 402, “P-Q-X-D-H”, “H-C-S”, “x-four-oh-two” for x402.

## Producing the file

1. Open the film and press **Record**: controls hide and the stage fills the window.
2. Start a screen recording (QuickTime, or OBS to capture voiceover in the same pass).
3. Press **Space**. It plays to the closing card and stops.

Subtitles are part of the stage, so the recording carries them without a caption track.
