/**
 * web-viewer feature — POST /api/canvas/web-viewer (aliased at the legacy
 * /api/canvas/file-viewer path for older clients).
 *   op:open     create a web-viewer shape pointing at a home-relative path
 *               (kind 'file'), or — when `port` is given — at a local dev
 *               server (kind 'dev'). Placement + attribution modelled on
 *               sticky.
 *   op:refresh  bump rev on every kind:'file' web-viewer shape matching the
 *               path — the "everyone look again" nudge (roadmap rev fan-out
 *               pattern). Dev viewers reload via their own refresh button.
 * v1 rejects `gateway` with 501 (the remote seam lands with the connector).
 */
import { fileOpen } from '@ensembleworks/contracts'
import { createShapeId } from '@tldraw/tlschema'
import { getIndexAbove, sortByIndex } from '@tldraw/utils'
import express from 'express'
import os from 'node:os'
import path from 'node:path'
import { STICKY_GRID_COLS, STICKY_GRID_STEP } from '../canvas/constants.ts'
import { findFrameByName } from '../canvas/frames-helper.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { schema } from '../schema.ts'
import { resolveAttribution } from '../kernel/attribution.ts'
import { resolveCaller } from '../whoami.ts'
import { createPresentRelay, type RelayEntry } from '../present-relay.ts'

const AGENT_HOME = () => process.env.ENSEMBLEWORKS_AGENT_HOME ?? os.homedir()

/** Home-relativise + validate. Returns the clean relative path or null. */
export function normalizeHomePath(raw: string): string | null {
	let p = raw.trim()
	if (!p) return null
	if (p.startsWith('~/')) p = p.slice(2)
	const home = AGENT_HOME()
	if (p.startsWith('/')) {
		if (p === home || p.startsWith(home + '/')) p = p.slice(home.length + 1)
		else return null // absolute outside home
	}
	// reject traversal anywhere
	if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
	return p
}

