/**
 * EnsembleWorks sync app.
 *
 * The express app + websocket wiring behind the sync server, extracted so
 * tests can boot it in-process on an ephemeral port (see canvas-api.test.ts).
 *
 * Routes:
 * Feature routes live in ./features/*; this block is the route index.
 *   GET  /api/health            – liveness probe
 *   GET  /api/livekit-token     – mint a LiveKit access token (M2)
 *   POST /api/kick              – disconnect one user from canvas + LiveKit
 *   POST /api/pulse             – VM pressure + per-user latency heartbeat
 *   POST /api/terminal-status   – flip the status light on a terminal shape
 *   POST /api/sticky            – post an advice sticky onto the canvas
 *   POST /api/transcript        – append a spoken utterance (transcriber bot)
 *   GET  /api/transcript        – read the transcript tail (minutes/map agents)
 *   POST /api/shape             – create/update/delete diagram shapes + arrows
 *   GET  /api/roadmap           – list roadmaps, or read one (?name=)
 *   POST /api/roadmap           – atomic op batch (replace | set | move)
 *   PUT  /uploads/:id           – store an asset (images dropped on the canvas)
 *   GET  /uploads/:id           – serve an asset
 *   WS   /sync/:roomId          – tldraw sync (TLSocketRoom)
 *   GET  /*                     – static client build (production)
 */
import { existsSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { slugify } from '@ensembleworks/contracts'
import { TLSocketRoom } from '@tldraw/sync-core'
import express from 'express'
import { WebSocketServer } from 'ws'
import { getAccessIdentity } from './access-identity.ts'
import { sanitizeId } from './canvas/ids.ts'
import { createAvRouter } from './features/av.ts'
import { createFramesRouter } from './features/frames.ts'
import { createShapeRouter } from './features/shape.ts'
import { createStickyRouter } from './features/sticky.ts'
import { createTerminalStatusRouter } from './features/terminal-status.ts'
import { createTranscriptRouter } from './features/transcript.ts'
import { createUploadsRouter } from './features/uploads.ts'
import { createGatewayPlane } from './gateway-registry.ts'
import type { PluginServerContext } from './kernel/context.ts'
import { createMediaService } from './kernel/media.ts'
import { rawUserId } from './kernel/presence.ts'
import { createRoomHost } from './kernel/rooms.ts'
import { createSessionRegistry } from './kernel/sessions.ts'
import { OpError, applyOps, createRoadmapStore, type RoadmapOp } from './roadmap-store.ts'
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

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, rooms: [...roomHost.rooms.keys()] })
	})

	// Remote terminal gateways (spike): connect-equals-register + relay splicer.
	// See docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md
	const gatewayPlane = createGatewayPlane()
	app.get('/api/gateway/list', gatewayPlane.listHandler)

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
	// GET /api/roadmap?room=[&name=] — without name: list; with name: full
	// document + rev (exact-id first, then fuzzy name match like /api/frame).
	app.get('/api/roadmap', async (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
		if (!name) {
			return void res.json({ ok: true, roadmaps: await roadmaps.list(roomId) })
		}
		const found = await roadmaps.get(roomId, name)
		if (!found) return void res.status(404).json({ error: 'roadmap not found' })
		res.json({
			ok: true,
			id: found.id,
			name: found.name,
			rev: found.rev,
			updated: found.updated,
			data: found.data,
		})
	})

	// POST /api/roadmap — one write path for humans (canvas drags/status
	// clicks) and agents (CLI): an all-or-nothing op batch. Creates the
	// roadmap when the batch starts with replace and nothing matches `name`.
	// ifRev guards wholesale regenerate-and-push flows against clobbering
	// edits that landed since the caller last read (409 carries current rev).
	app.post('/api/roadmap', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const name = typeof body.name === 'string' ? body.name.trim() : ''
		if (!name) return void res.status(400).json({ error: 'name is required' })
		if (name.length > 128) return void res.status(400).json({ error: 'name must be 128 characters or fewer' })
		const ifRev = typeof body.ifRev === 'number' && Number.isFinite(body.ifRev) ? body.ifRev : null

		// The store's lock serializes the whole read-modify-write; POST bodies
		// interleave across awaits, so without it two writers read the same rev.
		await roadmaps.withLock(roomId, async () => {
			const existing = await roadmaps.get(roomId, name)
			if (ifRev !== null && !existing) {
				return void res
					.status(409)
					.json({ error: `ifRev ${ifRev} given but no roadmap matches '${name}'` })
			}
			if (existing && ifRev !== null && ifRev !== existing.rev) {
				return void res
					.status(409)
					.json({ error: `stale ifRev ${ifRev} (current rev is ${existing.rev})`, rev: existing.rev })
			}

			let data
			try {
				data = applyOps(existing?.data ?? null, body.ops as RoadmapOp[])
			} catch (err) {
				if (err instanceof OpError) return void res.status(err.status).json({ error: err.message })
				return void res.status(400).json({ error: `invalid ops: ${err}` })
			}

			const id = existing?.id ?? slugify(name)
			if (!id) return void res.status(400).json({ error: 'name does not reduce to a valid id' })
			const rev = (existing?.rev ?? 0) + 1
			const updated = new Date().toISOString().slice(0, 10)
			data.meta.updated = updated // server-stamped; client-supplied values are ignored
			await roadmaps.write(roomId, id, { name: existing?.name ?? name, rev, updated, data })

			// Rev fan-out: stamp the new rev onto every shape bound to this roadmap
			// so tldraw sync broadcasts "data changed" and open clients refetch over
			// HTTP (the /api/terminal-status mechanism).
			// Fan-out is best-effort; the store write already succeeded.
			let shapesUpdated = 0
			try {
				await roomHost.getOrCreateRoom(roomId).updateStore((store) => {
					for (const record of store.getAll() as any[]) {
						if (
							record.typeName === 'shape' &&
							record.type === 'roadmap' &&
							record.props?.roadmapId === id
						) {
							store.put({ ...record, props: { ...record.props, rev } })
							shapesUpdated++
						}
					}
				})
			} catch (err) {
				console.warn(`[room ${roomId}] roadmap rev fan-out failed`, err)
			}
			res.json({ ok: true, id, rev, shapesUpdated })
		})
	})

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
