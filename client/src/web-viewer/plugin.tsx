/**
 * File-viewer plugin: the sandboxed-iframe file shape and its command-bar entry.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { createWebViewerShape } from './createWebViewerShape'
import { WebViewerShapeUtil } from './WebViewerShapeUtil'

export const webViewerPlugin: ClientPlugin = {
	id: 'web-viewer',
	shapeUtils: [WebViewerShapeUtil],
	barItems: [
		{
			id: 'web-viewer',
			label: 'web viewer',
			icon: 'tool-text',
			placement: 'overflow',
			onSelect: (editor) => createWebViewerShape(editor),
		},
	],
}
