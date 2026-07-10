# Discord bot — design

Status: design agreed via brainstorming, not yet implemented.
Date: 2026-07-08.

A Discord integration that lets an EnsembleWorks room push its own outputs into
Discord (summaries, action items, decisions, frame links) and pull Discord
channel messages back into the canvas (as stickies today, routed to other
handlers later). Built as a standalone service holding one bot token, leaning on
the sync server's existing HTTP API for all room mutation.

## Assumptions that will hurt if violated

**Single-org per deployment.** Every design decision below assumes one
EnsembleWorks deployment serves one team/org — consistent with the self-hosted
`deploy/deploy.sh <user@host-tailnet-name>` per-tailnet model. Consequences:

- One bot application, **one bot token per deployment**. "Credentials across
  users/orgs" is not a secret-storage problem; it's one env var.
- **No cross-org isolation** in the binding or authorization layer.
- **Any room participant may create/remove bindings** (see Authorization) —
  because participants are mutually trusted.

If future work implies *multiple independent orgs on one deployment*, per-org
credential separation, or guild-scoped access control, **stop and revisit** —
the single-token / trusted-participant model does not hold, and the binding +
authorization layers need a redesign. This assumption is also tracked in agent
memory (`discord-bot-single-org-assumption`) so it resurfaces across sessions.

## Scope

In scope:

- **Outbound (Tier 1 + frame links):** session summary, action items, decision
  log, and frame-link cards, posted to Discord on an explicit action.
- **Inbound:** messages in a bound Discord channel become sticky notes on a
  bound frame. New messages only, text only.
- **Frame deep-link wiring:** the `?room=<slug>&frame=<id>` support needed for
  frame-link cards (a small client prerequisite, see below).
- **A router layer** so inbound messages dispatch to pluggable handlers, of
  which `frame-sticky` is the first and `agent` is the anticipated second.

Explicitly out of scope for v1 (revisit later):

- Attachments/images on inbound messages (text only for now).
- Rate/volume guards and opt-in prefixes — every message in a bound channel
  becomes a sticky.
- Backfill of channel history when a binding is created (new messages only).
- Automatic lifecycle-triggered posting (session-end auto-post). Outbound is
  explicit-action only.
- Presence/"room is live" pings, roadmap-change pings, agent status mirroring
  (the Tier 3 candidates — prove value before adding noise).

## Architecture

A **standalone bot service** — a fifth process alongside sync, gateway, Vite,
Caddy, and the livekit/whisper/scribe stack. It holds exactly two things nobody
else does: the **Discord gateway websocket** and the **bot token**. Isolating it
means the token lives in one process's environment and nothing else can leak it.

The bot has two faces:

- **Inbound face:** the Discord gateway connection. Receives message events,
  resolves bindings, hands off to the router.
- **Outbound face:** a small **internal-only** HTTP API (`POST /post`) that the
  room calls when it wants something delivered to Discord. Bound to
  loopback/tailnet, never public, gated by a shared secret.

The bot **does not own room state.** To create a sticky it calls the sync
server's existing `/api/shape`; to post a summary it receives already-composed
content from the room. All canvas mutation flows through the one code path the
`canvas` and `minutes` skills already use. The bot stays dumb about tldraw.

```
Discord  ──gateway──▶  Bot service  ──/api/shape──▶  Sync server (room state)
         ◀──send────    │  ▲
                        │  └── POST /post (internal, shared-secret) ◀── room/agent
                        └── handler registry (router)
```

## Data model: bindings & routes

Everything hangs off one abstraction. A **binding** connects a Discord channel
to a **route** inside a room:

```
Binding {
  guildId, channelId          // Discord side
  room                        // EnsembleWorks room slug
  direction: "in" | "out"
  route: { handler, params }  // e.g. { handler: "frame-sticky", params: { frameId } }
  createdBy, createdAt        // provenance = the authorization record
}
```

The **route** is the extensibility seam. `handler` is a string naming a handler
in a registry; `params` is handler-specific. The bot never hardcodes behavior —
it resolves the binding, looks up the handler, and calls it. Adding `agent`,
`roadmap-intake`, `webhook-relay`, etc. later means registering a new handler and
touching **zero** Discord-facing code.

**Storage:** all bindings live in **synced room state** and are **configurable
through the canvas UI** — they travel with the room, sync to clients, and are
visible/removable in the UI. This is the single source of truth for both
directions. Deployment config may optionally *seed* bindings on first boot (e.g.
pre-wire `#planning` to the Planning room), but config is a bootstrap
convenience, not a parallel store. The **only** thing that must live in
deployment config is the **bot token** (a secret; channel IDs are not secrets).

Two mirrored handler interfaces:

- **Outbound handler:** `(payload) → Discord embed → send`. Owns Discord
  formatting only; never reads tldraw or transcripts.
- **Inbound handler:** `handle(message, params, ctx)` → acts on the room.

## Outbound flow

The room decides to post; the bot only delivers.

1. **Trigger** — a person or the scribe/minutes agent invokes an explicit
   "post to Discord" action. **Open question:** the ergonomics of that
   trigger — a chip on the frame, a widget, or a page-level control — is
   unresolved and should be prototyped. The data path is identical regardless.
2. **Compose** — the room builds a typed payload:
   `{ kind: "summary" | "action-items" | "decision" | "frame-link", room, data }`.
   The room owns the *content* (it already has the minutes); for `frame-link`,
   `data` carries the frame id + title.
3. **Resolve** — the room finds the outbound binding(s) for this room+kind and
   calls the bot's internal `POST /post` with payload + target channel(s).
