# bb-plugin-canvas

The EnsembleWorks multiplayer infinite canvas, mounted as a first-class BB plugin
panel. Every open **Canvas** page in every bb client edits one shared Loro CRDT
document; the plugin backend is the authoritative peer and persists it.

- `server.ts` — the backend: one authoritative `SyncServerPeer` for room
  `main`, the rpc half of its transport (`canvas_join` / `canvas_frame` /
  `canvas_ping` / `canvas_leave`), the `identity` and `scribe` HTTP routes, the
  transcript query rpc and `@transcript` mention provider, an idle-client
  sweep, and a `bb canvas` CLI for inspecting the live room.
- `canvas/` — the room host (`room.ts`), its SQLite snapshot + update log
  (`store.ts`), the shared wire contract (`wire.ts`), the identity contract
  (`identity.ts`), the note → agent-thread links (`agents.ts`) and their
  overlay (`agents-ui.tsx`), the roster + audio contract (`roster.ts`,
  `av.ts`) with its UI (`roster-ui.tsx`), LiveKit (`av-room.ts`), the room
  transcript (`transcript.ts`, `transcript-view.ts`, `transcript-ui.tsx`), the
  header ↔ body seam (`panel-bus.ts`), and the frontend mount
  (`CanvasPanel.tsx`) with its tool loop, page resolution, and presence
  publisher.
- `transport.ts` — the client half of the transport: outbound frames over rpc,
  inbound frames off `bb.realtime`.
- `app.tsx` — registers the full-bleed **Canvas** nav panel, its sidebar count
  (`experimental_sidebarAccessory`), the presence strip that lives in bb's
  title bar on every route (`contentScripts`), and the room transcript's four
  doors (thread panel, new-thread panel, command palette, and the **Transcript**
  button in the presence strip's popover — reached through the
  `experimental_threadHeaderAction` relay).
- `skills/room-transcript/` — the plugin skill that teaches agents to read the
  room's spoken conversation.

