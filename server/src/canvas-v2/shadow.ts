/**
 * ShadowMirror — a room's continuous tldraw → Loro mirror. On every `tick()`
 * (driven externally by D3's clock-polled interval, or directly by tests):
 * convert the live tldraw records via `fromTldraw`, `reconcile` that target
 * into this mirror's own `LoroCanvasDoc`, and — every `checkEvery`-th tick —
 * compare the mirror against the target structurally and count divergences.
 * Zero user exposure: this doc is never synced to any client, never mounted
 * on `/sync/v2`, and exists purely for telemetry ahead of the real Phase 3/5
 * cutover.
 *
 * Design notes (controller-ratified deviations from the plan's sketch):
 *
 * - **Fail-loud, but counted, not propagated.** `reconcile`/`putShape` can
 *   throw (Loro's native cycle guard) if converted tldraw data is somehow
 *   hostile. D1's reconcile() deliberately lets that throw rather than
 *   catch-and-skip per shape (a partial diff silently applied is worse than
 *   a loud failure). This class is the boundary that must not let one bad
 *   room's tick kill the D3 driver's loop over every other room: `tick()`
 *   wraps its whole body (including `getRecords()`, which can itself throw)
 *   in try/catch, counts `tickErrors`, records `lastError`, and
 *   `console.error`s — but never rethrows. This is a deviation from the
 *   plan's `ShadowMetrics` shape (no `tickErrors`/`lastError` there),
 *   controller-approved: fail-loud needs a counter or it's invisible.
 * - **No auto-repair of the mirror.** `checkDivergence` also runs
 *   `checkInvariants` on the mirror and *warns* on violations — it does NOT
 *   call `.repair()`. The mirror's whole purpose is to faithfully reflect
 *   what `reconcile` produces from the live conversion; a repair firing here
 *   in production is itself the signal (design: "prod repair firing = an
 *   escaped bug" upstream in convert/reconcile), not something to paper over
 *   by silently fixing the mirror.
 * - **`snapshotBytes` is sampled only on check-ticks, not every tick** —
 *   deviation from the plan's "shapeCount/snapshotBytes refreshed per tick".
 *   `exportSnapshot()` serializes the WHOLE doc (O(doc size)); at ~1s
 *   polling (D3) that's acceptable but needlessly hot every tick when
 *   `checkEvery` already gives a coarser, still trend-visible cadence.
 *   `shapeCount` stays cheap enough (`listShapes().length`) to refresh every
 *   tick. E4's soak will quantify whether even that needs sampling.
 * - **`peerId` is a constructor param but uncritical.** Mirror docs are
 *   single-peer and never merge with any other doc (they're never synced),
 *   so peerId collisions can't cause the corruption they'd cause in a real
 *   multi-peer sync — the param exists for API symmetry with
 *   `LoroCanvasDoc.create` and so callers can pick something stable/debuggable
 *   per room if they want to, not because collision safety demands it here.
 */
import { isDeepStrictEqual } from 'node:util'
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { checkInvariants, type CanvasDocument } from '@ensembleworks/canvas-model'
import { fromTldraw } from './convert.ts'
import { reconcile } from './reconcile.ts'

export interface ShadowMetrics {
	ticks: number
	/**
	 * Cumulative shape puts across all ticks. At steady state (no room edits
	 * between ticks) the per-tick puts rate should be ~0 — a persistently
	 * NONZERO puts rate at steady state is itself a churn alarm (e.g. the
	 * key-order-sensitive comparison bug this module was patched for; measured
	 * ~3.3ms steady-state vs ~64ms cold tick at 200 shapes). D3's driver may
	 * add a puts-rate heuristic on top of this counter.
	 */
	puts: number
	deletes: number
	/**
	 * Cumulative writes reconcile REFUSED, across all ticks — see reconcile()'s
	 * `refused`. Unlike puts/deletes this does not settle at steady state: a
	 * refused shape is never written, so every tick retries it and this climbs
	 * by one per bad shape per tick for as long as the room carries it. A
	 * steadily-climbing `refused` therefore means "N shapes in this room fail
	 * the model schema", not "N new problems occurred" — read the RATE against
	 * `ticks`, not the total. It is the counterpart that lets `puts` go back to
	 * meaning churn: before this field those retries were counted as puts.
	 */
	refused: number
	divergences: number
	lastDivergence: string | null
	shapeCount: number
	snapshotBytes: number
	/** Ticks whose body threw (getRecords, fromTldraw, or reconcile). Counted, never propagated. */
	tickErrors: number
	/** Sticky by design: the last tick error SINCE MIRROR CREATION, never
	 * cleared by a later healthy tick — read it as forensics ("has this
	 * mirror ever failed, and how"), not current state; pair with
	 * tickErrors to see whether failures are ongoing. */
	lastError: string | null
}

