/**
 * Agent API v2 (read side, Phase 1). Versioned read endpoints that serve the new
 * canvas-model, converted live from the tldraw store on each request. Read-only;
 * the live editing/write path is untouched. Endpoints declared as ToolDefs in
 * @ensembleworks/contracts (canvas-v2).
 */
import {
	canvasV2Document, canvasV2Frame, canvasV2Frames,
} from '@ensembleworks/contracts'
import {
	childrenOf, frames as modelFrames, pageBounds, plainText,
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
// error page / a hung response. Logs the real error server-side.
function guard(handler: (req: express.Request, res: express.Response) => void) {
	return (req: express.Request, res: express.Response) => {
		try {
			handler(req, res)
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
					page: doc.pages.find((p) => p.id === f.parentId)?.id ?? null,
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
				frame: { id: frame.id, name: String((frame.props as any)?.name ?? '') },
				members,
			})
		})
	)

	// Unit 10 (E3) seam: semantic + neighbors mount here once their ToolDefs are
	// wired in. Kept as a no-op call so this diff stays document/frames/frame-only.
	attachSemantic(router, { modelFor, roomOf, findFrame })

	return router
}

// Unit 10 (E3) fills this in: GET /api/v2/canvas/semantic + GET
// /api/v2/canvas/neighbors, reusing modelFor/roomOf/findFrame above.
function attachSemantic(
	_router: express.Router,
	_deps: {
		modelFor: (roomId: string) => CanvasDocument
		roomOf: (req: express.Request) => string | null
		findFrame: (doc: CanvasDocument, name: string) => Shape | undefined
	}
): void {
	/* E3 */
}
