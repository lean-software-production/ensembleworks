/**
 * Raise-hand / request-to-present queue derivation (canvas-controls Present
 * mode). Pure functions over collaborator presence — no tldraw import — so the
 * ordering rules are unit-tested under bun the same way followLogic is.
 *
 * Like the rest of Present mode, the queue rides the SAME presence `meta` blob
 * App.tsx already publishes (see chrome/present.ts): each client owns two tiny
 * JSON-serializable fields —
 *   handRaised: number | null            — Date.now() when this client raised
 *                                          its hand (null = down). The stamp
 *                                          both marks membership and orders the
 *                                          queue (earliest first).
 *   handoff:   { to: string; at: number } | null
 *                                        — set by the presenter to promote a
 *                                          specific peer; the addressed client
 *                                          consumes it once (edge-triggered).
 * No server message is involved: every client derives the queue by scanning
 * peer presence, exactly as it derives the current presenter (present.ts).
 */

export interface PresenceLike {
	userId: string
	userName?: string
	meta?: unknown
}

export interface HandRaiser {
	userId: string
	userName: string
	raisedAt: number
}

/** This peer's raise timestamp, or null when their hand is down / unset. */
function raisedAtOf(p: PresenceLike): number | null {
	const v = (p.meta as { handRaised?: unknown } | undefined)?.handRaised
	return typeof v === 'number' ? v : null
}

/**
 * The raise-hand queue: every peer whose meta carries a numeric handRaised
 * timestamp, ordered first-raised-first (ascending timestamp). Exact-ms ties
 * break by userId so every client — the presenter included — derives the
 * identical order from the same presence snapshot.
 */
export function handQueue(peers: readonly PresenceLike[]): HandRaiser[] {
	const raisers: HandRaiser[] = []
	for (const p of peers) {
		const raisedAt = raisedAtOf(p)
		if (raisedAt === null) continue
		raisers.push({ userId: p.userId, userName: p.userName?.trim() || 'Anonymous', raisedAt })
	}
	raisers.sort(
		(a, b) => a.raisedAt - b.raisedAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
	)
	return raisers
}

/**
 * 1-based place in line for a hand raised at `myTs`, given the OTHER peers'
 * presence (self is never among getCollaborators()) — one ahead of every peer
 * who raised earlier. null when the hand is down. A soft hint for the viewer
 * strip; an exact-ms dead heat resolves in the local raiser's favour (counted
 * as not-ahead), at worst under-counting by one.
 */
export function handPosition(peers: readonly PresenceLike[], myTs: number | null): number | null {
	if (myTs === null) return null
	let ahead = 0
	for (const p of peers) {
		const t = raisedAtOf(p)
		if (t !== null && t < myTs) ahead++
	}
	return ahead + 1
}

/**
 * The timestamp of the newest handoff token addressed to `myUserId`, or null.
 * The presenter promotes a peer by writing { to, at } into its OWN meta; the
 * addressed client watches for this and — edge-triggered on a rising `at`, so
 * it takes over exactly once even though the token lingers briefly in the
 * presenter's meta — becomes the presenter (see present.ts's handoff consumer).
 * Newest wins so a re-promotion after the first is consumed still fires.
 */
export function incomingHandoffTs(peers: readonly PresenceLike[], myUserId: string): number | null {
	let best: number | null = null
	for (const p of peers) {
		const h = (p.meta as { handoff?: { to?: unknown; at?: unknown } } | undefined)?.handoff
		if (!h || h.to !== myUserId || typeof h.at !== 'number') continue
		if (best === null || h.at > best) best = h.at
	}
	return best
}
