# file-viewer canvas control

A portal onto a file in the agent user's home directory, rendered on the canvas.
An agent working in a canvas terminal writes an HTML or Markdown document to
disk and runs `canvas file open <path>`; a `file-viewer` control appears on the
canvas rendering that file in a sandboxed iframe. Relative references inside
the document (CSS, images, sibling JSON) resolve against the real directory and
just work — nothing is copied or pushed. The file on disk is the document.

v1 also includes **scroll-follow** (rung 1 of the shared-viewing ladder): a
participant can toggle "Present" on a control and everyone else's iframe
tracks their scroll position, while keeping native per-user rendering,
selection and zoom.

## Background

Agents already produce rich HTML reports/plans; today the only way to see one
on the canvas is the dev-server `iframe` shape (`client/src/iframe/`), which
requires the agent to hand-run a web server and gives no markdown rendering, no
refresh fan-out, and no durable service. The roadmap control
(`client/src/roadmap/`) established the data-plane pattern this feature reuses:
content fetched over HTTP, a synced `rev` prop bumped server-side so every open
client refetches.

Two constraints shape the design:

- **Privilege separation (prod).** Terminals run as the sandbox user
  `ensembleworks-agent`, whose home is deliberately unreadable by the app user
  running the sync server (`server/src/terminal-gateway.ts`). So the sync
  server cannot read the files directly; a file server must *run as* the agent
  user, launched the same way terminals are (narrow sudoers rule + launcher).
- **Remote gateways (near future).** Terminals on remote VMs join via a
  reverse tunnel (`/api/terminal/connect`, `server/src/gateway-registry.ts`)
  and terminal shapes carry an optional `gateway` prop. v1 of the file-viewer
  is **local-only but remote-shaped**: the shape carries the same optional
  `gateway` prop, all iframe traffic goes through one canvas-server route that
  can later grow a relay arm, and the CLI reads its gateway id from the
  environment. The actual remote file transport is deferred to the connector
  engine work (plugin-architecture sub-project #5).

## Decisions (ratified during brainstorm)

- **Portal, not push** — the control shows whatever is on disk when the iframe
  loads; no server-side content store.
- **Live on reload** — a synced `rev` prop is the "everyone look again" nudge:
  bumped by `canvas file refresh` or the control's refresh button; a `rev`
  change reloads the iframe via cache-buster query param.
- **v1 renders HTML + Markdown** — anything else gets a styled
  "unsupported type" page. Markdown is converted to styled HTML server-side.
- **Per-user interaction, plus scroll-follow in v1** — inputs/selection inside
  the iframe are per-user (default iframe behaviour), but v1 ships the
  postMessage scroll bridge: an explicit presenter broadcasts scroll position
  and other clients follow (`postMessage` works from a sandboxed opaque-origin
  iframe). Form-sync and DOM mirroring stay deferred.
- **Sandbox without `allow-same-origin`** — served documents run in an opaque
  origin: no cookies/localStorage, no credentialed calls to `/api/*`, so
  agent-generated JS cannot ride the viewer's CF Access session. Trade-off
  accepted: unguarded `localStorage` access in a document throws.
- **Naming** — route `/files/*`, shape type `file-viewer`, stack service
  `file-server`, CLI verbs `ensembleworks file …` (a top-level verb group —
  ratified: documents are their own plane, not a canvas-shapes operation).
  (`/docs/` rejected: too easy to confuse with repos' own `docs/` folders
  appearing inside the path.)

## Components

### 1. `file-server` — new stack service, port 8791

A small Bun static server (`server/src/file-server.ts` — a second entry point
in the server workspace, the same arrangement as `terminal-gateway.ts`) that:

- serves the invoking user's `$HOME` read-only, **raw bytes only** (correct
  `Content-Type`, no directory listings in v1 — a request for a directory 404s);
