# e2e — canvas baseline rigs (Phase 0)

Playwright rigs that capture how the **current tldraw app** actually behaves.
These baselines (screenshots, interaction-feel numbers, perf stats) are the
executable spec the canvas rewrite must reproduce or deliberately supersede —
see [`docs/plans/2026-07-10-canvas-rewrite-design.md`](../docs/plans/2026-07-10-canvas-rewrite-design.md)
and the implementation plan,
[`docs/plans/2026-07-10-canvas-phase0-baseline.md`](../docs/plans/2026-07-10-canvas-phase0-baseline.md).

## Prereqs

- bun 1.3.14 on PATH: `export PATH="$HOME/.bun/bin:$PATH"`
- node 22.12.0 via asdf (`.tool-versions` at repo root)
- ports 8788 and 5273 free — stop `bin/dev`/the devcontainer stack first
- one-time: `cd e2e && bunx playwright install chromium`

## Commands (run from `e2e/`)

- `bunx playwright test --project=e2e` — smoke, seed, feel, multiplayer, visual
- `bunx playwright test --project=perf` — perf scenarios (sanity floor only, no budgets yet)
- `EW_CAPTURE=1 bunx playwright test --project=e2e -g feel` — rewrite `goldens/feel.json`
- `EW_CAPTURE=1 bunx playwright test --project=perf` — rewrite `baselines/tldraw-perf.json`
- `bunx playwright test --project=e2e -g visual --update-snapshots` — rewrite visual goldens.
  **Gotcha:** `--update-snapshots` silently *keeps* a PNG when the new capture is
  within `maxDiffPixelRatio` of the old one, so a real recapture needs
  `rm e2e/goldens/visual/*.png` first, then `--update-snapshots`.
- `bunx playwright show-trace test-results/**/trace.zip` — inspect a failure
  (traces are `retain-on-failure`)

## What lives where

- `goldens/visual/*.png` — `golden-board.png` (10-shape seeded board) and
  `empty-room.png` (chrome only). Two elements are masked as non-deterministic:
  the version stamp (`span[title="EnsembleWorks version"]`, `git describe`
  changes per commit) and the VM load/mem meters (`[data-vm-strip]`, live host
  telemetry). `settleChrome()` also gates the async AV-status text and
  `document.fonts.ready` before every screenshot.
- `goldens/feel.json` — `dragThresholdPx` (5), `nudgePx` (1), `shiftNudgePx`
  (10), `wheelZoomRatio` (1.1). `nudgePx`/`shiftNudgePx` match tldraw's
  exported `MINOR_NUDGE_FACTOR`/`MAJOR_NUDGE_FACTOR` exactly; `dragThresholdPx`
  is consistent with tldraw's internal `dragDistanceSquared: 16` (~4px); the
  zoom ratio follows from the default `zoomSpeed: 1` camera option — see
  `node_modules/@tldraw/editor/src/lib/constants.ts` and
  `node_modules/tldraw/src/lib/tools/SelectTool/childStates/Idle.ts`.
- `baselines/tldraw-perf.json` — `shapes-100`/`shapes-1000` load/pan/zoom frame
  stats + heap. Each key carries its own `_meta` (engine version, capturedAt,
  host) so a partial recapture never restamps scenarios it didn't rerun. At
  these sizes pan/zoom are vsync-locked (p50≈p95≈16.7ms, 0 drops) — `loadMs`
  and `heapMB` are the informative axes until Phase 3 adds heavier scenarios.
- `lib/` — `fixtures.ts` (pre-seeded identity storageState, dialog-throws-on-
  unexpected-prompt), `seed.ts` (agent HTTP API board seeding), `feel.ts` /
  `perf.ts` (golden read/write helpers).
- `playwright.config.ts` `webServer` boots the real stack: the server
  (`scripts/start-server.ts`, :8788, mkdtemp data dir owned + removed by the
  server process on SIGTERM) and the Vite client (`:5273`, so `:5173` stays
  free for the normal dev stack).

## Rules

- Seed rooms only through the agent HTTP API (`lib/seed.ts`) — the same
  surface bots/skills use, so the rig doubles as an API smoke suite.
- Deterministic by construction: fixed identity, viewport, camera, room names,
  and a fresh server data dir per run. A flaky baseline is a bug — fix the
  cause, never add retries (`retries: 0` in the config, on purpose).
- Goldens change only via a capture mode (`--update-snapshots` /
  `EW_CAPTURE=1`), committed with a message explaining why.
- Goldens are Linux-only: capture/update on Linux (devcontainer or CI), never
  a Mac — font/AA rendering differs enough to invalidate the pixel diffs.

## CI

`.github/workflows/e2e.yml`: the `e2e` project runs on PRs and manual dispatch
(not on the nightly schedule). A separate `perf-nightly` job runs the `perf`
project with `EW_CAPTURE=1` at 04:17 UTC (and on manual dispatch), uploading
`baselines/` as a 14-day artifact — it does not commit recaptured numbers.
Failures on either job upload `test-results/`/`playwright-report/`.

Goldens are captured on Arch; ubuntu-latest CI can antialias fonts slightly
differently, which `maxDiffPixelRatio: 0.02` usually absorbs. If a visual test
still fails on CI, pull the `e2e-failures` artifact and inspect the diff: if
it's pure antialiasing noise, regenerate the goldens *from CI* (`rm
goldens/visual/*.png` first, per the gotcha above) and commit the result.
