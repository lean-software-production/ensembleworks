/**
 * Roadmap store — one JSON file per roadmap (DATA_DIR/roadmaps/<room>/<id>.json),
 * following the transcript-store pattern: whole-file read/write, no SQL. The
 * documents are a few KB; however, per-room write serialization is required
 * (single process does not serialize multi-await handlers) — every
 * read-modify-write sequence must run inside the store's own withLock.
 *
 * Also owns the pure document logic shared by every writer: schema validation,
 * the unique-key rule, and the op vocabulary (replace | set | move) that both
 * human canvas edits and the canvas CLI speak. Op batches are applied
 * all-or-nothing by the endpoint: applyOps works on a clone and throws OpError
 * without side effects.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const ROADMAP_ZONES = ['done', 'now', 'next', 'later'] as const
export const ROADMAP_STATUSES = ['planned', 'in-progress', 'done', 'parked'] as const

export interface RoadmapMetric {
	key: string
	text: string
	done: boolean
}
export interface RoadmapFeature {
	key: string
	text: string
	status: string
}
export interface RoadmapInitiative {
	key: string
	title: string
	status: string
	statement?: string
	metrics?: RoadmapMetric[]
	features?: RoadmapFeature[]
}
export interface RoadmapOutcome {
	key: string
	zone: string
	status: string
	title: string
	why?: string
	initiatives?: RoadmapInitiative[]
}
export interface RoadmapDoc {
	meta: { title: string; revision?: string; updated?: string }
	outcomes: RoadmapOutcome[]
}
export interface StoredRoadmap {
	name: string
	rev: number
	updated: string
	data: RoadmapDoc
}

export type RoadmapOp =
	| { op: 'replace'; data: RoadmapDoc }
	| { op: 'set'; key: string; fields: Record<string, unknown> }
	| { op: 'move'; key: string; zone?: string; index?: number }

// Op failures carry the HTTP status the endpoint should answer with:
// 400 for a malformed op or document, 404 for a key that doesn't exist.
export class OpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message)
	}
}

// Returns an error message, or null when the document is valid. Checks the
// wire-format shape (design project roadmap.json schema) and that every key
// is unique across the whole document — keys are the addressing scheme.
export function validateRoadmap(data: unknown): string | null {
	const d = data as RoadmapDoc
	if (!d || typeof d !== 'object') return 'data must be an object'
	if (!d.meta || typeof d.meta.title !== 'string' || !d.meta.title.trim()) {
		return 'meta.title is required'
	}
	if (!Array.isArray(d.outcomes)) return 'outcomes must be an array'

	const seen = new Set<string>()
	const claim = (key: unknown, where: string): string | null => {
		if (typeof key !== 'string' || !key.trim()) return `${where}: key is required`
		if (seen.has(key)) return `duplicate key '${key}'`
		seen.add(key)
		return null
	}
	const badStatus = (s: unknown) =>
		typeof s !== 'string' || !(ROADMAP_STATUSES as readonly string[]).includes(s)

	for (const o of d.outcomes) {
		const err = claim(o?.key, 'outcome')
		if (err) return err
		if (!(ROADMAP_ZONES as readonly string[]).includes(o.zone)) {
			return `outcome ${o.key}: zone must be one of ${ROADMAP_ZONES.join(' | ')}`
		}
		if (badStatus(o.status)) {
			return `outcome ${o.key}: status must be one of ${ROADMAP_STATUSES.join(' | ')}`
		}
		if (typeof o.title !== 'string' || !o.title.trim()) return `outcome ${o.key}: title is required`
		for (const i of o.initiatives ?? []) {
			const ierr = claim(i?.key, `initiative under ${o.key}`)
			if (ierr) return ierr
			if (typeof i.title !== 'string' || !i.title.trim()) {
				return `initiative ${i.key}: title is required`
			}
			if (badStatus(i.status)) {
				return `initiative ${i.key}: status must be one of ${ROADMAP_STATUSES.join(' | ')}`
			}
			for (const m of i.metrics ?? []) {
				const merr = claim(m?.key, `metric under ${i.key}`)
				if (merr) return merr
				if (typeof m.text !== 'string') return `metric ${m.key}: text is required`
				if (typeof m.done !== 'boolean') return `metric ${m.key}: done must be a boolean`
			}
			for (const f of i.features ?? []) {
				const ferr = claim(f?.key, `feature under ${i.key}`)
				if (ferr) return ferr
				if (typeof f.text !== 'string') return `feature ${f.key}: text is required`
				if (badStatus(f.status)) {
					return `feature ${f.key}: status must be one of ${ROADMAP_STATUSES.join(' | ')}`
				}
			}
		}
	}
	return null
}

interface NodeRef {
	kind: 'outcome' | 'initiative' | 'metric' | 'feature'
	node: any
	list: any[] // the array the node lives in
}

function findNode(doc: RoadmapDoc, key: string): NodeRef | null {
	for (const o of doc.outcomes) {
		if (o.key === key) return { kind: 'outcome', node: o, list: doc.outcomes }
		for (const i of o.initiatives ?? []) {
			if (i.key === key) return { kind: 'initiative', node: i, list: o.initiatives! }
			for (const m of i.metrics ?? []) {
				if (m.key === key) return { kind: 'metric', node: m, list: i.metrics! }
			}
			for (const f of i.features ?? []) {
				if (f.key === key) return { kind: 'feature', node: f, list: i.features! }
			}
		}
	}
	return null
}

// Which `set` fields each node kind accepts (the v1 whitelist from the spec).
const SETTABLE: Record<NodeRef['kind'], string[]> = {
	outcome: ['status', 'title', 'why'],
	initiative: ['status', 'title', 'statement'],
	metric: ['done', 'text'],
	feature: ['status', 'text'],
}

// Apply an op batch to a document (null = roadmap doesn't exist yet) and
// return the next document. Pure: works on a clone, throws OpError on the
// first bad op, never mutates the input. Keep the set/move semantics in sync
// with client/src/roadmap/model.ts (applyLocalOp).
export function applyOps(doc: RoadmapDoc | null, ops: RoadmapOp[]): RoadmapDoc {
	if (!Array.isArray(ops) || ops.length === 0) {
		throw new OpError(400, 'ops must be a non-empty array')
	}
	let next: RoadmapDoc | null = doc ? structuredClone(doc) : null

	for (const op of ops) {
		if (!op || typeof op !== 'object') throw new OpError(400, 'each op must be an object')

		if (op.op === 'replace') {
			const err = validateRoadmap(op.data)
			if (err) throw new OpError(400, `invalid roadmap: ${err}`)
			next = structuredClone(op.data)
			continue
		}

		if (!next) {
			throw new OpError(404, 'roadmap not found (the first op on a new roadmap must be replace)')
		}
		if (typeof (op as any).key !== 'string' || !(op as any).key) {
			throw new OpError(400, `${(op as any).op}: key is required`)
		}

		if (op.op === 'set') {
			const ref = findNode(next, op.key)
			if (!ref) throw new OpError(404, `unknown key '${op.key}'`)
			if (!op.fields || typeof op.fields !== 'object' || !Object.keys(op.fields).length) {
				throw new OpError(400, 'set requires a non-empty fields object')
			}
			const allowed = SETTABLE[ref.kind]
			for (const [k, v] of Object.entries(op.fields)) {
				if (!allowed.includes(k)) {
					throw new OpError(400, `cannot set '${k}' on a ${ref.kind} (allowed: ${allowed.join(', ')})`)
				}
				if (k === 'done') {
					if (typeof v !== 'boolean') throw new OpError(400, 'done must be a boolean')
				} else if (k === 'status') {
					if (typeof v !== 'string' || !(ROADMAP_STATUSES as readonly string[]).includes(v)) {
						throw new OpError(400, `status must be one of ${ROADMAP_STATUSES.join(' | ')}`)
					}
				} else if (typeof v !== 'string' || !v.trim()) {
					throw new OpError(400, `${k} must be a non-empty string`)
				}
				ref.node[k] = v
			}
			continue
		}

		if (op.op === 'move') {
			const ref = findNode(next, op.key)
			if (!ref) throw new OpError(404, `unknown key '${op.key}'`)
			if (op.zone !== undefined && ref.kind !== 'outcome') {
				throw new OpError(400, 'zone applies to outcomes only')
			}
			if (op.zone === undefined && op.index === undefined) {
				throw new OpError(400, 'move requires zone and/or index')
			}
			if (op.zone !== undefined && !(ROADMAP_ZONES as readonly string[]).includes(op.zone)) {
				throw new OpError(400, `zone must be one of ${ROADMAP_ZONES.join(' | ')}`)
			}
			if (op.index !== undefined && (!Number.isInteger(op.index) || op.index < 0)) {
				throw new OpError(400, 'index must be a non-negative integer')
			}

			if (ref.kind === 'outcome') {
				// Outcomes live in one flat array; order-within-zone is array order
				// filtered by zone. Remove, retarget the zone, then insert before the
				// index-th member of that zone (or after its last member on append).
				const outcomes = next.outcomes
				outcomes.splice(outcomes.indexOf(ref.node), 1)
				const zone = op.zone ?? ref.node.zone
				ref.node.zone = zone
				const zoneMembers = outcomes.filter((o) => o.zone === zone)
				const at = Math.min(op.index ?? zoneMembers.length, zoneMembers.length)
				const anchor = zoneMembers[at]
				const pos = anchor
					? outcomes.indexOf(anchor)
					: zoneMembers.length
						? outcomes.indexOf(zoneMembers[zoneMembers.length - 1]!) + 1
						: outcomes.length
				outcomes.splice(pos, 0, ref.node)
			} else {
				const list = ref.list
				list.splice(list.indexOf(ref.node), 1)
				list.splice(Math.min(op.index ?? list.length, list.length), 0, ref.node)
			}
			continue
		}

		throw new OpError(400, `unknown op '${(op as any).op}' (expected replace | set | move)`)
	}
	return next!
}

export interface RoadmapStore {
	list(roomId: string): Promise<Array<{ id: string; name: string; rev: number; updated: string }>>
	get(roomId: string, query: string): Promise<({ id: string } & StoredRoadmap) | null>
	write(roomId: string, id: string, stored: StoredRoadmap): Promise<void>
	// Serializes writers per room: any get→applyOps→write sequence must run
	// inside withLock, or concurrent writers read the same rev and the second
	// silently clobbers the first.
	withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T>
}

export function createRoadmapStore(dir: string): RoadmapStore {
	const roomDir = (roomId: string) => path.join(dir, roomId)

	// Promise-chain mutex: each room's write chains onto the previous one.
	// Entries are never evicted — bounded by room count, which is small.
	const locks = new Map<string, Promise<void>>()

	async function readAll(roomId: string): Promise<Array<{ id: string } & StoredRoadmap>> {
		let files: string[]
		try {
			files = await readdir(roomDir(roomId))
		} catch {
			return []
		}
		const out: Array<{ id: string } & StoredRoadmap> = []
		for (const f of files.filter((f) => f.endsWith('.json')).sort()) {
			try {
				const raw = await readFile(path.join(roomDir(roomId), f), 'utf8')
				out.push({ id: f.slice(0, -'.json'.length), ...JSON.parse(raw) })
			} catch {
				// A torn write can leave one bad file; skip it.
			}
		}
		return out
	}

	return {
		async list(roomId) {
			return (await readAll(roomId)).map(({ id, name, rev, updated }) => ({
				id,
				name,
				rev,
				updated,
			}))
		},
		// Exact id first, then the frames-style fuzzy name match (case-insensitive
		// includes, first in id order).
		async get(roomId, query) {
			const all = await readAll(roomId)
			const q = query.toLowerCase()
			return (
				all.find((r) => r.id === q) ??
				all.find((r) => typeof r.name === 'string' && r.name.toLowerCase().includes(q)) ??
				null
			)
		},
		async write(roomId, id, stored) {
			const dir = roomDir(roomId)
			await mkdir(dir, { recursive: true })
			// Write to a .tmp file then atomically rename over the target so a crash
			// mid-write leaves the old file intact rather than torn JSON.
			const target = path.join(dir, `${id}.json`)
			const tmp = path.join(dir, `${id}.json.tmp`)
			await writeFile(tmp, JSON.stringify(stored, null, '\t'))
			await rename(tmp, target)
		},
		async withLock(roomId, fn) {
			const prev = locks.get(roomId) ?? Promise.resolve()
			let release!: () => void
			locks.set(roomId, new Promise<void>((r) => (release = r)))
			await prev
			try {
				return await fn()
			} finally {
				release()
			}
		},
	}
}
