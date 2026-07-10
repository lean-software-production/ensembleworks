/**
 * Shape feature — POST /api/canvas/shape: create/update/delete diagram shapes (geo,
 * arrow with bindings, text, note) for agents; arrows resolve endpoints to
 * shape centres.
 */
import { canvasShape } from '@ensembleworks/contracts'
import { createBindingId, createShapeId, toRichText } from '@tldraw/tlschema'
import { getIndexAbove, sortByIndex } from '@tldraw/utils'
import express from 'express'
import { GEO_TYPES, NOTE_COLORS } from '../canvas/constants.ts'
import {
	buildLinePoints,
	buildSegments,
	originOf,
	parsePoints,
	toLocal,
	translateForReparent,
	wouldCreateCycle,
} from '../canvas/drawShapes.ts'
import { findFrameByName } from '../canvas/frames-helper.ts'
import { pageIdOf, pagePoint } from '../canvas/geometry.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'
import { badgeText, resolveAttribution } from '../kernel/attribution.ts'
import { resolveCaller } from '../whoami.ts'

export function createShapeRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Diagram plane: a generic shape endpoint so agents can *maintain* a live
	// drawing (conversation map, dialogue threads) rather than only append
	// stickies. Three ops in one route:
	//   create — { type: geo|text|note|arrow, frame?, x?, y?, text?, … }
	//            arrows take { fromId, toId } and get real tldraw bindings,
	//            so the connector follows when humans drag the nodes around.
	//   update — { id, text?, x?, y?, w?, h?, color?, fill?, geo?, props? }
	//   delete — { id } (cascades bindings touching the shape)

	router.post(canvasShape.http.path, async (req, res) => {
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

		// Attribution: stamp the real caller (credential wins; anonymous body.author
		// is a cosmetic badge only). Resolved once; only the create branch consumes
		// it — update/delete do NOT re-attribute (author is the shape's creator).
		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)

		// ---- delete -----------------------------------------------------------
		if (op === 'delete') {
			const id = typeof body.id === 'string' ? body.id : ''
			if (!id) return void res.status(400).json({ error: 'id is required' })
			let deleted = 0
			await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
				const records = store.getAll() as any[]
				const target = records.find((r) => r.id === id)
				if (!target) return

				if (target.type === 'frame' && body.withChildren) {
					// Cascade: the frame + ALL descendants (BFS over parentId) + every
					// binding whose fromId/toId is any removed id (incl. an arrow that
					// lives OUTSIDE the frame but points at a shape inside it).
					const removeIds = new Set<string>([target.id])
					let frontier = [target.id]
					while (frontier.length) {
						const kids = records.filter(
							(r) => r.typeName === 'shape' && frontier.includes(r.parentId) && !removeIds.has(r.id)
						)
						frontier = kids.map((k) => k.id)
						for (const kid of frontier) removeIds.add(kid)
					}
					for (const rid of removeIds) {
						store.delete(rid)
						deleted++
					}
					for (const r of records) {
						if (r.typeName === 'binding' && (removeIds.has(r.fromId) || removeIds.has(r.toId))) {
							store.delete(r.id)
							deleted++
						}
					}
				} else if (target.type === 'frame') {
					// Default: KEEP the frame's DIRECT children. Reparent them to the
					// frame's own parent (its real page or an enclosing frame) and
					// translate their page-position: a child was frame-relative and the
					// frame was parent-relative ⇒ child.x + frame.x is correct in the
					// parent's space (unrotated only, AC22). Grandchildren ride along
					// with their surviving parent, untouched.
					const directKids = records.filter(
						(r) => r.typeName === 'shape' && r.parentId === target.id
					)
					const sibs = records.filter(
						(r) =>
							r.typeName === 'shape' &&
							r.parentId === target.parentId &&
							r.id !== target.id &&
							typeof r.index === 'string'
					)
					let top = sibs.length ? sibs.sort(sortByIndex).at(-1)!.index : undefined
					for (const kid of directKids) {
						top = getIndexAbove(top)
						store.put({
							...kid,
							parentId: target.parentId,
							x: (kid.x ?? 0) + (target.x ?? 0),
							y: (kid.y ?? 0) + (target.y ?? 0),
							index: top,
						})
					}
					store.delete(target.id)
					deleted++
					// Bindings touching the FRAME itself still cascade.
					for (const r of records) {
						if (r.typeName === 'binding' && (r.fromId === target.id || r.toId === target.id)) {
							store.delete(r.id)
							deleted++
						}
					}
				} else {
					// Non-frame delete (unchanged regression path): the shape + the
					// bindings touching it, so its arrows don't point at a ghost.
					store.delete(id)
					deleted++
					for (const r of records) {
						if (r.typeName === 'binding' && (r.fromId === id || r.toId === id)) {
							store.delete(r.id)
							deleted++
						}
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
			let problem: { status: number; error: string } | null = null
			try {
				await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
					const records = store.getAll() as any[]
					const byId = new Map(records.map((r) => [r.id, r]))
					const shapes = records.filter((r) => r.typeName === 'shape')
					const record = records.find((r) => r.typeName === 'shape' && r.id === id)
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

					// --- reparent (mutually exclusive: --frame OR --to-page) ---
					// NB: translateForReparent leans on pagePoint (geometry.ts), which
					// sums parent x/y and IGNORES rotation — so reparent preserves the
					// page-position for UNROTATED parents only (AC22). No affine claimed.
					let newParentId: string | undefined
					if (typeof body.frame === 'string') {
						const target = findFrameByName(shapes, body.frame)
						if (!target) {
							problem = { status: 404, error: 'frame not found' }
							return
						}
						// A frame fuzzy-matches its own name, and it may match a descendant —
						// either would set parentId to self/a child and cycle the tree. store.put
						// accepts it (base validator only checks the id prefix), so guard here.
						if (wouldCreateCycle(id, target.id, byId)) {
							problem = {
								status: 400,
								error: 'cannot reparent a shape into itself or its own descendant',
							}
							return
						}
						newParentId = target.id
					} else if (body.toPage) {
						newParentId =
							pageIdOf(record, byId) ??
							records.find((r) => r.typeName === 'page')?.id ??
							'page:page'
					}
					if (newParentId) {
						const { x, y } = translateForReparent(record, newParentId, byId)
						next.parentId = newParentId
						next.x = x
						next.y = y
						// Fresh index at/above the NEW parent's existing children (z-order).
						const sibs = shapes.filter(
							(r) => r.parentId === newParentId && r.id !== id && typeof r.index === 'string'
						)
						const top = sibs.length ? sibs.sort(sortByIndex).at(-1)!.index : undefined
						next.index = getIndexAbove(top)
					} else {
						// --x/--y overrides apply only when NOT reparenting, else a stray
						// --x would fight the translation that keeps the shape in place.
						if (num(body.x) !== undefined) next.x = num(body.x)
						if (num(body.y) !== undefined) next.y = num(body.y)
					}

					// --- base-field riders ---
					if (body.rotate !== undefined) {
						const r = num(body.rotate)
						if (r === undefined) throw new Error('rotate must be a finite number')
						next.rotation = r
					}
					if (typeof body.lock === 'boolean') next.isLocked = body.lock

					store.put(next)
				})
			} catch (err) {
				return void res.status(400).json({ error: `invalid update: ${err}` })
			}
			if (problem) {
				const p = problem as { status: number; error: string }
				return void res.status(p.status).json({ error: p.error })
			}
			if (!found) return void res.status(404).json({ error: 'shape not found' })
			return void res.json({ ok: true, id })
		}

		if (op !== 'create') {
			return void res.status(400).json({ error: 'op must be create | update | delete' })
		}

		// ---- create -----------------------------------------------------------
		const type = typeof body.type === 'string' ? body.type : ''
		if (!['geo', 'text', 'note', 'arrow', 'frame', 'line', 'draw', 'highlight'].includes(type)) {
			return void res
				.status(400)
				.json({ error: 'type must be geo | text | note | arrow | frame | line | draw | highlight' })
		}
		const frameName = typeof body.frame === 'string' ? body.frame : null
		const badged = badgeText(text ?? '', attribution.display)
		let createdId: string | null = null
		let problem: { status: number; error: string } | null = null

		try {
			await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
				const records = store.getAll() as any[]
				const byId = new Map(records.map((r) => [r.id, r]))
				const shapes = records.filter((r) => r.typeName === 'shape')

				// Resolve the parent: a fuzzy-matched frame, or the (first) page.
				let parentId = records.find((r) => r.typeName === 'page')?.id ?? 'page:page'
				if (frameName) {
					const target = findFrameByName(shapes, frameName)
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
					meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {},
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
							richText: toRichText(badged),
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
							richText: toRichText(badged),
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
							richText: toRichText(badged),
							scale: 1,
							autoSize: w === undefined,
						},
					} as any)
				} else if (type === 'frame') {
					// A frame is a real parent for other shapes; caption is props.name
					// (no richText). color is REQUIRED in 5.1.0 → default 'black'; w/h
					// default non-zero so a bare `create frame` never 400s (AC2).
					store.put({
						...base,
						type: 'frame',
						props: {
							w: num(body.w) ?? 800,
							h: num(body.h) ?? 600,
							name: typeof body.name === 'string' ? body.name : (text ?? ''),
							color: color ?? 'black',
						},
					} as any)
				} else if (type === 'line') {
					// Points are parent-relative (page coords on a page, frame-local under --frame,
					// same convention as geo/text/note); normalize to a bbox-min origin so the
						// shape sits at (minX,minY) and vertices are stored local.
					const pts = parsePoints(body.points, 2)
					const origin = originOf(pts)
					store.put({
						...base,
						x: (num(body.x) ?? 0) + origin.x,
						y: (num(body.y) ?? 0) + origin.y,
						type: 'line',
						props: {
							color: color ?? 'black',
							dash: 'draw',
							size: 'm',
							spline: body.spline === 'cubic' ? 'cubic' : 'line',
							points: buildLinePoints(toLocal(pts, origin)),
							scale: 1,
						},
					} as any)
				} else if (type === 'draw') {
					// buildSegments both delta-encodes the base64 path AND rejects a
					// consecutive-point x/y delta > 65504 (Float16 ceiling) → 400.
					const pts = parsePoints(body.points, 2)
					const origin = originOf(pts)
					store.put({
						...base,
						x: (num(body.x) ?? 0) + origin.x,
						y: (num(body.y) ?? 0) + origin.y,
						type: 'draw',
						props: {
							color: color ?? 'black',
							fill: typeof body.fill === 'string' ? body.fill : 'none',
							dash: 'draw',
							size: 'm',
							segments: buildSegments(toLocal(pts, origin)),
							isComplete: true,
							isClosed: !!body.closed,
							isPen: false,
							scale: 1,
							scaleX: 1,
							scaleY: 1,
						},
					} as any)
				} else if (type === 'highlight') {
					// Smaller prop set than draw: NO fill / dash / isClosed (unknown
					// keys throw on put → 400). segments builder is shared with draw.
					const pts = parsePoints(body.points, 2)
					const origin = originOf(pts)
					store.put({
						...base,
						x: (num(body.x) ?? 0) + origin.x,
						y: (num(body.y) ?? 0) + origin.y,
						type: 'highlight',
						props: {
							color: color ?? 'black',
							size: 'm',
							segments: buildSegments(toLocal(pts, origin)),
							isComplete: true,
							isPen: false,
							scale: 1,
							scaleX: 1,
							scaleY: 1,
						},
					} as any)
				} else {
					// note — same record /api/canvas/sticky builds, but at an explicit spot.
					if (!text) {
						problem = { status: 400, error: 'note shapes require text' }
						return
					}
					store.put({
						...base,
						type: 'note',
						props: {
							richText: toRichText(badged),
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

	return router
}
