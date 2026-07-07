import { Editor, createShapeId } from 'tldraw'

export function createFileViewerShape(editor: Editor) {
	const input = window.prompt('File path (relative to agent home):')?.trim()
	if (!input) return
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'file-viewer',
		x: x - 360,
		y: y - 270,
		props: { w: 720, h: 540, path: input, title: input.split('/').pop() ?? input, rev: 0 },
	})
	editor.setSelectedShapes([id])
}
