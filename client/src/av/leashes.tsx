/**
 * A leash from a panel tile to its teammate's live cursor — drawn only for the
 * tile you're actively hovering, and only when that cursor is on the page
 * you're viewing. The leash anchors at the tile's on-screen centre (a live DOM
 * element looked up via `getFaceEl`, pull-based — see av/bridge.ts), so it must
 * recompute after tiles render — the useValue below re-derives on camera pans
 * and hover changes.
 *
 * Speaking does NOT draw a leash. It used to (the active speaker leashed
 * unconditionally), but a line whipping across the canvas every time anyone
 * talks reads as noise, not information — in a room where people talk
 * constantly it is on more than it is off. Hover stays: it's an explicit,
 * one-at-a-time "where is this person?" request. Speaking is still signalled on
 * the tile itself (the blue outline in chrome/PanelTile.tsx).
 *
 * Every panel tile registers as an anchor, camera on or off, so hovering a
 * camera-off teammate leashes to their cursor too.
 */
import { Editor, useValue } from 'tldraw'
import { rawUserId } from '@ensembleworks/contracts'

export interface Leash {
	id: string
	x1: number
	y1: number
	x2: number
	y2: number
	color: string
}

export function useLeashes(
	editor: Editor,
	hoveredId: string | null,
	getFaceEl: (id: string) => HTMLElement | null
): Leash[] {
	return useValue<Leash[]>(
		'leashes',
		() => {
			if (!hoveredId) return []
			editor.getCamera() // subscribe to pan / zoom
			const presence = editor
				.getCollaboratorsOnCurrentPage()
				.find((c) => rawUserId(c.userId) === hoveredId)
			if (!presence?.cursor) return []
			const el = getFaceEl(hoveredId)
			if (!el) return []
			const rect = el.getBoundingClientRect()
			const end = editor.pageToViewport({ x: presence.cursor.x, y: presence.cursor.y })
			return [
				{
					id: hoveredId,
					x1: rect.left + rect.width / 2,
					y1: rect.top + rect.height / 2,
					x2: end.x,
					y2: end.y,
					color: presence.color,
				},
			]
		},
		[editor, hoveredId, getFaceEl]
	)
}

// A full-viewport SVG that draws the active leash from a panel tile to its
// teammate's cursor. Non-interactive; sits above the canvas but below the panel.
export function LeashOverlay({ leashes }: { leashes: Leash[] }) {
	if (leashes.length === 0) return null
	return (
		<svg
			style={{
				position: 'fixed',
				inset: 0,
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				zIndex: 999,
			}}
		>
			{leashes.map((l) => (
				<line
					key={l.id}
					x1={l.x1}
					y1={l.y1}
					x2={l.x2}
					y2={l.y2}
					stroke={l.color}
					strokeWidth={1.5}
					strokeDasharray="4 4"
					strokeLinecap="round"
					opacity={0.6}
				/>
			))}
		</svg>
	)
}
