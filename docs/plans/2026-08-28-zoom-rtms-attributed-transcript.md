# Zoom → canvas: realtime attributed transcript via RTMS (design)

**Date:** 2026-08-28
**Status:** Design only — researched and scoped with owner, not implemented. No
spike run yet; two open questions (below) must be answered before build.
**Context:** The scribe today transcribes the *canvas room's own* LiveKit
session (`transcriber/src/transcriber.ts`). The ask is to extend that to Zoom
meetings, so that what people say on Zoom lands in the room transcript with the
same speaker attribution and the same spatial decoration — "who said what, and
what were they doing on the canvas when they said it."

## Scope

**In:** Zoom meetings **hosted on our own Zoom Pro account**, with signed-in,
named participants. Realtime (a couple of seconds of latency is acceptable).
Text only. Attributed per speaker. Decorated with the speaker's canvas position
where they have a canvas tab open.

**Out, deliberately:**

- **Meetings hosted by other organisations.** See "Why not a meeting bot" —
  Zoom closed this route during 2026 and reopening it is a distribution
  problem, not an engineering one.
- **Audio ingestion.** We want text. The existing audio pipeline
  (`segmenter.ts`, `wav.ts`, `stt.ts`, the Groq dependency, the scribe's CPU
  reservation in `deploy/systemd/ensembleworks-media.slice`) is **not used** on
  this path and is not modified by it.
- **Google Meet.** Same shape of problem, different integration; deferred. No
  research done on Meet's current bot policy — do not assume it mirrors Zoom's.

## Decisions

| Question | Decision |
| --- | --- |
| How do we get Zoom audio? | **We don't.** Zoom RTMS delivers a realtime *transcript* stream with speaker attribution. No bot, no browser, no STT. |
| Bot joining the meeting? | **No.** RTMS is a server-side data pipeline; nothing joins the meeting as a participant. |
| Marketplace app type? | **Private (unpublished) app.** No App Submission Review for own-account use. |
| Where does the Zoom transcript land? | The **existing** `POST /api/scribe/transcript`. Zoom becomes a second transcript source behind one unchanged sink. |
| How is speech tied to canvas position? | The **existing** server-side stamping in `server/src/features/transcript.ts`. No new decoration mechanism. |
| How do we join a Zoom participant to a canvas user? | **Email**, verified on both sides (see "The identity join"). Config mapping table as fallback. |
| Interim vs final caption text? | **Open question 1** — determines whether the transcript store changes at all. |

## Why not a meeting bot (the research trail — perishable, dated)

Recorded because it is the reason the scope above is what it is, and because
Zoom's policy here moved twice in 2026 and will move again.

- **2026-03-02** — Zoom began requiring an On Behalf Of (OBF) token for Meeting
  SDK apps joining meetings hosted by **external** accounts.
- **~2026-07-07** — anonymous external joins started hard-failing with
  `AppCanNotAnonymousJoinMeeting`. Zoom is declining Anonymous Join Exception
  requests; staff position on the developer forum is that they "no longer allow
  anonymous participants to join Zoom meetings."
- An OBF token can only be minted for a user who has OAuth-authorized our app
  **and is actively present in the meeting**, and the SDK session is tied to
  that user's presence (the "chaperone rule") — when they leave, the bot is
  ejected.

Consequence: a bot that scribes *other people's* meetings requires every such
organisation to install our published app and keep an authorized human in the
call. That is the business Recall.ai is in; it is not a side quest.

**For meetings within the app owner's account, none of this applies** — Zoom's
own OBF FAQ states only the JWT is needed. That carve-out is what makes this
design cheap, and it is also what pins the scope: the distinction that matters
is **who hosts**, not who attends. External guests attending *our* meeting are
fine.

The headless-browser-on-web-client route sidesteps the Marketplace entirely but
is precisely the anonymous-join pattern Zoom spent 2026 closing, and
third-party use of an unpublished app is against their API License Terms.
Rejected — not a foundation to build on.