Try it: open **Canvas** in the sidebar in two browser tabs, draw a note in one,
and watch it (and the other tab's cursor) appear in the other.

## How it syncs

bb has no plugin WebSocket surface, so the two directions of the canvas-sync
protocol ride different bb primitives:

| Direction | Carrier |
| --- | --- |
| client → server | plugin rpc `canvas_frame`, one base64 frame per call |
| server → client | `bb.realtime.publish("canvas:main", { to, data })` |

realtime is broadcast-only and server-publish-only, so every client receives
every publish and keeps only the frames addressed to its own `clientId`. That
is fine for a spike — frames are CRDT deltas a non-addressee merely wastes
bytes on — but it is **not** a privacy boundary.

### Staying connected

The room drops a client from its set for reasons that client cannot observe,
and a dropped client is not merely offline — it goes **silently stale**: the
server stops relaying to it, nothing it is waiting on ever fails, and it keeps
rendering a document that is quietly out of date. Three mechanisms cover the
three ways that happens:

- **The panel pings.** A tab that is only being *watched* sends nothing at all
  (presence rides pointer movement, updates ride edits), so a `canvas_ping`
  every 45s keeps it inside the backend's 2-minute idle window. Without it the
  sweep evicts live viewers.
- **The ping is also the health check.** `canvas_ping` answers
  `{ connected: false }` when the room has no transport for the caller; the
  panel treats that as "re-handshake", not "nothing happened".
- **The room pushes.** An inbound frame from a `clientId` the room does not
  know auto-joins it *and* publishes `{ to, resync: true }`. Auto-join restores
  the downstream channel, but only a fresh handshake refetches what that client
  missed while it was absent.

Plus one broadcast: a plugin reload throws away every server-side transport
while browser tabs keep their peers alive, so the backend publishes one
`{ hello: <epoch> }` per load. Every one of these paths converges on the same
client routine — re-join, then `peer.reconnect`, which re-arms the handshake
and pushes this peer's full history back up.

## Binding a shape to a bb thread — launch or attach

Select a single shape and an **Agent ▾** button appears under it, with two arms:

- **Run as new thread** — spawns a real bb thread on the note's text. Notes
  only, because it is the note's body that becomes the prompt; on any other kind
  the item is greyed rather than hidden, so it says why.
- **Attach to existing thread…** — opens a searchable list of the threads
  already in the canvas's project, most recently updated first, and binds this
  shape to the one you pick. **Any shape**: attaching sends two ids and no
  prompt, so a frame, a rectangle or an image can carry a badge just as well.

Either way that shape then carries a status dot in its top-right corner — amber
and pulsing while the agent is working, green when it is idle, red when it
failed. Clicking the dot opens a small menu naming the thread, with **Open
thread** — bb's own chat for it in a 420px panel beside the canvas, where you can
read the reply and send follow-ups — and **Unlink thread**.

| Piece | Where |
| --- | --- |
| Spawn | rpc `canvas_run_note { shapeId, text }` → `bb.sdk.threads.spawn` |
| Attach | rpc `canvas_attach_thread { shapeId, threadId }` → `bb.sdk.threads.get`, then the *same* `record` + publish the spawn uses |
| Picker | rpc `canvas_thread_options` → `bb.sdk.threads.list({ projectId, archived: false })`, ordered and capped by `canvas/thread-picker.ts` |
| Link | `bb.storage.kv`, one row per shape, mirrored in memory (`canvas/agents.ts`) |
| Status | `bb.events.on` thread.active/idle/failed → `bb.realtime.publish("canvas:threads", link)` |
| Unlink | `bb.events.on` thread.archived/deleted, or rpc `canvas_unlink_agent { shapeId }` → `publish("canvas:threads", { shapeId, unlinked: true })` |
| Seed | rpc `canvas_agents` — every link, on mount and after a realtime reconnect |
| Chat | the host `ThreadChat` component, `variant: "compact"`, `layout: "contained"` |

Four deliberate choices:

- **The link lives in kv, not in the canvas document.** The document is a CRDT
  whose schema belongs to `@ensembleworks/canvas-model`, and this spike consumes
  those packages without modifying them — so "this note has a thread" is a bb
  fact stored on the bb side, not an invented shape field.
- **Badges are plugin chrome, not shapes.** `canvas/agents-ui.tsx` layers an
  ordinary absolutely-positioned div over the viewport and positions it with the
  same `worldBounds` → `worldToScreen` transform the collaborator cursors use, so
  a badge tracks its note through pan, zoom, drag and remote edits without
  `canvas-react` knowing agents exist. The layer is `pointer-events: none` except
  on its own controls, and sits outside `<Viewport>` so a badge click is never
  also a canvas gesture.
- **Re-running, or attaching over an existing link, replaces it.** The
  superseded thread keeps its history and its sidebar row; it just stops being
  the one that shape points at. A shape is one sticky with one current answer,
  and a fan-out of orphan badges is worse.
- **One thread can only badge one shape.** The kv mirror is keyed in both
  directions (shape → thread *and* thread → shape), so a second shape claiming
  the same thread would freeze the first shape's badge and steal its lifecycle
  events. Attaching a thread that another shape already holds is refused, naming
  that shape; re-attaching the *same* thread to the *same* shape is allowed,
  because it is idempotent rather than wrong.
- **Attach verifies, then derives.** `bb.sdk.threads.get` runs *before* anything
  is written — a kv row pointing at a thread that does not resolve mounts a
  `ThreadChat` on nothing — and resolving is only half the check, since `get`
  answers for archived and deleted threads too. The badge's starting status is
  then read off that thread (`active`/`starting`/`stopping` → running, `idle` →
  idle, `error` → failed) rather than assumed; only the spawn path is entitled to
  hardcode "running", because spawning starts a turn.
- **A badge disappears when its thread ends, and only the LINK ever dies.**
  `thread.archived` and `thread.deleted` drop the kv row and broadcast
  `{ shapeId, unlinked: true }`, so the badge goes from every open tab live
  rather than lingering as a button that opens nothing. **Unlink thread** does
  the same on a human's say-so and never touches the conversation — no archive,
  no delete, no stop; destroying a thread is a decision for bb's own thread UI,
  where it can be confirmed. On load, `canvas-gc`'s first tick also asks
  `bb.sdk.threads.get` about each surviving link and drops the ones bb reports
  as already archived or deleted, since those events only reach a *loaded*
  plugin; a probe that *throws* keeps its link, because "no such thread" and
  "the call did not work" fail identically and a wrongly dropped badge destroys
  the only pointer from a note to its conversation.

Which project the threads live in is the plugin's `project` setting
(`bb plugin config canvas set project proj_…`), and **unset is a refusal, not a
default**: the launch, the picker and the attach all fail with a message naming
that setting. It used to fall back to the first project bb listed, which meant
every canvas thread silently landed somewhere the owner was not looking — see
`canvas/agent-project.ts` for the full argument, including why "guess it when
there is only one project" was rejected too. `bb canvas agents` prints every link
and its status from a shell.

Known, spike-level: deleting a *note* leaves its kv row behind (nothing renders
for it, and the row is overwritten if the id is ever reused) — the canvas
document has no delete event this plugin observes, unlike the thread side, which
does. Statuses are ephemeral
realtime messages, so a panel re-reads `canvas_agents` after a reconnect rather
than trusting a badge frozen at whatever it last saw.

### Who is at the canvas

Cursors are labelled with a real name, and each name gets its own colour.

Identity enters the plugin through exactly one door: `GET
/api/v1/plugins/canvas/http/identity`. Behind Cloudflare Access the edge
authenticates the human and stamps `Cf-Access-Authenticated-User-Email` on the
request it forwards; the route answers `{ email, name }` with the address's
local part as the name. There is no Access edge locally, so the route answers
`{ email: null, name: "local:<os username>" }` — the same shape, honestly
labelled. Both branches, against a running bb:

```
curl -H "origin: http://127.0.0.1:38886" \
  http://127.0.0.1:38886/api/v1/plugins/canvas/http/identity
# {"email":null,"name":"local:mrdavidlaing"}

curl -H "origin: http://127.0.0.1:38886" \
  -H "Cf-Access-Authenticated-User-Email: alice@example.com" \
  http://127.0.0.1:38886/api/v1/plugins/canvas/http/identity
# {"email":"alice@example.com","name":"alice"}
```

An rpc handler never sees a request, so the header can only be read here. The
panel fetches this once on mount and carries the name up on `canvas_join`; the
room keeps a clientId → name map and broadcasts it on the same realtime channel
whenever membership changes. **Names travel beside presence, not inside it** —
canvas-sync's `Presence` has no identity field and this spike may not modify
canvas-sync — and the two are joined at render time, which is exact because a
`PresenceStore`'s self key *is* the panel's `clientId`. Colour is hashed from
the *name*, not the key, so one person is one colour in all of their tabs.

Known, spike-level: the server takes a client's word for its own name, because
the name makes a round trip through the browser. Keying the map inside the
identity route (where the header is) instead of on the join rpc closes that,
and needs the panel to send its `clientId` to the route.

### The roster, and how to reach it

Two host surfaces answer "who is here" without opening anything:

| Surface | What it shows | Where it comes from |
| --- | --- | --- |
| the presence strip (`contentScripts`) | an avatar stack in BB's title bar on **every** route, plus the audio controls one click down | `canvas/panel-bus.ts` + rpc `canvas_roster` |
| navPanel `experimental_sidebarAccessory` | a dot and a number on the sidebar row | rpc `canvas_roster` + realtime |

**The strip is not inside the panel.** It is imperative DOM inserted into bb's
own header row (see [The presence strip](#the-presence-strip)) — a different
mount point with no common plugin ancestor, so no React context can span the
two. They are the same bundle in the same window, though, so
`canvas/panel-bus.ts` is a module-level store that carries the roster out to the
strip and one `panTo(clientId)` call back in. Clicking a face in the strip's
popover reads that peer's cursor from the presence store *at click time* (the
roster is a poll behind, and a moving pointer is not where it was 150ms ago) and
sets the camera so it lands dead centre, at the zoom you were already at. A face
is disabled rather than jumping somewhere invented whenever there is nowhere
honest to land — either that person has published no cursor, *or* they are on
another canvas page, whose cursors this view deliberately does not draw (design
doc D-4), so flying to their world point would drop you on empty canvas. A peer
who publishes no page at all (an older bundle) is *unknown*, not elsewhere, and
stays pannable. Both the enabled-ness of the face and the behaviour of the click
are one call to `panIntentFor` (`canvas/roster.ts`), so they cannot drift apart;
the click re-asks at click time, because the roster is a poll behind and the
page can change under a handler registered earlier. The disabled face's tooltip
says "no cursor on the canvas yet" for both cases — `DockBubble` carries a
boolean, not a reason — while the toast you get from a raced click names which
one it was. On a route with no canvas panel mounted, `panTo` is simply a no-op.

The sidebar count cannot use that bus at all: it is mounted in **every** bb
window, including ones that have never opened the canvas. So it seeds itself
with one `canvas_roster` call and then follows the room's identity broadcast,
re-reading after a realtime reconnect because those signals are ephemeral. It
renders nothing at zero — the host clips that slot to one short line, and a
permanent "0" beside the row says less than an empty space does.

Membership, not presence, is what the roster lists. The room's identity
broadcast changes on join, leave and idle sweep; presence only exists once
somebody has moved a pointer — so deriving the roster from presence would hide
the teammate who *just arrived*, which is exactly who you want to see.

### Talking: LiveKit

"Join audio" mints a token and connects the browser to a LiveKit room.

| Piece | Where |
| --- | --- |
| Settings | `livekitUrl`, `livekitApiKey` + `livekitApiSecret` (both `secret: true`) |
| Token | rpc `canvas_av_token` → `livekit-server-sdk`'s `AccessToken` |
| Connection | `canvas/av-room.ts`, one module-level `Room` (`livekit-client`) |
| Phase | `canvas/av-session.ts` — off / connecting / live, shared by every control |
| Speaking | `RoomEvent.ActiveSpeakersChanged` → the bus → strip ring + cursor ring |
| Camera | `setCameraEnabled` → `LocalTrackPublished` / `TrackSubscribed` → the bus → the strip popover's tiles |

```
bb plugin config canvas set livekitUrl wss://livekit.example.com
bb plugin config canvas set livekitApiKey API…
bb plugin config canvas set livekitApiSecret …

curl -s -X POST -H "origin: http://127.0.0.1:38886" -H "content-type: application/json" \
  -d '{}' http://127.0.0.1:38886/api/v1/plugins/canvas/rpc/canvas_av_token
# {"ok":true,"result":{"ok":false,"error":"not_configured","detail":"Set livekitUrl, …"}}
```

Four things this deliberately does:

- **The room name is a constant, not a setting.** `LIVEKIT_ROOM = "bb-spike"`
  lives in `canvas/av.ts` and nothing can override it — no setting, no query
  param, no rpc input. The production EnsembleWorks deployment points at the
  same kind of LiveKit server, and a spike that could be *talked into* joining
  the real team's room would drop strangers into a live meeting.
- **"Not configured" is a result, not a throw.** A fresh install has no LiveKit
  keys, and that is the expected state, not a fault: it comes back as
  `{ ok: false, error: "not_configured" }`, the button shows one toast reading
  "LiveKit not configured", and the canvas carries on exactly as before. Genuine
  faults (a token that will not mint) still throw.
- **The identity is resolved server-side.** `canvas_av_token`'s `clientId` is a
  *lookup key* into the room's own clientId → name map, not a claimed name, so a
  caller cannot mint a signed token naming somebody else. (That name reached the
  map through the browser in the first place — see the trust-boundary note above
  — so this is consistency, not authentication.)
- **Secrets never reach a browser.** The key and secret are `secret: true`
  settings, so they live in this plugin's 0600 secrets file and are excluded
  from `useSettings()`; only the short-lived signed token crosses.

Known, spike-level: the LiveKit participant identity **is** the display name, so
two tabs opened by one person collide in the audio room (LiveKit evicts the
older one) and a speaking ring lights every avatar with that name. Real
deployments have distinct names per human; the fix if that ever matters is
`identity = clientId` with the name in the token's `name` field, and matching
speakers on `participant.name`.

The audio path beyond token minting — mic capture, remote playback, active
speakers — needs a running LiveKit server and is validated on ew-lsp-001.
Everything before it is exercised here: `npm test` decodes the minted JWT and
checks the room, the grants and the signature offline.

### The presence strip

One route's title bar is not where a call lives. That is what the canvas page's
`headerContent` slot used to be: click a thread and the "Join audio" control was
gone, while you were still in the call and nothing on screen said so. So the
room lives in **bb's own title bar, on every page**: a **presence strip** placed
inside `[data-testid="app-page-header-content-row"]` — the 48px flex line that
already holds the page title and the page's action buttons — with one 24px
bubble per person in the room.

Where exactly, inside that row, is a **three-level chain** (`canvas/dock/
anchor.ts`), and the level is re-decided on every navigation:

| # | When | Where the strip goes |
| --- | --- | --- |
| 1 | the row has a right-hand **actions cluster** (thread routes, the canvas page — anything whose header carries action buttons) | the cluster's **first child** — so presence is leftmost of whatever the page puts there, and the page's own controls stay to its right |
| 2 | a header row but no actions in it (settings) | the **trailing child** of the row |
| 3 | no header row at all (bb's home route) | `position: fixed` in the same 48px band, top right |

Level 1 is the point: the strip reads as the leftmost item of the header's
button group rather than as something parked past the far edge of it. Because
the chain is re-evaluated, navigating settings → thread **promotes** the strip
from level 2 to level 1 and coming back **demotes** it again, with one node
move each way.

**Finding the cluster.** It has no name of its own — only Tailwind classes,
which are a restyle away from meaning something else and are not a contract.
What bb *does* name is the content inside it, so `findActionsCluster` takes the
first marker the page carries, in this order —
`[data-thread-header-workflow-actions]`, `[data-thread-header-pane-actions]`,
`[data-plugin-right-panel-toggle-portal]` — and walks **up** from it to the
element whose parent is the header row. All three markers sit inside the same
cluster, so which one a page happens to have (and therefore which is found
first) cannot change the answer; the climb is one level on a thread route and
two on the canvas page, where the toggle portal sits inside a wrapper. If the
climb never reaches a child of the row — a marker rendered into a portal
somewhere else — the cluster counts as **absent** and the strip takes level 2,
rather than attaching relative to whatever element the climb stopped on.

This is what fixed the canvas page. Level 1 used to be "insert before
`[data-thread-header-workflow-actions]`", which named the cluster only by way of
a *thread's* own buttons: the canvas page has no such element, fell to level 2,
and put the strip at the trailing edge of the row — to the **right** of the
page's open-sidebar toggle, the opposite side from every other route. Naming the
target by what it is rather than by one of its occupants places it identically
on both.

It is deliberately *not* a floating pill. That is what this used to be (a
draggable bottom-centre slab with a drop shadow) and it was in the way of
everything: over the composer, over dialog backdrops, a thing you had to move
rather than a thing you read. The strip has no shadow, no slab, no backdrop blur
and no life of its own outside the bar. It is bar furniture, and it *is* the
avatar stack the canvas page's `headerContent` used to draw in that same row,
promoted to every route.

**It does, since 2026-09-01, look like a button** — it always was one
(`<button class="dock-strip" aria-expanded>`), it just did not say so. bb's own
header icon buttons were measured on the running app first, so the strip reads
as one of them rather than as a plugin's idea of one; the reference is the panel
toggle three controls to its right:

| | bb's icon button | the strip |
| --- | --- | --- |
| height | 28px | 28px |
| border-radius | 6px (`rounded-md`) | 6px (was 8px) |
| resting background | transparent | `rgba(128,134,145,0.14)` |
| border | none | 1px `rgba(128,134,145,0.38)` |
| hover | `bg-state-hover` = foreground @ 13.8% | `rgba(128,134,145,0.30)` |
| pressed / open | `bg-state-active` = foreground @ 22.5% | `0.42` + a 1px inset shadow |
| focus | `outline-none` + `ring-1 ring-ring` | 2px outline, 1px offset |
| motion | `transition-colors duration-150 hover:duration-0` | identical |

Two departures, both deliberate. **It does not rest transparent**, because bb's
icon buttons are recognisable at rest by being 28×28 squares around one 16px
glyph — a huddle of avatars is not, and read as decoration; a hairline plus a
faint fill puts the affordance there *before* the pointer arrives. And **the
colours are a fixed mid grey, not bb's variables** — `--state-hover` and
`--state-active` are alpha ramps on `--foreground`, near-white on one theme and
near-black on the other, and a host's CSS variables are not a contract offered
to plugins. `rgb(128,134,145)` at those alphas lands within a few points of bb's
own at both ends: hover computes to `rgb(67,70,82)` over the dark theme's
`#282a36` against bb's `rgb(69,70,80)`, and to `#D5D6D5` over the light theme's
`#f8f8f2` against bb's `rgb(220,220,220)`. Verified in both themes on the
running app.

| Piece | Where |
| --- | --- |
| Registration | `app.contentScripts.register({ id: "av-dock" })` in `app.tsx` |
| Renderer | `canvas/dock/dock.ts` — imperative DOM, no React |
| Placement | `canvas/dock/anchor.ts` — the three-level chain: which slot, when to move, when to fall back (`tests/dock-anchor.test.ts`) |
| Fold state | `canvas/dock/expand.ts` — minimised by default, and what opens/closes it (`tests/dock-expand.test.ts`) |
| Squeeze | `canvas/dock/squeeze.ts` — the width tier, and how many faces it leaves room for (`tests/dock-squeeze.test.ts`) |
| Popover placement | `canvas/dock/popover-place.ts` — where the popover goes on **both** axes, in viewport coordinates: right-aligned to the strip and clamped inside the margins, hung below it and flipped above when below will not fit (`tests/dock-popover-place.test.ts`) |
| Face geometry | `canvas/dock/face-geometry.ts` — each tier's face size, overlap and glyph offset, and the invariant that the leading capital survives the overlap (`tests/dock-face-geometry.test.ts`) |
| Decisions | `canvas/dock/model.ts` — pure, unit-tested (`tests/dock.test.ts`) |
| Speaking ring | `canvas/dock/speaking.ts` — owns the bus subscription *and* the sweep, so the ring has one clock (`tests/dock-speaking.test.ts`) |
| Repaint wiring | `canvas/dock/repaint.ts` — which events reach a repaint (`tests/dock-repaint.test.ts`) |
| Styles | `canvas/dock/styles.ts`, injected as one `<style>` the disposer removes. It styles **two** trees since the popover left the strip, and holds both ids (`DOCK_ROOT_ID`, `DOCK_POPOVER_ID`) so the sheet and the elements cannot drift |
| Style scoping | `canvas/dock/style-scope.ts` — the invariants over that sheet: every rule scoped to a root this widget owns, and every root carrying a font of its own, since neither can inherit one from the other any more (`tests/dock-style-scope.test.ts`) |
| Data | `canvas/dock/rpc.ts` (roster + token) and `canvas/panel-bus.ts` (live state) |

**Minimised is the default, and minimised is the product.** Every page load
starts folded, and folded is the avatar strip itself: bubbles, initials, the
green speaking ring, "+N" overflow, and a mic glyph that turns green while you
are in the call (red while you are in it muted). No control buttons, no status
line, no chevron. At the narrowest tier (`bare`, below) there are no bubbles
either — the strip is the mic glyph and a bare count, and the count loses its
"+" because with no faces beside it there is nothing to add to. **Clicking the
strip** opens a popover hanging below it — a child of `<body>`, positioned in
**viewport** coordinates rather than in the bar's own, for the reasons under
*The popover stays on the screen* below — with the fuller thing: 44px faces, live
`<video>` tiles for anyone with a camera on, Join/Leave, mute, camera, the
**Transcript** button on thread routes, and the status line. It folds on a
second click, on Escape, on a click outside, whenever the strip is re-anchored
into a different header, and whenever a click inside it sends you somewhere
else — flying the canvas camera to a face, taking somebody's jump link, or
opening the transcript panel. That last one folds on an **accepted** open only:
a refusal answers on the status line, and the status line is rendered inside the
popover, so folding on it would delete the only explanation the user gets
(`decideTranscriptClick`). **Nothing is persisted** — the old
`canvas-av-dock:collapsed` and `canvas-av-dock:position` keys are gone, and are
actively deleted on mount.

The one exception to "folded by default" is a message you must not miss:
`setStatus` with non-empty text forces the popover open, so "LiveKit not
configured — …" is delivered rather than reported into a fold nobody can see.
That is a transition in `expand.ts`, not an `if` in the renderer.

**Why a content script.** `app.contentScripts.register` is the only surface bb
offers that survives a route change — the SDK mounts it "once per active
frontend generation in each bb app window" and disposes it exactly once on
reload or teardown. Every other registration is scoped to a route: `navPanel`
and its `headerContent` exist only on the canvas page, `threadPanelAction` only
inside a thread's side panel. A call you are *in* is not allowed to disappear
when you click something.

**Living in someone else's React tree.** The header row is rendered by bb and
torn down and rebuilt on every navigation, and bb's home route renders no
`<header>` at all. A `MutationObserver` on `document.body` (not on
`[data-testid="app-layout-root"]` — that is itself a React node that could be
remounted out from under the observer) re-asks the placement question, coalesced
to one answer per frame with `requestAnimationFrame`: the observer callback only
raises a flag, so a streamed token in the composer costs a boolean, not a
`querySelector`. Every actual answer comes from `canvas/dock/anchor.ts`.

Writing a foreign node into a React-rendered container is tolerated because
React reconciles only the children it created, matched positionally against its
own previous render, and never walks the container looking for strangers. Its
`insertBefore`/`removeChild` calls name its own nodes, so a re-render can shuffle
a foreign node's *position* but never remove it. The condition is that we notice
the drift and undo it, which is why `decideAnchor` treats "no longer where this
level says I should be" — not the trailing child at level 2, not the cluster's
first child at level 1 — as a reason to move, and why every move is an
insert of the one node we own (a relocation, never a copy). A header re-render
therefore cannot leave a duplicate strip behind.

On a route with no header row the strip falls back to `position: fixed` in the
same 48px band, top right, still flat — offset 52px from the right edge so it
clears the control bb floats in that corner on the home route — and climbs back
up the chain the instant a row (or an actions cluster inside it) appears.

**One widget, not two.** The canvas page's `navPanel` no longer registers a
`headerContent`. It used to draw its own avatar stack and audio control into
this same row, which with the strip in place would have been the same widget
rendered twice, on one route only. Its one exclusive behaviour came with it:
clicking a face flies the canvas camera to that person. `DockBubble.clientId` /
`canPan` (`canvas/dock/model.ts`) pick which of that person's tabs to fly to —
one with a cursor if they have one — and the popover's faces call
`canvasBus.panTo`, which is a harmless no-op on every page where no canvas panel
is listening. `SpeakerRings` is untouched. `CanvasOnlineCount` kept its markup
and its two data sources, but the **location plumbing changed what it has to
count** — see *The sidebar badge counts the room, not the building* below.

The price is that there is no React and therefore no hook. `useRpc()` resolves
the plugin id from a context the host provides inside its own slot trees, which
an imperative mount is by definition outside of. So `canvas/dock/rpc.ts` speaks
the same wire the hook does, from the hook's own documented contract in
`bb-plugin-sdk-app.d.ts`:

```
POST /api/v1/plugins/<pluginId>/rpc/<method>      body: the input, as JSON
```

Same origin, same cookie, same server-side validation — the only thing not
shared with the hook is React. The `<pluginId>` half comes from the content
script's own `context.pluginId`, and every request carries `context.signal`, so
a poll in flight when the generation is replaced cannot write into DOM the
disposer has already removed.

**One session, two controls.** The strip popover's join button and the canvas
page's own controls drive the same `canvas/av-room.ts` singleton. That used to be
guarded by `if (room !== null) return`, which is right once connected and wrong
while *connecting*: the token fetch and the WebRTC handshake are both awaits,
and a second click lands inside them with `room` still null. Two connections
into one room from one tab shows the user twice in the SFU, echoes their own mic
back, and leaves each button able to hang up only its own half. The phase now
lives in `canvas/av-session.ts` — a LiveKit-free, DOM-free machine that makes a
second join attach to the connect already in flight, refuses to let a connect
that lands *after* a leave claim the session, and is where the interesting cases
are tested (`tests/av-session.test.ts`).

**Two cadences, two rules** (`canvas/dock/repaint.ts`). The strip has no React
and therefore no `useSyncExternalStore` doing this for it, so what repaints it is an
explicit decision — and the two things that drive it want opposite answers. The
**bus** is event-driven and already deduplicated by `panel-bus.ts`, so every
notification it delivers is a real change to something the strip draws (a mute, a
camera, a join phase, the roster) and repaints unconditionally. The **sweep**
runs 4×/second for the whole session in every bb window and exists only to
notice a speaking hold running out, so it repaints only when the ring actually
changed. Collapsing those into one gate is a bug in whichever direction you do
it: guard the bus and your own mic button sits on the wrong glyph until the 5s
roster poll rescues it; ungate the sweep and a permanent overlay repaints four
times a second forever. `tests/dock-repaint.test.ts` pins both halves against
the real bus.

**What it deliberately is not:**

- **Not bubbles that follow cursors.** That was tried on the canvas and read as
  confusing. Video lives in the strip's popover and only there; the canvas keeps
  its named cursors with a speaking ring.
- **Not one bubble per browser tab.** The model keys on the display *name*,
  because a face is per person: someone with the canvas open twice is two roster
  entries and exactly one LiveKit participant.
- **Not on top of bb's modals.** `z-index: 45` puts the popover over ordinary
  content and under bb's dialogs, popovers and command palette (50+). A call
  control is not more important than the dialog you just opened. That number
  only started deciding anything when the popover became a child of `<body>`:
  inside `#canvas-av-dock` it was resolved against whatever stacking context an
  ancestor of bb's happened to open, so 45 settled nothing. The 50+ figure is
  inherited belief, not a measurement — the pane's own z-index was never read.
- **Not draggable, and not remembered.** The grip, the persisted position and
  the persisted fold state are all gone. A widget that lives in the bar has
  nowhere to be dragged to and nothing worth remembering; every page load starts
  minimised.
- **Not two attached `<video>` elements per person.** Only the popover's faces
  become tiles, so folding detaches every camera rather than leaving them
  decoding behind a `hidden`.

#### Narrow screens: presence is what gives up width

Six 24px faces overlapping by 6px is what a *desktop* title bar can spare — it
is where `MAX_DOCK_BUBBLES` came from. On a phone, or in a split pane, that same
run is wider than bb's header row has to give, and the row does not clip it: it
is a flex line, so the overflow comes out of the page **title**, which shrinks
until it is an ellipsis. Presence quietly eating the name of the page you are on
is the bug `canvas/dock/squeeze.ts` exists to prevent. The header is the scarce
resource here and the strip is the guest in it, so the strip is what gives —
the same reasoning that moved the Transcript button off that row and into the
popover, below.

**The honest signal is the container's width, and the obvious alternative is
worthless in a way that looks precise.** "Row width minus the widths of the
other children" measures ~0 at every viewport, because the row is a flex line
whose title child *shrinks*: the line always exactly fills itself, and flex has
already spent the free space you are asking about. The one number that is not a
consequence of our own size is how wide the container actually is —
`getBoundingClientRect().width` on bb's header row, or the window on the `fixed`
placement, where there is no row and the window *is* the constraint
(`containerWidth`, which is why `dock.ts` hands in both numbers and picks
neither).

**Four tiers, not a continuum.** `roomy` (≥ `SQUEEZE_ROOMY_MIN_PX`, 760px) is
the strip described above: `MAX_DOCK_BUBBLES` faces at 24px, −6px overlap.
`tight` (≥ `SQUEEZE_TIGHT_MIN_PX`, 576px) draws 4 faces at 22px with −9px of
overlap. `cramped` (≥ `SQUEEZE_BARE_MIN_PX`, 432px) draws 3 at 20px with −10px,
and trims the strip's own side padding from 5px to 3px — 4px back across the
strip without touching its border, its radius or its height. `bare`, below that,
draws **no faces at all**. Faces a tier cannot draw are not lost; they
fold into the "+N" the strip already had, and **your** face is the one that is
never dropped, since the mic and camera state is read off it. Four named
layouts are four things a reviewer can look at; a per-pixel face count is a
continuum nobody can check. The strip stays **28px tall with 10px type at every
tier**: the height is bb's own header button, which it has to keep lining up
with however narrow the row gets, and the type is the thing all of this is being
done *for*.

**The bottom tier gives the faces up entirely, because squeezing them was not
enough.** The user, against a screenshot of a thread header carrying no title at
all: *"On narrow screens the presence icons hide the thread title (Perhaps if
this is about to happen we should drop the presence icons and just keep the mic
icon? Or maybe move them to a second header row? Thread title is important)"*.
The first option is the one taken — a second header row would move bb's own
layout, which is not ours to move. At `bare` the strip is the **mic glyph and a
count**: `maxBubblesFor("bare")` is `0`, `buildDockModel` takes that literally
(its `limit === 0` branch returns no bubbles), and the stylesheet takes the
now-empty `.dock-bubbles` out of the box tree with `display: none` so the flex
`gap: 4px` it was holding open goes with it. Two things change about the count
at this tier and both are deliberate: it counts **everybody, you included** —
"you are never the face that gets dropped" is a rule about attributing the mic
state to a face, and there is no face here to attribute it to — and it loses its
`+` (`overflowLabel`), because a "+3" with nothing beside it is a plus sign with
nothing to add to. What survives is the whole of the button: the border, the
radius, the 28px height, the hover/pressed/focus treatments and the mic glyph in
its in-call colour. It is still the control that opens the popover, and the
popover still draws every face full size from a model the tier never reaches.

**Where 432 comes from, and which half of it is a guess.** The arithmetic half
is off our own declarations: at `cramped` the strip costs the row ~70px (a 40px
three-face run, the 14px mic glyph, the 4px gap between them, 3px of padding and
1px of border each side, plus the 4px margin the element carries) against ~95px
at `tight`, so dropping the fourth face hands back 25px and the floor beneath
`tight` lands in the mid-400s rather than in the 300s. The judgement half is
that a thread title needs somewhere around 120–160px to be a title rather than
an ellipsis — **there is no measurement behind that**; there is no browser in
this spike and bb's header type size is not ours to read. It is the number in
`canvas/dock/squeeze.ts` most worth challenging first if the report recurs. The
digits were then fixed by the band: adjacent floors have to be more than two
hysteresis bands apart or the tier between them owns no width outright, which is
why the `tight` floor moved up (it was 480 while `cramped` was the bottom of the
ladder) rather than 432 being squeezed in under the old one — squashing `cramped` would have retired a tier by
accident. The cost, accepted rather than overlooked: the ladder has one set of
floors for all three placements, so the `fixed` placement (which measures the
window and has no title to protect) drops its faces at phone width too.

**Holding the type at 10px is a claim about the overlap, and it did not hold.**
Keeping the glyph the same size buys nothing if the next face is drawn on top of
it — and the faces are painted in DOM order with no `z-index`, so each one
covers the *right* of the one before it. `cramped` originally overlapped by
−12px, leaving an 8px sliver of every face but the last, and two centred
capitals at 10px sit across the middle of a 20px circle: what actually reached
the reader was about 5px of a ~7px leading capital and none of the second. Since
there is no photograph behind a face, that sliver *is* the identity. So the
cramped tier now relaxes to −10px and pushes its glyph into the exposed part
(`justify-content: flex-start` plus a 1.5px margin on `.dock-initials`, on
covered faces only — the trailing face is whole and stays centred). Making the
overlap loose enough to show a *centred* pair of capitals would have taken less
overlap than `roomy` has, i.e. the narrowest tier would have been the widest,
which is why the glyph moves instead of the geometry alone. The cost is 4px of
run (36px → 40px, against `tight`'s 61px), and the trailing capital of a covered
face is still partly hidden — accepted, because at a 10px window and a ~7px
capital there is no exposure that shows both letters and none that hides the
second cleanly.

**The tier reaches the model as a `limit`, and the clamp is one-directional.**
`buildDockModel` takes "how many faces there is room for" as an input, and a
caller may ask for fewer than `MAX_DOCK_BUBBLES`, never more: that constant is
about **legibility** — how many overlapping circles still read as faces in a
title-bar row — and no amount of measured width changes it, so a wide header is
not permission to draw ten. A limit that is not a finite number degrades to
`MAX_DOCK_BUBBLES`, i.e. to the behaviour the strip had before it measured
anything, and can never empty the strip.

**The CSS only mirrors a data attribute.** `dock.ts` writes
`data-dock-squeeze="roomy|tight|cramped|bare"` on the root and repaints; the
stylesheet switches on that attribute and carries **no thresholds at all**. The
per-tier *pixels* are not typed into it either — face size, overlap and glyph
offset have to agree with one another (previous paragraph), and three literals
per tier in a template string is the one arrangement in which nothing can check
that, so they are interpolated from `canvas/dock/face-geometry.ts` with
`tests/dock-face-geometry.test.ts` on the relationship between them. `bare` is
the one tier with no entry in that table, and deliberately: it draws no faces, so
it has no diameter and no overlap, and `FaceTier` is the narrower union that says
so in the types rather than carrying an invented row of zeroes. A
media query restating 760/576/432 would be a second set of numbers to drift from the
first, and it would be measuring the wrong thing anyway — inside a split pane
the header row's width is nothing like the viewport width a media query answers
about. There is deliberately no `[data-dock-squeeze="roomy"]` rule either: the
unsqueezed strip *is* the strip, and a tier that restates it is a second copy to
keep in step.

**Hysteresis, because a boundary is exactly where a divider gets parked.** The
width arrives from a live measurement — a `ResizeObserver` on the row, since
dragging bb's pane divider changes its width with no window `resize` event and
need not mutate the DOM either — so every intermediate pixel of a drag arrives,
and a scrollbar appearing or disappearing moves it ~15px on its own. A bare
threshold turns a container resting *on* 760 into a strobe: 759 tight, 760
roomy, 759 tight, at frame rate, which reads as a rendering fault rather than as
a responsive layout. So `nextSqueeze` requires the width to clear the boundary
it is leaving by more than `SQUEEZE_HYSTERESIS_PX` (48px — enough to swallow
both a scrollbar and a held divider; larger and the strip would feel like it
lags the drag) before the layout follows it. The band applies from **both**
sides: shifting the floors one way only leaves the opposite crossing bare, and
one bare crossing is all a flap needs.

**An unmeasurable container is not a narrow one.** A 0 (a `display: none`
ancestor mid route change, a node detached for a frame) or a NaN is a
measurement failure, and mid-life it **keeps** the tier already on screen —
collapsing a working desktop strip because one read came back blank is a visible
bug; holding the last good layout is invisible. Only `chooseSqueeze`, the first
decision of a strip's life, which has no layout to hold, answers `cramped` on
one: a strip that is too small is sparse but still legible, while one that is
too wide pushes bb's own header content out of the row. **A failed read can
therefore never empty the strip:** `bare` is only ever reached by a width that
was actually measured, which is what let `buildDockModel` drop the old
`Math.max(1, …)` floor and take a limit of 0 at its word. Every judgement in this
section — the tiers, the thresholds, the band, and what an unmeasurable
container means — is `tests/dock-squeeze.test.ts`'s; `canvas/dock/dock.ts`
measures, writes the attribute, and decides nothing.

#### The 📜 button — how it was ruled out, and how it got built anyway

`mockups/transcript-sidebar.html` shows a fourth door to the room transcript on
this widget. It is now **implemented** (the **Transcript** button in the strip's
popover, beside Join audio / Mute / Camera on, on thread routes only — it began
life as a bare 📜 glyph next to the strip in bb's header row and moved because
that row is the scarce surface on a narrow screen; the popover is not). Both
halves of that sentence are worth keeping, because the reasoning that said it
was impossible was mostly right and the way past it is narrow.

**What the original note said (SDK 0.4.21), and what still holds.** A content
script has no React fiber and no context, so it cannot call a hook; and:

- `PluginContentScriptContext` carries `pluginId`, `generation`, `signal` and
  `experimental_setThreadRowStatus` — **confirmed against the running bundle**,
  not just the `.d.ts`: bb constructs it as
  `t.mount({ pluginId: e, generation: n, signal: r.signal, experimental_setThreadRowStatus: … })`.
  No navigation, no panel control.
- Every sanctioned open is either a **hook** (`useBbNavigate().openThreadPanel`)
  or an **argument the host hands to a registration callback** (`openPanel` on
  `threadPanelAction` / `messageAction` / `commandPaletteAction` `run`).
- `globalThis.__bbPluginRuntime` exposes React, the Radix primitives, sonner and
  `pluginSdkApp` (those same hooks). There is still no imperative navigate on it.

**2026-09-01 — what changed, and what did not** (bb 0.40.0, SDK 0.4.21). The
product owner has since sanctioned guarded client-side navigation with a hard
fallback, and it ships in `canvas/dock/navigate.ts` for the jump-to-a-teammate
link. That retires the "pushing history at bb's router is out of bounds" half of
the old argument — and it **does not help here**, for a reason worth recording:

1. **Thread panels are not URL-addressable.** Measured on the running app, both
   sanctioned ways of opening the transcript (the right panel's launcher row and
   ⌘⇧P → "Canvas: open room transcript") leave everything about the URL alone:

   ```
   launcher  before {"url":"…/threads/thr_cjnyuqz388","state":{"idx":0},"len":3}
             after  {"url":"…/threads/thr_cjnyuqz388","state":{"idx":0},"len":3,"hash":"","search":""}
   palette   after  tabs "Info|Diff" → "Info|Diff|Room transcript",
                    {"url":"…/threads/thr_cjnyuqz388","state":{"idx":0},"len":6}
   ```

   No path change, no query, no hash, `history.state` unchanged, `history.length`
   does not increment. The open tab's identity lives in **localStorage**, under
   `bb.thread.fixedPanelTabsState-<threadId>-1`. Reloading the same URL re-opens
   the panel *from that record*, so the same link opens or does not open the
   panel depending on per-browser state — it is not a deep link, and there is
   nothing for `navigate.ts` to push. `useBbNavigate().toPluginPanel` *is* a real
   router navigate (`/plugins/canvas/canvas/<subPath>` renders `CanvasPanel`,
   verified), but it addresses **nav** panels, which the transcript is not.

2. **The obvious relay is ruled out by evidence, not by argument.**
   `openThreadPanel` resolves its opener from a React context
   (`let r = useContext(mB); … e => r?.({...e, pluginId:t}) ?? false`) that bb
   provides inside its thread route. Walking `__reactFiber$` `.return` chains on
   the live app for an ancestor whose `memoizedProps.openThreadPanel` is a
   function:

   | surface | provider in its ancestor chain? |
   | --- | --- |
   | `#canvas-av-dock` (the strip node) | no `__reactFiber$` key at all — outside React |
   | its parent, the header actions cluster | **yes**, at depth 29 |
   | `[data-testid="app-page-header-content-row"]` | **yes**, at depth 28 |
   | `CanvasOnlineCount` (`experimental_sidebarAccessory`) | **no** — absent from all 92 fibers |

   So the plugin's one always-mounted React surface is on exactly the wrong side
   of the tree: `openThreadPanel` there would return `false`.

3. **The door that works is `experimental_threadHeaderAction`.** It renders into
   the thread header's action row — the same cluster the strip is prepended into,
   proven above to be inside the provider. `canvas/dock/transcript-door-slot.tsx`
   registers a component that renders `null` and publishes that hook into the
   module singleton in `canvas/dock/transcript-door.ts`; the popover's Transcript
   button
   calls it. This is the identical seam `canvas/panel-bus.ts` already uses for
   `panTo` — two mount points with no common plugin ancestor, one bundle in one
   window, so a module singleton reaches both. Executed and observed, not just
   inferred: clicking the button logs
   `[canvas] openThreadPanel(transcript) returned true` and the "Room transcript"
   tab appears with live lines, URL unchanged.

   Two limits, both properties of the object rather than of the workaround.
   **Thread routes only** — the slot is not rendered on the compose screen or
   any non-thread route, and there is no door of any kind on
   `/plugins/canvas/canvas`, `/settings` or `/` (bb's own palette row hides
   itself there by the same `threadId !== null` test). The button is therefore
   hidden everywhere else rather than drawn dead. **Last writer wins** in a
   split layout, which mounts one header per pane; bb's own quick palette
   resolves its opener from a module-level Map the same way
   (`for (let t of _B.values()) e = t`), so the failure mode is the host's.

4. **Palette synthesis works and is refused.** Dispatching a synthetic
   `keydown` for ⌘⇧P, setting the palette input through React's native-setter
   workaround and pressing Enter *does* open the panel — it was tried, and a
   plain synthetic `click` on the row notably does **not** work, so even the
   activation path had to be found by trial. It is refused because it couples
   this spike to five undocumented things at once: the palette keybinding, the
   input's placeholder string, the row's title string, cmdk's keyboard-only
   activation semantics, and React's controlled-input native-setter trick. The
   keybinding alone is enough: on this very machine the `bb-ui-reference` plugin
   was already swallowing ⌘⇧P, so another installed plugin can silently take the
   binding the hack depends on. It also flashes the palette open and shut in
   front of the user.

#### Manual smoke checklist

The pure half is unit-tested; the DOM and LiveKit glue is not, and needs a real
bb plus a real LiveKit server (ew-lsp-001). Work through this after any change
to `canvas/dock/` or `canvas/av-room.ts`. Every step names the selector to look
for, so it also works from a devtools console.

**Placement & lifetime**

1. `bb plugin reload canvas`, then open a **thread** and look at the right-hand
   end of bb's title bar: `#canvas-av-dock` is the **first child of the row's
   actions cluster** —
   `document.querySelector("[data-thread-header-workflow-actions]").parentElement.firstElementChild`
   **is** that node, and its `data-dock-anchor` is `"before"`. It is flat — no
   shadow, no slab, no border — and reads as part of the bar, not as something
   laid on top of it. Now open the **Canvas page**, which has no thread markers
   at all: same level, same slot, found through the panel-toggle portal instead —
   `document.querySelector("[data-plugin-right-panel-toggle-portal]").closest("[data-testid=\"app-page-header-content-row\"] > *").firstElementChild`
   is the strip, so it sits **left** of the open-sidebar button. On **Settings**,
   whose header has no actions at all, it demotes to `data-dock-anchor="row"` and
   `document.querySelector("[data-testid=\"app-page-header-content-row\"]").lastElementChild`
   is that node instead.
2. Navigate thread → Settings → New thread → the Canvas page, **by clicking**
   (client-side routing, which is what re-renders the header). After each hop
   there is still exactly **one** `#canvas-av-dock`, it is at the highest level
   that route supports (`"before"` on threads and the canvas page, `"row"` on
   settings), and it is still vertically in the 48px band. Nothing ever covers
   the composer.
3. Go to bb's **home route** (`/`), which renders no `<header>` at all: the
   strip switches to `[data-dock-anchor="fixed"]`, stays in the same 48px band
   at the top right, and does **not** sit on top of the control bb floats in
   that corner. Navigate back into any route with a header: it returns to the
   row.
4. Open the canvas in a second tab under a different name. Within ~5s both
   strips show two bubbles, correct initials, correct colours — and the colours
   match the cursor labels on the canvas.
5. Close the second tab. Within ~5s the bubble goes.
6. `bb plugin reload canvas` again: exactly one `#canvas-av-dock` in the DOM and
   exactly one `#canvas-av-dock-styles` in `<head>` (the disposer ran, and its
   `MutationObserver` with it).
7. Open a bb dialog (⌘⇧P, or Settings → any modal): the dialog is fully usable
   and paints **over** the strip's popover.

**Fold & unfold**

8. On load, the strip is **minimised** on every route — faces, "+N" and the mic
   glyph, no buttons, no status line, and `[data-dock-expanded="false"]`. On a
   container narrower than the bare floor it is minimised *and* faceless: at
   `[data-dock-squeeze="bare"]` the strip is the mic glyph and a count, which is
   step 61. There
   is no stored preference that can change this: `localStorage` holds no
   `canvas-av-dock:*` key at all.
9. Click the strip. The popover opens **below** it, right-aligned to it, its top
   6px under the strip's bottom — 44px faces, Join/Leave, mute, camera. It is
   *not* in the bar's coordinate space: it is `#canvas-av-dock-popover`, a child
   of `<body>`, placed in viewport coordinates (steps 49–54 are the whole of
   that). Check it is not clipped: `document.elementFromPoint(...)` at its top
   edge returns the popover itself.
10. Fold it four ways and check each: a second click on the strip, **Escape**, a
    click anywhere outside it, and navigating to another route.
11. Reload the window: minimised again.

**Audio**

12. With LiveKit unconfigured, click **Join audio** in the popover, then fold the
    popover while the join is in flight. When it fails the popover **re-opens
    itself** and the status line reads "LiveKit not configured — Set livekitUrl,
    …". (This is `expand.ts`'s forced-open transition; a message reported into a
    fold is a message that was not delivered.)
13. Configure LiveKit, click **Join audio**. The button becomes **Leave**, and
    the strip's mic glyph turns green on every route.
14. **The race:** click Join twice within the same second (or from two bb
    windows). In the LiveKit room you appear **once**. (This is what
    `tests/av-session.test.ts` pins offline; this step is the live proof.)
15. Talk **continuously, on your own, for several seconds**. Your own bubble
    gets a green ring; it stays lit through the pauses between words *and*
    through a long unbroken sentence, and goes out ~1s after you stop. (The
    "unbroken sentence" half is where this once failed: the bus deduplicates a
    repeated speaker list, so the ring has to be kept alive by the strip's own
    sweep. `tests/dock-speaking.test.ts` pins that offline against the real bus;
    this step is the live proof.)
16. Click **Mute**: the strip's mic glyph turns red **immediately** — within the
    same frame, not after a pause — and the other tab stops hearing you. (Any
    lag here is the strip missing a repaint. That was once a five-second lag;
    `tests/dock-repaint.test.ts` pins it, this step is the live proof.)
17. Click **Leave**: the button says **Join audio** as soon as the session is
    down (not seconds later) and every ring clears. Likewise on the way in —
    **Joining…** appears disabled for the length of the handshake.

**Camera**

18. Join, open the popover, click **Camera on**. Grant the permission: your own
    face in the popover becomes a live self-view as soon as the track publishes
    (mirrored is fine, it must be **muted** — no feedback howl), and
    `[data-canvas-dock-video="true"]` is set on it.
19. The other tab sees your face in *its* popover within a second or two — that
    is LiveKit's subscribe latency, and nothing on top of it: the tile paints on
    the bus update, not on the next roster poll.
20. Click **Camera off**: both fall back to initials, and the `<video>` element
    is gone from the DOM (not merely hidden).
21. **Fold the popover** with a camera live: `#canvas-av-dock-popover video` is
    gone from the DOM entirely. Unfold: the tile comes back. (Only the popover's
    faces are tiles, so there is never more than one attached `<video>` per
    person.) The root in that selector is the POPOVER's, not the strip's: the
    popover is a child of `<body>` now, so `#canvas-av-dock video` matches
    nothing whatever the camera is doing and would be a check that can no longer
    fail.
22. **Refuse** the camera permission instead: the button returns to **Camera on**
    rather than latching "off" with a dead camera behind it.
23. With two cameras on, have someone else start talking — nobody's tile
    flickers or goes black (the renderer must not have re-inserted the
    `<video>`).
24. Close the far tab without leaving first: its tile disappears rather than
    freezing on a last frame.

**Fly to a cursor**

25. On the canvas page with somebody else present and moving a pointer, open the
    popover and click their face: the canvas camera flies to their cursor and
    the popover folds. Somebody with no cursor on the canvas has a **disabled**
    face rather than a jump to an invented destination.
26. Do the same on a thread route: the click is a harmless no-op (no canvas
    panel is listening), and nothing throws.

**Where everyone is — two tabs, two people**

This half of the strip is about seeing *somebody else*, so it needs two browser
sessions under **different names**. Locally there is no Cloudflare Access edge,
so both tabs would otherwise resolve to the same `local:<user>` and collapse
into one face (correctly — they are one person). Give each session its own
`Cf-Access-Authenticated-User-Email` header and reload, e.g. with
`agent-browser --session alice set headers '{"Cf-Access-Authenticated-User-Email":"alice@example.com"}'`.
Call them **A** and **B** below.

27. **Everybody is in the room now, not just the canvas.** With B parked on a
    thread and having never opened the canvas page, `canvas_roster` lists B.
    (Before this feature it did not: an off-canvas tab never called
    `canvas_join`, so the room could not see it. That is the whole reason
    `canvas/locations.ts` exists.)
28. **A sees where B is.** In A, open the popover: B's face carries a line
    reading *in "&lt;B's thread title&gt;"*, and A's own face reads **in this
    thread** when they are in the same one. A's own line is never a link.
29. **The row faces.** In A's sidebar, the row for B's thread carries **B's
    circle from the header strip**, in front of the thread title:

    ```js
    const row = document.querySelector('[data-sidebar-thread-id="<B thread>"]').parentElement;
    const deco = row.querySelector("[data-canvas-row-presence]");
    deco.getAttribute("aria-label");                    // "<B> viewing"
    deco.parentElement.firstChild === deco;             // true — leading child
    [...deco.querySelectorAll(".canvas-row-face")]
      .map(f => [f.textContent, getComputedStyle(f).backgroundColor]);
    ```

    **Compare it with the strip** — the same person's
    `#canvas-av-dock .dock-bubbles .dock-bubble` must report the *same*
    initials and the *same* computed `background-color`. Read them, do not
    eyeball them. Do this at a width above the tier floors: at
    `[data-dock-squeeze="bare"]` that selector matches nothing by design, and
    the popover's `.dock-faces .dock-bubble` is what to compare against instead.
    If nothing appears, check
    `#canvas-av-dock[data-dock-row-decor]` first: `no-rows` means there is no
    `a[data-sidebar-thread-id]` to decorate (a plugin has replaced the thread
    list, or the route has no sidebar), `failed` means the pass threw.
30. **Hover does not take it away — this is the whole point.** Hover B's row.
    The circles are **still there, at the same `x`**, and the archive button
    appears *beside* them:

    ```js
    row.matches(":hover");                                                    // true
    getComputedStyle(row.querySelector(".bb-sidebar-hover-actions-fade")).opacity;  // "0"  <- the old eye lived here
    getComputedStyle(row.querySelector(".bb-sidebar-hover-actions")).opacity;       // "1"
    row.querySelector("[data-canvas-row-presence]").getBoundingClientRect().x;      // unchanged
    ```

    The `fade` layer going to zero is exactly what erased the retired
    `experimental_setThreadRowStatus` glyph.
31. **It clears.** Navigate B to `/settings` **by clicking inside bb**. Within
    ~2s B's circle is gone from A's row and `#canvas-av-dock[data-dock-rows]`
    has dropped by one. **Do this client-side, not by typing a URL or
    reloading**: a hard navigation gives B's tab a *new* clientId, and the old
    one lingers in `LocationBook` still claiming the thread until
    `LOCATION_STALE_MS` retires its location — measured at ~15s, during which
    A's row still shows B. That is the staleness horizon behaving exactly as
    designed (step 38 is the same effect on purpose), not a bug, but a reader
    who tests this with the address bar and expects 2s will think it is broken.
32. **It does not churn, and it is not a feedback loop.** With nothing moving,
    sample `#canvas-av-dock[data-dock-row-writes]` every 250ms for 10s: it must
    be **constant**. That counter is how many DOM writes the decorations have
    made this generation, and the pass writes into the very subtree the
    observer that schedules it is watching. Then move B between two threads:
    the counter should climb by exactly **2** (one `add`, one `update`), never
    by one per tick.
33. **It survives the sidebar.** Scroll the thread list to the bottom and back:
    the list is virtualised (a scrolled-out row unmounts entirely, taking its
    decoration with it) and every re-rendered row must come back decorated,
    still as the **first child** of its title span. Then shuffle a decoration
    out of place by hand —
    `d = document.querySelector("[data-canvas-row-presence]"); d.parentElement.appendChild(d)`
    — and within one pass it is back in front of the title, with
    `document.querySelectorAll("[data-canvas-row-presence]").length` unchanged.
    **Never two decorations on one row.**
34. **Graceful degradation.** Strip the attribute the way a plugin owning the
    thread list does —
    `document.querySelectorAll("a[data-sidebar-thread-id]").forEach(a => delete a.dataset.sidebarThreadId)`
    — and within ~2s `data-dock-row-decor` reads `no-rows`,
    `data-dock-row-writes` stops moving and the page console stays clean.
    Restore the attributes and it reads `ok` again **without any new writes**:
    the signatures still match.
35. **Jump, client-side.** In A, set a sentinel (`window.__probe = 1`), open the
    popover and left-click B's link. A lands on B's page, `document.title`
    becomes B's, the popover **folds**, and the sentinel **survives** — the app
    routed, it did not reload.
36. **Jump, fallback.** Still in A, disable client-side routing
    (`history.pushState = function(){}`), set a fresh sentinel, and click the
    link again. A still lands in exactly the right place, but the sentinel is
    **gone**: the attempt was verified, found not to have taken, and the strip
    fell back to a real navigation.
37. **The browser's gestures are still the browser's.** Middle-click B's link:
    it opens in a new tab. ⌘/ctrl-click: same. Right-click → *copy link
    address*: you get the path. None of these are intercepted, because the
    affordance is a real `<a href>`.
38. **Staleness.** Kill B's tab without navigating (or background it and wait).
    After ~15s B's line in A's popover reads **somewhere in bb** and the link is
    gone; after ~2min B leaves the roster entirely.
39. **No self-jump — but yes, your own circle.** Open a second tab as the
    **same** person: it is still one face in the strip, and the popover still
    refuses to offer to fly you to yourself. The row you are reading, however,
    **does** carry your circle: `aria-label` reads *you viewing*, the face is
    `[data-canvas-row-self="true"]` and it is drawn with your real name's
    initials and hue, and your two tabs on it are one `you`, not two. On a
    thread you share with B it reads *you, B viewing* — `you` **first**, never
    *B, you*, and your circle is the leftmost one.
40. **B with two windows does not blink.** Give B a *second* live, visible
    window — say one on their thread and one on the canvas — and leave both in
    the foreground for a minute. In A: B's circle on their thread row stays
    **on** for the whole minute (`#canvas-av-dock[data-dock-rows]` never dips),
    and B's popover line and its `href` do not flip between *in "&lt;thread&gt;"*
    and *on the canvas*. This is the regression that shipped once and was caught
    live: two windows polling on drifting 2s timers made "most recent wins" a
    coin flip. Sampling `data-dock-rows` every 250ms for 45s is the cheap way to
    watch it — any `0` in that string is the defect back.
41. **Focus decides between them.** With both of B's windows open, click into
    B's canvas window: within ~2s A's popover line for B reads **on the canvas**.
    Click into B's thread window: it goes back to the thread. The row faces are
    unaffected either way — rows are a union, not a vote.
42. **The strip is unchanged.** Re-run steps 1–11 on all four route kinds — the
    anchor chain (`before` / `before` / `row` / `fixed`) and minimised-on-load
    must be exactly as before.

**The transcript door**

43. **The button lives in the popover, not on the strip.** On a **thread**
    route, fold the popover and look at the strip: faces, `+N` and the mic
    glyph, and nothing else (at `bare`, just the mic glyph and the count —
    fewer things on the strip, never more). Unfold it — the fourth labelled control beside
    Join audio / Mute / Camera is **Transcript**
    (`#canvas-av-dock-popover .dock-transcript` — the POPOVER's root, since the
    popover left the strip's tree; it still answers to
    `[data-canvas-dock-scribe]`; deploy checks grep for that attribute, so it
    survived the move deliberately). Click it: the room transcript opens in the
    thread's right panel and the popover **folds**.
44. **It hides where it has no door.** Go to **Settings**, whose header
    publishes no thread panel, and unfold the popover:
    `document.querySelector("[data-canvas-dock-scribe]").hidden` is `true` —
    the button is absent rather than present and dead. Return to a thread and it
    is back. Only an *accepted* open folds the popover: if the host ever
    declines, the refusal is a sentence on the popover's own status line and the
    popover stays open, because folding would hide the only explanation there
    is. (`tests/dock-transcript-door.test.ts` pins that half offline — there is
    no way to force a decline from the console.)

**The squeeze — giving the page title its width back**

The strip narrows as its *container* does, in four named tiers. Everything here
is `canvas/dock/squeeze.ts`'s: `SQUEEZE_ROOMY_MIN_PX` is **760**,
`SQUEEZE_TIGHT_MIN_PX` is **576**, `SQUEEZE_BARE_MIN_PX` is **432**, and
`SQUEEZE_HYSTERESIS_PX` is **48**. The tier is written to `data-dock-squeeze` on
`#canvas-av-dock` and is one of `roomy` / `tight` / `cramped` / `bare`.

45. **Walk the tiers.** Open a thread and shrink the window (or drag bb's pane
    divider) a little at a time, watching:

    ```js
    const d = document.getElementById("canvas-av-dock");
    const row = document.querySelector('[data-testid="app-page-header-content-row"]');
    setInterval(() => console.log(Math.round(row.getBoundingClientRect().width),
                                  d.dataset.dockSqueeze,
                                  d.querySelectorAll(".dock-strip .dock-bubble").length,
                                  d.querySelector(".dock-overflow").textContent), 250);
    ```

    Coming **down** from a wide window it reads `roomy` (up to **6** faces, 24px,
    overlapping 6px) until the row drops under **712** — 760 minus the band —
    then `tight` (**4** faces, 22px, overlap 9px) until under **528**, then
    `cramped` (**3** faces, 20px, overlap 10px) until under **384**, then `bare`
    (**0** faces — the logged bubble count is literally `0`, and the fourth
    column is the count with no `+` on it). Going back **up** the switches are at
    **480**, **624** and **808**, not at 432, 576 and 760; a `bare` strip that
    crosses 576 in one jump lands on `cramped`, not `tight`, because it has
    passed that floor without clearing it by a band.
46. **It measures the ROW, not the window.** That is why there is no media query
    anywhere in `canvas/dock/styles.ts`. Leave the window wide and make the
    *header row* narrow instead — open bb's right panel, or widen the sidebar —
    and the tier must follow the row: the logged `row` width above is the number
    `data-dock-squeeze` tracks, and `window.innerWidth` is not. On the **home**
    route, where there is no header at all and the strip is
    `[data-dock-anchor="fixed"]`, the window *is* the container and the tier
    follows it.
47. **The page title stops being an ellipsis.** This is the whole point of the
    feature. With the row narrow enough to be at `cramped`, bb's own page title
    is readable. Force the wide layout by hand —
    `document.getElementById("canvas-av-dock").dataset.dockSqueeze = "roomy"` —
    and the title loses characters to the strip; that is the bug the tiers
    prevent. **Note it will not repair itself:** the pass only rewrites the
    attribute when the tier it computes *changes*, and it compares against its
    own variable rather than against the DOM, so a hand-poked value survives
    until you resize past a boundary or reload.
48. **Park a divider on a boundary and confirm it does not flap.** Drag bb's
    pane divider until the row measures ~760, then jiggle it a few pixels either
    side and hold it there for ten seconds while sampling
    `d.dataset.dockSqueeze` every 250ms: the log must be **one repeated value**.
    Repeat at ~576 and at ~432. A tier alternating at frame rate is the strobe the 48px dead
    band exists to prevent, and the same band is what swallows a scrollbar
    appearing and disappearing (~15px) without relaying the strip out.

**The popover stays on the screen, and is no longer in a box that can clip it**

The popover is a child of **`<body>`** with a root of its own,
`#canvas-av-dock-popover`, and it is `position: fixed`. It is not inside
`#canvas-av-dock` and is not positioned against it.

**Why it moved.** It was reported as "showing behind the left side menu", and
the screenshot cut it off dead on the vertical line where bb's left navigation
pane ends, with the faces to the left of that line *gone* rather than dimmed.
Deleted pixels are an ancestor's `overflow: hidden`; a z-index loser is painted
*under* an opaque box, which looks the same only where that box covers it.
`position: fixed` on its own would not have been enough either — a fixed box is
re-based and re-clipped by any ancestor carrying `transform`, `filter`,
`backdrop-filter`, `will-change` or `contain` — so the node left the ancestor
chain instead. **None of that was observed**: there is no browser in the spike,
the clipping ancestor was never identified, and checks 49, 59 and 60 below are
what actually decide whether the diagnosis was right.

`canvas/dock/popover-place.ts` decides where it goes on both axes —
`POPOVER_EDGE_MARGIN_PX` is **8**, `POPOVER_ANCHOR_GAP_PX` is **6** — and the
answer is written as `--dock-popover-x` / `--dock-popover-y` on the popover
itself, for a `translate()` to consume. A transform rather than `left`/`top`
because the box is `width: max-content` against the viewport: writing a `left`
would change the room a shrink-to-fit width is solved in, and the placement
would chase its own measurement.

**The policy, in one paragraph, because a fixed box has no resting position to
fall back on.** Horizontally the box is right-aligned to the strip and then
clamped inside the margins by the *smallest* movement that works — pulled left
if its right edge overhangs, pushed right if its left edge does — so a popover
that already fitted does not move at all, and a popover too wide to satisfy both
margins keeps its **left** edge, since both of its rows start there.
Vertically it is hung `gap` below the strip, **flipped above** when below will
not fit *and* above is genuinely the roomier side, then clamped; when neither
side fits the **bottom** margin is the one that holds, because the four labelled
buttons are at the bottom of the box and the faces are at the top. A read that
was not a measurement lands the box in the safe corner (`margin, margin`) rather
than "unmoved" — for an absolutely positioned popover "unmoved" meant the CSS
resting position, and this box has none. All of that is
`tests/dock-popover-place.test.ts`'s; `dock.ts` measures (the root's rect, the
popover's `offsetWidth`/`offsetHeight`, and `documentElement.clientWidth`/
`clientHeight` — **not** `innerWidth`/`innerHeight`, which include the scrollbar
gutter the 8px margin could not absorb) and writes.

49. **The clip is gone — the reported bug.** On a **thread** route with bb's
    left pane visible, open the popover and confirm no vertical cut anywhere in
    it, then prove the node really is where it should be:

    ```js
    const p = document.getElementById("canvas-av-dock-popover");
    [p.parentElement === document.body, getComputedStyle(p).position];  // [true, "fixed"]
    ```

    If the box is a body child, is `fixed`, and is *still* cut off, the clipping
    diagnosis was wrong and the z-index (45, and what bb's own layers actually
    are) is the next thing to read. That is the falsification, and it is the
    reason this check is first.
50. **The crowded thread header at phone width.** Narrow the viewport to ~390px
    and stay on a **thread**, the route where the strip is the action cluster's
    FIRST child and its right edge therefore sits well in from the window's.
    Open the popover and check **all four** edges, not just the one you expect:

    ```js
    const p = document.getElementById("canvas-av-dock-popover").getBoundingClientRect();
    const d = document.documentElement;
    [p.left, d.clientWidth - p.right, p.top, d.clientHeight - p.bottom];  // all >= 8
    ```

    None may be below 8 and no part of the box may be off-screen. Here the box
    has been pushed **right**: right-aligning it to the strip would have started
    it off the left of the screen.
51. **It does not move when it was never in trouble.** Same popover on a wide
    desktop thread: its right edge lines up with the strip's, and its top is the
    strip's bottom + 6. Then the **home** route, where the strip is pinned into
    the corner: the box is still right-aligned to it and still does not drift —
    that placement sits `right: 52px`, so its right edge is 52px in from the
    viewport and the leftward clamp (which only fires inside the 8px margin)
    should never engage. Expect `p.right === s.right` there, and treat a
    **left** pull as something to explain rather than as the expected reading.
    Never re-centred, either way. A popover that drifts when it fits is as much a defect as
    one that is clipped — it breaks the tie back to the control that opened it.
52. **It flips rather than being squashed.** Shorten the window until there is
    not room below the strip for the whole popover. It must appear **above** the
    strip, whole, still 6px from it — and only while above is genuinely the
    roomier side; near the top of a short window it stays below and clamps. When
    neither side fits, the **bottom** margin is the one that holds and the top
    runs off: the four labelled buttons are at the bottom of the box and the
    faces are at the top.
53. **It follows a live resize.** With the popover open on a thread, drag the
    window narrower a few pixels at a time: every margin holds at every size and
    the box slides rather than jumping. On a **pane drag** the same is true —
    the placement rides the ResizeObserver on the header row. On the **fixed**
    placement there is no row to observe, so a window resize can leave the
    position up to one 2s tick stale; that is the backstop behaving as designed.
54. **A fixed box does not follow a scroll, and nothing here listens for one.**
    Scroll the thread hard with the popover open. It should not move, because
    the strip does not move: all three of anchor.ts's placements put it in a
    header. **If it does drift away from the strip, that is the case the design
    reasoned was impossible** — a `scroll` listener in the capture phase on
    `document`, feeding the same coalesced pass, is the fix. Reasoned from
    anchor.ts and bb's layout, not observed.
55. **The controls still work, and this is the one that would have been
    catastrophic.** Open the popover and press **Join audio**, then **Mute**,
    then a face, then **Transcript**. The popover must not vanish on the way
    *down*: outside-click dismissal now has two roots to test containment
    against (`insideWidget` in `canvas/dock/dock.ts`), and a version that tested
    only `#canvas-av-dock` would fold the popover on `pointerdown` for every
    control it contains, before the `click` ever arrived. **No test covers
    this** — there is no jsdom in this project — so it is verified here or not
    at all.
56. **The disposer takes it with it.** Reload the plugin (or deactivate the
    content-script generation) with the popover **open**, then
    `document.querySelectorAll("[data-canvas-dock-popover]").length` — it must
    be `0`. The popover is outside the tree `root.remove()` takes with it, so
    the disposer removes it by reference *and* sweeps the attribute
    document-wide, the same discipline the sidebar row decorations carry. A
    stranded popover keeps LiveKit video tiles attached to a dead generation.
57. **Moving the strip closes it.** Open the popover on a thread, then navigate
    to the **home** route, where the strip relocates to the fixed corner. The
    popover must be closed, and there must still be exactly one of it —
    `anchor.ts` relocates only the node it was given, so the popover neither
    travels with the strip nor is duplicated, and `reanchored` (expand.ts) is
    what folds it.
58. **It is still in OUR font, not bb's.** The popover used to inherit
    `font: 12px/1.35 -apple-system, …` from `#canvas-av-dock`; as a child of
    `<body>` it inherits bb's typography instead unless it declares its own, and
    `.dock-btn` asks for `font: inherit` outright while `.dock-jump` and
    `.dock-status` set a size with no family. The declaration was restored
    (`UI_FONT`, used at both roots) and the invariant is checked mechanically by
    `rootsWithoutOwnFont` — but "does this match the strip" is a thing only eyes
    can answer:

    ```js
    const p = document.getElementById("canvas-av-dock-popover");
    const d = document.getElementById("canvas-av-dock");
    [getComputedStyle(p).font, getComputedStyle(p).font === getComputedStyle(d).font];
    ```

    Expect `12px / 1.35` in the plugin's own stack, and `true`. Compare the
    four control labels against bb's own header buttons: they should NOT be the
    same typeface — the whole sheet is deliberately theme-neutral.

**The two reported bugs, walked end to end**

These four are the ones a human runs to close the two reports this round
answered. Steps 59 and 60 are the *only* evidence that exists for the clipping
diagnosis: it was reasoned from a described screenshot, in a spike with no
browser, and nothing about it has been observed.

59. **bb's LEFT panel open — the reported bug.** Open a **thread** with bb's
    left navigation panel **expanded**, and open the popover. The report was
    that it "shows behind the left side menu", cut off dead on the vertical line
    where that panel ends, with the faces to the left of the line *gone*. So
    look at that line, and at the faces:

    ```js
    const p = document.getElementById("canvas-av-dock-popover");
    const box = p.getBoundingClientRect();
    const first = p.querySelector(".dock-faces .dock-bubble").getBoundingClientRect();  // your own face is always one of them
    [p.parentElement === document.body, getComputedStyle(p).position];   // [true, "fixed"]
    // the popover's own left edge, and the centre of its leftmost face, must
    // both hit the popover — not bb's panel, and not the pane behind it
    const hit = (x, y) => { const el = document.elementFromPoint(x, y); return el === p || p.contains(el); };
    [hit(box.left + 2, box.top + 2), hit(first.left + first.width / 2, first.top + first.height / 2)];
    ```

    Both must be `true`, the popover's rounded left corners must be visible as
    curves rather than as a straight cut, and every face in `.dock-faces` must be
    a whole circle. Now collapse the panel and open it again: the box **moves**
    with the strip (the row got wider, so its anchor did) but its **width and
    height must be identical** to the pixel — `getBoundingClientRect()` before
    and after. It is sized against the viewport, not against the pane, so a size
    that changes with bb's panel means an ancestor is still re-basing it and the
    move did not take. If it *is*
    still cut off with `[true, "fixed"]` above, the clipping diagnosis was wrong
    and `z-index: 45` (against whatever bb's panel actually declares) is the next
    thing to read.
60. **bb's RIGHT panel open — where it was pushed off the left instead.** Same
    thread, open bb's right panel (or widen the sidebar) so the header row —
    and with it the strip, which is the action cluster's **first** child — is
    driven well in from the window's right edge. Open the popover:

    ```js
    const p = document.getElementById("canvas-av-dock-popover").getBoundingClientRect();
    const s = document.getElementById("canvas-av-dock").getBoundingClientRect();
    const d = document.documentElement;
    [p.left, d.clientWidth - p.right, p.top, d.clientHeight - p.bottom];   // all >= 8
    [Math.round(p.right - s.right), Math.round(p.top - s.bottom)];         // [shift, 6]
    ```

    No margin may be under **8**, and the top gap is **6** whenever the box is
    hung below. The first number is the horizontal correction: **0** if
    right-aligning already fitted, and **positive** when the box had to be pushed
    right because right-aligning would have started it off the left of the
    screen. It goes **negative** only when the strip's own right edge is within
    8px of the viewport's — which needs a placement that puts the strip flush
    with the window, not this one (reasoned from `placePopover`, not observed;
    the `fixed` placement sits 52px in, so it does not reach that branch
    either). Whether the push happens at all depends on how wide the box actually
    is — `width: max-content` up to `min(80vw, 420px)` — so narrow the window
    until it does. The popover may now overlap bb's right panel: that is
    expected and is exactly what leaving the pane bought, since a box that can be
    painted over the panel is a box the panel cannot clip.
61. **`bare`, with the thread title as the thing being protected.** On a
    **thread**, narrow the pane (or the window) until the strip drops its faces:

    ```js
    const d = document.getElementById("canvas-av-dock");
    d.dataset.dockSqueeze;                                          // "bare"
    d.querySelectorAll(".dock-strip .dock-bubble").length;          // 0
    getComputedStyle(d.querySelector(".dock-bubbles")).display;     // "none"
    d.querySelector(".dock-overflow").textContent;                  // e.g. "3", never "+3"
    getComputedStyle(d.querySelector(".dock-call")).width;          // "14px" — the mic stays
    ```

    Then the three things that matter, in order. **The thread title is
    readable** — bb's own title in `[data-testid="app-page-header-content-row"]`,
    which we do not own a selector for: read the row's text and compare it with
    the thread's real name. It must be words rather than an ellipsis; that is
    the entire point of the tier and the user's report ("Thread title is
    important"). **The mic still opens the popover** — click `.dock-strip`
    (the whole strip is one `<button>`) and check
    `d.dataset.dockExpanded === "true"` with
    `document.getElementById("canvas-av-dock-popover").hidden === false`.
    **The count is right** — it is everyone in the room **including you**,
    uncapped, and it must equal
    `document.querySelectorAll("#canvas-av-dock-popover .dock-faces .dock-bubble").length`
    for any room up to `MAX_DOCK_BUBBLES`; above that the popover folds its own
    tail and the strip's count is the larger, honest number. Widen again and the
    faces come back at `480`, not at 432 — the band, step 45.
62. **The Transcript button is in the popover's control row, not in bb's
    header.** On a **thread**, with the popover open:

    ```js
    const b = document.querySelector("[data-canvas-dock-scribe]");
    document.querySelectorAll("[data-canvas-dock-scribe]").length;          // 1
    b.parentElement.className;                                             // "dock-controls"
    [...b.parentElement.children].indexOf(b);                              // 3 — after Camera on
    b.closest("#canvas-av-dock-popover") !== null;                         // true
    document.querySelector('[data-testid="app-page-header-content-row"]').contains(b);  // false
    document.querySelector("#canvas-av-dock [data-canvas-dock-scribe]");    // null
    ```

    There must be exactly **one** of it, it must be the fourth control beside
    Join audio / Mute / Camera on, and bb's header row must not contain it — the
    header is the scarce surface on a narrow screen and that is why the button
    moved off it. Fold the popover: the button goes with it, and the strip is
    unchanged. (Its handle is deliberately still `data-canvas-dock-scribe` —
    deploy checks grep for that attribute, so the move must not have renamed it.)

### Where everyone is

The strip answers "who is in the room". The obvious next question — *and what
are they looking at?* — turned out to need something the plugin did not have.

**The preflight, and what it found.** The room's membership (`CanvasRoomHost`)
is built from `canvas_join`, and the only thing that calls `canvas_join` is the
**canvas panel**. A bb tab sitting on a thread has never joined, so before this
feature it was invisible: opening two brand-new bb tabs (a thread route and
`/settings`) left `canvas_debug.clientIds` completely unchanged, and the bubble
those tabs drew was somebody *else's* canvas tab, with no "(you)" on it. There
was no per-tab identity to hang a location on, so one had to be given.

**The minimum that works**, and deliberately not a second identity system:

* **One address per tab** — `canvas/tab-id.ts`, a module singleton wrapping the
  same `newClientId()` the transport already mints. The canvas panel now takes
  its clientId from there too (it used to mint its own in `useState`), so a
  canvas tab is **one** member of the room rather than a sync member and a
  location reporter that look like two different people.
* **One name source** — the strip resolves its own name through
  `fetchIdentity()`, the same `GET .../http/identity` door the panel uses. Same
  Cloudflare-Access-or-`local:<user>` answer, same trust boundary.
* **Two tabs of one person are one face.** The strip's bubbles have always been
  keyed by *name*, not by clientId (`canvas/dock/model.ts`), so somebody with bb
  open three times is one bubble — and one whereabouts. *Which* of their tabs
  that whereabouts means is its own decision, and the first answer was wrong:
  see below.

**"Which tab do we mean?" is two questions, not one.** The first cut collapsed a
person's tabs with `argmax(seenMs)` — most recently reported wins — and that is
a **coin flip** for anybody with two live visible windows: every window rewrites
its own `seenMs` on its own 2s timer, so the winner is decided by which of two
drifting timers happened to fire last. Measured live: three different answers
for one unmoving person inside twenty seconds, and the thread-row decoration flipping
on and off **nine times in forty-five seconds** while that person read one
thread. (The old justification — "a forgotten canvas window does not out-vote
the thread they are reading" — only ever held for a *backgrounded* window, which
stops polling and falls out on its own.) So:

* **Thread rows do not collapse at all** (`locatedTabs`). A row asks *"is anybody
  reading this thread"*, so every located tab votes yes and none votes no: the
  **union**. There is no argmax, so there is nothing to oscillate, and
  `threadRowStatuses` already deduplicates names, so a person with two tabs on
  one thread is still one name in the label.
* **The popover line and its link do collapse**, because they are one sentence
  and one href, and they rank **focus above recency** (`locateEveryone`): a tab
  that reported `document.hasFocus()` wins outright, since only one window can
  hold the focus and that is the honest answer to *"where are you"*. Among
  equals the answer **keeps the tab it chose last time** unless a rival is ahead
  by more than `WHERE_STICKY_LEAD_MS` (3s) — more than one poll period is not
  drift, it is a tab that has stopped reporting. Last of all comes recency, then
  the lower clientId so two genuinely equal tabs do not depend on the order the
  server serialised them in.

`tests/dock-whereabouts.test.ts` pins both halves, including the case the first
round missed: two tabs of one name whose `seenMs` alternate across successive
calls, asserting the chosen location does **not** alternate.

**The wire.** `canvas_roster` was widened rather than joined by a second
channel: its input went from `z.null()` to a `.strict()` object (still
`.nullable()`, because `CanvasOnlineCount` is a read-only consumer with no
location to report) and each member now carries `path`, `title`, `seenMs`,
`focused` and `inRoom`. `focused` is one bit — `document.hasFocus()` in the reporting tab —
and it is on the wire for exactly one reason: it is the only fact that settles
which of a person's live windows they are actually in (above). It is
`.optional()` on the way in and `.nullable()` on the way out; absent reads as
**not** focused, so an older bb bundle keeps polling successfully and can never
out-rank a tab that honestly claimed focus.
One request per tab per tick instead of two, and a location that can never be
newer or older than the membership it arrived with. The poll tightened from
**5s to 2s**: membership changes on the scale of people arriving at a meeting,
but *whereabouts* changes on the scale of clicking a thread. A route change does
not even wait for that — the strip watches its own `location.pathname` on the
rAF the anchor observer already drives, plus `popstate`, and pushes immediately.

`title` is the reporting tab's own `document.title`, which is how a jump link
can say *in "glossary measure"* without this server ever looking a thread up.

**Two horizons, and why a stale location is worse than none**
(`canvas/locations.ts`):

| Horizon | What happens |
| --- | --- |
| `LOCATION_STALE_MS` = **15s** | The member stays in the roster, but their location is reported as `null` — and so is its `focused` flag, because focus is a fact *about* a location. The strip says "somewhere in bb" and **offers no jump link**. Seven or eight missed 2s polls, so one dropped request changes nothing. |
| `LOCATION_IDLE_MS` = **2min** | The reporter leaves the roster entirely. Deliberately the same window as `CLIENT_IDLE_MS`, so the two membership books expire people on one clock. |

A location that is fifteen seconds old sends a teammate to the page you were on
a minute ago and tells them nothing went wrong; "somewhere in bb" is the honest
answer, so that is what is shown. Note that a **background tab stops polling**
(the strip skips the poll while `document.hidden`), so a minimised bb window
quietly leaves the room after two minutes — which is right, because a hidden tab
is not somewhere anybody is.

The book is **not** folded into `CanvasRoomHost`, and that is the load-bearing
decision: a room member owns a `ClientTransport`, and every canvas delta is
published once per transport. Making every bb tab in the building a room member
would multiply canvas traffic by the number of tabs that will never render a
canvas.

**Membership truth inverted, and it is worth recording.** `chooseRoster` used to
prefer the live bus roster outright, because the canvas panel refreshed it on
every presence tick while the poll knew strictly less. The poll now knows
strictly *more* — everyone in the building, not just the sync-room clients a
panel can see — so preferring the bus made opening the canvas page erase
everyone off it from your strip and silently clear every thread-row decoration. That
was observed live before it was fixed. It is now `mergeRoster`: the **poll** is
the membership truth and the bus overlays the one fact only it has,
`hasCursor`. The join key is the clientId, and it is exact precisely because one
tab is now one address.

**The sidebar badge counts the room, not the building.** Widening the roster
gave one pre-existing consumer a second, wrong meaning, and it is worth spelling
out because nothing about `canvas/roster-ui.tsx` changed to cause it.
`CanvasOnlineCount` — the *"● N"* beside the sidebar's Canvas row, whose
accessible label reads **"N on the canvas"** — has always had **two** sources
that had to agree: it seeds itself from `canvas_roster` and then follows the
room's `identities` realtime broadcast (which is what keeps it live in windows
that never open the canvas). Before the widening both read `room.identities`.
After it, the seed's `members.length` counted **every bb tab in the building**
while the broadcast still counted **canvas clients**, so the badge disagreed
with itself: measured live at three clients on the canvas and a badge reading
seven, snapping to four and back on every join/leave/idle-sweep publish. A
number a user cannot learn a rule for, asserting a fact that was false.

The fix is to make the two sources symmetrical again by having the server state
the subset rather than asking the client to re-derive it: every roster member
carries **`inRoom: boolean`** — *is this clientId in `room.identities`* — and
the seed counts on it, in the pure `onCanvasCount` (`canvas/roster.ts`), which
is exactly `Object.keys(identities).length` for the same population. It is the
server's answer and not a client-side guess on purpose: `path` cannot
distinguish an open canvas panel from a tab parked on `/plugins/canvas/canvas`
whose panel has unmounted, and a canvas client that has not polled yet has no
path at all. `inRoom` is deliberately **not** subject to `LOCATION_STALE_MS` —
staleness is a fact about a *location* report, and forgetting where a canvas
client is must not drop it out of the count. Pinned at both levels:
`tests/roster.test.ts` (`onCanvasCount`, including that it under-reports rather
than invents when the flag is missing or junk) and `tests/av.test.ts` (the wire:
a joined client is flagged, a thread tab is not, and a client that leaves the
room stays in the roster but stops being counted).

#### The thread-row presence faces

A sidebar row for a thread somebody is currently reading carries **their circle
from the header strip** — the same initials, the same name-derived hue — in
front of the thread title. `you, bob viewing` reads as a red **AL** and a green
**BO** beside *glossary measure*, and the strip above it shows the identical two
circles. That identity is the point: one person is one colour everywhere.

**The sanctioned API was abandoned, and this is why.** This used to be
`PluginContentScriptContext.experimental_setThreadRowStatus` —
`{ icon: "Eye", label: "you, bob viewing", tone: "default" }`. The product owner
reported the defect that killed it:

> "When you hover over the eye, the row state changes to show the archive button
> and loses the eye; so you can never see who the eye refers to."

Two independent problems, both fatal:

* **The slot is hover-contested.** The host paints a plugin's row status into
  the row's draft-glyph slot — the 28px `span` at the right-hand end — and bb
  reclaims exactly that slot for the row's hover actions. Measured on the
  running app (bb 0.40.0, 2026-09-01): at rest the slot's
  `span.bb-sidebar-hover-actions-fade` has `opacity: 1` and
  `div.bb-sidebar-hover-actions` (Archive, Thread actions) has `opacity: 0`; on
  hover they swap. The eye lived in the layer that goes to zero. So the glyph
  vanished under the pointer, and its label — the *only* place "who" could be
  said — could be read only *by* hovering. Unreadable by construction.
* **The payload cannot carry a colour.** `PluginComposerThreadRowStatus` is
  `{icon: string, label: string, tone?}` where `icon` is a *name from bb's own
  registry* ("Eye" is real, verified in `components/ui/icon-registry.ts`
  alongside "EyeOff"). There is no per-person colour and no avatar in it. "The
  same coloured circle as in the header av dock" was not sayable through that
  door at any price.

**So the plugin decorates the row itself**, which is what the SDK's own
content-script documentation sanctions: *"Styling or decorating existing
app-shell DOM belongs here rather than in an always-on frontend stylesheet."*
The condition attached to that permission — the script's disposer removes what
it added — is met (see below).

**Where it goes, and why leading.** Into the row's **title span**
(`span.bb-sidebar-hover-actions-inset`), as its **first child**, never the
contested right-hand slot. Both positions were measured on a full-width title,
at rest and hovered:

| | at rest | hovered |
|---|---|---|
| title span `padding-right` | `0px` | `24px` |
| a **leading** child's `x` | 40 | **40** |
| a **trailing** child's `x` | 247 | **223** |
| the title's own width | 177px | 153px |

The hover inset squeezes the span from the right. A leading child does not move;
a trailing one is shoved 24px and competes with the title for what is left. The
faces therefore sit where the hover state cannot reach them, and the archive
button appears *alongside* them rather than in their place.

**What a row says.** `canvas/dock/thread-status.ts` decides it, and it is a pure
module for the usual reason — this project has no jsdom, so anything decided
inline in `dock.ts` is decided where no test can reach it:

* **Up to `MAX_ROW_FACES` (3) circles, then `+N`** — the strip's own overflow
  convention scaled to a 28px row (18px circles overlapping by 5px), not a
  second idiom. **You are never the face that gets folded away.**
* **You are shown, and you sort first.** `you, bob viewing`, never
  `bob, you viewing`, and never your own resolved name handed back to you. Your
  *circle* is still yours — your real name's initials and hue — because it has
  to match the face you are looking at in the strip.
* **When the strip does not know who you are, nobody is `you`.**
  `resolveSelfName` returns null off the canvas page, out of a call, with the
  identity fetch unresolved. Then every viewer is named. Calling *everyone*
  `you` and dropping the unknown self are both bugs; naming everyone is neither.
* **A person's tabs are unioned, never voted on** (`locatedTabs`, not
  `locateEveryone`). All of their windows light their rows; each person is named
  once, and your own several tabs collapse to a single `you`.
