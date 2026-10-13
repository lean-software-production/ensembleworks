# t3code on the canvas — embed plan

**Status: Prototype working (verified 2026-07-12).** Two sidebar-less t3code
windows on canvas room `t3code-demo`, both live on one shared thread of one
t3code server (`localhost:4300`); a message typed in window A broadcast to
window B in real time, thread rename and provider-error chips included.
View: `http://localhost:8280/?room=t3code-demo` (see §Prototype). Embed [t3code](https://github.com/pingdotgg/t3code)
(MIT, external repo) threads as sidebar-less iframe windows on the canvas —
chat + composer + terminal + diff panels per window, several windows backed by
one t3code server, with **no fork and no upstream PR**.

## Decisions

1. **Whole-app-per-iframe, deep-linked to a thread.** t3code's web app is a
   monolithic SPA (providers, atom registry, one ~5.4k-line ChatView); its
   features are not independently mountable. Each window is the full SPA at
   `/<environmentId>/<threadId>`. Iframes give free isolation (own JS realm
   per window); live thread state syncs server-side.
2. **Artifact injection instead of a source patch.** Upstreaming is not an
   option and we don't carry a fork. `deploy/t3code-embed/build.sh` builds
   stock upstream `apps/web` at `UPSTREAM_PIN` and injects `embed.js` +
   `embed.css` into the built `index.html`. `?embed=1` latches an `ew-embed`
   class onto `<html>`; CSS under it hides the left thread sidebar, rail and
   floating toggle via upstream's (shadcn-conventional) `data-slot`
   attributes. The build fails loudly if the pinned source drops those
   attributes.
3. **Same-origin serving, cookie auth.** The t3code server serves the
   injected dist itself (`staticDir` fallback = monorepo `apps/web/dist`),
   so the SPA is same-origin with its backend: plain `SameSite=lax` cookie
   auth, no CORS/pairing/wsTicket machinery. Log in once in a normal tab;
   every canvas window on the same site is authenticated.
4. **Embed via the generic iframe shape** (`client/src/iframe/`), created
   programmatically through `POST /api/canvas/shape` — which now accepts
   `type: 'iframe'` (url stored verbatim, no proxy rewrite). The neko shape
   is the precedent if a dedicated t3code shape (per-viewer URLs, presence)
   is wanted later.
5. **Presence stays at the canvas layer.** t3code multiplayer is
   shared-session broadcast (chat timeline, terminal PTY, diffs all fan out
   to every viewer; commands are FIFO-serialized server-side). tldraw
   cursors over a window are the "who's here" signal; in-pane presence is an
   optional future t3code feature, not part of this work.

## Adversarial review findings (2026-07-12) and resolutions

- **BLOCKER — paste-time proxy rewrite breaks loopback t3code URLs.**
  `PasteUrlHandler` runs `toProxiedUrl` at paste time; `localhost:<port>`
  URLs become canvas-origin `/dev/<port>/…` paths. t3code's bundle is
  root-absolute (`/assets/*`, router at `/`), so under a stripping path
  proxy it never boots — and the iframe's origin becomes the canvas, the
  opposite of decision 3. *Resolution:* create t3code windows via the shape
  API (verbatim URL). For humans pasting URLs, use a non-loopback host
  (tailnet name / real domain) — multiplayer requires that anyway, since
  teammates can't resolve your `localhost`. Documented in
  `deploy/t3code-embed/README.md`; a paste-handler guard is a follow-up.
- **RISK — same-site is a hard requirement, enforced by nothing.** The
  session cookie is `SameSite=lax` (no `Secure`, no `None`): cross-site
  embedding renders logged-out with no error. Canvas and t3code must share
  a registrable domain (or plain-http localhost for single-machine dev).
  Note `foo.localhost` vs `localhost` is *cross-site* under the PSL.
- **RISK — a programmatic in-app `location.reload()` drops `?embed=1`**
  (SPA nav strips the query, so a hard reload from a stripped URL loses the
  class). Self-heals on the next shape reload (the shape's `src` carries the
  param). Accepted for now.
- Verified fine: selector contract in source and built dist; full-width
  layout after hiding (gap element is inside the hidden root; inset margins
  are variant-gated off); no `<html>` class clobbering (theme code uses
  `classList.toggle`); no FOUC (classic script + blocking CSS beat the
  deferred app module); mobile sheet variant also hidden; multi-window has
  no tab-lock/leader-election hazards; sandbox attrs keep cookies + WS
  working; the server's `devUrl` loopback redirect is inert in web mode
  (only never embed a *dev-mode* Vite server).

## Prototype (all done, 2026-07-12)

1. Build pipeline — `deploy/t3code-embed/` builds pin `f61fa949` (pnpm
   monorepo, node ≥24 via `mise exec node@24`, corepack pnpm) and injects;
   verified end-to-end.
2. Shape API — `type: 'iframe'` on `POST /api/canvas/shape` (contracts +
   server + tests, 25/25 ACs, typecheck green).
3. t3code server on the host: `apps/server` runs from TS source,
   `T3CODE_HOME=.local/t3code-demo/home T3CODE_PORT=4300 T3CODE_NO_BROWSER=1
   node src/bin.ts start .local/t3code-demo/project` — auto-creates project +
   thread, serves the injected dist, logs a one-time `/pair#token=` URL
   (mint more: `node src/bin.ts auth pairing create --base-url
   http://localhost:4300`).
4. Two iframe shapes in room `t3code-demo` via the shape API (through the
   Caddy edge, `POST http://localhost:8280/api/canvas/shape`), both at
   `http://localhost:4300/<env>/<thread>?embed=1`. **Use `localhost`
   consistently** — the session cookie is host-scoped, and `127.0.0.1` vs
   `localhost` are different hosts *and* different sites.
5. Verified in a browser: both windows render the thread full-width with no
   sidebar; double-click → type → send in window A broadcast live to window
   B (shared-session multiplayer), including the thread auto-rename and the
   (expected, no provider key) agent-error chip.

### Additional findings from the prototype run

- **Canvas bug: first-visit name prompt can hard-wedge the page.**
  `client/src/identity.ts:41-43` loops `while (!name) { name =
  window.prompt(…) }`. In any context where Chrome suppresses dialogs
  (automation targets, background/CDP-opened tabs, headless), `prompt()`
  returns `null` immediately and the loop spins the main thread forever —
  debugger-uninterruptible, page unusable. Interactive users just see the
  prompt and answer it. Suggested guard: bail to a default name (or an
  in-canvas rename affordance) after the first null.
- The sync server's `/api/*` responses are served sandboxed (opaque origin —
  `localStorage` throws there); harmless, but don't use an API page as a
  same-origin scripting anchor.
