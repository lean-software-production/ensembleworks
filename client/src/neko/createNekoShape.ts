import { Editor, createShapeId } from 'tldraw'
import { NEKO_DEFAULT_BASE, NEKO_DEFAULT_H, NEKO_DEFAULT_W } from './NekoShapeUtil'

export function createNekoShape(editor: Editor) {
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'neko',
		x: x - NEKO_DEFAULT_W / 2,
		y: y - NEKO_DEFAULT_H / 2,
		props: { w: NEKO_DEFAULT_W, h: NEKO_DEFAULT_H, base: NEKO_DEFAULT_BASE, title: 'shared browser' },
	})
	editor.setSelectedShapes([id])
}
