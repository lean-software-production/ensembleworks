/**
 * The "audible zone" ring (legibility cue #3): a faint dashed circle at the
 * huddle radius — teammates whose cursors are inside it are at full volume.
 * Screen-space and therefore constant on screen (the radius is a fraction of
 * the viewport half-diagonal, spatial.ts); zooming changes which CONTENT sits
 * inside it, which is what teaches zoom-to-reach. Hidden in standup mode
 * (volumes are pinned, the ring would lie) and when there's no one to hear.
 * Non-interactive; sits above the canvas like LeashOverlay.
 */
import { useValue, type Editor } from 'tldraw'
import { wm } from '../theme'
import { DEFAULT_SCREEN_SPATIAL_SETTINGS } from './spatial'

export function AudibleZoneOverlay({ editor, show }: { editor: Editor; show: boolean }) {
	const geo = useValue(
		'audible-zone',
		() => {
			const screen = editor.getViewportScreenBounds()
			const halfDiagonalPx = Math.hypot(screen.w, screen.h) / 2
			return {
				cx: screen.midX,
				cy: screen.midY,
				r: DEFAULT_SCREEN_SPATIAL_SETTINGS.huddleFraction * halfDiagonalPx,
			}
		},
		[editor]
	)
	if (!show) return null
	return (
		<svg
			data-testid="ew-audible-zone"
			style={{
				position: 'fixed',
				inset: 0,
				width: '100%',
				height: '100%',
				pointerEvents: 'none',
				zIndex: 998, // just under the leashes (999)
			}}
		>
			<circle
				cx={geo.cx}
				cy={geo.cy}
				r={geo.r}
				fill="none"
				stroke={wm.sealBlue}
				strokeWidth={1.5}
				strokeDasharray="6 8"
				opacity={0.35}
			/>
		</svg>
	)
}
