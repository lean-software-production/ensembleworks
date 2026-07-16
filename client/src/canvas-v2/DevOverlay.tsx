/**
 * canvas-v2 dogfood dev overlay (Task G5) — surfaces the Phase-2 anomalies
 * that were deferred-again rather than fixed, so a REAL occurrence in a
 * dogfood room is at least VISIBLE (Open Q8/Q9/Q11 in the phase-3 plan):
 * pendingImports/malformedFrames/tainted + eviction taintCount/idleCount
 * (scraped from the server's `/api/canvas/metrics`, filtered to THIS room),
 * plus this client peer's OWN repairCount/lastBackfillBytes (canvas-sync's
 * SyncClientPeer, Task G5's small accessor additions) and a best-effort
 * connection-state label.
 *
 * GATING: v2-only by construction (only ever mounted from CanvasV2App.tsx,
 * itself reachable only through the selectEngine guard — Task G6's exposure
 * audit pins that). WITHIN that mount, still gated a second time —
 * `import.meta.env.DEV` (a local/dev server build) OR an explicit
 * `?devOverlay=1` URL param (so a real dogfood deployment, which builds in
 * PRODUCTION mode, can still opt a specific session into the telemetry
 * on demand — e.g. debugging a live report) — see `shouldShowDevOverlay`
 * (pure, testable) / `shouldShowDevOverlayFromEnvironment` (the real-env
 * wrapper), the SAME injectable-opts pattern engine.ts's `selectEngine`/
 * `selectEngineFromEnvironment` establishes for exactly this reason.
 *
 * CONNECTION STATE, HONESTLY (v1 gap, not hidden): `SyncClientPeer`/
 * `wsClientTransport` do not currently distinguish "the underlying socket
 * dropped" from "still open" — `client-peer.ts`'s `wireTransport` wires
 * `t.onClose(() => {})`, a genuine no-op. So this overlay's `connectionState`
 * prop can only ever honestly report THIS MOUNT's own lifecycle
 * ('connecting' before the boot sequence resolves a session, 'connected'
 * once it has one) — never a real "the socket silently died and we haven't
 * noticed yet" state. Surfacing that would need canvas-sync work (wiring a
 * real onClose), out of this task's scope.
 */
import { useEffect, useState, type CSSProperties } from 'react'

export interface CanvasMetricsSyncEntry {
	readonly pendingImports: number
	readonly malformedFrames: number
	readonly tainted: string | null
	/** Task H4 (S6 dogfood visibility): live on-disk SQLite file size for this
	 * room, in bytes — a HIGH-WATER MARK (the store never VACUUMs). Optional:
	 * absent on a payload served by a server build that predates Task H4 (a
	 * rolling deploy can briefly mix client/server versions), in which case
	 * the overlay falls back to the same '—' placeholder as a null `metrics`
	 * prop. */
	readonly diskBytes?: number
	/** Live in-memory snapshot size for this room, in bytes — the same
	 * `exportSnapshot()` byte length DocumentActor.compact() persists, so
	 * diskBytes÷snapshotBytes is the disk÷snapshot high-water ratio. Same
	 * optionality caveat as diskBytes above. */
	readonly snapshotBytes?: number
}
export interface CanvasMetricsEviction {
	readonly taintCount: number
	readonly idleCount: number
	readonly lastTaintReason: string | null
	readonly lastIdleReason: string | null
}
/** The slice of GET /api/canvas/metrics' payload (server/src/features/
 * canvas-metrics.ts) this overlay reads — `shadow`/`sweepErrors` exist on the
 * real payload too but are Task D2/shadow-mirror concerns, out of scope here. */
export interface CanvasMetricsPayload {
	readonly ok: boolean
	readonly sync: Readonly<Record<string, CanvasMetricsSyncEntry>>
	readonly evictions: Readonly<Record<string, CanvasMetricsEviction>>
}

export interface ClientTelemetry {
	readonly repairCount: number
	readonly lastBackfillBytes: number
}

export type ConnectionState = 'connecting' | 'connected'

