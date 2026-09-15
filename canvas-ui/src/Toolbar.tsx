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
	/** With `onArmStyle` on a vertical rail, shows the active tool's next-shape
	 * style beside the rail. A horizontal toolbar shows none. */
	readonly nextShapeStyle?: Record<string, unknown>
	/** `SetNextStyle`; a host that omits it gets no flyout. */
	readonly onArmStyle?: StyleChange
}

const containerStyle: CSSProperties = {
	// Containing block for the rail's flyout.
	position: 'relative',
	display: 'inline-flex',
	// Lets a host's max-height shrink the rail (its scroller takes the overflow).
	minHeight: 0,
	boxSizing: 'border-box',
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

// A rail taller than its host scrolls rather than pushing tools off-edge.
// Deliberately unpositioned: overflow clips only descendants contained inside
// the scroller, and the flyout is contained by the rail around it.
const RAIL_SCROLLER_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0, overflowX: 'hidden', overflowY: 'auto' }
const ROW_STYLE: CSSProperties = { display: 'flex', flexDirection: 'row', gap: 2 }

const SEPARATOR_STYLE: CSSProperties = { height: 1, margin: '2px 4px', background: UI_VARS.panelBorder }

export function Toolbar({ activeToolId, onSelectTool, style, orientation = 'horizontal', nextShapeStyle, onArmStyle }: ToolbarProps) {
	const vertical = orientation === 'vertical'
	const showFlyout = vertical && nextShapeStyle !== undefined && onArmStyle !== undefined
	return (
		<div
			role="toolbar"
			aria-label="Canvas tools"
			data-canvas-toolbar
			aria-orientation={orientation}
			style={{ ...containerStyle, flexDirection: vertical ? 'column' : 'row', ...style }}
		>
			<div data-canvas-toolbar-scroller style={vertical ? RAIL_SCROLLER_STYLE : ROW_STYLE}>
				{TOOL_ORDER.map(({ id, label }) => {
					const shortcut = TOOL_SHORTCUT_LABEL[id]
					const title = shortcut ? `${label} (${shortcut})` : label
					const active = activeToolId === id
					return (
						// Not positioned: the flyout inside resolves against the rail itself.
						<div key={id} style={{ display: 'flex', flexDirection: 'column' }}>
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
							{active && showFlyout && (
								<ArmedStyleFlyout toolId={id} nextShapeStyle={nextShapeStyle} onArmStyle={onArmStyle} />
							)}
							{/* Navigation tools (select, hand) sit apart from the creation tools on the rail. */}
							{vertical && id === 'hand' && <div aria-hidden="true" style={SEPARATOR_STYLE} />}
						</div>
					)
				})}
			</div>
		</div>
	)
}
