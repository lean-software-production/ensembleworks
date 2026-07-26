/**
 * Locked-shape badge decision (locked-shape affordance spec §5): given what is
 * hovered, what is selected, and a lock-state lookup, which shape ids should
 * show a padlock chip?
 *
 * MUST NOT import 'tldraw' — must stay importable under bare bun test scripts
 * (see framesDrawerLayout.ts's header for why that matters). Shape ids are
 * plain strings here and the lock lookup is injected; LockedShapeBadge.tsx
 * supplies editor.isShapeOrAncestorLocked, so an ancestor-locked child is
 * reported locked without this module knowing what a frame is.
 */

export interface BadgedShapesInput {
	/** editor.getHoveredShapeId() — null when nothing is hovered. */
	hoveredShapeId: string | null
	/** editor.getSelectedShapeIds(). */
	selectedShapeIds: readonly string[]
	/** True when the shape is locked, or sits inside a locked ancestor. */
	isLocked: (id: string) => boolean
}

/**
 * Hovered first (when it qualifies), then the selection in its own order, with
 * duplicates dropped — the hovered shape is very often also the selected one,
 * and two chips stacked at the same coordinates would render as one smudged
 * badge.
 *
 * No cap, deliberately: a truncated set lies about how many shapes are locked
 * (spec §5).
 */
export function badgedLockedShapeIds(input: BadgedShapesInput): string[] {
	const { hoveredShapeId, selectedShapeIds, isLocked } = input
	const out: string[] = []
	const seen = new Set<string>()
	const push = (id: string) => {
		if (seen.has(id)) return
		if (!isLocked(id)) return
		seen.add(id)
		out.push(id)
	}
	if (hoveredShapeId) push(hoveredShapeId)
	for (const id of selectedShapeIds) push(id)
	return out
}
