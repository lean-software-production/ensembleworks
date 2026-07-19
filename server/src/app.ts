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
import { type CanvasActors, createCanvasActors } from './canvas-v2/actors.ts'
import { ShadowMirror } from './canvas-v2/shadow.ts'
import { wsTransport } from './canvas-v2/ws-transport.ts'
import { createAvRouter } from './features/av.ts'
import { createCanvasMetricsRouter } from './features/canvas-metrics.ts'
import { createCanvasV2Router } from './features/canvas-v2.ts'
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

// Fixed peerId for every Task D3 ShadowMirror in this process. Per shadow.ts's
// class doc: mirror docs are single-peer and never merge with any other doc
// (never synced to a client, never mounted on /sync), so peerId collisions
// can't cause the corruption they would in a real multi-peer sync — any
// constant works, and a fixed one keeps mirror doc bytes reproducible across
// restarts for the same room.
const SHADOW_PEER_ID = 9999n

export interface SyncApp {
	server: http.Server // not yet listening
	getOrCreateRoom(roomId: string): TLSocketRoom
	app: express.Express   // NEW — read-only test seam for route introspection
	/** Phase 2 canvas-v2 actor registry — non-null exactly when EW_CANVAS_SYNC=1
	 * was set at construction time. Exposed for the mount integration test, and
	 * for the D3 metrics endpoint, which reads each actor's
	 * peer.pendingImports / peer.malformedFrames / tainted through it. */
	canvasActors: CanvasActors | null
	/** Task D3's clock-polled shadow driver — non-null exactly when
	 * EW_CANVAS_SHADOW=1 was set at construction time. Maps roomId to its
	 * ShadowMirror plus the last document clock value seen for that room.
	 * Exposed for tests and for the /api/canvas/metrics endpoint (same
	 * null-when-flag-off pattern as canvasActors above). */
	shadowMirrors: Map<string, { mirror: ShadowMirror; lastClock: number }> | null
	/** F2 graceful-shutdown hook: stops the shadow driver and idle-sweep
	 * intervals, force-closes every live ws client (legacy /sync AND
	 * canvas-v2 /sync/v2 — they share one `wss`), THEN persists + releases
	 * every canvas-v2 actor (canvasActors?.close(), which compacts on its way
	 * out), THEN closes the http server — bounded by shutdownTimeoutMs so a
	 * known race (see close()'s own doc comment) can never hang shutdown
	 * forever. Resolves once teardown is complete (or the bound is hit).
	 * Idempotent is NOT guaranteed by this method itself — callers (the
	 * process entrypoint) are responsible for calling it at most once, or for
	 * their own double-signal guard, same as every other lifecycle method in
	 * this codebase (cf. DocumentActor.close()'s explicit idempotence vs. this
	 * one's single-shot contract). */
	close(): Promise<void>
}

