// canvas-sync/src/soak.ts — E4's soak simulation. PURE, parameterized,
// deterministic: boundary.test.ts scans this file like every other src/ file
// (no Date.now/Math.random). Every random draw goes through the injected
// mulberry32 rng (same seed ⇒ same replay, forever). Wall-clock concerns (the
// nightly CLI's own timing, process.memoryUsage().rss sampling) live OUTSIDE
// this file, in ../soak-cli.ts (package root, not scanned) — this file only
// ever sees an INJECTED `sampleRss?: () => number` if a caller wants RSS
// tracked; it never calls process.memoryUsage() itself.
//
// Topology: one SyncServerPeer (never a DocumentActor — persistence is
// server-side, E3's job; canvas-sync stays clean-room: SyncServerPeer +
// SyncClientPeer only), `clients` SyncClientPeers each behind a CHAOS-wrapped
// in-memory transport pair (per-frame PRNG decision: deliver now / drop /
// defer-to-queue — intensity-scaled), plus occasional DIRECT server-doc
// writes standing in for "agent API" writers that bypass every client.
//
// Op source: rig/ops.ts's SAME vocabulary and PRNG as the E1 convergence rig
// (REUSE, not a reinvention) — one big batch is generated up front via
// `randomOps(rng, ops, idPool)` (preserving ops.ts's own internal hostile-
// burst pairing/PRNG-consumption contract), then this file routes each op,
// ONE AT A TIME, to a randomly chosen target (a client's doc, or the server's
// doc directly). Honesty note: E1 applies each peer's WHOLE batch on ONE
// peer before exchanging, so a hostile burst (e.g. "attempt a reparent cycle")
// always lands on a single doc, guaranteeing the local cycle-guard trip it's
// designed to exercise. Here, routing per-op to a RANDOM target can split a
// burst's ops across different actors, which usually degrades the burst into
// a harmless silent no-op (reparent/putShape on an id that peer hasn't
// synced yet — both are no-throw, per canvas-doc's contract) rather than a
// guaranteed same-peer cycle rejection. That's an accepted, documented
// simplification: this rig's job is chaos/reconnect/growth/repair under
// concurrent multi-actor load, not re-proving E1's cycle-guard property.
//
// Chaos-dropped frames are healed ONLY by a reconnect-driven full-history
// backfill (Loro version-vector deltas) — never by "waiting long enough".
// The final phase QUIESCES: chaos off (every client gets one final reconnect
// over a PLAIN, non-chaotic pair, so the backfill handshake itself cannot be
// dropped), the deferred queue is drained, and ONLY THEN does this function
// assert convergence. Removing the quiesce step is a real, self-checked
// failure mode (see the execution report) — proving chaos in this rig is
// genuine, not decorative.
import assert from 'node:assert/strict'
import { checkInvariants } from '@ensembleworks/canvas-model'
import type { RepairOp } from '@ensembleworks/canvas-model'
import { dumpModel, type LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { SyncClientPeer } from './client-peer.js'
import { SyncServerPeer } from './server-peer.js'
import { makePair } from './memory-transport.js'
import type { Transport } from './protocol.js'
import { int, mulberry32, type Rng } from './rig/prng.js'
import { applyOp, randomOps, type ApplyStats, type IdPool } from './rig/ops.js'
import { normalize } from './test-helpers.js'

export interface RunSoakOpts {
	clients: number
	ops: number
	seed: number
	/** 0..1 chaos intensity: linearly scales the drop/defer probabilities (see
	 * DROP_CEILING/DEFER_CEILING — capped so even chaos=1 can't guarantee
	 * 100% loss; convergence must remain reachable once quiesced). */
	chaos: number
	/** Sampling cadence (in ops) for the bounded-growth snapshot-size
	 * tripwire. NOTE: canvas-sync has no compaction primitive of its own
	 * (only the server-side DocumentActor compacts, E3) — this knob means
	 * "how often to SAMPLE snapshot bytes", not "compact now". Default
	 * `ops / 10`, matching the design's "track ... at intervals (every
	 * ~ops/10)". */
	compactEvery?: number
	/** Force a full (mid-sim, still chaos-wrapped) reconnect of a random
	 * client every this-many ops — exercises the backfill path repeatedly,
	 * not just once at the end. Default `ops / 20`. */
	reconnectEvery?: number
	/** Injected RSS sampler (e.g. `() => process.memoryUsage().rss` from the
	 * CLI). Sampled at the same cadence as the snapshot-size tripwire.
	 * Omitted entirely ⇒ `rssSamples` is absent from the result — this file
	 * never calls process.memoryUsage() itself (determinism rule). */
	sampleRss?: () => number
}

export interface SoakResult {
	/** True iff every client's normalized dumpModel equals the server's AND
	 * checkInvariants is clean everywhere, AFTER the quiesce phase. */
	converged: boolean
	/** The server's live shape count after quiescing (the canonical count). */
	finalShapeCount: number
	/** The server's exportSnapshot().byteLength after quiescing. */
	finalSnapshotBytes: number
	/** Snapshot byte-length samples taken every `compactEvery` ops throughout
	 * the run, plus one final sample post-quiesce — the growth curve the
	 * bounded-growth tripwire below is judging. */
	snapshotSamples: number[]
	/** The largest single local-update payload (bytes) observed on ANY peer
	 * (server or client) during the whole run — a proxy for single-message
	 * inflation, distinct from the cumulative snapshot growth tracked above. */
	maxUpdateBytes: number
	/** Count of repair() invocations (across the server AND every client)
	 * that returned a NON-EMPTY plan — i.e., repair actually did something.
	 * Observed via wrapping each peer's `doc.repair` (the same "wrap a real
	 * method to count/observe calls" technique server/canvas-v2's actor.test
	 * already uses for its own instrumentation) — a real count, not a
	 * fabricated one. */
	repairFirings: number
	/** How many mid-sim forced reconnects this run performed (diagnostic). */
	reconnectsForced: number
	/** SyncServerPeer.malformedFrames after quiescing — should be ~0 (nothing
	 * here manufactures garbage bytes; a fuzz corpus is E2's job). */
	malformedFrames: number
	/** SyncServerPeer.pendingImports after quiescing — climbing during the
	 * run is expected (chaos reorders frames); should settle low/zero once
	 * quiesced (everything that was pending has been filled by then). */
	pendingImports: number
	/** Present iff `opts.sampleRss` was provided. */
	rssSamples?: number[]
}

// Bounded-growth tripwire constants — a tripwire for tombstone bloat, NOT a
// tight budget (the design's own framing). AVG_SHAPE_SIZE_BYTES is a rough
// RAW envelope-only estimate (independent of any CRDT overhead); K is the
// "CRDT/history overhead multiplier on top of that" — calibrated from three
// real runSoak() measurements (bytes-per-LIVE-shape, since without
// compaction — canvas-sync has none; only the server-side DocumentActor
// compacts, E3 — full history always survives in the snapshot):
//   500 ops / 3 clients / chaos 0.3  -> 4 live shapes,   21,868 B -> 5,467 B/shape
//   5,000 ops / 5 clients / chaos 0.5 -> 55 live shapes,  221,876 B -> 4,034 B/shape
//   20,000 ops / 5 clients / chaos 0.5 -> 238 live shapes, 908,057 B -> 3,815 B/shape
// The ratio DECREASES as scale grows (fixed genesis/doc-structure overhead
// amortizes), so the smallest-scale run is the worst case: 5,467 B/shape ÷
// 300 B ≈ 18.2x. K=30 gives ~1.65x headroom over that worst case (and ~2.2–
// 2.4x headroom at the two larger scales) — generous enough to absorb normal
// run-to-run variance (different seeds/chaos/pool sizes) while still
// catching a genuine multi-x regression (e.g. a repair/dedupe bug that stops
// reclaiming tombstones at all).
// CAVEAT: this K=30 calibration is scoped to the two shipped configurations
// above (chaos 0.3 smoke, chaos 0.5 nightly). chaos=0 / low-shape-count
// configs measured ~21.9KB over just 2 live shapes — far outside this
// envelope — and WILL false-positive the tripwire; recalibrate before adding
// any new runSoak() caller with different parameters.
export const BOUNDED_GROWTH_K = 30
export const AVG_SHAPE_SIZE_BYTES = 300

/** Scales the shared id pool to the requested op count: enough ids that
 * heavy churn on a SMALL pool (the interesting case — collisions, deletes
 * racing recreates, tombstone accumulation) still happens, without the pool
 * being so large that ops almost never touch the same id twice. */
function makeIdPool(ops: number): IdPool {
	const shapeCount = Math.max(10, Math.min(2000, Math.floor(ops / 20)))
	const bindingCount = Math.max(4, Math.min(500, Math.floor(shapeCount / 4)))
	return {
		shapeIds: Array.from({ length: shapeCount }, (_, i) => `shape:s${i}`),
		pageIds: ['page:p'],
		bindingIds: Array.from({ length: bindingCount }, (_, i) => `binding:b${i}`),
	}
}

/** Deliveries deferred by chaos, drained explicitly by the sim loop (never a
 * setTimeout — see the house "no timers in deterministic tests" rule). */
interface DeferredQueue {
	push(deliver: () => void): void
	pump(): void
	size(): number
}
function makeDeferredQueue(): DeferredQueue {
	let queued: Array<() => void> = []
	return {
		push(fn) {
			queued.push(fn)
		},
		pump() {
			const batch = queued
			queued = []
			for (const fn of batch) fn()
		},
		size() {
			return queued.length
		},
	}
}

interface ChaosOpts {
	rng: Rng
	intensity: number
	queue: DeferredQueue
}

// Never let intensity=1 guarantee total loss — a soak must remain able to
// converge once quiesced, and these ceilings keep drop+defer well under 1.
const DROP_CEILING = 0.25
const DEFER_CEILING = 0.35

/** Wraps ONE end of a transport pair: every `send()` is a fresh PRNG draw
 * deciding deliver-now / drop (never delivered — only a reconnect backfill
 * heals this) / defer (queued, delivered out of its original order whenever
 * the sim next pumps — the reordering case). `onMessage`/`onClose`/`close`
 * pass straight through untouched. */
function wrapChaos(raw: Transport, opts: ChaosOpts): Transport {
	return {
		send(bytes) {
			const r = opts.rng()
			const dropP = opts.intensity * DROP_CEILING
			const deferP = opts.intensity * DEFER_CEILING
			if (r < dropP) return
			if (r < dropP + deferP) {
				opts.queue.push(() => raw.send(bytes))
				return
			}
			raw.send(bytes)
		},
		onMessage: (cb) => raw.onMessage(cb),
		onClose: (cb) => raw.onClose(cb),
		close: () => raw.close(),
	}
}

function makeChaosPair(rng: Rng, intensity: number, queue: DeferredQueue): [Transport, Transport] {
	const [a, b] = makePair()
	return [wrapChaos(a, { rng, intensity, queue }), wrapChaos(b, { rng, intensity, queue })]
}

/** Wraps `doc.repair` to count non-empty-plan invocations into a shared
 * counter, and adds an EXTRA `subscribeLocalUpdates` listener (Loro's
 * subscribe hooks support more than one subscriber) purely to track the
 * largest local-update payload seen — neither wiring replaces or interferes
 * with the peer's own already-wired forwarding subscription. */
function instrument(
	doc: LoroCanvasDoc,
	onRepair: (plan: RepairOp[]) => void,
	onLocalUpdate: (bytes: Uint8Array) => void,
): void {
	const originalRepair = doc.repair.bind(doc)
	;(doc as unknown as { repair: () => RepairOp[] }).repair = () => {
		const plan = originalRepair()
		onRepair(plan)
		return plan
	}
	doc.subscribeLocalUpdates(onLocalUpdate)
}

function statesEqual(a: unknown, b: unknown): boolean {
	try {
		assert.deepStrictEqual(a, b)
		return true
	} catch {
		return false
	}
}

export function runSoak(opts: RunSoakOpts): SoakResult {
	const rng = mulberry32(opts.seed)
	const idPool = makeIdPool(opts.ops)
	const queue = makeDeferredQueue()
	const stats: ApplyStats = { skipped: 0 }

	let repairFirings = 0
	let maxUpdateBytes = 0
	const onRepair = (plan: RepairOp[]): void => {
		if (plan.length > 0) repairFirings++
	}
	const onLocalUpdate = (bytes: Uint8Array): void => {
		if (bytes.length > maxUpdateBytes) maxUpdateBytes = bytes.length
	}

	const server = new SyncServerPeer({ peerId: 1n })
	instrument(server.doc, onRepair, onLocalUpdate)
	// Genesis: one real page. Without it, EVERY shape (fixed-pool parentId
	// 'page:p') would be a permanent noOrphans violation — repairPlan cannot
	// invent a page to reparent onto (see canvas-model/repair.ts).
	server.doc.putPage({ id: 'page:p', name: 'P' })
	server.doc.commit()

	interface ClientHandle {
		peer: SyncClientPeer
	}
	const clients: ClientHandle[] = []
	for (let i = 0; i < opts.clients; i++) {
		const peerId = BigInt(1000 + i)
		const [serverEnd, clientEnd] = makeChaosPair(rng, opts.chaos, queue)
		server.connect(serverEnd)
		const peer = new SyncClientPeer({ peerId, transport: clientEnd })
		instrument(peer.doc, onRepair, onLocalUpdate)
		clients.push({ peer })
	}

	// 5% of ops are direct server-side "agent API" writes, bypassing every
	// client entirely (they mutate the authoritative doc directly, then relay
	// out through each client's already-chaos-wrapped connection).
	const AGENT_WRITE_RATE = 0.05
	const pumpEvery = Math.max(1, Math.floor(opts.ops / 100))
	const reconnectEvery = opts.reconnectEvery ?? Math.max(1, Math.floor(opts.ops / 20))
	const snapshotSampleEvery = opts.compactEvery ?? Math.max(1, Math.floor(opts.ops / 10))

	const snapshotSamples: number[] = []
	const rssSamples: number[] = []
	let reconnectsForced = 0

	// One big batch, up front — preserves ops.ts's own internal PRNG-
	// consumption/hostile-burst-pairing contract (see this file's header
	// comment for the honesty note on what's lost by routing per-op below).
	const script = randomOps(rng, opts.ops, idPool)

	for (let i = 0; i < script.length; i++) {
		const op = script[i] as (typeof script)[number]
		if (rng() < AGENT_WRITE_RATE) {
			applyOp(server.doc, op, stats)
			server.doc.commit()
		} else {
			const c = clients[int(rng, clients.length)] as ClientHandle
			applyOp(c.peer.doc, op, stats)
			c.peer.doc.commit()
		}

		const n = i + 1
		if (n % pumpEvery === 0) queue.pump()
		if (clients.length > 0 && n % reconnectEvery === 0) {
			const c = clients[int(rng, clients.length)] as ClientHandle
			const [serverEnd, clientEnd] = makeChaosPair(rng, opts.chaos, queue)
			server.connect(serverEnd)
			c.peer.reconnect(clientEnd)
			reconnectsForced++
		}
		if (n % snapshotSampleEvery === 0) {
			snapshotSamples.push(server.snapshot().byteLength)
			if (opts.sampleRss) rssSamples.push(opts.sampleRss())
		}
	}

	// --- QUIESCE: stop chaos, full reconnect every client over a PLAIN pair,
	// drain the deferred queue — THEN assert convergence. ---
	queue.pump() // deliver whatever chaos had deferred, before transports are replaced
	for (const c of clients) {
		const [serverEnd, clientEnd] = makePair() // PLAIN — this handshake must not be dropped
		server.connect(serverEnd)
		c.peer.reconnect(clientEnd)
	}
	queue.pump() // anything still targeting a now-closed (pre-reconnect) transport is a harmless no-op

	const serverModel = normalize(dumpModel(server.doc))
	let converged = checkInvariants(dumpModel(server.doc)).length === 0
	for (const c of clients) {
		const clientDoc = dumpModel(c.peer.doc)
		if (checkInvariants(clientDoc).length > 0) converged = false
		if (!statesEqual(normalize(clientDoc), serverModel)) converged = false
	}

	const finalShapeCount = server.doc.listShapes().length
	const finalSnapshotBytes = server.snapshot().byteLength
	snapshotSamples.push(finalSnapshotBytes)

	const bound = BOUNDED_GROWTH_K * Math.max(1, finalShapeCount) * AVG_SHAPE_SIZE_BYTES
	assert.ok(
		finalSnapshotBytes < bound,
		`bounded-growth tripwire: snapshot ${finalSnapshotBytes}B >= K(${BOUNDED_GROWTH_K}) × liveShapes(${finalShapeCount}) × avgSize(${AVG_SHAPE_SIZE_BYTES}B) = ${bound}B — possible tombstone bloat`,
	)

	const result: SoakResult = {
		converged,
		finalShapeCount,
		finalSnapshotBytes,
		snapshotSamples,
		maxUpdateBytes,
		repairFirings,
		reconnectsForced,
		malformedFrames: server.malformedFrames,
		pendingImports: server.pendingImports,
	}
	if (opts.sampleRss) result.rssSamples = rssSamples
	void stats // skip-count is informational only (a guarded op that threw) — not asserted, mirrors E1's rig/ops.ts contract
	return result
}
