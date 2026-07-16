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

Running the devcontainer on a remote box and reaching it (canvas, terminals,
voice) from your laptop over the LAN? See "Developing on a remote box (LAN)"
in README "Development".

## Verify your changes

- `npm run typecheck` and `npm run build` must pass (three workspaces +
  `bin/`).
- Run the smoke tests listed in README "Development" for anything touching
  the sync server, terminal gateway, canvas API, spatial audio or the
  transcriber.

## Interaction Contract (mandatory in unit specs)

Every unit spec that touches an interaction-bearing surface —
`canvas-editor/src/tools/`, `canvas-react/src/`, or `client/src/canvas-v2/`
input/tool files — must include an **Interaction Contract** section. It has
exactly two legal forms:

1. One or more contract declarations: name, a sketch of the seeded gesture,
   the invariant in prose plus the `obs` expression it checks, the level
   (`fsm` / `browser`), and the scope. See
   `@ensembleworks/interaction-contracts` for the vocabulary and
   `docs/plans/2026-07-16-ux-contracts-design.md` /
   `docs/plans/2026-07-16-ux-contracts-implementation.md` for worked
   examples.
2. `No interaction surface — <one-line justification>`, when the unit
   genuinely touches none of the above (e.g. a pure refactor with no
   gesture/observable change).

Silence — omitting the section entirely — means the spec is incomplete; it is
not read as "no interaction surface." Spec review judges the *substance* of
the section (is the invariant real, is the gesture well-seeded); the CI
presence check (`scripts/ux-contract-presence.test.ts`) only guarantees that
a declaration-or-opt-out exists at all, not that it's a good one.

## Ground rules

- EnsembleWorks is AGPL-3.0; contributions are accepted under that license.
  The bundled tldraw SDK has its own license — see README "License".
- Releases are maintainer-cut via `deploy/release.sh`; don't bump versions
  or tags in PRs.
