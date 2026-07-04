import { createShapeId, type Editor } from 'tldraw'

export function createTerminalShape(editor: Editor, gateway?: string) {
	// Short, human-typeable ID — it is also the tmux session name suffix, so
	// `ssh vm` + `tmux attach -t canvas-<id>` works.
	const sessionId = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'terminal',
		x: x - 360,
		y: y - 220,
		props: { w: 720, h: 440, sessionId, title: 'terminal', ...(gateway ? { gateway } : {}) },
	})
	editor.setSelectedShapes([id])
}
