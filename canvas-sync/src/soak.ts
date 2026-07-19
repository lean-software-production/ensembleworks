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

/**
 * The minimal server-side surface `runSoak` actually touches — satisfied
 * structurally by a bare `SyncServerPeer` (the default, unchanged since this
 * type was introduced) or by a caller-supplied adapter around something
 * heavier, e.g. server/src/canvas-v2/'s `DocumentActor` (Task H4's
 * actor-backed compacting variant — canvas-sync itself can never import
 * `server`, so that adapter is built OUTSIDE this package and handed in via
 * `RunSoakOpts.server`; this interface is the seam that makes that possible
 * without this file knowing DocumentActor exists). Every method/getter here
 * is something `SyncServerPeer` already has, so `new SyncServerPeer({peerId:
 * 1n})` satisfies this type with zero adapter code — see `runSoak`'s default.
 */
export interface SoakServer {
	readonly doc: LoroCanvasDoc
	connect(t: Transport): void
	snapshot(): Uint8Array
	readonly malformedFrames: number
	readonly pendingImports: number
}

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
	/** Injected EXTRA sampler, sampled at the exact same cadence/points as
	 * `sampleRss` — an open channel for a caller-specific metric this file
	 * has no business knowing about (Task H4's actor-backed variant uses it
	 * for the actor's ON-DISK sqlite file size — a genuinely different axis
	 * from `snapshotSamples` below, which is always the in-memory
	 * `doc.exportSnapshot().byteLength`, unaffected by any disk-level
	 * compaction). Omitted entirely ⇒ `extraSamples` is absent from the
	 * result. */
	sampleExtra?: () => number
	/** The server-side peer to run against. Defaults to a bare, freshly
	 * constructed `new SyncServerPeer({peerId: 1n})` — canvas-sync's own
	 * clean-room soak, unchanged from before this option existed. A caller
	 * outside this package (server's H4 variant) may inject an adapter
	 * around something heavier that satisfies `SoakServer` structurally. */
	server?: SoakServer
	/** Bounded-growth tripwire overrides — default to the module's own
	 * `BOUNDED_GROWTH_K`/`AVG_SHAPE_SIZE_BYTES`, calibrated for the bare
	 * `SyncServerPeer` variant at the two shipped configurations (see those
	 * constants' own doc comment). A caller running against a DIFFERENT
	 * `server` (e.g. an actor-backed adapter with its own growth shape) may
	 * need its own calibrated numbers — set both here rather than silently
	 * inheriting a calibration that doesn't apply, per this module's own
	 * CAVEAT on BOUNDED_GROWTH_K. */
	growthK?: number
	avgShapeSizeBytes?: number
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
	/** Present iff `opts.sampleExtra` was provided — see that option's doc
	 * comment. */
	extraSamples?: number[]
}

