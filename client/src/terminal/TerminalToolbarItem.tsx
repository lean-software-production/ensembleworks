/** Legacy toolbar slot for the terminal button; delegates to openNewTerminal.
 * Removed in Phase-1 Task 6 when the command bar replaces DefaultToolbar. */
import { TldrawUiMenuItem, useDialogs, useEditor } from 'tldraw'
import { openNewTerminal } from './openNewTerminal'

export function TerminalToolbarItem() {
	const editor = useEditor()
	const { addDialog } = useDialogs()
	return (
		<TldrawUiMenuItem
			id="terminal"
			icon="tool-frame"
			label="New terminal"
			readonlyOk={false}
			onSelect={() => openNewTerminal(editor, { addDialog })}
		/>
	)
}
