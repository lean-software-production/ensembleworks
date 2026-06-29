# neko shared-browser shape — POC plan

First item on the post-MVP backlog (`README.md`): a **shared browser on the
canvas** that the whole mob can drive, the way they already share tmux terminals.
[neko](https://github.com/m1k1o/neko) is a Dockerised real browser (Firefox /
Chromium on a virtual display) streamed to clients over **WebRTC**, with
**multiplayer control hand-off built in** — request/release the keyboard, exactly
the "mob on one shared thing" model EnsembleWorks is built around.

This plan gets it working on the **dev box first** (`baljeet`, tailnet-only),
then promotes it to the **Cloudflare server**. The two phases differ *only* in
the WebRTC media path; everything else is identical and needs no app code.

## Why this is mostly plumbing we already have

neko exposes two planes that line up with EnsembleWorks' "two planes" design:

| neko plane | What it is | Reuses |
|---|---|---|
| HTTP + WebSocket on one port | serves the neko web UI + signaling / control | the existing `/dev/{port}` Caddy route (`reverse_proxy` already does WS upgrade) — **no Caddyfile change** |
| WebRTC media | the actual screen + input stream, browser ↔ neko container directly | the **same** public-media pattern the self-hosted LiveKit SFU already uses (pinned advertised IP + a fixed port, signaling on loopback) |

The neko web client is just a webpage, so it rides the existing `iframe` shape
(`client/src/iframe/IframeShapeUtil.tsx`) — paste its URL and it becomes a shape.
**No app code is required to validate the concept.** A first-class `neko` shape
type with proper control affordances is the *productisation* step, deliberately
deferred until the POC proves it feels right.

The one genuine risk is **serving neko under a sub-path** (`/dev/8090/…`) — see
"Risk: base path" below. That, not the media, is what to derisk first.

---

## Phase 1 — dev box (`baljeet`, tailnet)

This is the easy environment: the edge is `tailscale serve --bg 8080`
(tailnet-only, membership = auth), so **every client is already a WireGuard peer**
and can reach baljeet's tailnet IP directly on any UDP port — **no firewall holes,
no NAT traversal config beyond pinning the advertised IP.** It mirrors the
LiveKit dev setup exactly (`~/.config/ensembleworks/livekit-dev.yaml`).

Host facts (host glue, not in the repo — confirm with `tailscale ip -4`):

| | value |
|---|---|
| tailnet IP (`NAT1TO1`) | `100.127.227.76` |
| tailnet interface | `tailscale0` |
| public host | `baljeet.cyprus-macaroni.ts.net` |
| LiveKit media range (avoid) | UDP `50000-50300` |
| **neko media port (chosen)** | **UDP `52000`** (single mux port, outside the LiveKit range) |
| neko HTTP (loopback) | `127.0.0.1:8090` → reached via `/dev/8090/` |

### Step 1 — run neko

Standalone `docker run` for the POC (promote to a tmux window later — see
"Launcher glue"). Env-var names are neko **v3** (`m1k1o/neko`), confirmed against
the v3 docs. This exact command was run + verified on `baljeet` 2026-06-27.

```bash
docker run -d --name neko-poc --shm-size=2g \
  -p 8090:8080 \
  -p 52000:52000/udp \
  -e NEKO_DESKTOP_SCREEN=1280x720@30 \
  -e NEKO_MEMBER_PROVIDER=multiuser \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
  -e NEKO_SESSION_IMPLICIT_HOSTING=true \
  -e NEKO_SESSION_INACTIVE_CURSORS=true \
  -e NEKO_WEBRTC_UDPMUX=52000 \
  -e NEKO_WEBRTC_NAT1TO1=100.127.227.76 \
  ghcr.io/m1k1o/neko/firefox:latest
```

**Control model — mob-friendly.** `NEKO_SESSION_IMPLICIT_HOSTING=true` (neko's
default, set explicitly here) means control switches to whoever clicks/types — no
"request control" handshake, exactly like a shared tmux terminal.
`NEKO_SESSION_INACTIVE_CURSORS=true` (off by default) draws every member's cursor
on the shared browser so the mob can see where each other is pointing. Together
they make one neko shape feel like the terminals: everyone can drive, everyone
can see.

`8090` is published on all interfaces (not loopback) for the POC so neko is
reachable **both** directly at root over the tailnet
(`http://100.127.227.76:8090/`, no sub-path — clean media test) **and** via
`localhost:8090` so Caddy's `/dev/8090/` serves it for the canvas embed. When
promoting to the launcher, bind HTTP to `127.0.0.1:8090` (Caddy-only) per the
plan. No `NEKO_SERVER_PATH_PREFIX` is needed — neko uses relative asset/WS paths
(see "Risk: base path").

