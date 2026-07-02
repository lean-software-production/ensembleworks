/**
 * Local screen-share lifecycle: capture → publish → shape, and teardown from
 * whichever end dies first (browser "Stop sharing" bar, tile deletion by
 * anyone, unpublish). Module-level rather than a hook so the toolbar tool —
 * a closure in uiOverrides with only the editor in hand — can call it; the
 * LiveKit room arrives via the screenshare store.
 *
 * Each call to startScreenShare is one independent share: one browser picker
 * (one surface — the browser's consent boundary, by design), one named track
 * `screen:<uuid>`, one tile. Multi-window sharing = press the button again.
 * Never setScreenShareEnabled(): it manages exactly one screen track.
 */
import { ScreenSharePresets, Track, VideoPreset } from 'livekit-client'
import { Editor, TLShapeId, createShapeId } from 'tldraw'
import {
	SCREENSHARE_DEFAULT_W,
	propsForAspect,
	titleFromTrackLabel,
} from './ScreenShareShapeUtil'
import { getScreenShareRoom } from './store'

// Capped top layer: 1080p / 15 fps / 2.5 Mbps — screen content favours
// resolution over smoothness (the spec's honest baseline), and the cap keeps
// a canvas of many tiles inside the self-hosted SFU's bandwidth budget. One
// cheap simulcast layer serves zoomed-out tiles via adaptiveStream.
const SCREEN_TOP_LAYER = new VideoPreset(1920, 1080, 2_500_000, 15)
const SCREEN_LOW_LAYER = ScreenSharePresets.h360fps3

interface ActiveShare {
	shapeId: TLShapeId
	mediaTrack: MediaStreamTrack
	pollTimer: ReturnType<typeof setInterval>
}

// Keyed by trackName. Only the sharer's own client has entries here.
const active = new Map<string, ActiveShare>()
const deleteHandlerInstalled = new WeakSet<Editor>()

export async function startScreenShare(editor: Editor): Promise<void> {
	const room = getScreenShareRoom()
	// The toolbar item is hidden when unavailable, but guard anyway (a stale
	// toolbar during a reconnect can still fire this).
	if (!room || room.localParticipant.permissions?.canPublish === false) {
		window.alert('Screen sharing is unavailable — audio/video is not connected.')
		return
	}

	let stream: MediaStream
	try {
		// Video only in v1: voice already flows through spatial mic audio.
		stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
	} catch {
		return // picker cancelled or denied — a non-event, not an error
	}
	const mediaTrack = stream.getVideoTracks()[0]
	if (!mediaTrack) return
	// Crisp text under bitrate pressure beats smooth motion for screen content.
	mediaTrack.contentHint = 'detail'

	const settings = mediaTrack.getSettings()
	const aspect =
		settings.width && settings.height ? settings.width / settings.height : 16 / 9
	const trackName = `screen:${crypto.randomUUID()}`

	try {
		await room.localParticipant.publishTrack(mediaTrack, {
			name: trackName,
			source: Track.Source.ScreenShare,
			simulcast: true,
			screenShareEncoding: SCREEN_TOP_LAYER.encoding,
			screenShareSimulcastLayers: [SCREEN_LOW_LAYER],
		})
	} catch (err) {
		console.error('screen share publish failed', err)
		mediaTrack.stop()
		return
	}

	const w = SCREENSHARE_DEFAULT_W
	const sized = propsForAspect(w, aspect)
	const { x, y } = editor.getViewportPageBounds().center
	const shapeId = createShapeId()
	editor.createShape({
		id: shapeId,
		type: 'screenshare',
		x: x - w / 2,
		y: y - sized.h / 2,
		props: {
			w,
			h: sized.h,
			participantId: room.localParticipant.identity,
			trackName,
			title: titleFromTrackLabel(mediaTrack.label),
			aspect: sized.aspect,
		},
	})
	editor.setSelectedShapes([shapeId])

	// Aspect follows the source: when the shared window is resized, rewrite
	// the tile's height/aspect (width kept, so the tile never drifts). Capture
	// settings only change on real resizes, so a 1 s poll is plenty and avoids
	// wiring per-frame media events.
	const pollTimer = setInterval(() => {
		const cur = mediaTrack.getSettings()
		if (!cur.width || !cur.height) return
		const nextAspect = cur.width / cur.height
		const shape = editor.getShape(shapeId)
		if (!shape) return
		const props = shape.props as { w: number; aspect: number }
		if (Math.abs(nextAspect - props.aspect) < 0.01) return
		editor.updateShape({
			id: shapeId,
			type: 'screenshare',
			props: propsForAspect(props.w, nextAspect),
		})
	}, 1000)

	active.set(trackName, { shapeId, mediaTrack, pollTimer })
	// Browser "Stop sharing" bar (or the OS revoking capture) → tear down.
	mediaTrack.addEventListener('ended', () => stopScreenShare(editor, trackName))
	installDeleteHandler(editor)
}

export function stopScreenShare(editor: Editor, trackName: string): void {
	const share = active.get(trackName)
	if (!share) return
	active.delete(trackName)
	clearInterval(share.pollTimer)
	getScreenShareRoom()?.localParticipant.unpublishTrack(share.mediaTrack, true)
	share.mediaTrack.stop()
	// Absent when teardown started FROM a deletion (delete handler below).
	if (editor.getShape(share.shapeId)) editor.deleteShape(share.shapeId)
}

// Deleting a live share's tile — locally or by a teammate over sync — stops
// the capture: a tile-less stream would otherwise keep uploading invisibly.
function installDeleteHandler(editor: Editor) {
	if (deleteHandlerInstalled.has(editor)) return
	deleteHandlerInstalled.add(editor)
	editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
		if (shape.type !== 'screenshare') return
		const trackName = (shape.props as { trackName: string }).trackName
		if (active.has(trackName)) stopScreenShare(editor, trackName)
	})
}
