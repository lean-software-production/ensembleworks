/**
 * Mosaic ordering (panel-video-mosaic spec "Ordering rules"):
 *
 * - Current page: tiles sort by cursor distance from YOUR viewport centre,
 *   closest first. Missing cursors (collaborator never moved) sort last,
 *   stable by input (join) order.
 * - Other pages: proximity is meaningless cross-page, so chips sort by
 *   most-recently-spoke, then join order.
 * - Re-sorts are MANUAL: PanelPages recomputes the current page's order only
 *   at mount and when the user presses the mosaic's Reorder button, so faces
 *   never rearrange themselves under a working cursor.
 *
 * MUST NOT import 'tldraw' — bare-bun test scripts import this module.
 */

export interface MosaicPoint {
	x: number
	y: number
}

/**
 * Sort ids by their cursor's distance from `centre`, closest first. Ids with
 * no cursor sort last. Stable (Array.prototype.sort is stable): ties and
 * missing-cursor runs keep input order.
 */
export function orderByViewportDistance(
	ids: readonly string[],
	cursors: Record<string, MosaicPoint | undefined>,
	centre: MosaicPoint
): string[] {
	const dist = (id: string): number => {
		const c = cursors[id]
		if (!c) return Infinity
		return Math.hypot(c.x - centre.x, c.y - centre.y)
	}
	return [...ids].sort((a, b) => dist(a) - dist(b))
}

/**
 * Fold the currently-speaking set into a lastSpokeAt record. Returns the
 * SAME reference when nothing changed, so React effects keyed on the record
 * don't churn (the AV snapshot republishes often).
 */
export function updateSpokeRecency(
	prev: Record<string, number>,
	speakingIds: readonly string[],
	now: number
): Record<string, number> {
	let changed = false
	for (const id of speakingIds) {
		if (prev[id] !== now) {
			changed = true
			break
		}
	}
	if (!changed) return prev
	const next = { ...prev }
	for (const id of speakingIds) next[id] = now
	return next
}

/**
 * Sort ids by lastSpokeAt descending (most recent first). Ids that never
 * spoke sort last, stable by input (join) order.
 */
export function orderByRecency(
	ids: readonly string[],
	recency: Record<string, number>
): string[] {
	const at = (id: string): number => recency[id] ?? -Infinity
	return [...ids].sort((a, b) => at(b) - at(a))
}