What each WebRTC line is doing, and its LiveKit analogue:

- `NEKO_WEBRTC_NAT1TO1=100.127.227.76` — force the advertised ICE host candidate
  to the **tailnet** IP. Same job as `node_ip` in `livekit-dev.yaml`; also the
  fix for "a container advertises its docker-bridge IP" (LiveKit solved the
  sibling problem with `interfaces.includes: [lo, tailscale0]`).
- `NEKO_WEBRTC_UDPMUX=52000` — a **single** UDP port for all media (vs an EPR
  range). Same instinct as narrowing LiveKit to a fixed range; one port is the
  docker-friendly, easy-to-reason-about choice. Published to the host so it's
  reachable on `tailscale0`.

No `ufw` / cloud-firewall rule is needed on the tailnet — tailnet ACLs govern
reachability, and the default ACL already permits a user's own devices.

### Step 2 — put it on the canvas (a dedicated `neko` shape)

neko is its **own** tldraw shape (`client/src/neko/NekoShapeUtil.tsx`), not a
flavour of the generic iframe shape. It brings its own auth, per-viewer
identity, control model and (soon) resize semantics, so isolating it means the
whole feature can be enabled/disabled/reworked without touching anything else.

Create one from the toolbar → **New shared browser** (`createNekoShape` in
`ui.tsx`). The shape stores only `{ w, h, base, title }`; `base` defaults to
`/shared-browser/` — the dedicated Caddy route (see "Running it as a service"
below; the POC first proved this out on the generic `/dev/8090/` proxy). Each
viewer's iframe `src` is composed at render time by `buildNekoSrc(base, name)`:

```
/shared-browser/?usr=<your-canvas-name>&pwd=neko&embed=1
```

- `usr=<name>&pwd=neko` — the neko client auto-logs-in when both are present
  (`searchParams.get("usr"/"pwd")`). The name is **this viewer's** canvas
  identity (`peekIdentity().name`) — the shape's props are shared via sync, but
  the loaded `src` is per-user, so everyone joins under their own name, no
  prompt.
- `embed=1` → neko's `videoOnly` mode: hides the side menu / member panel /
  login chrome, leaving the bare interactive stream. `cast=1` would also hide
  controls → view-only, so it is **not** used.
- `pwd=neko` is the regular-member password (control hand-off, not admin). It
  rides in the per-viewer URL — acceptable on the tailnet (membership is the
  real auth boundary); the admin password is never put in a URL.

**Aspect ratio (Option A).** The stream is 1280x720; the shape locks to that
ratio on resize (`lockNekoAspect`, accounting for the fixed-height header) so the
browser always fills the shape with no letterbox bars. It does not reflow the
remote browser to arbitrary shapes — that was the heavier "Option B" and is
deferred.

**Connect splash.** neko briefly shows its branded login window (`.connect`) while
auto-login + WebRTC come up. The iframe is same-origin, so the shape injects a
one-line stylesheet (`NEKO_SPLASH_CSS`) into the iframe document to hide it,
giving a clean black→stream transition. Auto-login runs in JS regardless, so
hiding the overlay changes nothing functional.

**Audio.** Two separate concerns:

- *Stream audio (co-watching) + the reconnect "plop".* The shape header carries a
  **🔇/🔊 toggle** that reads/sets the same-origin `<video>` **directly from the
  parent** (`getVideo()` + `toggleMute()`) — no injected `<script>`, no console,
  and it only ever flips `muted`, so it can never disable the stream. Audio is
  muted by default and the default is **enforced**: on a canvas origin the browser
  treats as "engaged", neko auto-unmutes the stream on connect, and that
  auto-unmute is exactly what makes the WebRTC re-attach **plop** audible. So
  while the user prefers muted, a `volumechange` listener (plus a polled backstop)
  re-mutes neko's auto-unmute instantly — no plop until they press 🔊 — and while
  they prefer unmuted it re-asserts that across reconnects. Because it only ever
  toggles `muted` (recoverable), it can't get stuck silent. (Abandoned along the
  way: an injected-script unmute that never fired, and a track-`enabled` gate that
  could mute the single persistent desktop track for good.)
