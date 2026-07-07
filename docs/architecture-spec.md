# EnsembleWorks — Reference Architecture

**Status:** code-agnostic reference architecture of the system as it stands
today. Each component is described by its abstract role, contract, and data
flows, with the current implementation called out in parentheses as the
concrete instance. The seams between components are made explicit so the
space of alternative implementations is visible.

**Scope:** one team, one shared Linux VM, one room (or a few side rooms), a
mob of people editing/operating together. This is not a multi-tenant SaaS
architecture; the VM *is* the instance.

---

## 1. Purpose & product

A **multiplayer infinite-canvas team room** for a dev team that mobs on a
shared Linux VM. The canvas holds:

- **live terminals** backed by a real PTY/multiplexer (everyone types into
  the same terminal; sessions survive browser disconnects),
- **embedded dev servers** rendered as iframes,
- **sticky notes, drawings, text, images, frames**,
- **teammates as video bubbles at their cursors**, with **spatial audio**
  — a voice gets louder the closer your viewport is to where they're
  working.

An **agent API** lets on-VM agents (and anything else on the box) read and
write the canvas over HTTP, so an agent can see what teammates placed and
report back. A **scribe bot** joins the voice room, transcribes speech with
a hosted STT service, and posts each utterance — attributed to the speaker
*and stamped with where on the canvas they were working* — back to the
canvas server for minutes/conversation-map agents to consume.

**One always-on VM, public via a reverse-tunnel + access-gateway in front of
it.** The box opens no inbound ports; the tunnel dials out, and the access
gateway is the auth boundary.

---

## 2. Topology

```
browser ─HTTPS─► edge (auth boundary) ─► tunnel ─► reverse-proxy :8080
                                                                  │
                ┌─────────────────────────────────────────────────┤
                │                                                 │
        /dev/{port} ─► any dev server on the VM                   │
        /api/terminal/{health,sessions,ws} ─► terminal gateway    │
        *            ─► app dev server / static app                │
                          and proxies:                            │
                          /sync/{room} ─► canvas sync server      │
                          /uploads,/api ─► canvas sync server     │
                            (incl. /api/terminal/{connect,relay,  │
                             list,status} — the remote relay plane)│

browser ──► media plane (WebRTC voice/video, hosted) ─── direct

scribe bot ──► media plane (subscribe-only) ──► hosted STT
                                                └──► POST /api/scribe/transcript
```

### 2.1 Planes, deliberately separated

Two data planes that **deliberately don't merge**:

- **The spatial canvas plane** owns *spatial state*: which shapes exist,
  where they are, how big, who's on what page, where each cursor is. This
  is the source of truth for "what's on the room" and is a CRDT-synced
  document.
- **The content plane** flows on its own channels: terminal bytes over the
  terminal gateway, media over the media plane. The canvas plane carries
  **only small references** — a terminal shape holds a *session id*, an
  embed shape holds a *URL*. Bytes never traverse the canvas sync channel.

This separation is load-bearing: it keeps the canvas store tiny and fast,
lets the terminal substrate and the media backend be swapped
independently, and means a heavy content stream can't starve cursor sync.

### 2.2 The reverse proxy's only bespoke job

The reverse proxy in front of the app has one primary bespoke route:
same-origin `/dev/{port}` → any dev server listening on that local port on
the VM (so embedded dev-server iframes are same-origin with the app and
can be interacted with without cross-origin restrictions). It also splits
the terminal surface by path: the **local** terminal plane
(`/api/terminal/{health,sessions,ws}`) goes to the standalone terminal
gateway process, while the **remote relay** plane
(`/api/terminal/{connect,relay,list,status}`) and **everything else** go to
the app server, which serves the static app and proxies the backend routes.
In dev this same topology runs locally, reached via port-forwarding instead
of a tunnel.

---

## 3. Components

### 3.1 Canvas sync server (the app backend)

**Role:** the authoritative-but-CRDT-replicated spatial state of every
room, plus the HTTP surface for agents, uploads, transcripts, and media
token minting. Serves the static app build in production.

**Current instance:** a Bun process running Express + a WebSocket server,
compiled to a single binary (`ensembleworks-server sync`, the default
sub-command of a `sync|term` dispatcher); one in-process `TLSocketRoom` per
room, persisted one-SQLite-file-per-room via `SQLiteSyncStorage`; schema =
tldraw schema + two custom shape types (`terminal`, `iframe`).

**Contract — kernel + plugins:** the HTTP surface is assembled as a **thin
kernel** plus **per-plugin feature routers**. The kernel owns what every
plugin shares — rooms, the sync WS upgrade, caller identity, uploads, and
the static build — and reserves a small set of routes (`/api/health`,
`/api/whoami`, `/api/participants`, `/api/tools`). Each plugin owns a
namespaced slice of `/api/<plugin>/…` and is mounted as an Express router
against a shared `PluginServerContext` (rooms, sessions, media, storage).
The current plugins are **av** (`/api/av/token|kick|pulse`), **canvas**
(`/api/canvas/sticky|shape|frames|frame`), **scribe**
(`/api/scribe/transcript`), **roadmap** (`/api/roadmap/doc`), and
**terminal** (`/api/terminal/status|list` + the relay upgrade routes,
§3.2). Routers mount in a fixed order and the static catch-all stays last;
`/uploads` remains a top-level (non-`/api`) route. The direction of travel
is a plugin registry: routes, their JSON-Schema, and the CLI/`/api/tools`
manifest (§3.6) all derive from one contracts tool registry.

