import { Editor, createShapeId } from 'tldraw'
import { toProxiedUrl } from './IframeShapeUtil'

export function createDevServerShape(editor: Editor) {
	const input = window.prompt('Dev server port (or full URL):', '3000')?.trim()
	if (!input) return
	const url = /^\d+$/.test(input) ? `/dev/${input}/` : toProxiedUrl(input)
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'iframe',
		x: x - 400,
		y: y - 300,
		props: { w: 800, h: 600, url, title: `dev server ${input}` },
	})
	editor.setSelectedShapes([id])
}
