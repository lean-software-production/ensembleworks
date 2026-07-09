/**
 * EnsembleWorks sync server — thin entry point.
 *
 * Self-hosted replacement for the Cloudflare Durable Objects backend of the
 * tldraw multiplayer starter kit. One process, one SQLite file per room.
 * All routes and websocket wiring live in app.ts (createSyncApp); this file
 * only parses the environment and starts listening.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { accessVerificationEnabled } from './access-identity.ts'
import { createSyncApp } from './app.ts'

const PORT = Number(process.env.PORT ?? 8788)
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const DATABASE_DIR = process.env.DATABASE_DIR // optional: fast boot-disk path for room DBs
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.join(import.meta.dirname, '../../client/dist')

const { server } = createSyncApp({ dataDir: DATA_DIR, databaseDir: DATABASE_DIR, clientDist: CLIENT_DIST })

server.listen(PORT, () => {
	console.log(`ensembleworks sync server listening on :${PORT}`)
	console.log(`  data dir: ${DATA_DIR}`)
	console.log(`  database dir: ${DATABASE_DIR ?? '(unset — room DBs under data dir)'}`)
	console.log(`  client build: ${existsSync(CLIENT_DIST) ? CLIENT_DIST : '(not built — dev mode)'}`)
	console.log(`  auth posture: ${accessVerificationEnabled() ? 'verified (CF Access JWT signatures checked)' : 'header-trust (no CF_ACCESS_TEAM_DOMAIN/AUD — trusting edge headers)'}`)
})
