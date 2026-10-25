/**
 * Locked-shape padlock chip (locked-shape affordance spec §3/§5): lives in the
 * InFrontOfTheCanvas slot alongside ContextualStylePanel and FocusOverlay (see
 * ui.tsx).
 *
 * A locked shape is otherwise completely indistinguishable from an unlocked one
 * and silently ignores every interaction — tldraw ships no locked-shape visual
 * at all. This chip appears just outside a shape's top-right corner while that
 * shape is hovered OR selected, and nowhere else: at rest the canvas looks
 * exactly as it did.
 *
 * Top-RIGHT, specifically, because the terminal shape pins its own title chip
 * top-left (TerminalShapeUtil.tsx:736-751, `left: 0; bottom: 100%`), so the two
 * can never collide.
 *
 * HARD PREREQUISITE: `selectLockedShapes: true` on the <Tldraw> options prop
 * (App.tsx). Hover hit-testing passes `hitLocked: editor.options
 * .selectLockedShapes` (tldraw's updateHoveredShapeId.ts) and the default is
 * false, so without it getHoveredShapeId() can never return a locked shape and
 * this component silently renders nothing forever.
 *
 * Informational only — never a control (spec §6). Right-click -> Unlock already
 * exists and is how the live incident was resolved; knowing the shape is locked
 * was the whole problem. Hence pointerEvents: 'none' on every chip.
 */
import type { CSSProperties } from 'react'
import { useEditor, useValue, type TLShapeId } from 'tldraw'
import { wm } from '../theme'
import { badgedLockedShapeIds } from './lockedShapes'

interface BadgePlacement {
	id: string
	/** Container-relative viewport coords of the shape's top-right corner. */
	x: number
	y: number
}

// Reuses the terminal title chip's visual language (mono, small) so the padlock
// reads as shape chrome rather than as canvas content.
const chipStyle: CSSProperties = {
	position: 'absolute',
	display: 'flex',
	alignItems: 'center',
	padding: '1px 5px',
	background: wm.bg,
	border: `1px solid ${wm.ruleStrong}`,
	borderRadius: 4,
	boxShadow: wm.shadowPaper,
	fontFamily: wm.mono,
	fontSize: 11,
	lineHeight: '16px',
	color: wm.ink,
	// Informational only (spec §6) — must never eat a canvas click.
	pointerEvents: 'none',
	// Same layer as FocusOverlay's own buttons: above the canvas, below the
	// side panel and rail.
	zIndex: 410,
}

export function LockedShapeBadge() {
	const editor = useEditor()

	const placements = useValue<BadgePlacement[]>(
		'locked shape badges',
		() => {
			// Subscribe to pan / zoom — neither the hovered id nor the selection
			// changes when the camera moves, so without this read the chips would
			// stay pinned to stale screen coordinates (same trick as
			// av/leashes.tsx).
			editor.getCamera()
			const ids = badgedLockedShapeIds({
				hoveredShapeId: editor.getHoveredShapeId(),
				selectedShapeIds: editor.getSelectedShapeIds(),
				isLocked: (id) => editor.isShapeOrAncestorLocked(id as TLShapeId),
			})
			const out: BadgePlacement[] = []
			for (const id of ids) {
				const bounds = editor.getShapePageBounds(id as TLShapeId)
				// Shape deleted between the id read and this lookup, or not on the
				// current page — skip rather than render a chip at (0,0).
				if (!bounds) continue
				// pageToViewport is already container-relative, which is the space
				// these left/top values are measured in (FocusOverlay.tsx "Fix 3").
				const topRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.minY })
				out.push({ id, x: topRight.x, y: topRight.y })
			}
			return out
		},
		[editor]
	)

	if (placements.length === 0) return null

	return (
		<>
			{placements.map((p) => (
				<div
					key={p.id}
					// aria-label, not title: pointerEvents is 'none', so a title
					// tooltip could never be hovered into existence anyway.
					aria-label="Locked"
					style={{ ...chipStyle, left: p.x + 6, top: p.y }}
				>
					🔒
				</div>
			))}
		</>
	)
}
