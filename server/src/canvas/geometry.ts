import type { CursorRef } from '../kernel/presence.ts'

// --- Proximity ---------------------------------------------------------------
// The read endpoints sort their results by nearness to a teammate's live
// cursor, *when one is available*. Presence (cursor + currentPageId) is
// ephemeral and only exists while a browser tab is connected, so this is a
// best-effort overlay: with nobody connected the endpoints fall back to plain
// document order.

// The client-computed spatial stamp carried in presence.meta.stamp, and its
// server-side trust boundary (parseStamp — never trust presence meta) live
// in @ensembleworks/contracts, shared verbatim with the client's computeStamp.

// Recover plain text from a tldraw richText doc (the ProseMirror JSON that
// toRichText produces). Top-level paragraphs join with newlines; text nodes
// within a paragraph concatenate. The inverse of toRichText, server-side and
// without an Editor — used by the read endpoints to surface sticky/text bodies.
export function richTextToPlainText(rich: any): string {
	if (!rich || !Array.isArray(rich.content)) return ''
	const textOf = (node: any): string => {
		if (!node) return ''
		if (typeof node.text === 'string') return node.text
		if (Array.isArray(node.content)) return node.content.map(textOf).join('')
		return ''
	}
	return rich.content.map(textOf).join('\n')
}

// The page id a shape ultimately lives on (walks up nested parents).
export function pageIdOf(shape: any, byId: Map<string, any>): string | null {
	let pid: string | undefined = shape.parentId
	let guard = 0
	while (pid && pid.startsWith('shape:') && guard++ < 50) {
		pid = byId.get(pid)?.parentId
	}
	return pid ?? null
}

// A shape's top-left in page coordinates (child x/y are parent-relative).
export function pagePoint(shape: any, byId: Map<string, any>): { x: number; y: number } {
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

export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y)
}

// The point a teammate's reads are ordered by: their client-computed stamp
// point when present (where they're at / looking at — the cursor is usually
// parked off-canvas since the camera bubble decoupled from it), else the raw
// cursor. Point *selection* only; no geometry is recomputed here.
export function sortPointOf(ref: CursorRef): { x: number; y: number } {
	return ref.stamp?.at ?? ref.cursor
}

// Sort items (each carrying a page-space `pt`) by distance to the sort point
// (the teammate's stamp point when present, else their raw cursor — see
// sortPointOf), attaching a rounded `dist`. Returns a new array; input order
// on a tie is preserved. With no cursor, returns the items unchanged and
// undistanced.
export function byProximity<T extends { pt: { x: number; y: number } }>(
	items: T[],
	cursor: CursorRef | null
): Array<Omit<T, 'pt'> & { dist: number | null }> {
	const decorated = items.map((it, i) => {
		const { pt, ...rest } = it
		const d = cursor ? dist(pt, sortPointOf(cursor)) : null
		return { rest, d, i }
	})
	if (cursor) decorated.sort((a, b) => a.d! - b.d! || a.i - b.i)
	return decorated.map((e) => ({ ...(e.rest as Omit<T, 'pt'>), dist: e.d === null ? null : Math.round(e.d) }))
}
