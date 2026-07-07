/**
 * Terminal plugin: shape util, the "New terminal" toolbar button, and the
 * delete-veto room hook.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { openNewTerminal } from './openNewTerminal'
import { TerminalShapeUtil } from './TerminalShapeUtil'
import { TerminalToolbarItem } from './TerminalToolbarItem'

export const terminalPlugin: ClientPlugin = {
	id: 'terminal',
	shapeUtils: [TerminalShapeUtil],
	ToolbarItems: TerminalToolbarItem,
	barItems: [
		{
			id: 'terminal',
			label: 'terminal',
			accelerator: 'm',
			icon: 'tool-frame',
			placement: 'priority',
			onSelect: openNewTerminal,
		},
	],
	roomHooks: () => {
		// Terminals are easy to delete by accident (one stray Backspace on a
		// selected shape). Veto local deletions unless the user confirms. One
		// dialog covers the whole delete gesture: batch members reach the
		// handler microseconds apart, so a decision is reused (and its window
		// extended) while calls keep arriving within 250ms of the last one —
		// measured from when the dialog closed, since confirm() blocks for
		// however long the user thinks. The tmux session itself survives.
		let decision = false
		let decidedAt = 0
		return {
			beforeShapeDelete(shape, source) {
				if (source !== 'user' || shape.type !== 'terminal') return
				const props = shape.props as { title?: string; sessionId?: string }
				if (Date.now() - decidedAt > 250) {
					decision = window.confirm(
						`Delete terminal "${props.title ?? ''}"` +
							` (and any other terminals in this selection)?\n\n` +
							`tmux sessions keep running on the VM — reattach with: ` +
							`tmux attach -t canvas-${props.sessionId ?? '<id>'}`
					)
				}
				decidedAt = Date.now()
				if (!decision) return false
			},
		}
	},
}
