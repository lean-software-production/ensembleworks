# Agent notes — EnsembleWorks

Multiplayer infinite-canvas team room: tldraw + tmux terminals + LiveKit spatial audio.
Workspaces: `client`, `server`, `transcriber` (npm workspaces).

## Local dev — bin/dev

`bin/dev up` runs the whole stack (sync :8788, terminal gateway :8789, Vite
:5173, Caddy :8080, plus livekit/whisper/scribe when their binaries are
present) in the `workspace` tmux session; the canvas is at
http://localhost:8080. It's idempotent. The commands you'll actually use:

- `bin/dev status --json` — per-service enabled/health, machine-readable
- `bin/dev logs <svc> --tail 500` — one service's scrollback (crashes keep
  their window: exit code + scrollback survive)
- `bin/dev restart <svc>` — respawn one service (after `npm install`, etc.)
- `bin/dev doctor` — environment check; every failure prints its remedy

State: `~/.local/share/ensembleworks`. Optional keys:
`~/.config/ensembleworks/dev.env`. Verify changes with `npm run typecheck`
and the smoke tests in README "Development".

## Releasing — always use the script

Cut releases with `deploy/release.sh`, never by hand-editing `package.json` /
tagging manually. It runs from a clean `main` and gates on a full build before
tagging.

```
deploy/release.sh patch     # or minor / major
```

It: validates `main` is clean and in sync with `origin`, runs
`npm ci && npm run typecheck && npm run build`, then `npm version <bump> -m "release: %s"`
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

- `npm run typecheck` and `npm run build` cover all three workspaces.
