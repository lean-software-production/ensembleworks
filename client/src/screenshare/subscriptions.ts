/**
 * Viewport-scoped delivery (spec §6.3, deterministic path): subscribe only to
 * screen tracks whose tile is in — or within a margin of — the viewer's
 * viewport, so the stream stops at the SFU rather than merely being hidden.
 * Called from AvOverlay's 150 ms loop; owning it here keeps knowledge of the
 * screenshare shape type and its props out of the general A/V layer.
 */
import { Room, Track } from 'livekit-client'
import { Editor } from 'tldraw'
import { type Rect, shouldBeSubscribed } from './visibility'

export function updateScreenShareSubscriptions(editor: Editor, room: Room): void {
	const viewport = editor.getViewportPageBounds()
	const boundsByTrackName = new Map<string, Rect>()
	for (const shape of editor.getCurrentPageShapes()) {
		if (shape.type !== 'screenshare') continue
		const bounds = editor.getShapePageBounds(shape)
		if (bounds) {
			boundsByTrackName.set((shape.props as { trackName: string }).trackName, bounds)
		}
	}
	for (const participant of room.remoteParticipants.values()) {
		for (const pub of participant.trackPublications.values()) {
			if (pub.source !== Track.Source.ScreenShare) continue
			// A tile on another page (or deleted) maps to null → unsubscribe.
			const want = shouldBeSubscribed(
				boundsByTrackName.get(pub.trackName) ?? null,
				viewport,
				pub.isSubscribed
			)
			if (want !== pub.isSubscribed) pub.setSubscribed(want)
		}
	}
}
