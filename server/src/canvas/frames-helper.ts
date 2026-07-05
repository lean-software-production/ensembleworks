/**
 * Shared frame fuzzy-match: given an array of shape records, find the frame
 * whose name case-insensitively contains the given search string. Used by
 * POST /api/sticky, POST /api/shape, and GET /api/frame (see
 * features/sticky.ts, features/shape.ts, features/frames.ts) — each site
 * builds its own `shapes` array (from a live store transaction or a
 * read-only snapshot) and handles a miss with its own control flow; only
 * the matching rule itself is shared here.
 */
export function findFrameByName(shapes: any[], name: string): any | undefined {
	return shapes.find(
		(r) =>
			r.type === 'frame' &&
			typeof r.props?.name === 'string' &&
			r.props.name.toLowerCase().includes(name.toLowerCase())
	)
}
