/**
 * Collaborator cursors fade with their applied spatial gain (legibility cue
 * #2): the cause (distance from my viewport) and the effect (volume) are
 * shown in the same place. Subclasses tldraw's canvas cursor overlay and
 * multiplies per-cursor alpha by the bridge's applied gain — the same number
 * driving the peer's GainNode, so a faint cursor IS a quiet voice.
 *
 * Same static `type`, so passing this via <Tldraw overlayUtils> REPLACES the
 * default cursor overlay (mergeArraysAndReplaceDefaults keys on `type`).
 * Gains are read non-reactively: the overlay already repaints on cursor and
 * camera changes, which are the events that change gains. (A standup-mode
 * toggle shows on the next repaint — any pointer/camera motion.)
 */
import { rawUserId } from '@ensembleworks/contracts'
import { CollaboratorCursorOverlayUtil, type TLCollaboratorCursorOverlay } from 'tldraw'
import { getPeerGains } from './bridge'
import { cursorAlphaForGain } from './legibility'

const ID_PREFIX = 'collaborator_cursor:'

export class FadedCollaboratorCursorOverlayUtil extends CollaboratorCursorOverlayUtil {
	override render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorCursorOverlay[]): void {
		const gains = getPeerGains()
		for (const overlay of overlays) {
			const userId = overlay.id.startsWith(ID_PREFIX) ? overlay.id.slice(ID_PREFIX.length) : ''
			const gain = gains[rawUserId(userId)] ?? 1
			ctx.save()
			ctx.globalAlpha *= cursorAlphaForGain(gain)
			super.render(ctx, [overlay])
			ctx.restore()
		}
	}
}

/** Stable module-level array so <Tldraw overlayUtils> deps don't churn. */
export const avOverlayUtils = [FadedCollaboratorCursorOverlayUtil]
