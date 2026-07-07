/**
 * Screenshare plugin: shape util, toolbar icon + tool (offered only when A/V
 * is up and this participant may publish), the viewport-scoped subscription
 * loop, and the delete room-hook that stops a live capture with its tile.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import {
	SCREENSHARE_ICON_NAME,
	SCREENSHARE_TOOLBAR_ICON,
	ScreenShareShapeUtil,
} from './ScreenShareShapeUtil'
import { startScreenShare, stopShareForDeletedShape } from './share'
import { isScreenShareAvailable, useScreenShareAvailable } from './store'
import { ScreenShareSubscriptionLoop } from './SubscriptionLoop'

function ScreenShareToolbarItem() {
	const tools = useTools()
	const available = useScreenShareAvailable()
	if (!available || !tools['screenshare']) return null
	return <TldrawUiMenuItem {...tools['screenshare']} />
}

export const screensharePlugin: ClientPlugin = {
	id: 'screenshare',
	shapeUtils: [ScreenShareShapeUtil],
	icons: { [SCREENSHARE_ICON_NAME]: SCREENSHARE_TOOLBAR_ICON },
	tools: (editor: Editor) => ({
		screenshare: {
			id: 'screenshare',
			icon: SCREENSHARE_ICON_NAME,
			label: 'Share screen',
			readonlyOk: false,
			onSelect() {
				void startScreenShare(editor)
			},
		},
	}),
	ToolbarItems: ScreenShareToolbarItem,
	barItems: [
		{
			id: 'cast',
			label: 'cast',
			accelerator: 'c',
			icon: SCREENSHARE_ICON_NAME,
			placement: 'priority',
			onSelect: (editor) => {
				if (!isScreenShareAvailable()) return
				void startScreenShare(editor)
			},
			useAvailable: useScreenShareAvailable,
		},
	],
	Overlay: ScreenShareSubscriptionLoop,
	roomHooks: () => ({
		afterShapeDelete: stopShareForDeletedShape,
	}),
}
