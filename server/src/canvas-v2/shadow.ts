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
import { LoroCanvasDoc, dumpModel } from '@ensembleworks/canvas-doc'
import { checkInvariants, type CanvasDocument } from '@ensembleworks/canvas-model'
import { fromTldraw } from './convert.ts'
import { reconcile } from './reconcile.ts'

export interface ShadowMetrics {
	ticks: number
	puts: number
	deletes: number
	divergences: number
	lastDivergence: string | null
	shapeCount: number
	snapshotBytes: number
	/** Ticks whose body threw (getRecords, fromTldraw, or reconcile). Counted, never propagated. */
	tickErrors: number
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
			const { puts, deletes } = reconcile(this.doc, target)
			this.m.puts += puts
			this.m.deletes += deletes
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

// Structural comparison ignoring order; returns the first (well, a summary)
// difference string or null. Normalizes by sorting shapes/bindings/pages by
// id before a deep JSON comparison, so insertion-order differences between
// the mirror and a freshly-converted target never register as a divergence.
function diverges(a: CanvasDocument, b: CanvasDocument): string | null {
	const norm = (d: CanvasDocument) => ({
		shapes: [...d.shapes].sort((x, y) => x.id.localeCompare(y.id)).map((s) => ({ ...s })),
		bindings: [...d.bindings].sort((x, y) => x.id.localeCompare(y.id)),
		pages: [...d.pages].sort((x, y) => x.id.localeCompare(y.id)),
	})
	const na = JSON.stringify(norm(a))
	const nb = JSON.stringify(norm(b))
	return na === nb ? null : `mirror(${a.shapes.length} shapes) != source(${b.shapes.length} shapes)`
}
