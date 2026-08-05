/**
 * In-memory log of rrweb events for live file-viewer presentations.
 * One log per (roomId, shapeId); presentId (random per presentation)
 * guards against stale streams crossing presentations.
 * A finished presentation's log survives as the frozen last view —
 * retained until replaced by a new presentation or the server restarts.
 * Under total-bytes pressure, least-recently-appended OTHER logs are evicted
 * (LRU), so frozen logs never starve a live presentation.
 * (spec: 2026-07-29-file-viewer-force-follow-design.md)
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
}

type Log = { presentId: string; truncated: boolean; entries: RelayEntry[]; bytes: number; lastAppendAt: number }

export function createPresentRelay(caps?: {
	maxEvents?: number
	maxBytes?: number
	maxTotalBytes?: number
	now?: () => number
}): PresentRelay {
	const maxEvents = caps?.maxEvents ?? 5000
	const maxBytes = caps?.maxBytes ?? 5 * 1024 * 1024
	const maxTotalBytes = caps?.maxTotalBytes ?? 50 * 1024 * 1024
	const now = caps?.now ?? Date.now
	const logs = new Map<string, Log>()
	const key = (roomId: string, shapeId: string) => `${roomId} ${shapeId}`
	let totalBytes = 0

	// Frozen logs (finished presentations kept as the last view) may not starve
	// a live one: under total-bytes pressure, evict least-recently-appended
	// OTHER logs until the incoming batch fits.
	function evictForRoom(selfKey: string, needed: number) {
		while (totalBytes + needed > maxTotalBytes) {
			let oldestKey: string | null = null
			let oldestAt = Infinity
			for (const [k, log] of logs) {
				if (k === selfKey) continue
				if (log.lastAppendAt < oldestAt) {
					oldestAt = log.lastAppendAt
					oldestKey = k
				}
			}
			if (!oldestKey) return
			totalBytes -= logs.get(oldestKey)!.bytes
			logs.delete(oldestKey)
		}
	}

	return {
		append(roomId, shapeId, presentId, entries) {
			const k = key(roomId, shapeId)
			let log = logs.get(k)
			if (!log || log.presentId !== presentId) {
				if (log) totalBytes -= log.bytes
				log = { presentId, truncated: false, entries: [], bytes: 0, lastAppendAt: now() }
				logs.set(k, log)
			}
			log.lastAppendAt = now()
			if (log.truncated) return { accepted: false, truncated: true }
			const addedBytes = JSON.stringify(entries).length
			evictForRoom(k, addedBytes)
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
			const log = logs.get(key(roomId, shapeId))
			if (!log) return { presentId: null, truncated: false, entries: [] }
			return { presentId: log.presentId, truncated: log.truncated, entries: log.entries }
		},
	}
}
