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
 *   GET  /api/gateway/list      – remote terminal gateway registry (spike)
 *   WS   /sync/:roomId          – tldraw sync (TLSocketRoom)
 *   GET  /*                     – static client build (production)
 */
import { existsSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { TLSocketRoom } from '@tldraw/sync-core'
import express from 'express'
import { WebSocketServer } from 'ws'
import { getAccessIdentity } from './access-identity.ts'
import { sanitizeId } from './canvas/ids.ts'
import { createAvRouter } from './features/av.ts'
import { createFramesRouter } from './features/frames.ts'
import { createRoadmapRouter } from './features/roadmap.ts'
import { createShapeRouter } from './features/shape.ts'
import { createStickyRouter } from './features/sticky.ts'
import { createTerminalStatusRouter } from './features/terminal-status.ts'
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
import { createRoadmapStore } from './roadmap-store.ts'
import { createTranscriptStore } from './transcript-store.ts'

export { buildParticipants, type CursorRef, type Participant } from './kernel/presence.ts'

export interface SyncApp {
	server: http.Server // not yet listening
	getOrCreateRoom(roomId: string): TLSocketRoom
}

export function createSyncApp(opts: { dataDir: string; clientDist?: string }): SyncApp {
	const uploadsDir = path.join(opts.dataDir, 'uploads')
	mkdirSync(uploadsDir, { recursive: true })
	const transcripts = createTranscriptStore(path.join(opts.dataDir, 'transcripts'))
	const roadmaps = createRoadmapStore(path.join(opts.dataDir, 'roadmaps'))

	const roomHost = createRoomHost(opts.dataDir)
	const registry = createSessionRegistry()
	const media = createMediaService()

	const ctx: PluginServerContext = {
		rooms: roomHost,
		sessions: registry,
		media,
		storage: { transcripts, roadmaps, uploadsDir },
	}

	// -------------------------------------------------------------------------
	// HTTP app
	// -------------------------------------------------------------------------

	const app = express()

	// Feature routers mount here IN THIS ORDER (today's registration order —
	// Express matches top-down and the static catch-all below must stay last):
	// av (livekit-token, kick, participants, pulse) → terminal-status → sticky
	// → transcript → shape → frames → roadmap → uploads
	app.use('/api', express.json())

	// Write scoping: read-only service tokens are 403'd on mutating requests.
	app.use(createWriteScopeGuard())

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, rooms: [...roomHost.rooms.keys()] })
	})

	// Remote terminal gateways (spike): connect-equals-register + relay splicer.
	// See docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md
	const gatewayPlane = createGatewayPlane()
	app.get('/api/gateway/list', gatewayPlane.listHandler)

	// Auth-plane foundation: caller identity envelope (human|bot|anonymous).
	app.use(createWhoamiRouter())

	app.use(createAvRouter(ctx))

	// Canvas API (session MVP): lets agents flip the status light on their
	// terminal shape and post advice stickies, whether or not the room is open.

	app.use(createTerminalStatusRouter(ctx))

	app.use(createStickyRouter(ctx))

	app.use(createTranscriptRouter(ctx))

	app.use(createShapeRouter(ctx))

	app.use(createFramesRouter(ctx))

	// Roadmap (two-way roadmap control): the document lives in the roadmap
	// store, not the tldraw document — shapes hold only { roadmapId, rev }.
	app.use(createRoadmapRouter(ctx))

	app.use(createUploadsRouter(ctx))

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
			ws.once('close', () => {
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
			roomHost.getOrCreateRoom(roomId).handleSocketConnect({ sessionId, socket: ws })
		})
	})

	return { server, getOrCreateRoom: roomHost.getOrCreateRoom }
}
