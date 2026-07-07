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
import { findFrameByName } from '../canvas/frames-helper.ts'
import { pagePoint } from '../canvas/geometry.ts'
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
				await ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => {
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