// Bounded-growth tripwire constants — a tripwire for tombstone bloat, NOT a
// tight budget (the design's own framing). AVG_SHAPE_SIZE_BYTES is a rough
// RAW envelope-only estimate (independent of any CRDT overhead); K is the
// "CRDT/history overhead multiplier on top of that" — calibrated from real
// runSoak() measurements (bytes-per-LIVE-shape, since without compaction —
// canvas-sync has none; only the server-side DocumentActor compacts, E3 —
// full history always survives in the snapshot).
//
// RE-CALIBRATED 2026-07-15 for the setText-inclusive op mix (rig/ops.ts H1
// shift: putShape 40→35%, updateProps 20→15%, reparent 15→10%, new setText
// 15%; hostile bands unchanged). setText's payload lives in a separate,
// compact per-shape LoroText container keyed `text:<id>` (loro-canvas-doc.ts's
// textKey), so trading putShape/updateProps/reparent weight for setText did
// NOT raise per-live-shape snapshot growth at the production configs — if
// anything it eased slightly there (see the keep-decision below).
// Representative single-run point measurements on the new mix (via
// `bun canvas-sync/soak-cli.ts`):
//   500 ops / 3 clients / chaos 0.3   seed=1  ->   7 live shapes,  19,726 B -> 2,818 B/shape
//   5,000 ops / 5 clients / chaos 0.5  seed=42 ->  74 live shapes, 222,033 B -> 3,000 B/shape
//   20,000 ops / 5 clients / chaos 0.5 seed=42 -> 348 live shapes, 926,373 B -> 2,662 B/shape
// Seed sweeps at each config, worst-case bytes-per-LIVE-shape (÷300 B gives
// the K-multiple the tripwire is judging). The bytes-per-shape ratio is
// dominated by FIXED per-doc overhead (genesis page, doc structure, full
// oplog history) amortized over the LIVE shape count, so it EXPLODES at low
// shape counts and settles as shape count grows — read these three configs
// with that shape-count axis in mind, not as one monotonic curve:
//   500/3/0.3   (150 seeds): DEGENERATE low-shape-count config. ~9% of seeds
//     (14/150) quiesce to just 1–2 live shapes and TRIP the K=30 bound
//     outright (fixed overhead over ~1 shape ⇒ tens of x). Even excluding
//     those, the shapes≥3 worst is ~7,120 B/shape ≈ 23.7x (seed=46) —
//     ABOVE the old-mix 18.2x benchmark AND above the two production configs
//     below. This is the amortization artifact, not a growth regression:
//     500 ops over a 25-id pool simply cannot sustain many live shapes.
//   5,000/5/0.5  (20 seeds): worst 4,552 B/shape ≈ 15.2x (seed=28), byte-exact.
//   20,000/5/0.5 (20 seeds): worst 3,828 B/shape ≈ 12.8x (seed=65), byte-exact.
// KEEP-DECISION (K=30, unchanged — NOT lowered): the decision rests on the
// PRODUCTION-RELEVANT configs, i.e. the two chaos-0.5 scales that actually
// run hundreds of live shapes. Their worst is 4,552 B/shape ≈ 15.2x — LOWER
// than the old mix's 18.2x — so K=30 gives ~2.0x headroom there (≈2.3x at
// the 20k scale), enough to absorb run-to-run variance while still catching
// a genuine multi-x regression (a repair/dedupe bug that stops reclaiming
// tombstones, or a setText path that stops converging its LoroText
// containers). The nightly runs exactly 20k/5/0.5 and rotates its seed
// forever (GITHUB_RUN_NUMBER), so its per-shape bytes stay well under the K
// bound (9,000 B/shape = 30 × 300) at the hundreds-of-shapes scale it always
// reaches. The 500/3/0.3 numbers above are NOT the keep-basis (they'd argue
// for a LARGER K) — they're reported honestly to document the degenerate
// tail, which is not a live risk: soak-smoke pins seed=1 (7 live shapes,
// 2,818 B/shape, comfortably inside the bound) and never sweeps the tail.
// CAVEAT: K=30 is scoped to the two PRODUCTION configs (chaos 0.5, hundreds
// of shapes). Low-shape-count runs — the ~9% of 500/3/0.3 seeds that quiesce
// to 1–2 shapes (worst measured ~18.9KB over a single shape, 63x), and any
// chaos=0 config — fall outside this envelope by that same amortization
// effect and WILL false-positive the tripwire; recalibrate (or set the
// growthK/avgShapeSizeBytes overrides) before adding any new runSoak() caller
// whose parameters yield few live shapes.
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

	const server: SoakServer = opts.server ?? new SyncServerPeer({ peerId: 1n })
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
	const extraSamples: number[] = []
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
			if (opts.sampleExtra) extraSamples.push(opts.sampleExtra())
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

	// TEXT convergence: dumpModel/CanvasDocument carries NO text field at all —
	// setText writes to a separate per-shape LoroText container keyed
	// `text:<id>` (loro-canvas-doc.ts's textKey), entirely outside the
	// Shape/CanvasDocument schema. So the dumpModel-based checks above never
	// exercise setText's convergence — they'd stay green under TOTAL
	// cross-client text divergence. Mirrors convergence.test.ts's runTrial:
	// check getText explicitly, per pool shape id, across the server and every
	// client (the server stands in for that rig's "peer 0" reference point).
	for (const id of idPool.shapeIds) {
		const serverText = server.doc.getText(id)
		for (const c of clients) {
			if (c.peer.doc.getText(id) !== serverText) converged = false
		}
	}

	const finalShapeCount = server.doc.listShapes().length
	const finalSnapshotBytes = server.snapshot().byteLength
	snapshotSamples.push(finalSnapshotBytes)

	const growthK = opts.growthK ?? BOUNDED_GROWTH_K
	const avgShapeSizeBytes = opts.avgShapeSizeBytes ?? AVG_SHAPE_SIZE_BYTES
	const bound = growthK * Math.max(1, finalShapeCount) * avgShapeSizeBytes
	assert.ok(
		finalSnapshotBytes < bound,
		`bounded-growth tripwire: snapshot ${finalSnapshotBytes}B >= K(${growthK}) × liveShapes(${finalShapeCount}) × avgSize(${avgShapeSizeBytes}B) = ${bound}B — possible tombstone bloat`,
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
	if (opts.sampleExtra) result.extraSamples = extraSamples
	void stats // skip-count is informational only (a guarded op that threw) — not asserted, mirrors E1's rig/ops.ts contract
	return result
}
