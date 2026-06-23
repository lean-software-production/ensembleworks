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
import { createSyncApp } from './app.ts'

const PORT = Number(process.env.PORT ?? 8788)
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.join(import.meta.dirname, '../../client/dist')

const { server } = createSyncApp({ dataDir: DATA_DIR, clientDist: CLIENT_DIST })

server.listen(PORT, () => {
	console.log(`ensembleworks sync server listening on :${PORT}`)
	console.log(`  data dir: ${DATA_DIR}`)
	console.log(`  client build: ${existsSync(CLIENT_DIST) ? CLIENT_DIST : '(not built — dev mode)'}`)
})
