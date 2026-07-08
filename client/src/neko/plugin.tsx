/**
 * Neko plugin: the shared-browser shape and its command-bar entry.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { createNekoShape } from './createNekoShape'
import { NEKO_ICON_NAME, NEKO_TOOLBAR_ICON, NekoShapeUtil } from './NekoShapeUtil'

export const nekoPlugin: ClientPlugin = {
	id: 'neko',
	shapeUtils: [NekoShapeUtil],
	icons: { [NEKO_ICON_NAME]: NEKO_TOOLBAR_ICON },
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