- rejects any resolved path that escapes `$HOME` (symlink-resolved, tested);
- sends `Access-Control-Allow-Origin: *` (documents fetch siblings from an
  opaque origin) and `Cache-Control: no-store`;
- binds to localhost only.

Dev: registered in the tmux stack (`bin/dev-lib.mjs` service list) running as
the developer. Prod: a systemd unit modelled on
`deploy/systemd/prod/ensembleworks-term.service`, launched as
`ensembleworks-agent` via the existing launcher/sudoers pattern.

> **Implementation deviation (ratified at review):** the prod unit uses
> `User=ensembleworks-agent` directly — systemd performs the privilege drop, so
> no NOPASSWD sudoers entry or launcher binary is added at all (strictly
> narrower than the term pattern; over-satisfies R2). Because the agent user
> cannot read `@APP_HOME@/current` (700), `deploy.sh` installs a world-readable
> copy of the compiled server binary at `/usr/local/bin/ensembleworks-server`
> (no baked secrets — everything is runtime env) and the unit's `ExecStart`
> points there. `ew_boot_check` gates the `files` arm pre-swap like sync/term.

### 2. `/files/*` route on the sync server (:8788)

The single routing layer the iframe talks to (`server/src/features/files.ts`,
mounted in `server/src/app.ts`; dev also needs a Vite proxy entry for
`/files`). Behaviour:

- `GET /files/<path>?rev=N[&gateway=<id>]` — v1 ignores `gateway` beyond
  validating it is absent/empty (501 "remote files not yet supported" if set);
  later this is where relay forwarding lands.
- Proxies the path to the local `file-server` (:8791).
- `.md` responses are transformed to styled HTML **here** (marked/micromark +
  a small inline stylesheet), so the file-server — and the future remote
  connector — stay dumb byte readers. Relative refs inside rendered markdown
  still resolve because the document's base URL stays under `/files/<dir>/`.
- `.html`/`.htm` and markdown pass through/render; **assets referenced by
  documents** (css/js/images/json/fonts) pass through raw; any other extension
  requested *as the top-level document* gets the styled "unsupported type"
  page. (Simplest v1 discriminator: render/pass-through by extension;
  assets are just extensions the iframe requests as subresources.)
- File missing / file-server down → a small styled error page (the control
  shows it rather than a broken iframe).
- Sits behind CF Access like every other :8788 route; `no-store` caching.
- **Injects the scroll-bridge helper** into every top-level HTML document it
  serves (and into rendered markdown): a small inline script appended before
  `</body>` (or at end of document — injection must not break documents
  without a `</body>` tag). See §5.

### 3. `file-viewer` shape (`client/src/file-viewer/`)

A sibling of the existing iframe shape, following the plugin pattern
(`plugin.tsx`, `FileViewerShapeUtil.tsx` extending `BaseBoxShapeUtil`):

- Props in `contracts/src/shapes.ts`:

  ```ts
  export const fileViewerShapeProps = {
  	w: T.number,
  	h: T.number,
  	// Path relative to the agent user's home, e.g. "my-repo/docs/report.html".
  	path: T.string,
  	title: T.string,
  	// Bumped by POST /api/canvas/file-viewer refresh so every client reloads.
  	rev: T.number.optional(),
  	// Remote gateway id (future); optional so existing rooms need no migration.
  	gateway: T.string.optional(),
  }
  ```

- Renders a header bar (filename + refresh button + **Present toggle**) above
  `<iframe src={`/files/${path}?rev=${rev ?? 0}`} sandbox="allow-scripts allow-forms allow-downloads">`
  — deliberately **no `allow-same-origin`**.
- `rev` change → iframe reloads (the `src` changes; no extra effort needed).
  The header's refresh button bumps the synced `rev` via `editor.updateShape`
  — "look again" is a shared action, same semantics as `canvas file refresh`.
- Interaction gating copied from the iframe/roadmap shapes: double-click to
  interact, `pointerEvents` toggled on `isEditing`, wheel/pointer
  `stopPropagation` while editing. All per-user state in React state, never in
  props.
