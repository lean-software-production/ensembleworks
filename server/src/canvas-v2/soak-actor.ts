/**
 * The DocumentActor-backed compacting soak variant (Task H4 — the Phase-2
 * deferral "DocumentActor-backed compacting soak variant (prod-faithful
 * growth)"). canvas-sync's own soak (src/soak.ts) runs entirely against a
 * bare `SyncServerPeer` — a real peer, but with NO persistence and NO
 * compaction, since canvas-sync is clean-room and compaction is a
 * server-side concern (`DocumentActor`/`CanvasV2Store`, this workspace).
 * That variant's `snapshotSamples` growth curve is therefore a function of
 * Loro's own in-memory history retention alone — it can NEVER show what
 * compaction does, because nothing in canvas-sync compacts anything.
 *
 * THE SEAM (per the plan's own framing — "canvas-sync can't import server;
 * server CAN import canvas-sync"): canvas-sync's `runSoak` now accepts an
 * optional `server: SoakServer` — a minimal structural interface (`doc`,
 * `connect`, `snapshot`, `malformedFrames`, `pendingImports`) that a bare
 * `SyncServerPeer` already satisfies for free. This module builds an
 * adapter (`actorSoakServer`) around a REAL `DocumentActor` (writing to a
 * REAL SQLite file the caller owns) that satisfies the exact same
 * interface, then hands it to the UNCHANGED `runSoak` — reusing every bit
 * of its chaos/reconnect/op-routing/instrumentation machinery with zero
 * duplication. `server` here can import `canvas-sync`'s public entry
 * freely (this workspace already depends on it); canvas-sync itself never
 * imports anything from `server` — the boundary stays exactly as clean-room
 * as before.
 *
 * TWO GROWTH AXES, MEASURED SEPARATELY (this is the whole point of this
 * variant): `SoakResult.snapshotSamples`/`finalSnapshotBytes` — the
 * IN-MEMORY `doc.exportSnapshot()` size — behaves IDENTICALLY to the bare
 * variant (compaction never shrinks Loro's own retained history; it only
 * persists whatever that size already is). The NEW axis this variant adds
 * is `diskSamples`/`finalDiskBytes` — the ACTUAL ON-DISK SQLite file size
 * (`CanvasV2Store`'s `updates` + `snapshots` tables) — which SHOULD stay
 * roughly BOUNDED (one folded-in snapshot row plus at most `compactEvery`
 * un-compacted update rows) rather than growing without bound the way an
 * ever-appending, never-compacted log would. See CALIBRATION below for the
 * measured numbers this bound is set from.
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { runSoak, type RunSoakOpts, type SoakResult, type SoakServer } from '@ensembleworks/canvas-sync'
import { DocumentActor } from './actor.ts'

/** How often (in PERSISTED updates, not sim ops — DocumentActor's own unit,
 * see actor.ts's `compactEvery` doc comment) the actor folds its append-log
 * into a fresh snapshot. Deliberately small relative to a soak's op count so
 * compaction actually FIRES MULTIPLE TIMES during a run of any real size —
 * the whole point of this variant is to observe the compacting curve, not
 * to compact once at the very end. */
const DEFAULT_ACTOR_COMPACT_EVERY = 50

export interface RunActorSoakOpts extends Omit<RunSoakOpts, 'server' | 'sampleExtra'> {
	/** Directory for the actor's SQLite file — CALLER-OWNED (create + clean up
	 * a temp dir; this function never deletes it, matching DocumentActor's own
	 * "caller owns the dir" posture — actors.ts's registry). */
	dir: string
	/** Default `'soak'` — only matters if a caller runs more than one actor
	 * soak against the SAME dir and needs distinct files. */
	roomId?: string
	/** DocumentActor's own compaction cadence (persisted updates between
	 * folds) — see DEFAULT_ACTOR_COMPACT_EVERY's doc comment. NOT the same
	 * knob as `RunSoakOpts.compactEvery` (which only controls SAMPLING
	 * cadence in the inherited base type — misleadingly similarly named, but
	 * a genuinely different axis; kept distinct rather than overloaded). */
	actorCompactEvery?: number
	/** Bounded-DISK-growth tripwire override — see CALIBRATION in the module
	 * header / soak-actor.test.ts for the measured numbers this defaults
	 * from. */
	diskGrowthMultiplier?: number
}

export interface ActorSoakResult extends SoakResult {
	/** The actor's SQLite file size, in bytes, after a final close()
	 * (which always compacts — actor.ts's close() doc comment). */
	finalDiskBytes: number
	/** Disk-file-size samples at the SAME cadence as `snapshotSamples`
	 * (`sampleExtra`, threaded through unchanged `runSoak`), plus one final
	 * post-close sample — mirrors `snapshotSamples`' own "plus one final
	 * sample post-quiesce" convention (soak.ts's SoakResult doc comment). */
	diskSamples: number[]
}

/** Adapts a real `DocumentActor` to canvas-sync's `SoakServer` — the ONLY
 * new code this variant needs; everything else is `runSoak` itself,
 * unchanged. Getters (not plain fields) so this always reads the actor's
 * CURRENT `.peer` — irrelevant today (an actor's `.peer` never changes
 * post-construction) but cheap and future-proof against that ever
 * changing. */
