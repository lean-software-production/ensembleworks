/**
 * Pilot 5 (Task F4 — F1 owner decision: Option 1, indicator only; no lock,
 * concurrent setText remains a documented LWW stomp). Renders a small
 * "peer is editing" badge on every shape a REMOTE peer's presence.editing
 * names — never on a shape THIS peer itself is editing (TextEditor.tsx
 * already owns that shape's own UI; showing your own badge back at yourself
 * would be noise, not signal).
 *
 * SCREEN-SPACE, NOT a WorldLayer child (quality-review fix, pilot-5 round —
 * the first cut rendered inside WorldLayer and inherited the camera
 * transform, so the badge scaled with zoom: unreadably small zoomed out,
 * comically large zoomed in): the badge is UI chrome, not canvas content —
 * a presence affordance should stay constant-size and legible at every zoom,
 * exactly like the Cursors overlay. So this component follows the Cursors
 * idiom precisely: it takes `camera` + `viewportSize`, converts each badge's
 * world anchor through `worldToScreen`, offsets in SCREEN px, and
 * CanvasV2App renders it OUTSIDE WorldLayer as a late Viewport sibling
 * (Viewport.tsx's STACKING CONTRACT: later DOM siblings paint over earlier
 * ones — so it is never occluded by shape bodies either).
 *
 * NOT a canvas-react component: canvas-react may not import canvas-sync
 * (boundary.test.ts forbids it — clean-room), and this badge's whole reason
 * to exist is reading canvas-sync's wire `Presence.editing` field directly
 * (no adapter layer needed for a single string field, unlike Cursors.tsx's
 * `RemotePresence` narrowing).
 *
 * KEPT MINIMAL (per the plan's own text): the interaction contract
 * (`peer-editing-is-visible`) only asserts the marker's PRESENCE
 * (`data-overlay="editing"` + `data-editing-shape-id`), never its styling —
 * so this component makes no attempt at polish (exact corner rounding,
 * animation, avatar/name) beyond "visibly there and legible."
 */
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import { worldTransform } from '@ensembleworks/canvas-model'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import type { ViewportSize } from '@ensembleworks/canvas-react'
import type { Presence } from '@ensembleworks/canvas-sync'

export interface EditingIndicatorsProps {
	readonly presence: Readonly<Record<string, Presence>>
	readonly selfKey: string
	readonly snapshot: CanvasDocument
	readonly camera: Camera
	readonly viewportSize: ViewportSize
}

/** How far ABOVE the shape's anchor point the badge sits, in SCREEN px —
 * constant at every zoom (the whole point of the screen-space placement). */
const BADGE_OFFSET_PX = 20

export function EditingIndicators({ presence, selfKey, snapshot, camera, viewportSize }: EditingIndicatorsProps) {
	const badges: Array<{ key: string; shapeId: string; left: number; top: number }> = []
	for (const [key, p] of Object.entries(presence)) {
		if (key === selfKey) continue // never badge back at yourself — see module header
		const shapeId = p.editing
		if (!shapeId) continue
		const shape = snapshot.byId.get(shapeId)
		if (!shape) continue // the shape isn't in THIS peer's current snapshot (deleted, or not yet synced) — omit, don't throw
		// Anchor: the shape's world-transform origin (its unrotated top-left),
		// converted to screen. NOTE: the badge ignores shape ROTATION — it is
		// axis-aligned at the origin's screen point, so on a rotated shape it
		// may visually detach from what reads as the shape's "top edge" —
		// accepted minimal scope (placement/styling is not contract-asserted).
		const t = worldTransform(snapshot, shape)
		const screen = worldToScreen(camera, { x: t.x, y: t.y })
		// Off-viewport badges are omitted entirely, matching Cursors.tsx's
		// OFF-VIEWPORT posture (omit, no edge-clamped affordance — the same
		// documented v1 simplification).
		if (screen.x < 0 || screen.x > viewportSize.width || screen.y < 0 || screen.y > viewportSize.height) continue
		badges.push({ key, shapeId, left: screen.x, top: screen.y - BADGE_OFFSET_PX })
	}
	if (badges.length === 0) return null

	return (
		<>
			{badges.map((b) => (
				<div
					key={b.key}
					data-overlay="editing"
					data-editing-shape-id={b.shapeId}
					style={{
						position: 'absolute',
						left: b.left,
						top: b.top,
						pointerEvents: 'none',
						whiteSpace: 'nowrap',
						fontSize: 10,
						lineHeight: '14px',
						padding: '1px 5px',
						borderRadius: 3,
						background: '#d98c2b',
						color: '#fff',
					}}
				>
					editing…
				</div>
			))}
		</>
	)
}
