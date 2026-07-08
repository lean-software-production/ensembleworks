/**
 * File-viewer plugin: the sandboxed-iframe file shape and its command-bar entry.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { createFileViewerShape } from './createFileViewerShape'
import { FileViewerShapeUtil } from './FileViewerShapeUtil'

export const fileViewerPlugin: ClientPlugin = {
	id: 'file-viewer',
	shapeUtils: [FileViewerShapeUtil],
	barItems: [
		{
			id: 'file-viewer',
			label: 'file viewer',
			icon: 'tool-text',
			placement: 'overflow',
			onSelect: (editor) => createFileViewerShape(editor),
		},
	],
}
