import { slugify } from '@ensembleworks/contracts'
import { Editor, createShapeId } from 'tldraw'
import { ROADMAP_DEFAULT_H, ROADMAP_DEFAULT_W } from './RoadmapShapeUtil'

export function createRoadmapShape(editor: Editor) {
	// The name is the CLI/agent addressing handle; its slug is the document id
	// (createDevServerShape precedent: prompt, no server round-trip). The shape
	// renders its empty state until someone pushes data to that name.
	const name = window.prompt('Roadmap name:', 'Roadmap')?.trim()
	if (!name) return
	const roadmapId = slugify(name)
	if (!roadmapId) {
		window.alert('Roadmap name must contain at least one letter or digit.')
		return
	}
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'roadmap',
		x: x - ROADMAP_DEFAULT_W / 2,
		y: y - ROADMAP_DEFAULT_H / 2,
		props: { w: ROADMAP_DEFAULT_W, h: ROADMAP_DEFAULT_H, roadmapId },
	})
	editor.setSelectedShapes([id])
}
