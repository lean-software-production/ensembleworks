/**
 * Iframe plugin: proxied-iframe shape, the "Embed dev server" command-bar
 * entry, and the paste-a-URL handler.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { createDevServerShape } from './createDevServerShape'
import { IframeShapeUtil } from './IframeShapeUtil'
import { PasteUrlHandler } from './PasteUrlHandler'

export const iframePlugin: ClientPlugin = {
	id: 'iframe',
	shapeUtils: [IframeShapeUtil],
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
