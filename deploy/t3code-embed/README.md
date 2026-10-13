# t3code embed bundle

Puts [t3code](https://github.com/pingdotgg/t3code) (MIT) threads on the canvas
as iframe windows — chat + composer + terminal + diff panels, **without** the
left thread-list sidebar — with **no fork and no upstream PR**.

## How it works

t3code's web app is a static Vite bundle that the t3code server serves itself
(its `staticDir` falls back to the monorepo `apps/web/dist`). `build.sh`
builds that bundle from stock upstream at `UPSTREAM_PIN`, then injects two
tiny assets into the built `index.html`:

- `embed.js` — latches `?embed=1` from the URL into an `ew-embed` class on
  `<html>` for the lifetime of the document (survives SPA navigations that
  drop the query param).
- `embed.css` — under that class, hides the left sidebar, its rail, and the
  floating toggle. Without `?embed=1` the bundle behaves exactly like stock.

Because the t3code server serves the injected dist, the app is same-origin
with its backend: normal cookie auth applies, and no pairing/CORS/wsTicket
work is needed. **Hard requirement:** canvas and t3code must be same-*site*
(same registrable domain, or the same plain-http hostname such as localhost —
ports don't matter, but `foo.localhost` vs `localhost` is cross-site). The
session cookie is `SameSite=lax`; cross-site embedding renders logged-out
with no error. Log in to t3code once in a normal tab; every canvas window on
the same site is then authenticated.

## Usage

```sh
deploy/t3code-embed/build.sh    # prints the injected dist path on stdout
```

Clones upstream to `.local/t3code-upstream` (override with `T3CODE_SRC`),
checks out `UPSTREAM_PIN`, `bun install && bun run build` in `apps/web`,
injects, and sanity-checks the selector contract against the source.

Run the t3code server from that checkout — it runs from TS source on node 24
(no server build) and picks up `apps/web/dist` automatically:

```sh
cd <checkout>/apps/server
T3CODE_HOME=<state-dir> T3CODE_PORT=4300 T3CODE_NO_BROWSER=1 \
  mise exec node@24 -- node src/bin.ts start <project-dir>
```

`start` (web mode) auto-creates a project from `<project-dir>` and a first
thread, and logs a one-time pairing URL (`/pair#token=…`, single-use, 5-min
TTL) — open it once to set the session cookie. Mint more without restarting:
`node src/bin.ts auth pairing create --base-url http://127.0.0.1:4300`.

**Every browser pairs once** (the session cookie is per-browser, ~30 days;
embedded windows show the pairing screen until then). There is no multi-use
pairing secret upstream — all tokens are consumed on first use — so for a
team, pre-mint one labelled long-TTL token per person and share them:
`… auth pairing create --ttl 30d --label alice --base-url http://<host>:4300`.
A canvas-side "join t3code" button that mints + redirects on demand (gated by
the same caller identity as `/api/av/token`) is the natural follow-up.
Do **not** pass `--dev-url`/`VITE_DEV_SERVER_URL` (dev mode 302-redirects
loopback requests away from the static bundle, which breaks iframes).

Get ids: `curl -s http://127.0.0.1:4300/.well-known/t3/environment` (env id)
and `/api/orchestration/snapshot` with the cookie (thread ids). Then put a
window on the canvas via the shape API, which stores the URL verbatim:

```sh
bin/canvas shape '{"type":"iframe","title":"t3code",
  "url":"http://<host>:4300/<environmentId>/<threadId>?embed=1"}'
```

**Don't paste loopback t3code URLs onto the canvas.** Paste runs the shape
through the `/dev/<port>` Caddy proxy rewrite (`client/src/iframe/`), and a
root-absolute SPA can't boot behind a stripping path proxy — the window stays
blank. Pasting is fine with a non-loopback host (tailnet name / real domain),
which multiplayer needs anyway: teammates can't resolve your `localhost`.

One t3code server backs any number of windows; threads are shared-session
multiplayer (everyone sees the same server-side thread live).

## Updating the pin

1. Put the new commit sha in `UPSTREAM_PIN`.
2. Re-run `build.sh`. It fails loudly if upstream dropped the DOM attributes
   the CSS relies on (`data-slot="sidebar"`, `data-slot="sidebar-rail"`,
   `data-sidebar-control`); if so, adjust `embed.css` to the new markup —
   the selector contract is documented at the top of that file.

## Why artifact injection instead of a source patch

An `?embed=1` flag in t3code's source would be ~15 lines but lives in someone
else's repo — upstreaming isn't an option and we don't want a fork to rebase.
Injecting into the built artifact keeps all our code in our tree; the only
upstream coupling is the (shadcn-conventional) `data-slot` attributes, which
the build verifies on every run.