* **The accessible name is readable without hovering.** The decoration is
  `role="img"` with an `aria-label` naming everybody — *including* the people
  folded into `+N`, because a count a screen reader cannot expand would
  re-create the very defect this replaced. A `title` is set too, though the
  row's own `position:absolute; inset:0` link paints above the faces and may
  swallow the native tooltip; that same paint order is why a click on a face
  reaches the row, and `pointer-events: none` makes that a guarantee rather than
  a consequence.
* **The jump link is still others-only.** Only the rows changed. The popover has
  never offered to fly you to yourself and still does not.

**Staying attached, without hanging the app.** Rows are React-rendered, the list
is **virtualised** (measured: scrolling a row out of view unmounts it entirely),
and it re-orders. The decoration rides the machinery that already exists rather
than a second copy of it:

* **The same coalesced pass** `canvas/dock/sync-latch.ts` drives for the strip's
  own placement — the `MutationObserver`'s frame, with the 2s roster tick as the
  backstop for the frame that never comes, because `requestAnimationFrame` is
  not a promise.
* **A signature, not a re-render.** Each decoration carries
  `data-canvas-row-presence="<signature>"`, a string equal for two decorations
  that would render identically. `planRowDecorations` compares it and emits
  `add` / `update` / `move` / `remove` — **and nothing at all for an unchanged
  row**. That is both the cost argument (this runs on every DOM mutation bb
  makes anywhere, forever) and the termination argument.
