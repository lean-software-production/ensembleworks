/**
 * What THIS client is presenting: shapeId + latest scroll fraction, or null.
 * Read synchronously by App.tsx's getUserPresence (merged into presence meta —
 * presence dies with the session, so a presentation can never fossilise in the
 * document).
 *
 * State lives in a tldraw `atom` rather than a plain module variable so that a
 * read inside getUserPresence is *tracked*: getUserPresence runs inside tldraw's
 * presence derivation (a Computed the sync client subscribes to), so mutating
 * the atom while the presenter's mouse is idle still re-emits presence. A plain
 * variable would not be tracked and idle updates would never sync.
 */
import { atom } from 'tldraw'

// A `type` (not `interface`) so it structurally satisfies tldraw's `JsonObject`
// index signature — presence meta must be JsonValue, and interfaces don't get an
// implicit index signature.
export type Presenting = {
	shapeId: string
	fraction: number
	// Toggle-on time (Date.now()). Presence tokens can't be cleared across
	// users, so followers resolve competing tokens by the LARGEST ts (true
	// last-writer-wins, spec §5). Callers must PRESERVE this across scroll
	// updates — re-stamping on every scroll would let a scrolling incumbent
	// perpetually out-stamp anyone trying to steal the presentation.
	ts: number
}

const current = atom<Presenting | null>('fileViewerPresent', null)

export const presentStore = {
	get: (): Presenting | null => current.get(),
	set(next: Presenting | null) {
		current.set(next)
	},
}
