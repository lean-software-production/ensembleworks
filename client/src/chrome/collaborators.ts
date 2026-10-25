/**
 * Which presence records count as OTHER people.
 *
 * A presence record carrying our own userId is never a teammate — it is our
 * own session seen from the outside. Rendering one produces the same person
 * twice: once from the local self entry, once from the record. The panel keys
 * tiles on the raw user id, so the duplicate is also a React key collision.
 *
 * This is reachable in normal operation. tldraw's sync server holds a closed
 * session for SESSION_REMOVAL_WAIT_TIME (5s) before dropping its presence, so
 * a tab that connects inside that window receives a record for its own user.
 * The single-tab gate makes that the NORMAL case rather than a rare race: when
 * the holder tab closes, the blocked tab's queued lock is granted in about a
 * millisecond and it connects immediately — comfortably inside the 5s window.
 *
 * The record does get deleted 5s later, but a stale reactive derivation can
 * outlive it, which is how a transient ghost becomes a permanent duplicate
 * tile. Filtering at the source means neither the race nor the staleness can
 * put the same person on screen twice.
 */
import { rawUserId } from '@ensembleworks/contracts'

/** The minimum shape this filter needs; the real records carry much more. */
export interface PresenceLike {
	userId: string
}

/**
 * Drop any presence record belonging to `selfPrefixedId`'s user.
 *
 * Compares RAW ids, not the prefixed tldraw ids: the same user can hold two
 * presence records with different record ids, and it is the user we are
 * deduplicating, not the session.
 */
export function otherCollaborators<T extends PresenceLike>(presences: readonly T[], selfPrefixedId: string): T[] {
	const selfRawId = rawUserId(selfPrefixedId)
	return presences.filter((presence) => rawUserId(presence.userId) !== selfRawId)
}
