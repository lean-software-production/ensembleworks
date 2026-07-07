/**
 * Iframe plugin: proxied-iframe shape, the "Embed dev server" tool, and the
 * paste-a-URL handler.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createDevServerShape } from './createDevServerShape'
import { IframeShapeUtil } from './IframeShapeUtil'
import { PasteUrlHandler } from './PasteUrlHandler'

function DevServerToolbarItem() {
	const tools = useTools()
	if (!tools['dev-server']) return null
	return <TldrawUiMenuItem {...tools['dev-server']} />
}

export const iframePlugin: ClientPlugin = {
	id: 'iframe',
	shapeUtils: [IframeShapeUtil],
	tools: (editor: Editor) => ({
		'dev-server': {
			id: 'dev-server',
			icon: 'tool-embed',
			label: 'Embed dev server',
			readonlyOk: false,
			onSelect() {
				createDevServerShape(editor)
			},
		},
	}),
	ToolbarItems: DevServerToolbarItem,
	barItems: [
		{
			id: 'dev-server',
			label: 'dev server',
			icon: 'tool-embed',
			placement: 'overflow',
			onSelect: (editor) => createDevServerShape(editor),
		},
	],
	Overlay: PasteUrlHandler,
}
