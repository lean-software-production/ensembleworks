/**
 * Codespace plugin: the container shape util + the "new codespace" overflow
 * command-bar entry (terminal/plugin.ts pattern).
 */
import type { ClientPlugin } from '../kernel/plugin'
import { CodespaceShapeUtil } from './CodespaceShapeUtil'
import { openNewCodespace } from './openNewCodespace'

// Command-bar icon: a container box holding a `>` prompt — the codespace is a
// box of terminals. Single-colour silhouette rendered by tldraw as a CSS mask
// (terminal plugin's pattern).
const CODESPACE_ICON_NAME = 'codespace'
const CODESPACE_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
	'<rect x="2" y="3" width="20" height="18" rx="2"/>' +
	'<path d="M2 8h20"/>' +
	'<path d="M7 13l3 2.5-3 2.5"/></svg>'
const CODESPACE_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(CODESPACE_ICON_SVG)}`

export const codespacePlugin: ClientPlugin = {
	id: 'codespace',
	shapeUtils: [CodespaceShapeUtil],
	icons: { [CODESPACE_ICON_NAME]: CODESPACE_TOOLBAR_ICON },
	barItems: [
		{
			id: 'codespace',
			label: 'codespace',
			icon: CODESPACE_ICON_NAME,
			placement: 'overflow',
			onSelect: openNewCodespace,
		},
	],
}