function actorSoakServer(actor: DocumentActor): SoakServer {
	return {
		get doc() {
			return actor.peer.doc
		},
		connect(t) {
			actor.connect(t)
		},
		snapshot() {
			return actor.peer.snapshot()
		},
		get malformedFrames() {
			return actor.peer.malformedFrames
		},
		get pendingImports() {
			return actor.peer.pendingImports
		},
	}
}

/**
 * CALIBRATION (measured directly with a throwaway calibration harness
 * against THIS module, seed 42, actorCompactEvery=50 — see the H4 execution
 * report for the full transcript):
 *
 *   clients ops   chaos  finalShapes  finalSnapshotBytes  finalDiskBytes  disk÷snapshot
 *   2       300   0.3    4            11,408              4,096           0.36x
 *   3       1,000 0.3    7            40,336               176,128        4.37x
 *   3       3,000 0.5    25           119,698              339,968        2.84x
 *   5       8,000 0.5    91           352,836              2,232,320      6.33x
 *
 * KEY FINDING (why this bounds against `finalSnapshotBytes`, NOT
 * `finalShapeCount × avgSize` the way soak.ts's in-memory tripwire does):
 * `DocumentActor.compact()` persists `store.compact(peer.snapshot())` —
 * the snapshot ROW it writes IS byte-identical to the in-memory
 * `exportSnapshot()` this same run's `finalSnapshotBytes` already measures.
 * So disk size is fundamentally ANCHORED to that same in-memory-history
 * axis, plus whatever the uncompacted log tail and SQLite's own page
 * overhead add on top — a per-shape estimate has no mechanical reason to
 * predict it, which is exactly why the ratio above bounces around (0.36x
 * to 6.33x) rather than settling like soak.ts's own K did.
 *
 * A SECOND finding, equally load-bearing: `CanvasV2Store.compact()`'s
 * `DELETE` frees SQLite rows into the file's internal freelist, but does
 * NOT shrink the file on disk (no `VACUUM`/`auto_vacuum` is configured) —
 * so file size is a HIGH-WATER MARK across the run's compaction cycles,
 * not a live "current logical size." That's a genuine, documented
 * limitation of the current `store.ts` (worth a Phase-4 look — `VACUUM`
 * has real cost of its own, so isn't a drop-in fix), not something this
 * unit changes; the growth-shape observation above already accounts for it
 * (the ratio was measured against the ACTUAL file, high-water-mark
 * behavior included).
 *
 * `DISK_GROWTH_MULTIPLIER` bounds `finalDiskBytes < DISK_GROWTH_MULTIPLIER ×
 * max(AVG_MIN_DISK_BYTES, finalSnapshotBytes)` — headroom of ~1.9x over the
 * worst measured ratio (6.33x), generous for run-to-run variance while
 * still catching a genuine multi-x regression (e.g. `actorCompactEvery`
 * silently stops firing, or a `store.compact()` regression that stops
 * pruning the log at all). `AVG_MIN_DISK_BYTES` (one SQLite page) floors
 * the bound so a tiny/near-empty run's naturally-small snapshot doesn't
 * make the bound tighter than a single page ever allows.
 */
export const DISK_GROWTH_MULTIPLIER = 12
export const AVG_MIN_DISK_BYTES = 4096

export function runActorSoak(opts: RunActorSoakOpts): ActorSoakResult {
	const roomId = opts.roomId ?? 'soak'
	const actor = new DocumentActor({
		dir: opts.dir,
		roomId,
		peerId: 1n,
		compactEvery: opts.actorCompactEvery ?? DEFAULT_ACTOR_COMPACT_EVERY,
	})
	const dbPath = path.join(opts.dir, `${roomId}.sqlite`)
	const server = actorSoakServer(actor)

	let result: SoakResult
	try {
		result = runSoak({
			clients: opts.clients,
			ops: opts.ops,
			seed: opts.seed,
			chaos: opts.chaos,
			compactEvery: opts.compactEvery,
			reconnectEvery: opts.reconnectEvery,
			sampleRss: opts.sampleRss,
			growthK: opts.growthK,
			avgShapeSizeBytes: opts.avgShapeSizeBytes,
			server,
			sampleExtra: () => statSync(dbPath).size,
		})
	} finally {
		// Idempotent (DocumentActor.close()'s own guard) — always runs, success
		// or throw. ALWAYS compacts one final time (actor.ts's close() doc
		// comment), which is exactly what makes the finalDiskBytes read below
		// meaningful: it reflects the POST-compaction file size, not whatever
		// the log happened to look like at the last sampled point.
		actor.close()
	}

	const finalDiskBytes = statSync(dbPath).size
	const diskSamples = [...(result.extraSamples ?? []), finalDiskBytes]

	const diskGrowthMultiplier = opts.diskGrowthMultiplier ?? DISK_GROWTH_MULTIPLIER
	const bound = diskGrowthMultiplier * Math.max(AVG_MIN_DISK_BYTES, result.finalSnapshotBytes)
	if (!(finalDiskBytes < bound)) {
		throw new Error(
			`bounded-DISK-growth tripwire: actor sqlite file ${finalDiskBytes}B >= multiplier(${diskGrowthMultiplier}) × max(${AVG_MIN_DISK_BYTES}B, finalSnapshotBytes=${result.finalSnapshotBytes}B) = ${bound}B — possible append-log compaction regression`,
		)
	}

	return { ...result, finalDiskBytes, diskSamples }
}
