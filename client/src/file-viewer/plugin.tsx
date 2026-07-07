/**
 * File-viewer plugin: the sandboxed-iframe file shape and its toolbar tool.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createFileViewerShape } from './createFileViewerShape'
import { FileViewerShapeUtil } from './FileViewerShapeUtil'

function FileViewerToolbarItem() {
	const tools = useTools()
	if (!tools['file-viewer']) return null
	return <TldrawUiMenuItem {...tools['file-viewer']} />
}

export const fileViewerPlugin: ClientPlugin = {
	id: 'file-viewer',
	shapeUtils: [FileViewerShapeUtil],
	tools: (editor: Editor) => ({
		'file-viewer': {
			id: 'file-viewer',
			icon: 'tool-text',
			label: 'File viewer',
			readonlyOk: false,
			onSelect() {
				createFileViewerShape(editor)
			},
		},
	}),
	ToolbarItems: FileViewerToolbarItem,
}