export function createSyncApp(opts: {
	dataDir: string
	databaseDir?: string
	clientDist?: string
	/** Task D3 test-only knob: how often the shadow driver's setInterval fires.
	 * Defaults to the real ~1000ms cadence; tests shrink this (e.g. 20-30ms) so
	 * they can observe several ticks without a multi-second sleep. Production
	 * callers never set this. */
	shadowIntervalMs?: number
	/** F1/F2 test-only knob: how often the canvas-v2 idle-eviction sweep fires.
	 * Defaults to a real ~5-minute cadence; tests shrink this so they can
	 * observe a sweep without a multi-minute sleep. Production callers never
	 * set this. Only relevant when EW_CANVAS_SYNC=1 (canvasActors non-null) —
	 * flag-off deployments never construct this interval. */
	idleSweepIntervalMs?: number
	/** F1 knob: how long a canvas-v2 room may sit with zero connections and no
	 * activity before sweepIdle() releases its DocumentActor (doc + SQLite
	 * handle). Defaults to 30 minutes — long enough that a dogfooder tabbing
	 * away and back doesn't pay a reload, short enough that an abandoned room
	 * doesn't hold a SQLite handle for the rest of the process's life. Tests
	 * shrink this to observe an eviction without a real wait. */
	idleTtlMs?: number
	/** F2 test-only knob: how long close() waits for http.Server's own close()
	 * callback before force-destroying any sockets it's still tracking and
	 * resolving anyway (see close()'s doc comment for the race this guards
	 * against). Defaults to a real ~3s bound; tests shrink this. */
	shutdownTimeoutMs?: number
}): SyncApp {
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

	// Phase 2 new-engine sync (Task C3), OFF by default — zero user exposure
	// until EW_CANVAS_SYNC=1 is set (see the gated upgrade branch below).
	// Constructed LAZILY, only when the flag is on, so a flag-off deployment
	// never creates the canvas-v2 directory or opens a single actor: the
	// registry itself (server/src/canvas-v2/actors.ts) is the only thing that
	// knows the on-disk layout (databaseDir/canvas-v2/<roomId>.sqlite).
	//
	// F2 shutdown wiring: `close()` (returned below, called from
	// sync-server.ts's SIGTERM/SIGINT handler) calls `canvasActors?.close()` —
	// see close()'s own doc comment for the full teardown order. roomHost
	// (the LEGACY tldraw rooms) still exposes no close() of its own: it relies
	// entirely on SQLite's own crash-safe append/commit semantics, same as
	// before this task — only the canvas-v2 side (this file's F1/F2 scope)
	// gained an explicit graceful-release path.
	const canvasActors = process.env.EW_CANVAS_SYNC === '1' ? createCanvasActors(opts.databaseDir ?? opts.dataDir) : null

	// Task D3: clock-polled shadow driver, gated on EW_CANVAS_SHADOW=1 and
	// INDEPENDENT of EW_CANVAS_SYNC above — this mirrors the LEGACY tldraw
	// rooms living in roomHost, not the canvas-v2 actors (those are already
	// covered by ShadowMirror's own pre-cutover purpose: telemetry ahead of the
	// real Phase 3/5 cutover, not a canvas-v2 concern). A single setInterval,
	// unref()'d like the backpressure sampler below so it never keeps the
	// process alive in tests. Every sweep (~1000ms, or opts.shadowIntervalMs
	// for tests): for each room roomHost currently knows about, compare
	// getCurrentDocumentClock() to the last value seen for that room and, on
	// change (including first sight, where lastClock starts at NaN — NaN !==
	// NaN unconditionally forces the first tick), call mirror.tick(). Gating on
	// the clock keeps an idle room's mirror motionless between edits: the
	// entire reason to clock-poll rather than tick every room unconditionally
	// every sweep.
	const shadowMirrors = process.env.EW_CANVAS_SHADOW === '1'
		? new Map<string, { mirror: ShadowMirror; lastClock: number }>()
		: null
	// Sweep bodies that threw, across all rooms and all sweeps. Lives OUTSIDE
	// ShadowMetrics deliberately: the dominant throw site is the clock read
	// (sync-core's SQLiteSyncStorage.getClock runs a live prepared-statement
	// query — a realistic disk-error throw site), which can fire BEFORE the
	// room's mirror even exists, so there may be no ShadowMetrics to count it
	// on. Surfaced as the metrics payload's top-level `sweepErrors`;
	// post-construction tick failures are ADDITIONALLY counted on that
	// mirror's own tickErrors/lastError (shadow.ts).
	let shadowSweepErrors = 0
	// Hoisted out of the `if` below (rather than `const`-scoped inside it) so
	// F2's close() can clearInterval() it on shutdown — see close()'s doc
	// comment. Stays undefined (nothing to clear) when EW_CANVAS_SHADOW is off.
	let shadowInterval: ReturnType<typeof setInterval> | undefined
	if (shadowMirrors) {
		shadowInterval = setInterval(() => {
			for (const roomId of roomHost.rooms.keys()) {
				// Per-room isolation: this body runs inside a setInterval callback,
				// where an uncaught throw is FATAL to the whole process (probe-proven:
				// one poisoned clock getter exited the process mid-sweep — the other
				// rooms' ticks never ran and HTTP/WS/AV died with it). tick()
				// self-guards, but the clock read and mirror construction sit outside
				// it — so the whole per-room body is wrapped for defense-in-depth:
				// count, log with the room id, continue to the next room. The failed
				// room just shows stale ticks until its storage recovers.
				try {
					const clock = roomHost.getOrCreateRoom(roomId).getCurrentDocumentClock()
					let entry = shadowMirrors.get(roomId)
					if (!entry) {
						entry = {
							mirror: new ShadowMirror(roomId, SHADOW_PEER_ID, () =>
								roomHost.getOrCreateRoom(roomId).getCurrentSnapshot().documents.map((d) => d.state as any)
							),
							lastClock: Number.NaN,
						}
						shadowMirrors.set(roomId, entry)
					}
					if (entry.lastClock !== clock) {
						entry.mirror.tick()
						entry.lastClock = clock
					}
				} catch (err) {
					shadowSweepErrors++
					console.error(`[shadow ${roomId}] sweep error — room skipped this sweep:`, err)
				}
			}
			// Bound the map to rooms roomHost still knows about each sweep — cheap,
			// and correct by construction if/when room eviction is ever added to
			// RoomHost. Today this is a NO-OP: kernel/rooms.ts's `rooms` map never
			// removes an entry once a room is opened (rooms live for the process
			// lifetime, per its own comments), so there is nothing to prove this
			// branch against yet — it exists so a future eviction doesn't silently
			// leak one ShadowMirror per ever-opened room forever.
			for (const roomId of shadowMirrors.keys()) {
				if (!roomHost.rooms.has(roomId)) shadowMirrors.delete(roomId)
			}
		}, opts.shadowIntervalMs ?? 1000)
		shadowInterval.unref()
	}

	// F1: idle-actor eviction sweep, gated the SAME way canvasActors itself is
	// (EW_CANVAS_SYNC=1) — there is nothing to sweep when the registry doesn't
	// exist. Own interval rather than piggybacking on the shadow driver above:
	// the two are independent concerns gated by independent flags (a deployment
	// can run EW_CANVAS_SYNC without EW_CANVAS_SHADOW, or vice versa), and
	// tying idle-sweep cadence to the shadow driver's would make its interval
	// do double duty for an unrelated flag. unref()'d like every other
	// interval in this file so it never keeps the process (or a test) alive.
	// registry.sweepIdle() is itself per-actor exception-safe (actors.ts), so
	// no additional try/catch is needed here.
	let idleSweepInterval: ReturnType<typeof setInterval> | undefined
	if (canvasActors) {
		const idleTtlMs = opts.idleTtlMs ?? 30 * 60_000
		idleSweepInterval = setInterval(() => {
			canvasActors.sweepIdle(idleTtlMs)
		}, opts.idleSweepIntervalMs ?? 5 * 60_000)
		idleSweepInterval.unref()
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
	// transcript → shape → frames → canvas-v2 → roadmap → discord →
	// canvas-metrics → uploads → files
	app.use('/api', express.json())

	// Write scoping: read-only service tokens are 403'd on mutating requests.
	app.use(createWriteScopeGuard())

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, rooms: [...roomHost.rooms.keys()] })
	})

	// TEST-ONLY cold-actor hook (2026-07-19, docs/plans/2026-07-19-v2-first-shape-perf-harness.md).
	// Forces an immediate idle sweep so the load-perf harness can measure a
	// genuinely COLD room actor — one that must reload its snapshot + replay its
	// oplog from SQLite — instead of the warm actor the harness's own wire
	// seeding just created. There is no other way to force this from outside the
	// process: sweepIdle is driven by an internal interval with no env knob.
	//
	// DOUBLE-GATED: requires BOTH EW_CANVAS_SYNC=1 (canvasActors exists at all)
	// AND EW_CANVAS_TEST_EVICT=1. Absent the second flag the route is never
	// registered, so a production deployment cannot evict a live room over HTTP
	// even if someone guesses the path.
	if (canvasActors && process.env.EW_CANVAS_TEST_EVICT === '1') {
		app.post('/api/canvas-v2/test/evict/:roomId', (_req, res) => {
			// TTL 0 = "every actor is idle enough". A live socket still vetoes
			// eviction (sweepIdle's own rule), which is correct: the harness closes
			// its seeder peers before calling this.
			canvasActors.sweepIdle(0)
			res.json({ ok: true })
		})
	}

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

	// Agent API v2 (read side, Phase 1): versioned reads of the new canvas-model
	// document, converted live from the same tldraw store as the routers above.
	app.use(createCanvasV2Router(ctx))

	// Roadmap (two-way roadmap control): the document lives in the roadmap
	// store, not the tldraw document — shapes hold only { roadmapId, rev }.
	app.use(createRoadmapRouter(ctx))

	app.use(createDiscordRouter(ctx))

	// D3 metrics (internal/ops-facing, NOT an agent tool — see the router's own
	// JSDoc and tools-api.test.ts's EXEMPT predicate): mounted UNCONDITIONALLY,
	// readable regardless of EW_CANVAS_SHADOW / EW_CANVAS_SYNC — both flags off
	// still returns { ok: true, shadow: {}, sync: {}, evictions: {} }.
	app.use(createCanvasMetricsRouter({ shadowMirrors, canvasActors, sweepErrors: () => shadowSweepErrors }))

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

	// F2 shutdown-race tracking: node's http.Server exposes no "list every
	// currently-open connection" API of its own, so close() (below) tracks raw
	// sockets itself via the 'connection' event (http.Server IS a net.Server —
	// this event fires for every TCP connection, ws upgrades included, before
	// the upgrade handler even runs). Needed because http.Server.close()'s
	// callback only fires once every tracked connection has ended — the
	// documented Phase 2 caveat is that an abruptly-terminated ws's underlying
	// socket can sit open past its 'close' event's other listeners running,
	// so close() force-destroys whatever's left in this set after a bounded
	// wait rather than trusting server.close() to always call back.
	const openSockets = new Set<Socket>()
	server.on('connection', (socket: Socket) => {
		openSockets.add(socket)
		socket.on('close', () => openSockets.delete(socket))
	})

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '', 'http://internal')
		if (gatewayPlane.handleUpgrade(req, socket, head, url)) return

		// Phase 2: new-engine sync (Task C3), gated on EW_CANVAS_SYNC=1 and
		// checked BEFORE the legacy /sync/:roomId match below (a real room id
		// could theoretically collide with the literal segment "v2", so the
		// more specific route must win). Real users never hit this: the flag
		// is off in every production deployment today and the client build
		// never references /sync/v2. `canvasActors` is non-null exactly when
		// this branch can be reached (see its construction above).
		if (canvasActors) {
			const v2Match = url.pathname.match(/^\/sync\/v2\/([^/]+)$/)
			if (v2Match) {
				const roomId = sanitizeId(v2Match[1]!)
				if (!roomId) {
					socket.destroy()
					return
				}
				;(socket as Socket).setNoDelay(true)
				// v2 sockets inherit the existing backpressure sampler for free:
				// handleUpgrade registers them on the SAME shared `wss`, and the
				// sampler (`const backpressure = setInterval(...)` below) iterates
				// `wss.clients` generically — v2 clients just log with `room=?`
				// (no syncMeta entry), and still get the warn/1013-close ladder.
				wss.handleUpgrade(req, socket, head, (ws) => {
					try {
						canvasActors.getOrCreate(roomId).connect(wsTransport(ws))
					} catch (err) {
						// getOrCreate can throw if constructing a fresh DocumentActor
						// fails (e.g. a corrupt on-disk log); connect() throws if the
						// actor was tainted by a concurrent persist failure between
						// getOrCreate and this callback. Either way: fail loud in the
						// log, close just this one socket (1011 = internal error) —
						// mirrors sync-attach.ts's guard for the legacy /sync path —
						// and leave every other room untouched.
						console.error(`[canvas-v2] room ${roomId} failed to attach — closing socket:`, err)
						ws.close(1011, 'room load failed')
					}
				})
				return
			}
		}

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

	/**
	 * F2 graceful shutdown. Order matters and is NOT arbitrary:
	 *
	 * 1. Stop every interval first — nothing here should observe a sweep or a
	 *    tick mid-teardown (an idle-sweep or shadow-tick racing step 2/3 below
	 *    would at best be wasted work, at worst touch an actor mid-close).
	 * 2. Force-close every live ws client — legacy /sync AND canvas-v2
	 *    /sync/v2 both register on this ONE shared `wss` (see the upgrade
	 *    handler above), so one loop covers both. `ws.terminate()`, not
	 *    `ws.close()`: terminate() drops the underlying TCP socket immediately
	 *    instead of waiting on the close handshake — this is the fix for the
	 *    documented Phase 2 caveat (this file's canvasActors construction-site
	 *    comment, historically): "http.Server.close() may never call back with
	 *    abruptly-terminated sockets in flight." Doing this BEFORE
	 *    canvasActors.close() also means every DocumentActor's final compact
	 *    (step 3) runs with no client able to shove in one more edit mid-close.
	 * 3. canvasActors?.close(): persists (close-path compact, per actor.ts)
	 *    and releases every canvas-v2 SQLite handle. Safe to call unconditionally
	 *    after step 2 — no transport can reach a peer's onFrame anymore.
	 * 4. server.close(): now that every ws (and the sockets they rode in on)
	 *    is gone, this SHOULD call back quickly. Bounded by shutdownTimeoutMs
	 *    anyway, because "should" isn't "will" — a keep-alive HTTP connection
	 *    with no ws on it is tracked in `openSockets` but not force-closed by
	 *    step 2, so the fallback below destroys whatever's left and resolves
	 *    regardless, so shutdown can never hang.
	 */
	async function close(): Promise<void> {
		if (shadowInterval) clearInterval(shadowInterval)
		if (idleSweepInterval) clearInterval(idleSweepInterval)
		clearInterval(backpressure)
		clearInterval(lagMonitor)

		for (const ws of wss.clients) {
			try {
				ws.terminate()
			} catch (err) {
				console.error('[shutdown] ws.terminate() threw (ignored, shutdown proceeds):', err)
			}
		}

		canvasActors?.close()

		const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 3000
		await new Promise<void>((resolve) => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				resolve()
			}
			server.close((err) => {
				if (err) console.error('[shutdown] http server close() callback reported an error (ignored, shutdown proceeds):', err)
				finish()
			})
			const fallback = setTimeout(() => {
				console.warn(
					`[shutdown] http server close() had not called back within ${shutdownTimeoutMs}ms — ` +
						`force-destroying ${openSockets.size} remaining socket(s) and proceeding (known Phase 2 close() race)`,
				)
				for (const socket of openSockets) socket.destroy()
				finish()
			}, shutdownTimeoutMs)
			fallback.unref()
		})
	}

	return { server, getOrCreateRoom: roomHost.getOrCreateRoom, app, canvasActors, shadowMirrors, close }
}