> **Re-verify before building.** Every Zoom fact above was checked on
> 2026-08-28 and this area is volatile. If this document is more than a couple
> of months old when you pick it up, re-check the OBF FAQ and RTMS docs first.

## Architecture

```
Zoom meeting (our Pro account)
  │  meeting.rtms_started / meeting.rtms_stopped  (webhook, HTTPS)
  ▼
sync server: new RTMS webhook route
  │  signaling WS handshake → media WS (transcript)
  ▼
@zoom/rtms  →  onTranscriptData(data, size, timestamp, metadata)
  │
  │  map: metadata → { identity, name, t }
  ▼
POST /api/scribe/transcript          ← UNCHANGED
  │
  │  server stamps from live presence (page / cursor / frame)
  ▼
transcript store (JSONL)  →  minutes, conversation-map, agent pollers
```

The adapter is the whole integration. Zoom's own example is five lines:

```js
import rtms from "@zoom/rtms";
rtms.onWebhookEvent(({ payload }) => {
    rtms.onTranscriptData((data, size, timestamp, metadata) =>
        console.log(`${metadata.userName}: ${data}`),
    );
    rtms.join(payload);
});
```

Replace the `console.log` with the existing `postTranscript()` and the scribe
exists. `@zoom/rtms` is Zoom's official cross-platform wrapper over their C++
SDK with Node bindings — there is no C++ work in this design.

## What is reused vs. new

| | |
| --- | --- |
| **Reused unchanged** | `POST /api/scribe/transcript` and its contract (`contracts/src/tools/scribe.ts`); the spatial stamping in `server/src/features/transcript.ts`; `contracts/src/stamp.ts`; the transcript store; every downstream consumer (`minutes`, `conversation-map`, agent pollers) |
| **Unused on this path** | `transcriber/src/segmenter.ts`, `wav.ts`, `stt.ts`; the Groq STT key; LiveKit subscription |
| **New** | RTMS webhook route + signature/CRC validation; the `@zoom/rtms` adapter; meeting→room routing; identity join; (conditionally) time-indexed stamp lookup |

The transcriber workspace ends up with **two sources sharing one sink**. Worth
extracting a small `TranscriptSource` seam — `{speakerId, name, text, t}` — so
the LiveKit and Zoom paths converge at `postTranscript` rather than duplicating
it. The seam is at the *text* level, not the audio level.

## The identity join

The stamping lookup keys on `identity` == tldraw presence userId:

```js
const want = rawUserId(identity)
const ref = getCursorRefs(room).find((r) => rawUserId(r.userId) === want) ?? null
```

Zoom hands us a Zoom user — a different namespace — so out of the box every
Zoom-sourced line lands **unstamped** (nulls, gracefully; the endpoint requires
only a non-empty `identity`).

The join key already exists on both sides. `server/src/kernel/presence.ts`
builds participants from `ctx.sessions.identitiesByUser`, carrying a **verified
email** per canvas user from Cloudflare Access; `ctx.sessions` is already in
scope in the transcript router, so the join needs no new infrastructure. Zoom
participants are signed in, so RTMS metadata should expose an email —
**open question 2**. A config mapping table is the fallback for a known team.

Use a namespaced identity (`zoom:<userId>`) for unmatched speakers so the two
sources can never collide in the store, and consider a `source` field on the
entry so consumers can tell Zoom lines from LiveKit ones.

**Precondition, by design:** the stamp is computed by the speaker's *own
browser* from its CRDT replica and published via `presence.meta.stamp`. A
participant dialled in from a phone with no canvas tab has no presence record
and therefore no stamp. `contracts/src/stamp.ts` is explicit that there is no
server-side geometry fallback. This is correct behaviour, not a gap to fill.

## What the decoration actually carries

Richer than a raw cursor. `computeStamp` has a three-tier fallback:

1. **Selection wins** — an explicit "I'm working *here*"; `at` is the selection centre.
2. Else the **cursor when inside a frame** — pointing at something.
3. Else the **viewport centre** — what they're looking at.

