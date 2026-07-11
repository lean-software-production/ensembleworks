/**
 * Converter between the tldraw store (flat records) and the pure
 * @ensembleworks/canvas-model CanvasDocument. Lives server-side because it is
 * inherently tldraw-coupled; the canvas-* packages stay clean-room and
 * tldraw-free. Read path for Agent API v2, and the seed of the Phase 5 migration
 * tool.
 */
import { type Binding, type CanvasDocument, type Page, type Shape, SHAPE_KINDS, makeDocument } from '@ensembleworks/canvas-model'

const KINDS = new Set<string>(SHAPE_KINDS)

// tldraw shape record → model Shape. Envelope fields map 1:1; props pass through
// verbatim (lossless, incl. richText). Unknown shape types are dropped (they
// cannot be in this schema, but be defensive).
function shapeFromRecord(r: any): Shape | null {
	if (!KINDS.has(r.type)) return null
	return {
		id: r.id,
		kind: r.type,
		parentId: r.parentId,
		index: r.index,
		x: r.x ?? 0,
		y: r.y ?? 0,
		rotation: r.rotation ?? 0,
		isLocked: !!r.isLocked,
		opacity: r.opacity ?? 1,
		meta: r.meta ?? {},
		props: r.props ?? {},
	}
}

export function fromTldraw(records: any[]): CanvasDocument {
	const pages: Page[] = []
	const shapes: Shape[] = []
	const bindings: Binding[] = []
	for (const r of records) {
		switch (r.typeName) {
			case 'page':
				pages.push({ id: r.id, name: r.name ?? '', index: r.index })
				break
			case 'shape': {
				const s = shapeFromRecord(r)
				if (s) shapes.push(s)
				break
			}
			case 'binding':
				if (r.type === 'arrow') bindings.push({ id: r.id, fromId: r.fromId, toId: r.toId, props: r.props ?? {}, meta: r.meta ?? {} })
				break
			// document / asset / instance* → out-of-band, ignored by the model.
		}
	}
	return makeDocument({ pages, shapes, bindings })
}