export function createWebViewerRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Canvas API (session MVP): lets agents pop a file (or dev server) open on
	// the canvas and nudge every open file viewer to reload, whether or not
	// the room is open.

	router.post([fileOpen.http.path, '/api/canvas/file-viewer'], async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })

		const op = typeof body.op === 'string' ? body.op : ''
		if (op !== 'open' && op !== 'refresh') {
			return void res.status(400).json({ error: 'op must be open | refresh' })
		}

		// v1 has no remote transport; reject before touching the store so a
		// misconfigured gateway never creates/refreshes a local-only shape.
		const gateway = typeof body.gateway === 'string' ? body.gateway.trim() : ''
		if (gateway) {
			return void res.status(501).json({ error: 'remote files not yet supported (v1)' })
		}

		const rawPort = body.port
		const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : null
		const rawPath = typeof body.path === 'string' ? body.path : ''
		let cleanPath: string | null = null
		if (port === null) {
			cleanPath = normalizeHomePath(rawPath)
			if (!cleanPath) {
				return void res
					.status(400)
					.json({ error: 'path must be a non-empty path within the agent home (no ../ traversal), or pass port for a dev server' })
			}
		} else if (op === 'refresh') {
			return void res.status(400).json({ error: 'refresh is by path; dev viewers reload via their own refresh button' })
		}

		// ---- refresh ------------------------------------------------------------
		if (op === 'refresh') {
			let updated = 0
			await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
				for (const record of store.getAll() as any[]) {
					if (
						record.typeName === 'shape' &&
						record.type === 'web-viewer' &&
						record.props?.path === cleanPath
					) {
						store.put({ ...record, props: { ...record.props, rev: (record.props.rev ?? 0) + 1 } })
						updated++
					}
				}
			})
			return void res.json({ ok: true, updated })
		}

		// ---- open -----------------------------------------------------------------
		const frame = typeof body.frame === 'string' ? body.frame : null
		const title =
			typeof body.title === 'string' && body.title.trim()
				? body.title.trim()
				: port !== null
					? `:${port}`
					: path.basename(cleanPath!)

		// Attribution: stamp the real caller (credential wins; anonymous body.author
		// is a cosmetic badge only) — same rule as sticky, though the file-viewer
		// has no free-text surface to badge, so only meta.author is used.
		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)

		let createdId: string | null = null
		let frameFound = true
		await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
			const records = store.getAll() as any[]
			const shapes = records.filter((r) => r.typeName === 'shape')

			let parentId: string
			let x: number
			let y: number
			if (frame) {
				const target = findFrameByName(shapes, frame)
				if (!target) {
					frameFound = false
					return
				}
				parentId = target.id
				// Grid inside the frame, based on how many web-viewers it already holds.
				const count = shapes.filter((r) => r.type === 'web-viewer' && r.parentId === parentId).length
				x = 20 + (count % STICKY_GRID_COLS) * STICKY_GRID_STEP
				y = 20 + Math.floor(count / STICKY_GRID_COLS) * STICKY_GRID_STEP
			} else {
				// No frame: page origin area, offset by web-viewer count so tiles
				// don't stack exactly.
				parentId = records.find((r) => r.typeName === 'page')?.id ?? 'page:page'
				const count = shapes.filter((r) => r.type === 'web-viewer' && r.parentId === parentId).length
				x = count * 40
				y = count * 40
			}

			const siblings = shapes.filter(
				(r) => r.parentId === parentId && typeof r.index === 'string'
			)
			const topIndex = siblings.length ? siblings.sort(sortByIndex).at(-1)!.index : undefined
			const id = createShapeId()
			const viewer = (schema.types.shape as any).create({
				id,
				type: 'web-viewer',
				parentId,
				index: getIndexAbove(topIndex),
				x,
				y,
				meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {},
				props: port !== null
					? { w: 960, h: 640, kind: 'dev', port, path: typeof body.path === 'string' && body.path.startsWith('/') ? body.path : '/', title, rev: 0 }
					: { w: 720, h: 540, kind: 'file', path: cleanPath!, title, rev: 0 },
			})
			store.put(viewer)
			createdId = id
		})
		if (!frameFound) return void res.status(404).json({ error: 'frame not found' })
		res.json({ ok: true, id: createdId })
	})

	// ---- rrweb present relay (spec: 2026-07-27-file-viewer-rrweb-broadcast) --
	// Presenter POSTs event batches; the server logs them (late-joiner backlog)
	// and fans them out over the existing sync socket as a custom message. The
	// POST carries no session identity, so fan-out includes the presenter, who
	// ignores messages for shapes they are presenting.
	const relay = createPresentRelay()
	// Fan-out includes the presenter (the POST carries no session identity to
	// exclude them by) — the presenting client ignores ew-rrweb for shapes it
	// is itself presenting.
	const truncatedNotified = new Set<string>()

	const parseEntries = (raw: unknown): RelayEntry[] | null => {
		if (!Array.isArray(raw)) return null
		const out: RelayEntry[] = []
		for (const e of raw) {
			if (!e || typeof e !== 'object' || typeof (e as any).seq !== 'number' || !('event' in (e as any))) return null
			out.push({ seq: (e as any).seq, event: (e as any).event })
		}
		return out
	}

	function fanOut(roomId: string, room: import('@tldraw/sync-core').TLSocketRoom, message: unknown) {
		for (const sessions of ctx.sessions.sessionsByUser.get(roomId)?.values() ?? []) {
			for (const sessionId of sessions) room.sendCustomMessage(sessionId, message)
		}
	}

	// A large batch (e.g. a FullSnapshot after a long DOM) can exceed the
	// app-wide express.json 100kb default — this route gets its own parser
	// sized to the relay's own 5MB-per-log cap (app.ts skips the default
	// json() parser for this one path so this is the only body parse it gets).
	router.post(
		['/api/canvas/web-viewer/present-events', '/api/canvas/file-viewer/present-events'],
		express.json({ limit: '6mb' }),
		(req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? ''))
		const shapeId = typeof body.shapeId === 'string' ? body.shapeId : ''
		const presentId = typeof body.presentId === 'string' ? body.presentId : ''
		const entries = parseEntries(body.entries)
		if (!roomId || !shapeId || !presentId || !entries) {
			return void res.status(400).json({ error: 'room, shapeId, presentId, entries[] required' })
		}
		const room = ctx.rooms.rooms.get(roomId)
		if (!room) return void res.status(404).json({ error: 'room not found' })

		const { truncated } = relay.append(roomId, shapeId, presentId, entries)
		const notifyKey = `${roomId} ${shapeId} ${presentId}`
		if (!truncated) {
			fanOut(roomId, room, { type: 'ew-rrweb', shapeId, presentId, truncated, entries })
		} else if (!truncatedNotified.has(notifyKey)) {
			// First append to trip the cap: tell connected followers once, with
			// no entries, so a live mirror can degrade instead of stalling silently.
			truncatedNotified.add(notifyKey)
			fanOut(roomId, room, { type: 'ew-rrweb', shapeId, presentId, truncated: true, entries: [] })
		}
		res.json({ ok: true, truncated })
		}
	)

	router.get(['/api/canvas/web-viewer/present-events', '/api/canvas/file-viewer/present-events'], (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? ''))
		const shapeId = typeof req.query.shapeId === 'string' ? req.query.shapeId : ''
		if (!roomId || !shapeId) return void res.status(400).json({ error: 'room and shapeId required' })
		res.json(relay.backlog(roomId, shapeId))
	})

	// present-stop no longer deletes the log — a finished presentation IS the
	// frozen last view (spec: 2026-07-29-file-viewer-force-follow-design.md).
	// Kept as a 200 no-op so older clients' broadcasters don't error on stop.
	router.post(['/api/canvas/web-viewer/present-stop', '/api/canvas/file-viewer/present-stop'], (req, res) => {
		res.json({ ok: true })
	})

	return router
}
