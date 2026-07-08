/**
 * Screenshare plugin: shape util, command-bar entry (offered only when A/V is
 * up and this participant may publish), the viewport-scoped subscription
 * loop, and the delete room-hook that stops a live capture with its tile.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { SCREENSHARE_ICON_NAME, SCREENSHARE_TOOLBAR_ICON, ScreenShareShapeUtil } from './ScreenShareShapeUtil'
import { startScreenShare, stopShareForDeletedShape } from './share'
import { isScreenShareAvailable, useScreenShareAvailable } from './store'
import { ScreenShareSubscriptionLoop } from './SubscriptionLoop'

export const screensharePlugin: ClientPlugin = {
	id: 'screenshare',
	shapeUtils: [ScreenShareShapeUtil],
	icons: { [SCREENSHARE_ICON_NAME]: SCREENSHARE_TOOLBAR_ICON },
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
