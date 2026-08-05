/**
 * Force-follow baton (spec: 2026-07-29-file-viewer-force-follow-design.md) —
 * hides a controller's REGULAR tldraw collaborator cursor on the canvas
 * while they hold a file-viewer baton: the mirror already renders their
 * in-control cursor inside the shape, so the canvas-wide cursor is a
 * duplicate. Chains onto `FadedCollaboratorCursorOverlayUtil` (av/
 * FadedCursorOverlay.ts) rather than the base `CollaboratorCursorOverlayUtil`
 * — both are `getOverlays()`/`render()` overrides on the SAME `type:
 * 'collaborator_cursor'` overlay, so composing by subclassing (not by
 * passing two separate entries to <Tldraw overlayUtils>) keeps gain-fade
 * AND baton-hide both in effect; <Tldraw overlayUtils> replaces by `type`
 * (mergeArraysAndReplaceDefaults), so two same-type entries would just have
 * the later one silently win, dropping the other's behavior.
 *
 * Per-collaborator, not per-shape: this checks each peer's OWN presence
 * meta (self-reported — `presentStore`'s token), not `presenterFor`'s
 * cross-peer LWW-winner resolution for one particular shape. That's a
 * deliberate simplification (product ask: "when someone has control,
 * remove their regular canvas cursor" — no per-shape precision needed) and
 * it also means a stale LWW-loser's leftover token still hides their
 * cursor, which is fine — those are rare and transient.
 *
 * KNOWN CAVEAT (implemented as specified): the baton only releases on
 * disconnect (yield-on-steal or presence expiry) — there is no "stop
 * controlling" gesture. So a controller who walks away from the shape
 * (without another peer stealing it) stays cursor-hidden on the canvas
 * until someone steals the baton or they disconnect. Accepted by the
 * product owner as-is.
 */
import { type TLCollaboratorCursorOverlay } from 'tldraw'
import { FadedCollaboratorCursorOverlayUtil } from '../av/FadedCursorOverlay'
import { hasFileViewerBaton } from './fileViewerBaton'

const ID_PREFIX = 'collaborator_cursor:'

export class HideControllerCursorOverlayUtil extends FadedCollaboratorCursorOverlayUtil {
	override getOverlays(): TLCollaboratorCursorOverlay[] {
		const overlays = super.getOverlays()
		const holderIds = new Set(
			this.editor
				.getVisibleCollaboratorsOnCurrentPage()
				.filter((presence) => hasFileViewerBaton(presence.meta))
				.map((presence) => presence.userId)
		)
		if (holderIds.size === 0) return overlays
		return overlays.filter((o) => {
			const userId = o.id.startsWith(ID_PREFIX) ? o.id.slice(ID_PREFIX.length) : ''
			return !holderIds.has(userId)
		})
	}
}

/** Stable module-level array so <Tldraw overlayUtils> deps don't churn. */
export const fileViewerOverlayUtils = [HideControllerCursorOverlayUtil]
