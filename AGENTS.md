# Agent notes — EnsembleWorks

Multiplayer infinite-canvas team room: tldraw + tmux terminals + LiveKit spatial audio.
Workspaces: `client`, `server`, `transcriber` (Bun workspaces).

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

Inside the container (the Dockerfile sets `ENSEMBLEWORKS_IN_DEVCONTAINER=1`)
`bin/dev` is the *engine* that actually manages the tmux stack — the same
commands, run natively. `ENSEMBLEWORKS_NATIVE=1` forces engine mode on the host
(the no-Docker path). Every call narrates on stderr which mode it picked and
what it forwarded.

State: `~/.local/share/ensembleworks`. Optional keys:
`~/.config/ensembleworks/dev.env`. Verify changes with `bun run typecheck`
and the smoke tests in README "Development".

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
