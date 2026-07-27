/**
 * In-memory log of rrweb events for live file-viewer presentations.
 * One log per (roomId, shapeId); presentId (random per presentation)
 * guards against stale streams crossing presentations. Nothing persists —
 * a server restart simply degrades followers to scroll-fraction follow
 * (spec: 2026-07-27-file-viewer-rrweb-broadcast-design.md).
 */

export type RelayEntry = { seq: number; event: unknown }

export interface PresentRelay {
	append(
		roomId: string,
		shapeId: string,
		presentId: string,
		entries: RelayEntry[]
	): { accepted: boolean; truncated: boolean }
	backlog(roomId: string, shapeId: string): { presentId: string | null; truncated: boolean; entries: RelayEntry[] }
	stop(roomId: string, shapeId: string, presentId: string): void
}

type Log = { presentId: string; truncated: boolean; entries: RelayEntry[]; bytes: number; lastAppendAt: number }

export function createPresentRelay(caps?: {
	maxEvents?: number
	maxBytes?: number
	maxTotalBytes?: number
	idleTtlMs?: number
	now?: () => number
}): PresentRelay {
	const maxEvents = caps?.maxEvents ?? 5000
	const maxBytes = caps?.maxBytes ?? 5 * 1024 * 1024
	const maxTotalBytes = caps?.maxTotalBytes ?? 50 * 1024 * 1024
	const idleTtlMs = caps?.idleTtlMs ?? 10 * 60 * 1000
	const now = caps?.now ?? Date.now
	const logs = new Map<string, Log>()
	const key = (roomId: string, shapeId: string) => `${roomId} ${shapeId}`
	let totalBytes = 0

	// Lazy sweep: dropped from the log map (and its bytes un-counted) once idle
	// for idleTtlMs, run at the top of append/backlog rather than on a timer —
	// no relay ever needs a live server to reap memory it isn't using.
	function sweepIdle() {
		const cutoff = now() - idleTtlMs
		for (const [k, log] of logs) {
			if (log.lastAppendAt < cutoff) {
				totalBytes -= log.bytes
				logs.delete(k)
			}
		}
	}

	return {
		append(roomId, shapeId, presentId, entries) {
			sweepIdle()
			const k = key(roomId, shapeId)
			let log = logs.get(k)
			// A new presentId supersedes the old log wholesale (new presentation).
			if (!log || log.presentId !== presentId) {
				if (log) totalBytes -= log.bytes
				log = { presentId, truncated: false, entries: [], bytes: 0, lastAppendAt: now() }
				logs.set(k, log)
			}
			log.lastAppendAt = now()
			if (log.truncated) return { accepted: false, truncated: true }
			const addedBytes = JSON.stringify(entries).length
			if (
				log.entries.length + entries.length > maxEvents ||
				log.bytes + addedBytes > maxBytes ||
				totalBytes + addedBytes > maxTotalBytes
			) {
				log.truncated = true
				return { accepted: false, truncated: true }
			}
			log.entries.push(...entries)
			log.bytes += addedBytes
			totalBytes += addedBytes
			return { accepted: true, truncated: false }
		},
		backlog(roomId, shapeId) {
			sweepIdle()
			const log = logs.get(key(roomId, shapeId))
			if (!log) return { presentId: null, truncated: false, entries: [] }
			return { presentId: log.presentId, truncated: log.truncated, entries: log.entries }
		},
		stop(roomId, shapeId, presentId) {
			const k = key(roomId, shapeId)
			const log = logs.get(k)
			if (log && log.presentId === presentId) {
				totalBytes -= log.bytes
				logs.delete(k)
			}
		},
	}
}