export interface DevOverlayProps {
	readonly roomId: string
	readonly connectionState: ConnectionState
	readonly client: ClientTelemetry
	/** `null` while the first scrape hasn't resolved yet, or the fetch failed
	 * (see useCanvasMetrics — a fetch error is swallowed, not thrown, so a
	 * metrics-endpoint hiccup never breaks the canvas it's merely reporting
	 * on). Every metrics field renders an explicit "—" placeholder in that
	 * case rather than a misleading 0. */
	readonly metrics: CanvasMetricsPayload | null
}

const fieldStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const fieldWarnStyle: CSSProperties = { ...fieldStyle, color: '#fca5a5', fontWeight: 700 }

function Field({ label, value, warn }: { readonly label: string; readonly value: string | number; readonly warn?: boolean }) {
	return (
		<div data-dev-overlay-field={label} data-dev-overlay-warn={warn ? 'true' : undefined} style={warn ? fieldWarnStyle : fieldStyle}>
			<span>{label}</span>
			<span>{value}</span>
		</div>
	)
}

/** S6 DECISION THRESHOLD — mirrors `DISK_SUSTAINED_HIGHWATER_MULTIPLIER` in
 * `server/src/canvas-v2/soak-actor.ts` (the soak's own S6 disk-high-water
 * verdict, task I1 cites both). The client can't import the server
 * workspace, so this is a deliberate DUPLICATE, not a re-export — keep this
 * number in sync with that one by hand if it ever changes; both sides are
 * cross-referenced in their doc comments for exactly that reason. Same 10x
 * value: comfortably above every measured soak run's last-quartile ratio
 * while still catching the "VACUUM is needed" signal the S6 ruling watches
 * for. A brand-new/near-empty room's ratio starts elevated too (SQLite
 * allocates a full page, ~4KB, before a snapshot's CRDT metadata reaches
 * that size) and settles down as real content accumulates — the same
 * floor-effect soak-actor.ts's AVG_MIN_DISK_BYTES documents, not a bug here. */
export const DISK_SUSTAINED_HIGHWATER_MULTIPLIER = 10

/** Human-readable byte size (B/KB/MB) for the diskBytes Field. */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Pure render — fixture-testable via renderToStaticMarkup (this house's
 * usual component-test rig, no DOM emulator required). */
export function DevOverlay({ roomId, connectionState, client, metrics }: DevOverlayProps) {
	const sync = metrics?.sync[roomId]
	const eviction = metrics?.evictions[roomId]
	// Task H4 (S6 dogfood visibility): diskBytes/snapshotBytes are optional
	// even on a live sync entry (see CanvasMetricsSyncEntry's doc comment), so
	// this guards both "no sync entry at all" (metrics null / room absent)
	// and "sync entry present but from an older server build."
	const diskBytes = sync?.diskBytes
	const snapshotBytes = sync?.snapshotBytes
	const diskRatio = diskBytes !== undefined && snapshotBytes !== undefined && snapshotBytes > 0 ? diskBytes / snapshotBytes : undefined
	return (
		<div
			data-canvas-v2-dev-overlay
			style={{
				position: 'fixed',
				right: 8,
				bottom: 8,
				zIndex: 9999,
				minWidth: 220,
				padding: '8px 10px',
				borderRadius: 6,
				background: 'rgba(15,23,42,0.88)',
				color: '#e2e8f0',
				fontFamily: 'ui-monospace, monospace',
				fontSize: 11,
				lineHeight: 1.5,
				pointerEvents: 'none',
			}}
		>
			<div style={{ fontWeight: 600, marginBottom: 4 }}>canvas-v2 · {roomId}</div>
			<Field label="connection" value={connectionState} />
			<Field label="repairCount" value={client.repairCount} />
			<Field label="lastBackfillBytes" value={client.lastBackfillBytes} />
			<Field label="pendingImports" value={sync ? sync.pendingImports : '—'} />
			<Field label="malformedFrames" value={sync ? sync.malformedFrames : '—'} />
			<Field label="tainted" value={sync ? (sync.tainted ?? 'no') : '—'} />
			<Field label="evictions.taintCount" value={eviction ? eviction.taintCount : '—'} />
			<Field label="evictions.idleCount" value={eviction ? eviction.idleCount : '—'} />
			<Field label="diskBytes" value={diskBytes !== undefined ? formatBytes(diskBytes) : '—'} />
			<Field
				label="disk:snapshot"
				value={diskRatio !== undefined ? `${diskRatio.toFixed(1)}x` : '—'}
				warn={diskRatio !== undefined && diskRatio >= DISK_SUSTAINED_HIGHWATER_MULTIPLIER}
			/>
		</div>
	)
}

