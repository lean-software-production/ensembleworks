/**
 * Terminal plugin: shape util, the "New terminal" command-bar entry, and the
 * delete-veto room hook.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { openNewTerminal } from './openNewTerminal'
import { TerminalShapeUtil } from './TerminalShapeUtil'

// Command-bar icon: a terminal window with a `>` prompt + cursor. tldraw has no
// built-in console glyph (the bar used 'tool-frame' as a placeholder), so we
// register our own the same way screenshare/neko do — a single-colour
// silhouette tldraw renders as a CSS mask, exposed via <Tldraw assetUrls> in
// App.tsx (collectIcons).
const TERMINAL_ICON_NAME = 'terminal'
const TERMINAL_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
	'<rect x="2" y="4" width="20" height="16" rx="2"/>' +
	'<path d="M6 9.5 9 12l-3 2.5"/>' +
	'<path d="M12.5 14.5H17"/></svg>'
const TERMINAL_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(TERMINAL_ICON_SVG)}`

export const terminalPlugin: ClientPlugin = {
	id: 'terminal',
	shapeUtils: [TerminalShapeUtil],
	icons: { [TERMINAL_ICON_NAME]: TERMINAL_TOOLBAR_ICON },
	barItems: [
		{
			id: 'terminal',
			label: 'terminal',
			accelerator: 'm',
			icon: TERMINAL_ICON_NAME,
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