4. **Format & send** — the bot's outbound handler renders the payload into a
   Discord embed (action items → checklist, decision → decision card, summary →
   titled sections, frame-link → titled deep link) and sends via the gateway.

Division of labor: **content is composed room-side, formatting/delivery is
bot-side.** The token-holding process stays minimal and knows nothing about
tldraw or transcripts.

## Inbound flow

1. **Receive** — the gateway delivers `MESSAGE_CREATE` for `(guildId, channelId)`.
2. **Resolve binding** — look up inbound bindings for that channel. No binding →
   ignore. (This is also the security gate: an unbound channel reaches nothing.)
3. **Route** — for each matching binding, pull `route.handler` from the registry
   and call `handler.handle(message, route.params, ctx)`. `ctx` provides the
   server API base, room id, and author metadata.
4. **Handle:**
   - `frame-sticky` → `POST /api/shape` creating a note in `params.frameId`,
     carrying the Discord author's name + timestamp so it reads like
     *"@alice (Discord): …"*.
   - `agent` (future) → enqueue the message for a Claude agent in the room.

v1 rules: **new messages only** (no history backfill), **text only**
(attachments ignored), **every message becomes a sticky** (no opt-in prefix, no
rate guard). **Echo/loop prevention:** ignore `message.author.bot` so outbound
posts are never re-ingested.

## Frame deep-link (prerequisite for frame-link cards)

No frame-focused deep-link exists today, but both ends are already built; the
gap is wiring. Findings:

- Room routing is `?room=<slug>` — a single query param, no router
  (`client/src/identity.ts:60`). So the link is `?room=<room>&frame=<id>`.
- Zoom-to-shape already exists: `enterFocus(editor, shapeId)` → `zoomToBounds`
  in `client/src/chrome/focus.ts:54`. Today it is click-triggered only
  (`FocusOverlay.tsx:282`) and gated to `terminal` shapes (`focus.ts:32`).

Wiring to add:

1. **Read the param** — extend the `identity.ts:60` pattern to also read
   `?frame=`/`?shape=` and validate it as a `shape:` id.
2. **Apply after hydration** — an effect in `App.tsx` (once `editor` exists and
   the shape has arrived over sync) that resolves the id and calls
   `zoomToBounds` (or `enterFocus` for the locked/matte treatment). It must wait
   for the shape to sync in — it won't exist at mount.
3. **Allow frames to focus** — add `'frame'` to `FOCUSABLE_SHAPE_TYPES`
   (`focus.ts:32`) if reusing `enterFocus`; otherwise use a plain `zoomToBounds`
   path that bypasses the terminal-only policy.
4. **Generate the link** — add a "copy link to this frame" affordance; nothing
   serializes a shape id into a URL today.

This is a scoped prerequisite for the frame-link workflow, not a blocker for
summaries/actions/decisions.

## Security & authorization

- **Bot token** — one secret, one env var, one process. Never in repo, room
  state, or client.
- **Internal `/post`** — unreachable from the public internet: bound to
  loopback/tailnet, plus a shared secret between sync server and bot so only the
  room can request a post. Without this, anyone reaching the port can send
  arbitrary embeds to the org's channels.
- **Discord intents** — reading message text needs the privileged
  `MESSAGE_CONTENT` intent, enabled on the Discord application and requested at
  least-privilege otherwise (read/send in bound channels, nothing more). This is
  a Discord dashboard toggle, not just code.
- **Echo/loop prevention** — ignore `message.author.bot`.
- **Who may bind** — creating an inbound binding authorizes a channel to write
  into a room, so it is *the* access-control decision. Under the single-org
  assumption, **any room participant may create/remove bindings via the UI**,
  with `createdBy` recording who did. This is the decision that breaks under
  multi-tenancy (see Assumptions).
- **Deep-link exposure** — a frame URL is only as private as room access already
  is; `?room=<slug>` slugs are guessable today. The deep-link adds no *new*
  exposure but does not fix the pre-existing guessability.

## Testing

The existing suite boots the app in-process and asserts behavior
(`canvas-api.test.ts`, `scribe-api.test.ts`). The bot fits the same mold **if
Discord stays behind a thin adapter** so tests never touch the network.

- **Adapter seam** — wrap the discord.js gateway in a small interface
  (`onMessage(handler)`, `send(channelId, embed)`). Real impl in prod; a fake in
  tests that injects `MESSAGE_CREATE` events and captures sends. This one
  decision makes everything below testable.
- **Router / registry** (unit) — binding → handler dispatch; unknown handler
  ignored safely; echo-prevention drops `author.bot`; an unbound channel reaches
  nothing (the security gate).
- **Inbound `frame-sticky`** (contract) — boot the sync app in-process, feed a
  fake Discord message through the router, assert a note lands in the right frame
  via `/api/shape` with author-attributed text.
- **Outbound handlers** (unit) — each payload kind → assert the embed JSON
  (snapshot). No real Discord.
- **`/post` auth** — rejects calls without the shared secret.
- **Deep-link wiring** (client) — `?frame=` parse + `shape:`-id validation
  (`identity.ts` style), and that a valid id triggers the `zoomToBounds` path
  once the shape hydrates. Camera math is tldraw's; we test the wiring.

## Open questions

- **Outbound trigger ergonomics** — chip on the frame vs. widget vs. page-level
  control. Prototype before committing.
- **Rate/volume & opt-in** — deferred; revisit if bound channels spam frames.
- **Inbound attachments/images** — deferred; would need `/uploads` handling.
