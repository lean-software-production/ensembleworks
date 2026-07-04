# LAN-accessible devcontainer with working voice — design

**Date:** 2026-07-04
**Status:** approved (design); spec under review

## Goal

The same bridge-networked, keyless-by-default devcontainer every contributor
uses, but reachable from **another machine on the LAN** — canvas, terminals,
transcription **and LiveKit voice** — with **no tailscale and no host
networking**. This lets a maintainer develop on a remote box (baljeet) exactly
the way any contributor develops on their laptop: `devcontainer up` when you
sit down to work, `devcontainer down` when you're done. Baljeet stops being a
hand-rolled `--network host` deployment and becomes "a contributor who happens
to have real keys and a LAN address."

The shared-repo changes (Components 1–3) benefit **every** contributor doing
LAN/remote dev; Component 4 is baljeet-specific adoption.

### Why voice is the hard part

LiveKit's SFU must advertise an IP the **browser** can reach. On a laptop
contributor everything is co-located on `localhost`, so LiveKit's `--dev` mode
(`--node-ip 127.0.0.1`) just works. When the browser is on a *different* LAN
machine than the stack, `127.0.0.1` is unreachable — the SFU must advertise the
host's **LAN IP**, and the browser must talk to the box's LAN address (not
`localhost`) for both signaling and media.

### What already works (discovered, not assumed)

- LiveKit's dev command already binds all interfaces:
  `livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1`
  (`bin/dev-lib.mjs`). Only `--node-ip 127.0.0.1` pins it to localhost.
- The media ports are **already published** by `devcontainer.json` runArgs:
  `-p 7881:7881` (ICE/TCP) and `-p 7882:7882/udp` (LiveKit dev-mode UDP mux —
  one port carries all participant media).
- The `.local/` state seam (git-ignored backing store, symlinked to the
  home-dir paths by `post-create.bash`) already exists from the
  contributor-dev-setup work.

So the work is: advertise the host LAN IP instead of `127.0.0.1`, publish the
app port, and teach the browser-facing URL wiring to speak plain HTTP on `:8080`
instead of assuming TLS on `:443`.

## Out of scope

- **Tailscale-in-container** (the container joining the tailnet as its own node
  for portable tailnet voice) — left as a documented future seam.
- **Always-on service** semantics (restart policy, reboot autostart) — baljeet
  is an open-when-working dev session.
- **Local TLS** for LAN access — we use plain HTTP on `:8080`.

## Components

### 1. Configurable LiveKit `node_ip` (+ host auto-detect)

`bin/dev` learns an `ENSEMBLEWORKS_LIVEKIT_NODE_IP` override (default
`127.0.0.1`), used as the `--node-ip` value in the `--dev` command:

```
livekit-server --dev --bind 0.0.0.0 --node-ip ${nodeIp}
```

- `bin/dev-main.mjs` `makeCtx()` resolves the node IP with this precedence:
  1. `ENSEMBLEWORKS_LIVEKIT_NODE_IP` env (from `dev.env` or the process env)
  2. the git-ignored file `<repo>/.local/config/ensembleworks/host-lan-ip`
     (single line, an IP) if present
  3. `127.0.0.1`
- `bin/dev-lib.mjs` `buildServices` consumes `ctx.livekitNodeIp` in the livekit
  command (config-file mode is unchanged — it takes `node_ip` from the yaml).
- `devcontainer.json` gains an `initializeCommand` (runs on the **host** before
  container create) that detects the host's primary LAN IP and writes it to
  `<repo>/.local/config/ensembleworks/host-lan-ip` (idempotent overwrite):
  ```
  ip -4 route get 1.1.1.1 | grep -oE 'src [0-9.]+' | awk '{print $2}' > .local/config/ensembleworks/host-lan-ip
  ```
  Result: LAN voice works for any contributor hitting a box on their LAN with
  **zero manual config**. A laptop-local contributor's detected IP is their own
  LAN IP (co-located → reachable) or, if detection yields nothing, the
  `127.0.0.1` default still works.

