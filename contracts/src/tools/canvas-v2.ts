// Agent API v2 (read side, Phase 1) — versioned read endpoints backed by the
// new @ensembleworks/canvas-model document (see server/src/canvas-v2/convert.ts
// and server/src/features/canvas-v2.ts). Outputs are deliberately loose: this
// package must stay canvas-model-free (accepted controller decision), so each
// endpoint's real shape is documented in its router, not typed field-by-field
// here. House idiom for a loose zod-4 object (this repo's zod is looseObject,
// not the deprecated .passthrough()) — see canvas-model/src/shape.ts, document.ts.
import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')
const ok = z.looseObject({ ok: z.literal(true) })

export const canvasV2Document: ToolDef = {
	plugin: 'canvas-v2',
	id: 'document',
	http: { method: 'GET', path: '/api/v2/canvas/document' },
	help: 'Read the whole room as the new canvas-model document (pages, shapes, bindings), converted live from the tldraw store.',
	zodInput: z.object({ room }),
	zodOutput: ok,
}

export const canvasV2Frames: ToolDef = {
	plugin: 'canvas-v2',
	id: 'frames',
	http: { method: 'GET', path: '/api/v2/canvas/frames' },
	help: 'List frames (id, name, page, page-space bounds, child counts) from the new model.',
	zodInput: z.object({ room }),
	zodOutput: ok,
}

export const canvasV2Frame: ToolDef = {
	plugin: 'canvas-v2',
	id: 'frame',
	http: { method: 'GET', path: '/api/v2/canvas/frame' },
	help: "Read one fuzzy-matched frame's members (id, kind, text, bounds) from the new model.",
	zodInput: z.object({ room, name: z.string().min(1).describe('fuzzy frame name') }),
	zodOutput: ok,
}

export const canvasV2Semantic: ToolDef = {
	plugin: 'canvas-v2',
	id: 'semantic',
	http: { method: 'GET', path: '/api/v2/canvas/semantic' },
	help:
		'Spatial semantics for a frame (or the whole page): clusters (members, arrangement, confidence, label), outliers, ' +
		'and arrow relations between clusters. Scale-relative thresholds. Cluster indices (and relation fromCluster/toCluster) ' +
		"are positions in THIS response's clusters array — recomputed per request, not stable ids; do not cache them across calls.",
	zodInput: z.object({ room, frame: z.string().optional().describe('fuzzy frame name; omitted = whole first page') }),
	zodOutput: ok,
}

export const canvasV2Neighbors: ToolDef = {
	plugin: 'canvas-v2',
	id: 'neighbors',
	http: { method: 'GET', path: '/api/v2/canvas/neighbors' },
	help: 'Shapes within a radius of a given shape (nearest first, same page only). radius is in page units.',
	zodInput: z.object({ room, id: z.string().min(1).describe('shape id'), radius: z.coerce.number().default(400) }),
	zodOutput: ok,
}

export const canvasV2Tools: ToolDef[] = [
	canvasV2Document,
	canvasV2Frames,
	canvasV2Frame,
	canvasV2Semantic,
	canvasV2Neighbors,
]
