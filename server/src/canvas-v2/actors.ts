/**
 * canvasActors — process-wide registry of one DocumentActor per canvas-v2
 * room, the C3 counterpart of kernel/rooms.ts's RoomHost for the legacy
 * tldraw rooms. Constructed lazily by createSyncApp ONLY when
 * EW_CANVAS_SYNC=1 (see app.ts) — flag-off deployments never call
 * createCanvasActors, so they never even create the canvas-v2 directory.
 */
import path from 'node:path'
import { DocumentActor } from './actor.ts'

// Fixed server peerId, reused across every room in this process. Safe by the
// peer-id probe documented on DocumentActor (actor.ts): a fixed peerId
// survives crash+restart because a reconstructed repair delta is
// byte-identical to whatever it's replacing, not a colliding op. Rooms are
// isolated by directory/file (one CanvasV2Store per room), not by peerId.
const SERVER_PEER_ID = 1n

/** D3's metrics gap-fix: an eviction ends a tainted actor's life and starts a
 * fresh, healthy one in its place — the fresh actor's `.tainted` reads null,
 * so without a separate record the fact that THIS room ever lost durability
 * is invisible the instant getOrCreate replaces it. `count` accumulates across
 * every eviction this room has ever had; `lastReason` is the message of the
 * MOST RECENT tainted actor evicted (not cumulative — read it as "why did the
 * last replacement happen", pairing with `count` for "how often"). */
export interface EvictionRecord {
	count: number
	lastReason: string
}

export interface CanvasActors {
	/** Live, non-tainted actor for roomId — memoized. A tainted actor is
	 * evicted (closed, which is safe/idempotent) and replaced with a fresh one
	 * that reloads whatever is durable at eviction time — which may
	 * retroactively include the tainted edit, if the close-path's final
	 * compact succeeded after the storage recovered (DocumentActor.close()'s
	 * tainted-outcome log lines say which happened). */
	getOrCreate(roomId: string): DocumentActor
	/** Every currently-registered (live) actor, keyed by room id — read-only
	 * introspection for the D3 metrics endpoint (server/src/features/canvas-metrics.ts),
	 * which reads each actor's peer.pendingImports/malformedFrames and .tainted. */
	entries(): ReadonlyMap<string, DocumentActor>
	/** Per-room eviction history — see EvictionRecord's doc comment. Exposed
	 * for the D3 metrics endpoint. */
	evictions(): ReadonlyMap<string, EvictionRecord>
	/** Close every actor currently registered (server shutdown). */
	close(): void
}

// Idle-actor eviction is DELIBERATELY deferred (same register as the
// shutdown-gap note at app.ts's construction site): Phase 2 is rigs-only
// behind EW_CANVAS_SYNC, so a handful of test rooms living for the process
// lifetime costs nothing. Revisit before the Phase 3 cutover, when every
// live room gets an actor and idle rooms should release their doc + SQLite
// handle.

export function createCanvasActors(databaseDir: string): CanvasActors {
	const dir = path.join(databaseDir, 'canvas-v2')
	const actors = new Map<string, DocumentActor>()
	const evictions = new Map<string, EvictionRecord>()

	function getOrCreate(roomId: string): DocumentActor {
		const existing = actors.get(roomId)
		if (existing) {
			if (!existing.tainted) return existing
			console.warn(`[canvas-v2 ${roomId}] evicting tainted actor and constructing a fresh one`)
			const prev = evictions.get(roomId)
			evictions.set(roomId, { count: (prev?.count ?? 0) + 1, lastReason: existing.tainted.message })
			existing.close() // idempotent/safe per DocumentActor.close()'s contract
			actors.delete(roomId)
		}
		const actor = new DocumentActor({ dir, roomId, peerId: SERVER_PEER_ID })
		actors.set(roomId, actor)
		return actor
	}

	function entries(): ReadonlyMap<string, DocumentActor> {
		return actors
	}

	function getEvictions(): ReadonlyMap<string, EvictionRecord> {
		return evictions
	}

	function close(): void {
		for (const actor of actors.values()) actor.close()
		actors.clear()
	}

	return { getOrCreate, entries, evictions: getEvictions, close }
}
