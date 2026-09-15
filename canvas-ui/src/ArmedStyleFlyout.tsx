// Next-shape style options for the armed tool, shown as a card attached to
// the tool toolbar. Every axis renders expanded because choosing the next
// shape's style is the card's whole purpose; a click calls `onArmStyle`
// (-> `SetNextStyle`). Opacity is left out to keep the card compact.
// Hook-free so toolbar.test.ts can call it as a plain function.
import type { CSSProperties, ReactElement } from 'react'
import {
	kindDefault,
	kindForTool,
	relevantAxesForTool,
	toolbarSlots,
	type StyleAxis,
	type StyleValue,
	type ToolId,
} from '@ensembleworks/canvas-editor'
import { AxisRow, type StyleChange } from './style-controls.js'
import { UI_VARS } from './theme.js'

export interface ArmedStyleFlyoutProps {
	readonly toolId: ToolId
	readonly nextShapeStyle: Record<string, unknown>
	readonly onArmStyle: StyleChange
	/** `right`: a column beside a vertical rail's button, centred on it.
	 * `end`: a wide, short card past the end of a horizontal bar, so it
	 * extends the bar rather than hanging down over the canvas. */
	readonly side: 'right' | 'end'
}

/** `nextShapeStyle[axis]` if set, else the armed tool's kind default — so a
 * fresh mount shows what the shape would actually render with. */
export function armedValue(nextShapeStyle: Record<string, unknown>, toolId: ToolId, axis: StyleAxis): StyleValue | undefined {
	const raw = nextShapeStyle[axis]
	if (typeof raw === 'string' || typeof raw === 'number') return raw
	const kind = kindForTool(toolId)
	return kind ? kindDefault(kind, axis) : undefined
}

/** The tool's non-opacity axes in the selection toolbar's slot order, so the
 * flyout and the selection bar list styles the same way. */
function flyoutAxes(toolId: ToolId): StyleAxis[] {
	const relevant = new Set(relevantAxesForTool(toolId))
	relevant.delete('opacity')
	const kind = kindForTool(toolId)
	if (!kind || relevant.size === 0) return []
	const ordered = toolbarSlots([kind])
		.flatMap((slot) => slot.axes)
		.filter((axis) => relevant.has(axis))
	// Any relevant axis the slot table does not place still renders, last.
	return [...new Set([...ordered, ...relevant])]
}

const SIDE_PLACEMENT: Record<ArmedStyleFlyoutProps['side'], CSSProperties> = {
	right: { left: 'calc(100% + 10px)', top: '50%', transform: 'translateY(-50%)' },
	end: { left: 'calc(100% + 10px)', top: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 14, width: 'max-content', maxWidth: 760 },
}

const CARD_STYLE: CSSProperties = {
	position: 'absolute',
	display: 'flex',
	flexDirection: 'column',
	rowGap: 8,
	columnGap: 8,
	width: 220,
	padding: '10px 12px',
	background: UI_VARS.panelBg,
	border: `1px solid ${UI_VARS.panelBorder}`,
	borderRadius: 10,
	boxShadow: UI_VARS.shadow,
	color: UI_VARS.panelFg,
	fontFamily: 'system-ui, sans-serif',
	fontSize: 11,
	boxSizing: 'border-box',
	zIndex: 500,
	// The card sits beside the toolbar over the canvas edge, never over a
	// selection, so it can take pointers itself.
	pointerEvents: 'auto',
}

const HEADING_STYLE: CSSProperties = { margin: 0, fontSize: 12, fontWeight: 600 }

const TOOL_HEADINGS: Partial<Record<ToolId, string>> = { note: 'Note', text: 'Text', geo: 'Shape', arrow: 'Arrow', frame: 'Frame' }

function stopPropagation(e: { stopPropagation(): void }): void {
	e.stopPropagation()
}

export function ArmedStyleFlyout({ toolId, nextShapeStyle, onArmStyle, side }: ArmedStyleFlyoutProps): ReactElement | null {
	const axes = flyoutAxes(toolId)
	if (axes.length === 0) return null
	return (
		<div
			data-testid="ew-style-panel"
			data-style-panel-mode="armed"
			onPointerDown={stopPropagation}
			onPointerUp={stopPropagation}
			style={{ ...CARD_STYLE, ...SIDE_PLACEMENT[side] }}
		>
			<h4 style={side === 'end' ? { ...HEADING_STYLE, flexBasis: '100%' } : HEADING_STYLE}>{TOOL_HEADINGS[toolId] ?? toolId}</h4>
			{axes.map((axis) => (
				<AxisRow key={axis} axis={axis} value={armedValue(nextShapeStyle, toolId, axis)} onStyleChange={onArmStyle} />
			))}
		</div>
	)
}
