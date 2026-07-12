/**
 * Internal ops-facing metrics endpoint (Task D3) — GET /api/canvas/metrics.
 * NOT an agent tool: it is not declared in @ensembleworks/contracts and is
 * deliberately exempt from the /api/tools manifest completeness check (see
 * tools-api.test.ts's EXEMPT predicate). It exists so an operator (or the
 * eventual soak/alerting rig) can curl one JSON envelope for Phase 2's
 * pre-cutover telemetry: the shadow-mirror divergence counters (Task D2) and
 * the canvas-v2 sync health counters (Task B4/C2), plus taint-eviction
 * history that would otherwise vanish the instant a fresh actor replaces a
 * tainted one.
 *
 * Mounted UNCONDITIONALLY in app.ts, regardless of EW_CANVAS_SHADOW or
 * EW_CANVAS_SYNC — readable even with both flags off, returning empty
 * `shadow`/`sync`/`evictions` sections (and `sweepErrors: 0`) rather than
 * 404ing, so a curl against a flags-off deployment gets a clean envelope
 * instead of having to guess whether the route exists.
 */
import express from 'express'
import type { CanvasActors } from '../canvas-v2/actors.ts'
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

		const sync: Record<string, { pendingImports: number; malformedFrames: number; tainted: string | null }> = {}
		const evictions: Record<string, { count: number; lastReason: string }> = {}
		if (deps.canvasActors) {
			for (const [roomId, actor] of deps.canvasActors.entries()) {
				sync[roomId] = {
					pendingImports: actor.peer.pendingImports,
					malformedFrames: actor.peer.malformedFrames,
					tainted: actor.tainted ? actor.tainted.message : null,
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
