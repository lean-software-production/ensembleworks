/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from where
 * they are relative to me. On my page, volume falls off with SCREEN-SPACE
 * distance between my viewport centre and their cursor — page distance × my
 * zoom, against radii derived from my viewport's half-diagonal (spatial.ts's
 * gainForScreenDistance). Zoom is reach: zoom into a corner and peers outside
 * your focus fade; zoom all the way out and the whole page is a huddle.
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
import { DEFAULT_SCREEN_SPATIAL_SETTINGS, distance, gainForScreenDistance } from './spatial'
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
		const my = editor.getViewportPageBounds().center
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
			// In-page distance gain — the screen-space spatial model. A peer on my
			// page with no cursor yet counts as full volume, exactly as before.
			const pageGain = presence?.cursor
				? gainForScreenDistance(
						distance(my.x, my.y, presence.cursor.x, presence.cursor.y),
						zoom,
						halfDiagonalPx,
						DEFAULT_SCREEN_SPATIAL_SETTINGS
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
