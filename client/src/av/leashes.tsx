/**
 * Leashes from panel tiles to their teammate's live cursor — drawn only for
 * the active speaker or the tile you're hovering, and only when that cursor
 * is on the page you're viewing. The leash anchors at the tile's on-screen
 * centre (a live DOM element looked up via `getFaceEl`, pull-based — see
 * av/bridge.ts), so it must recompute after tiles render — the useValue
 * below re-derives on camera pans, peer changes and hover changes.
 */
import { Editor, useValue } from 'tldraw'
import { rawUserId } from '@ensembleworks/contracts'
import type { RemotePeer } from './useLiveKitRoom'

export interface Leash {
	id: string
	x1: number
	y1: number
	x2: number
	y2: number
	color: string
	strong: boolean
}

export function useLeashes(
	editor: Editor,
	peers: RemotePeer[],
	hoveredId: string | null,
	getFaceEl: (id: string) => HTMLElement | null
): Leash[] {
	return useValue<Leash[]>(
		'leashes',
		() => {
			editor.getCamera() // subscribe to pan / zoom
			const collaborators = editor.getCollaboratorsOnCurrentPage()
			const out: Leash[] = []
			for (const peer of peers) {
				const id = rawUserId(peer.identity)
				if (!peer.isSpeaking && hoveredId !== id) continue
				const presence = collaborators.find((c) => rawUserId(c.userId) === id)
				if (!presence?.cursor) continue
				const el = getFaceEl(id)
				if (!el) continue
				const rect = el.getBoundingClientRect()
				const end = editor.pageToViewport({ x: presence.cursor.x, y: presence.cursor.y })
				out.push({
					id,
					x1: rect.left + rect.width / 2,
					y1: rect.top + rect.height / 2,
					x2: end.x,
					y2: end.y,
					color: presence.color,
					strong: peer.isSpeaking,
				})
			}
			return out
		},
		[editor, peers, hoveredId, getFaceEl]
	)
}

// A full-viewport SVG that draws each active leash from a rail face to its
// teammate's cursor. Non-interactive; sits above the canvas but below the rail.
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
					strokeWidth={l.strong ? 2.5 : 1.5}
					strokeDasharray={l.strong ? undefined : '4 4'}
					strokeLinecap="round"
					opacity={l.strong ? 0.9 : 0.6}
				/>
			))}
		</svg>
	)
}
