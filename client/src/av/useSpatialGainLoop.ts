/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from where
 * they are relative to me. A peer whose cursor is anywhere INSIDE my viewport
 * rectangle is at full volume — if I can see their cursor, I can hear them
 * (this also keeps a teammate audible while their pointer is parked at the
 * canvas edge because they're using the side panel). Beyond the edge, volume
 * fades with the screen-pixel shortfall to the viewport (spatial.ts's
 * screenDistanceOutsideRect + gainForViewportDistance) down to the crosstalk
 * level — the ONE dial for "how loud are people I can't see?" (av/crosstalk.ts).
 * A peer on ANOTHER page sits one step further: otherPageLevel(crosstalk).
 * A peer absent from presence entirely fades to 0. Zoom is reach: zoom into a
 * corner and peers outside it fade; zoom all the way out and every cursor is
 * in view — and audible. Crosstalk at 1 (the default) means no fade anywhere:
 * the old standup mode.
 *
 * Crucially this drives the SAME single GainNode per participant either way,
 * so cross-page bleed is the exact same audio path as in-room voice — one
 * gain, no echo, no doubled voice. The 0.08 s setTargetAtTime constant is the
 * smoothing that keeps pans (and crossing a page boundary) from clicking.
 *
 * Each tick also publishes the per-participant gains (quantised) through
 * av/bridge.ts — the single source of truth the legibility cues read (tile
 * dim, cursor fade, hover % readout), so what you see matches what you hear.
 * Those gains cover EVERYONE in presence, not just the peers with an audio
 * pipeline: the visual answer is "how loud would they be if their mic were
 * on", so distance and page-membership stay legible for muted teammates too
 * (who would otherwise sit at full brightness). Audio is still only applied
 * where a GainNode exists.
 */
import { rawUserId } from '@ensembleworks/contracts'
import type { Editor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { publishPeerGains } from './bridge'
import { clampCrosstalk, gainTarget, type PeerLocation } from './crosstalk'
import { quantizeGain } from './legibility'
import {
	DEFAULT_VIEWPORT_SPATIAL_SETTINGS,
	gainForViewportDistance,
	screenDistanceOutsideRect,
} from './spatial'
import type { LiveKitState } from './useLiveKitRoom'

export function useSpatialGainLoop(editor: Editor, lk: LiveKitState, crosstalkLevel: number): void {
	useEvery(150, () => {
		const ctx = lk.audioContext
		if (!ctx) return
		const viewport = editor.getViewportPageBounds()
		const myPageId = editor.getCurrentPageId()
		// Read the camera once per tick, not per peer.
		const zoom = editor.getZoomLevel()
		const screen = editor.getViewportScreenBounds()
		const halfDiagonalPx = Math.hypot(screen.w, screen.h) / 2
		// The crosstalk level is the floor the on-page fade bottoms out at — the
		// slider IS "the softest you can be on the current page".
		const settings = {
			falloffFraction: DEFAULT_VIEWPORT_SPATIAL_SETTINGS.falloffFraction,
			floor: clampCrosstalk(crosstalkLevel),
		}
		// Scan collaborators on ALL pages, not just the current one: an off-page
		// teammate must still be found so crosstalk can bleed them in, instead of
		// the loop treating "off my page" as "gone" and hard-muting them.
		// (getCollaboratorsOnCurrentPage() is exactly this list filtered to
		// currentPageId, so on-page peers behave identically to before.)
		const collaborators = editor.getCollaborators()

		// One pass over presence, keyed by raw id — the loop used to `.find()`
		// through this list once per peer (O(peers x collaborators) every tick).
		const presenceById = new Map(collaborators.map((c) => [rawUserId(c.userId), c]))

		// The gain someone WOULD have, from presence alone. Deliberately does
		// not care whether they publish audio: the visual cues want "how loud
		// would this person be if their mic were on", so a muted teammate still
		// reads as near/far and on/off my page. Only the AUDIO application
		// below is gated on there being a real pipeline.
		const targetFor = (rawId: string): number => {
			const presence = presenceById.get(rawId)
			const location: PeerLocation = !presence
				? 'absent'
				: presence.currentPageId === myPageId
					? 'my-page'
					: 'other-page'
			// In-page gain — the viewport-rect spatial model. Someone on my page
			// with no cursor yet counts as full volume, exactly as before.
			const pageGain = presence?.cursor
				? gainForViewportDistance(
						screenDistanceOutsideRect(presence.cursor.x, presence.cursor.y, viewport, zoom),
						halfDiagonalPx,
						settings
					)
				: 1
			return gainTarget({ location, pageGain, crosstalk: crosstalkLevel })
		}

		const appliedGains: Record<string, number> = {}

		// Audio: only participants with a live pipeline (mic on) have a
		// GainNode to steer. Unchanged behaviour.
		for (const peer of lk.peers) {
			if (!peer.gain) continue
			const rawId = rawUserId(peer.identity)
			const target = targetFor(rawId)
			peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
			appliedGains[rawId] = quantizeGain(target)
		}

		// Visuals: everyone else in presence gets the same computed gain so the
		// tile dim / cursor fade covers muted teammates too. Pure arithmetic —
		// no WebAudio, no DOM.
		for (const rawId of presenceById.keys()) {
			if (rawId in appliedGains) continue
			appliedGains[rawId] = quantizeGain(targetFor(rawId))
		}
		// publishPeerGains dedupes internally, so quiet ticks cost one map compare.
		publishPeerGains(appliedGains)
	})
}
