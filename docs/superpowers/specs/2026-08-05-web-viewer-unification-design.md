# Web viewer — unify file-viewer and dev-server controls

Builds on 2026-07-29-file-viewer-force-follow-design.md (force-follow
baton, shipped in v0.26.0). Merges the dev-server `iframe` control into
the file-viewer, renames the result **web viewer**, and retires the
`iframe` control.

## Problem

Two canvas controls embed web content with unrelated capability sets:

- **file-viewer**: VM files, force-follow baton, rrweb mirror, relay
  backlog, presenter cursor — the full presentation stack.
- **iframe**: dev servers (and arbitrary URLs) via a dumb Caddy
  `/dev/{port}` path proxy — per-user state, no follow, and broken
  whenever the dev app uses root-absolute URLs (assets, HMR websocket),
  which is nearly always.

Teams present dev servers constantly; the control that shows them has
none of the presentation machinery, and the proxy under it corrupts most
real dev apps.

## Decisions (from brainstorm)

- **Local/proxied content only.** The web viewer renders VM files and
  `localhost:<port>` dev servers. External URLs are unsupported —
  rejected at creation with a clear message. No two-tier "dumb embed"
  mode survives.
- **One shape, renamed.** The file-viewer becomes the **web viewer** at
  the UI level (labels, toolbar, docs, CLI help). The wire shape type
  stays `file-viewer` — no tldraw sync schema migration for existing
  file shapes. The shape gains a source discriminator:
  `{ kind: 'file', path, rev }` (today's behaviour, unchanged) or
  `{ kind: 'dev', port, path }`.
- **Migration.** Two kinds of existing shapes:
  - **Old file-viewer shapes migrate in place, automatically.** The
    wire type stays `file-viewer`; a tldraw shape-props migration adds
    the `source` discriminator, defaulting existing shapes to
    `{ kind: 'file' }` with their current path/rev. No visible change,
    no data loss — every existing file-viewer shape simply *is* a web
    viewer after the upgrade.
  - **Old `iframe` shapes** auto-migrate on room load into a plain
    tldraw `text` shape whose text is the shape's URL, formatted as a
    link to that URL. No legacy wording, no split by local/external;
    users recreate local ones as web viewers by hand. This migration is
    best-effort: if it proves fiddly in practice, it may be dropped and
    the shapes left as tldraw "unknown shape" boxes — the iframe
    control is rarely used and the loss is acceptable.
- **`iframe` control retired.** Shape util deleted from the v1 plugin
  registry; creation paths removed. (The v2 engine's
  `canvas-v2/shapes/IframeShape.tsx` is out of scope — v1 only, same as
  the force-follow work.)
- **Proxy strategy: single-origin heuristic (option 2).** Cloudflared
  is the production access path and only forwards 443, so
  origin-per-port is impossible and wildcard subdomains are
  Cloudflare-only; the single-origin `/dev/{port}` path proxy is the
  one scheme that works through every front door (cloudflared, tailnet,
  localhost). Origin-per-port / subdomain schemes are explicitly out of
  scope; revisit only if the heuristic leaks in practice.

## Architecture

### 1. Injecting dev proxy (server)

A server-side proxy replaces Caddy's dumb `/dev/{port}` passthrough
(Caddy keeps routing `/dev/*` to the server; the server now terminates
it instead of Caddy proxying straight to the port):

- **HTML responses**: inject three scripts before streaming to the
  client — the rrweb recorder bridge (same bridge protocol and
  postMessage channel the file server's `injectBridge` uses today), the
  URL-patch script, and the error reporter.
- **Everything else** (JS, CSS, images, fonts, JSON): stream through
  untouched.
- **WebSocket upgrades**: pass through to the target port (HMR).

### 2. URL correctness — two layers, no dev-app changes

Root-absolute URLs (`/src/main.tsx`, `/assets/x.js`, HMR ws at `/`)
resolve against the canvas origin and 404 under a path proxy. Fix:

- **Injected URL patch (deterministic)**: monkeypatch `fetch`,
  `XMLHttpRequest`, and `WebSocket` in the proxied page to rewrite
  root-absolute URLs to `/dev/{port}/…`. Covers all JS-initiated
  traffic, including the HMR websocket.
- **Edge Referer fallback (heuristic)**: requests that miss every
  canvas route but carry a `Referer` under `/dev/{port}/` are proxied
  to that port with the path unchanged. Covers HTML/CSS-initiated loads
  (`<img>`, `<script>`, `<link>`, `url(...)`) that the patch cannot
  reach.

Known residual gaps (accepted): Referer-stripped requests
(`referrerpolicy="no-referrer"`, some workers), and two dev servers
racing for the same unmatched path. The error reporter (below) makes
these visible instead of silent.

### 3. Error visibility

The injected reporter observes, inside the dev app's document:

- JS errors: `window.onerror` + `unhandledrejection`.
- Failed subresources: capture-phase `error` listener on the document
  (a 404'd `<img>`/`<script>`/`<link>` is the signature of a proxy
  miss).
- Failed JS traffic: the patched `fetch`/XHR report non-2xx statuses;
  the patched `WebSocket` reports connect failures and abnormal closes.

Reports flow over the same postMessage channel as rrweb events. The web
viewer header shows an error badge with a count; clicking it opens a
detail list that classifies each entry as **proxy miss** (path-shaped
404 — actionable for us) or **app error** (actionable for the dev).

### 4. Follow / baton — unchanged machinery

The entire force-follow stack applies to dev sources with zero fork:
presentStore token + LWW steal, double-click grab, edit-exit release,
frozen last view, relay backlog, RrwebMirror, presenter cursor, hidden
canvas cursor. The only difference is delivery: file sources get the
recorder via the file server's existing `injectBridge`; dev sources get
it via the injecting proxy. Same bridge protocol downstream, so
`presentBroadcast`, the relay, and the mirror are untouched. No
speculative `useShapeBaton` extraction — there is only one shape after
this change.

### 5. Security — two sandbox profiles by source kind

- **File sources** keep today's strict sandbox (no `allow-same-origin`):
  rendered files are arbitrary disk content (agent-generated,
  downloaded, third-party); the opaque origin keeps any embedded script
  from reaching canvas-origin cookies, APIs, or DOM.
- **Dev sources** get `allow-same-origin` (plus the retired iframe
  control's other grants: scripts, forms, popups, downloads): a dev
  server is code the team deliberately runs, the same trust level as a
  terminal shape — and dev apps routinely need `localStorage`/cookies,
  which an opaque origin denies. This is the same exposure the retired
  `iframe` control already granted, now confined to `/dev/` sources.

The profile is derived from `source.kind` in exactly one place.

### 6. Creation UX

- Existing file paths: unchanged (CLI/API `POST /api/canvas/file-viewer`
  with a path).
- Dev servers: the same creation surface accepts a
  `localhost:<port>`/port form and produces a `{ kind: 'dev' }` shape.
  `toProxiedUrl`'s localhost-detection rule carries over as the
  validator; anything non-local is rejected with a message naming the
  local-only constraint.

## Testing

- **Unit**: source discriminator + sandbox-profile derivation; URL-patch
  rewrite rules (fetch/XHR/WebSocket, root-absolute vs relative vs
  already-prefixed); error classifier (proxy miss vs app error);
  iframe→text migration (URL as text and link).
- **Server**: proxy injects into HTML only; non-HTML streams untouched;
  WebSocket passthrough; Referer-fallback routing (hit, miss, ambiguous
  port).
- **E2E smoke**: real Vite dev server behind the proxy — page loads with
  correct assets, HMR applies an edit live, presenter drives + follower
  mirrors, induced 404 raises the error badge classified as proxy miss.
- **ux-contract**: `none — legacy v1 tldraw web-viewer UI; not a
  canvas-editor/canvas-react/canvas-v2 contract surface` (carries over
  from the force-follow PR).

## Out of scope

- External URLs (permanently, per decision above).
- Origin-per-port and wildcard-subdomain proxy schemes.
- v2 engine (`canvas-v2`) parity, including its IframeShape.
- Auth changes at the edge.
- HTML/CSS body rewriting in the proxy (the two-layer scheme above is
  the whole strategy).
