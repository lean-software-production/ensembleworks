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

/** D3's metrics gap-fix: an eviction ends an actor's life and starts a fresh
 * one in its place (a tainted replacement, or — F1 — an idle actor's
 * lazily-reconstructed successor) — the fresh actor's `.tainted` reads null
 * either way, so without a separate record the fact that THIS room was ever
 * evicted is invisible the instant getOrCreate replaces it.
 *
 * The two causes get SEPARATE counter/reason pairs, deliberately NOT a shared
 * {count, lastReason, lastKind} triple: after a taint eviction, the healthy
 * replacement will ROUTINELY idle-evict some time later (that is F1 working
 * as designed), and a shared last-slot would let that routine churn OVERWRITE
 * the durability-loss incident — re-introducing the exact visibility loss
 * this record was built to prevent, and noise-tripping any count-based alarm
 * with ordinary idle patterns. The taint fields are STICKY: only another
 * taint eviction touches taintCount/lastTaintReason, so an alarm keyed on
 * `taintCount > 0` is immune to idle churn. Per pair: the count accumulates
 * across every eviction of that kind this room has ever had; the reason is
 * the MOST RECENT of that kind only (null until the first). 'taint' means
 * durability was actually lost (see DocumentActor's tainted doc comment —
 * investigate the storage layer); 'idle' is routine housekeeping (an unused
 * room's doc + SQLite handle was released — nothing was wrong, do not page
 * anyone). */
export interface EvictionRecord {
	taintCount: number
	idleCount: number
	/** STICKY — never overwritten by an idle eviction. */
	lastTaintReason: string | null
	lastIdleReason: string | null
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
	/** F1: evict every registered actor that is BOTH idle past `idleTtlMs`
	 * (no activity — see actor.ts's onActivity call sites for exactly what
	 * counts) AND has zero connected transports right now (DocumentActor's
	 * connectionCount, read fresh — a live socket is NEVER evicted regardless
	 * of how stale its last-activity timestamp is). Eviction = actor.close()
	 * (idempotent, close-path compact persists) + registry removal + an
	 * idle-side EvictionRecord increment (idleCount/lastIdleReason — the taint
	 * pair is sticky and untouched). Called externally on a timer (see
	 * app.ts) — this registry has no clock of its own beyond the injected
	 * `now`. Per-actor exception-safe: one actor's close() throwing is logged
	 * and skipped, every other idle actor in the same sweep is still evicted
	 * (mirrors app.ts's shadow-driver per-room try/catch). */
	sweepIdle(idleTtlMs: number): void
	/** Close every actor currently registered (server shutdown). */
	close(): void
}

export function createCanvasActors(databaseDir: string, opts: { now?: () => number } = {}): CanvasActors {
	const dir = path.join(databaseDir, 'canvas-v2')
	const now = opts.now ?? Date.now
	const actors = new Map<string, DocumentActor>()
	const evictions = new Map<string, EvictionRecord>()
	// F1: last-activity timestamp per room, keyed the same as `actors`. Bumped
	// on (a) a getOrCreate cache hit below, (b) DocumentActor's own connect()
	// and persist() success paths via the injected onActivity callback wired
	// at construction time — see actor.ts's ActorOpts.onActivity doc comment
	// for exactly which events count as activity and why. Entries are removed
	// alongside their actor on every eviction (taint OR idle) so a replacement
	// actor always starts its idle clock fresh rather than inheriting a stale
	// timestamp from the room id it happens to share.
	const lastActivity = new Map<string, number>()

	// Two increment paths, one per kind — see EvictionRecord's doc comment for
	// why the taint pair is sticky and never shares a slot with idle churn.
	function recordEviction(roomId: string, reason: string, kind: 'taint' | 'idle'): void {
		const prev = evictions.get(roomId) ?? { taintCount: 0, idleCount: 0, lastTaintReason: null, lastIdleReason: null }
		evictions.set(
			roomId,
			kind === 'taint'
				? { ...prev, taintCount: prev.taintCount + 1, lastTaintReason: reason }
				: { ...prev, idleCount: prev.idleCount + 1, lastIdleReason: reason },
		)
	}

	function construct(roomId: string): DocumentActor {
		const actor = new DocumentActor({
			dir,
			roomId,
			peerId: SERVER_PEER_ID,
			onActivity: () => lastActivity.set(roomId, now()),
		})
		actors.set(roomId, actor)
		lastActivity.set(roomId, now())
		return actor
	}

	function getOrCreate(roomId: string): DocumentActor {
		const existing = actors.get(roomId)
		if (existing) {
			if (!existing.tainted) {
				lastActivity.set(roomId, now()) // a getOrCreate hit is itself activity (F1)
				return existing
			}
			console.warn(`[canvas-v2 ${roomId}] evicting tainted actor and constructing a fresh one`)
			recordEviction(roomId, existing.tainted.message, 'taint')
			existing.close() // idempotent/safe per DocumentActor.close()'s contract
			actors.delete(roomId)
			lastActivity.delete(roomId)
		}
		return construct(roomId)
	}

	function entries(): ReadonlyMap<string, DocumentActor> {
		return actors
	}

	function getEvictions(): ReadonlyMap<string, EvictionRecord> {
		return evictions
	}

	function sweepIdle(idleTtlMs: number): void {
		const nowMs = now()
		// Snapshot the entries before iterating: construct()/getOrCreate() never
		// runs concurrently with this synchronous sweep (single-threaded JS, and
		// nothing here awaits), but copying is cheap and makes "the set we sweep
		// is a stable read" a fact about the code, not an assumption.
		for (const [roomId, actor] of [...actors]) {
			try {
				if (actor.connectionCount > 0) continue // a live socket is NEVER evicted for idleness
				const last = lastActivity.get(roomId) ?? nowMs
				if (nowMs - last < idleTtlMs) continue
				actor.close() // idempotent; close-path compact persists (see actor.ts)
				actors.delete(roomId)
				lastActivity.delete(roomId)
				recordEviction(roomId, `idle: no activity or connections for >= ${idleTtlMs}ms`, 'idle')
				console.log(`[canvas-v2 ${roomId}] evicted for idleness (>= ${idleTtlMs}ms, no connections)`)
			} catch (err) {
				// Per-actor isolation, mirroring app.ts's shadow-driver sweep: one
				// poisoned actor's close() throwing must not abort the sweep for
				// every other idle room. The actor is left registered (not
				// half-evicted) — it will be retried on the next sweep.
				console.error(`[canvas-v2 ${roomId}] sweepIdle: actor.close() threw — left registered, will retry next sweep`, err)
			}
		}
	}

	function close(): void {
		for (const actor of actors.values()) actor.close()
		actors.clear()
	}

	return { getOrCreate, entries, evictions: getEvictions, sweepIdle, close }
}
