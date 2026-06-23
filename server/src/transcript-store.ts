/**
 * Transcript store — one append-only JSONL file per room.
 *
 * The transcriber bot posts one entry per spoken utterance; agents poll with
 * `since` (ms epoch) to consume the tail. Entries are stamped server-side
 * with a timestamp and, when the speaker has a canvas tab open, their cursor
 * position and nearest frame — that spatial context is what turns a flat
 * transcript into minutes-with-places and conversation threads.
 *
 * JSONL keeps the store greppable and crash-safe (every line is a complete
 * record); a session's worth of speech is small enough to re-read per poll.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface TranscriptEntry {
	id: string
	t: number // ms epoch, server-stamped on append
	identity: string // LiveKit identity == tldraw presence userId
	name: string
	text: string
	// The page, and the point we located the speaker by, when they spoke (null
	// with no tab open). Since the camera bubble was decoupled from the cursor,
	// the point is their mouse cursor only when it's inside a frame (pointing);
	// otherwise it's their viewport centre (what they're looking at).
	page: string | null
	cursor: { x: number; y: number } | null
	// The frame containing (dist 0) or nearest to that point.
	frame: { name: string; dist: number } | null
}

export interface TranscriptStore {
	append(
		roomId: string,
		entry: Omit<TranscriptEntry, 'id' | 't'> & { t?: number }
	): Promise<TranscriptEntry>
	read(roomId: string, opts?: { since?: number; limit?: number }): Promise<TranscriptEntry[]>
}

export function createTranscriptStore(dir: string): TranscriptStore {
	let seq = 0
	const fileFor = (roomId: string) => path.join(dir, `${roomId}.jsonl`)

	return {
		async append(roomId, entry) {
			await mkdir(dir, { recursive: true })
			const t = entry.t ?? Date.now()
			const full: TranscriptEntry = { ...entry, t, id: `${t}-${seq++}` }
			await appendFile(fileFor(roomId), `${JSON.stringify(full)}\n`)
			return full
		},

		async read(roomId, opts = {}) {
			let raw: string
			try {
				raw = await readFile(fileFor(roomId), 'utf8')
			} catch {
				return []
			}
			const entries: TranscriptEntry[] = []
			for (const line of raw.split('\n')) {
				if (!line.trim()) continue
				try {
					entries.push(JSON.parse(line))
				} catch {
					// A torn write can leave one bad line; skip it.
				}
			}
			const since = opts.since ?? 0
			const filtered = entries.filter((e) => e.t > since)
			// limit keeps the most recent N — a poller that fell behind wants the
			// tail, not the stale head.
			return opts.limit && filtered.length > opts.limit ? filtered.slice(-opts.limit) : filtered
		},
	}
}