* **`move`, because writing into a React container has one condition.**
  `anchor.ts`'s rule, applied to a second container: React reconciles only the
  children it created and never walks the container looking for strangers, so it
  can shuffle a foreign node's *position* but not its *existence*. So we notice
  when we are no longer the first child and put ourselves back. Every repair is
  a **move** of the one node we own, so no number of re-renders can produce a
  second decoration.
* **An explicit loop guard.** Until this feature the observer only ever watched
  DOM somebody else owned; it now watches a subtree the pass it schedules
  *writes into*. `shouldScheduleSync` breaks that at the source: a mutation
  batch whose every record is **ours** — our own subtree, or a `childList`
  record on a host node whose added/removed nodes are all ours, which is exactly
  "we inserted a decoration into a row" — schedules nothing. The cascade is not
  merely convergent, it never starts.

**Introspection**, on the strip's own root, because the rows live in DOM this
plugin does not own:

| attribute | meaning |
|---|---|
| `data-dock-row-decor` | `ok` / `no-rows` / `failed`. `no-rows` = there is no `a[data-sidebar-thread-id]` to decorate (another plugin owns the thread list, or the route has no sidebar); `failed` = the pass threw. Nothing to decorate and broken must not look alike — the job `data-dock-row-status` used to do for the feature-detected host API. |
| `data-dock-rows` | how many decorations are attached right now |
| `data-dock-row-writes` | how many DOM writes the decorations have made this generation. **A counter that stops climbing while nothing is happening is the proof there is no feedback loop.** |