export interface ShouldShowDevOverlayOpts {
	/** `import.meta.env.DEV` in production; injected here so the decision is
	 * a pure function of its inputs (same seam engine.ts's selectEngine
	 * establishes). */
	readonly dev: boolean
	/** The `?devOverlay=` URL param's value, or `null` if absent/different.
	 * Only the exact string `'1'` has any effect. */
	readonly devOverlayParam: string | null
}

/** Pure. `true` iff this is a dev build OR the URL explicitly opted in — see
 * the module header's GATING section. */
export function shouldShowDevOverlay(opts: ShouldShowDevOverlayOpts): boolean {
	return opts.dev || opts.devOverlayParam === '1'
}

/** Production wrapper: reads the real build-time env flag and the real URL's
 * `?devOverlay=` param, then delegates to the pure `shouldShowDevOverlay`. */
export function shouldShowDevOverlayFromEnvironment(): boolean {
	const devOverlayParam = new URLSearchParams(location.search).get('devOverlay')
	return shouldShowDevOverlay({ dev: Boolean(import.meta.env.DEV), devOverlayParam })
}

/** Polls GET /api/canvas/metrics every `intervalMs` (default 5000, per the
 * plan's "poll ~5s" spec) and returns the most recent successfully-parsed
 * payload (`null` before the first successful scrape). Cleans up its
 * interval on unmount. Any failure — a rejected fetch, a non-ok HTTP
 * status, a JSON parse throw — is caught and warned, NEVER thrown: this
 * overlay reports on the system, it must never be a NEW way for the system
 * to break (same "never surface as a crash" posture the six custom shapes'
 * own error boundaries take).
 *
 * WARN DEDUPE (once per failure-state CHANGE, not per poll — decided here,
 * quality-review fix round): a persistently-down metrics endpoint polled
 * every 5s would otherwise emit an identical console.warn 12x/minute for
 * as long as the overlay is open — a console flood that buries the real
 * signal (the STATE TRANSITION into failure). So each failure carries a
 * signature ('http <status>' or 'fetch-rejected'), warned only when it
 * DIFFERS from the previous scrape's outcome; a success resets the
 * signature so a later relapse warns again. A 500->404 change warns (a
 * different failure IS new information); 500->500 stays silent.
 *
 * `fetchImpl`/`intervalMs` are injectable test seams (production omits
 * both — see DevOverlay.test.ts's hook cases). */
export function useCanvasMetrics(enabled = true, intervalMs = 5000, fetchImpl: typeof fetch = fetch): CanvasMetricsPayload | null {
	const [metrics, setMetrics] = useState<CanvasMetricsPayload | null>(null)
	useEffect(() => {
		if (!enabled) return // the overlay isn't shown (shouldShowDevOverlay false) — never scrape for nothing
		let cancelled = false
		let lastFailure: string | null = null // the WARN DEDUPE signature — see the doc comment
		function warnOnce(signature: string, detail: unknown): void {
			if (signature === lastFailure) return
			lastFailure = signature
			console.warn('[canvas-v2] dev overlay metrics scrape failed:', detail)
		}
		async function scrape() {
			try {
				const res = await fetchImpl('/api/canvas/metrics')
				if (!res.ok) {
					warnOnce(`http ${res.status}`, `HTTP ${res.status}`)
					return
				}
				const payload = (await res.json()) as CanvasMetricsPayload
				lastFailure = null // success: a later relapse into failure warns again
				if (!cancelled) setMetrics(payload)
			} catch (err) {
				warnOnce('fetch-rejected', err)
			}
		}
		scrape()
		const id = setInterval(scrape, intervalMs)
		return () => {
			cancelled = true
			clearInterval(id)
		}
	}, [enabled, intervalMs, fetchImpl])
	return metrics
}