- *Notification sound (precaution).* neko's only sound asset is `chat.mp3`,
  played on chat/event messages when its `chat_sound` setting is on. As a
  precaution we assign a no-op `SilentAudio` onto the iframe's
  `contentWindow.Audio` **from the parent** (same-origin) so `new
  Audio("chat.mp3").play()` does nothing — done parent-side because an injected
  `<script>` doing the same silently never took effect. (The reconnect "plop" we
  chased turned out to be the *stream* re-attach, not chat.mp3 — handled by the
  enforced-mute above.)

**Re-measure on mount.** neko's player sizes its container only on a window
`resize` event and can latch onto a transient first-mount layout (a flicker that
a manual resize would clear). The shape dispatches synthetic `resize` events into
the iframe across neko's async mount + stream start to settle it.

**Enable/disable.** The feature is three registrations + one module. To remove
it entirely: drop `NekoShapeUtil` from `customShapeUtils` (`App.tsx`), the
`neko` tool from `ui.tsx`, and the `neko` entry from `server/src/schema.ts`,
then delete `client/src/neko/`. Nothing else references it. (The container is a
separate `docker run`; stopping it is `docker rm -f neko-poc`.)

The generic iframe shape (`IframeShapeUtil.tsx`) is intentionally **untouched**
by neko — the only shared helper is `peekIdentity()` in `identity.ts`.

### Step 3 — verify (the actual test)

From a **second** tailnet device (e.g. `candace-omarchy`, the laptop) open the
same canvas room and the same neko shape:

- [ ] the neko web UI loads inside the iframe (proves path-prefix + WS signaling)
- [ ] video of the remote browser renders (**proves the tailnet UDP media path**)
- [ ] control hand-off works — one person requests control, types, releases; the
      other takes it
- [ ] both canvas tabs agree on the shape's position/size (tldraw sync — free)

### Risk: base path — RESOLVED (verified 2026-06-27)

Web apps served under a sub-path break if they assume root (`/`). `/dev/{port}`
strips the prefix, so neko **sees** requests at `/`, but the **browser** is at
`/dev/8090/`. Verified empirically that this is a **non-issue for neko**:

- neko's index references assets **relatively** (`src="js/app.…js"`, no leading
  slash) → under `/dev/8090/` they resolve to `/dev/8090/js/…` and load (200
  through Caddy). No `NEKO_SERVER_PATH_PREFIX` needed.
- `/dev/8090/api/ws` returns the **same** `400 application/json` as the root
  `/api/ws` — i.e. the request reaches **neko's WS handler**, not Vite's SPA
  fallback (which would be `200 text/html`). So signaling survives the sub-path.
- `/dev/8090/health` → `200`.

So neko embeds under the canvas origin with **zero Caddyfile changes and no
path-prefix config**. (If a future neko version switches to absolute asset/WS
paths, the fallback is a dedicated non-stripping Caddy route — `@neko path
/neko*` → `reverse_proxy localhost:8090` paired with a path-prefix config — but
that is not needed today.)

### Other things to expect

- **iframe sandbox** (`IframeShapeUtil.tsx:171`) lacks `allow-pointer-lock`.
  neko's absolute-pointer mode works without it; if the cursor feels wrong,
  adding `allow-pointer-lock` is the one likely client tweak. WebRTC itself
  works in a `allow-scripts allow-same-origin` sandbox with no extra token.
- **CPU**: neko runs a real browser + software video encode and will compete
  with the dev servers + SFU. Fine for a POC; if it stays, it wants its own
  cgroup slice (cf. `ensembleworks-media.slice`, `CPUWeight=50`).
- **`--shm-size=2g`**: Chromium/Firefox crash with the default 64 MB `/dev/shm`.

### Running it as a service (`ensembleworks-shared-browser`)

Beyond the POC, the shared browser is an **additional always-on service**, the
same class as the self-hosted LiveKit SFU (loopback signaling behind Caddy +
public UDP media + a pinned advertised IP). The only structural difference: it's
a **container**, so the supervisor runs `docker run` instead of a binary. It is a
**singleton** — one neko (one Firefox, one display) shared by the whole canvas;
per-room instances are out of scope (each would be another ~1 core + ~1 GB).

