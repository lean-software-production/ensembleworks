/**
 * Frame-link plugin: a "copy frame link" overflow command-bar entry that, when
 * exactly one frame shape is selected, copies a deep-link URL
 * (`<origin>/?room=<room>&frame=<shapeId>`) to the clipboard.
 */
import { buildFrameLink } from '../chrome/frameLink'
import { getRoomId } from '../identity'
import type { ClientPlugin } from '../kernel/plugin'

export const frameLinkPlugin: ClientPlugin = {
	id: 'framelink',
	barItems: [
		{
			id: 'copy-frame-link',
			label: 'copy frame link',
			icon: 'link',
			placement: 'overflow',
			onSelect: (editor) => {
				const ids = editor.getSelectedShapeIds()
				if (ids.length !== 1) return
				const shape = editor.getShape(ids[0])
				if (!shape || shape.type !== 'frame') return
				const url = buildFrameLink(location.origin, getRoomId(), shape.id)
				navigator.clipboard?.writeText(url).catch(() => {})
			},
		},
	],
}
