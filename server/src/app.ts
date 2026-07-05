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
import { createBindingId, createShapeId, toRichText } from '@tldraw/tlschema'
import { getIndexAbove, sortByIndex } from '@tldraw/utils'
import express from 'express'
import { WebSocketServer } from 'ws'
import { getAccessIdentity } from './access-identity.ts'
import { GEO_TYPES, NOTE_COLORS, STICKY_GRID_COLS, STICKY_GRID_STEP } from './canvas/constants.ts'
import { pageIdOf, pagePoint, richTextToPlainText } from './canvas/geometry.ts'
import { sanitizeId } from './canvas/ids.ts'
import { createAvRouter } from './features/av.ts'
import { createTerminalStatusRouter } from './features/terminal-status.ts'
import { createTranscriptRouter } from './features/transcript.ts'
import { createUploadsRouter } from './features/uploads.ts'
import { createGatewayPlane } from './gateway-registry.ts'
import type { PluginServerContext } from './kernel/context.ts'
import { createMediaService } from './kernel/media.ts'
import { byProximity, getCursorRefs, pickCursor, rawUserId, sortPointOf } from './kernel/presence.ts'
import { createRoomHost } from './kernel/rooms.ts'
import { createSessionRegistry } from './kernel/sessions.ts'
import { schema } from './schema.ts'
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
		await roomHost.getOrCreateRoom(roomId).updateStore((store) => {
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

	app.use(createTranscriptRouter(ctx))

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
			await roomHost.getOrCreateRoom(roomId).updateStore((store) => {
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
				await roomHost.getOrCreateRoom(roomId).updateStore((store) => {
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
			await roomHost.getOrCreateRoom(roomId).updateStore((store) => {
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
		const room = roomHost.getOrCreateRoom(roomId)
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
			sortedBy: cursor ? { userName: cursor.userName, page: cursor.currentPageId, cursor: sortPointOf(cursor) } : null,
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
		const room = roomHost.getOrCreateRoom(roomId)
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
			sortedBy: cursor ? { userName: cursor.userName, cursor: sortPointOf(cursor) } : null,
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
