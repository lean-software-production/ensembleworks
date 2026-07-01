# Roadmap Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A native `roadmap` tldraw shape (zoned outcome board, two-way editable) backed by a server-side JSON-file store, plus `canvas roadmap list|read|push|ops` CLI subcommands.

**Architecture:** Roadmap JSON lives in `DATA_DIR/roadmaps/<room>/<id>.json` (transcript-store pattern) with a monotonic `rev`. One `POST /api/roadmap` endpoint applies atomic op batches (`replace | set | move`) for both human canvas edits and the CLI; after every write the server stamps the new `rev` onto matching roadmap shapes via `updateStore`, so tldraw sync broadcasts "changed" and clients refetch over HTTP. The shape component is a React port of the `Roadmap.dc.html` design component.

**Tech Stack:** TypeScript, Express 5, tldraw v5 (`BaseBoxShapeUtil`), React 19, bash + curl. Tests: self-executing `npx tsx src/*.test.ts` scripts with `node:assert/strict` (house style, see `server/src/canvas-api.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-01-roadmap-control-design.md`
**Branch:** work on the existing `feat/roadmap-control` branch. Repo root: `/home/mrdavidlaing/Work/ensembleworks`.

## File structure

| File | Responsibility |
|---|---|
| `server/src/roadmap-store.ts` (create) | Types, `slugify`, `validateRoadmap`, `applyOps` (pure), `OpError`, `createRoadmapStore` (JSON files) |
| `server/src/roadmap-fixture.ts` (create) | Shared test fixture (trimmed design-project sample) |
| `server/src/roadmap-store.test.ts` (create) | Unit tests for the pure logic + file store |
| `server/src/schema.ts` (modify) | Register the `roadmap` shape props server-side |
| `server/src/app.ts` (modify) | `GET/POST /api/roadmap` + rev fan-out |
| `server/src/roadmap-api.test.ts` (create) | In-process HTTP contract tests |
| `client/src/roadmap/model.ts` (create) | Client-pure model: types, glyph/chip/cycle, `applyLocalOp`, `slugify` |
| `client/src/roadmap/model.test.ts` (create) | Unit tests for the client model |
| `client/src/roadmap/roadmap.css` (create) | Scoped design tokens + repeated typography classes |
| `client/src/roadmap/RoadmapShapeUtil.tsx` (create) | Shape util + component (port of Roadmap.dc.html) |
| `client/src/App.tsx` (modify) | Register `RoadmapShapeUtil` |
| `client/src/ui.tsx` (modify) | Toolbar "New roadmap" button |
| `client/index.html` (modify) | Load the Source Serif 4 webfont |
| `bin/canvas` (modify) | `roadmap` subcommand family |
| `.claude/skills/canvas/SKILL.md`, `deploy/agent-home/AGENTS.md` (modify) | Agent docs |

---

### Task 1: Pure roadmap document logic (`slugify`, `validateRoadmap`, `applyOps`)

**Files:**
- Create: `server/src/roadmap-store.ts`
- Create: `server/src/roadmap-fixture.ts`
- Create: `server/src/roadmap-store.test.ts`

- [ ] **Step 1: Create the fixture**

Create `server/src/roadmap-fixture.ts`:

```ts
// A trimmed copy of the design project's roadmap.json sample — enough
// structure to exercise every op: three zones populated, nested initiatives,
// metrics and features. Shared by roadmap-store.test.ts and roadmap-api.test.ts.
import type { RoadmapDoc } from './roadmap-store.ts'

export const ROADMAP_FIXTURE: RoadmapDoc = {
	meta: { title: 'Product Roadmap', revision: 'rev 01', updated: '2026-07-01' },
	outcomes: [
		{
			key: 'O1',
			zone: 'done',
			status: 'done',
			title: 'Reliable Nightly Sync',
			why: 'Stale source data means every report is second-guessed.',
			initiatives: [
				{
					key: 'O1.I1',
					title: 'Ingest one source end-to-end',
					status: 'done',
					statement: 'FOR: analysts. OUTCOME: data present at 09:00 untouched.',
					metrics: [
						{ key: 'O1.I1.M1', text: 'Sync completes by 09:00 unattended', done: true },
						{ key: 'O1.I1.M2', text: 'Failed runs alert within 15 minutes', done: true },
					],
					features: [
						{ key: 'O1.I1.F1', text: 'Connector framework + registry', status: 'done' },
						{ key: 'O1.I1.F2', text: 'Retry + checkpoint resume', status: 'done' },
					],
				},
			],
		},
		{
			key: 'O3',
			zone: 'now',
			status: 'in-progress',
			title: 'Broad Source Coverage',
			why: 'One connector covers a fraction of the estate.',
			initiatives: [
				{
					key: 'O3.I1',
					title: 'Abstract the connector layer',
					status: 'in-progress',
					statement: 'FOR: platform team. OUTCOME: a new source is a config entry.',
					metrics: [{ key: 'O3.I1.M1', text: 'Two source categories working', done: true }],
					features: [
						{ key: 'O3.I1.F1', text: 'Connector SDK', status: 'in-progress' },
						{ key: 'O3.I1.F2', text: 'Schema-mapping assistant', status: 'in-progress' },
					],
				},
			],
		},
		{
			key: 'O4',
			zone: 'next',
			status: 'planned',
			title: 'Self-Serve Onboarding',
			why: 'Setup time is measured in days, not minutes.',
			initiatives: [],
		},
	],
}
```

- [ ] **Step 2: Write the failing test**

Create `server/src/roadmap-store.test.ts`:

```ts
// Unit tests for the pure roadmap document logic and the JSON-file store.
// Run with: npx tsx src/roadmap-store.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ROADMAP_FIXTURE } from './roadmap-fixture.ts'
import {
	OpError,
	applyOps,
	createRoadmapStore,
	slugify,
	validateRoadmap,
} from './roadmap-store.ts'

function expectOpError(fn: () => void, status: number, label: string) {
	try {
		fn()
		assert.fail(`${label}: expected an OpError`)
	} catch (err) {
		// tsc doesn't narrow `err` through assert.ok, so cast after checking.
		assert.ok(err instanceof OpError, `${label}: throws OpError, got ${err}`)
		assert.equal((err as OpError).status, status, `${label}: status`)
	}
}

async function main() {
	// --- slugify ---------------------------------------------------------------
	assert.equal(slugify('EnsembleWorks Roadmap'), 'ensembleworks-roadmap')
	assert.equal(slugify('Roadmap'), 'roadmap')
	assert.equal(slugify('  ---  '), null, 'slug with no alphanumerics is invalid')
	console.log('ok: slugify')

	// --- validateRoadmap --------------------------------------------------------
	assert.equal(validateRoadmap(ROADMAP_FIXTURE), null, 'fixture is valid')
	assert.match(String(validateRoadmap({})), /meta\.title/, 'missing title rejected')
	{
		const dup = structuredClone(ROADMAP_FIXTURE)
		dup.outcomes[1]!.key = 'O1'
		assert.match(String(validateRoadmap(dup)), /duplicate key 'O1'/)
	}
	{
		const badZone = structuredClone(ROADMAP_FIXTURE)
		badZone.outcomes[0]!.zone = 'someday'
		assert.match(String(validateRoadmap(badZone)), /zone/)
	}
	{
		const badDone = structuredClone(ROADMAP_FIXTURE)
		;(badDone.outcomes[0]!.initiatives![0]!.metrics![0] as any).done = 'yes'
		assert.match(String(validateRoadmap(badDone)), /done must be a boolean/)
	}
	console.log('ok: validateRoadmap accepts the fixture, rejects bad docs')

	// --- applyOps: replace -------------------------------------------------------
	{
		const doc = applyOps(null, [{ op: 'replace', data: ROADMAP_FIXTURE }])
		assert.equal(doc.outcomes.length, 3)
		expectOpError(
			() => applyOps(null, [{ op: 'replace', data: { meta: {} } as any }]),
			400,
			'invalid replace data'
		)
		expectOpError(
			() => applyOps(null, [{ op: 'set', key: 'O1', fields: { status: 'done' } }]),
			404,
			'non-replace first op on a missing roadmap'
		)
		expectOpError(() => applyOps(ROADMAP_FIXTURE, []), 400, 'empty ops batch')
	}
	console.log('ok: applyOps replace')

	// --- applyOps: set ----------------------------------------------------------
	{
		const doc = applyOps(ROADMAP_FIXTURE, [
			{ op: 'set', key: 'O3.I1.F1', fields: { status: 'done' } },
			{ op: 'set', key: 'O3.I1.M1', fields: { done: false } },
			{ op: 'set', key: 'O4', fields: { title: 'Self-Serve Setup', why: 'New why.' } },
		])
		assert.equal(doc.outcomes[1]!.initiatives![0]!.features![0]!.status, 'done')
		assert.equal(doc.outcomes[1]!.initiatives![0]!.metrics![0]!.done, false)
		assert.equal(doc.outcomes[2]!.title, 'Self-Serve Setup')
		// The input document is never mutated (endpoint atomicity depends on it).
		assert.equal(ROADMAP_FIXTURE.outcomes[1]!.initiatives![0]!.features![0]!.status, 'in-progress')

		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'set', key: 'NOPE', fields: { status: 'done' } }]),
			404,
			'unknown key'
		)
		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'set', key: 'O1.I1.M1', fields: { status: 'done' } }]),
			400,
			'status is not settable on a metric'
		)
		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'set', key: 'O1', fields: { status: 'bogus' } }]),
			400,
			'invalid status value'
		)
	}
	console.log('ok: applyOps set (whitelist, clone, unknown key)')

	// --- applyOps: move ----------------------------------------------------------
	{
		// Outcome across zones, appended (no index).
		const moved = applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O4', zone: 'now' }])
		assert.equal(moved.outcomes.find((o) => o.key === 'O4')!.zone, 'now')
		const nowKeys = moved.outcomes.filter((o) => o.zone === 'now').map((o) => o.key)
		assert.deepEqual(nowKeys, ['O3', 'O4'], 'append lands after existing zone members')

		// Outcome to a specific index within its zone.
		const first = applyOps(moved, [{ op: 'move', key: 'O4', index: 0 }])
		assert.deepEqual(
			first.outcomes.filter((o) => o.zone === 'now').map((o) => o.key),
			['O4', 'O3']
		)

		// Feature reorder within its parent list.
		const feat = applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O3.I1.F2', index: 0 }])
		assert.deepEqual(
			feat.outcomes[1]!.initiatives![0]!.features!.map((f) => f.key),
			['O3.I1.F2', 'O3.I1.F1']
		)

		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O3.I1.F1', zone: 'done' }]),
			400,
			'zone applies to outcomes only'
		)
		expectOpError(() => applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O1' }]), 400, 'move needs zone or index')
		expectOpError(
			() => applyOps(ROADMAP_FIXTURE, [{ op: 'move', key: 'O1', zone: 'someday' }]),
			400,
			'bad zone'
		)
	}
	console.log('ok: applyOps move (zones, index, nested lists)')

	// --- file store ---------------------------------------------------------------
	{
		const dir = await mkdtemp(path.join(os.tmpdir(), 'roadmap-store-test-'))
		const store = createRoadmapStore(dir)
		assert.deepEqual(await store.list('team'), [], 'empty room lists nothing')
		assert.equal(await store.get('team', 'roadmap'), null)

		await store.write('team', 'product-roadmap', {
			name: 'Product Roadmap',
			rev: 1,
			updated: '2026-07-01',
			data: ROADMAP_FIXTURE,
		})
		const listed = await store.list('team')
		assert.deepEqual(listed, [
			{ id: 'product-roadmap', name: 'Product Roadmap', rev: 1, updated: '2026-07-01' },
		])
		const byFuzzy = await store.get('team', 'product')
		assert.equal(byFuzzy?.id, 'product-roadmap', 'fuzzy name match')
		const byId = await store.get('team', 'product-roadmap')
		assert.equal(byId?.rev, 1, 'exact id match')
		assert.equal(byId?.data.outcomes.length, 3)
		assert.equal(await store.get('other-room', 'product'), null, 'rooms are isolated')
	}
	console.log('ok: file store write/list/get (fuzzy + exact id)')
}

main().then(
	() => {
		console.log('roadmap-store.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/server && npx tsx src/roadmap-store.test.ts
```

Expected: FAIL — `Cannot find module './roadmap-store.ts'` (or equivalent ERR_MODULE_NOT_FOUND).

- [ ] **Step 4: Write the implementation**

Create `server/src/roadmap-store.ts`:

```ts
/**
 * Roadmap store — one JSON file per roadmap (DATA_DIR/roadmaps/<room>/<id>.json),
 * following the transcript-store pattern: whole-file read/write, no SQL. The
 * documents are a few KB; however, per-room write serialization is required
 * and provided by the endpoint's promise-chain lock (single process does not
 * serialize multi-await handlers).
 *
 * Also owns the pure document logic shared by every writer: schema validation,
 * the unique-key rule, and the op vocabulary (replace | set | move) that both
 * human canvas edits and the canvas CLI speak. Op batches are applied
 * all-or-nothing by the endpoint: applyOps works on a clone and throws OpError
 * without side effects.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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

// "EnsembleWorks Roadmap" → "ensembleworks-roadmap". The result must satisfy
// app.ts's sanitizeId shape so ids are safe in file paths and shape props.
// Keep in sync with client/src/roadmap/model.ts (slugify).
export function slugify(name: string): string | null {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : null
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
}

export function createRoadmapStore(dir: string): RoadmapStore {
	const roomDir = (roomId: string) => path.join(dir, roomId)

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
			await mkdir(roomDir(roomId), { recursive: true })
			await writeFile(path.join(roomDir(roomId), `${id}.json`), JSON.stringify(stored, null, '\t'))
		},
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/server && npx tsx src/roadmap-store.test.ts
```

Expected: PASS — every `ok:` line then `roadmap-store.test.ts: all tests passed`.

- [ ] **Step 6: Typecheck and commit**

```bash
cd /home/mrdavidlaing/Work/ensembleworks && npm run typecheck --workspace=server
git add server/src/roadmap-store.ts server/src/roadmap-fixture.ts server/src/roadmap-store.test.ts
git commit -m "feat(server): roadmap store — pure op logic + JSON-file persistence"
```

---

### Task 2: Server schema — register the `roadmap` shape

**Files:**
- Modify: `server/src/schema.ts`

- [ ] **Step 1: Add the shape props**

In `server/src/schema.ts`, after the `nekoShapeProps` block (line 34), insert:

```ts
// Keep in sync with client/src/roadmap/RoadmapShapeUtil.tsx
const roadmapShapeProps = {
	w: T.number,
	h: T.number,
	// Slug id of the roadmap document this shape renders (see roadmap-store.ts).
	roadmapId: T.string,
	// Bumped by POST /api/roadmap on every write so clients refetch; optional
	// so existing rooms need no migration.
	rev: T.number.optional(),
}
```

and register it in the `createTLSchema` call:

```ts
export const schema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		terminal: { props: terminalShapeProps },
		iframe: { props: iframeShapeProps },
		neko: { props: nekoShapeProps },
		roadmap: { props: roadmapShapeProps },
	},
	bindings: defaultBindingSchemas,
})
```

- [ ] **Step 2: Typecheck and commit**

```bash
cd /home/mrdavidlaing/Work/ensembleworks && npm run typecheck --workspace=server
git add server/src/schema.ts
git commit -m "feat(server): register roadmap shape in the sync schema"
```

---

### Task 3: `GET/POST /api/roadmap` endpoints + rev fan-out

**Files:**
- Modify: `server/src/app.ts`
- Create: `server/src/roadmap-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/roadmap-api.test.ts`:

```ts
// Contract tests for the roadmap HTTP API. Boots the express app in-process
// via createSyncApp, seeds a roadmap shape for the rev fan-out check, then
// exercises GET/POST /api/roadmap end to end.
// Run with: npx tsx src/roadmap-api.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'
import { ROADMAP_FIXTURE } from './roadmap-fixture.ts'

const SHAPE_ID = 'shape:roadmap-1'

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'roadmap-api-test-'))
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const base = `http://127.0.0.1:${address.port}`

	const postJson = async (route: string, body: unknown) => {
		const res = await fetch(`${base}${route}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		return { status: res.status, body: (await res.json()) as any }
	}
	const getJson = async (route: string) => {
		const res = await fetch(`${base}${route}`)
		return { status: res.status, body: (await res.json()) as any }
	}

	// Seed a roadmap shape bound to the id "Product Roadmap" will slug to, so
	// the fan-out check has a target. A fresh room contains page:page already.
	const room = getOrCreateRoom('test')
	await room.updateStore((store) => {
		store.put({
			id: SHAPE_ID,
			typeName: 'shape',
			type: 'roadmap',
			x: 0,
			y: 0,
			rotation: 0,
			isLocked: false,
			opacity: 1,
			meta: {},
			props: { w: 1280, h: 720, roadmapId: 'product-roadmap' },
			parentId: 'page:page',
			index: 'a1',
		} as any)
	})
	const documents = () => room.getCurrentSnapshot().documents.map((d) => d.state as any)

	// 1. Create via replace: rev 1, id slugged from the name, shape stamped.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'Product Roadmap',
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(res.status, 200, `create should be 200, got ${JSON.stringify(res.body)}`)
		assert.equal(res.body.ok, true)
		assert.equal(res.body.id, 'product-roadmap')
		assert.equal(res.body.rev, 1)
		assert.equal(res.body.shapesUpdated, 1, 'the seeded shape is stamped')
		const shape = documents().find((r) => r.id === SHAPE_ID)
		assert.equal(shape.props.rev, 1, 'rev fan-out lands on props.rev')
		console.log('ok: create via replace, rev fan-out stamps the bound shape')
	}

	// 2. List and read (fuzzy name + exact id).
	{
		const list = await getJson('/api/roadmap?room=test')
		assert.equal(list.status, 200)
		assert.equal(list.body.roadmaps.length, 1)
		assert.equal(list.body.roadmaps[0].id, 'product-roadmap')
		assert.equal(list.body.roadmaps[0].rev, 1)

		const read = await getJson('/api/roadmap?room=test&name=product')
		assert.equal(read.status, 200)
		assert.equal(read.body.name, 'Product Roadmap')
		assert.equal(read.body.rev, 1)
		assert.equal(read.body.data.outcomes.length, 3)
		assert.ok(read.body.updated, 'read carries the server-stamped updated date')

		const missing = await getJson('/api/roadmap?room=test&name=definitely-not-here')
		assert.equal(missing.status, 404)
		console.log('ok: list + read (fuzzy match), 404 on unknown name')
	}

	// 3. Patch ops bump rev, persist, and re-stamp the shape.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ops: [
				{ op: 'set', key: 'O3.I1.F1', fields: { status: 'done' } },
				{ op: 'move', key: 'O4', zone: 'now' },
			],
		})
		assert.equal(res.status, 200)
		assert.equal(res.body.rev, 2)
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		assert.equal(read.body.data.outcomes[1].initiatives[0].features[0].status, 'done')
		assert.equal(read.body.data.outcomes.find((o: any) => o.key === 'O4').zone, 'now')
		const shape = documents().find((r) => r.id === SHAPE_ID)
		assert.equal(shape.props.rev, 2)
		console.log('ok: patch ops apply, rev 2 fanned out')
	}

	// 4. Concurrency guard: stale ifRev is 409 and carries the current rev.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ifRev: 1,
			ops: [{ op: 'set', key: 'O1', fields: { status: 'parked' } }],
		})
		assert.equal(res.status, 409)
		assert.equal(res.body.rev, 2, '409 carries the current rev')
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		assert.equal(read.body.data.outcomes[0].status, 'done', 'stale write did not apply')
		console.log('ok: stale ifRev is 409, nothing applied')
	}

	// 5. Atomicity: a batch with one bad op leaves the document untouched.
	{
		const res = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ops: [
				{ op: 'set', key: 'O1', fields: { status: 'parked' } },
				{ op: 'set', key: 'NO-SUCH-KEY', fields: { status: 'done' } },
			],
		})
		assert.equal(res.status, 404, 'unknown key is 404')
		const read = await getJson('/api/roadmap?room=test&name=product-roadmap')
		assert.equal(read.body.data.outcomes[0].status, 'done', 'first op rolled back with the batch')
		assert.equal(read.body.rev, 2, 'rev unchanged')
		console.log('ok: failing batch is all-or-nothing')
	}

	// 6. Edges: ops on a missing roadmap 404; bad op 400; bad names 400.
	{
		const missing = await postJson('/api/roadmap', {
			room: 'test',
			name: 'no-such-roadmap',
			ops: [{ op: 'set', key: 'O1', fields: { status: 'done' } }],
		})
		assert.equal(missing.status, 404)

		const badOp = await postJson('/api/roadmap', {
			room: 'test',
			name: 'product-roadmap',
			ops: [{ op: 'destroy', key: 'O1' }],
		})
		assert.equal(badOp.status, 400)

		const noName = await postJson('/api/roadmap', {
			room: 'test',
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(noName.status, 400)

		const badSlug = await postJson('/api/roadmap', {
			room: 'test',
			name: '***',
			ops: [{ op: 'replace', data: ROADMAP_FIXTURE }],
		})
		assert.equal(badSlug.status, 400)
		console.log('ok: edges (missing roadmap 404, bad op 400, bad name 400)')
	}

	room.close()
	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

main().then(
	() => {
		console.log('roadmap-api.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/server && npx tsx src/roadmap-api.test.ts
```

Expected: FAIL — the create call returns 404 (`GET /api/roadmap` / `POST /api/roadmap` don't exist yet; express answers with the JSON 404 or an HTML 404 → the first assert fails).

- [ ] **Step 3: Implement the endpoints**

In `server/src/app.ts`:

3a. Add to the route list in the file-header comment (after the `POST /api/shape` line):

```
 *   GET  /api/roadmap           – list roadmaps, or read one (?name=)
 *   POST /api/roadmap           – atomic op batch (replace | set | move)
```

3b. Add the import (after the `createTranscriptStore` import on line 37):

```ts
import { OpError, applyOps, createRoadmapStore, slugify, type RoadmapOp } from './roadmap-store.ts'
```

3c. Inside `createSyncApp`, after the `transcripts` store creation (line 325):

```ts
	const roadmaps = createRoadmapStore(path.join(opts.dataDir, 'roadmaps'))
```

3d. After the `GET /api/frame` handler (ends line 1093), add both routes:

```ts
	// Roadmap (two-way roadmap control): the document lives in the roadmap
	// store, not the tldraw document — shapes hold only { roadmapId, rev }.
	// GET /api/roadmap?room=[&name=] — without name: list; with name: full
	// document + rev (exact-id first, then fuzzy name match like /api/frame).
	app.get('/api/roadmap', async (req, res) => {
		const roomId = sanitizeId(String(req.query.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const name = typeof req.query.name === 'string' ? req.query.name.trim() : ''
		if (!name) {
			return void res.json({ ok: true, roadmaps: await roadmaps.list(roomId) })
		}
		const found = await roadmaps.get(roomId, name)
		if (!found) return void res.status(404).json({ error: 'roadmap not found' })
		res.json({
			ok: true,
			id: found.id,
			name: found.name,
			rev: found.rev,
			updated: found.updated,
			data: found.data,
		})
	})

	// POST /api/roadmap — one write path for humans (canvas drags/status
	// clicks) and agents (CLI): an all-or-nothing op batch. Creates the
	// roadmap when the batch starts with replace and nothing matches `name`.
	// ifRev guards wholesale regenerate-and-push flows against clobbering
	// edits that landed since the caller last read (409 carries current rev).
	app.post('/api/roadmap', async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const roomId = sanitizeId(String(body.room ?? 'team'))
		if (!roomId) return void res.status(400).json({ error: 'bad room id' })
		const name = typeof body.name === 'string' ? body.name.trim() : ''
		if (!name || name.length > 128) return void res.status(400).json({ error: 'name is required' })
		const ifRev = typeof body.ifRev === 'number' && Number.isFinite(body.ifRev) ? body.ifRev : null

		const existing = await roadmaps.get(roomId, name)
		if (existing && ifRev !== null && ifRev !== existing.rev) {
			return void res
				.status(409)
				.json({ error: `stale ifRev ${ifRev} (current rev is ${existing.rev})`, rev: existing.rev })
		}

		let data
		try {
			data = applyOps(existing?.data ?? null, body.ops as RoadmapOp[])
		} catch (err) {
			if (err instanceof OpError) return void res.status(err.status).json({ error: err.message })
			return void res.status(400).json({ error: `invalid ops: ${err}` })
		}

		const id = existing?.id ?? slugify(name)
		if (!id) return void res.status(400).json({ error: 'name does not reduce to a valid id' })
		const rev = (existing?.rev ?? 0) + 1
		const updated = new Date().toISOString().slice(0, 10)
		data.meta.updated = updated // server-stamped; client-supplied values are ignored
		await roadmaps.write(roomId, id, { name: existing?.name ?? name, rev, updated, data })

		// Rev fan-out: stamp the new rev onto every shape bound to this roadmap
		// so tldraw sync broadcasts "data changed" and open clients refetch over
		// HTTP (the /api/terminal-status mechanism).
		let shapesUpdated = 0
		await getOrCreateRoom(roomId).updateStore((store) => {
			for (const record of store.getAll() as any[]) {
				if (
					record.typeName === 'shape' &&
					record.type === 'roadmap' &&
					record.props?.roadmapId === id
				) {
					store.put({ ...record, props: { ...record.props, rev } })
					shapesUpdated++
				}
			}
		})
		res.json({ ok: true, id, rev, shapesUpdated })
	})
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/server && npx tsx src/roadmap-api.test.ts && npx tsx src/canvas-api.test.ts
```

Expected: both scripts end with `all tests passed` (canvas-api is the no-regression guard).

- [ ] **Step 5: Typecheck and commit**

```bash
cd /home/mrdavidlaing/Work/ensembleworks && npm run typecheck --workspace=server
git add server/src/app.ts server/src/roadmap-api.test.ts
git commit -m "feat(server): GET/POST /api/roadmap with atomic ops, ifRev guard and rev fan-out"
```

---

### Task 4: Client model — pure roadmap helpers

**Files:**
- Create: `client/src/roadmap/model.ts`
- Create: `client/src/roadmap/model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/roadmap/model.test.ts`:

```ts
// Unit tests for the pure roadmap client model.
// Run with: npx tsx src/roadmap/model.test.ts
import assert from 'node:assert/strict'
import { applyLocalOp, cycleStatus, glyphFor, slugify, type RoadmapDoc } from './model.ts'

const DOC: RoadmapDoc = {
	meta: { title: 'T' },
	outcomes: [
		{
			key: 'O1',
			zone: 'now',
			status: 'in-progress',
			title: 'One',
			initiatives: [
				{
					key: 'O1.I1',
					title: 'Ini',
					status: 'planned',
					metrics: [{ key: 'O1.I1.M1', text: 'm', done: false }],
					features: [
						{ key: 'O1.I1.F1', text: 'f1', status: 'planned' },
						{ key: 'O1.I1.F2', text: 'f2', status: 'planned' },
					],
				},
			],
		},
		{ key: 'O2', zone: 'next', status: 'planned', title: 'Two', initiatives: [] },
	],
}

// The status click cycle skips parked (spec §decisions.4).
assert.equal(cycleStatus('planned'), 'in-progress')
assert.equal(cycleStatus('in-progress'), 'done')
assert.equal(cycleStatus('done'), 'planned')
assert.equal(cycleStatus('parked'), 'planned')
console.log('ok: cycleStatus')

assert.equal(glyphFor('done').g, '✓')
assert.equal(glyphFor('in-progress').g, '●')
assert.equal(glyphFor('parked').g, '–')
assert.equal(glyphFor('planned').g, '○')
console.log('ok: glyphFor')

assert.equal(slugify('Product Roadmap'), 'product-roadmap')
assert.equal(slugify('!!!'), null)
console.log('ok: slugify')

{
	const next = applyLocalOp(DOC, { op: 'set', key: 'O1.I1.F1', fields: { status: 'done' } })
	assert.equal(next.outcomes[0]!.initiatives![0]!.features![0]!.status, 'done')
	assert.equal(DOC.outcomes[0]!.initiatives![0]!.features![0]!.status, 'planned', 'input untouched')
}
{
	const next = applyLocalOp(DOC, { op: 'move', key: 'O2', zone: 'now', index: 0 })
	assert.deepEqual(
		next.outcomes.filter((o) => o.zone === 'now').map((o) => o.key),
		['O2', 'O1']
	)
}
{
	const next = applyLocalOp(DOC, { op: 'move', key: 'O1.I1.F2', index: 0 })
	assert.deepEqual(next.outcomes[0]!.initiatives![0]!.features!.map((f) => f.key), [
		'O1.I1.F2',
		'O1.I1.F1',
	])
}
console.log('ok: applyLocalOp set + move mirror the server semantics')
console.log('model.test.ts: all tests passed')
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/client && npx tsx src/roadmap/model.test.ts
```

Expected: FAIL — `Cannot find module './model.ts'`.

- [ ] **Step 3: Write the implementation**

Create `client/src/roadmap/model.ts`:

```ts
/**
 * Pure roadmap document model for the roadmap shape: wire-format types, the
 * glyph/chip mappings from the Roadmap.dc.html design, the status-click
 * cycle, and an optimistic local mirror of the server's set/move semantics.
 * Keep op semantics in sync with server/src/roadmap-store.ts (applyOps).
 */

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

export type RoadmapOp =
	| { op: 'replace'; data: RoadmapDoc }
	| { op: 'set'; key: string; fields: Record<string, unknown> }
	| { op: 'move'; key: string; zone?: string; index?: number }

export const ZONES = [
	{ id: 'done', label: 'Done — shipped', marker: false, warm: true },
	{ id: 'now', label: 'Now / in progress', marker: true, warm: false },
	{ id: 'next', label: 'Next', marker: false, warm: false },
	{ id: 'later', label: 'Later — ranked', marker: false, warm: false },
] as const

export function glyphFor(status: string): { g: string; c: string } {
	if (status === 'done') return { g: '✓', c: 'var(--rm-ok)' }
	if (status === 'in-progress') return { g: '●', c: 'var(--rm-seal-blue)' }
	if (status === 'parked') return { g: '–', c: 'var(--rm-fg-subtle)' }
	return { g: '○', c: 'var(--rm-fg-subtle)' }
}

export function chipFor(status: string): { text: string; fg: string; bc: string } {
	if (status === 'done') return { text: 'Done', fg: 'var(--rm-ok)', bc: 'rgba(21,163,134,0.4)' }
	if (status === 'in-progress') {
		return { text: 'In progress', fg: 'var(--rm-seal-blue)', bc: 'rgba(0,73,144,0.35)' }
	}
	if (status === 'parked') return { text: 'Parked', fg: 'var(--rm-fg-subtle)', bc: 'var(--rm-rule)' }
	return { text: 'Planned', fg: 'var(--rm-fg-subtle)', bc: 'var(--rm-rule)' }
}

// The v1 status click: planned → in-progress → done → planned. `parked` sits
// outside the cycle (parking is a deliberate CLI/agent act); clicking a
// parked item re-activates it as planned.
export function cycleStatus(status: string): string {
	if (status === 'planned') return 'in-progress'
	if (status === 'in-progress') return 'done'
	return 'planned'
}

export function countsLine(doc: RoadmapDoc): string {
	const nI = doc.outcomes.reduce((n, o) => n + (o.initiatives ?? []).length, 0)
	const nF = doc.outcomes.reduce(
		(n, o) => n + (o.initiatives ?? []).reduce((m, i) => m + (i.features ?? []).length, 0),
		0
	)
	return `${doc.outcomes.length} outcomes · ${nI} initiatives · ${nF} features`
}

// Keep in sync with server/src/roadmap-store.ts (slugify).
export function slugify(name: string): string | null {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : null
}

function findNode(doc: RoadmapDoc, key: string): { node: any; list: any[] } | null {
	for (const o of doc.outcomes) {
		if (o.key === key) return { node: o, list: doc.outcomes }
		for (const i of o.initiatives ?? []) {
			if (i.key === key) return { node: i, list: o.initiatives! }
			for (const m of i.metrics ?? []) if (m.key === key) return { node: m, list: i.metrics! }
			for (const f of i.features ?? []) if (f.key === key) return { node: f, list: i.features! }
		}
	}
	return null
}

// Optimistic mirror of the server's applyOps for the ops the canvas emits
// (set + move). Trusting by design: the component only builds valid ops, and
// any divergence is reconciled by the rev-bump refetch.
export function applyLocalOp(doc: RoadmapDoc, op: RoadmapOp): RoadmapDoc {
	if (op.op === 'replace') return structuredClone(op.data)
	const next = structuredClone(doc)
	const ref = findNode(next, op.key)
	if (!ref) return next
	if (op.op === 'set') {
		Object.assign(ref.node, op.fields)
		return next
	}
	if (ref.list === next.outcomes) {
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
	return next
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/client && npx tsx src/roadmap/model.test.ts
```

Expected: PASS — ends with `model.test.ts: all tests passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/mrdavidlaing/Work/ensembleworks
git add client/src/roadmap/model.ts client/src/roadmap/model.test.ts
git commit -m "feat(client): pure roadmap model (glyphs, status cycle, optimistic ops)"
```

---

### Task 5: Roadmap CSS tokens + Source Serif 4 font

**Files:**
- Create: `client/src/roadmap/roadmap.css`
- Modify: `client/index.html`

- [ ] **Step 1: Create the stylesheet**

Create `client/src/roadmap/roadmap.css`:

```css
/*
 * Roadmap shape styles. Tokens are the Wellmaintained design-system values
 * used by Roadmap.dc.html (colors_and_type.css), scoped under .rm-root so
 * they can't leak into tldraw chrome. Font stacks reuse the canvas theme's
 * --wm-* tokens where they exist (theme.css).
 */
.rm-root {
	--rm-bg: #fafaf7;
	--rm-bg-warm: #f6f3ec;
	--rm-panel: #f2f0ea;
	--rm-fg: #0f172a;
	--rm-fg-muted: rgba(15, 23, 42, 0.58);
	--rm-fg-subtle: rgba(15, 23, 42, 0.4);
	--rm-rule: rgba(15, 23, 42, 0.1);
	--rm-rule-strong: rgba(15, 23, 42, 0.22);
	--rm-rule-cool: rgba(15, 23, 42, 0.08);
	--rm-seal-blue: #004990;
	--rm-seal-cream: #f6efe2;
	--rm-ok: #15a386;
	--rm-serif: 'Source Serif 4', 'Source Serif Pro', Charter, 'Iowan Old Style', Georgia, serif;
	--rm-sans: var(--wm-sans, 'PT Sans', system-ui, sans-serif);
	--rm-mono: var(--wm-mono, 'JetBrains Mono', ui-monospace, monospace);

	font-family: var(--rm-sans);
	color: var(--rm-fg);
	box-sizing: border-box;
}
.rm-root * {
	box-sizing: border-box;
}

/* The signature ALL-CAPS tracked mono label. */
.rm-label {
	font-family: var(--rm-mono);
	font-size: 8.5px;
	letter-spacing: 1.5px;
	text-transform: uppercase;
	color: var(--rm-fg-subtle);
	white-space: nowrap;
}

/* Copyable key chips ("O3.I1.F2 · click to copy"). */
.rm-key {
	font-family: var(--rm-mono);
	font-size: 8.5px;
	letter-spacing: 0.5px;
	color: var(--rm-fg-muted);
	background: none;
	border: none;
	padding: 0;
	cursor: pointer;
	align-self: flex-start;
}
.rm-key:hover {
	color: var(--rm-seal-blue);
}

/* Bare glyph buttons (status cycle / metric toggle). */
.rm-glyph {
	background: none;
	border: none;
	padding: 0;
	font-size: 10.5px;
	width: 14px;
	flex: none;
	cursor: pointer;
	line-height: 1.5;
}

.rm-drag {
	cursor: grab;
}
.rm-drag:active {
	cursor: grabbing;
}
```

- [ ] **Step 2: Load Source Serif 4**

In `client/index.html`, replace the Google Fonts stylesheet `href` with one that adds Source Serif 4 (semibold, for the outcome titles):

```html
		<link
			rel="stylesheet"
			href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=PT+Sans:wght@400;700&family=Source+Serif+4:wght@600&display=swap"
		/>
```

- [ ] **Step 3: Commit**

```bash
cd /home/mrdavidlaing/Work/ensembleworks
git add client/src/roadmap/roadmap.css client/index.html
git commit -m "feat(client): roadmap design tokens + Source Serif 4 webfont"
```

---

### Task 6: `RoadmapShapeUtil` — the shape and its component

**Files:**
- Create: `client/src/roadmap/RoadmapShapeUtil.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Create the shape util + component**

Create `client/src/roadmap/RoadmapShapeUtil.tsx`. This is the React port of `Roadmap.dc.html` (claude.ai/design project "React roadmap component design"): `sc-for`/`sc-if` become maps/conditionals; the `DCLogic` view logic carries over; status glyphs/chips become buttons that cycle status (the one v1 addition to the design).

```tsx
/**
 * The roadmap control — a zoned outcome board (Done / Now / Next / Later)
 * rendered as a tldraw shape. React port of the Roadmap.dc.html design
 * component.
 *
 * Data plane: the document lives server-side (server/src/roadmap-store.ts);
 * this shape holds only { roadmapId, rev }. The component fetches the JSON on
 * mount and whenever props.rev changes — the server bumps rev on every write,
 * and that prop change arriving over tldraw sync is the multiplayer "refetch
 * now" signal. Human edits (drag-reorder, zone moves, status clicks) apply
 * optimistically via applyLocalOp and POST the same op the CLI would; a
 * failed POST triggers a refetch so the board never drifts from the server.
 *
 * Interaction gating follows the terminal shape: double-click to edit
 * (drag/filter/status-click active), Esc or click away to go back to canvas
 * navigation. View state (filter, collapse, drag hover) is local per client.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	TLBaseShape,
	TLResizeInfo,
	resizeBox,
	useEditor,
	useValue,
} from 'tldraw'
import { getRoomId } from '../identity'
import {
	ZONES,
	applyLocalOp,
	chipFor,
	countsLine,
	cycleStatus,
	glyphFor,
	type RoadmapDoc,
	type RoadmapInitiative,
	type RoadmapOp,
	type RoadmapOutcome,
} from './model'
import './roadmap.css'

export interface RoadmapShapeProps {
	w: number
	h: number
	roadmapId: string
	// Bumped server-side on every write (POST /api/roadmap) to trigger refetch.
	rev?: number
}

declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		roadmap: RoadmapShapeProps
	}
}

export type RoadmapShape = TLBaseShape<'roadmap', RoadmapShapeProps>

export const ROADMAP_DEFAULT_W = 1280
export const ROADMAP_DEFAULT_H = 720
const MIN_W = 480
const MIN_H = 320

export class RoadmapShapeUtil extends BaseBoxShapeUtil<RoadmapShape> {
	static override type = 'roadmap' as const
	// Keep in sync with server/src/schema.ts
	static override props = {
		w: T.number,
		h: T.number,
		roadmapId: T.string,
		rev: T.number.optional(),
	}

	override getDefaultProps(): RoadmapShape['props'] {
		return { w: ROADMAP_DEFAULT_W, h: ROADMAP_DEFAULT_H, roadmapId: 'roadmap' }
	}

	override canEdit() {
		return true
	}
	override canScroll() {
		return true
	}
	override hideRotateHandle() {
		return true
	}

	override onResize(shape: RoadmapShape, info: TLResizeInfo<RoadmapShape>) {
		return resizeBox(shape, info, { minWidth: MIN_W, minHeight: MIN_H })
	}

	override component(shape: RoadmapShape) {
		return <RoadmapShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: RoadmapShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

interface DragInfo {
	type: 'outcome' | 'ini' | 'child'
	container: string
	key: string
}

const FILTERS = [
	['all', 'All'],
	['done', 'Done'],
	['in-progress', 'In progress'],
	['planned', 'Planned'],
] as const

function RoadmapShapeComponent({ shape }: { shape: RoadmapShape }) {
	const editor = useEditor()
	const isEditing = useValue(
		'isEditing',
		() => editor.getEditingShapeId() === shape.id,
		[editor, shape.id]
	)
	const [doc, setDoc] = useState<RoadmapDoc | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [refresh, setRefresh] = useState(0)
	const [filter, setFilter] = useState('all')
	const [open, setOpen] = useState<Record<string, boolean>>({})
	const [copied, setCopied] = useState<string | null>(null)
	const [over, setOver] = useState<string | null>(null)
	const drag = useRef<DragInfo | null>(null)
	const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	const { roadmapId, rev } = shape.props

	useEffect(() => {
		let cancelled = false
		fetch(
			`/api/roadmap?room=${encodeURIComponent(getRoomId())}&name=${encodeURIComponent(roadmapId)}`
		)
			.then(async (r) => {
				if (r.status === 404) return null
				if (!r.ok) throw new Error(`server answered ${r.status}`)
				return ((await r.json()) as { data: RoadmapDoc }).data
			})
			.then((data) => {
				if (cancelled) return
				setDoc(data)
				setError(null)
			})
			.catch((err) => {
				if (!cancelled) setError(String(err?.message ?? err))
			})
		return () => {
			cancelled = true
		}
	}, [roadmapId, rev, refresh])

	// Optimistic write: mutate the local doc, POST the same op the CLI would,
	// refetch on failure so the board reconverges with the server.
	const postOp = useCallback(
		(op: RoadmapOp) => {
			setDoc((d) => (d ? applyLocalOp(d, op) : d))
			fetch('/api/roadmap', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ room: getRoomId(), name: roadmapId, ops: [op] }),
			})
				.then((r) => {
					if (!r.ok) setRefresh((n) => n + 1)
				})
				.catch(() => setRefresh((n) => n + 1))
		},
		[roadmapId]
	)

	const copyKey = (key: string) => {
		navigator.clipboard?.writeText(key).catch(() => {})
		setCopied(key)
		clearTimeout(copyTimer.current)
		copyTimer.current = setTimeout(() => setCopied(null), 1400)
	}

	// ---- drag core (port of DCLogic's drag core) ------------------------------
	const startDrag = (e: React.DragEvent, info: DragInfo) => {
		e.stopPropagation()
		drag.current = info
		try {
			e.dataTransfer.setData('text/plain', info.key)
			e.dataTransfer.effectAllowed = 'move'
		} catch {
			/* dataTransfer may be unavailable in tests */
		}
	}
	const endDrag = () => {
		drag.current = null
		setOver(null)
	}
	const allowDrop = (e: React.DragEvent, type: DragInfo['type'], container: string, sig: string) => {
		const d = drag.current
		if (d && d.type === type && d.container === container) {
			e.preventDefault()
			e.stopPropagation()
			if (over !== sig) setOver(sig)
		}
	}
	const overShadow = (sig: string) => (over === sig ? '0 0 0 2px var(--rm-seal-blue) inset' : 'none')

	// ---- drop handlers → move ops ---------------------------------------------
	// Dropping outcome A on outcome B: A adopts B's zone and takes B's index
	// within that zone (server move semantics are index-within-zone).
	const dropOutcomeOn = (e: React.DragEvent, targetKey: string) => {
		e.preventDefault()
		e.stopPropagation()
		const d = drag.current
		if (!doc || !d || d.type !== 'outcome' || d.key === targetKey) return endDrag()
		const target = doc.outcomes.find((o) => o.key === targetKey)
		if (!target) return endDrag()
		const zoneMembers = doc.outcomes.filter((o) => o.zone === target.zone && o.key !== d.key)
		postOp({
			op: 'move',
			key: d.key,
			zone: target.zone,
			index: zoneMembers.findIndex((o) => o.key === targetKey),
		})
		endDrag()
	}
	const dropOutcomeOnZone = (e: React.DragEvent, zoneId: string) => {
		e.preventDefault()
		e.stopPropagation()
		const d = drag.current
		if (!d || d.type !== 'outcome') return endDrag()
		postOp({ op: 'move', key: d.key, zone: zoneId })
		endDrag()
	}
	// Reorder within a nested list (initiatives / metrics / features).
	const dropInList = (e: React.DragEvent, list: { key: string }[], targetKey: string) => {
		e.preventDefault()
		e.stopPropagation()
		const d = drag.current
		if (!d || d.key === targetKey) return endDrag()
		const without = list.filter((x) => x.key !== d.key)
		postOp({ op: 'move', key: d.key, index: without.findIndex((x) => x.key === targetKey) })
		endDrag()
	}

	const keyBtn = (key: string) => (
		<button
			className="rm-key"
			title="Copy key"
			style={copied === key ? { color: 'var(--rm-ok)' } : undefined}
			onClick={(e) => {
				e.stopPropagation()
				copyKey(key)
			}}
		>
			{copied === key ? 'copied ✓' : key}
		</button>
	)

	// ---- nested renderers -------------------------------------------------------
	const renderChild = (
		item: { key: string; text: string; done?: boolean; status?: string },
		kind: 'metrics' | 'features',
		ini: RoadmapInitiative,
		outcomeKey: string
	) => {
		const container = `child:${outcomeKey}/${ini.key}/${kind}`
		const sig = `${container}:${item.key}`
		const isMetric = kind === 'metrics'
		const g = isMetric
			? { g: item.done ? '✓' : '○', c: item.done ? 'var(--rm-ok)' : 'var(--rm-fg-subtle)' }
			: glyphFor(item.status ?? 'planned')
		const list = (isMetric ? ini.metrics : ini.features) ?? []
		return (
			<div
				key={item.key}
				className="rm-drag"
				draggable
				onDragStart={(e) => startDrag(e, { type: 'child', container, key: item.key })}
				onDragEnd={endDrag}
				onDragOver={(e) => allowDrop(e, 'child', container, sig)}
				onDrop={(e) => dropInList(e, list, item.key)}
				style={{
					display: 'flex',
					gap: 6,
					padding: '5px 0',
					borderBottom: '1px solid var(--rm-rule-cool)',
					boxShadow: overShadow(sig),
				}}
			>
				<span style={{ color: 'var(--rm-fg-subtle)', fontSize: 10, flex: 'none', letterSpacing: -2 }}>⠿</span>
				<button
					className="rm-glyph"
					style={{ color: g.c }}
					title={isMetric ? 'Toggle done' : 'Cycle status'}
					onClick={(e) => {
						e.stopPropagation()
						postOp(
							isMetric
								? { op: 'set', key: item.key, fields: { done: !item.done } }
								: { op: 'set', key: item.key, fields: { status: cycleStatus(item.status ?? 'planned') } }
						)
					}}
				>
					{g.g}
				</button>
				<div style={{ flex: 1 }}>
					<div style={{ fontSize: 11.5, lineHeight: 1.4 }}>{item.text}</div>
					{keyBtn(item.key)}
				</div>
			</div>
		)
	}

	const renderInitiative = (ini: RoadmapInitiative, outcomeKey: string) => {
		const isOpen = open[ini.key] ?? true
		const st = glyphFor(ini.status)
		const container = `ini:${outcomeKey}`
		const sig = `${container}:${ini.key}`
		const list = doc?.outcomes.find((o) => o.key === outcomeKey)?.initiatives ?? []
		return (
			<div
				key={ini.key}
				onDragOver={(e) => allowDrop(e, 'ini', container, sig)}
				onDrop={(e) => dropInList(e, list, ini.key)}
				style={{
					width: 212,
					flex: 'none',
					border: '1px solid var(--rm-rule)',
					borderRadius: 2,
					background: 'var(--rm-bg)',
					boxShadow: overShadow(sig),
				}}
			>
				<div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '8px 10px', background: 'var(--rm-panel)' }}>
					<span
						className="rm-drag"
						draggable
						onDragStart={(e) => startDrag(e, { type: 'ini', container, key: ini.key })}
						onDragEnd={endDrag}
						title="Drag to reorder"
						style={{ color: 'var(--rm-fg-subtle)', fontSize: 11, lineHeight: 1.5, flex: 'none', letterSpacing: -2 }}
					>
						⠿
					</span>
					<button
						className="rm-glyph"
						style={{ color: st.c, fontSize: 11 }}
						title="Cycle status"
						onClick={(e) => {
							e.stopPropagation()
							postOp({ op: 'set', key: ini.key, fields: { status: cycleStatus(ini.status) } })
						}}
					>
						{st.g}
					</button>
					<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
						<div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.3 }}>{ini.title}</div>
						{keyBtn(ini.key)}
					</div>
					<button
						title="Collapse / expand"
						onClick={(e) => {
							e.stopPropagation()
							setOpen((s) => ({ ...s, [ini.key]: !isOpen }))
						}}
						style={{
							flex: 'none',
							width: 18,
							height: 18,
							fontFamily: 'var(--rm-mono)',
							fontSize: 11,
							lineHeight: 1,
							color: 'var(--rm-fg-muted)',
							background: 'none',
							border: '1px solid var(--rm-rule)',
							borderRadius: 2,
							cursor: 'pointer',
							padding: 0,
						}}
					>
						{isOpen ? '–' : '+'}
					</button>
				</div>
				{isOpen && (
					<div style={{ padding: 10, borderTop: '1px solid var(--rm-rule)' }}>
						{ini.statement && (
							<p style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--rm-fg-muted)', fontStyle: 'italic', margin: '0 0 10px' }}>
								{ini.statement}
							</p>
						)}
						<div className="rm-label" style={{ fontSize: 8, color: 'var(--rm-seal-blue)', marginBottom: 2 }}>
							Metrics — when done?
						</div>
						{(ini.metrics ?? []).map((m) => renderChild(m, 'metrics', ini, outcomeKey))}
						<div className="rm-label" style={{ fontSize: 8, color: 'var(--rm-seal-blue)', margin: '10px 0 2px' }}>
							Features
						</div>
						{(ini.features ?? []).map((f) => renderChild(f, 'features', ini, outcomeKey))}
					</div>
				)}
			</div>
		)
	}

	const renderOutcome = (oc: RoadmapOutcome) => {
		const match = filter === 'all' || oc.status === filter
		const chip = chipFor(oc.status)
		const sig = `oc:${oc.key}`
		return (
			<div
				key={oc.key}
				onDragOver={(e) => allowDrop(e, 'outcome', 'root', sig)}
				onDrop={(e) => dropOutcomeOn(e, oc.key)}
				style={{
					opacity: match ? 1 : 0.22,
					borderRight: '1px solid var(--rm-rule)',
					padding: '0 12px 16px',
					transition: 'opacity 120ms linear',
					boxShadow: overShadow(sig),
				}}
			>
				<div
					className="rm-drag"
					draggable
					onDragStart={(e) => startDrag(e, { type: 'outcome', container: 'root', key: oc.key })}
					onDragEnd={endDrag}
					style={{
						height: 72,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'center',
						gap: 5,
						borderBottom: '1px solid var(--rm-rule)',
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<span style={{ color: 'var(--rm-fg-subtle)', fontSize: 11, lineHeight: 1, letterSpacing: -2 }}>⠿</span>
						<button
							className="rm-key"
							title="Copy key"
							style={{
								fontSize: 9.5,
								letterSpacing: 1,
								padding: '2px 7px',
								background: 'var(--rm-panel)',
								border: '1px solid var(--rm-rule)',
								borderRadius: 2,
								...(copied === oc.key ? { color: 'var(--rm-ok)' } : {}),
							}}
							onClick={(e) => {
								e.stopPropagation()
								copyKey(oc.key)
							}}
						>
							{copied === oc.key ? 'copied ✓' : oc.key}
						</button>
						<button
							title="Cycle status"
							onClick={(e) => {
								e.stopPropagation()
								postOp({ op: 'set', key: oc.key, fields: { status: cycleStatus(oc.status) } })
							}}
							style={{
								fontFamily: 'var(--rm-mono)',
								fontSize: 8.5,
								letterSpacing: 1.5,
								padding: '2px 6px',
								whiteSpace: 'nowrap',
								border: `1px solid ${chip.bc}`,
								color: chip.fg,
								background: 'none',
								borderRadius: 2,
								textTransform: 'uppercase',
								cursor: 'pointer',
							}}
						>
							{chip.text}
						</button>
					</div>
					<div style={{ fontFamily: 'var(--rm-serif)', fontWeight: 600, fontSize: 16, letterSpacing: -0.2, lineHeight: 1.15 }}>
						{oc.title}
					</div>
				</div>
				<div style={{ height: 104, borderBottom: '1px solid var(--rm-rule)', padding: '10px 2px', overflow: 'hidden' }}>
					<div className="rm-label" style={{ fontSize: 8, marginBottom: 4 }}>
						Why
					</div>
					<p style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--rm-fg-muted)', margin: 0, maxWidth: '44ch' }}>
						{oc.why}
					</p>
				</div>
				<div style={{ display: 'flex', gap: 12, paddingTop: 12, alignItems: 'flex-start' }}>
					{(oc.initiatives ?? []).map((ini) => renderInitiative(ini, oc.key))}
				</div>
			</div>
		)
	}

	// ---- top-level layout ---------------------------------------------------------
	const header = (
		<div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderBottom: '1px solid var(--rm-rule-strong)' }}>
			<div style={{ width: 20, height: 20, background: 'var(--rm-seal-blue)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
				<div style={{ width: 8, height: 8, background: 'var(--rm-seal-cream)', transform: 'rotate(45deg)' }} />
			</div>
			<div>
				<div style={{ fontFamily: 'var(--rm-serif)', fontWeight: 600, fontSize: 17, letterSpacing: -0.2 }}>
					{doc?.meta.title ?? shape.props.roadmapId}
				</div>
				<div className="rm-label" style={{ fontSize: 9, letterSpacing: 1, textTransform: 'none' }}>
					{doc
						? `${[doc.meta.revision, doc.meta.updated].filter(Boolean).join(' · ')} · ${countsLine(doc)}`
						: error
							? `unreachable: ${error}`
							: 'loading…'}
				</div>
			</div>
			<div style={{ flex: 1 }} />
			<span className="rm-label">Drag to reorder · Filter</span>
			<div style={{ display: 'flex', gap: 6 }}>
				{FILTERS.map(([id, label]) => {
					const active = filter === id
					return (
						<button
							key={id}
							onClick={(e) => {
								e.stopPropagation()
								setFilter(id)
							}}
							style={{
								fontFamily: 'var(--rm-mono)',
								fontSize: 8.5,
								letterSpacing: 1.5,
								textTransform: 'uppercase',
								whiteSpace: 'nowrap',
								padding: '4px 9px',
								border: `1px solid ${active ? 'var(--rm-seal-blue)' : 'var(--rm-rule-strong)'}`,
								borderRadius: 2,
								background: active ? 'var(--rm-seal-blue)' : 'transparent',
								color: active ? '#f6efe2' : 'var(--rm-fg-muted)',
								cursor: 'pointer',
							}}
						>
							{label}
						</button>
					)
				})}
			</div>
		</div>
	)

	const board = doc && (
		<div style={{ overflow: 'auto', flex: 1 }}>
			<div style={{ display: 'flex', alignItems: 'stretch', minWidth: 'max-content', minHeight: '100%' }}>
				{/* Sticky left rail: row labels for the aligned outcome grid. */}
				<div style={{ position: 'sticky', left: 0, zIndex: 4, flex: 'none', width: 84, background: 'var(--rm-bg)', borderRight: '1px solid var(--rm-rule-strong)', display: 'flex', flexDirection: 'column' }}>
					<div style={{ height: 36, borderBottom: '1px solid var(--rm-rule-strong)' }} />
					<div style={{ height: 72, display: 'flex', alignItems: 'center', padding: '0 10px', borderBottom: '1px solid var(--rm-rule)' }}>
						<span className="rm-label">Outcome</span>
					</div>
					<div style={{ height: 104, display: 'flex', alignItems: 'center', padding: '0 10px', borderBottom: '1px solid var(--rm-rule)' }}>
						<span className="rm-label">Why</span>
					</div>
					<div style={{ flex: 1, padding: '16px 10px' }}>
						<span className="rm-label" style={{ lineHeight: 2 }}>
							Initiatives
							<br />
							Metrics
							<br />
							Features
						</span>
					</div>
				</div>

				{ZONES.map((zone) => {
					const outcomes = doc.outcomes.filter((o) => o.zone === zone.id)
					const zoneSig = `zone:${zone.id}`
					return (
						<div key={zone.id} style={{ display: 'contents' }}>
							{zone.marker && (
								<div style={{ flex: 'none', width: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--rm-panel)', borderRight: '2px solid var(--rm-seal-blue)' }}>
									<span style={{ writingMode: 'vertical-rl', fontFamily: 'var(--rm-mono)', fontSize: 9, letterSpacing: 3, color: 'var(--rm-seal-blue)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
										← past · Today · future →
									</span>
								</div>
							)}
							<div style={{ flex: 'none', minWidth: 260, borderRight: '1px solid var(--rm-rule-strong)', background: zone.warm ? 'var(--rm-bg-warm)' : 'transparent' }}>
								<div
									onDragOver={(e) => allowDrop(e, 'outcome', 'root', zoneSig)}
									onDrop={(e) => dropOutcomeOnZone(e, zone.id)}
									style={{ height: 36, display: 'flex', alignItems: 'center', padding: '0 14px', borderBottom: '1px solid var(--rm-rule-strong)', boxShadow: overShadow(zoneSig) }}
								>
									<span style={{ fontFamily: 'var(--rm-mono)', fontSize: 9.5, fontWeight: 500, letterSpacing: 2, color: 'var(--rm-seal-blue)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
										{zone.label}
									</span>
									<span style={{ flex: 1 }} />
									<span style={{ fontFamily: 'var(--rm-mono)', fontSize: 8.5, color: 'var(--rm-fg-subtle)' }}>
										{outcomes.length}
									</span>
								</div>
								<div
									onDragOver={(e) => allowDrop(e, 'outcome', 'root', zoneSig)}
									onDrop={(e) => dropOutcomeOnZone(e, zone.id)}
									style={{ display: 'flex', alignItems: 'stretch', minHeight: 120 }}
								>
									{outcomes.length === 0 ? (
										<div className="rm-label" style={{ width: 244, margin: '16px 8px', border: '1px dashed var(--rm-rule-strong)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: overShadow(zoneSig) }}>
											Drop outcome here
										</div>
									) : (
										outcomes.map(renderOutcome)
									)}
								</div>
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)

	const emptyState = !doc && (
		<div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
			<div style={{ textAlign: 'center', maxWidth: 420 }}>
				<div style={{ fontFamily: 'var(--rm-serif)', fontWeight: 600, fontSize: 17, marginBottom: 8 }}>
					{error ? 'Roadmap unreachable' : 'No roadmap data yet'}
				</div>
				<div style={{ fontSize: 12, color: 'var(--rm-fg-muted)', lineHeight: 1.5 }}>
					{error ??
						`Push one from a canvas terminal: canvas roadmap push "${shape.props.roadmapId}" roadmap.json`}
				</div>
			</div>
		</div>
	)

	const legend = (
		<div style={{ display: 'flex', gap: 18, padding: '10px 18px', borderTop: '1px solid var(--rm-rule-strong)' }}>
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>✓ done</span>
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>● in progress</span>
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>○ planned</span>
			<span style={{ flex: 1 }} />
			<span className="rm-label" style={{ letterSpacing: 1, textTransform: 'none' }}>
				{isEditing ? '⠿ drag to reorder · click glyphs to set status · click keys to copy' : 'double-click to interact'}
			</span>
		</div>
	)

	return (
		<HTMLContainer style={{ pointerEvents: isEditing ? 'all' : 'none' }}>
			<div
				className="rm-root"
				onPointerDown={(e) => {
					if (isEditing) e.stopPropagation()
				}}
				onWheel={(e) => {
					if (isEditing) e.stopPropagation()
				}}
				style={{
					width: shape.props.w,
					height: shape.props.h,
					display: 'flex',
					flexDirection: 'column',
					overflow: 'hidden',
					border: '1px solid var(--rm-rule-strong)',
					borderRadius: 4,
					background: 'var(--rm-bg)',
				}}
			>
				{header}
				{doc ? board : emptyState}
				{legend}
			</div>
		</HTMLContainer>
	)
}
```

- [ ] **Step 2: Register the shape in `client/src/App.tsx`**

Add the import (after the `TerminalShapeUtil` import on line 18):

```ts
import { RoadmapShapeUtil } from './roadmap/RoadmapShapeUtil'
```

and extend line 21:

```ts
const customShapeUtils = [TerminalShapeUtil, IframeShapeUtil, NekoShapeUtil, RoadmapShapeUtil]
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/mrdavidlaing/Work/ensembleworks && npm run typecheck --workspace=client
```

Expected: clean. (Common trip-ups: unused imports, `open` shadowing — fix any reported.)

- [ ] **Step 4: Commit**

```bash
git add client/src/roadmap/RoadmapShapeUtil.tsx client/src/App.tsx
git commit -m "feat(client): roadmap shape — React port of the Roadmap.dc design component"
```

---

### Task 7: Toolbar button

**Files:**
- Modify: `client/src/ui.tsx`

- [ ] **Step 1: Add the factory + tool + toolbar item**

In `client/src/ui.tsx`:

1a. Add imports (extend the existing import lists):

```ts
import { ROADMAP_DEFAULT_H, ROADMAP_DEFAULT_W } from './roadmap/RoadmapShapeUtil'
import { slugify } from './roadmap/model'
```

1b. After `createNekoShape` (line 73), add:

```ts
export function createRoadmapShape(editor: Editor) {
	// The name is the CLI/agent addressing handle; its slug is the document id
	// (createDevServerShape precedent: prompt, no server round-trip). The shape
	// renders its empty state until someone pushes data to that name.
	const name = window.prompt('Roadmap name:', 'Roadmap')?.trim()
	if (!name) return
	const roadmapId = slugify(name)
	if (!roadmapId) {
		window.alert('Roadmap name must contain at least one letter or digit.')
		return
	}
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'roadmap',
		x: x - ROADMAP_DEFAULT_W / 2,
		y: y - ROADMAP_DEFAULT_H / 2,
		props: { w: ROADMAP_DEFAULT_W, h: ROADMAP_DEFAULT_H, roadmapId },
	})
	editor.setSelectedShapes([id])
}
```

1c. In `uiOverrides.tools` (after the `neko` entry, line 103), add:

```ts
		tools['roadmap'] = {
			id: 'roadmap',
			icon: 'tool-note',
			label: 'New roadmap',
			readonlyOk: false,
			onSelect() {
				createRoadmapShape(editor)
			},
		}
```

1d. In `ToolbarWithTerminal` (line 115), add after the neko item:

```tsx
				{tools['roadmap'] && <TldrawUiMenuItem {...tools['roadmap']} />}
```

- [ ] **Step 2: Typecheck and commit**

```bash
cd /home/mrdavidlaing/Work/ensembleworks && npm run typecheck --workspace=client
git add client/src/ui.tsx
git commit -m "feat(client): New roadmap toolbar button"
```

---

### Task 8: CLI — `canvas roadmap list | read | push | ops`

**Files:**
- Modify: `bin/canvas`

- [ ] **Step 1: Add the usage text**

In `usage()`, after the `shape <json>` block (line 48), add:

```bash
    '  roadmap list' \
    '      List the room'"'"'s roadmaps (JSON: id, name, rev, updated).' \
    '  roadmap read <name>' \
    '      Read one roadmap (fuzzy name match, exact id first; JSON with data' \
    '      + rev). Use the rev with push --if-rev to avoid clobbering edits.' \
    '  roadmap push <name> <file.json> [--if-rev <n>]' \
    '      Create or wholesale-replace a roadmap from a roadmap.json document.' \
    '      NOTE: <name> matches existing roadmaps fuzzily first — pushing' \
    '      "roadmap" updates an existing "Product Roadmap" rather than' \
    '      creating a second one.' \
    '  roadmap ops <name> <ops-json> [--if-rev <n>]' \
    '      Apply targeted ops (JSON array). Ops:' \
    '        {"op":"set","key":"O3.I1.F2","fields":{"status":"done"}}' \
    '        {"op":"move","key":"O4","zone":"now","index":0}' \
    '      set fields: status|done|title|why|statement|text (per node kind);' \
    '      move: zone (outcomes only) and/or index (within zone/parent list).' \
```

- [ ] **Step 2: Add the command implementation**

After `cmd_shape()` (line 263), add:

```bash
# roadmap_post POSTs to /api/roadmap without curl's -f, so error bodies (which
# carry the current rev on 409) reach the caller; non-2xx exits non-zero.
roadmap_post() {
  local payload="$1" out status body
  out="$(curl -sS -o - -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "$payload" "${canvas_url}/api/roadmap")"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  printf '%s\n' "$body"
  [[ "$status" == 2* ]] || exit 1
}

cmd_roadmap() {
  [[ $# -ge 1 ]] || die "roadmap requires a subcommand: list | read | push | ops (run 'canvas --help')"
  local sub="$1"
  shift
  case "$sub" in
    list)
      [[ $# -eq 0 ]] || die 'roadmap list takes no arguments'
      get_query /api/roadmap "room=${canvas_room}"
      ;;
    read)
      [[ $# -eq 1 ]] || die 'roadmap read requires exactly <name>'
      [[ -n "$1" ]] || die 'name must be non-empty'
      get_query /api/roadmap "room=${canvas_room}" "name=$1"
      ;;
    push | ops)
      [[ $# -ge 2 ]] || die "roadmap $sub requires <name> and $([[ "$sub" == push ]] && echo '<file.json>' || echo "'<ops-json>'")"
      local name="$1" arg="$2" if_rev=''
      shift 2
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --if-rev)
            [[ $# -ge 2 ]] || die '--if-rev requires a value'
            if_rev="$2"
            shift 2
            ;;
          *)
            die "unknown argument: $1"
            ;;
        esac
      done
      [[ -n "$name" ]] || die 'name must be non-empty'
      [[ -z "$if_rev" || "$if_rev" =~ ^[0-9]+$ ]] || die '--if-rev must be a number'

      local ops
      if [[ "$sub" == push ]]; then
        [[ -f "$arg" ]] || die "no such file: $arg"
        local data
        data="$(cat "$arg")"
        [[ "$data" == \{* ]] || die "$arg must contain a JSON object (the roadmap document)"
        ops="[{\"op\":\"replace\",\"data\":${data}}]"
      else
        ops="$arg"
        [[ "$ops" == \[* ]] || die 'ops must be a JSON array'
      fi

      local payload
      payload="$(printf '{"room":"%s","name":"%s","ops":%s' \
        "$(json_escape "$canvas_room")" "$(json_escape "$name")" "$ops")"
      [[ -n "$if_rev" ]] && payload+=",\"ifRev\":${if_rev}"
      payload+='}'
      roadmap_post "$payload"
      ;;
    *)
      die "unknown roadmap subcommand: $sub (expected list | read | push | ops)"
      ;;
  esac
}
```

- [ ] **Step 3: Add the dispatch arm**

In `main()`'s `case` (after the `shape)` arm, line 305), add:

```bash
    roadmap)
      shift
      cmd_roadmap "$@"
      ;;
```

- [ ] **Step 4: Verify against a live in-process server**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/server
DATA_DIR=$(mktemp -d) PORT=18788 npx tsx src/sync-server.ts &
SERVER_PID=$!
sleep 2
cd /home/mrdavidlaing/Work/ensembleworks
cat > /tmp/roadmap-demo.json <<'EOF'
{
  "meta": { "title": "Demo Roadmap", "revision": "rev 01" },
  "outcomes": [
    {
      "key": "O1", "zone": "now", "status": "in-progress", "title": "First Outcome",
      "why": "Because demos.",
      "initiatives": [
        {
          "key": "O1.I1", "title": "Do the thing", "status": "in-progress",
          "statement": "FOR: everyone. OUTCOME: it works.",
          "metrics": [ { "key": "O1.I1.M1", "text": "It ships", "done": false } ],
          "features": [ { "key": "O1.I1.F1", "text": "The feature", "status": "planned" } ]
        }
      ]
    }
  ]
}
EOF
export CANVAS_URL=http://localhost:18788 CANVAS_ROOM=clitest
./bin/canvas roadmap push "Demo Roadmap" /tmp/roadmap-demo.json
./bin/canvas roadmap list
./bin/canvas roadmap read demo
./bin/canvas roadmap ops demo '[{"op":"set","key":"O1.I1.F1","fields":{"status":"done"}}]'
./bin/canvas roadmap push demo /tmp/roadmap-demo.json --if-rev 1; echo "exit=$? (expect 1: stale rev)"
kill $SERVER_PID
```

Expected: push → `{"ok":true,"id":"demo-roadmap","rev":1,...}`; list shows one entry; read shows `"rev":1` and the document; ops → `"rev":2`; the stale `--if-rev 1` push prints a 409 body containing `"rev":2` and `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add bin/canvas
git commit -m "feat(cli): canvas roadmap list/read/push/ops"
```

---

### Task 9: Agent docs

**Files:**
- Modify: `.claude/skills/canvas/SKILL.md`
- Modify: `deploy/agent-home/AGENTS.md`

- [ ] **Step 1: Document the commands**

Append this section to **both** files (adjust the heading level to match each file's structure — read each file first and place it alongside the existing CLI command docs):

```markdown
## Roadmap

A room can hold named roadmap controls — zoned outcome boards (Done / Now /
Next / Later) that humans re-prioritise by dragging and clicking status
glyphs, and agents populate and read back:

- `canvas roadmap list` — the room's roadmaps (id, name, rev, updated).
- `canvas roadmap read <name>` — full document + `rev`. Fuzzy name match,
  exact id first. Read before you regenerate: human drags and status clicks
  live here and nowhere else.
- `canvas roadmap push <name> <file.json> [--if-rev <rev>]` — create or
  wholesale-replace from a roadmap.json document
  (`meta + outcomes[] → initiatives[] → metrics[]/features[]`; keys like
  `O3.I1.F2` must be unique). Use `--if-rev` with the rev you read; a 409
  reply means someone edited meanwhile — re-read, merge, retry.
- `canvas roadmap ops <name> '<ops-json>' [--if-rev <rev>]` — targeted edits
  without touching the rest:
  `[{"op":"set","key":"O3.I1.F2","fields":{"status":"done"}}]`
  `[{"op":"move","key":"O4","zone":"now","index":0}]`
  `set` fields per kind — outcome: status/title/why; initiative:
  status/title/statement; feature: status/text; metric: done/text. Statuses:
  planned | in-progress | done | parked. `move` takes `zone` (outcomes only)
  and/or `index` (position within the zone or parent list).

Structural changes (add/remove outcomes, initiatives, metrics, features) go
through `push` — regenerate the document and replace it.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/canvas/SKILL.md deploy/agent-home/AGENTS.md
git commit -m "docs: canvas roadmap CLI commands in agent docs"
```

---

### Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: All tests + typecheck**

```bash
cd /home/mrdavidlaing/Work/ensembleworks/server
npx tsx src/roadmap-store.test.ts && npx tsx src/roadmap-api.test.ts && npx tsx src/canvas-api.test.ts
cd /home/mrdavidlaing/Work/ensembleworks/client
npx tsx src/roadmap/model.test.ts
cd /home/mrdavidlaing/Work/ensembleworks
npm run typecheck
```

Expected: every test script prints `all tests passed`; typecheck clean across all workspaces.

- [ ] **Step 2: Manual walkthrough in the dev stack**

With the dev stack running (`npm run dev`, or the workspace tmux windows — see the dev tmux stack notes):

1. Open the canvas in a browser; click the **New roadmap** toolbar button; name it `Product Roadmap`. Expect the empty state: "No roadmap data yet … canvas roadmap push".
2. From a terminal: `CANVAS_URL=http://localhost:8788 CANVAS_ROOM=team ./bin/canvas roadmap push "Product Roadmap" /tmp/roadmap-demo.json` (file from Task 8 step 4). Expect the board to render **without reloading** (rev fan-out → refetch).
3. Double-click the shape to edit; drag the outcome to another zone; click a feature's `○` glyph (expect `●`, then `✓` on second click); click a key chip (expect `copied ✓`).
4. `./bin/canvas roadmap read product` — expect the zone/status changes from step 3 in the JSON.
5. Open a second browser tab: both tabs show the same board; an edit in one appears in the other within a second.

- [ ] **Step 3: Commit any fixes, then wrap up**

If the walkthrough surfaced fixes, commit them individually. Then run the superpowers:finishing-a-development-branch skill (merge/PR decision).

---

## Notes for the implementer

- **Two-planes rule** (`docs/architecture-spec.md`): never put roadmap content in shape props — only `{roadmapId, rev}`. If you're tempted to add a prop, it probably belongs in the store.
- **Keep-in-sync pairs:** shape props (`RoadmapShapeUtil.tsx` ↔ `schema.ts`), slugify (`roadmap-store.ts` ↔ `model.ts`), op semantics (`applyOps` ↔ `applyLocalOp`). Each carries a comment naming its twin.
- **tabs, not spaces** — the repo uses tab indentation in TS files; match it.
- The `tools['roadmap']` icon `tool-note` is a placeholder from tldraw's built-in set; a custom icon (the neko `assetUrls` pattern) is a possible follow-up, not v1.
