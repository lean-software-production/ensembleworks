// Which triggers the selection style toolbar shows, and in what order, per
// shape kind. Pure: canvas-ui renders these slots; the table decides them.
// Axes a kind supports but rarely changes live in the trailing `more` slot.
import type { ShapeKind } from '@ensembleworks/canvas-model'
import type { StyleAxis } from './style-axes.js'

export type ToolbarSlotId = 'color' | 'font' | 'size' | 'align' | 'geo' | 'fill' | 'dash' | 'arrowheads' | 'more'

export interface ToolbarSlot {
	readonly id: ToolbarSlotId
	/** The axes this slot's popover edits; the trigger face shows `axes[0]`. */
	readonly axes: readonly StyleAxis[]
}

const slot = (id: ToolbarSlotId, ...axes: StyleAxis[]): ToolbarSlot => ({ id, axes })

// First guess from the 2026-09-15 design; tune after dogfooding.
const LAYOUT_BY_KIND: Partial<Record<ShapeKind, readonly ToolbarSlot[]>> = {
	note: [slot('color', 'color'), slot('font', 'font'), slot('size', 'size'), slot('align', 'align', 'verticalAlign'), slot('more', 'opacity')],
	text: [slot('color', 'color'), slot('font', 'font'), slot('size', 'size'), slot('align', 'textAlign'), slot('more', 'opacity')],
	geo: [slot('geo', 'geo'), slot('color', 'color'), slot('fill', 'fill'), slot('dash', 'dash'), slot('align', 'align', 'verticalAlign'), slot('more', 'size', 'font', 'opacity')],
	arrow: [slot('color', 'color'), slot('dash', 'dash'), slot('arrowheads', 'arrowheadStart', 'arrowheadEnd'), slot('more', 'size', 'fill', 'font', 'opacity')],
}

// Opacity is an envelope field every kind has.
const UNSTYLED: readonly ToolbarSlot[] = [slot('more', 'opacity')]

function layoutFor(kind: ShapeKind): readonly ToolbarSlot[] {
	return LAYOUT_BY_KIND[kind] ?? UNSTYLED
}

/** Slots for a selection of these kinds: the first kind's order, keeping only
 * axes every kind supports, dropping emptied slots. */
export function toolbarSlots(kinds: readonly ShapeKind[]): readonly ToolbarSlot[] {
	if (kinds.length === 0) return []
	const unique = [...new Set(kinds)]
	const supported = unique.map((k) => new Set(layoutFor(k).flatMap((s) => s.axes)))
	const common = (axis: StyleAxis) => supported.every((set) => set.has(axis))
	const out: ToolbarSlot[] = []
	let more: StyleAxis[] = []
	for (const s of layoutFor(unique[0]!)) {
		const axes = s.axes.filter(common)
		if (s.id === 'more') more = axes
		else if (axes.length > 0) out.push({ id: s.id, axes })
	}
	// An axis that is top-level for the first kind but only in `more` for
	// another is still top-level; an axis only in the first kind's `more`
	// stays there.
	if (more.length > 0) out.push({ id: 'more', axes: more })
	return out
}
