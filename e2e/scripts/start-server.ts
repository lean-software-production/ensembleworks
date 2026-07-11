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

const { server } = createSyncApp({ dataDir })
server.listen(8788, () => console.log(`[e2e] server on :8788, data in ${dataDir}`))
