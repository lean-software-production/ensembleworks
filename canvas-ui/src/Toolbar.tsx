import type { CSSProperties } from 'react'
import { TOOL_SHORTCUT_LABEL, type ToolId } from '@ensembleworks/canvas-editor'
import { ArmedStyleFlyout } from './ArmedStyleFlyout.js'
import type { StyleChange } from './style-controls.js'
import { ToolIcon } from './tool-icons.js'
import { UI_VARS } from './theme.js'

export const TOOL_ORDER: readonly { readonly id: ToolId; readonly label: string }[] = [
	{ id: 'select', label: 'Select' },
	{ id: 'hand', label: 'Hand' },
	{ id: 'note', label: 'Note' },
	{ id: 'text', label: 'Text' },
	{ id: 'geo', label: 'Shape' },
	{ id: 'frame', label: 'Frame' },
	{ id: 'arrow', label: 'Arrow' },
	{ id: 'draw', label: 'Draw' },
	{ id: 'line', label: 'Line' },
]

export interface ToolbarProps {
	readonly activeToolId: ToolId
	readonly onSelectTool: (id: ToolId) => void
	/** Merged over the toolbar's own container style — hosts use it for placement. */
	readonly style?: CSSProperties
	readonly orientation?: 'horizontal' | 'vertical'
	/** With `onArmStyle`, shows the active tool's next-shape style: beside its
	 * button on a vertical rail, past the bar's end when horizontal. */
	readonly nextShapeStyle?: Record<string, unknown>
	/** `SetNextStyle`; a host that omits it gets no flyout. */
	readonly onArmStyle?: StyleChange
}

const containerStyle: CSSProperties = {
	// Containing block for a horizontal bar's flyout.
	position: 'relative',
	display: 'inline-flex',
	gap: 2,
	padding: 4,
	borderRadius: 8,
	background: UI_VARS.panelBg,
	border: `1px solid ${UI_VARS.panelBorder}`,
}

function buttonStyle(active: boolean): CSSProperties {
	return {
		width: 32,
		height: 32,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		padding: 0,
		borderRadius: 6,
		border: 'none',
		cursor: 'pointer',
		background: active ? UI_VARS.accent : 'transparent',
		color: active ? UI_VARS.accentFg : UI_VARS.panelFg,
	}
}

const SEPARATOR_STYLE: CSSProperties = { height: 1, margin: '2px 4px', background: UI_VARS.panelBorder }

export function Toolbar({ activeToolId, onSelectTool, style, orientation = 'horizontal', nextShapeStyle, onArmStyle }: ToolbarProps) {
	const vertical = orientation === 'vertical'
	const showFlyout = nextShapeStyle !== undefined && onArmStyle !== undefined
	return (
		<div
			role="toolbar"
			aria-label="Canvas tools"
			data-canvas-toolbar
			aria-orientation={orientation}
			style={{ ...containerStyle, flexDirection: vertical ? 'column' : 'row', ...style }}
		>
			{TOOL_ORDER.map(({ id, label }) => {
				const shortcut = TOOL_SHORTCUT_LABEL[id]
				const title = shortcut ? `${label} (${shortcut})` : label
				const active = activeToolId === id
				return (
					<div key={id} style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
						<button
							type="button"
							data-canvas-tool={id}
							aria-pressed={active}
							aria-label={title}
							title={title}
							onClick={() => onSelectTool(id)}
							style={buttonStyle(active)}
						>
							<ToolIcon tool={id} />
						</button>
						{vertical && active && showFlyout && (
							<ArmedStyleFlyout toolId={id} nextShapeStyle={nextShapeStyle} onArmStyle={onArmStyle} side="right" />
						)}
						{/* Navigation tools (select, hand) sit apart from the creation tools on the rail. */}
						{vertical && id === 'hand' && <div aria-hidden="true" style={SEPARATOR_STYLE} />}
					</div>
				)
			})}
			{/* Past the bar's end rather than under the button: below, a tall card
			    would cover the host's chrome under the bar and the canvas area
			    where the next shape gets drawn. */}
			{!vertical && showFlyout && (
				<ArmedStyleFlyout toolId={activeToolId} nextShapeStyle={nextShapeStyle} onArmStyle={onArmStyle} side="end" />
			)}
		</div>
	)
}