Plus `frame: {name, dist}` — containing frame at `dist: 0`, else the nearest
with a distance. **Consumers should threshold on `dist`**: `dist: 0` is real
evidence; a nearest-frame several hundred px away is weak and probably should
not decorate anything.

## Timing skew — the one real design problem

**The stamp is taken at append time, not speech time.** This defect already
exists on the LiveKit path (utterance ends → Groq round-trip → post) and gets
worse with RTMS plus any finalization buffer. It bites hardest exactly where
the feature is most valuable: someone says *"this sticky here is wrong,"* then
clicks away; two seconds later we stamp where they are now and the decoration
points at the wrong thing.

Fix: RTMS supplies a per-segment `timestamp` and `postTranscript` already
accepts an optional `t`. Keep a short ring buffer of each user's stamp in
`ctx.sessions` (~60s, sampled on presence change) and resolve the stamp **as of
`t`** rather than as of now. Contained: `server/src/features/transcript.ts`
plus a small store. Improves the existing LiveKit path for free.

## Open questions — resolve in a half-day spike before designing further

1. **Does RTMS emit finalized segments or rolling revisions?** If finalized,
   nothing downstream changes. If revisions, we buffer until stable (~1–2s,
   inside the latency budget) rather than adding update semantics to the
   append-only store (`server/src/transcript-store.ts`) and to every consumer.
   This single answer determines the shape of the rest.
2. **What is actually in `metadata`?** Specifically: is there a stable Zoom
   userId and an email? Dump the whole object. Determines whether the identity
   join is free or needs a mapping table.

Run both against ngrok with a throwaway app before writing any production code.

## Delivery sequence

Each step is independently useful and independently verifiable.

1. **Pipe** — RTMS webhook + adapter; Zoom lines land in the room transcript,
   unstamped, attributed by display name. Proves credentials, webhook
   reachability, and the stream.
2. **Attribution** — the email join; Zoom lines acquire canvas identity and
   start picking up stamps from live presence.
3. **Accuracy** — time-indexed stamp lookup; decoration means what it claims.

## Risks

- **Public webhook vs. CF Access.** Zoom must reach the webhook route
  *unauthenticated*, and prod sits behind CF Access. Needs a bypass rule scoped
  to that path, plus Zoom's signature verification doing the auth instead.
  Likely the fiddliest part of the build.
- **Policy drift.** Re-verify (see box above).
- **RTMS enablement.** Requires an admin toggling "Share realtime meeting
  content with apps" and Developer Pack credits on the account. Confirm the
  entitlement lands before scheduling build work.
- **Transcript quality is Zoom's**, not ours — we lose the ability to swap STT
  models on this path. Accepted: attribution and zero-ops are worth more here
  than marginal word accuracy.

## Cost

Developer Pack credits, priced per minute of stream: **25,000 min / $23**,
250,000 / $225, 1,000,000 / $870 (1-year packs). Eligibility is gated on the
developer account holding credits rather than on a plan tier, so **Pro
qualifies**. For a team room this is hundreds of hours of transcription for
pocket change.

## Effort

**~3–5 days** to working end-to-end, assuming the spike answers land where
expected. Residual risk is ops (the public webhook) and the identity join —
not media, not app review, not cost.

## References

- [FAQ: Updates to Meeting SDK authorization](https://developers.zoom.us/docs/meeting-sdk/obf-faq/) — the own-account carve-out
- [Transitioning to OBF tokens in Meeting SDK apps](https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/)
- [Anonymous Join Exception — developer forum](https://devforum.zoom.us/t/anonymous-join-exception/144677)
- [Get Zoom transcripts in 5 lines of code](https://developers.zoom.us/blog/realtime-media-streams-meeting-transcripts/)
- [zoom/rtms — Node/Python/Go bindings](https://github.com/zoom/rtms)
- [Getting started with Realtime Media Streams](https://developers.zoom.us/docs/rtms/meetings/getting-started/)
- [RTMS webhook events reference](https://developers.zoom.us/docs/api/rtms/events/)
- [Zoom developer pricing](https://zoom.us/pricing/developer)