**Every decoration is removed by the disposer**, sweeping
`[data-canvas-row-presence]` document-wide. These nodes live in the host's DOM,
so nothing else will remove them: a disposer that left them behind would
decorate rows on behalf of a plugin that is no longer running, with faces that
stopped updating the moment it stopped. The mount also runs a **one-time
retirement sweep** that clears the host row status (`setThreadRowStatus(id,
null)`) for every row currently in the sidebar, so nothing the retired call path
left behind can sit next to the new circles.

**Known edges, stated rather than worked around:**

* **Only rows bb itself renders.** A plugin that registers its own thread list
  (`PluginThreadListRegistration`) replaces the row this draws on. Such a row
  carries no `data-sidebar-thread-id`, there is nothing to attach a face to,
  and the pass reports `data-dock-row-decor="no-rows"` — correctly, and without
  throwing. This is a real limit of drawing into someone else's DOM, and it is
  stated because the failure is silent by construction.

  It is stated WITHOUT an example, deliberately. `yaks` was named here as one,
  and that turned out to be wrong (see below); no plugin installed on this
  machine has since been observed actually taking the rows over. An
  unsubstantiated example is worse than none — it sends the next reader
  debugging the wrong plugin.

  **The blast radius is narrower than it first looks, and it is per-ROW.** A
  takeover only costs the rows that plugin actually renders — not the view, and
  certainly not the session. Observed on the deployment on **2026-09-02** with
  `yaks` 0.4.1 enabled, in **organise-by-projects**, the view previously
  believed to be lost entirely: `yaks` inserts its own headings (a yak's title,
  and a `No yak` group) and files bb's ORDINARY thread rows underneath them.
  Those rows still carry `data-sidebar-thread-id`, so the circles are drawn on
  them exactly as anywhere else — screenshotted, with a face sitting on a
  `Daily — …` row two levels inside a yak.

  An earlier note here said `yaks` replaced the rows in that view and that you
  had to switch to **by machine** or **manually** to get the circles back. That
  was written from a `data-dock-row-decor="no-rows"` reading taken before the
  circles existed in their current form, and it has not been reproduced since.
  It is corrected rather than deleted because the shape of the claim is the
  thing worth remembering: what matters is whether a given ROW is bb's, and the
  attribute answers that per row. Read `data-dock-rows` if you want the count
  the strip actually decorated — it is the only trustworthy answer, and it is
  cheaper than reasoning about which plugin owns what.
