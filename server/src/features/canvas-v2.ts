/**
 * Agent API v2 (read side, Phase 1). Versioned read endpoints that serve the new
 * canvas-model, converted live from the tldraw store on each request. Read-only;
 * the live editing/write path is untouched. Endpoints declared as ToolDefs in
 * @ensembleworks/contracts (canvas-v2).
 */
import {
	canvasV2Document, canvasV2Frame, canvasV2Frames, canvasV2Neighbors, canvasV2Semantic,
} from '@ensembleworks/contracts'
import {
	childrenOf, frames as modelFrames, neighbors, pageBounds, plainText, rootShapes, semanticView, shapeById,
	type CanvasDocument, type Shape,
} from '@ensembleworks/canvas-model'
import express from 'express'
import { fromTldraw } from '../canvas-v2/convert.ts'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

// Shapes surfaced together as one "drawings" bucket, mirroring the v1 frames
// reader (server/src/features/frames.ts) so the two APIs report the same
// child-count buckets for the same room.
const DRAWING_KINDS = new Set(['geo', 'line', 'draw', 'highlight'])

// The Agent API's `model` marker: 2 = "canvas-model"-backed reads (this file),
// as opposed to the v1 tldraw-record reads (server/src/features/frames.ts).
// Deliberately NOT @ensembleworks/canvas-model's CANVAS_MODEL_VERSION (=1) —
// that tracks the model package's own schema version, a different axis.
const API_MODEL = 2

// Catch-all so an unexpected throw deep in conversion (a malformed record, a
// pathological tree) returns a clean 500 instead of Express's default HTML
// error page / a hung response. Logs the real error server-side. Awaits the
// handler so ASYNC handlers (house style; Unit 10 adds some through this
// wrapper) are covered too — a sync-only try/catch would silently miss a
// rejected promise and hang the response.
function guard(handler: (req: express.Request, res: express.Response) => void | Promise<void>) {
	return async (req: express.Request, res: express.Response) => {
		try {
			await handler(req, res)
		} catch (err) {
			console.error('[canvas-v2] unexpected error', err)
			res.status(500).json({ error: 'internal error' })
		}
	}
}

export function createCanvasV2Router(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	// Live conversion: snapshot → model. One helper so every read is identical.
	const modelFor = (roomId: string): CanvasDocument => {
		const records = ctx.rooms.getOrCreateRoom(roomId).getCurrentSnapshot().documents.map((d) => d.state as any)
		return fromTldraw(records)
	}
	const roomOf = (req: express.Request): string | null => sanitizeId(String(req.query.room ?? 'team'))

	// Fuzzy frame match (same rule as v1: case-insensitive substring on name).
	const findFrame = (doc: CanvasDocument, name: string): Shape | undefined =>
		modelFrames(doc).find((f) => String((f.props as any)?.name ?? '').toLowerCase().includes(name.toLowerCase()))

	const memberOf = (doc: CanvasDocument, s: Shape) => ({
		id: s.id,
		kind: s.kind,
		text: plainText(s),
		bounds: pageBounds(doc, s),
	})

	// The page a directly page-parented frame lives on (frames are page children
	// in this schema; a nested/malformed parent yields null, mirroring v1's
	// nullable page field).
	const pageOf = (doc: CanvasDocument, f: Shape): string | null =>
		doc.pages.find((p) => p.id === f.parentId)?.id ?? null

	// GET /api/v2/canvas/document?room= — the whole room as a canvas-model
	// document: pages, shapes, bindings, converted live from the tldraw store.
	router.get(
		canvasV2Document.http.path,
		guard((req, res) => {
			const roomId = roomOf(req)
			if (!roomId) return void res.status(400).json({ error: 'bad room id' })
			const doc = modelFor(roomId)
			res.json({ ok: true, model: API_MODEL, pages: doc.pages, shapes: doc.shapes, bindings: doc.bindings })
		})
	)

	// GET /api/v2/canvas/frames?room= — every frame with page-space bounds and
	// per-kind child counts (same bucket set as the v1 reader).
	router.get(
		canvasV2Frames.http.path,
		guard((req, res) => {
			const roomId = roomOf(req)
			if (!roomId) return void res.status(400).json({ error: 'bad room id' })
			const doc = modelFor(roomId)
			const frames = modelFrames(doc).map((f) => {
				const children = childrenOf(doc, f.id)
				const countOf = (kind: string) => children.filter((c) => c.kind === kind).length
				return {
					id: f.id,
					name: String((f.props as any)?.name ?? ''),
					page: pageOf(doc, f),
					bounds: pageBounds(doc, f),
					notes: countOf('note'),
					texts: countOf('text'),
					images: countOf('image'),
					terminals: countOf('terminal'),
					iframes: countOf('iframe'),
					drawings: children.filter((c) => DRAWING_KINDS.has(c.kind)).length,
				}
			})
			res.json({ ok: true, model: API_MODEL, frames })
		})
	)

	// GET /api/v2/canvas/frame?room=&name= — one fuzzy-matched frame's direct
	// members (id, kind, text, page-space bounds).
	router.get(
		canvasV2Frame.http.path,
		guard((req, res) => {
			const roomId = roomOf(req)
			const name = typeof req.query.name === 'string' ? req.query.name : ''
			if (!roomId) return void res.status(400).json({ error: 'bad room id' })
			if (!name) return void res.status(400).json({ error: 'name is required' })
			const doc = modelFor(roomId)
			const frame = findFrame(doc, name)
			if (!frame) return void res.status(404).json({ error: 'frame not found' })
			const members = childrenOf(doc, frame.id).map((s) => memberOf(doc, s))
			res.json({
				ok: true,
				model: API_MODEL,
				frame: { id: frame.id, name: String((frame.props as any)?.name ?? ''), page: pageOf(doc, frame) },
				members,
			})
		})
	)

	attachSemantic(router, { modelFor, roomOf, findFrame })

	return router
}