- Toolbar item for humans: prompts for a path (like `createDevServerShape.ts`).

### 4. CLI + endpoint

New ToolDef pair in `contracts/src/tools/` and feature router
`server/src/features/file-viewer.ts`:

- `POST /api/canvas/file-viewer` with `op: 'open' | 'refresh'`:
  - **open** `{ room, path, title?, frame?, gateway? }` — creates the shape
    server-side (placement/attribution modelled on `sticky.ts`), normalising
    the path: strips a leading `~/` or the agent home prefix; rejects absolute
    paths outside home and any `..`. Returns `{ ok, id }`.
  - **refresh** `{ room, path, gateway? }` — bumps `rev` on every `file-viewer`
    shape in the room whose `path` (and `gateway`) match, via
    `room.updateStore` (the roadmap rev fan-out pattern). Returns
    `{ ok, updated: n }`.
- CLI subcommands — a **top-level `file` verb group** on the `ensembleworks`
  surface (ratified: it is a document plane, not a canvas-shapes operation;
  the #4 charter verb table gains `file`):
  - `ensembleworks file open <path> [--frame --title]`
  - `ensembleworks file refresh <path>`
  If v1 lands before the #4 CLI ships, the same commands go into `bin/canvas`
  as `canvas file …` interim aliases; the ToolDef + endpoint are the stable
  part either way. Both send `gateway: $ENSEMBLEWORKS_GATEWAY_ID` when that
  env var is set (the connector will export it into the tmux sessions it
  spawns; local sessions don't have it). The CLI resolves a relative `<path>`
  against `$PWD` and then home-relativises it, so
  `ensembleworks file open docs/report.html` works from inside a repo.
- Mutations respect the write-scope guard (`write-scope.ts`) like every other
  POST.

### 5. Scroll-follow bridge

Three cooperating pieces, all v1:

- **Helper script** (injected by the `/files/` route, §2): on load, posts
  `{ type: 'ew-file-viewer-ready' }` to the parent. Listens to window scroll,
  throttled to ~10Hz, and posts
  `{ type: 'ew-scroll', fraction }` where
  `fraction = scrollY / (scrollHeight − innerHeight)` (0 when the document
  doesn't scroll) — a fraction, not pixels, so different viewer sizes land in
  the same place. Listens for `{ type: 'ew-scroll-set', fraction }` from the
  parent and applies it, setting an internal flag so the resulting scroll
  event is not re-broadcast (echo suppression at the source).
- **Presenter state**: rides tldraw **presence**, not shape props — it must
  die with the presenter's session, never fossilise in the document. The
  presenting client stamps `{ fileViewerPresenter: <shapeId>, scrollFraction }`
  into its presence record's `meta`; followers watch presence for any peer
  presenting their shape id. Presence disappearing (tab closed, network drop)
  ends the presentation naturally. One presenter per shape; a second "Present"
  click steals the token (last-writer-wins — acceptable for a team room).
- **Shape component**: the Present toggle in the header. While presenting:
  relay `ew-scroll` messages from the iframe into presence meta. While a peer
  presents: apply their `scrollFraction` to the iframe via `ew-scroll-set`,
  and show a "Following <name> — stop" affordance in the header; "stop" sets a
  local opt-out (React state) until the presentation ends. The presenter's own
  manual refresh/rev reload re-applies the last fraction after the iframe's
  `ready` message.

**Plan-time verification (V1):** confirm the tldraw version in use supports
custom `meta` on `TLInstancePresence` and that it syncs through
`TLSocketRoom`. If it does not, fall back to the already-connected LiveKit
data channel (topic `file-viewer-scroll`) — same message shape, same
component logic; the transport is isolated behind one small module either way.

### 6. `publish-doc` agent skill (v1 deliverable)

A user-level Claude Code skill at `deploy/agent-home/.claude/skills/publish-doc/SKILL.md`,
installed into `${AGENT_HOME}/.claude/skills/` by `deploy/deploy.sh` (the same
mechanism that ships `AGENTS.md` / `.claude/CLAUDE.md`), so **every agent in
every repo** on a canvas box gets it. This is the feature's adoption surface —
demand was proven by an agent independently publishing a Cloudflare Pages
workaround skill (`lean-software-production/workshops#34`). Content:

- **When to use:** the user wants to see a rich document (report, plan,
  storyboard, mockup) — write it to a file in the home dir and
  `ensembleworks file open <path>`; iterate with `file refresh`. The
  **external publish route is retired**: do not publish team documents to
  public URLs; the one remaining alternative is a claude.ai Artifact when the
  audience is a private Claude workspace rather than the canvas room.
- **Authoring guidance:** standalone HTML skeleton with inline CSS
  (relative-path assets also work — the portal serves siblings);
  light+dark via `prefers-color-scheme`; **no unguarded `localStorage`/
  cookies** (opaque origin throws); prefer SVG charts over `<canvas>`
  (identical today, mirrors better when the rrweb rung lands); markdown is
  fine for prose-only documents.
- **Presenting:** tell the humans about the header's Present toggle for
  walkthroughs; `file refresh` after each significant edit so every viewer
  reloads.

## Error handling

| Failure | Behaviour |
| --- | --- |
| File does not exist / unreadable | `/files/` returns styled 404 page; control displays it |
| `file-server` down | `/files/` returns styled 502 page |
| Path escapes home (traversal/symlink) | file-server 403s; `/files/` styled error page |
| Unsupported top-level type | styled "unsupported type" page |
| `open` with bad path (`..`, absolute outside home) | 400 from the endpoint |
| `refresh` matching no shapes | `{ ok: true, updated: 0 }` (agent-visible, non-fatal) |
| `gateway` set on any request (v1) | 501 with clear message |

## Testing

- **Unit (file-server):** path traversal (`../`, encoded, symlink-escape)
  rejected; content-type mapping; directory request 404s.
- **Unit (route):** md→HTML transform (relative img/link preserved);
  unsupported-type page; error pages on 404/backend-down; `gateway` → 501.
- **Unit (endpoint):** open normalises paths and rejects bad ones; refresh
  bumps `rev` only on matching shapes (store-level, like existing feature
  tests).
- **Unit (bridge):** helper-script logic (fraction maths incl. the
  non-scrolling document, throttle, echo-suppression flag) extracted into a
  testable module; injection preserves documents with and without `</body>`.
- **Smoke:** write a file into the (dev) home → `canvas file open` → shape
  exists in room with expected props → `GET /files/<path>` returns rendered
  content **with the helper injected** → `canvas file refresh` → `rev` bumped.
- **Interaction (scroll-follow):** two headless-browser clients on one room
  (the `.claude/skills/debugging-roadmap-control/` pattern) — presenter
  scrolls, follower's iframe lands on the same fraction; follower "stop"
  opts out; presenter tab close ends following. This one IS a v1 gate —
  scroll-follow can't be meaningfully verified below the browser level.
- Whole-suite gates: `bun run typecheck`, `bun run test`, `bun run build`.
- The headless-browser pattern from `.claude/skills/debugging-roadmap-control/`
  is available if interaction bugs appear; not a v1 gate.

## Security posture

- The file-server exposes the agent home read-only to canvas users — the same
  visibility they already have via any canvas terminal (which runs as that
  user), behind the same CF Access edge. No new audience, no write path.
- Opaque-origin sandbox keeps arbitrary document JS away from canvas
  cookies/storage and credentialed `/api/*` calls.
- In dev (no privilege separation) the served home is the developer's own —
  acceptable for the same "terminals already expose it" reason, but worth a
  line in the README.

## Explicitly deferred

- **Remote file transport** — an HTTP-request channel over the gateway relay +
  file reads in the connector; lands with sub-project #5 (connector engine).
  v1 ships the `gateway` prop, the routing seam, and the env-var convention.
- **Shared viewing beyond scroll-follow** — rung 1 of the ladder
  (scroll-follow) ships in v1 (§5); the higher rungs stay deferred and reuse
  the same seams (script injection at the `/files/` route, the
  postMessage-friendly sandbox, the presenter concept). In fidelity-vs-cost
  order:
  2. **rrweb DOM mirror** — the presenter's iframe records (full DOM snapshot
     + MutationObserver deltas as JSON); viewers run the rrweb replayer, not
     the document, so there is no JS-divergence problem and framework-driven
     state mirrors for free. Server cost is JSON fan-out only (a small
     dedicated WS room; snapshots are too big for presence). Weak spots:
     `<canvas>`/WebGL capture is partial (nudge agents toward SVG charts),
     viewers are followers (drive = handoff, i.e. a new recorder). Subsumes
     any form-sync bridge — don't build that separately.
  3. **Screenshare piggyback** — a "Present" affordance opens `/files/<path>`
     in a popup and starts the existing LiveKit screenshare flow
     (`client/src/screenshare/share.ts`) so the window lands on the canvas as
     a normal screenshare tile. Full browser fidelity (canvas/WebGL/video
     included), near-zero server cost (SFU relay; encoding on the presenter's
     machine), thin glue. Costs: video-soft for viewers, requires a human
     presenter's browser + upstream bandwidth, dies with their session, and a
     human must click through the `getDisplayMedia` picker (agents can't
     initiate it).
  4. **neko handoff** — "Open in shared browser" pointing the existing neko
     shape at the `/files/` URL. The only mode where everyone can drive one
     real browser; also the only one with heavy *server* cost (headless
     Chromium + video encode per shared doc). Escape hatch, not default.
- **Other file types** (images/PDF/source as top-level documents), directory
  listings, asset bundling (unneeded — the portal serves siblings natively).
- **`canvas file close`** — deleting the shape by hand is fine for v1.
- **Workshops follow-up PR** — after v1 ships, PR
  `lean-software-production/workshops` to retire the `publish-preview` skill's
  Cloudflare Pages route in favour of the `publish-doc` skill (§6): fix the
  "canvas cannot host a live page" claim and point at
  `ensembleworks file open`. Their repo, their merge; not a v1 gate.
- The `file` verb group rides the #4 `ensembleworks` CLI surface (§4); at the
  #8 cutover any interim `bin/canvas file …` aliases retire with `bin/canvas`
  itself — the endpoint + ToolDef carry forward.

## Risks

- **R1 — markdown transform fidelity.** Rendering md at the route means the
  file-server's bytes are transformed in-flight; edge cases (front-matter,
  GFM tables, mermaid) are bounded by the chosen renderer. v1 targets GFM,
  nothing exotic.
- **R2 — prod launcher surface.** Running the file-server as
  `ensembleworks-agent` adds a second sudoers/launcher entry; must stay as
  narrow as the terminal one (fixed binary path, no args from the app user).
- **R3 — opaque-origin gotcha.** Agent-generated HTML that touches
  `localStorage` unguarded will throw. Mitigation: the `publish-doc` skill's
  authoring guidance (§6) states the constraint.
- **R4 — port 8791 collision.** Chosen as the next free port after
  sync (8788) / gateway (8789); verify against neko (8090), livekit (7880),
  whisper at plan time.
- **R5 — presence transport uncertainty.** Scroll-follow assumes presence
  `meta` syncs through `TLSocketRoom` (verification V1 in §5); the LiveKit
  data-channel fallback is specified so a negative answer changes one module,
  not the design.
- **R6 — script injection fragility.** Injecting into arbitrary agent HTML
  can theoretically collide with document JS (message-type namespace, global
  leakage). Mitigation: everything in one IIFE, `ew-` prefixed message types,
  no globals; injection failure degrades to a working non-followable
  document, never a broken one.