// A room's shadow mirror. `getRecords` returns the live tldraw records
// (ctx.rooms.getOrCreateRoom(roomId).getCurrentSnapshot().documents.map(d => d.state)).
export class ShadowMirror {
	readonly doc: LoroCanvasDoc
	private m: ShadowMetrics = {
		ticks: 0,
		puts: 0,
		deletes: 0,
		refused: 0,
		divergences: 0,
		lastDivergence: null,
		shapeCount: 0,
		snapshotBytes: 0,
		tickErrors: 0,
		lastError: null,
	}
	constructor(
		private roomId: string,
		peerId: bigint,
		private getRecords: () => any[],
		private checkEvery = 20
	) {
		this.doc = LoroCanvasDoc.create({ peerId })
	}

	tick(): void {
		this.m.ticks++
		try {
			const target = fromTldraw(this.getRecords())
			const { puts, deletes, refused } = reconcile(this.doc, target)
			this.m.puts += puts
			this.m.deletes += deletes
			this.m.refused += refused
			this.m.shapeCount = this.doc.listShapes().length
			if (this.m.ticks % this.checkEvery === 0) {
				this.checkDivergence(target)
				this.m.snapshotBytes = this.doc.exportSnapshot().byteLength
			}
		} catch (err) {
			this.m.tickErrors++
			this.m.lastError = err instanceof Error ? err.message : String(err)
			console.error(`[shadow ${this.roomId}] tick error:`, err)
		}
	}

	private checkDivergence(target: CanvasDocument): void {
		const mirror = dumpModel(this.doc)
		const d = diverges(mirror, target)
		if (d) {
			this.m.divergences++
			this.m.lastDivergence = d
			console.warn(`[shadow ${this.roomId}] divergence: ${d}`)
		}
		// Signal only — see the class doc comment: never auto-repair the mirror.
		const violations = checkInvariants(mirror)
		if (violations.length) console.warn(`[shadow ${this.roomId}] ${violations.length} invariant violations`)
	}

	metrics(): ShadowMetrics {
		return { ...this.m }
	}
}

// Structural comparison, fully order-independent, naming the first
// difference (or null when equal). Two order dimensions must not register:
// collection/insertion order (handled by comparing per sorted id, not per
// position) and OBJECT KEY order — Loro's tree-node data map does not
// round-trip JS key insertion order, so this must use isDeepStrictEqual,
// never JSON.stringify (a stringify comparator false-positived a divergence
// on every clean multi-key-prop mirror — shadow.test.ts case 5 pins this).
function diverges(mirror: CanvasDocument, source: CanvasDocument): string | null {
	return (
		diffCollection('shape', mirror.shapes, source.shapes) ??
		diffCollection('binding', mirror.bindings, source.bindings) ??
		diffCollection('page', mirror.pages, source.pages)
	)
}

// First difference between two id-keyed record collections, walked in sorted
// id order: a record missing from / extra in the mirror, or the first record
// whose content differs — naming the first differing field so the divergence
// string is actionable (`shape shape:n differs (x: mirror vs source)`), not
// just a count line.
function diffCollection(
	kind: 'shape' | 'binding' | 'page',
	mirror: readonly { id: string }[],
	source: readonly { id: string }[]
): string | null {
	const m = new Map(mirror.map((r) => [r.id, r]))
	const s = new Map(source.map((r) => [r.id, r]))
	const ids = [...new Set([...m.keys(), ...s.keys()])].sort()
	for (const id of ids) {
		const a = m.get(id)
		const b = s.get(id)
		if (!a) return `${kind} ${id} missing from mirror`
		if (!b) return `${kind} ${id} extra in mirror`
		if (isDeepStrictEqual(a, b)) continue
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
		const field = keys.find((k) => !isDeepStrictEqual((a as any)[k], (b as any)[k]))
		return `${kind} ${id} differs${field ? ` (${field}: mirror vs source)` : ''}`
	}
	return null
}
