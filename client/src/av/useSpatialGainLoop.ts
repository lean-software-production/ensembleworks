/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from the
 * canvas distance between my viewport centre and their cursor. Standup mode
 * pins everyone to full volume; a peer off my page fades to silence. The
 * 0.08 s setTargetAtTime constant is the smoothing that keeps pans from
 * clicking — behaviour, not taste.
 */
import { rawUserId } from '@ensembleworks/contracts'
import type { Editor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { DEFAULT_SPATIAL_SETTINGS, distance, gainForDistance } from './spatial'
import type { LiveKitState } from './useLiveKitRoom'

export function useSpatialGainLoop(editor: Editor, lk: LiveKitState, standupMode: boolean): void {
	useEvery(150, () => {
		const ctx = lk.audioContext
		if (!ctx) return
		const my = editor.getViewportPageBounds().center
		const collaborators = editor.getCollaboratorsOnCurrentPage()
		for (const peer of lk.peers) {
			if (!peer.gain) continue
			const presence = collaborators.find((c) => rawUserId(c.userId) === rawUserId(peer.identity))
			const target = !presence
				? 0
				: standupMode
					? 1
					: presence.cursor
						? gainForDistance(
								distance(my.x, my.y, presence.cursor.x, presence.cursor.y),
								DEFAULT_SPATIAL_SETTINGS
							)
						: 1
			peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
		}
	})
}
