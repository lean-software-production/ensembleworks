/**
 * Viewport-scoped screen-share delivery, hosted by the screenshare feature
 * itself (formerly a loop inside AvOverlay): every 150 ms, subscribe only to
 * screen tracks whose tile is in (or near) the viewport, with hysteresis so
 * edge-panning doesn't flap. Runs only while a LiveKit room is registered.
 * Audio subscriptions untouched.
 */
import { useEditor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { useScreenShareRoom } from './store'
import { updateScreenShareSubscriptions } from './subscriptions'

export function ScreenShareSubscriptionLoop() {
	const editor = useEditor()
	const room = useScreenShareRoom()
	useEvery(
		150,
		() => {
			if (room) updateScreenShareSubscriptions(editor, room)
		},
		room != null
	)
	return null
}
