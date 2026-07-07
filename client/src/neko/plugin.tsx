/**
 * Neko plugin: the shared-browser shape, its toolbar icon and tool.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createNekoShape } from './createNekoShape'
import { NEKO_ICON_NAME, NEKO_TOOLBAR_ICON, NekoShapeUtil } from './NekoShapeUtil'

function NekoToolbarItem() {
	const tools = useTools()
	if (!tools['neko']) return null
	return <TldrawUiMenuItem {...tools['neko']} />
}

export const nekoPlugin: ClientPlugin = {
	id: 'neko',
	shapeUtils: [NekoShapeUtil],
	icons: { [NEKO_ICON_NAME]: NEKO_TOOLBAR_ICON },
	tools: (editor: Editor) => ({
		neko: {
			id: 'neko',
			icon: NEKO_ICON_NAME,
			label: 'New shared browser',
			readonlyOk: false,
			onSelect() {
				createNekoShape(editor)
			},
		},
	}),
	ToolbarItems: NekoToolbarItem,
	barItems: [
		{
			id: 'neko',
			label: 'browser',
			icon: NEKO_ICON_NAME,
			placement: 'overflow',
			onSelect: (editor) => createNekoShape(editor),
		},
	],
}
