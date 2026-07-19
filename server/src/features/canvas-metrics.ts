/**
 * Internal ops-facing metrics endpoint (Task D3) — GET /api/canvas/metrics.
 * NOT an agent tool: it is not declared in @ensembleworks/contracts and is
 * deliberately exempt from the /api/tools manifest completeness check (see
 * tools-api.test.ts's EXEMPT predicate). It exists so an operator (or the
 * eventual soak/alerting rig) can curl one JSON envelope for Phase 2's
 * pre-cutover telemetry: the shadow-mirror divergence counters (Task D2) and
 * the canvas-v2 sync health counters (Task B4/C2), plus taint-eviction
 * history that would otherwise vanish the instant a fresh actor replaces a
 * tainted one, plus (Task H4) each canvas-v2 room's live diskBytes/
 * snapshotBytes — S6 dogfood visibility, so the same disk÷snapshot
 * high-water signal soak-actor.ts's DISK_SUSTAINED_HIGHWATER_MULTIPLIER
 * judges in the soak is decidable on real dogfood traffic too (Task I1).
 *
 * Mounted UNCONDITIONALLY in app.ts, regardless of EW_CANVAS_SHADOW or
 * EW_CANVAS_SYNC — readable even with both flags off, returning empty
 * `shadow`/`sync`/`evictions` sections (and `sweepErrors: 0`) rather than
 * 404ing, so a curl against a flags-off deployment gets a clean envelope
 * instead of having to guess whether the route exists.
 */
import express from 'express'
import type { CanvasActors, EvictionRecord } from '../canvas-v2/actors.ts'
import type { ShadowMirror } from '../canvas-v2/shadow.ts'

export interface CanvasMetricsDeps {
	/** Task D3's shadow driver's live mirror map — null when EW_CANVAS_SHADOW
	 * was not set at createSyncApp construction time. */
	shadowMirrors: Map<string, { mirror: ShadowMirror; lastClock: number }> | null
	/** Task C3's canvas-v2 actor registry — null when EW_CANVAS_SYNC was not
	 * set at createSyncApp construction time. */
	canvasActors: CanvasActors | null
	/** Cumulative count of shadow-driver sweep bodies that threw (all rooms,
	 * all sweeps) — a getter because the counter is a closure variable inside
	 * createSyncApp. Top-level in the payload rather than inside any room's
	 * ShadowMetrics: the dominant throw site is the per-room clock read, which
	 * can fire BEFORE that room's mirror (and hence its ShadowMetrics) exists.
	 * Always 0 when EW_CANVAS_SHADOW is off — the driver never runs. */
	sweepErrors: () => number
}

export function createCanvasMetricsRouter(deps: CanvasMetricsDeps): express.Router {
	const router = express.Router()

	router.get('/api/canvas/metrics', (_req, res) => {
		const shadow: Record<string, ReturnType<ShadowMirror['metrics']>> = {}
		if (deps.shadowMirrors) {
			for (const [roomId, entry] of deps.shadowMirrors) shadow[roomId] = entry.mirror.metrics()
		}

		const sync: Record<
			string,
			{
				pendingImports: number
				malformedFrames: number
				tainted: string | null
				/** Task H4 (S6 dogfood visibility): live on-disk SQLite file size for
				 * this room — a high-water mark, see CanvasV2Store.diskBytes()'s doc
				 * comment. Additive: existing pendingImports/malformedFrames/tainted
				 * consumers are unaffected by these two new fields. */
				diskBytes: number
				/** Live in-memory snapshot size for this room, in bytes — the SAME
				 * export DocumentActor.compact() persists, so diskBytes÷snapshotBytes
				 * is the disk÷snapshot high-water ratio the DevOverlay renders,
				 * mirroring soak-actor.ts's DISK_SUSTAINED_HIGHWATER_MULTIPLIER. */
				snapshotBytes: number
			}
		> = {}
		// Declared as the registry's own EvictionRecord type (not a hand-copied
		// inline shape) so the payload's declared type can never silently drift
		// from what the runtime spread below actually serves — the F1 spec
		// review caught exactly that drift once. Alarm guidance: key on
		// `taintCount > 0` / `lastTaintReason` — the taint pair is STICKY
		// (never overwritten by an idle eviction; see EvictionRecord's doc
		// comment in ../canvas-v2/actors.ts), so routine idle churn cannot
		// noise-trip a taint alarm.
		const evictions: Record<string, EvictionRecord> = {}
		if (deps.canvasActors) {
			for (const [roomId, actor] of deps.canvasActors.entries()) {
				sync[roomId] = {
					pendingImports: actor.peer.pendingImports,
					malformedFrames: actor.peer.malformedFrames,
					tainted: actor.tainted ? actor.tainted.message : null,
					diskBytes: actor.diskBytes,
					snapshotBytes: actor.snapshotBytes,
				}
			}
			for (const [roomId, record] of deps.canvasActors.evictions()) {
				evictions[roomId] = { ...record }
			}
		}

		res.json({ ok: true, shadow, sync, evictions, sweepErrors: deps.sweepErrors() })
	})

	return router
}
