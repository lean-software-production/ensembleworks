/**
 * Roadmap plugin: the roadmap shape and its toolbar tool.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createRoadmapShape } from './createRoadmapShape'
import { RoadmapShapeUtil } from './RoadmapShapeUtil'

function RoadmapToolbarItem() {
	const tools = useTools()
	if (!tools['roadmap']) return null
	return <TldrawUiMenuItem {...tools['roadmap']} />
}

export const roadmapPlugin: ClientPlugin = {
	id: 'roadmap',
	shapeUtils: [RoadmapShapeUtil],
	tools: (editor: Editor) => ({
		roadmap: {
			id: 'roadmap',
			icon: 'tool-note',
			label: 'New roadmap',
			readonlyOk: false,
			onSelect() {
				createRoadmapShape(editor)
			},
		},
	}),
	ToolbarItems: RoadmapToolbarItem,
}
