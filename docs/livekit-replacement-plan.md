# LiveKit Cloud replacement — evaluation & spike plan

- **Status:** Re-evaluated 2026-06-20 → **self-host LiveKit OSS is the preferred path**;
  the RealtimeKit spike is no longer the next step. See [Re-evaluation &
  measurements](#re-evaluation--measurements-2026-06-20) below.
- **Date:** 2026-06-18 (original) · 2026-06-20 (re-evaluation)

## Context

EnsembleWorks runs spatial voice/video on **LiveKit Cloud**. The free *Build* tier
(5,000 WebRTC min/month) is now exhausted, and the next tier (*Ship*) is
**$50/month**. We run **regular daily mob sessions**, so usage will keep exceeding
any small free allowance — we need a cheaper standing arrangement.

LiveKit is wired deep into three packages, which is what makes "just switch
providers" expensive:

- **Client** — `client/src/av/useLiveKitRoom.ts` uses `livekit-client` `Room`; each
  remote audio track is routed through a **WebAudio source→gain→destination**
  pipeline for spatial audio (gain = canvas distance, driven by `AvOverlay`), and it
  relies on `ActiveSpeakersChanged`. Participant identity = the tldraw presence
  `userId`.
- **Server** — `server/src/app.ts` mints a **self-signed JWT** access token at
  `/api/livekit-token` (member vs subscribe-only `scribe`) and kicks via
  `RoomServiceClient.removeParticipant`.
- **Scribe** — `transcriber/src/transcriber.ts` is a subscribe-only
  `@livekit/rtc-node` bot that pulls **raw 16 kHz PCM per participant** → VAD → Groq
  Whisper. This per-participant raw-frame access is the hardest feature to replace.

Two constraints shape the options: (1) the host VM is **tiny** — 2 vCPU, 1.9 GiB RAM
with ~300 MiB free and a history of OOM reboots (an `ensembleworks.slice` caps the
dev services at `MemoryMax=1400M`); (2) the box currently **opens no inbound ports**
— everything reaches it via Cloudflare Tunnel, which cannot carry WebRTC media. The
team is willing to open inbound media ports if needed.

## Options considered

| | Self-host LiveKit | CF Realtime SFU | **CF RealtimeKit** | LiveKit Cloud |
|---|---|---|---|---|
| App rewrite | None | Heavy (raw WebRTC) | **Moderate (swap SDK)** | None |
| Room/presence/active-speaker | Built-in | You build it | **Built-in** | Built-in |
| Scribe | Keep | Rebuild (Opus→PCM WS) | **Retire → built-in STT** | Keep |
| Infra / VM load | Own a server, resize VM | None | **None** | None |
| Ports | Open media ports | Closed | **Closed** | Closed |
| Latency | Single region | Global edge | **Global edge** | Global edge |
| Cost | $0 + VM (~€8–15) | ~$0 (1 TB free) | **~$6–26/mo (free beta)** | $50/mo |
| Lock-in | OSS (low) | Std WebRTC (none) | **Proprietary SDK** | Managed |

RealtimeKit keeps the box load-free and ports-closed (the team's load/bandwidth/
latency concerns) **and** plausibly keeps the bespoke spatial canvas via its
headless Core SDK (`@cloudflare/realtimekit`) — *if* the SDK exposes raw tracks and a
usable server token flow. Those "ifs" are exactly what the spike tests. The raw CF
SFU is cheapest but is the heaviest rewrite (no rooms, no SDK); self-hosting LiveKit
is zero-code but forces a VM resize + open ports.

## Plan: spike Cloudflare RealtimeKit, fall back to self-host LiveKit OSS

We spike **Cloudflare RealtimeKit** (free in beta) as the preferred replacement
before committing. The spike is throwaway code (isolated under `spike/realtimekit/`,
deleted afterward) that proves or kills the unknowns. **If it fails, we fall back to
self-hosting the open-source LiveKit server** (zero application code change).

### Riskiest assumptions to de-risk (in priority order)

1. **Raw track access (make-or-break)** — the Core SDK exposes a remote participant's
   audio as a real `MediaStreamTrack` we can drive with our existing WebAudio gain
   pipeline. If not, spatial audio dies and RealtimeKit is out.
2. **Server meeting/token flow** — replace the self-signed JWT with RealtimeKit's REST
   flow: API-token → **Create Meeting** → **Add Participant** (`custom_participant_id`
   = tldraw userId, a `preset_name`) → returns the participant `authToken` for
   `RealtimeKitClient.init({ authToken })`.
3. **Multi-participant + active-speaker** — two browsers in one meeting see/hear each
   other; an active-speaker event fires (replaces `ActiveSpeakersChanged`).
4. **Scribe path (secondary probe)** — confirm built-in transcription can deliver
   utterances (webhook → `/api/transcript`); otherwise document the gap and the
   server-side-bot alternative. Full parity is out of spike scope.

### Spike build (throwaway, under `spike/realtimekit/`)

Kept out of `client/`, `server/`, `transcriber/` so it deletes cleanly; reuses the
WebAudio pipeline *logic* by mirroring `useLiveKitRoom.ts` (copy, not import).

1. **`token-server.mjs`** — tiny Node HTTP server. Reads `CF_ACCOUNT_ID`,
   `CF_RTK_APP_ID`, `CF_RTK_API_TOKEN`. `GET /token?id=&name=`: Create Meeting (once),
   Add Participant with `custom_participant_id=id`, return `{ token, meetingId }`.
   Plain `fetch` to the Cloudflare REST API with `Authorization: Bearer`. Proves #2.
2. **`index.html` + `main.ts`** — minimal page (served by Vite). `RealtimeKitClient.init`,
   enable mic/cam, render local video. For each remote participant, take their
   `audioTrack` (MediaStreamTrack) → copy of `attachAudio` (source→gain→destination +
   muted keep-alive) with a **per-peer gain slider** to prove loudness control (#1);
   render their `videoTrack`; log participant join/leave and **active-speaker** events
   (#3).
3. **Scribe probe (#4, lightweight)** — enable transcription on the preset and confirm
   a transcript event/webhook arrives; else document the gap. No Groq wiring.

### Prerequisites (team must provide — cannot be self-served)

A **Cloudflare RealtimeKit app** (free in beta) → `CF_ACCOUNT_ID`, `CF_RTK_APP_ID`; an
**API token** `CF_RTK_API_TOKEN`; a **participant preset** with transcription enabled.
Place these in a gitignored `spike/realtimekit/.env` (never commit the API token).

### Pass / fail

- **PASS (RealtimeKit viable):** server mints a participant token; two tabs see+hear
  each other; a remote `audioTrack` is a real `MediaStreamTrack` whose loudness tracks
  the gain slider; an active-speaker event fires while talking.
- **Scribe:** PASS if built-in transcription delivers utterances we could POST to
  `/api/transcript`; else record it as the main migration risk and cost.
- **FAIL (drop RealtimeKit → self-host LiveKit OSS):** no raw `MediaStreamTrack`
  (spatial audio impossible), or the token/meeting flow can't carry the tldraw-userId
  identity.

### Fallback: self-host LiveKit OSS (if the spike fails)

Zero application code — repoint `LIVEKIT_URL` + own keys — but it adds ops: **resize
the VM** (the current box would OOM under an SFU; ~€8–15/mo for a CPX21/CPX31), **open
inbound media ports** (UDP range + TURN/TCP — a deliberate change to the "no inbound
ports" posture), run `livekit-server` under a new systemd unit (outside the
memory-capped slice), proxy signaling at `/livekit` via Caddy. Single-region latency.

## After the spike

- Record the verdict + surprises here; **delete `spike/realtimekit/`**.
- If PASS: full migration plan — rewrite `useLiveKitRoom.ts` on the `meeting` API,
  replace `/api/livekit-token` + kick with RealtimeKit REST calls, decide scribe
  (built-in STT vs bot); keep `AvOverlay`/spatial + canvas untouched.
- Per the team's decision process ([decisions/ADR-0001](../../decisions/0001-lightweight-decision-process.md)),
  the final provider choice is a one-way-ish door → land it via a decision PR.

## Re-evaluation & measurements (2026-06-20)

Two things changed between the original plan and now, and both weaken the case
for the RealtimeKit spike and strengthen self-hosting LiveKit OSS.

### What changed

1. **The VM's RAM constraint — the plan's primary objection to self-hosting —
   is gone.** Per [`memory-resource-policy.md`](./memory-resource-policy.md),
   the box was resized to **8 GB** (7.6 GiB usable) and the cgroup policy was
   rewritten from a hard `MemoryMax=1400M` cap to percentage-based limits
   (`MemoryHigh=78%` ≈ 5.9 G, `MemoryMax=88%` ≈ 6.7 G) with the three core
   services protected via `MemoryLow`. The plan's "the current box would OOM
   under an SFU; resize the VM (~€8–15/mo)" fallback premise no longer holds —
   the resize is a **sunk cost with $0 incremental hosting**.
2. **RealtimeKit at GA is likely *more* expensive than the $50 being escaped,**
   for this team's actual usage. The plan's table estimated RealtimeKit at
   ~$6–26/mo, but that range is inconsistent with "regular daily mob sessions +
   video." At GA ($0.002/min A/V, $0.0005/min audio) against ~6 people × ~5
   hrs/day × ~22 days ≈ 39,600 participant-min/month: cameras-on A/V ≈ **$79**
   (above LiveKit Cloud Ship's $50); audio-only ≈ **$20**. RealtimeKit is only
   cheaper than LiveKit Cloud if mobbing is audio-only. The free beta is
   genuinely free, but as a *strategic* platform it does not beat what we are
   escaping — so it is at most a throwaway free stopgap, not a target.

The plan's "moderate (swap SDK)" label for RealtimeKit also understates the
rewrite: `client/src/av/useLiveKitRoom.ts` and `AvOverlay.tsx` are built on
LiveKit's **track-publication** model (`TrackSubscribed`, `getTrackPublication`,
`isMuted`, `permissions.canPublish` flagging the scribe `readOnly`); RealtimeKit
is **meeting/participant-centric**, so every event the spatial pipeline and the
faces-rail depend on gets re-mapped — a rewrite of the A/V layer, not a swap.
The scribe's per-participant raw PCM gives diarization-by-track and lets each
utterance be stamped with the speaker's **live cursor position**; RealtimeKit
built-in STT delivers utterances via webhook after the fact, so cursor-stamped
transcripts are lost and a server-side bot subscribing to raw tracks would be
needed — itself unproven on RealtimeKit. So the scribe is a rebuild on
RealtimeKit regardless, while on self-host it is **zero change**. Vendor
concentration also cuts against RealtimeKit: [`canvas-on-cloudflare-design.md`](./canvas-on-cloudflare-design.md)
already moves canvas + access onto Cloudflare; adding media would put the entire
interactive experience on one proprietary vendor, whereas self-hosted LiveKit
OSS is open and portable and keeps the media plane independent.

### Two capacity gates the original plan never measured

The original plan killed self-host on RAM before it had to check the two things
that now gate it. Both were measured on the live box on 2026-06-20:

**Uplink capacity (the VM uplink now carries SFU egress, previously ≈0):**

| Direction | Payload | Time | Throughput |
|---|---|---|---|
| Download (Azure CDN → VM) | 163 MB | 2.34 s | ≈ 70 MB/s ≈ **560 Mbps** (single TCP stream) |
| Upload (VM → Cloudflare `__up`) | 50 MB | 0.52 s | ≈ 96 MB/s ≈ **770 Mbps** |

A 6-person mob with cameras on (~2.6 Mbps/stream, 720p audio+video) needs ~16
Mbps ingress and **~78 Mbps egress** to the SFU (6 senders × 2.6 × 5 receivers)
— about **10% of the measured 770 Mbps uplink**. Even at 1080p (~5 Mbps, ~150
Mbps egress) it is ~20% of uplink. Bandwidth is a non-issue.

**CPU headroom (the SFU now shares the 2 vCPU with the latency-critical sync
server, per [`architecture-spec.md`](./architecture-spec.md) §6.6):**

| Metric | Reading |
|---|---|
| vCPU | 2 |
| Load avg (1/5/15 min) | 0.25 / 0.13 / 0.07 |
| CPU idle (`vmstat`) | 92–98% |
| Free RAM | 5.9 GiB (+ 1.9 GiB swap, 72 MiB used) |
| cgroup CPU weights (slice + services) | **none set** |

A LiveKit SFU (Go, **no transcoding** — it forwards RTP) for a single 6-person
room is well under ~0.3 core even at peak; two vCPU absorb it trivially alongside
the sync server and tmux. **One design note surfaced:** there is no CPU
isolation in place today, so the §6.6 concern ("SFU spike stutters cursors") is
the real thing to manage — not capacity. The fix is a one-line extension of the
existing memory-policy pattern: run `livekit-server` in **its own slice with a
`CPUWeight` below the sync/term services and its own `MemoryMax` outside
`ensembleworks.slice`**, so the SFU is the spiky, low-blast-radius tenant that
gets throttled first — the same role `term` plays in the memory policy.

### Re-ranked options

| Option | True cost (this usage) | App rewrite | Scribe | Remaining objection | Verdict |
|---|---|---|---|---|---|
| **Self-host LiveKit OSS** | **$0 incremental** (box already 8 GB) | None | None | Single-region latency + CPU-isolation config | **Preferred** |
| LiveKit Cloud Ship | $50/mo | None | None | Cost | "Do nothing" baseline; $50 buys global edge + zero ops |
| CF RealtimeKit (beta) | $0 now | Heavy-ish | Rebuild/uncertain | Lock-in, scribe parity, throwaway | Free stopgap only |
| CF RealtimeKit (GA) | ~$20–79/mo | Heavy-ish | Rebuild/uncertain | Cost ≥ self-host + lock-in | Disqualified |

### What this means for the spike

The RealtimeKit spike is **not** the next step. Its main value was proving the
raw-track assumption (#1) — which only matters if RealtimeKit is a desirable
strategic platform, and the GA-pricing + scribe-parity + lock-in re-evaluation
says it is not. Running it would burn effort toward a target we no longer want.

The next step is the self-host LiveKit OSS migration spec:
[`livekit-self-host-spec.md`](./livekit-self-host-spec.md). Per
[ADR-0001](../../decisions/0001-lightweight-decision-process.md) the final
provider choice is a one-way-ish door, so it lands via a decision PR rather than
unilaterally. The one genuine trade left to weigh consciously is **single-region
latency** for any far-region participant versus $50/mo for LiveKit Cloud's
global edge — a clean two-way-door-ish decision for the team.

## Sources

- [RealtimeKit Core SDK — `@cloudflare/realtimekit`, `RealtimeKitClient.init`](https://developers.cloudflare.com/realtime/realtimekit/core/)
- [Add Participant REST API (returns participant token)](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/meetings/methods/add_participant)
- [RealtimeKit pricing — free in beta; GA $0.002/min A/V, $0.0005/min audio](https://developers.cloudflare.com/realtime/realtimekit/pricing)
- [Cloudflare Realtime SFU — track-centric, no rooms/SDK](https://developers.cloudflare.com/realtime/sfu/introduction/)
- [LiveKit self-hosting — ports & TURN](https://docs.livekit.io/transport/self-hosting/deployment/)
