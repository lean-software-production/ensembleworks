/**
 * Roadmap plugin: the roadmap shape and its command-bar entry.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { createRoadmapShape } from './createRoadmapShape'
import { RoadmapShapeUtil } from './RoadmapShapeUtil'

export const roadmapPlugin: ClientPlugin = {
	id: 'roadmap',
	shapeUtils: [RoadmapShapeUtil],
	barItems: [
		{
			id: 'roadmap',
			label: 'roadmap',
			icon: 'tool-note',
			placement: 'overflow',
			onSelect: (editor) => createRoadmapShape(editor),
		},
	],
}
