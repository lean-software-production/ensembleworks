/**
 * EnsembleWorks sync app.
 *
 * The express app + websocket wiring behind the sync server, extracted so
 * tests can boot it in-process on an ephemeral port (see canvas-api.test.ts).
 *
 * Routes:
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
import { readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createBindingId, createShapeId, toRichText } from '@tldraw/tlschema'
import { getIndexAbove, sortByIndex } from '@tldraw/utils'
import express from 'express'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { WebSocketServer } from 'ws'
import { type AccessIdentity, getAccessIdentity } from './access-identity.ts'
import { resolveRoomServiceUrl } from './livekit-url.ts'
import { schema } from './schema.ts'
import { OpError, applyOps, createRoadmapStore, slugify, type RoadmapOp } from './roadmap-store.ts'
import { createTranscriptStore } from './transcript-store.ts'
import { readVmStats } from './vm-stats.ts'

export interface SyncApp {
	server: http.Server // not yet listening
	getOrCreateRoom(roomId: string): TLSocketRoom
}

// LiveKit token endpoint configuration. The tldraw presence userId is used as
// the LiveKit participant identity, which is how the client matches video
// bubbles to cursors. When LiveKit isn't configured the client hides all A/V UI.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET
// Public signaling URL returned to browser clients (wss://…/livekit via tunnel).
const LIVEKIT_URL = process.env.LIVEKIT_URL
// Internal HTTP base for the server's own RoomService calls (kick). Co-located
// with livekit-server -> hit localhost and skip the tunnel + CF Access round
// trip. Defaults to the public URL's HTTP form for LiveKit Cloud.
const LIVEKIT_API_URL = process.env.LIVEKIT_API_URL
// Guard on the RESOLVED url, not on LIVEKIT_API_URL directly — otherwise
// pre-cutover (LiveKit Cloud, no LIVEKIT_API_URL) liveKitRoomService would be
// null and /api/kick's removeParticipant would silently stop working.
const roomServiceUrl = resolveRoomServiceUrl(LIVEKIT_URL, LIVEKIT_API_URL)
const liveKitRoomService =
	LIVEKIT_API_KEY && LIVEKIT_API_SECRET && roomServiceUrl
		? new RoomServiceClient(roomServiceUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
		: null

const TERMINAL_STATUSES = ['working', 'needs-you', 'done', 'idle']

// A per-user latency sample older than this is dropped from /api/pulse — the
// client polls every PULSE_INTERVAL (~30s, client-side), so this is ~2.5×
// that: a user who misses one beat still shows; one who left disappears.
const PULSE_STALE_MS = 75_000

// The note colours tldraw's default schema accepts (see TLDefaultColorStyle).
const NOTE_COLORS = [
	'black',
	'grey',
	'light-violet',
	'violet',
	'blue',
	'light-blue',
	'yellow',
	'orange',
	'green',
	'light-green',
	'light-red',
	'red',
	'white',
]

// In-frame stickies land on a simple grid: 3 per row, 220px columns/rows.
const STICKY_GRID_COLS = 3
const STICKY_GRID_STEP = 220

// The geo styles tldraw's default schema accepts (see GeoShapeGeoStyle).
const GEO_TYPES = [
	'cloud',
	'rectangle',
	'ellipse',
	'triangle',
	'diamond',
	'pentagon',
	'hexagon',
	'octagon',
	'star',
	'rhombus',
	'rhombus-2',
	'oval',
	'trapezoid',
	'arrow-right',
	'arrow-left',
	'arrow-up',
	'arrow-down',
	'x-box',
	'check-box',
	'heart',
]

function sanitizeId(id: string): string | null {
	return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null
}

// Recover plain text from a tldraw richText doc (the ProseMirror JSON that
// toRichText produces). Top-level paragraphs join with newlines; text nodes
// within a paragraph concatenate. The inverse of toRichText, server-side and
// without an Editor — used by the read endpoints to surface sticky/text bodies.
function richTextToPlainText(rich: any): string {
	if (!rich || !Array.isArray(rich.content)) return ''
	const textOf = (node: any): string => {
		if (!node) return ''
		if (typeof node.text === 'string') return node.text
		if (Array.isArray(node.content)) return node.content.map(textOf).join('')
		return ''
	}
	return rich.content.map(textOf).join('\n')
}

// --- Proximity ---------------------------------------------------------------
// The read endpoints sort their results by nearness to a teammate's live
// cursor, *when one is available*. Presence (cursor + currentPageId) is
// ephemeral and only exists while a browser tab is connected, so this is a
// best-effort overlay: with nobody connected the endpoints fall back to plain
// document order.

export interface CursorRef {
	userId: string | null
	userName: string
	currentPageId: string
	cursor: { x: number; y: number }
	// Camera + viewport, used to stamp the frame a speaker is *looking at* when
	// their mouse cursor isn't pointing inside a frame (null on tldraw versions
	// or presence records that omit them).
	camera: { x: number; y: number; z: number } | null
	screenBounds: { w: number; h: number } | null
	lastActivityTimestamp: number
}

// tldraw presence stores userId as a prefixed TLUserId ("user:abc"), but the
// LiveKit identity the scribe posts is the raw form ("abc"). Normalise both to
// raw before matching a speaker to their cursor.
function rawUserId(id: string | null): string {
	return (id ?? '').replace(/^user:/, '')
}

// Live presence records for a room, via the (internal, untyped) accessor.
// Guarded so a tldraw version without it just disables proximity sorting.
function getCursorRefs(room: any): CursorRef[] {
	let presence: Record<string, any> = {}
	try {
		presence = room.getPresenceRecords?.() ?? {}
	} catch {
		return []
	}
	return Object.values(presence)
		.filter((p: any) => p?.cursor && typeof p.currentPageId === 'string')
		.map((p: any) => ({
			userId: typeof p.userId === 'string' ? p.userId : null,
			userName: typeof p.userName === 'string' ? p.userName : 'teammate',
			currentPageId: p.currentPageId,
			cursor: { x: p.cursor.x, y: p.cursor.y },
			camera:
				p.camera && typeof p.camera.x === 'number' && typeof p.camera.y === 'number'
					? { x: p.camera.x, y: p.camera.y, z: typeof p.camera.z === 'number' ? p.camera.z : 1 }
					: null,
			screenBounds:
				p.screenBounds && typeof p.screenBounds.w === 'number' && typeof p.screenBounds.h === 'number'
					? { w: p.screenBounds.w, h: p.screenBounds.h }
					: null,
			lastActivityTimestamp: p.lastActivityTimestamp ?? 0,
		}))
}

// A person currently connected to a room, as reported to /api/participants —
// the join of live presence (name + page) with their captured Cloudflare Access
// identity (email). `email` is null when their identity wasn't captured (dev /
// header-trust gaps); `pageId` is the tldraw page they're on.
export interface Participant {
	userId: string
	name: string
	email: string | null
	verified: boolean
	pageId: string
}

// Join live presence with captured Access identities into a deduped participant
// list. With `page` set, only people on that tldraw page are included — this is
// the co-author rule: present in the same room AND on the same page. Pure, so
// it's unit-tested directly.
export function buildParticipants(
	refs: CursorRef[],
	identities: Map<string, AccessIdentity> | undefined,
	page?: string | null,
): Participant[] {
	const byUser = new Map<string, Participant>()
	for (const ref of refs) {
		if (page && ref.currentPageId !== page) continue
		const uid = rawUserId(ref.userId)
		if (!uid || byUser.has(uid)) continue
		const id = identities?.get(uid)
		byUser.set(uid, {
			userId: uid,
			name: ref.userName,
			email: id?.email ?? null,
			verified: id?.verified ?? false,
			pageId: ref.currentPageId,
		})
	}
	return [...byUser.values()]
}

// The page point at the centre of a speaker's viewport — what they're looking
// at — from their camera + screen size. tldraw screen→page is
// page = (screen - screenBounds) / z - camera, evaluated at the screen centre.
function viewportCenter(ref: CursorRef): { x: number; y: number } | null {
	if (!ref.camera || !ref.screenBounds) return null
	const z = ref.camera.z || 1
	return {
		x: ref.screenBounds.w / 2 / z - ref.camera.x,
		y: ref.screenBounds.h / 2 / z - ref.camera.y,
	}
}

// The most-recently-active cursor, optionally restricted to one page (a cursor
// on another page can't meaningfully order shapes on this one).
function pickCursor(refs: CursorRef[], pageId?: string): CursorRef | null {
	const candidates = pageId ? refs.filter((r) => r.currentPageId === pageId) : refs
	if (!candidates.length) return null
	return candidates.reduce((a, b) => (b.lastActivityTimestamp > a.lastActivityTimestamp ? b : a))
}

// The page id a shape ultimately lives on (walks up nested parents).
function pageIdOf(shape: any, byId: Map<string, any>): string | null {
	let pid: string | undefined = shape.parentId
	let guard = 0
	while (pid && pid.startsWith('shape:') && guard++ < 50) {
		pid = byId.get(pid)?.parentId
	}
	return pid ?? null
}

// A shape's top-left in page coordinates (child x/y are parent-relative).
function pagePoint(shape: any, byId: Map<string, any>): { x: number; y: number } {
	let x = shape.x ?? 0
	let y = shape.y ?? 0
	let parent = byId.get(shape.parentId)
	let guard = 0
	while (parent && parent.typeName === 'shape' && guard++ < 50) {
		x += parent.x ?? 0
		y += parent.y ?? 0
		parent = byId.get(parent.parentId)
	}
	return { x, y }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y)
}

// The frame a point is inside of (dist 0), or the nearest one on the same
// page (distance to the frame's edge). Used to stamp transcript entries with
// *where* the speaker was — "at the drafting table" — so minutes and the
// conversation map can segment by place.
function frameAtPoint(
	shapes: any[],
	byId: Map<string, any>,
	pageId: string,
	point: { x: number; y: number }
): { name: string; dist: number } | null {
	let best: { name: string; dist: number } | null = null
	for (const f of shapes) {
		if (f.type !== 'frame' || pageIdOf(f, byId) !== pageId) continue
		const pt = pagePoint(f, byId)
		const w = f.props?.w ?? 0
		const h = f.props?.h ?? 0
		// Distance from the point to the frame rect (0 when inside).
		const dx = Math.max(pt.x - point.x, 0, point.x - (pt.x + w))
		const dy = Math.max(pt.y - point.y, 0, point.y - (pt.y + h))
		const d = Math.hypot(dx, dy)
		if (!best || d < best.dist) {
			best = { name: typeof f.props?.name === 'string' ? f.props.name : '', dist: Math.round(d) }
		}
	}
	return best
}

// Sort items (each carrying a page-space `pt`) by distance to the cursor,
// attaching a rounded `dist`. Returns a new array; input order on a tie is
// preserved. With no cursor, returns the items unchanged and undistanced.
function byProximity<T extends { pt: { x: number; y: number } }>(
	items: T[],
	cursor: CursorRef | null
): Array<Omit<T, 'pt'> & { dist: number | null }> {
	const decorated = items.map((it, i) => {
		const { pt, ...rest } = it
		const d = cursor ? dist(pt, cursor.cursor) : null
		return { rest, d, i }
	})
	if (cursor) decorated.sort((a, b) => a.d! - b.d! || a.i - b.i)
	return decorated.map((e) => ({ ...(e.rest as Omit<T, 'pt'>), dist: e.d === null ? null : Math.round(e.d) }))
}

export function createSyncApp(opts: { dataDir: string; clientDist?: string }): SyncApp {
	const roomsDir = path.join(opts.dataDir, 'rooms')
	const uploadsDir = path.join(opts.dataDir, 'uploads')
	mkdirSync(roomsDir, { recursive: true })
	mkdirSync(uploadsDir, { recursive: true })
	const transcripts = createTranscriptStore(path.join(opts.dataDir, 'transcripts'))
	const roadmaps = createRoadmapStore(path.join(opts.dataDir, 'roadmaps'))

	// -------------------------------------------------------------------------
	// Rooms: one TLSocketRoom per room ID, persisted via SQLite. Storage commits
	// transactionally on every change, so there is no debounced-save dance and
	// the room survives process restarts (M0 exit criterion).
	// -------------------------------------------------------------------------

	const rooms = new Map<string, TLSocketRoom>()
	const sessionsByUser = new Map<string, Map<string, Set<string>>>()
	// Verified Cloudflare Access identity per connected user (roomId -> rawUserId
	// -> identity), captured at WS upgrade from the Cf-Access headers and read by
	// /api/participants. Cleared when the user's last session closes, so it only
	// ever covers currently-connected people.
	const identitiesByUser = new Map<string, Map<string, AccessIdentity>>()
	// Most-recent client-measured round-trip per connected user (roomId ->
	// rawUserId -> { rtt ms, t }). Reported and read back via POST /api/pulse;
	// pruned by age on every read so it only ever reflects live participants.
	const latencyByUser = new Map<string, Map<string, { rtt: number; t: number }>>()

	function getOrCreateRoom(roomId: string): TLSocketRoom {
		let room = rooms.get(roomId)
		if (room && !room.isClosed()) return room
		const db = new DatabaseSync(path.join(roomsDir, `${roomId}.sqlite`))
		const storage = new SQLiteSyncStorage({ sql: new NodeSqliteWrapper(db) })
		room = new TLSocketRoom({
			storage,
			schema,
			log: {
				warn: (...args) => console.warn(`[room ${roomId}]`, ...args),
				error: (...args) => console.error(`[room ${roomId}]`, ...args),
			},
		})
		rooms.set(roomId, room)
		console.log(`[room ${roomId}] opened`)
		return room
	}

	// -------------------------------------------------------------------------
	// HTTP app
	// -------------------------------------------------------------------------

	const app = express()

	app.use('/api', express.json())

	app.get('/api/health', (_req, res) => {
		res.json({ ok: true, rooms: [...rooms.keys()] })
	})

	app.get('/api/livekit-token', async (req, res) => {
		if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
			res.json({ enabled: false })
			return
		}
		const room = sanitizeId(String(req.query.room ?? ''))
		const identity = String(req.query.identity ?? '').slice(0, 128)
		const name = String(req.query.name ?? 'teammate').slice(0, 64)
		// role=scribe mints a subscribe-only token for the transcriber bot: it
		// hears every track but can never publish audio/video into the room.
		const role = String(req.query.role ?? 'member')
		if (!room || !identity) {
			res.status(400).json({ error: 'room and identity are required' })
			return
		}
		if (role !== 'member' && role !== 'scribe') {
			res.status(400).json({ error: 'role must be member or scribe' })
			return
		}
		const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
			identity,
			name,
			ttl: '12h',
		})
		token.addGrant({
			room: `canvas-${room}`,
			roomJoin: true,
			canPublish: role === 'member',
			canSubscribe: true,
		})
		res.json({ enabled: true, token: await token.toJwt(), url: LIVEKIT_URL })
	})

	app.post('/api/kick', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? ''))
		const userId = typeof body.userId === 'string' ? body.userId.slice(0, 128) : ''
		if (!roomId || !userId) {
			return void res.status(400).json({ error: 'room and userId are required' })
		}

		const room = rooms.get(roomId)
		const sessionIds = [...(sessionsByUser.get(roomId)?.get(userId) ?? [])]
		for (const sessionId of sessionIds) {
			room?.sendCustomMessage(sessionId, { type: 'kicked' })
			room?.closeSession(sessionId, 'PERMISSION_DENIED')
		}

		if (liveKitRoomService) {
			try {
				await liveKitRoomService.removeParticipant(`canvas-${roomId}`, userId)
			} catch (error) {
				if (!(error instanceof Error && 'status' in error && error.status === 404)) {
					console.warn(`[room ${roomId}] LiveKit kick failed for ${userId}`, error)
				}
			}
		}

		res.json({ ok: true, disconnected: sessionIds.length })
	})

	// Who is currently in a room — live presence joined with each person's
	// verified Cloudflare Access identity. With ?page= it's filtered to one
	// tldraw page, which is the git co-author rule (same room AND page). The
	// commit tool reads this to build `Co-authored-by` trailers.
	app.get('/api/participants', (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const page = req.query.page ? String(req.query.page) : null
		const room = rooms.get(roomId)
		const refs = room && !room.isClosed() ? getCursorRefs(room) : []
		res.json({
			room: roomId,
			page,
			participants: buildParticipants(refs, identitiesByUser.get(roomId), page),
		})
	})

	// Session pulse: one heartbeat that carries both features in the "In session"
	// panel. The client measures the round-trip of its *previous* pulse and
	// reports it here (rttMs); the server records it, prunes stale samples, and
	// returns the live per-user latency map plus a single shared VM-pressure
	// reading. One client timer, one endpoint, no extra storage or schema.
	app.post('/api/pulse', (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const userId = typeof body.userId === 'string' ? rawUserId(body.userId.slice(0, 128)) : ''
		const rtt =
			typeof body.rttMs === 'number' && Number.isFinite(body.rttMs) && body.rttMs >= 0
				? Math.min(60_000, Math.round(body.rttMs))
				: null
		const now = Date.now()

		let room = latencyByUser.get(roomId)
		if (!room) latencyByUser.set(roomId, (room = new Map()))
		if (userId && rtt !== null) room.set(userId, { rtt, t: now })

		const latencies: Record<string, { rtt: number; t: number }> = {}
		for (const [uid, sample] of room) {
			if (now - sample.t > PULSE_STALE_MS) room.delete(uid)
			else latencies[uid] = sample
		}
		if (room.size === 0) latencyByUser.delete(roomId)

		res.json({ ok: true, now, vm: readVmStats(now), latencies })
	})

	// Canvas API (session MVP): lets agents flip the status light on their
	// terminal shape and post advice stickies, whether or not the room is open.

	app.post('/api/terminal-status', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null
		const status = typeof body.status === 'string' ? body.status : ''
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!sessionId) return void res.status(400).json({ error: 'sessionId is required' })
		if (!TERMINAL_STATUSES.includes(status)) {
			return void res
				.status(400)
				.json({ error: `status must be one of ${TERMINAL_STATUSES.join(' | ')}` })
		}
		let updated = 0
		await getOrCreateRoom(roomId).updateStore((store) => {
			for (const record of store.getAll() as any[]) {
				if (
					record.typeName === 'shape' &&
					record.type === 'terminal' &&
					record.props?.sessionId === sessionId
				) {
					store.put({ ...record, props: { ...record.props, status } })
					updated++
				}
			}
		})
		res.json({ ok: true, updated })
	})

	app.post('/api/sticky', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const text = typeof body.text === 'string' ? body.text.trim() : ''
		const frame = typeof body.frame === 'string' ? body.frame : null
		const color = typeof body.color === 'string' ? body.color : 'yellow'
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!text || text.length > 2000) {
			return void res.status(400).json({ error: 'text must be non-empty and at most 2000 chars' })
		}
		if (!NOTE_COLORS.includes(color)) {
			return void res.status(400).json({ error: `color must be one of ${NOTE_COLORS.join(' | ')}` })
		}
		let createdId: string | null = null
		let frameFound = true
		await getOrCreateRoom(roomId).updateStore((store) => {
			const records = store.getAll() as any[]
			const shapes = records.filter((r) => r.typeName === 'shape')

			let parentId: string
			let x: number
			let y: number
			if (frame) {
				const target = shapes.find(
					(r) =>
						r.type === 'frame' &&
						typeof r.props?.name === 'string' &&
						r.props.name.toLowerCase().includes(frame.toLowerCase())
				)
				if (!target) {
					frameFound = false
					return
				}
				parentId = target.id
				// Grid inside the frame, based on how many notes it already holds.
				const count = shapes.filter((r) => r.type === 'note' && r.parentId === parentId).length
				x = 20 + (count % STICKY_GRID_COLS) * STICKY_GRID_STEP
				y = 20 + Math.floor(count / STICKY_GRID_COLS) * STICKY_GRID_STEP
			} else {
				// No frame: page origin area, offset by note count so stickies
				// don't stack exactly.
				parentId = records.find((r) => r.typeName === 'page')?.id ?? 'page:page'
				const count = shapes.filter((r) => r.type === 'note' && r.parentId === parentId).length
				x = count * 40
				y = count * 40
			}

			const siblings = shapes.filter(
				(r) => r.parentId === parentId && typeof r.index === 'string'
			)
			const topIndex = siblings.length ? siblings.sort(sortByIndex).at(-1)!.index : undefined
			const id = createShapeId()
			const note = (schema.types.shape as any).create({
				id,
				type: 'note',
				parentId,
				index: getIndexAbove(topIndex),
				x,
				y,
				props: {
					richText: toRichText(text),
					color,
					labelColor: 'black',
					size: 'm',
					font: 'draw',
					// Multiplier on the label font size (1 = unadjusted). 0 would
					// render the text at 0px — i.e. an invisible label.
					fontSizeAdjustment: 1,
					align: 'middle',
					verticalAlign: 'middle',
					growY: 0,
					url: '',
					scale: 1,
					textFirstEditedBy: null,
				},
			})
			store.put(note)
			createdId = id
		})
		if (!frameFound) return void res.status(404).json({ error: 'frame not found' })
		res.json({ ok: true, id: createdId })
	})

	// Transcript (voice → text): the transcriber bot appends one entry per
	// spoken utterance; minutes/map agents poll the tail with ?since=. Each
	// entry is stamped with the speaker's live cursor + nearest frame when a
	// canvas tab is open — the scribe posts the raw LiveKit identity, which
	// equals the tldraw presence userId once its "user:" prefix is stripped.

	app.post('/api/transcript', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		const identity = typeof body.identity === 'string' ? body.identity.slice(0, 128) : ''
		const name = typeof body.name === 'string' && body.name ? body.name.slice(0, 64) : identity
		const text = typeof body.text === 'string' ? body.text.trim() : ''
		const t = typeof body.t === 'number' && Number.isFinite(body.t) ? body.t : undefined
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!identity) return void res.status(400).json({ error: 'identity is required' })
		if (!text || text.length > 4000) {
			return void res.status(400).json({ error: 'text must be non-empty and at most 4000 chars' })
		}

		// Best-effort spatial stamp: which frame was this speaker at, and at what
		// point? Their mouse cursor is the strongest signal *when it's actually
		// inside a frame* (they're pointing at something) — but since the camera
		// bubble was decoupled from the cursor, a talking speaker's cursor is just
		// the native tldraw pointer, usually parked off-canvas. So otherwise we
		// locate them by their viewport centre (what they're looking at), and
		// record that same point so `at` and `frame` always agree.
		const room = getOrCreateRoom(roomId)
		const want = rawUserId(identity)
		const ref = getCursorRefs(room).find((r) => rawUserId(r.userId) === want) ?? null
		let frame: { name: string; dist: number } | null = null
		let at: { x: number; y: number } | null = null
		if (ref) {
			const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
			const byId = new Map(records.map((r) => [r.id, r]))
			const shapes = records.filter((r) => r.typeName === 'shape')
			const atCursor = frameAtPoint(shapes, byId, ref.currentPageId, ref.cursor)
			if (atCursor && atCursor.dist === 0) {
				frame = atCursor
				at = ref.cursor
			} else {
				const view = viewportCenter(ref)
				at = view ?? ref.cursor
				frame = frameAtPoint(shapes, byId, ref.currentPageId, at)
			}
		}

		const entry = await transcripts.append(roomId, {
			identity,
			name,
			text,
			t,
			page: ref?.currentPageId ?? null,
			cursor: at ? { x: Math.round(at.x), y: Math.round(at.y) } : null,
			frame,
		})
		res.json({ ok: true, entry })
	})

	// GET /api/transcript?room=&since=&limit= — entries with t > since, oldest
	// first. `now` is the server clock so pollers can chain since=now without
	// trusting their own clock.
	app.get('/api/transcript', async (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const since = Number(req.query.since ?? 0)
		const limit = Number(req.query.limit ?? 1000)
		if (!Number.isFinite(since) || since < 0) {
			return void res.status(400).json({ error: 'since must be a ms-epoch number' })
		}
		if (!Number.isFinite(limit) || limit < 1) {
			return void res.status(400).json({ error: 'limit must be a positive number' })
		}
		const entries = await transcripts.read(roomId, { since, limit })
		res.json({ ok: true, now: Date.now(), entries })
	})

	// Diagram plane: a generic shape endpoint so agents can *maintain* a live
	// drawing (conversation map, dialogue threads) rather than only append
	// stickies. Three ops in one route:
	//   create — { type: geo|text|note|arrow, frame?, x?, y?, text?, … }
	//            arrows take { fromId, toId } and get real tldraw bindings,
	//            so the connector follows when humans drag the nodes around.
	//   update — { id, text?, x?, y?, w?, h?, color?, fill?, geo?, props? }
	//   delete — { id } (cascades bindings touching the shape)

	app.post('/api/shape', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const op = typeof body.op === 'string' ? body.op : 'create'

		const text = typeof body.text === 'string' ? body.text : undefined
		const color = typeof body.color === 'string' ? body.color : undefined
		if (color && !NOTE_COLORS.includes(color)) {
			return void res.status(400).json({ error: `color must be one of ${NOTE_COLORS.join(' | ')}` })
		}
		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

		// ---- delete -----------------------------------------------------------
		if (op === 'delete') {
			const id = typeof body.id === 'string' ? body.id : ''
			if (!id) return void res.status(400).json({ error: 'id is required' })
			let deleted = 0
			await getOrCreateRoom(roomId).updateStore((store) => {
				const records = store.getAll() as any[]
				const target = records.find((r) => r.id === id)
				if (!target) return
				store.delete(id)
				deleted++
				// A shape's arrows must not keep pointing at a ghost.
				for (const r of records) {
					if (r.typeName === 'binding' && (r.fromId === id || r.toId === id)) {
						store.delete(r.id)
						deleted++
					}
				}
			})
			if (!deleted) return void res.status(404).json({ error: 'shape not found' })
			return void res.json({ ok: true, deleted })
		}

		// ---- update -----------------------------------------------------------
		if (op === 'update') {
			const id = typeof body.id === 'string' ? body.id : ''
			if (!id) return void res.status(400).json({ error: 'id is required' })
			let found = false
			try {
				await getOrCreateRoom(roomId).updateStore((store) => {
					const record = (store.getAll() as any[]).find(
						(r) => r.typeName === 'shape' && r.id === id
					)
					if (!record) return
					found = true
					const props = { ...record.props }
					if (text !== undefined) props.richText = toRichText(text)
					for (const key of ['w', 'h'] as const) {
						const v = num(body[key])
						if (v !== undefined && key in props) props[key] = v
					}
					if (color && 'color' in props) props.color = color
					if (typeof body.fill === 'string' && 'fill' in props) props.fill = body.fill
					if (typeof body.geo === 'string' && 'geo' in props) {
						if (!GEO_TYPES.includes(body.geo)) throw new Error('bad geo')
						props.geo = body.geo
					}
					// Raw prop merge for anything the shorthands don't cover; the
					// schema validates on put, so junk turns into a 400 below.
					if (body.props && typeof body.props === 'object') Object.assign(props, body.props)
					const next = { ...record, props }
					if (num(body.x) !== undefined) next.x = num(body.x)
					if (num(body.y) !== undefined) next.y = num(body.y)
					store.put(next)
				})
			} catch (err) {
				return void res.status(400).json({ error: `invalid update: ${err}` })
			}
			if (!found) return void res.status(404).json({ error: 'shape not found' })
			return void res.json({ ok: true, id })
		}

		if (op !== 'create') {
			return void res.status(400).json({ error: 'op must be create | update | delete' })
		}

		// ---- create -----------------------------------------------------------
		const type = typeof body.type === 'string' ? body.type : ''
		if (!['geo', 'text', 'note', 'arrow'].includes(type)) {
			return void res.status(400).json({ error: 'type must be geo | text | note | arrow' })
		}
		const frameName = typeof body.frame === 'string' ? body.frame : null
		let createdId: string | null = null
		let problem: { status: number; error: string } | null = null

		try {
			await getOrCreateRoom(roomId).updateStore((store) => {
				const records = store.getAll() as any[]
				const byId = new Map(records.map((r) => [r.id, r]))
				const shapes = records.filter((r) => r.typeName === 'shape')

				// Resolve the parent: a fuzzy-matched frame, or the (first) page.
				let parentId = records.find((r) => r.typeName === 'page')?.id ?? 'page:page'
				if (frameName) {
					const target = shapes.find(
						(r) =>
							r.type === 'frame' &&
							typeof r.props?.name === 'string' &&
							r.props.name.toLowerCase().includes(frameName.toLowerCase())
					)
					if (!target) {
						problem = { status: 404, error: 'frame not found' }
						return
					}
					parentId = target.id
				}
				const siblings = shapes.filter(
					(r) => r.parentId === parentId && typeof r.index === 'string'
				)
				const topIndex = siblings.length ? siblings.sort(sortByIndex).at(-1)!.index : undefined
				const id = createShapeId()
				const base = {
					id,
					typeName: 'shape' as const,
					parentId,
					index: getIndexAbove(topIndex),
					x: num(body.x) ?? 0,
					y: num(body.y) ?? 0,
					rotation: 0,
					isLocked: false,
					opacity: 1,
					meta: {},
				}

				if (type === 'arrow') {
					const fromId = typeof body.fromId === 'string' ? body.fromId : ''
					const toId = typeof body.toId === 'string' ? body.toId : ''
					const from = byId.get(fromId)
					const to = byId.get(toId)
					if (!from || !to || from.typeName !== 'shape' || to.typeName !== 'shape') {
						problem = { status: 404, error: 'arrow fromId/toId must be existing shape ids' }
						return
					}
					// Local start/end approximate the node centres; the bindings are
					// what actually pin the terminals once a client renders the room.
					const centre = (s: any) => {
						const pt = pagePoint(s, byId)
						return { x: pt.x + (s.props?.w ?? 200) / 2, y: pt.y + (s.props?.h ?? 200) / 2 }
					}
					const a = centre(from)
					const b = centre(to)
					store.put({
						...base,
						type: 'arrow',
						parentId: from.parentId, // live beside the nodes it connects
						x: a.x,
						y: a.y,
						props: {
							kind: 'arc',
							labelColor: 'black',
							color: color ?? 'black',
							fill: 'none',
							dash: 'draw',
							size: 's',
							arrowheadStart: 'none',
							arrowheadEnd: 'arrow',
							font: 'draw',
							start: { x: 0, y: 0 },
							end: { x: b.x - a.x, y: b.y - a.y },
							bend: 0,
							richText: toRichText(text ?? ''),
							labelPosition: 0.5,
							scale: 1,
							elbowMidPoint: 0.5,
						},
					} as any)
					for (const [terminal, target] of [
						['start', fromId],
						['end', toId],
					] as const) {
						store.put({
							id: createBindingId(),
							typeName: 'binding',
							type: 'arrow',
							fromId: id,
							toId: target,
							meta: {},
							props: {
								terminal,
								normalizedAnchor: { x: 0.5, y: 0.5 },
								isExact: false,
								isPrecise: false,
								snap: 'none',
							},
						} as any)
					}
				} else if (type === 'geo') {
					const geo = typeof body.geo === 'string' ? body.geo : 'rectangle'
					if (!GEO_TYPES.includes(geo)) {
						problem = { status: 400, error: `geo must be one of ${GEO_TYPES.join(' | ')}` }
						return
					}
					store.put({
						...base,
						type: 'geo',
						props: {
							geo,
							dash: 'draw',
							url: '',
							w: num(body.w) ?? 220,
							h: num(body.h) ?? 120,
							growY: 0,
							scale: 1,
							labelColor: 'black',
							color: color ?? 'black',
							fill: typeof body.fill === 'string' ? body.fill : 'semi',
							size: 's',
							font: 'draw',
							align: 'middle',
							verticalAlign: 'middle',
							richText: toRichText(text ?? ''),
						},
					} as any)
				} else if (type === 'text') {
					if (!text) {
						problem = { status: 400, error: 'text shapes require text' }
						return
					}
					const w = num(body.w)
					store.put({
						...base,
						type: 'text',
						props: {
							color: color ?? 'black',
							size: 's',
							font: 'draw',
							textAlign: 'start',
							w: w ?? 300,
							richText: toRichText(text),
							scale: 1,
							autoSize: w === undefined,
						},
					} as any)
				} else {
					// note — same record /api/sticky builds, but at an explicit spot.
					if (!text) {
						problem = { status: 400, error: 'note shapes require text' }
						return
					}
					store.put({
						...base,
						type: 'note',
						props: {
							richText: toRichText(text),
							color: color ?? 'yellow',
							labelColor: 'black',
							size: 'm',
							font: 'draw',
							fontSizeAdjustment: 1,
							align: 'middle',
							verticalAlign: 'middle',
							growY: 0,
							url: '',
							scale: 1,
							textFirstEditedBy: null,
						},
					} as any)
				}
				createdId = id
			})
		} catch (err) {
			return void res.status(400).json({ error: `invalid shape: ${err}` })
		}
		if (problem) {
			const p = problem as { status: number; error: string }
			return void res.status(p.status).json({ error: p.error })
		}
		res.json({ ok: true, id: createdId })
	})

	// Read side (mirror of the write endpoints): let agents see what's on the
	// canvas. Both read from getCurrentSnapshot() so they work whether or not a
	// browser is connected, just like the write endpoints' updateStore().

	// GET /api/frames?room= — discovery: every frame with its child counts.
	// Frames on the active teammate's page are ordered nearest-cursor-first;
	// the rest keep document order (see sortedBy in the response).
	app.get('/api/frames', (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const room = getOrCreateRoom(roomId)
		const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
		const byId = new Map(records.map((r) => [r.id, r]))
		const shapes = records.filter((r) => r.typeName === 'shape')
		const cursor = pickCursor(getCursorRefs(room))

		const frames = shapes
			.filter((r) => r.type === 'frame')
			.map((f) => {
				const children = shapes.filter((r) => r.parentId === f.id)
				const countOf = (t: string) => children.filter((r) => r.type === t).length
				const pt = pagePoint(f, byId)
				return {
					pt,
					id: f.id,
					name: typeof f.props?.name === 'string' ? f.props.name : '',
					page: pageIdOf(f, byId),
					x: f.x,
					y: f.y,
					w: f.props?.w,
					h: f.props?.h,
					notes: countOf('note'),
					texts: countOf('text'),
					images: countOf('image'),
					terminals: countOf('terminal'),
					iframes: countOf('iframe'),
				}
			})

		// Only frames on the cursor's page can be ranked by it; others trail in
		// document order. byProximity strips `pt` and attaches `dist`.
		const ordered = cursor
			? [
					...byProximity(frames.filter((f) => f.page === cursor.currentPageId), cursor),
					...byProximity(frames.filter((f) => f.page !== cursor.currentPageId), null),
				]
			: byProximity(frames, null)

		res.json({
			ok: true,
			sortedBy: cursor ? { userName: cursor.userName, page: cursor.currentPageId, cursor: cursor.cursor } : null,
			frames: ordered,
		})
	})

	// GET /api/frame?room=&name= — the contents of one fuzzy-matched frame:
	// stickies, text, images (resolved to their /uploads URL), terminals,
	// iframes. Same case-insensitive name match as POST /api/sticky.
	app.get('/api/frame', (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		const name = typeof req.query.name === 'string' ? req.query.name : ''
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		if (!name) return void res.status(400).json({ error: 'name is required' })
		const room = getOrCreateRoom(roomId)
		const records = room.getCurrentSnapshot().documents.map((d) => d.state as any)
		const byId = new Map(records.map((r) => [r.id, r]))
		const shapes = records.filter((r) => r.typeName === 'shape')
		const frame = shapes.find(
			(r) =>
				r.type === 'frame' &&
				typeof r.props?.name === 'string' &&
				r.props.name.toLowerCase().includes(name.toLowerCase())
		)
		if (!frame) return void res.status(404).json({ error: 'frame not found' })

		const children = shapes.filter((r) => r.parentId === frame.id)
		const assetById = new Map(records.filter((r) => r.typeName === 'asset').map((a) => [a.id, a]))
		const byType = (t: string) => children.filter((r) => r.type === t)

		// A child's page-space point is the frame's point plus its own offset.
		const framePt = pagePoint(frame, byId)
		const ptOf = (c: any) => ({ x: framePt.x + (c.x ?? 0), y: framePt.y + (c.y ?? 0) })

		// Only a cursor on this frame's own page can rank its contents.
		const framePage = pageIdOf(frame, byId)
		const cursor = pickCursor(getCursorRefs(room), framePage ?? undefined)

		const notes = byProximity(
			byType('note').map((n) => ({
				pt: ptOf(n),
				id: n.id,
				text: richTextToPlainText(n.props?.richText),
				color: n.props?.color,
			})),
			cursor
		)
		const texts = byProximity(
			byType('text').map((t) => ({
				pt: ptOf(t),
				id: t.id,
				text: richTextToPlainText(t.props?.richText),
			})),
			cursor
		)
		const images = byProximity(
			byType('image').map((img) => {
				const asset = img.props?.assetId ? assetById.get(img.props.assetId) : null
				return {
					pt: ptOf(img),
					id: img.id,
					url: asset?.props?.src ?? null,
					name: asset?.props?.name ?? null,
					w: img.props?.w,
					h: img.props?.h,
				}
			}),
			cursor
		)

		res.json({
			ok: true,
			frame: { id: frame.id, name: frame.props?.name, page: framePage },
			sortedBy: cursor ? { userName: cursor.userName, cursor: cursor.cursor } : null,
			notes,
			texts,
			images,
			terminals: byType('terminal').map((t) => ({
				id: t.id,
				sessionId: t.props?.sessionId,
				title: t.props?.title,
				status: t.props?.status ?? null,
			})),
			iframes: byType('iframe').map((f) => ({
				id: f.id,
				url: f.props?.url,
				title: f.props?.title,
			})),
		})
	})

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
		if (!name || name.length > 128) return void res.status(400).json({ error: 'name is required' })
		const ifRev = typeof body.ifRev === 'number' && Number.isFinite(body.ifRev) ? body.ifRev : null

		const existing = await roadmaps.get(roomId, name)
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
			await getOrCreateRoom(roomId).updateStore((store) => {
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

	app.put('/uploads/:id', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
		const id = sanitizeId(req.params.id)
		if (!id) return void res.status(400).json({ error: 'bad asset id' })
		await writeFile(path.join(uploadsDir, id), req.body)
		res.json({ ok: true })
	})

	app.get('/uploads/:id', async (req, res) => {
		const id = sanitizeId(req.params.id)
		if (!id) return void res.status(400).json({ error: 'bad asset id' })
		try {
			res.send(await readFile(path.join(uploadsDir, id)))
		} catch {
			res.status(404).json({ error: 'not found' })
		}
	})

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
				let m = identitiesByUser.get(roomId)
				if (!m) identitiesByUser.set(roomId, (m = new Map()))
				m.set(rawUserId(userId), id)
			})
			.catch(() => {})
		wss.handleUpgrade(req, socket, head, (ws) => {
			let roomUsers = sessionsByUser.get(roomId)
			if (!roomUsers) sessionsByUser.set(roomId, (roomUsers = new Map()))
			let userSessions = roomUsers.get(userId)
			if (!userSessions) roomUsers.set(userId, (userSessions = new Set()))
			userSessions.add(sessionId)
			ws.once('close', () => {
				userSessions.delete(sessionId)
				if (userSessions.size === 0) {
					roomUsers.delete(userId)
					identitiesByUser.get(roomId)?.delete(rawUserId(userId))
				}
				if (roomUsers.size === 0) {
					sessionsByUser.delete(roomId)
					identitiesByUser.delete(roomId)
				}
			})
			getOrCreateRoom(roomId).handleSocketConnect({ sessionId, socket: ws })
		})
	})

	return { server, getOrCreateRoom }
}