Media rides the already-published `7882/udp` mux; `--bind 0.0.0.0` is already
set, so no LiveKit bind change is needed.

### 2. Generalized public origin (the substantive change)

Today `client/vite.config.ts` and `bin/dev-lib.mjs` assume a public host is
always **TLS on port 443** (built for tailscale-serve / Cloudflare tunnels):

```js
// vite.config.ts (current)
hmr: { protocol: 'wss', host: publicHost, clientPort: 443 }
```

Plain-HTTP LAN access (`http://192.168.1.77:8080`) breaks this: HMR and the
LiveKit signaling URL both target `:443` and fail, so voice never connects.

Introduce **`ENSEMBLEWORKS_PUBLIC_ORIGIN`** — a full origin string
`scheme://host[:port]` — and derive everything browser-facing from it:

| access mode | `ENSEMBLEWORKS_PUBLIC_ORIGIN` | derived HMR / LiveKit signaling |
|---|---|---|
| laptop-local | *(unset)* | `localhost`, default vite behavior |
| **LAN (this design)** | `http://192.168.1.77:8080` | `ws` / host `192.168.1.77` / clientPort `8080` |
| tailscale / tunnel | `https://baljeet.cyprus-macaroni.ts.net` | `wss` / that host / clientPort `443` |

Derivation rules (a single shared parse):
- `allowedHosts = [origin.host]`
- HMR: `{ protocol: origin.scheme === 'https' ? 'wss' : 'ws', host: origin.host, clientPort: origin.port ?? (https ? 443 : 80) }`
- Browser-facing LiveKit URL (`LIVEKIT_URL`, the `wss?://…/livekit` behind
  Caddy): `${origin.scheme === 'https' ? 'wss' : 'ws'}://${origin.host}${origin.port ? ':' + origin.port : ''}/livekit`

**Back-compatibility:** `ENSEMBLEWORKS_PUBLIC_HOST`, if set and
`PUBLIC_ORIGIN` is not, is treated as `https://<host>` (port 443) — existing
tailscale/tunnel deployments and the Codespaces auto-detect branch keep working
unchanged. `PUBLIC_ORIGIN` wins when both are set.

Touchpoints:
- `client/vite.config.ts` — parse `PUBLIC_ORIGIN` (falling back to
  `PUBLIC_HOST` → https, then the existing Codespaces branch, then localhost);
  build `allowedHosts` + `hmr` from it.
- `bin/dev-lib.mjs` — `ctx.publicOrigin` replaces the `wss://${publicHost}`
  hardcode in `livekitPublicUrl`; the client window's inline env passes
  `ENSEMBLEWORKS_PUBLIC_ORIGIN` (not `…_PUBLIC_HOST`).
- `bin/dev-main.mjs` — `makeCtx()` resolves `publicOrigin` (with the
  `PUBLIC_HOST → https://host` shim) and exposes host/scheme/port to the ctx.
- **Verify** how the client app itself constructs the LiveKit connection URL
  (it may read a server-provided `LIVEKIT_URL` or `window.location`); the plan
  must confirm it honors the origin rather than re-deriving `:443`.

### 3. Publish the app port to the LAN

`devcontainer.json` publishes Caddy's `:8080` to the host on all interfaces so a
LAN machine can reach it, alongside the already-published media ports:

```json
"runArgs": ["-p", "8080:8080", "-p", "7881:7881", "-p", "7882:7882/udp"]
```

(`-p` defaults to `0.0.0.0`, i.e. reachable on the LAN — intended here.)
`forwardPorts: [8080]` stays for the VS Code UX. On a laptop this simply also
binds `localhost:8080` — harmless.

### 4. Baljeet adoption + migration

1. Retire the hand-rolled `--network host` container:
   `docker stop ensembleworks && docker rm ensembleworks`.
2. Seed the git-ignored `<repo>/.local/`:
   - `config/ensembleworks/dev.env` with
     `ENSEMBLEWORKS_PUBLIC_ORIGIN=http://192.168.1.77:8080` and `STT_API_KEY`
     (Groq). **LiveKit API keys are not needed** in this model — see below.
   - copy the current canvas data (`~/.local/share/ensembleworks/*`, the Jul 2
     authoritative set) into `share/ensembleworks/`.
   - **omit** `livekit-dev.yaml` — the tailnet config forces config-file mode
     bound to `tailscale0`, which a bridge container can't use. LAN uses
     `--dev` + `node_ip`.