It is **release-independent** (it runs a container, not the app's release code),
so on production boxes it's wired into `deploy/deploy.sh` as an **opt-in** extra:
deploy with `SHARED_BROWSER=1` and the unit + slice are installed, enabled, and
started if down. Because a restart would drop the live shared session, a routine
deploy never restarts it — pick up a changed unit with a manual
`systemctl restart ensembleworks-shared-browser`. `docker` itself and the media
UDP firewall rule are **host** concerns owned by the laingville bootstrap (exactly
like LiveKit), not by this repo's deploy scripts.

Scaffolded in the repo (fill in host specifics, don't commit secrets):

| Concern | Artifact |
|---|---|
| Supervision (prod) | `deploy/systemd/prod/ensembleworks-shared-browser.service` — runs the container, `Restart=always`. Installed/enabled by `deploy/deploy.sh` only when `SHARED_BROWSER=1` + docker + the env file are present |
| Resource isolation | `deploy/systemd/prod/ensembleworks-shared-browser.slice` — its OWN slice, sibling of the app's `ensembleworks.slice` (a browser's RSS would dwarf the app envelope); `CPUWeight=100`, below the SFU's 200, above the dev slice's 50. Installed alongside the unit |
| Edge (HTTP/WS) | the **`@shared-browser`** route (strip `/shared-browser` → loopback `:8090`) is in **both** `deploy/Caddyfile` (dev/ash) and `deploy/Caddyfile.prod` (deployed boxes). The shape's `base` is `/shared-browser/` (`NekoShapeUtil.tsx`). Verified: page, assets and `/shared-browser/api/ws` all reach neko |
| Config / secrets | `deploy/shared-browser.env.example` → copy to `~/.config/ensembleworks/shared-browser.env`. Pinned image, screen, member passwords (admin is a real secret, never in a URL), `NEKO_UDPMUX` + `NEKO_NAT1TO1` (per-env) |
| Media firewall | **prod only, host-owned (laingville):** open `NEKO_UDPMUX/udp` in ufw + the Hetzner cloud firewall (rule `shared-browser-media-UDP`), like the LiveKit `50000-50300` range. `deploy.sh` does not touch the firewall. Dev (tailnet) needs none |
| Image / docker | host-owned: pin a digest in `NEKO_IMAGE` (not `:latest`) so dev == prod; `docker` install + `docker pull` happen in the laingville bootstrap; `--shm-size=2g` is mandatory |

On the **dev box** the same container runs instead as a gated `shared-browser`
window in `~/Work/ensembleworks-devserver` (foreground `docker run --rm` wrapped
by `hold`, gated on `docker` being present / `SHARED_BROWSER_ENABLE`) — mirroring
how the `livekit`/`scribe` windows are gated.

Auth inherits CF Access (prod) / the tailnet (dev); neko's password is a second
layer. Browser state is ephemeral (resets on restart) — mount a volume only if
persistent logins are wanted.

---

## Phase 2 — Cloudflare server (`canvas.leansoftware.ai`)

Same container, same iframe, same `/dev/{port}` route. **Only the media path
changes**, and it's the path the box already runs for LiveKit
(`deploy/livekit-cutover-ash.sh`, `docs/livekit-self-host-spec.md`):

| dev box (Phase 1) | Cloudflare box (Phase 2) |
|---|---|
| `NAT1TO1` = tailnet IP `100.127.227.76` | `NAT1TO1` = public IPv4 `178.156.162.162` |
| media reachable over WireGuard, no firewall | open UDP `52000` in **both** `ufw` (`shared-browser-media-UDP`) and the Hetzner cloud firewall |
| tailnet membership = auth | CF Access on the origin = auth; neko password second layer |

Concretely:

1. Same `docker run`, with `NEKO_WEBRTC_NAT1TO1=178.156.162.162`.
2. `ufw allow 52000/udp comment 'shared-browser-media-UDP'` **and** add the matching rule
   in the Hetzner cloud firewall (host ufw alone is insufficient when the cloud
   firewall is enabled — same lesson as the LiveKit range).
3. Verify from off-tailnet that signaling **and** media connect; if media stalls
   while signaling works, it's the firewall (probe with
   `nmap -sU -p 52000 178.156.162.162`).

Carry over the LiveKit hard-won lessons: pin the advertised IP (no STUN/WAN
discovery), keep signaling on loopback behind Caddy + CF Access, exclude
docker-bridge interfaces from ICE (here, the UDP-mux + `NAT1TO1` combination
already forces the right single candidate).

Defer until Phase 2 proves out: the first-class `neko` shape type, per-room neko
instances vs. one shared browser, and capacity isolation (cgroup slice).

---

## Out of scope for the POC

- A dedicated `neko` shape type / toolbar action / control-state affordances.
- Multiple neko instances (per-room, per-shape) and their lifecycle.
- Persisting neko browser state across restarts.
- Recording / egress.
