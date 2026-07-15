// Boots the real EnsembleWorks server for the e2e rig: fixed port 8788 (the
// Vite proxy target). Owns the per-run data dir lifecycle: when EW_E2E_DATA_DIR
// is unset (the normal Playwright path) it mkdtemps a fresh dir and removes it
// on shutdown. It can't be handed the dir by globalSetup: Playwright launches
// webServer commands during plugin setup, BEFORE globalSetup runs, so no
// env var set there reaches this process. Deletion relies on the config's
// webServer.gracefulShutdown (SIGTERM) — without it Playwright SIGKILLs and
// the exit hook never runs. Set EW_E2E_DATA_DIR to run against your own dir
// (then you own its cleanup). Run with: bun scripts/start-server.ts
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from '../../server/src/app.ts'

const external = process.env.EW_E2E_DATA_DIR
const dataDir = external ?? mkdtempSync(path.join(os.tmpdir(), 'ew-e2e-'))

if (!external) {
	process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }))
	for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0))
}

// EW_CANVAS_SYNC=1 (default ON for the e2e rig, unless a caller explicitly
// sets it) — mounts `/sync/v2/:roomId` (server/src/app.ts) so the new-engine
// dogfood E2E (canvas-v2.spec.ts's browser cases, Task H2) has a real actor
// to dial. This is ADDITIVE, not a behavior change for any other spec: it
// only ever ADDS the /sync/v2 route (gated separately from the legacy
// /sync/:roomId path every OTHER spec here exercises), and this e2e rig's
// Agent API v2 tests (the `/api/v2/canvas/*` read endpoints, this same file's
// original canvas-v2.spec.ts cases) convert live from the tldraw store
// (server/src/features/canvas-v2.ts) — a completely independent code path
// from EW_CANVAS_SYNC/the canvas-v2 actor registry, so turning this on
// changes nothing about them.
if (process.env.EW_CANVAS_SYNC === undefined) process.env.EW_CANVAS_SYNC = '1'

const { server } = createSyncApp({ dataDir })
server.listen(8788, () => console.log(`[e2e] server on :8788, data in ${dataDir}, EW_CANVAS_SYNC=${process.env.EW_CANVAS_SYNC}`))
