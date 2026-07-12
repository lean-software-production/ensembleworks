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
import { resolveStorageGeometry } from './kernel/storage-geometry.ts'

const PORT = Number(process.env.PORT ?? 8788)
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.join(import.meta.dirname, '../../client/dist')

// The storage triple is REQUIRED and validated — a misconfigured box must
// refuse to start here, loudly, not corrupt a room DB 15 minutes later when
// the backup timer fires (the 2026-07-10 ew-lsp-001 outage). No fallbacks:
// prod supplies all three via ~/.config/ensembleworks/storage.env; dev/test
// harnesses set them explicitly. DATABASE_BACKUPS_DIR is validated here even
// though only the laingville backup units write to it — the sync server is
// the loud failure point; a dead oneshot backup unit is what went unnoticed.
let geometry
try {
	geometry = resolveStorageGeometry(process.env)
} catch (err) {
	console.error(`ensembleworks sync server: ${err instanceof Error ? err.message : err}`)
	process.exit(1)
}
const { dataDir: DATA_DIR, databaseDir: DATABASE_DIR, databaseBackupsDir: DATABASE_BACKUPS_DIR } = geometry

const { server, close } = createSyncApp({ dataDir: DATA_DIR, databaseDir: DATABASE_DIR, clientDist: CLIENT_DIST })

server.listen(PORT, () => {
	console.log(`ensembleworks sync server listening on :${PORT}`)
	console.log(`  data dir: ${DATA_DIR}`)
	console.log(`  database dir: ${DATABASE_DIR}`)
	console.log(`  database backups dir: ${DATABASE_BACKUPS_DIR} (written by the backup timer, validated here)`)
	console.log(`  client build: ${existsSync(CLIENT_DIST) ? CLIENT_DIST : '(not built — dev mode)'}`)
	console.log(`  auth posture: ${accessVerificationEnabled() ? 'verified (CF Access JWT signatures checked)' : 'header-trust (no CF_ACCESS_TEAM_DOMAIN/AUD — trusting edge headers)'}`)
})

// F2 graceful shutdown: the FIRST SIGTERM/SIGINT runs the full teardown
// (app.ts's close() — stops the shadow/idle-sweep intervals, force-closes
// every ws client, persists + releases every canvas-v2 actor, then closes the
// http server with its own bounded fallback) and exits 0 once it resolves. A
// SECOND signal received while that's still in flight means the operator
// wants OUT now (e.g. close() itself is hung on something its own bound
// didn't anticipate) — exit(1) immediately, no more teardown attempted.
let shuttingDown = false
function shutdown(signal: NodeJS.Signals): void {
	if (shuttingDown) {
		console.warn(`ensembleworks sync server: received ${signal} again during shutdown — exiting immediately`)
		process.exit(1)
	}
	shuttingDown = true
	console.log(`ensembleworks sync server: received ${signal}, shutting down gracefully...`)
	close()
		.then(() => {
			console.log('ensembleworks sync server: shutdown complete')
			process.exit(0)
		})
		.catch((err) => {
			console.error('ensembleworks sync server: shutdown hook threw — exiting anyway', err)
			process.exit(1)
		})
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
