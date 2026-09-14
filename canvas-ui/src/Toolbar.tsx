import type { CSSProperties } from 'react'
import { TOOL_SHORTCUT_LABEL, type ToolId } from '@ensembleworks/canvas-editor'
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
}

const containerStyle: CSSProperties = {
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

export function Toolbar({ activeToolId, onSelectTool, style }: ToolbarProps) {
	return (
		<div role="toolbar" aria-label="Canvas tools" data-canvas-toolbar style={{ ...containerStyle, ...style }}>
			{TOOL_ORDER.map(({ id, label }) => {
				const shortcut = TOOL_SHORTCUT_LABEL[id]
				const title = shortcut ? `${label} (${shortcut})` : label
				const active = activeToolId === id
				return (
					<button
						key={id}
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
				)
			})}
		</div>
	)
}
