/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from where
 * they are relative to me. On my page, a peer whose cursor is anywhere INSIDE
 * my viewport rectangle is at full volume — if I can see their cursor, I can
 * hear them (this also keeps a teammate audible while their pointer is parked
 * at the canvas edge because they're using the side panel). Beyond the edge,
 * volume fades with the screen-pixel shortfall to the viewport (spatial.ts's
 * screenDistanceOutsideRect + gainForViewportDistance). Zoom is reach: zoom
 * into a corner and peers outside it fade; zoom all the way out and every
 * cursor is in view — and audible.
 * Standup mode still pins everyone on my page to full. A peer on ANOTHER page
 * is held at the crosstalk bleed level (av/crosstalk.ts) — 0 fades them to
 * silence as before. A peer absent from presence entirely fades to 0.
 *
 * Crucially this drives the SAME single GainNode per participant either way,
 * so cross-page bleed is the exact same audio path as in-room voice — one
 * gain, no echo, no doubled voice. The 0.08 s setTargetAtTime constant is the
 * smoothing that keeps pans (and crossing a page boundary) from clicking.
 *
 * Each tick also publishes the APPLIED per-peer gains (quantised) through
 * av/bridge.ts — the single source of truth the legibility cues read (tile
 * dim, cursor fade, hover % readout), so what you see matches what you hear.
 */
import { rawUserId } from '@ensembleworks/contracts'
import type { Editor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { publishPeerGains } from './bridge'
import { gainTarget, type PeerLocation } from './crosstalk'
import { quantizeGain } from './legibility'
import {
	DEFAULT_VIEWPORT_SPATIAL_SETTINGS,
	gainForViewportDistance,
	screenDistanceOutsideRect,
} from './spatial'
import type { LiveKitState } from './useLiveKitRoom'

export function useSpatialGainLoop(
	editor: Editor,
	lk: LiveKitState,
	standupMode: boolean,
	crosstalkLevel: number
): void {
	useEvery(150, () => {
		const ctx = lk.audioContext
		if (!ctx) return
		const viewport = editor.getViewportPageBounds()
		const myPageId = editor.getCurrentPageId()
		// Read the camera once per tick, not per peer.
		const zoom = editor.getZoomLevel()
		const screen = editor.getViewportScreenBounds()
		const halfDiagonalPx = Math.hypot(screen.w, screen.h) / 2
		// Scan collaborators on ALL pages, not just the current one: an off-page
		// teammate must still be found so crosstalk can bleed them in, instead of
		// the loop treating "off my page" as "gone" and hard-muting them.
		// (getCollaboratorsOnCurrentPage() is exactly this list filtered to
		// currentPageId, so on-page peers behave identically to before.)
		const collaborators = editor.getCollaborators()
		const appliedGains: Record<string, number> = {}
		for (const peer of lk.peers) {
			if (!peer.gain) continue
			const presence = collaborators.find((c) => rawUserId(c.userId) === rawUserId(peer.identity))
			const location: PeerLocation = !presence
				? 'absent'
				: presence.currentPageId === myPageId
					? 'my-page'
					: 'other-page'
			// In-page gain — the viewport-rect spatial model. A peer on my page
			// with no cursor yet counts as full volume, exactly as before.
			const pageGain = presence?.cursor
				? gainForViewportDistance(
						screenDistanceOutsideRect(presence.cursor.x, presence.cursor.y, viewport, zoom),
						halfDiagonalPx,
						DEFAULT_VIEWPORT_SPATIAL_SETTINGS
					)
				: 1
			const target = gainTarget({ location, standupMode, pageGain, crosstalk: crosstalkLevel })
			peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
			appliedGains[rawUserId(peer.identity)] = quantizeGain(target)
		}
		// publishPeerGains dedupes internally, so quiet ticks cost one map compare.
		publishPeerGains(appliedGains)
	})
}
