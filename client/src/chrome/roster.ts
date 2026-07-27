/**
 * The panel roster: self plus collaborator presence, grouped by page.
 *
 * Extracted from PanelPages' reactive derivation so the grouping rules are
 * testable without an editor — the derivation there now only reads signals and
 * hands the values to this function.
 */
import { rawUserId } from '@ensembleworks/contracts'
import { otherCollaborators } from './collaborators'

export interface RosterEntry {
	prefixedId: string
	rawId: string
	name: string
	color: string
	isLocal: boolean
}

/** The presence fields the roster reads; real records carry much more. */
export interface RosterPresence {
	userId: string
	currentPageId: string
	userName?: string | null
	color: string
}

export function rosterByPage(input: {
	self: RosterEntry
	currentPageId: string
	presences: readonly RosterPresence[]
}): Map<string, RosterEntry[]> {
	// Self goes in first under the page it is currently viewing; collaborator
	// presence then joins in under whichever page each of them is on.
	const byPage = new Map<string, RosterEntry[]>()
	byPage.set(input.currentPageId, [input.self])
	// Our own presence is already in the roster as `self`, so a record carrying
	// our user id would render the same person twice (see otherCollaborators for
	// how a tab comes to receive one at all).
	for (const presence of otherCollaborators(input.presences, input.self.prefixedId)) {
		const list = byPage.get(presence.currentPageId) ?? []
		list.push({
			prefixedId: presence.userId,
			rawId: rawUserId(presence.userId),
			name: presence.userName?.trim() || 'Anonymous',
			color: presence.color,
			isLocal: false,
		})
		byPage.set(presence.currentPageId, list)
	}
	return byPage
}
