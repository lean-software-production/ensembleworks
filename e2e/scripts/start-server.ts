// Boots the real EnsembleWorks server for the e2e rig: fixed port 8788 (the
// Vite proxy target), data dir from EW_E2E_DATA_DIR (fresh temp dir per run,
// created by playwright.config.ts). Run with: bun scripts/start-server.ts
import { createSyncApp } from '../../server/src/app.ts'

const dataDir = process.env.EW_E2E_DATA_DIR
if (!dataDir) throw new Error('EW_E2E_DATA_DIR not set — run via playwright, not directly')

const { server } = createSyncApp({ dataDir })
server.listen(8788, () => console.log(`[e2e] server on :8788, data in ${dataDir}`))
