/**
 * EnsembleWorks sync app.
 *
 * The express app + websocket wiring behind the sync server, extracted so
 * tests can boot it in-process on an ephemeral port (see canvas-api.test.ts).
 *
 * Routes:
 * Feature routes live in ./features/*; this file is the kernel assembler —
 * it wires up storage/rooms/sessions/media into a PluginServerContext and
 * mounts each feature router in order. Only a couple of routes stay inline:
 *   GET  /api/health            – liveness probe
 *   GET  /api/terminal/list     – remote terminal gateway registry (spike)
 *   WS   /sync/:roomId          – tldraw sync (TLSocketRoom)
 *   GET  /files/*               – file-viewer proxy (outside /api, see below)
 *   GET  /*                     – static client build (production)
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { terminalList } from '@ensembleworks/contracts'
import { TLSocketRoom } from '@tldraw/sync-core'
import express from 'express'
import { type WebSocket, WebSocketServer } from 'ws'
import { getAccessIdentity } from './access-identity.ts'
import { sanitizeId } from './canvas/ids.ts'
import { createAvRouter } from './features/av.ts'
import { createDiscordRouter } from './features/discord.ts'
import { createFileViewerRouter } from './features/file-viewer.ts'
import { createFilesRouter } from './features/files.ts'
import { createFramesRouter } from './features/frames.ts'
import { createParticipantsRouter } from './features/participants.ts'
import { createRoadmapRouter } from './features/roadmap.ts'
import { createShapeRouter } from './features/shape.ts'
import { createStickyRouter } from './features/sticky.ts'
import { createTelemetryRouter } from './features/telemetry.ts'
import { createTerminalStatusRouter } from './features/terminal-status.ts'
import { createToolsRouter } from './features/tools.ts'
import { createTranscriptRouter } from './features/transcript.ts'
import { createUploadsRouter } from './features/uploads.ts'
import { createWhoamiRouter } from './features/whoami.ts'
import { createWriteScopeGuard } from './features/write-scope.ts'
import { createGatewayPlane } from './gateway-registry.ts'
import type { PluginServerContext } from './kernel/context.ts'
import { createMediaService } from './kernel/media.ts'
import { rawUserId } from './kernel/presence.ts'
import { createRoomHost } from './kernel/rooms.ts'
import { createSessionRegistry } from './kernel/sessions.ts'
import { createDiscordStore } from './discord-store.ts'
import { createRoadmapStore } from './roadmap-store.ts'
import { attachSyncSocket } from './sync-attach.ts'
import { classifyBackpressure } from './sync-backpressure.ts'
import { createTelemetryStore } from './telemetry-store.ts'
import { createTranscriptStore } from './transcript-store.ts'

export { buildParticipants, type CursorRef, type Participant } from './kernel/presence.ts'

export interface SyncApp {
	server: http.Server // not yet listening
	getOrCreateRoom(roomId: string): TLSocketRoom
	app: express.Express   // NEW — read-only test seam for route introspection
}

export function createSyncApp(opts: { dataDir: string; databaseDir?: string; clientDist?: string }): SyncApp {
	const uploadsDir = path.join(opts.dataDir, 'uploads')
	mkdirSync(uploadsDir, { recursive: true })
	const transcripts = createTranscriptStore(path.join(opts.dataDir, 'transcripts'))
	const roadmaps = createRoadmapStore(path.join(opts.dataDir, 'roadmaps'))
	const telemetry = createTelemetryStore(path.join(opts.dataDir, 'telemetry'))
	const discord = createDiscordStore(opts.dataDir)

	// Room DBs live under databaseDir (the fast boot disk in prod). The
	// dataDir/rooms fallback below is a TEST/LIB-ONLY convenience for the ~25
	// in-process test harnesses that construct createSyncApp({ dataDir }); the
	// prod entry point (sync-server.ts) validates the storage triple and always
	// passes databaseDir — an unset DATABASE_DIR no longer boots there (see
	// kernel/storage-geometry.ts and the 2026-07-11 required-database-dirs spec).
	const roomsDir = opts.databaseDir
		? path.join(opts.databaseDir, 'rooms')
		: path.join(opts.dataDir, 'rooms')

	const roomHost = createRoomHost(roomsDir)

	// EW_WARM_ROOMS=1 (default OFF — normal prod boot stays lazy): eagerly open
	// every rooms/*.sqlite through getOrCreateRoom, forcing each one through the
	// @tldraw schema at boot instead of on first WS connect / mutating call.
	// This is what the cutover data-load check needs: a freshly-fetched binary
	// booted against a COPY of the live DATA_DIR must prove every room still
	// loads under the new schema, not just that the process starts. If any
	// sqlite fails to load, getOrCreateRoom throws, createSyncApp throws, the
	// server never comes up, and the boot-check's health poll fails — a
	// deliberate fail-closed so a bad cutover aborts instead of shipping.
	if (process.env.EW_WARM_ROOMS === '1') {
		if (existsSync(roomsDir)) {
			for (const entry of readdirSync(roomsDir)) {
				if (!entry.endsWith('.sqlite')) continue
				const roomId = entry.slice(0, -'.sqlite'.length)
				roomHost.getOrCreateRoom(roomId)
				console.log(`[warm] loaded room ${roomId}`)
			}
		}
	}

	const registry = createSessionRegistry()
	const media = createMediaService()

	const ctx: PluginServerContext = {
		rooms: roomHost,
		sessions: registry,
		media,
		storage: { transcripts, roadmaps, telemetry, discord, uploadsDir },
	}

	// -------------------------------------------------------------------------
	// HTTP app
	// -------------------------------------------------------------------------

	const app = express()

	// Feature routers mount here IN THIS ORDER (Express matches top-down and the
	// static catch-all below must stay last): whoami → participants (kernel) → av
	// (av/token, av/kick, av/pulse) → terminal-status → sticky → file-viewer →
	// transcript → shape → frames → roadmap → uploads → files
	app.use('/api', express.json())

	// Write scoping: read-only service tokens are 403'd on mutating requests.
	app.use(createWriteScopeGuard())

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, rooms: [...roomHost.rooms.keys()] })
	})

	// Remote terminal gateways (spike): connect-equals-register + relay splicer.
	// See docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md
	const gatewayPlane = createGatewayPlane()
	app.get(terminalList.http.path, gatewayPlane.listHandler)   // path from the tool def

	// Auth-plane foundation: caller identity envelope (human|bot|anonymous).
	app.use(createWhoamiRouter())

	app.use(createParticipantsRouter(ctx))   // kernel-reserved: /api/participants

	app.use(createToolsRouter())             // kernel-reserved: GET /api/tools

	app.use(createAvRouter(ctx))

	// Canvas API (session MVP): lets agents flip the status light on their
	// terminal shape and post advice stickies, whether or not the room is open.

	app.use(createTerminalStatusRouter(ctx))

	app.use(createStickyRouter(ctx))

	app.use(createFileViewerRouter(ctx))

	app.use(createTranscriptRouter(ctx))
	app.use(createTelemetryRouter(ctx))       // POST /api/telemetry/connection (write-only beacon)

	app.use(createShapeRouter(ctx))

	app.use(createFramesRouter(ctx))

	// Roadmap (two-way roadmap control): the document lives in the roadmap
	// store, not the tldraw document — shapes hold only { roadmapId, rev }.
	app.use(createRoadmapRouter(ctx))

	app.use(createDiscordRouter(ctx))

	app.use(createUploadsRouter(ctx))

	// File-viewer proxy: also outside the /api json parser (GETs only, no body
	// to parse) and, like uploads, must sit above the static catch-all.
	app.use(createFilesRouter())

	// In production the sync server also serves the static client build; Caddy
	// just reverse-proxies everything here.
	const clientDist = opts.clientDist
	if (clientDist && existsSync(clientDist)) {
		app.use(express.static(clientDist))
		app.use((req, res, next) => {
			if (req.method === 'GET' && !req.path.startsWith('/api')) {
				res.sendFile(path.join(clientDist, 'index.html'))
			} else {
				next()
			}
		})
	}

	// -------------------------------------------------------------------------
	// WebSocket upgrade → TLSocketRoom
	// -------------------------------------------------------------------------

	const server = http.createServer(app)
	const wss = new WebSocketServer({ noServer: true })
	// Per-socket context for the backpressure sampler's log lines (WeakMap so a
	// closed socket's entry is collected with it).
	const syncMeta = new WeakMap<WebSocket, { roomId: string; userId: string; sessionId: string }>()

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '', 'http://internal')
		if (gatewayPlane.handleUpgrade(req, socket, head, url)) return
		const match = url.pathname.match(/^\/sync\/([^/]+)$/)
		const roomId = match ? sanitizeId(match[1]!) : null
		const sessionId = url.searchParams.get('sessionId')
		const userId = url.searchParams.get('userId')?.slice(0, 128)
		if (!roomId || !sessionId || !userId) {
			socket.destroy()
			return
		}
		// Sync traffic is small, frequent frames — cursor moves and incremental
		// edits. Disable Nagle so they aren't parked ~40ms waiting to coalesce,
		// which would add to round-trip lag for far-region users. The upgrade
		// event types `socket` as a generic Duplex; over HTTP/TCP it's a net.Socket.
		;(socket as Socket).setNoDelay(true)
		// Capture the caller's verified Cloudflare Access identity for co-author
		// attribution. Fire-and-forget so the WS handshake isn't delayed; identity
		// is needed only later, when a commit reads /api/participants.
		void getAccessIdentity(req.headers)
			.then((id) => {
				if (!id) return
				let m = registry.identitiesByUser.get(roomId)
				if (!m) registry.identitiesByUser.set(roomId, (m = new Map()))
				m.set(rawUserId(userId), id)
			})
			.catch(() => {})
		wss.handleUpgrade(req, socket, head, (ws) => {
			let roomUsers = registry.sessionsByUser.get(roomId)
			if (!roomUsers) registry.sessionsByUser.set(roomId, (roomUsers = new Map()))
			let userSessions = roomUsers.get(userId)
			if (!userSessions) roomUsers.set(userId, (userSessions = new Set()))
			userSessions.add(sessionId)
			syncMeta.set(ws, { roomId, userId, sessionId })
			console.log(`[sync] open room=${roomId} user=${userId} session=${sessionId}`)
			ws.on('error', (err) =>
				console.warn(`[sync] error room=${roomId} user=${userId} session=${sessionId}: ${err?.message ?? err}`)
			)
			ws.once('close', (code: number) => {
				console.log(`[sync] close room=${roomId} user=${userId} session=${sessionId} code=${code}`)
				userSessions.delete(sessionId)
				if (userSessions.size === 0) {
					roomUsers.delete(userId)
					registry.identitiesByUser.get(roomId)?.delete(rawUserId(userId))
				}
				if (roomUsers.size === 0) {
					registry.sessionsByUser.delete(roomId)
					registry.identitiesByUser.delete(roomId)
				}
			})
			attachSyncSocket(roomHost, ws, roomId, sessionId)
		})
	})

	// Backpressure: a client that can't drain its socket would grow bufferedAmount
	// unbounded and eventually OOM the shared sync process. Sample every ~10s;
	// warn when it crosses 1MB, close at 4MB (a fresh reconnect gets a clean
	// snapshot). unref() so this monitor never keeps the process alive in tests.
	const backpressure = setInterval(() => {
		for (const ws of wss.clients) {
			if (ws.readyState !== ws.OPEN) continue
			const verdict = classifyBackpressure(ws.bufferedAmount)
			if (verdict === 'ok') continue
			const m = syncMeta.get(ws)
			const tag = m ? `room=${m.roomId} user=${m.userId} session=${m.sessionId}` : 'room=?'
			const mb = (ws.bufferedAmount / (1024 * 1024)).toFixed(1)
			if (verdict === 'warn') {
				console.warn(`[sync] backpressure ${mb}MB buffered ${tag}`)
			} else {
				console.warn(`[sync] backpressure ${mb}MB — closing ${tag}`)
				ws.close(1013, 'backpressure')
			}
		}
	}, 10_000)
	backpressure.unref()

	// Event-loop lag: a 1s tick that logs when the observed gap exceeds the
	// scheduled 1s by more than 1s — direct evidence for/against event-loop
	// starvation (the incident's leading theory). unref() so it can't hold the
	// process open in tests.
	let lastTick = Date.now()
	const lagMonitor = setInterval(() => {
		const now = Date.now()
		const drift = now - lastTick - 1000
		lastTick = now
		if (drift > 1000) console.warn(`[sync] event-loop lag ${drift}ms`)
	}, 1000)
	lagMonitor.unref()

	return { server, getOrCreateRoom: roomHost.getOrCreateRoom, app }
}