**Contract — persistence:** every canvas mutation commits to that room's
SQLite file transactionally on the change (no debounced save), so the room
survives process restarts and there is no save-dance.

**Contract — room lifecycle:** rooms are created lazily on first connect
(or first agent write) and live for the process lifetime; a per-room
SQLite file under `DATA_DIR/rooms/<room>.sqlite` is the durable store.

**Contract — identity:** the sync WS handshake carries `userId` and
`sessionId`. The *presence userId* (canvas cursors) is also used as the
*media-plane participant identity*, which is what matches a voice bubble
to a cursor and a transcript line to a speaker. So one stable id threads
through all three planes.

### 3.2 Terminal gateway

**Role:** bridge browser terminal emulators to real PTY sessions on the VM
so that (a) many browsers can view/type into one terminal, (b) the session
outlives every browser and the gateway itself, and (c) the same session is
reachable from a plain SSH shell.

**Current instance:** a small Bun HTTP + WebSocket server
(`ensembleworks-server term`, the second sub-command of the compiled server
binary). Per canvas terminal session it holds **exactly one** PTY —
spawned via `Bun.spawn` (a small in-tree PTY wrapper replaces node-pty,
which is a native Node addon Bun can't load) — running `tmux new-session -A
-s canvas-<id>` (attach-or-create). That one pty's output is **fanned out**
to every attached WebSocket, so all viewers see identical bytes. The PTY is
*a single tmux client*, not the session — the tmux session is the durable
substrate; the pty and the gateway are ephemeral. The tmux spawn is a
**shared spec** (`canvasTmuxSpawnSpec` in `@ensembleworks/contracts`) so the
local gateway and the remote connector (below) open byte-identical sessions.

**Current instance — remote gateways (relay plane):** a box that isn't the
canvas VM (a devcontainer, a Codespace) exposes its terminals by running
the **Bun connector** (`ensembleworks terminal connect`), which dials **one
outbound** WebSocket to the sync server's `/api/terminal/connect`. Connect
equals register, and the registration is **bound to the connector's resolved
identity** (§3.7). Browsers attach at `/api/terminal/relay?gateway=<id>` and
are **spliced** onto that connector's single WS as multiplexed channels
(a 4-byte channel-id prefix on binary output, JSON `relay-*` control
frames); `/api/terminal/list` enumerates the live gateways for the shape's
picker. The connector runs the same `canvasTmuxSpawnSpec` tmux substrate, so
a remote box's terminals behave identically to local ones. This Bun
connector is the instance; the earlier Go gateway (`gateway-go`) is
superseded and retires at the #8 cutover.

**Contract — survival:** with zero attached clients the pty (and its tmux
session) **stays alive** by design; closing every browser must not kill
the session. Reconnect re-runs `tmux new-session -A` and reattaches.
Anyone on the box can `ssh` in and `tmux attach -t canvas-<id>` to the
same session — the browser is just another door.

**Contract — scrollback:** the gateway keeps a bounded (~256KB) ring
buffer of recent output per session so a freshly attached viewer gets an
immediate screen repaint without waiting for the terminal to emit.

**Contract — sizing:** the grid (cols/rows) is **authoritative on the
gateway**: one attached viewer resizing fans a `resize` message to all
others, and the PTY (hence the tmux session) is resized to match. All
viewers converge on one shared grid.

**Wire protocol (gateway WS, `/api/terminal/ws?session=&cols=&rows=`):**
- client → server (text JSON): `{type:'input',data}` | `{type:'resize',cols,rows}`
- server → client: terminal output as **binary** frames (raw bytes);
  control as text JSON `{type:'attached'|'resize'|'exit', ...}`.

The remote relay carries this same inner protocol wrapped per channel
(`relay-msg`), so a spliced browser can't tell it's on a remote gateway.

**HTTP surface:** `/api/terminal/health`; `/api/terminal/sessions` (list
live + detached tmux sessions); `DELETE /api/terminal/sessions/:id` (kill a
session, which kills the underlying tmux session).

### 3.3 Media plane (voice/video)

**Role:** carry peer-to-peer voice and video between browsers, plus a
subscribe-only door for the scribe bot. The VM hosts **no media server**
and needs no GPU; browsers connect to the hosted media plane directly.

**Current instance:** LiveKit Cloud (WebRTC SFU). The canvas sync server's
**av** plugin **only mints access tokens** (`GET /api/av/token`; member =
publish+subscribe; scribe = subscribe-only, can never publish) and can call
the media plane's room service to remove a participant (used by
`POST /api/av/kick`). The media plane is otherwise unmediated by the app
backend.

**Contract — identity coupling:** the participant identity minted into
the token *is* the canvas presence userId (stripped of any prefix), so a
video bubble, a cursor, and a transcript line all refer to the same
person.

**Contract — graceful absence:** when the media plane isn't configured
(no keys), the token endpoint returns `{enabled:false}` and the client
hides all A/V UI. The rest of the system works headlessly.

### 3.4 Spatial audio model (client-side)

**Role:** a remote teammate's voice volume is a function of the
canvas-space distance between *your viewport centre* and *their cursor*.
Full volume inside a huddle radius; linear falloff to a non-zero floor; a
"standup mode" override forces everyone to full volume regardless of
distance.

**Contract — client-side only:** spatial gain is a *client-side
attenuation* of the media stream, **not an access control**. The scribe
hears every track at full volume regardless of canvas distance — huddle
conversations still land in the transcript (kept separable by the spatial
frame stamp, §5.2).

**Parameters:** huddle radius (page units), falloff end, floor gain —
client-side constants, not server state.

### 3.5 Scribe bot (the transcriber)

**Role:** join the room's media session with a subscribe-only token,
split each participant's audio track into utterances, transcribe each
utterance with a hosted STT service, and `POST` the text to the canvas
sync server's transcript endpoint. Deliberately **visible** in the
participant list (the room should know it's being transcribed).

**Current instance:** a Bun process (compiled to a single binary) using the
LiveKit RTC SDK; per participant an `AudioStream` (resampled to 16kHz mono)
→ an **energy-VAD segmenter** (utterance splitting) → a **WAV/PCM-16
encoder** → a call to an OpenAI-compatible STT endpoint (Groq Whisper by
default; any OpenAI-compatible STT works via `STT_URL`). It `POST`s each
line to `/api/scribe/transcript`. (Under Bun the RTC SDK's `captureFrame`
needed a copy of `Int16Array` subarray views, which the binary applies.)

**Contract — per-speaker ordering:** STT calls are chained *per
participant* (a slow transcription can't reorder one speaker's
utterances); different speakers transcribe concurrently.

**Contract — attribution:** no diarization is needed — the media plane
gives one track per participant, and the participant identity *is* the
canvas presence userId, so every line arrives pre-attributed. The server
then stamps it with the speaker's live cursor + nearest frame (§5.2).

**Contract — restart:** on disconnect from the media plane the scribe
exits and is restarted by its process supervisor.

### 3.6 Canvas API (agents on the canvas)

**Role:** let on-VM agents (and anything on the box) read and write the
canvas over HTTP, without a browser. The agent isn't blind: it can see
what teammates have placed in a frame, then report back. There is also a
CLI so agents and shells can use the same surface.

**Current instance:** the `ensembleworks` CLI (a compiled Bun binary). It is
**manifest-rendered**: each `<group> <verb>` (e.g. `ensembleworks canvas
sticky`, `ensembleworks canvas frame`, `ensembleworks terminal status`) maps
to a tool in the manifest fetched from `GET /api/tools`, so the CLI's verbs,
flags, and validation track the server's contracts rather than being
hand-coded. A few verbs are native (`terminal connect`, `canvas
pull-images`, `auth`, `version`); a trusted extension dir can add
`ensembleworks-<group>` sub-commands. This replaces the earlier `bin/canvas`
wrapper, which retires at the #8 cutover.

**Write surface:**
- flip a status light on a terminal shape (`working|needs-you|done|idle`),
- post an advice sticky (optionally parented to a frame by fuzzy name,
  optionally `--author`-tagged so agent notes are visually distinct),
- create/update/delete diagram shapes — `geo`, `text`, `note`, `arrow`
  (arrows take `fromId`/`toId` and get real bindings so they follow nodes
  when humans drag them),
- inject a transcript line by hand (for demos/testing).

**Read surface:**
- list every frame + child counts,
- read a frame's stickies/text/images/embeds (images resolved to their
  `/uploads` URLs; a `pull-images` helper downloads them so a multimodal
  agent can actually open the files),
- poll the transcript tail (chain with the returned `now`).

**Contract — frame matching:** frame args match the first frame whose name
*contains* the value, case-insensitively.

**Contract — proximity ordering:** the read endpoints sort results by
nearness to a connected teammate's live cursor (nearest first, each item
tagged with `dist`), *when* a browser tab is open. Presence is ephemeral
(cursor + current page), so with nobody connected results fall back to
plain document order and `sortedBy` is `null`. This is a best-effort
overlay on the read side, not stored state.

### 3.7 Identity & access (the auth boundary)

**Role:** the access gateway in front of the tunnel is the **only auth
boundary**. It authenticates every user (email one-time PIN or team SSO)
and injects a verified identity into each origin request: a header with
the verified email, plus a signed JWT carrying the same claims. The app
backend turns that into an `AccessIdentity`.

**Current instance:** Cloudflare Access in front of a Cloudflare Tunnel;
the email header is `Cf-Access-Authenticated-User-Email` and the JWT is
`Cf-Access-Jwt-Assertion`, verified against the team's JWKS.

**Contract — three modes by configuration:** the switch is a single boolean,
`accessVerificationEnabled()` (both `CF_ACCESS_TEAM_DOMAIN` and
`CF_ACCESS_AUD` set); the server logs which posture it booted in.
1. **verified** — team domain + audience configured → the JWT's
   signature/aud/exp is verified against the team's JWKS. A forged header is
   rejected. This is the production posture.
2. **header-trust** — neither configured → trust the email header. Safe
   *only because* the box has no inbound ports and is reachable only via
   the tunnel (the gateway overwrites that header, so nothing can forge
   it). This is the default until verification is configured.
3. **dev** — no access headers at all (local / port-forwarded) → fall back
   to a dev identity env var, else null.

**Contract — the app-side identity plane.** The injected identity is no
longer just captured-for-attribution; the app backend resolves every caller
into a small **Whoami envelope** (`GET /api/whoami`) — `human` (CF Access
email/SSO), `bot` (a CF Access **service token**, keyed by its
`common_name` and mapped to an identity + write-scope in a
`service-tokens.toml`), or `anonymous`. Three things read that resolution:
- **Write-scope guard** — an app-wide middleware that 403s a **read-only**
  service token on any mutating request; humans, read-write tokens, and
  anonymous callers pass untouched (a no-op unless a read-only token is
  configured).
- **Attribution stamping** — canvas content writes (sticky/shape/roadmap)
  are stamped **server-side**: a credentialed caller's identity becomes the
  trusted structured `meta.author` (a voluntary `author` in the body is
  ignored), while an anonymous caller's `author` is a cosmetic badge only,
  never structured — the server always wins, so `meta.author` can't be
  forged.
- **Gateway-owner binding** — a remote terminal connector's registration is
  bound to `resolveGatewayOwner(headers)`: on a verified instance an
  anonymous/dev connect is **rejected**, and a gateway id already owned by a
  different identity can't be hijacked (§3.2).

**Why it matters:** the verified email is what gets matched to a git
committer identity for `Co-authored-by` attribution (§6.3). The terminal
gateway is interactive shell access as the shared OS user, so the access
policy in front of the tunnel is what keeps the terminal routes from being
an open shell. **Explicit seam — remote terminals are team-wide.** The
gateway-owner binding governs who may *register* a gateway, not who may
*attach*: `/api/terminal/list` and `/api/terminal/relay` are unfiltered, so
any authenticated teammate who knows a `gatewayId`+`sessionId` can attach to
any terminal. That is acceptable for one trusted team behind the access
gateway; a per-identity attach check would be a future slice.

### 3.8 VM pressure monitor

**Role:** a single server-side reading of how loaded the shared box is.
Because every terminal, the sync server, and the scribe all run on one
VM, "load" is **global, not per-client** — one server reading is the
source of truth the whole room sees.

**Current instance:** plain reads of `/proc` and `/sys`, zero deps. CPU:
load-1 / cores + a PSI "some" avg10 stall fraction. Memory: read from the
**cgroup slice** (the unit that actually gets OOM-killed), not host RAM —
`memory.current` vs `memory.max`/`memory.high`, plus the slice's
`memory.pressure`. Falls back to host memory off cgroup-v2. A 2s read
cache so a roomful of pollers don't each re-stat the same files.

**Contract:** surfaced as part of the session pulse (§6.4) so the room
sees one shared pressure reading.

---

## 4. Data model

### 4.1 The canvas document (spatial state)

A CRDT-replicated document per room. Standard canvas primitives: `geo`,
`text`, `note`, `image`, `arrow`, `frame`, plus two **custom shape types**
that carry only references (never content):

- **`terminal`** — props: `w`, `h`, `sessionId`, `title`, optional
  `status`. The `sessionId` is the handle into the terminal gateway (the
  tmux session name suffix). No bytes here.
- **`iframe`** — props: `w`, `h`, `url`, `title`. The `url` is what the
  client renders; for a dev server it's a same-origin `/dev/{port}` URL.

Shapes carry `parentId` (a frame or the page), an `index` for ordering,
and page-relative `x`/`y`. Arrows carry bindings (`fromId`/`toId`) so they
follow nodes when dragged. The schema is shared between client and server
so the server can validate and migrate records. Assets (dropped images)
are stored out-of-band (§4.3) and referenced by `assetId`.

### 4.2 The transcript (voice → text)

**One append-only JSONL file per room** under `DATA_DIR/transcripts/`.
Each line is a complete record (greppable, crash-safe):

```
{ id, t (server ms-epoch), identity, name, text,
  page, cursor:{x,y}, frame:{name,dist} }
```

`identity` = the speaker's canvas presence userId. `page`, `cursor`, and
`frame` are the **spatial stamp** — computed by the speaker's *own browser*
from the CRDT replica it already holds and published on its presence record
(`meta.stamp`); the server copies it onto the entry at append time (on `POST
/api/scribe/transcript`) when the speaker has a browser tab open (null
otherwise). `frame` is the frame
containing (dist 0) or nearest to the point the speaker was at — that
*place* is what turns a flat transcript into minutes-with-places and
threaded conversation maps. (Computing the stamp client-side keeps the
frame geometry off the server's cursor-serving event loop — see §6.6.)

### 4.3 Uploaded assets

Raw bytes stored on disk under `DATA_DIR/uploads/<id>`; the canvas
document references them by `assetId`. Written via `PUT /uploads/:id`,
served via `GET /uploads/:id`. Image URLs surfaced to agents as
`/uploads/<id>`.

### 4.4 Sessions & presence (ephemeral)

- **Sync sessions:** per (room, user) a *set* of WS sessionIds (one user
  can have multiple tabs). Tracked in-memory only.
- **Presence:** cursor + current page + camera + screen bounds, ephemeral
  in the CRDT presence channel; only meaningful while a browser tab is
  connected. Used for proximity ordering, transcript spatial stamping,
  and the participant list.
- **Captured access identities:** per connected user, the verified access
  identity (email) is captured at WS upgrade and held in-memory, cleared
  when the user's last session closes — so it only ever covers
  currently-connected people.

### 4.5 Data layout on disk

Everything lives under one `DATA_DIR` (default
`~/.local/share/ensembleworks`):

```
DATA_DIR/
  rooms/<room>.sqlite        # canvas document, one file per room
  transcripts/<room>.jsonl   # voice transcript, one file per room
  uploads/<id>               # dropped-image asset bytes
```

So one backup of `DATA_DIR` (plus the code and the secrets, §7.2) captures
all session state for the instance.

---

## 5. Key behaviors (cross-component data flows)

### 5.1 A terminal byte round-trip

1. Browser opens a terminal shape, reads `sessionId` from its props, opens
   a WS with `?session=<id>&cols&rows` — to `/api/terminal/ws` for a local
   session, or `/api/terminal/relay?gateway=<id>` to be spliced onto a
   remote connector (§3.2).
2. Gateway runs (or reattaches) one pty → `tmux new-session -A -s
   canvas-<id>`. Sends `attached` + current grid size + scrollback.
3. Keystrokes → `{type:'input',data}` → pty.write → tmux.
4. tmux output → pty.onData → **fanned out as binary frames to every
   attached WS**. Every viewer sees identical bytes.
5. A viewer drags a handle → `{type:'resize'}` → gateway resizes the pty
   (hence tmux) → broadcasts `resize` so all viewers converge.
6. Browser closes → its WS leaves the set; the pty and tmux session
   **stay alive**.

The canvas sync plane is uninvolved for the entire byte path; it only
holds the `terminal` shape with its `sessionId` reference.

### 5.2 A spoken utterance → a stamped transcript line

1. A teammate talks. Their browser publishes audio to the media plane.
2. The scribe (subscribe-only) receives their track, resamples to 16kHz
   mono, runs energy-VAD, accumulates an utterance.
3. On utterance close: encode WAV, call the hosted STT (chained per
   speaker so order is preserved), get text.
4. `POST /api/scribe/transcript` with the speaker's media identity (==
   canvas userId) + name + text.
5. The canvas server looks up the speaker's **live presence** and copies
   the **spatial stamp their browser already computed** there (`meta.stamp`
   = `{at, frame}`). The client is what locates them — by their **mouse
   cursor when it's inside a frame** (they're pointing at something),
   **otherwise by their viewport centre** (what they're looking at) —
   recording that same point so `at` and `frame` always agree, and the
   frame containing (dist 0) or nearest to it. The server does **no
   geometry** on this path; a connected tab that published no stamp (an
   old bundle) yields a null cursor/frame, self-healing on reload.
6. Appends one JSONL line: speaker + text + page + cursor + frame.
7. A minutes/conversation-map agent polls `GET /api/scribe/transcript?since=`,
   gets the new line, and maintains its artifacts.

### 5.3 An agent reads a frame, works, reports back

1. Agent runs `ensembleworks canvas frame <name>` → `GET
   /api/canvas/frame?name=`. Server fuzzy-matches the frame, returns
   stickies/text/images (as `/uploads` URLs)/terminals/iframes,
   **proximity-sorted** to the nearest live cursor. Agent takes its brief
   (possibly `ensembleworks canvas pull-images` to actually see images).
2. Agent does its work in a canvas terminal.
3. Agent reports: `ensembleworks canvas sticky … --frame advice`
   (server-stamped by the caller's identity, §3.7; agent-tagged, distinct
   colour) and/or `ensembleworks terminal status <session> needs-you` so the
   drafting table can see at a glance which agents want attention.

### 5.4 Kicking a user

`POST /api/av/kick` disconnects one user from **both** planes: it closes all
their canvas sync sessions (sending a `kicked` custom message the client
surfaces) *and* removes them from the media plane via the media room
service. One endpoint, both planes, by identity.

### 5.5 Proximity-sorted reads

`/api/canvas/frames` and `/api/canvas/frame` pick the **most-recently-active cursor** on
the relevant page and sort that page's items by distance to the point that
teammate is at — their client-computed **stamp point** (`meta.stamp.at`,
what they're pointing at / looking at) when present, else their raw cursor.
Nearest first, each tagged with a rounded `dist`; items on other pages
trail in document order. The response carries a `sortedBy` block (who,
which page, the point ranked by) so callers know how to interpret the
order — or `null` when no tab is connected and document order was used.
This is a read-side overlay on ephemeral presence, never stored. (Only the
*sort point* comes from the client; the server still walks the page to
build the response — see §6.6.)

---

## 6. Cross-cutting concerns

### 6.1 Latency & the session pulse

One heartbeat endpoint (`POST /api/av/pulse`) carries **two** features at
once: each client measures the round-trip of its *previous* pulse and
reports it; the
server records per-user RTT, prunes stale samples, and returns the live
per-user latency map **plus** the shared VM-pressure reading. One client
timer, one endpoint, no extra storage. Stale samples (~2.5× the poll
interval) drop off so the map only reflects live participants.

### 6.2 Low-latency tuning

Both the canvas sync WS and the terminal gateway WS disable TCP Nagle
(`setNoDelay`) on upgrade, because both carry streams of tiny frames
(cursor moves, incremental edits, single keystrokes / one-char echoes)
that Nagle would otherwise park ~40ms to coalesce — most noticeable for
far-region users on top of raw network RTT.

### 6.3 Co-author attribution

The verified access identity (email) captured at WS upgrade is joined
with live presence to produce a participant list (`/api/participants`).
With `?page=` it's filtered to one canvas page — the **co-author rule**:
present in the same room *and* on the same page. A commit tool reads this
to build `Co-authored-by` trailers from the GitHub-matching email.

### 6.4 Resilience & process supervision

- Canvas rooms survive process restarts (transactional SQLite per room).
- Terminal sessions survive gateway/browser restarts (tmux is the
  substrate; the pty is a reattachable client).
- The scribe exits on media-plane disconnect and is restarted by its
  supervisor.
- All services run under a process supervisor in **watch mode** during
  dogfooding (file-watch → restart that process only). Client edits
  hot-swap via HMR; server-side edits briefly drop live connections
  (canvases reconnect, gateway terminals reset), so they're made during a
  lull.

### 6.5 One shared OS user

There is **one shared OS user** for the whole mob; the named people you
see are app-level only (a name in browser storage), not OS accounts.
Everything that user owns lives under its home: the editable code, all
session state (`DATA_DIR`), and the secrets. One backup of the home
directory captures the whole instance. (A later hardening pass splits the
human and service identities and makes the instance un-editable from
itself; the single-user watch/HMR setup is a deliberate dogfooding-stage
choice.)

---

### 6.6 Performance characteristics

The two-planes split (§2.1) produces a counterintuitive profile: **the
VM is the latency-critical hot spot *despite* being media-light.** The
two things users perceive as a "laggy room" — remote cursor smoothness
and terminal typing feel — both terminate on the VM, while the heaviest
bandwidth thing in the system (audio/video) bypasses the VM entirely
(browser↔hosted SFU). So the VM's CPU/RAM budget is small in absolute
terms but sits *directly on the interactive path* — which is why the
VM-pressure monitor (§3.8) is a single shared reading the whole room
sees, and why it reads the **cgroup slice** (the unit that actually gets
OOM-killed), not host RAM.

**Rankings (on the VM unless noted):**

| Dimension | Most sensitive component |
|---|---|
| Network latency | 1. canvas cursor sync · 2. terminal echo · (media off-VM) |
| CPU (VM) | 1. canvas sync server (read-endpoint proximity/CRDT) · 2. tmux rendering · 3. scribe VAD · (STT + transcript-stamp geometry offloaded) |
| CPU (browser) | 1. video encode/decode · 2. tldraw render (incl. own spatial-stamp compute) · 3. terminal-emulator render |
| RAM (VM) | 1. canvas sync server (all rooms in memory) · 2. tmux scrollback · 3. scribe audio buffers |
| Bandwidth (VM) | 1. terminal output fan-out · 2. scribe audio uplink to STT · 3. canvas sync cursors/edits · (media ≈ 0) |
| Bandwidth (browser) | 1. media (video) · 2. terminal downlink · 3. canvas sync |

**Network latency — the real sensitivity.** Two streams are
latency-critical and *both end on the VM*: remote cursor sync (a
high-rate stream of tiny frames from every participant to every
participant; Nagle-off, §6.2, because ~40ms coalescing per frame would
stutter cursors), and terminal echo (keystroke-up → echo-down; same
Nagle-off). Both mean **VM load degrades the interactive feel for
everyone** — any scheduling jitter on the sync server (CPU contention, a
slow synchronous read endpoint blocking the event loop) shows up as
cursor stutter. Everything else is latency-tolerant: conversational
audio/video latency is the hosted SFU's problem, not the VM's; the scribe
STT pipeline is async and fine with seconds of latency; agent reads and
transcript polls are agent-paced. **Implication for alternative
implementations:** moving cursor sync or terminal echo off the VM's
synchronous path (or off the VM entirely — e.g. a regionally-placed sync
server / edge terminal substrate) is the single biggest latency win
available; in the current single-VM topology one far-region user pays
full RTT to the box for both.

**CPU — the non-obvious cost is proximity math.** The canvas sync server
is the main VM CPU consumer, and it scales with **canvas size × access
frequency**, not user count directly. The remaining proximity logic
(parent walks up to 50 deep, `byProximity` sorts) runs synchronously on
the read endpoints `/api/canvas/frames` and `/api/canvas/frame` (§5.5) — a steady-state
drain that competes with the latency-critical cursor path for the same
event loop. Note what is **no longer** on this path: the frame-matching
geometry (`frameAtPoint`/viewport-centre) has moved to the browsers, which
each compute their own spatial stamp from the CRDT replica they already
hold and publish it on presence (§4.2, §5.2). So `POST /api/scribe/transcript`
now does *zero* document work — a per-utterance snapshot walk that used to
compete with cursor sync is gone — and the read endpoints consume a
client-provided sort point rather than recomputing it. CRDT merge itself
is comparatively light. tmux
rendering (escape parsing + grid render, proportional to output volume;
a noisy build is the spike) is real CPU but lives in the tmux processes.
The scribe is *light* on the VM because **STT is offloaded** — VAD is
energy thresholding on 16kHz mono, WAV encoding is trivial, the expensive
transcription happens at the hosted STT endpoint (the VM needs no GPU).
Video encode/decode is the biggest CPU sink in the system but it's on
the **browsers** and the hosted SFU, not the VM.

**RAM — everything in memory.** The canvas sync server holds **every
room fully in memory** (one in-process room object each; SQLite is only
the durable backing), scaling with #rooms × canvas-document-size plus
the in-memory presence/identity/latency maps (cleared on disconnect, so
bounded by live participants) — and it's the process that gets
OOM-killed when the cgroup `memory.max` is blown. tmux scrollback is
per-session and can be large (tmux's own history limit, independent of
the gateway's capped 256KB fan-out buffer); many terminals × deep
history is the second RAM consumer. Scribe audio buffers accumulate one
utterance per participant up to VAD close (modest; scales with utterance
length × participants).

**Bandwidth — media ≈ 0 on the VM.** Audio/video flows browser↔hosted
SFU directly; the VM's only media-plane traffic is token minting. So the
VM's biggest bandwidth item is **terminal output fan-out, which
multiplies by viewer count** — one terminal's output is copied to every
attached WS (§5.1), so a mob of N watching a busy terminal = N× the
downlink from the VM for that terminal's output. The scribe audio uplink
to the hosted STT is second (~32KB/s per speaking participant at 16kHz
mono 16-bit, originating on the VM but destined off it). Canvas sync is
modest in bytes but high in *message rate* — bandwidth is rarely the
constraint there, latency/scheduling is. On the **browser**, media
(especially video) dominates, then terminal downlink, then sync.

**Two scaling cliffs for alternative implementations:**

1. **Canvas size × read frequency** on sync-server CPU. The remaining
   proximity math is O(shapes)–O(shapes×frames) per `/api/canvas/frames` /
   `/api/canvas/frame` read and runs synchronously in the cursor-serving process;
   as the canvas grows and agent activity rises it competes with cursor
sync. This cliff is now **half-closed**: the per-utterance
   `POST /api/scribe/transcript` walk that used to sit on it has been eliminated
   by computing the spatial stamp in each browser and publishing it on
   presence (§4.2, §5.2), and the reads now consume a client-provided sort
   point. What's left is the response-building walk on the two read
   endpoints; a precomputed spatial index, or moving reads off the
   cursor-serving process, would close the rest.
2. **Terminal fan-out × viewers** on VM bandwidth. Fan-out is O(viewers)
   per terminal per output burst — for a large mob all watching one busy
   terminal, that's the bandwidth (and some CPU) cost that grows with
   team size rather than with the workload. A single shared broadcast
   stream (e.g. a fan-out at the SFU/edge rather than N copies from the
   VM) would change this.

---

## 7. Deployment & operations

### 7.1 Single-instance topology

One VM, no inbound ports. A reverse-tunnel client dials out; an access
gateway sits in front of the public hostname. A reverse proxy on `:8080`
does the `/dev/{port}` same-origin proxy, routes the local terminal plane
(`/api/terminal/{health,sessions,ws}`) to the terminal gateway process, and
forwards everything else (including the terminal relay plane) to the app
server. TLS terminates at the edge; the reverse proxy needs no certs.

**Artifacts & deploy.** The server, terminal gateway, transcriber, and CLI
are compiled Bun single-file binaries (the server and gateway are the two
sub-commands of one `ensembleworks-server sync|term` binary). Deploy is
**fetch-verify-swap** (`deploy/deploy.sh <target> <version>`): download the
tagged release artifacts to `releases/<version>`, checksum-verify, run a
hermetic pre-swap boot-check of the fetched server + transcriber, stamp a
posture-era marker, swap the `current` symlink, restart the units, and prune
to the last few releases (rollback = re-swap an older still-present release).
The one-shot `deploy/cutover.sh` wraps a data-load check + `DATA_DIR` backup
+ env reseed around a sanctioned cross-era `deploy.sh`.

### 7.2 Secrets, segregated by service

Secrets live in env files under `~/.config/ensembleworks/`, fed to their
respective services:
- **media/env** → the sync server (media plane URL + API key/secret for
  token minting).
- **stt/env** → the scribe (STT URL + model + API key).
- **github-app/env** → a GitHub-app token helper.
- **term/env** → env vars sourced into every interactive shell spawned in
  canvas terminals (e.g. agent API keys), so CLI tools launched from
  canvas terminals see them. Editing `term.env` needs no gateway restart
  — a new terminal picks it up.

Because the mob can edit the code the services run, the media/STT keys
are effectively readable by anyone with a terminal — inherent to a
self-editing room, so only admit people you'd trust with those keys.

### 7.3 Process units

One supervisor unit each for: the sync server (`ensembleworks-server sync`,
which also serves the static build in production — no separate app-server
unit in hardened mode), the terminal gateway (`ensembleworks-server term`),
and (optional) the scribe binary. A tight sudoers rule grants the shared
user `restart|start|stop` on these units only (no root shell), for
dependency changes or a wedged unit.

### 7.4 The terminal substrate config

Canvas terminals run an opinionated terminal-multiplexer config (prefix
key, vi copy-mode with OSC52 clipboard passthrough to the *browser*,
mouse-on, a top status bar, a light-background colour hint for apps that
can't query the background through the multiplexer). The look is a named
"paper" palette shared by the canvas shape chrome, the terminal emulator
palette, and the multiplexer theme. The config applies when the
multiplexer *server* starts; restyling a running server reloads it.

### 7.5 Dogfooding: editable from inside

The point of this stage is that the team can change the app *from a
running canvas terminal* and see it live. The units run in watch mode;
the shared OS user owns the code and edits it in place.

---

## 8. Swappable seams (where alternatives live)

This is the payoff of separating the planes. Each seam is a contract you
could re-implement without touching the others:

| Seam | Contract (abstract) | Current instance | Alternative space |
|---|---|---|---|
| **Canvas spatial store** | a CRDT-synced, per-room, durably-persisted document of shapes + presence, with a shared schema | tldraw sync + per-room SQLite | any CRDT/OT doc store; Yjs, Automerge, a Durable-Object-style backend |
| **Terminal substrate** | a durable PTY-backed multiplexer session, attachable from browser and plain SSH, with fan-out + bounded scrollback | tmux + a `Bun.spawn` PTY wrapper; local gateway process + a Bun relay connector for remote boxes | any persistent PTY + multiplexer (zellij, abduco); a k8s-container-per-terminal; see `docs/distributed-terminals-design.md` |
| **Media plane** | hosted WebRTC SFU carrying peer audio/video + a subscribe-only door | LiveKit Cloud | any WebRTC SFU / SFU-less mesh; a self-hosted LiveKit; see `docs/livekit-replacement-plan.md` |
| **STT** | an OpenAI-compatible transcription endpoint (audio in, text out) | Groq Whisper (hosted) | any OpenAI-compatible STT; local Whisper; a different VAD/segmenter |
| **Access boundary** | an edge gateway authenticating users and injecting a verified identity (header + JWT) | Cloudflare Access + Tunnel | any zero-trust access gateway (Tailscale Funnel, Oauth2 Proxy, mTLS) |
| **Reverse proxy** | same-origin `/dev/{port}` proxy + default route to app | Caddy | any reverse proxy (nginx, traefik) |
| **App backend / HTTP surface** | a thin kernel (rooms/WS/identity/uploads/static + reserved routes) + per-plugin `/api/<plugin>/…` feature routers | Bun + Express + ws, compiled to `ensembleworks-server sync` | any HTTP/WS server; the route contracts in §3, §5 are the spec |
| **Client app** | a canvas renderer with custom terminal/iframe shapes + spatial audio + media client | React + tldraw + LiveKit client + xterm.js | any canvas framework + terminal emulator + WebRTC client |
| **Scribe** | subscribe-only media client → VAD → STT → POST transcript | Bun (compiled binary) + LiveKit RTC SDK | any media client + STT; the per-speaker-ordering + visible-participant contracts in §3.5 are the spec |

The two **non-seams** to be aware of: the **identity coupling** (canvas
presence userId == media-plane identity == transcript speaker identity)
threads through all three planes and any swap must preserve it; and the
**two-planes separation** itself (spatial state vs content bytes) is a
design invariant, not something to collapse — putting terminal bytes or
media on the canvas sync channel would re-introduce exactly the
starvation the split avoids.

---

## 9. Glossary

- **Room** — one named canvas document + its terminals + its media room.
  The URL path `/sync/<room>` selects it; `?room=` makes a side room.
- **Canvas plane** — the CRDT-synced spatial state (shapes, presence).
- **Content plane** — terminal bytes + media, on their own channels.
- **Session id** (terminal) — the handle in a `terminal` shape's props;
  the suffix of the tmux session name `canvas-<id>`.
- **Presence userId** — the stable id threading canvas cursors, media
  bubbles, and transcript attribution.
- **Spatial stamp** — the `{page, cursor, frame}` a transcript line gets
  at append time from the speaker's live presence.
- **Huddle radius** — page-units distance within which a voice is at full
  volume.
- **Standup mode** — override forcing all voices to full volume.
- **DATA_DIR** — root of all per-instance durable state (rooms, transcripts,
  uploads).
- **Access identity** — the verified email (and name) the access gateway
  injects; used for co-author attribution.