* **A row we can no longer identify keeps its decoration until its row goes.**
  If the thread-id attribute disappears from a row that is still mounted, that
  row is no longer in the plan and nothing is removed from it. In practice a
  plugin taking over the list unmounts the rows and our nodes go with them; the
  disposer sweeps the rest.

#### Jump to them

Under each face in the popover — **below the video, per the ask, and separate
from the face's own "fly the canvas camera to their cursor"** — is a line saying
where that person is, and when there is somewhere honest to send you, it is a
**real `<a href="/projects/…/threads/…">`**. That is what makes middle-click,
⌘-click, right-click → *copy link address* and the browser's status bar work:
the strip does nothing at all and they behave.

**No link for you, and no link for an unknown or stale location.** The sentence
still shows in both cases — where somebody is is worth reading even when there
is nowhere to click. `jumpHref` (`canvas/dock/where.ts`) also refuses anything
that is not a rooted same-origin path, because this string came off the wire
from another client: `//evil.example/x` looks like a path, passes a naive
`startsWith("/")`, and is a cross-origin navigation. The wire refuses the same
shapes independently in `canvas_roster`'s schema; neither half trusts the other.

**Plain left click only** is intercepted (`shouldTryClientSide`), and then:

1. `history.pushState(…)` + a synthetic `popstate`. bb's router answers this —
   verified against the running app, where a pushed entry re-routed a thread
   page in under two frames.
