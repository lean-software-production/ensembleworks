/**
 * Client-side stream assembly for rrweb present events (spec:
 * 2026-07-27-file-viewer-rrweb-broadcast-design.md). Ingests ew-rrweb custom
 * messages (App.tsx onCustomMessageReceived) and the HTTP backlog fetch, and
 * hands each subscriber a duplicate-free, seq-ordered stream per shapeId.
 * Live entries arriving before the backlog seed are buffered; a different
 * presentId resets the stream (new presentation).
 */

export type RrwebEntry = { seq: number; event: unknown }

type Meta = { presentId: string; truncated: boolean }
type Sub = (entries: RrwebEntry[], meta: Meta) => void
type Stream = {
	presentId: string | null
	truncated: boolean
	seeded: boolean
	lastDelivered: number
	pending: RrwebEntry[]
	subs: Set<Sub>
}

const streams = new Map<string, Stream>()

function stream(shapeId: string): Stream {
	let s = streams.get(shapeId)
	if (!s) {
		s = { presentId: null, truncated: false, seeded: false, lastDelivered: -1, pending: [], subs: new Set() }
		streams.set(shapeId, s)
	}
	return s
}

function deliver(s: Stream, entries: RrwebEntry[]) {
	// Deduplicate by seq, keeping the first occurrence
	const seenSeqs = new Set<number>()
	const deduped = entries.filter((e) => {
		if (seenSeqs.has(e.seq)) return false
		seenSeqs.add(e.seq)
		return true
	})

	const fresh = deduped.filter((e) => e.seq > s.lastDelivered).sort((x, y) => x.seq - y.seq)
	if (!fresh.length) return
	s.lastDelivered = fresh[fresh.length - 1].seq
	const meta: Meta = { presentId: s.presentId ?? '', truncated: s.truncated }
	for (const sub of s.subs) sub(fresh, meta)
}

function resetIfNewPresentation(s: Stream, presentId: string) {
	if (s.presentId === presentId) return
	s.presentId = presentId
	s.truncated = false
	s.seeded = false
	s.lastDelivered = -1
	s.pending = []
}

export const rrwebFollowStore = {
	ingest(msg: { shapeId: string; presentId: string; truncated?: boolean; entries: RrwebEntry[] }): void {
		const s = stream(msg.shapeId)
		resetIfNewPresentation(s, msg.presentId)
		if (msg.truncated) s.truncated = true

		// Auto-seed if incoming entries contain seq 0 (start of this presentation)
		if (!s.seeded && msg.entries.some((e) => e.seq === 0)) {
			s.seeded = true
			const buffered = s.pending
			s.pending = []
			deliver(s, [...msg.entries, ...buffered])
		} else if (!s.seeded) {
			s.pending.push(...msg.entries)
		} else {
			deliver(s, msg.entries)
		}
	},
	seedBacklog(
		shapeId: string,
		backlog: { presentId: string | null; truncated: boolean; entries: RrwebEntry[] }
	): void {
		if (!backlog.presentId) return
		const s = stream(shapeId)
		resetIfNewPresentation(s, backlog.presentId)
		s.truncated = backlog.truncated
		s.seeded = true
		const buffered = s.pending
		s.pending = []
		deliver(s, [...backlog.entries, ...buffered])
	},
	subscribe(shapeId: string, cb: Sub): () => void {
		const s = stream(shapeId)
		s.subs.add(cb)
		return () => s.subs.delete(cb)
	},
	clear(shapeId: string): void {
		streams.delete(shapeId)
	},
}
