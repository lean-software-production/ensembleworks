# Agent notes — EnsembleWorks

Multiplayer infinite-canvas team room: tldraw + tmux terminals + LiveKit spatial audio.
Workspaces: `contracts`, `canvas-model`, `canvas-doc`, `canvas-sync`,
`canvas-editor`, `canvas-react`, `client`, `server`, `transcriber`, `cli`,
`discord`, `e2e` (Bun workspaces). `discord` is the Discord bridge bot (inbound
messages → frame stickies; outbound summaries → bound channels; internal
/post on :8790). `canvas-model` (pure typed canvas model), `canvas-doc` (Loro
CRDT wrapper), and `canvas-sync` (Loro update exchange + presence over an
injected transport) are the canvas-rewrite foundations — clean-room, never
import server/tldraw/ws. `canvas-editor` (headless clean-room editor: camera/
selection/hover/editing state + tools as pure FSMs against an injected
clock/PRNG, no DOM) completes that clean-room set. `canvas-react` (thin,
logic-free React renderer: CSS-transform world + one SVG overlay + the six
ported custom HTML shapes) sits on top of `canvas-editor` and may touch the
DOM, but holds no editor logic of its own.

### Dogfood rooms (canvas v2)

A per-room flag mounts the new `canvas-editor`/`canvas-react` engine instead
of the legacy tldraw one, over the Phase-2 `/sync/v2` protocol:

- **Server:** set `EW_CANVAS_SYNC=1` on the deployment — this is what mounts
  `/sync/v2/:roomId` at all (`server/src/app.ts`); flag off, that route
  doesn't exist and every room behaves exactly as it does today.
- **Client build:** set `VITE_CANVAS_V2_ROOMS=<comma-list>` (e.g.
  `dogfood,design-review`) at build time — the allowlist `client/src/
  engine.ts`'s `selectEngine` checks against the room id.
- **Ad-hoc override:** append `?engine=v2` to a room's URL to dogfood it
  without a client rebuild, for any room not otherwise excluded.
- **`team` can never run v2.** `selectEngine` hard-excludes the `team` room
  id before consulting the allowlist or the URL param — no build
  misconfiguration or stray `?engine=v2` link can ever flip the room the
  whole team lives in onto the new engine. See `client/src/engine.ts` and its
  `engine.test.ts` / `scripts/exposure-audit.ts` proofs.

## Local dev — bin/dev

Run `bin/dev` **from the host** (the repo root). There it's a *controller*: it
drives the devcontainer and forwards commands into it — you never need
`devcontainer exec …` or the container name.

- `bin/dev up` — start the devcontainer (`devcontainer up`); its stack (sync
  :8788, gateway :8789, Vite :5173, Caddy :8080, plus livekit/whisper/scribe)
  comes up inside.
- `bin/dev status --json` — forwards in; **stdout is clean JSON** (all
  detection/forwarding narration goes to stderr, so `2>/dev/null` gives pure
  JSON for agents).
- `bin/dev logs <svc> --tail 500` / `bin/dev restart <svc>` — forwarded.
- `bin/dev doctor` — host prerequisites (docker, the `@devcontainers/cli`),
  then the container's own doctor.
- `bin/dev attach` — **prints** how to attach (`docker exec -it … tmux attach`)
  plus the nested-tmux detach caveat; it never nests tmux for you.
- `bin/dev down` — stops the whole devcontainer (`docker stop`).
- `bin/dev --help` / `-h` — usage.
- Multiple stacks per host: every dev port shifts by `ENSEMBLEWORKS_PORT_OFFSET`
  (persisted per-checkout in `.local/port-offset`; `bin/dev up` auto-picks
  100/200/… when the defaults are busy and narrates the edge URL). Offset
  stacks use tmux session `workspace-<offset>` and data dir
  `~/.local/share/ensembleworks-<offset>`. Use separate clones (not linked
  worktrees — the controller targets the main checkout). `bin/canvas` needs
  `CANVAS_URL=http://localhost:<8788+offset>` against an offset stack.

Inside the container (the Dockerfile sets `ENSEMBLEWORKS_IN_DEVCONTAINER=1`)
`bin/dev` is the *engine* that actually manages the tmux stack — the same
commands, run natively. `ENSEMBLEWORKS_NATIVE=1` forces engine mode on the host
(the no-Docker path). Every call narrates on stderr which mode it picked and
what it forwarded.

State root: `~/.local/share/ensembleworks`, holding the required storage
triple as siblings — `data/` (DATA_DIR), `databases/` (DATABASE_DIR, live room
SQLite), `database-backups/` (DATABASE_BACKUPS_DIR). The sync server refuses
to start unless all three are set and non-colliding (`server/src/kernel/`
`storage-geometry.ts`). Optional keys: `~/.config/ensembleworks/dev.env`.
Verify changes with `bun run typecheck` and the smoke tests in README
"Development".

## Releasing — always use the script

Cut releases with `deploy/release.sh`, never by hand-editing `package.json` /
tagging manually. It runs from a clean `main` and gates on a full build before
tagging.

```
deploy/release.sh patch     # or minor / major
```

It: validates `main` is clean and in sync with `origin`, runs
`bun install && bun run typecheck && bun run build`, then `npm version <bump> -m "release: %s"`
(bumps `package.json`, commits `release: X.Y.Z`, creates the **annotated** tag
`vX.Y.Z`), and pushes `main --follow-tags`.

Land your feature/fix commits on `main` first; `release.sh` only produces the
version-bump commit + tag.

## Deploying

```
deploy/deploy.sh <user@host-tailnet-name> <version>   # e.g. ...@ew-...-001-tailnet 0.5.1
```

Builds the tag into `~/releases/<ver>`, swaps the `current` symlink, restarts
units, keeps the last 3 releases. Roll back by deploying an older version (its
built dir is still present). See the "Development & Deploy" section of
[README.md](README.md) for shared-browser, the terminal sandbox user, and the
tldraw license-key requirement for prod builds.

## Checks

- `bun run typecheck` and `bun run build` cover all three workspaces.