2. **Verify.** "Did the path change" is *not* evidence: `pushState` moves
   `location.pathname` whether or not anybody was listening, so a failed attempt
   leaves the destination in the URL bar and the old page on screen. The
   evidence that the *app* moved is that it repainted, and the proxy is
   `document.title` (bb sets a placeholder within a frame or two and the real
   title later). Checked on the next two frames, then once more after 150ms.
3. **Fall back** with `location.replace(path)` — `replace`, not `assign`,
   because step 1 already pushed a history entry for this path, so replacing it
   leaves the back button pointing where the user actually came from.

`clientSideTook` **errs towards falling back**: two pages sharing a title read
as "did not take", and the cost is a full page load that lands in exactly the
right place. The opposite mistake would strand the user on the old page with the
new URL in the bar, escapable only by reloading by hand. That asymmetry, and
every branch that hands a click back to the browser, is pinned by
`tests/dock-navigate.test.ts` — this is the part of the feature most likely to
rot silently the next time bb changes, so it is tested rather than hoped for.


## The room transcript

The canvas room is a voice room, so it produces a second stream beside the
drawing: **what was said**. On the production VM a systemd service (LiveKit →
Whisper) POSTs each utterance to this plugin.

**The transcript is not a bb thread.** A thread is a conversation *with an
agent* — turns, a provider, a runtime. A room transcript is a firehose of short
utterances from humans talking to each other; nobody replies to it, and every
question anyone asks of it is a query ("the last ten minutes", "everything
Alice said", "did we mention Postgres"). That is a table with an index on time.
Modelling it as a thread would buy agent affordances nobody wants and cost
every query everybody does.

| Direction | Surface |
| --- | --- |
| In | `POST …/http/scribe`, `auth: "token"` |
| Out, live | realtime `canvas:transcript`, one message per utterance |
| Out, query | rpc `canvas_transcript_query` |
| Out, shell | `bb canvas transcript` |
| Out, agent | the `@transcript` mention + the `room-transcript` skill |

### Ingest

`auth: "token"` is the only right mode here: the caller is a **machine**, not a
bb app origin (`"local"` would reject it) and not a webhook with a signature of
its own to verify (`"none"` would let anything on the box write into the room's
memory). The service carries `bb plugin token canvas` in `x-bb-plugin-token`.

```
TOKEN=$(bb plugin token canvas)
curl -X POST -H "x-bb-plugin-token: $TOKEN" -H "content-type: application/json" \
  -d '{"speaker":"alice","text":"the transcript route is live"}' \
  http://127.0.0.1:38886/api/v1/plugins/canvas/http/scribe
# {"ok":true,"inserted":1}

# a batch — what the service sends when it catches up after a blip
curl -X POST -H "x-bb-plugin-token: $TOKEN" -H "content-type: application/json" \
  -d '[{"speaker":"bob","text":"can you hear me"},{"speaker":"alice","text":"loud and clear"}]' \
  …/http/scribe
# {"ok":true,"inserted":2}
```

Three deliberate choices in the body contract:

- **`ts` is optional and defaults to server-now.** An utterance is timed by when
  it was *spoken*, so a producer that knows better says so; one that does not
  gets the only honest answer available.
- **Unknown fields are tolerated, known ones are not.** The producer is a
  service on another machine this repo does not own. When it grows a
  `confidence` field, the room should keep working — not refuse every utterance
  until both sides ship together. `speaker` and `text` are still validated
  strictly, and the error *names the field* (`at 1.text`) rather than the vague
  root failure a zod union would report.
- **A batch lands whole or not at all**, in one transaction. Half a minute of
  conversation is worse than none, because nobody can tell it is half.

### Reading it

```
bb canvas transcript                        # the last 200 utterances
bb canvas transcript --since 10m            # 45s | 10m | 2h | 1d — the unit is required
bb canvas transcript --since 2h --speaker alice
bb canvas transcript --search "rate limit"  # substring of what was SAID
bb canvas transcript --limit 50 --json
```

`--limit` (default 200, max 1000) is the **tail**, and output is always
**oldest first**. Both halves are deliberate: a reader asking for 50 lines of a
four-hour day wants the last 50, and reading order is the opposite of "newest
first", so the reversal happens once, in the store, and every consumer renders
top to bottom. The rpc takes the same filters, with `sinceMs` as an *absolute*
epoch bound (the CLI turns its duration into one).

A search is a substring, never a `LIKE` pattern — `--search "100%"` finds the
one line that says it, not every line in the room.

### For agents

`@transcript` in any composer offers **Last 15 minutes**, **Last hour**,
**Today**, and — once you have typed something — **matches for …**, each with a
live count so an empty window is visible *before* it costs a send. The items are
**windows, not rows**: `resolve` runs at send time, so "the last 15 minutes"
means the 15 minutes before the agent reads them, not before the user typed.

The block is capped at ~8000 characters, dropping the **oldest** lines and
saying so in its header. Oldest-first is the only defensible direction: an agent
catching up needs the *end* of the conversation, and a block that silently
stopped ten minutes short of now is worse than useless.

`skills/room-transcript/SKILL.md` is the standing knowledge that goes with it —
the CLI's grammar, plus how to read a transcript well (they are lossy, turn-taking
is implicit, and a transcript is not a decision record).

