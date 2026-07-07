/**
 * Telemetry feature — POST /api/telemetry/connection. The client beacon posts a
 * batch of connection-lifecycle events (LiveKit + tldraw sync); we validate each,
 * append to the per-room JSONL store, and emit one journal line per batch so
 * `journalctl -u ensembleworks-sync` can cross-reference client-perceived drops
 * against server-side session churn. Write-only: no GET (operators read the file).
 */
import express from 'express'
import { sanitizeId } from '../canvas/ids.ts'
import type { PluginServerContext } from '../kernel/context.ts'

const MAX_BATCH = 100
const MAX_DETAIL_CHARS = 2000

function cleanDetail(detail: unknown): unknown {
	if (detail === undefined || detail === null) return undefined
	try {
		const s = JSON.stringify(detail)
		return s.length > MAX_DETAIL_CHARS ? { truncated: s.slice(0, MAX_DETAIL_CHARS) } : detail
	} catch {
		return undefined
	}
}

export function createTelemetryRouter(ctx: PluginServerContext): express.Router {
	const router = express.Router()

	router.post('/api/telemetry/connection', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const events = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : []
		if (events.length === 0) return void res.status(400).json({ error: 'events[] required' })

		let written = 0
		const rooms = new Set<string>()
		for (const raw of events) {
			const e = (raw ?? {}) as Record<string, unknown>
			const roomId = sanitizeId(String(e.roomId ?? ''))
			const plane = e.plane === 'livekit' || e.plane === 'sync' ? e.plane : null
			const event = typeof e.event === 'string' ? e.event.slice(0, 64) : ''
			const userId = typeof e.userId === 'string' ? e.userId.slice(0, 128) : ''
			if (!roomId || !plane || !event) continue
			const t = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : undefined
			await ctx.storage.telemetry.append(roomId, { userId, plane, event, detail: cleanDetail(e.detail), t })
			written++
			rooms.add(roomId)
		}
		console.log(`[telemetry] ${written} connection event(s), room(s): ${[...rooms].join(',') || '-'}`)
		res.json({ ok: true, written })
	})

	return router
}
