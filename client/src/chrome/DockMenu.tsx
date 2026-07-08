/**
 * The command bar's right-click "Dock to" popover (canvas-controls spec §4
 * "Docking"), split out of CommandBar.tsx. Renders inside the bar's
 * position:relative root; open/close state lives up in CommandBar.
 */
import { wm } from '../theme'
import { popoverBoxStyle, popoverPositionStyle } from './popover'
import { updateSettings, type DockEdge } from './settings'

// Dock-to menu order, matching the spec §4 wording verbatim ("Dock to:
// bottom · left · top · right").
const DOCK_EDGE_OPTIONS: readonly DockEdge[] = ['bottom', 'left', 'top', 'right']

export function DockMenu({ dockEdge, onClose }: { dockEdge: DockEdge; onClose: () => void }) {
	return (
		<div
			data-testid="ew-bar-dock-menu"
			style={{ ...popoverBoxStyle, ...popoverPositionStyle(dockEdge) }}
		>
			<span
				style={{
					fontSize: 9,
					fontWeight: 700,
					textTransform: 'uppercase',
					letterSpacing: 0.9,
					color: wm.inkMuted,
					padding: '2px 6px',
				}}
			>
				Dock to
			</span>
			{DOCK_EDGE_OPTIONS.map((edge) => (
				<button
					key={edge}
					type="button"
					data-testid={'ew-bar-dock-' + edge}
					onClick={() => {
						updateSettings({ dockEdge: edge })
						onClose()
					}}
					style={{
						display: 'flex',
						alignItems: 'center',
						padding: '4px 8px',
						background: edge === dockEdge ? wm.accentSoft : 'transparent',
						border: edge === dockEdge ? `1px solid ${wm.sealBlue}` : '1px solid transparent',
						borderRadius: 4,
						fontFamily: wm.sans,
						fontSize: 11,
						color: wm.ink,
						cursor: 'pointer',
						textAlign: 'left',
						whiteSpace: 'nowrap',
					}}
				>
					{edge}
				</button>
			))}
		</div>
	)
}