- t3code runs threads fine with no provider API key (UI, terminal, thread
  timeline all live); agent runs error visibly until a key is configured in
  t3code settings.

## UI feedback — two-user session (2026-07-12)

David tested with two users in two browsers, same thread, several windows.
Decision: capture findings and pause; roadmap to be decided separately.

- **Interaction gating works.** Double-click-to-interact / click-away felt
  natural and stayed out of the way — no change needed.
- **Terminal sync is a highlight.** The shared PTY across both users "was
  nice" — it's the moment the multiplayer premise lands.
- **Clipboard image paste into the chat worked** inside an embedded window —
  attachments survive the iframe/embed context with no extra work.
- **…which exposes a sync asymmetry.** Diff-viewer interactions (and other
  panel state) are per-viewer while the terminal is shared, with no cue
  which is which. Preferred model: keep panels independent by default and
  add an **opt-in follow/presenter mode** (one person drives, others'
  panels follow — same pattern as the file-viewer shape's presenter state),
  rather than blanket-syncing panel state upstream.
- **Missing: a canvas-level overview of threads ↔ windows.** The confusion
  isn't inside a window — it's that nothing on the canvas shows which
  t3code threads exist and which windows map to them. (Stale shape titles
  and same-thread duplicate windows were fine by comparison.) A dedicated
  t3code shape with a live thread title / thread picker, or a small
  "threads on this server" overview shape, is the likely answer.
- **In-pane presence: wanted but shape unclear.** Its absence was the top
  multiplayer irritation, but none of the candidate minimums (frame
  avatars, typing indicator, action attribution) stood out yet — revisit
  once the overview/presenter questions settle.
- **Onboarding is tolerable at team scale.** Per-browser one-time pairing
  is acceptable for now; the one-click join endpoint stays a follow-up,
  not a blocker.

## Follow-ups (not in the prototype)

- Onboarding: each browser must pair once with the t3code server (single-use
  tokens; no multi-use secret upstream). Add a canvas endpoint that mints a
  pairing token for the resolved caller and 302s to `/pair#token=…` — a
  "join t3code" sticky/button on the canvas — modeled on `/api/av/token`.

- Guard `PasteUrlHandler`/`toProxiedUrl` so loopback URLs that would die
  behind the `/dev` proxy aren't silently rewritten (or warn on the shape).
- Decide the prod topology: t3code server as a systemd unit beside the
  canvas, same registrable domain, non-loopback URLs everywhere.
- Consider a dedicated `t3code` shape (neko-style): per-viewer deep links,
  thread picker in the header, presence badge — port-friendly to the
  canvas rewrite (keep the body a plain component; the ShapeUtil shell is
  the only throwaway part).
- Security note: `type: 'iframe'` via the API executes arbitrary http(s)
  content for every room viewer (same trust model as paste-to-embed —
  tailnet membership is the auth boundary). Revisit if the API is ever
  exposed to lower-trust callers.
