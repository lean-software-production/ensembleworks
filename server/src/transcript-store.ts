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
 * record). Reads do NOT re-parse the whole file: a room's transcript grows for
 * as long as the room lives (ew-lsp-001's team.jsonl reached 27 MB / 99k lines)
 * and agents poll it every couple of seconds. Re-reading and JSON-parsing all
 * of it per poll made sync allocate tens of MB of short-lived garbage per
 * request, faster than Bun's GC reclaimed it, so RSS climbed to the unit's
 * MemoryMax and the kernel OOM-killed sync every ~30 minutes (2026-09-13).
 * Instead each room keeps a small in-memory index (timestamp + byte span per
 * line), extended incrementally from the bytes appended since the last read,
 * and a read fetches only the byte span of the lines it returns.
 */
import { appendFile, type FileHandle, mkdir, open, stat } from 'node:fs/promises'
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

// Per-room line index. `t`/`start`/`end` are parallel arrays, one slot per
// parseable line, in file order; `offset` is how many bytes of the file have
// been indexed (always a line boundary — a torn trailing line waits for its
// newline). A new `ino`, a shrinking size, or a last indexed line that no
// longer reads back detects the file being replaced or rewritten (restore from
// backup), which forces a rebuild.
interface RoomIndex {
	ino: number
	offset: number
	t: number[]
	start: number[]
	end: number[]
}

const NEWLINE = 0x0a
// Bound a single index-extension read so a first read of a huge file doesn't
// allocate it all in one buffer.
const INDEX_CHUNK = 4 * 1024 * 1024

export function createTranscriptStore(dir: string): TranscriptStore {
	let seq = 0
	const fileFor = (roomId: string) => path.join(dir, `${roomId}.jsonl`)
	const indexes = new Map<string, RoomIndex>()
	// Reads of one room are serialised so two concurrent polls can't both extend
	// (and double-append to) the same index.
	const locks = new Map<string, Promise<unknown>>()

	function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
		const next = (locks.get(roomId) ?? Promise.resolve()).then(fn)
		locks.set(roomId, next.catch(() => {}))
		return next
	}

	async function refreshIndex(roomId: string): Promise<RoomIndex | null> {
		const file = fileFor(roomId)
		let info: Awaited<ReturnType<typeof stat>>
		try {
			info = await stat(file)
		} catch {
			indexes.delete(roomId)
			return null
		}
		let index = indexes.get(roomId)
		if (!index || index.ino !== info.ino || info.size < index.offset) {
			index = { ino: info.ino, offset: 0, t: [], start: [], end: [] }
			indexes.set(roomId, index)
		}
		if (index.offset === 0 && info.size === 0) return index

		const handle = await open(file, 'r')
		try {
			// A same-inode rewrite that didn't shrink the file slips past the checks
			// above; if the last indexed line no longer reads back, start over.
			if (index.offset > 0 && !(await lastLineIntact(handle, index))) {
				index = { ino: info.ino, offset: 0, t: [], start: [], end: [] }
				indexes.set(roomId, index)
			}
			let pending = Buffer.alloc(0)
			let pendingStart = index.offset
			let position = index.offset
			while (position < info.size) {
				const chunk = Buffer.alloc(Math.min(INDEX_CHUNK, info.size - position))
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
				if (bytesRead === 0) break
				position += bytesRead
				const buf = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
				let lineStart = 0
				for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, lineStart)) {
					indexLine(index, buf.subarray(lineStart, nl), pendingStart + lineStart, pendingStart + nl)
					lineStart = nl + 1
				}
				// Keep any unterminated tail for the next chunk (or the next read).
				pending = Buffer.from(buf.subarray(lineStart))
				pendingStart += lineStart
				index.offset = pendingStart
			}
		} finally {
			await handle.close()
		}
		return index
	}

	async function lastLineIntact(handle: FileHandle, index: RoomIndex): Promise<boolean> {
		const last = index.t.length - 1
		if (last < 0) return false
		const bytes = Buffer.alloc(index.end[last]! - index.start[last]! + 1)
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, index.start[last]!)
		if (bytesRead !== bytes.length || bytes[bytes.length - 1] !== NEWLINE) return false
		try {
			return (JSON.parse(bytes.toString('utf8')) as { t?: unknown }).t === index.t[last]
		} catch {
			return false
		}
	}

	function indexLine(index: RoomIndex, line: Buffer, start: number, end: number) {
		const text = line.toString('utf8')
		if (!text.trim()) return
		let t: unknown
		try {
			t = (JSON.parse(text) as { t?: unknown }).t
		} catch {
			// A torn write can leave one bad line; skip it.
			return
		}
		if (typeof t !== 'number' || !Number.isFinite(t)) return
		index.t.push(t)
		index.start.push(start)
		index.end.push(end)
	}

	return {
		async append(roomId, entry) {
			await mkdir(dir, { recursive: true })
			const t = entry.t ?? Date.now()
			const full: TranscriptEntry = { ...entry, t, id: `${t}-${seq++}` }
			await appendFile(fileFor(roomId), `${JSON.stringify(full)}\n`)
			return full
		},

		read(roomId, opts = {}) {
			return withRoomLock(roomId, async () => {
				const index = await refreshIndex(roomId)
				if (!index) return []
				const since = opts.since ?? 0
				const matches: number[] = []
				for (let i = 0; i < index.t.length; i++) if (index.t[i]! > since) matches.push(i)
				// limit keeps the most recent N — a poller that fell behind wants the
				// tail, not the stale head.
				const selected = opts.limit && matches.length > opts.limit ? matches.slice(-opts.limit) : matches
				if (!selected.length) return []

				// Read each run of adjacent selected lines as one span. t is
				// caller-supplied, so one early line with a skewed timestamp matches
				// every poll — reading first-to-last would drag in the whole file.
				const entries: TranscriptEntry[] = []
				const handle = await open(fileFor(roomId), 'r')
				try {
					for (let runStart = 0; runStart < selected.length; ) {
						let runEnd = runStart
						while (runEnd + 1 < selected.length && selected[runEnd + 1] === selected[runEnd]! + 1) runEnd++
						const spanStart = index.start[selected[runStart]!]!
						const span = Buffer.alloc(index.end[selected[runEnd]!]! - spanStart)
						await handle.read(span, 0, span.length, spanStart)
						for (let k = runStart; k <= runEnd; k++) {
							const i = selected[k]!
							const line = span.subarray(index.start[i]! - spanStart, index.end[i]! - spanStart).toString('utf8')
							try {
								entries.push(JSON.parse(line) as TranscriptEntry)
							} catch {
								// The file was swapped between indexing and this read; the next
								// read notices and rebuilds.
							}
						}
						runStart = runEnd + 1
					}
				} finally {
					await handle.close()
				}
				return entries
			})
		},
	}
}
