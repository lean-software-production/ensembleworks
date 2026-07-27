/**
 * What THIS client is following: the shapeId of the file-viewer presentation
 * it is currently mirroring, or null. The exact twin of presentStore — a
 * tldraw atom read inside App.tsx's getUserPresence so flipping it re-emits
 * presence (see presentStore.ts for why an atom, not a plain variable).
 * Rides presence meta as `fileViewerFollowing`, so the audience row on every
 * client can show who is watching the presentation and who wandered off —
 * no server changes needed.
 *
 * One token per client (not per shape): simultaneous presentations on two
 * shapes would LWW to the most recent follow, which is fine — the audience
 * row is a social signal, not bookkeeping.
 */
import { atom } from 'tldraw'

export type Following = {
	shapeId: string
	ts: number
}

const current = atom<Following | null>('fileViewerFollowing', null)

export const followingStore = {
	get: (): Following | null => current.get(),
	set(next: Following | null) {
		current.set(next)
	},
}
