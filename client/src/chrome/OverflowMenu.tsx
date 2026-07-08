/**
 * The command bar's ⋯ overflow popover (canvas-controls spec §4: demoted
 * native tools + plugin overflow items), split out of CommandBar.tsx. Renders
 * inside the bar's position:relative root; open/close state, last-used
 * adoption and availability tracking all live up in CommandBar.
 */
import type { Editor, TLUiToolsContextType } from 'tldraw'
import type { BarItemDescriptor, BarItemHelpers } from '../kernel/plugin'
import { displayKeyForKbd } from './accel'
import { BarButton, NATIVE_LABELS, OVERFLOW_TOOLS } from './barButtons'
import { popoverBoxStyle, popoverPositionStyle } from './popover'
import type { DockEdge } from './settings'

export function OverflowMenu({
	tools,
	currentToolId,
	dockEdge,
	overflowItems,
	isItemAvailable,
	editor,
	helpers,
	recordLastOverflow,
	onClose,
}: {
	tools: TLUiToolsContextType
	currentToolId: string
	dockEdge: DockEdge
	overflowItems: BarItemDescriptor[]
	isItemAvailable: (item: BarItemDescriptor) => boolean
	editor: Editor
	helpers: BarItemHelpers
	recordLastOverflow: (id: string) => void
	onClose: () => void
}) {
	return (
		<div
			data-testid="ew-bar-overflow-menu"
			style={{ ...popoverBoxStyle, ...popoverPositionStyle(dockEdge) }}
		>
			{OVERFLOW_TOOLS.map((id) => {
				const tool = tools[id]
				if (!tool) return null
				const accel = displayKeyForKbd(tool.kbd, NATIVE_LABELS[id] ?? id)
				return (
					<BarButton
						key={id}
						id={'overflow-' + id}
						icon={tool.icon}
						label={NATIVE_LABELS[id] ?? id}
						accelerator={accel}
						active={currentToolId === id}
						onClick={() => {
							tool.onSelect('toolbar')
							recordLastOverflow(id)
							onClose()
						}}
					/>
				)
			})}
			{overflowItems.map((item) => {
				// Unavailable plugin items are hidden (plugin contract).
				if (!isItemAvailable(item)) return null
				return (
					<BarButton
						key={item.id}
						id={'overflow-' + item.id}
						icon={item.icon}
						label={item.label}
						accelerator={item.accelerator}
						onClick={() => {
							item.onSelect(editor, helpers)
							recordLastOverflow(item.id)
							onClose()
						}}
					/>
				)
			})}
		</div>
	)
}
