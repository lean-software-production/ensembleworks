# EnsembleWorks

A multiplayer infinite-canvas team room for a dev team that mobs on a shared
Linux VM: live **tmux-backed terminals**, **embedded dev servers**, sticky
notes and drawings — with teammates as **video bubbles whose voices get louder
as you work closer to them**.

Session MVP plan: [docs/session-mvp-plan.md](docs/session-mvp-plan.md) ·
Debugging the canvas headlessly: [docs/headless-browser.md](docs/headless-browser.md)

EnsembleWorks is free software, licensed under the
[GNU AGPL-3.0](LICENSE).

## How to connect

1. Open the team's canvas URL (ask in the team channel for the exact hostname,
   e.g. `https://canvas.leansoftware.ai`).
2. Sign in at the Cloudflare Access prompt (email one-time PIN or the team SSO).
   Then enter your name once — it's stored locally.
3. That's it. One shared room per URL; add `?room=<name>` for a side room.

## Using the canvas

| Action | How |
|---|---|
| New shared terminal | Toolbar → **New terminal** |
| Type into a terminal | **Double-click** it. tldraw shortcuts pause while you type. |
| Stop typing, go back to canvas | Press **Esc twice quickly**, or click outside the shape. A single Esc goes to the terminal (vim users: you're safe). |
| Resize a terminal | Drag its handles — the PTY cols/rows follow for everyone. |
| Attach from a plain shell | `ssh ensemble@<vm>` then `tmux attach -t canvas-<id>` (the id is in the shape's title bar). |
| Embed a dev server | Toolbar → **Embed dev server** and give a port, or just paste `http://localhost:3000` onto the canvas. |
| Interact with an embedded page | Double-click it; click away to leave. |
| Voice & video | Bottom control bar: mic / camera. Teammates appear as bubbles at their cursors. |
| Hear someone better | Move your viewport toward where they're working. Inside the huddle radius you hear them at full volume. |
| Standup | Toggle **Standup mode** — everyone at full volume regardless of distance. |
| Demo layout | Main menu (top-left) → **Seed demo layout**. |
| Session layout | Main menu → **Seed session layout** — crew zones, benches, painted rings and pair huddles for an augmented team session. |

## Etiquette

- **Don't `exit` or `tmux kill-session` shared terminals** — closing your
  browser detaches you; typing `exit` ends the session for everyone.
- Give terminals meaningful titles so the canvas stays legible.
- Spatial audio means you're "audible" when your viewport is near someone —
  mute if you're stepping away.

## Architecture (one always-on VM, public via Cloudflare Access)

```
browser ─HTTPS─► Cloudflare edge ─[Access auth]─► tunnel ─► cloudflared ─► Caddy :8080 ─┬─ /dev/{port}/ ─► any dev server on the VM
                                                                                        │
                                                                                        └─ * ─► Vite :5173 ── app + HMR, and proxies:
                                                                                                   /sync/{room} ─► sync server :8788 (TLSocketRoom + SQLite)
                                                                                                   /uploads,/api ─► sync server :8788 (assets, health,
                                                                                                                    LiveKit tokens, transcript, shapes)
                                                                                                   /term        ─► terminal gateway :8789 (node-pty ⇄ tmux)

browser ──► LiveKit Cloud (WebRTC voice/video, direct)

scribe bot ──► LiveKit Cloud (subscribe-only) ──► Groq Whisper API (hosted STT)
                                                   └──► POST /api/transcript
```

Caddy's only job is the same-origin `/dev/{port}` proxy; **Vite** serves the app
(with HMR) and proxies the backend routes. The devcontainer runs this exact same
topology under tmux, reached via Codespaces port-forwarding instead of Cloudflare
— so dev and the dogfooding server run identically.

Voice/video runs on **LiveKit Cloud** and STT on **Groq**, so the VM hosts no
media server and needs no GPU — browsers connect to LiveKit Cloud directly,
while the sync server only mints the access tokens.

Two planes, deliberately separated: **tldraw sync owns spatial state** (which
shapes exist, where, how big, who's looking where); **content flows on its own
channels** (terminal bytes via the gateway, media via LiveKit). Shape props
hold only small references — a tmux session id, a URL.

## Development

```bash
npm install
npm run dev        # vite on :5173, sync server :8788, terminal gateway :8789
npm run typecheck
npm run build
```

Smoke tests (gateway must be running for the second one):

```bash
cd server
npx tsx src/smoke-client.ts     # tldraw sync handshake
npx tsx src/smoke-terminal.ts   # gateway: io, scrollback, resize, tmux survival
npx tsx src/canvas-api.test.ts  # canvas API: terminal-status, sticky, frames + frame read
npx tsx src/scribe-api.test.ts  # transcript + shape APIs, scribe tokens
cd ../client && npx tsx src/av/spatial.test.ts        # spatial gain model
npx tsx src/session/layout.test.ts                    # session layout invariants
npx tsx src/neko/neko.test.ts                         # neko shared-browser URL + aspect lock
cd ../transcriber && npx tsx src/segmenter.test.ts    # utterance VAD
npx tsx src/wav.test.ts                               # WAV encoder
```

## Canvas API — agents on the canvas

Agents (and anything else on the VM) both **read** and **write** the canvas
over HTTP via `bin/canvas`. The agent isn't blind: it can see what teammates
have placed in a frame, then report back.

```bash
# write
bin/canvas status <session-id> <working|needs-you|done|idle>   # status chip on the terminal shape
bin/canvas sticky "shipped the fix" --frame advice --author crew-a   # 🤖-tagged, light-blue
bin/canvas sticky "risk: retry loop has no backoff" --frame advice --color yellow

# read
bin/canvas frames                       # every frame + child counts (JSON)
bin/canvas read advice                  # a frame's stickies, text, images, embeds (JSON)
bin/canvas pull-images drafting [dir]   # download a frame's images; prints local paths
```

`CANVAS_URL` (default `http://localhost:8788`) and `CANVAS_ROOM` (default
`team`) configure the target. The `<session-id>` is shown in each terminal's
title bar (`tmux: canvas-<id>`); in a seeded session it equals the crew name.
Frame args match the first frame whose name *contains* the value, case-
insensitively. `read` recovers plain text from each sticky and returns
`/uploads/...` urls for images; `pull-images` downloads them so a multimodal
agent can open the files and actually see them. `--author` tags a sticky
`🤖 <crew>: …` in light-blue so humans can tell agent notes from their own.

**Proximity ordering.** `read` and `frames` sort their results by nearness to
a connected teammate's live cursor — nearest first, each item tagged with a
`dist`, plus a top-level `sortedBy: { userName, cursor }`. So the sticky a human
is hovering lands at `notes[0]`. This uses ephemeral tldraw presence (cursor +
`currentPageId`), so it only applies while a browser tab is open; with nobody
connected, `sortedBy` is `null` and results fall back to document order.

The HTTP routes behind the CLI: `POST /api/terminal-status`, `POST /api/sticky`,
`GET /api/frames`, `GET /api/frame?name=<frame>`.

Typical wiring: a Claude Code Stop hook runs `canvas status $SESSION needs-you`
so the drafting table can see at a glance which agents want attention; an agent
opens with `canvas read <crew>` to take its brief, then posts its Wise Crowds
advice with `canvas sticky … --frame advice --author <crew>`. The bundled
**`canvas` skill** (`.claude/skills/canvas/`) teaches an agent this read →
work → report loop end-to-end.

## Voice transcription — minutes & conversation maps

The **scribe bot** (`transcriber/`) joins the LiveKit room with a
subscribe-only token, splits each teammate's audio into utterances (energy
VAD), transcribes them against **Groq's hosted Whisper API**
(`whisper-large-v3-turbo`; any OpenAI-compatible STT works via `STT_URL`), and
posts each line to `POST /api/transcript`. No
diarization needed — LiveKit gives one track per participant, and the
participant identity *is* the tldraw presence userId, so every line arrives
pre-attributed **and stamped with the speaker's cursor position + nearest
frame**. The transcript knows not just who said what, but *where on the
canvas they were working* when they said it.

```bash
npm run start --workspace=transcriber   # env: CANVAS_URL, CANVAS_ROOM, STT_URL, STT_MODEL, STT_API_KEY

canvas transcript --since <ms-epoch>    # poll the tail (returns `now` to chain polls)
canvas say "let's cap retries" --name alice   # inject a line by hand (demo/testing)
```

Two bundled skills consume the feed (point a Claude Code agent at them in a
canvas terminal):

- **`minutes`** (`.claude/skills/minutes/`) — polls the transcript every few
  minutes and maintains session minutes: decisions, actions, topics, grouped
  by *place* (the frame stamps separate parallel huddle conversations), as a
  markdown file plus a live-updated text shape in a Minutes frame.
- **`conversation-map`** (`.claude/skills/conversation-map/`) — maintains a
  live IBIS-style dialogue map of the discussion (questions, ideas,
  pros/cons, decisions) as real tldraw shapes via `POST /api/shape`. Arrows
  are bound at both ends, so humans can drag the nodes around and the
  structure survives.

`POST /api/shape` is the diagram plane behind that second skill: create
`geo`/`text`/`note`/`arrow` shapes (arrows take `fromId`/`toId` and get real
bindings), update labels/colours/positions by id, delete with cascade. The
CLI wrapper is `canvas shape '<json>'`.

Two design choices to keep in mind: the scribe is **deliberately visible**
(it appears as 📝 scribe in the participant list — the room should know it's
being transcribed; stop it with `systemctl stop ensembleworks-scribe`), and it
hears **everyone at full volume** — spatial audio is a client-side gain, not
an access control, so huddle conversations land in the transcript too (they
stay separable via the frame stamps).

The HTTP routes: `POST /api/transcript` (scribe writes), `GET /api/transcript?since=&limit=`
(agents read), `POST /api/shape` (diagram ops), and
`GET /api/livekit-token?role=scribe` (subscribe-only tokens).

## Terminals & tmux

Canvas terminals run an Omarchy-derived tmux config
([deploy/tmux-ensembleworks.conf](deploy/tmux-ensembleworks.conf), adapted from
[basecamp/omarchy](https://github.com/basecamp/omarchy), MIT — local edits
are marked `ENSEMBLEWORKS` in the file):

- Prefix is **Ctrl-Space** (Ctrl-b still works). `prefix h`/`v` split,
  `prefix c` new window, `prefix q` reloads the config, `prefix ?` lists keys.
- **Vi copy-mode**: `prefix [`, then `v` to select, `y` to yank — the yank
  lands in your *browser* clipboard (OSC52 via tmux `set-clipboard` + the
  xterm.js clipboard addon).
- Mouse is on: wheel-scroll in a terminal scrolls tmux history.
- The Alt-key bindings (`M-1..9`, `C-M-arrows`) work over plain `ssh` +
  `tmux attach`, but the browser/OS eats some of them on the canvas — the
  prefix-based bindings always work.
- The status bar sits at the top of the terminal (Omarchy's default).
- Apps that auto-detect light/dark (Claude Code's "Auto Terminal", vim, bat)
  can't query the background through tmux < 3.4 (it drops OSC 11), so the
  config exports `COLORFGBG=0;15` — the standard "light background" hint.
  Open a fresh tmux window (or restart the app) after changing it.
- The config applies when the tmux server starts; to restyle a running
  server: `tmux source-file deploy/tmux-ensembleworks.conf`.

The look is the **Wellmaintained paper theme**: tokens live in
`client/src/theme.ts` (shape chrome, xterm palette) and `client/src/theme.css`
(canvas + frame labels). The tmux theme uses only named ANSI colors, so it
inherits the same palette automatically.

**neovim** is themed the way Omarchy themes are: a LazyVim plugin spec at
[deploy/theme/neovim.lua](deploy/theme/neovim.lua) (flexoki-light pinned to
the brand tokens). Wire it up with a one-line stub:

```lua
-- ~/.config/nvim/lua/plugins/theme.lua
return dofile("<repo>/ensembleworks/deploy/theme/neovim.lua")
```

## Deployment on the VM

_This section covers the **ash dogfood box** (watch mode, self-editing). For
production client boxes see [Releasing & deploying (production)](#releasing--deploying-production) below._

The fastest path is the bootstrap script — it provisions a fresh **Debian 13
(trixie)** box end to end (Node, Caddy, cloudflared, the `ensemble` user, the
systemd units and Caddyfile below):

```bash
scp deploy/bootstrap-debian-ash.sh root@<box>:/root/
ssh root@<box> 'CF_TUNNEL_TOKEN=eyJ... PUBLIC_HOST=canvas.leansoftware.ai bash /root/bootstrap-debian-ash.sh'
```

See [deploy/bootstrap-debian-ash.sh](deploy/bootstrap-debian-ash.sh) for the config
knobs (`REPO_BRANCH`, `APP_USER`, …). Everything the instance owns lives under
`/home/ensemble`. What it sets up, and the manual steps:

1. **Code**: the repo is cloned to `~ensemble/.local/lean-software-production/ensembleworks`
   (the repo root *is* the app), with `~ensemble/ensembleworks` symlinked to that
   checkout; `npm ci && npm run build`. The `ensemble` user owns it, so the mob can edit
   it in place (see "Editing from inside" below).
2. **LiveKit + STT** are hosted (LiveKit Cloud, Groq) — nothing to run locally.
   Put the project's `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
   in `~ensemble/.config/ensembleworks/sync.env`. The bootstrap also writes
   placeholders for `scribe.env` (STT), `github-app.env` (the EnsembleWorks
   bot — see `deploy/github-app-runbook.md`), and `term.env` (env vars for
   shells spawned in canvas terminals, e.g. `OPENCODE_API_KEY`).
3. **systemd**: `ensembleworks-sync`, `ensembleworks-term`,
   `ensembleworks-client` (Vite), and (optional) `ensembleworks-scribe` —
   installed and enabled, run as `ensemble` in **watch mode** (tsx watch + Vite
   HMR), the same processes the devcontainer runs under tmux. The client unit
   needs `ENSEMBLEWORKS_PUBLIC_HOST` set to your Cloudflare hostname (pass
   `PUBLIC_HOST=` to the script, or edit the unit) so Vite accepts it.
4. **Caddy**: serves plain HTTP on `:8080`; its only route is the `/dev/{port}`
   proxy — everything else goes to Vite, which serves the app and proxies the
   backends. TLS is terminated at the Cloudflare edge, so Caddy needs no certs.
   The Caddyfile is `deploy/Caddyfile` (the same one the devcontainer uses).
5. **Cloudflare Tunnel**: create a tunnel in the Zero Trust dashboard, run
   `cloudflared service install <token>` (or pass `CF_TUNNEL_TOKEN`), and add a
   Public Hostname → `HTTP localhost:8080`.
6. **Cloudflare Access (required)**: add a Self-hosted Access application over
   that hostname with an allow policy (email allowlist or team SSO). This is
   the auth boundary — see Security model below.
7. Open the URL from two laptops, sign in via Access, draw a sticky on each.
8. (Optional) transcription: put `STT_API_KEY=gsk_...` (a Groq key) plus the
   LiveKit values in `~ensemble/.config/ensembleworks/scribe.env`, then
   `systemctl enable --now ensembleworks-scribe`. Check it's hearing the room:
   `canvas transcript`.

Security model: **Cloudflare Access is the auth boundary.** The terminal
gateway is interactive shell access as the shared `ensemble` user — the same
access the team already has over ssh, via a different door. The Cloudflare
Tunnel publishes the hostname to the public internet, so the Access policy in
front of it is what keeps `/term` from being an open shell. The box itself opens
no inbound ports (cloudflared dials out), so lock its firewall down to ssh only.

Users & data: there is **one shared OS user** (`ensemble`) — everyone mobs as
it, and the named people you see are app-level only (a name in browser storage),
not OS accounts. Everything `ensemble` owns lives under its home: the editable
code (`~/.local/lean-software-production/ensembleworks`, symlinked at
`~/ensembleworks`), all session state — canvas SQLite, uploads and transcripts
under `~/.local/share/ensembleworks` (the `DATA_DIR`) — and the secrets
(`~/.config/ensembleworks/*.env`). So one backup of `/home/ensemble` captures
the whole instance. The `*.env` files are segregated by service:
`sync.env` / `scribe.env` feed their systemd units, `github-app.env` feeds
`bin/gh-app-token.bash`, and `term.env` is sourced into every interactive
shell by `~/.bashrc` (wired by `bootstrap-debian-ash.sh`) so CLI tools launched
from canvas terminals see those vars — new terminals pick it up at startup,
and editing `term.env` needs no gateway restart (just open a new terminal or
`source ~/.bashrc`). Because the mob can edit the code the services run, the
LiveKit/Groq keys are effectively readable by anyone with a terminal — that's
inherent to a self-editing room, so only admit people you'd trust with those
keys.

Editing from inside (dogfooding): the point of this stage is that you can change
EnsembleWorks *from a running EnsembleWorks terminal* and see it live. The units
run in watch mode, so you just edit — you are `ensemble`:

```bash
cd ~/ensembleworks                 # the app (symlink to the repo checkout)
$EDITOR client/src/App.tsx         # Vite HMR updates browsers in place
$EDITOR server/src/sync-server.ts  # tsx watch reloads the sync server
```

Client edits hot-swap seamlessly via HMR. Server-side edits (sync, gateway,
scribe) make `tsx watch` restart that process — which **briefly drops live
connections** (canvases reconnect; gateway terminals reset), so make those edits
during a lull. A tight sudoers rule (`/etc/sudoers.d/ensembleworks`) also grants
`ensemble` `systemctl restart|start|stop ensembleworks-*` (no root shell) for
dependency changes or a wedged unit:

```bash
npm install <pkg>                            # then:
sudo systemctl restart ensembleworks-sync    # or -term / -client / -scribe
```

> **Hardening later:** to make the instance *un*-editable from itself (once past
> dogfooding): switch the units off watch mode (the `dev`/`dev:term` ExecStarts
> back to `start`/`start:term`), drop the `ensembleworks-client` Vite unit and
> serve the static `vite build` from the sync server instead (Caddy default route
> back to `:8788`), then split the human and service identities apart — run the
> units as a separate locked-down `ensembleworks` user that owns the code
> read-only to `ensemble`, drop `/etc/sudoers.d/ensembleworks`, and move the
> secrets to that service user so a terminal shell can no longer read or change
> them. The single-user watch/HMR setup here is a deliberate dogfooding-stage
> choice.

## Releasing & deploying (production)

Production client boxes (e.g. ew-donkeyred-001) run non-watch systemd units; the
sync server serves the static client (Caddy proxies to it). The host (Node, Caddy,
cloudflared, LiveKit, the resource envelope, secret placeholders) is provisioned by
the **laingville** repo (`servers/<host>/bootstrap.sh`); this repo owns the app + its
rollout.

> **Prerequisite — tldraw license.** On a real production domain tldraw enforces a
> per-domain license; without one the editor blanks. Put `VITE_TLDRAW_LICENSE_KEY=…`
> in `~<app-user>/.config/ensembleworks/build.env` on the box (key from tldraw.dev) —
> `deploy.sh` sources it and Vite bakes it into the bundle at build time. Dev/watch
> and localhost are exempt, so this only bites production builds.

1. **Cut a release** (from a clean `main`):

       deploy/release.sh patch        # or minor / major -> tags vX.Y.Z, pushes

2. **Deploy a version** to a server (SSH over its tailnet name):

       deploy/deploy.sh mrdavidlaing@ew-donkeyred-001-tailnet 0.2.0

   deploy.sh preflights the host against `deploy/runtime-requirements`, builds the
   tag into `~/releases/<ver>` (reusing `node_modules` when the lockfile is
   unchanged), installs the prod units + `Caddyfile.prod`, swaps the `current`
   symlink, restarts, and keeps the last 3 releases.

3. **Roll back**: deploy an older version — its built dir is still present, so it
   swaps the symlink instantly:

       deploy/deploy.sh mrdavidlaing@ew-donkeyred-001-tailnet 0.1.0

> The ash dogfood box uses `deploy/bootstrap-debian-ash.sh` (watch mode) — a
> separate path that these scripts don't touch.

## The 10-minute team demo

1. **Everyone joins** (2 min) — faces appear as bubbles; say hi; watch the
   bubbles track cursors. Toggle standup mode on and off.
2. **Mob on Claude Code** (3 min) — Main menu → Seed demo layout. Double-click
   the `claude code` terminal, start Claude Code, give it a small real task.
   Two people alternate typing in the same terminal; someone else attaches to
   the same tmux session from a plain ssh window to prove it's just tmux.
3. **Dev server + live preview** (2 min) — in the `dev server` terminal start
   the app on port 3000; the iframe beside it shows the served app. Edit,
   reload the iframe, point with cursors and arrows.
4. **The murmur** (2 min) — two people stay at the code huddle, two drag their
   viewports to the retro corner and talk stickies. Each pair hears itself at
   full volume and the other pair as a murmur. Drag back over — the voices
   cross-fade.
5. **Standup mode** (1 min) — toggle it; everyone is loud again. Close every
   browser tab, reopen: terminals reattach to their tmux sessions, the canvas
   is exactly where it was (SQLite), and the demo is over.

## Post-MVP backlog

neko shared-browser shapes → screenshare-as-a-shape → edge-docked bubbles →
TipTap+Yjs doc frames → mob timer → LiveKit egress recording.

## License

Copyright © 2026 Lean Software Production.

EnsembleWorks is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0). See [LICENSE](LICENSE) for the full text. Because the AGPL's network
clause applies, anyone you let run a modified version of EnsembleWorks over a
network must be offered its corresponding source.

This repository bundles third-party dependencies under their own licenses,
including the [tldraw](https://tldraw.dev) SDK, which ships under the tldraw
license rather than a standard OSS license — review its terms before
distributing or operating a commercial deployment.
