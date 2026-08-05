import { createShapeId, type Editor } from 'tldraw'
import type { GatewayListEntry } from './gatewayView'

export function createCodespaceShape(editor: Editor, gw: GatewayListEntry) {
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'codespace',
		x: x - 480,
		y: y - 300,
		props: { w: 960, h: 600, gatewayId: gw.gatewayId, repo: gw.repo ?? '', branch: gw.branch ?? '' },
	})
	editor.setSelectedShapes([id])
}
