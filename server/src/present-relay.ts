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

type Log = { presentId: string; truncated: boolean; entries: RelayEntry[]; bytes: number }

export function createPresentRelay(caps?: { maxEvents?: number; maxBytes?: number }): PresentRelay {
	const maxEvents = caps?.maxEvents ?? 5000
	const maxBytes = caps?.maxBytes ?? 5 * 1024 * 1024
	const logs = new Map<string, Log>()
	const key = (roomId: string, shapeId: string) => `${roomId} ${shapeId}`

	return {
		append(roomId, shapeId, presentId, entries) {
			const k = key(roomId, shapeId)
			let log = logs.get(k)
			// A new presentId supersedes the old log wholesale (new presentation).
			if (!log || log.presentId !== presentId) {
				log = { presentId, truncated: false, entries: [], bytes: 0 }
				logs.set(k, log)
			}
			if (log.truncated) return { accepted: false, truncated: true }
			const addedBytes = JSON.stringify(entries).length
			if (log.entries.length + entries.length > maxEvents || log.bytes + addedBytes > maxBytes) {
				log.truncated = true
				return { accepted: false, truncated: true }
			}
			log.entries.push(...entries)
			log.bytes += addedBytes
			return { accepted: true, truncated: false }
		},
		backlog(roomId, shapeId) {
			const log = logs.get(key(roomId, shapeId))
			if (!log) return { presentId: null, truncated: false, entries: [] }
			return { presentId: log.presentId, truncated: log.truncated, entries: log.entries }
		},
		stop(roomId, shapeId, presentId) {
			const k = key(roomId, shapeId)
			const log = logs.get(k)
			if (log && log.presentId === presentId) logs.delete(k)
		},
	}
}
