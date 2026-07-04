# Contributing to EnsembleWorks

## Get a dev environment

Open the repo in the devcontainer (VS Code, Codespaces, or `devcontainer
up`) — it builds Debian 13 with everything baked in and starts the stack via
`bin/dev up`; the canvas is on forwarded port 8080 with voice and
transcription working keylessly. Setting up natively instead: run
`bin/dev doctor` and follow its remedies. See README "Development" for the
`bin/dev` command reference.

Most contributors drive development with a coding agent (Claude Code &c.);
`AGENTS.md` / `CLAUDE.md` give agents the same contract in brief.

## Verify your changes

- `npm run typecheck` and `npm run build` must pass (three workspaces +
  `bin/`).
- Run the smoke tests listed in README "Development" for anything touching
  the sync server, terminal gateway, canvas API, spatial audio or the
  transcriber.

## Ground rules

- EnsembleWorks is AGPL-3.0; contributions are accepted under that license.
  The bundled tldraw SDK has its own license — see README "License".
- Releases are maintainer-cut via `deploy/release.sh`; don't bump versions
  or tags in PRs.
