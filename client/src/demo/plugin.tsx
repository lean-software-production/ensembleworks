/**
 * Demo plugin: the "Seed demo layout" main-menu entry.
 */
import { TldrawUiMenuItem, useEditor } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { seedDemoCanvas } from './seedDemoCanvas'

function DemoMenuItems() {
	const editor = useEditor()
	return (
		<TldrawUiMenuItem
			id="seed-demo"
			label="Seed demo layout"
			icon="duplicate"
			onSelect={() => seedDemoCanvas(editor)}
		/>
	)
}

export const demoPlugin: ClientPlugin = {
	id: 'demo',
	MenuItems: DemoMenuItems,
}