3. `initializeCommand` writes `host-lan-ip` (or set
   `ENSEMBLEWORKS_LIVEKIT_NODE_IP=192.168.1.77` in `dev.env`).
4. `devcontainer up` (or VS Code "Reopen in Container"); develop; `down` when
   done. Access `http://192.168.1.77:8080` from any LAN machine.

### 5. Docs

- `CONTRIBUTING.md` / README dev section: a short "developing on a remote box on
  your LAN" note — set `ENSEMBLEWORKS_PUBLIC_ORIGIN`, the `initializeCommand`
  handles `node_ip`, voice works over the LAN.
- Note the two consequences below.

## Notable consequences (accepted)

- **LiveKit runs with dev keys** (`devkey`/`secret`, public constants) on a
  LAN-reachable box. Acceptable for a trusted home/office LAN; documented as a
  one-liner. (Config-file mode with real keys remains available for anyone who
  wants it, but requires an interface LiveKit can bind — i.e. host networking —
  so it's not the bridge/LAN path.)
- **shared-browser is off** on baljeet in this model (a bridge container's Caddy
  can't reach the host neko) — identical to every laptop contributor.
- **One `node_ip` ⇒ voice on one network.** Media works on whichever network
  that IP belongs to (LAN here). The canvas HTTP can still be reached on other
  networks (e.g. tailscale-serve fronting `:8080` in parallel), but voice media
  would only connect on the `node_ip` network.

## Error handling

- If `PUBLIC_ORIGIN` is malformed, `bin/dev` and `vite.config.ts` fall back to
  localhost behavior with a clear one-line warning rather than crashing.
- If `initializeCommand` can't detect a LAN IP (e.g. no default route), it
  writes nothing; `bin/dev` falls through to `127.0.0.1` (localhost-only voice)
  — never a hard failure.
- `bin/dev doctor` reports the resolved `node_ip` and `public origin` as info
  lines so a contributor can see what voice/HMR will target.

## Testing

- **Unit (`bin/dev.test.ts`, `npx tsx`):**
  - `node_ip` override precedence (env > `host-lan-ip` file > `127.0.0.1`) and
    its appearance in the livekit `--dev` command.
  - `PUBLIC_ORIGIN` parse → derived `LIVEKIT_URL` for http:8080 / https:443 /
    unset, plus the `PUBLIC_HOST → https://host` back-compat shim.
- **vite.config:** a focused assertion (or documented manual check) that a
  `PUBLIC_ORIGIN` of `http://host:8080` yields `hmr.protocol==='ws'`,
  `clientPort===8080`, and `allowedHosts` includes the host.
- **End-to-end (manual, the bar):** from a *second* LAN machine open
  `http://192.168.1.77:8080` — canvas loads, HMR connects (edit a file, see
  hot reload), open the About/version, and join voice: confirm the browser
  receives an ICE candidate at `192.168.1.77:7882` and audio connects. Confirm
  `bin/dev status --json` all-healthy and the smoke tests pass.
- **Co-located scribe media path (explicit check):** with `node_ip` set to the
  LAN IP, the in-container scribe now receives a LAN-IP media candidate and must
  hairpin (container → host LAN IP → published `7882/udp` → container) to pull
  audio. Verify transcription still lands (`bin/dev logs scribe`, and a
  transcript appears). If hairpin proves unreliable, the fallback is to also
  advertise a loopback candidate for co-located clients (documented in the plan
  as a contingency — do not pre-build it).

## Rollback

The change is additive and env-gated: with `PUBLIC_ORIGIN` unset and no
`host-lan-ip`, behavior is identical to today (localhost, `node_ip 127.0.0.1`).
Baljeet can revert to the current `--network host` container at any time by
re-running the earlier `docker run` recipe.
