import { Editor, createShapeId } from 'tldraw'
import { parseDevInput } from './devSource'

export function createWebViewerShape(editor: Editor) {
	const input = window.prompt(
		'File path (relative to agent home) — or a local dev server URL / port (e.g. localhost:3000):'
	)?.trim()
	if (!input) return
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	const dev = parseDevInput(input)
	if (!dev && /^https?:\/\//.test(input)) {
		window.alert('Only local (localhost:<port>) URLs are supported — external URLs cannot be shared or followed.')
		return
	}
	editor.createShape({
		id,
		type: 'web-viewer',
		x: x - 360,
		y: y - 270,
		props: dev
			? { w: 960, h: 640, kind: 'dev', port: dev.port, path: dev.path, title: `:${dev.port}`, rev: 0 }
			: { w: 720, h: 540, kind: 'file', path: input, title: input.split('/').pop() ?? input, rev: 0 },
	})
	editor.setSelectedShapes([id])
}