// GET /api/v2/canvas/semantic + GET /api/v2/canvas/neighbors — spatial
// semantics (clusters/outliers/relations) and shape-proximity reads, built on
// the same modelFor/roomOf/findFrame helpers as document/frames/frame above.
function attachSemantic(
	router: express.Router,
	deps: {
		modelFor: (roomId: string) => CanvasDocument
		roomOf: (req: express.Request) => string | null
		findFrame: (doc: CanvasDocument, name: string) => Shape | undefined
	}
): void {
	// GET /api/v2/canvas/semantic?room=&frame= — clusters/outliers/relations for
	// a fuzzy-matched frame's descendants, or the whole first page if omitted.
	router.get(
		canvasV2Semantic.http.path,
		guard((req, res) => {
			const roomId = deps.roomOf(req)
			if (!roomId) return void res.status(400).json({ error: 'bad room id' })
			const doc = deps.modelFor(roomId)
			const frameName = typeof req.query.frame === 'string' ? req.query.frame : ''
			let scope: Shape[]
			let frameInfo: { id: string; name: string } | null = null
			if (frameName) {
				const frame = deps.findFrame(doc, frameName)
				if (!frame) return void res.status(404).json({ error: 'frame not found' })
				frameInfo = { id: frame.id, name: String((frame.props as any)?.name ?? '') }
				scope = childrenOf(doc, frame.id)
			} else {
				scope = rootShapes(doc)
			}
			const view = semanticView(doc, scope)
			res.json({ ok: true, model: API_MODEL, frame: frameInfo, ...view })
		})
	)

	// GET /api/v2/canvas/neighbors?room=&id=&radius= — shapes within radius of a
	// given shape (nearest first, same page only).
	router.get(
		canvasV2Neighbors.http.path,
		guard((req, res) => {
			const roomId = deps.roomOf(req)
			const id = typeof req.query.id === 'string' ? req.query.id : ''
			const radius = Number(req.query.radius ?? 400)
			if (!roomId) return void res.status(400).json({ error: 'bad room id' })
			if (!id) return void res.status(400).json({ error: 'id is required' })
			const doc = deps.modelFor(roomId)
			if (!shapeById(doc, id)) return void res.status(404).json({ error: 'shape not found' })
			res.json({
				ok: true,
				model: API_MODEL,
				id,
				radius,
				neighbors: neighbors(doc, id, Number.isFinite(radius) ? radius : 400),
			})
		})
	)
}
