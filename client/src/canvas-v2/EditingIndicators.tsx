/**
 * Pilot 5 (Task F4 — F1 owner decision: Option 1, indicator only; no lock,
 * concurrent setText remains a documented LWW stomp). Renders a small
 * "peer is editing" badge on every shape a REMOTE peer's presence.editing
 * names — never on a shape THIS peer itself is editing (TextEditor.tsx
 * already owns that shape's own UI; showing your own badge back at yourself
 * would be noise, not signal).
 *
 * WORLD-SPACE, NOT a canvas-react component: canvas-react may not import
 * canvas-sync (boundary.test.ts forbids it — clean-room), and this badge's
 * whole reason to exist is reading canvas-sync's wire `Presence.editing`
 * field directly (no adapter layer needed for a single string field, unlike
 * Cursors.tsx's `RemotePresence` narrowing). CanvasV2App.tsx renders this as
 * a WorldLayer sibling of ShapeLayer (same "position: absolute; left: 0;
 * top: 0; transform: translate(...)" convention ShapeBody.tsx documents —
 * see its shapeBodyTransform — so the badge inherits WorldLayer's camera
 * transform for free, no separate screen conversion needed here).
 *
 * KEPT MINIMAL (per the plan's own text): the interaction contract
 * (`peer-editing-is-visible`) only asserts the marker's PRESENCE
 * (`data-overlay="editing"` + `data-editing-shape-id`), never its styling —
 * so this component makes no attempt at polish (exact corner rounding,
 * animation, avatar/name) beyond "visibly there and legible."
 */
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import { worldTransform } from '@ensembleworks/canvas-model'
import type { Presence } from '@ensembleworks/canvas-sync'

export interface EditingIndicatorsProps {
	readonly presence: Readonly<Record<string, Presence>>
	readonly selfKey: string
	readonly snapshot: CanvasDocument
}

export function EditingIndicators({ presence, selfKey, snapshot }: EditingIndicatorsProps) {
	const badges: Array<{ key: string; shapeId: string; transform: string }> = []
	for (const [key, p] of Object.entries(presence)) {
		if (key === selfKey) continue // never badge back at yourself — see module header
		const shapeId = p.editing
		if (!shapeId) continue
		const shape = snapshot.byId.get(shapeId)
		if (!shape) continue // the shape isn't in THIS peer's current snapshot (deleted, or not yet synced) — omit, don't throw
		const t = worldTransform(snapshot, shape)
		badges.push({ key, shapeId, transform: `translate(${t.x}px, ${t.y - 20}px)` })
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
						left: 0,
						top: 0,
						transformOrigin: '0 0',
						transform: b.transform,
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