### Where the UI lives, and where it does not

There is deliberately **no transcript tab on the canvas page**. What the room
said out loud is ambient context for everything you do in bb, and the place you
most want it is beside the agent you are briefing. So one `TranscriptView` is
registered in three slots, and reached through **four** doors:

| Slot | Where it shows up |
| --- | --- |
| `threadPanelAction` | any thread's right panel, next to Terminal |
| `experimental_newThreadPanelAction` | the New-thread screen's panel |
| `commandPaletteAction` | ⌘⇧P → "Canvas: open room transcript" |

The fourth door is not a slot of its own: it is the **Transcript button in the
presence strip's popover**, which relays `useBbNavigate().openThreadPanel` out of an
`experimental_threadHeaderAction` that renders nothing
(`canvas/dock/transcript-door.ts`, `canvas/dock/transcript-door-slot.tsx`) and
opens the *same* `threadPanelAction` registration as the launcher row. It is
visible on thread routes only, because that is the only surface the panel
exists on. See "The 📜 button — how it was ruled out, and how it got built
anyway" above for the measurements behind that.

The palette row uses `isAvailable` to hide itself where `openPanel` would
decline (it only has somewhere to go on the main thread view) — a command that
does nothing is worse than a command that is not there. All three slots use
`layout: "flush"`, because the view owns its own scrolling (a pinned live tail)
and its own footer (the search box), which the host's padded scroll container
would fight.

The view seeds itself over rpc, follows `canvas:transcript` live, and re-reads
after a realtime reconnect — those signals are ephemeral and never replayed, so
every utterance during a socket gap is otherwise simply gone. Live rows are
filtered by the *same* predicate the server applied, so a row that appears while
you are searching is a row that survives the next refetch. Auto-scroll follows
the live edge only while you are watching it; scrolling up to read is a
deliberate act, and yanking the viewport back mid-sentence is the worst thing a
live log can do — so the tail unpins, and **Jump to live ↓** appears. Speakers
are coloured with the same name → hue hash the cursors and avatars use, so one
person is one colour everywhere in this plugin.

The canvas packages (`@ensembleworks/canvas-model`, `-doc`, `-sync`, `-editor`,
`-react`) are consumed as `file:` deps straight from the EnsembleWorks
checkout, as raw TypeScript. This spike never modifies them.

### Known cost: the app bundle is ~5.2 MB

`canvas-doc` imports `loro-crdt/base64`, which inlines the Loro wasm as a
base64 JS string, and `bb plugin build` emits one unsplit `dist/app.js` that
loads in **every** bb window whether or not anyone opens the Canvas panel.
Neither half is fixable from here: the import lives in `canvas-doc` (which this
spike may not modify) and code splitting is the host's to offer. `livekit-client`
adds ~600 KB on top of that, and it is bundled statically for the same reason: a
dynamic `import()` buys nothing when the build cannot split. Accepted for a
spike; it is the first thing to solve before this ships to anyone.

### Debugging a live panel

`window.__canvas` (editor, tool context, presence store, an `input()` that
feeds the same handler real pointer events reach, and the roster/audio `bus`)
is **opt-in**, because this bundle loads everywhere: append `?canvasDebug=1` to
the panel URL, or set localStorage `canvas.debug` to `"1"`.

`bus` is how you exercise the audio UI without a LiveKit server — it drives the
same store `av-room.ts` writes to:

```js
__canvas.bus.setAv({ status: "live", muted: false, speaking: ["alice"] });
// header shows Mute/Leave; alice's avatar and her cursor both get a ring
__canvas.bus.setAv({ status: "off", speaking: [] });
```

## Standing rule: every panel wiring seam gets a parser-based guard

**There is no jsdom here and there may not be one.** So every *decision* lives
in a pure, exported, unit-tested module and the `.tsx` files are hands only —
that half is well covered. The half that keeps breaking is the **seam**: proof
that the component actually *calls* the decision it imports. A hook can import a
perfect module, name it in a comment, keep it in a dependency array, typecheck
clean, and never run it. On 2026-09-06 thirteen such mutations of
`canvas/pages/PageSwitcher.tsx` were tried; **twelve** left all 43 test files
green and `tsc --noEmit` at 0, and only one was already caught. A second pass
over the *guards written for them* then found **four more** that were still
green — three variants of the uncalled decoy aimed one level up from where each
guard looked, and one spread-override. They are now all guarded — see the
wiring-seam blocks at the end of `tests/tab-drag.test.ts` and
`tests/page-tab-menu.test.ts`, which name the mutation each assertion exists to
fail on.

The rule, therefore: **a guard on a wiring seam asks the TypeScript parser about
SHAPE, never a regex about text.** `tests/lib/source.ts` is the only place that
reads a component's source, and it has one helper per shape-question:

| Question | Helper |
| --- | --- |
| which real call sites exist, and what is each one handed? | `callsTo(source, callee)` |
| which statements does this function actually RUN, in order? | `bodyStatements(source, name)` |
| what is this variable actually initialised to? | `initializerText(source, name)` / `objectLiteralText` |
| which expression does this element's attribute hold? | `jsxAttributes(source, marker)` |
| does REACT RUN this effect — is it a statement of the component's own body? | `topLevelEffectIn(source, fnName, needle)` |
| which statements does this effect actually RUN, in order? | `effectStatements(effectText)` |
| (last resort, bounded) one call's own argument list | `callArguments(code, name)` |

### The four attacks that have defeated guards in this repo

Each of these shipped past a green suite and a clean `tsc --noEmit`. Write a new
guard so that all four fail it.

1. **The comment.** `PageSwitcher.tsx`'s own header spells out the call sequence
   it performs, so a `toContain("resolvePageId(peer.doc, pageIdFromSubPath(")`
   was satisfied by the *prose* after the call itself was cut down. Every guard
   reads through `stripComments` for this reason — and that is the floor, not
   the ceiling.
2. **The string literal.** `stripComments` deliberately does **not** blank string
   literals (dozens of guards legitimately match `addEventListener("keydown"`).
   So the real `setPointerCapture` call was deleted and replaced with
   `const capture = "setPointerCapture(event.pointerId)"; void capture;` and the
   suite stayed green. **A string is not a call**; only `callsTo` knows the
   difference.
3. **The value-changing / value-discarding suffix.** A guard that pins a
   *prefix* cannot see an arithmetic mutation (`right: rect.right * 0` passed a
   guard closed only at the left) and a guard that counts *calls* cannot see the
   answer being thrown away (`if (back !== null) tabRefs.current.get(back)?.focus();`
   → `if (back !== null) void back;` left `countInCode(…, "pageTabMenuFocusReturn(") === 1`
   perfectly true and focus permanently stranded). The same trick works through
   a spread: `PopoverAnchor` is exactly four fields, so `...anchorOf(tab)`
   followed by `anchorLeft: 0, anchorRight: 0, anchorTop: 0, anchorBottom: 0,`
   computes the right anchor and totally overrides it, past a guard that pinned
   only the `anchorOf` call. Pin whole statements and whole argument objects,
   closed at both ends.
4. **The uncalled decoy.** A regex bounded to a *text region* is satisfied by
   dead code inside that region:
   `const shape = (): void => { if (tabDragBlocksContextMenu(dragRef.current)) return; }; void shape;`
   contains the guard's exact captured text, is never called, and left the
   context menu opening over every drag in flight. A decoy can put the text
   anywhere; it cannot put it back in the list of statements a function actually
   runs. That is `bodyStatements`.

   **And the decoy climbs.** Once a guard pins one level, the same move works on
   the level above it, because *every* text- or call-based helper here —
   `callsTo` included — is **reachability-blind**: the parser reports a call it
   can see, not a call that runs. Three variants got past the guards written
   for the mutations above:

   * registrations moved out of a surviving effect —
     `const register = (): void => { document.addEventListener(…); … }; void register;`
     — kept a `callsTo(dismissal, "document.addEventListener")` assertion exactly
     true while the tab menu bound nothing and stopped closing on Escape. Ask
     `effectStatements` for the effect's own top-level statements instead.
   * the same move on `window.addEventListener("keydown", onDragKeyDown)`, past
     a guard that pinned only the handler BODIES with `bodyStatements` — both
     handlers perfect, neither attached.
   * a whole `useLayoutEffect`, byte-for-byte unchanged, wrapped in
     `const focusOnOpen = (): void => { … }; void focusOnOpen;` — an EXACT match
     on the effect's own text stayed green while React never ran it. Reachability
     is not something a call's text can carry; only its POSITION in the
     component's statement list can. That is `topLevelEffectIn`.

   The general form: **pin the seam at every level between the decision and the
   thing that runs it** — the statement is in the function, the function is
   attached, the effect is in the component body.

Two corollaries that fall out of the same failures:

* **Assert at least one ABSOLUTE value for any threshold.** A 768px reveal
  threshold shipped wrong past 20 green tests because every assertion was
  written relative to the constant itself.
* **A guard that exists and does not hold is worse than none**, because it reads
  as covered. When a guard is shown to be defeatable, *replace* it and say in
  the comment what defeated it — do not add a second one beside it.

### The ceiling, and where this stops — owner decision, 2026-09-07

**Do not open a fifth round.** The rule above is worth keeping and the guards
already written are worth having, but they are now explicitly understood as
*partial*, and the owner has decided not to chase the remainder.

The reason is structural, not a failure of any particular guard. **Every helper
in `tests/lib/source.ts` is reachability-blind.** `callsTo` returns every
`CallExpression` the parser can see, called or not; `bodyStatements` lists what
a function contains, not whether anything invokes that function. So each round
of guards has been beaten by moving the pinned thing exactly one level further
from where the guard looks:

* round 1 — regex over source text, beaten by a comment, a string literal, and a
  value-discarding suffix;
* round 2 — `callsTo` parser guards, beaten by an **uncalled decoy**;
* round 3 — statements pinned inside the effect, beaten by a decoy closure
  *inside the effect body*.

There is no fixed point here. Proving that a component reaches a line requires
**executing** it, and nothing static can substitute. That is the real cost of
the no-jsdom rule — a deliberate trade, not an oversight.

**So the policy is:**

1. Keep writing parser guards for new wiring seams. They catch what actually
   happens in practice: an honest refactor that drops a call, renames a handler,
   or reorders an effect. **Nobody regresses code by planting an uncalled
   decoy** — the decoys are an adversarial validator's tool for measuring guard
   strength, not a realistic failure mode.
2. **Do not treat a decoy-based finding as blocking.** Record it, do not chase
   it. Twelve such findings were open when this decision was taken (three on the
   tab seams, nine on the attach affordance); they are accepted, not fixed.
3. **Reachability is verified by hand.** A change to interaction-bearing wiring
   is not done until someone has driven it in a real browser. The suite proves
   the decisions are right; only a person proves the hands are attached.
4. If this becomes intolerable, the answer is a **DOM lane** (jsdom or a small
   Playwright pass) scoped to wiring only, leaving the pure modules jsdom-free —
   not a sixth round of cleverer static guards. That reverses a founding
   constraint and is an owner call.


## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry (the full shadcn set, version-matched to your BB install
via the pinned ref in `components.json`):

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches BB's own toaster), are provided by the BB app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `bb plugin types`
repins them alongside the SDK. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`, which holds
  `room-transcript`. Each directory with a `SKILL.md` is one skill, named after
  the directory.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; declare `icon` as a BB icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.bb` — supported bb app version range.
- `engines.bbPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.4.21`). BB reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that BB does not provide.
  `bb plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (BB shims React, the portal primitives, and
  `@get-bb/plugin-sdk` at runtime — never bundle them).

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Install

From this directory (`bb plugin new` already ran the install; a fresh clone
needs it):

```
npm install
bb plugin install .
```

After editing sources, reload:

```
bb plugin reload canvas
```

Or let `bb plugin dev` rebuild and reload on every save.

## Inspect the live room

```
bb canvas status         # room, who is connected (by name), shapes, pending updates
bb canvas shapes --json  # every shape id
bb canvas agents         # every note -> agent-thread link and its live status
bb canvas transcript --since 30m   # what the room said in the last half hour
bb plugin token canvas   # the token the VM's scribe service POSTs with
bb plugin config canvas  # the project + the three LiveKit settings
npm test                 # vitest: the backend + transport suite (no bb server needed)
```

## Types & API reference

The plugin API ships as the npm package `@get-bb/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.4.21` — the SDK of the BB
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@get-bb/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every BB release, so the pin has to track the BB you
actually run:

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the BB
repo and read the source: <https://github.com/get-bb/bb>.
