/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from where
 * they are relative to me. On my page, volume falls off with canvas distance
 * between my viewport centre and their cursor (standup mode pins everyone on my
 * page to full). A peer on ANOTHER page is held at the crosstalk bleed level
 * (av/crosstalk.ts) — 0 fades them to silence as before, higher keeps them
 * audible across the page hop. A peer absent from presence entirely fades to 0.
 *
 * Crucially this drives the SAME single GainNode per participant either way, so
 * cross-page bleed is the exact same audio path as in-room voice — one gain,
 * no echo, no doubled voice. The 0.08 s setTargetAtTime constant is the
 * smoothing that keeps pans (and crossing a page boundary) from clicking.
 */
import { rawUserId } from '@ensembleworks/contracts'
import type { Editor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { gainTarget, type PeerLocation } from './crosstalk'
import { DEFAULT_SPATIAL_SETTINGS, distance, gainForDistance } from './spatial'
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
		// Scan collaborators on ALL pages, not just the current one: an off-page
		// teammate must still be found so crosstalk can bleed them in, instead of
		// the loop treating "off my page" as "gone" and hard-muting them.
		// (getCollaboratorsOnCurrentPage() is exactly this list filtered to
		// currentPageId, so on-page peers behave identically to before.)
		const collaborators = editor.getCollaborators()
		for (const peer of lk.peers) {
			if (!peer.gain) continue
			const presence = collaborators.find((c) => rawUserId(c.userId) === rawUserId(peer.identity))
			const location: PeerLocation = !presence
				? 'absent'
				: presence.currentPageId === myPageId
					? 'my-page'
					: 'other-page'
			// In-page distance gain — the existing spatial model. A peer on my page
			// with no cursor yet counts as full volume, exactly as before.
			const pageGain = presence?.cursor
				? gainForDistance(
						distance(my.x, my.y, presence.cursor.x, presence.cursor.y),
						DEFAULT_SPATIAL_SETTINGS
					)
				: 1
			const target = gainTarget({ location, standupMode, pageGain, crosstalk: crosstalkLevel })
			peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
		}
	})
}
