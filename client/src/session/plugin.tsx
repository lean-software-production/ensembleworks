/**
 * Session plugin: the "Seed session layout" main-menu entry.
 */
import { TldrawUiMenuItem, useEditor } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { seedSessionCanvas } from './seedSessionCanvas'

function SessionMenuItems() {
	const editor = useEditor()
	return (
		<TldrawUiMenuItem
			id="seed-session"
			label="Seed session layout"
			icon="duplicate"
			onSelect={() => {
				seedSessionCanvas(editor)
			}}
		/>
	)
}

export const sessionPlugin: ClientPlugin = {
	id: 'session',
	MenuItems: SessionMenuItems,
}
