/**
 * Connection-telemetry store — one append-only JSONL per room
 * (<dir>/<roomId>-connection.jsonl), written by the client beacon via
 * POST /api/telemetry/connection. Greppable, crash-safe (one record per line),
 * and size-capped: when a file crosses the cap it rotates to `.1` (one backup)
 * so a long/chatty session can't grow unbounded. No read API — operators read
 * the file. Mirrors transcript-store.ts.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'

export interface ConnectionEvent {
	t: number // ms epoch, server-stamped on append
	roomId: string
	userId: string
	plane: 'livekit' | 'sync' | 'lock'
	event: string
	detail?: unknown
}

const ROTATE_BYTES = 10 * 1024 * 1024 // 10 MB

export interface TelemetryStore {
	append(
		roomId: string,
		event: Omit<ConnectionEvent, 't' | 'roomId'> & { t?: number }
	): Promise<void>
}

export function createTelemetryStore(dir: string, rotateBytes = ROTATE_BYTES): TelemetryStore {
	const fileFor = (roomId: string) => path.join(dir, `${roomId}-connection.jsonl`)
	return {
		async append(roomId, event) {
			await mkdir(dir, { recursive: true })
			const file = fileFor(roomId)
			try {
				if ((await stat(file)).size >= rotateBytes) await rename(file, `${file}.1`)
			} catch {
				/* no file yet — nothing to rotate */
			}
			const full: ConnectionEvent = { ...event, roomId, t: event.t ?? Date.now() }
			await appendFile(file, `${JSON.stringify(full)}\n`)
		},
	}
}
