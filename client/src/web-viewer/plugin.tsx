/**
 * Web-viewer plugin: the sandboxed-iframe file/dev-server shape and its
 * command-bar entry.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { createWebViewerShape } from './createWebViewerShape'
import { WebViewerShapeUtil } from './WebViewerShapeUtil'

// Browser window with a play triangle — the play echoes the presenter
// cursor's "driving" badge, distinguishing this from the neko shared-browser
// icon (same window frame, dots instead). Same stroke conventions as
// NEKO_ICON_SVG so the two read as siblings in the command bar.
const WEB_VIEWER_ICON_NAME = 'web-viewer'
const WEB_VIEWER_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linejoin="round">' +
	'<rect x="3" y="5" width="18" height="14" rx="2.5"/>' +
	'<line x1="3" y1="9" x2="21" y2="9"/>' +
	'<path d="M10.2 11.4 L15 14 L10.2 16.6 Z" fill="black" stroke="none"/></svg>'
const WEB_VIEWER_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(WEB_VIEWER_ICON_SVG)}`

export const webViewerPlugin: ClientPlugin = {
	id: 'web-viewer',
	shapeUtils: [WebViewerShapeUtil],
	icons: { [WEB_VIEWER_ICON_NAME]: WEB_VIEWER_TOOLBAR_ICON },
	barItems: [
		{
			id: 'web-viewer',
			label: 'web viewer',
			icon: WEB_VIEWER_ICON_NAME,
			placement: 'overflow',
			onSelect: (editor) => createWebViewerShape(editor),
		},
	],
}
