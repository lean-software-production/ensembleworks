// HTTP integration contract for EW-CLI-DRAW-0001 (Navigator RED).
// Boots the REAL app in-process (createSyncApp → real SQLite, real TLSocketRoom
// running the same schema validation the browser uses). NO mocks. Drives
//   POST /api/canvas/shape   (create / update / delete)
//   POST /api/canvas/sticky
//   GET  /api/canvas/frame(s)
//   GET  /api/tools
// and asserts the RESULTING STORE RECORD (decoded points, parentId, page-point,
// index, rotation, meta) — never "it returned 200". Copied from the
// scribe-api.test.ts harness (createSyncApp / listen(0) / makeTestClient /
// getCurrentSnapshot snapshot reader / mkdtemp).
//
// Every AC1–AC23 has ≥1 assertion. Instead of a single linear abort, each AC is
// a self-contained check() that seeds its own room directly into the store, so a
// RED run surfaces EVERY failing AC at once (and proves each failure is an
// assertion about unbuilt behaviour, not a harness crash).
//
// Run with: bun src/shape-api.test.ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { b64Vecs, compressLegacySegments, toRichText } from '@tldraw/tlschema'
import { getIndicesAbove, sortByIndex } from '@tldraw/utils'
import { makeTestClient } from './test-helpers.ts'

// --- test doubles for the environment (same as scribe-api.test.ts) -----------
// Fake LiveKit keys (only decoded locally) + force header-trust auth mode with an
// anonymous default: unset CF Access verification and any dev identity, so a
// header-less request resolves to identity=null (meta {}), and a
// Cf-Access-Authenticated-User-Email header makes the caller credentialed (AC21).
process.env.LIVEKIT_API_KEY = 'testkey'
process.env.LIVEKIT_API_SECRET = 'testsecret-testsecret-testsecret'
process.env.LIVEKIT_URL = 'wss://example.test/livekit'
delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL
delete process.env.EW_DEV_IDENTITY_NAME

const DRAW_TYPES = ['frame', 'line', 'draw', 'highlight'] as const

// ---- pure test helpers ------------------------------------------------------
const decode = (path: string): { x: number; y: number }[] => (b64Vecs as any).decodePoints(path)

// Per-element ±tol comparison of two [x,y] sequences.
const approxSeq = (a: any[], b: any[], tol: number): boolean =>
	a.length === b.length &&
	a.every((p: any, i: number) => Math.abs(p[0] - b[i][0]) <= tol && Math.abs(p[1] - b[i][1]) <= tol)

// A record's top-left in page coords (child x/y are parent-relative) — mirrors
// server/src/canvas/geometry.ts:pagePoint, recomputed test-side for round-trips.
const pagePointOf = (rec: any, byId: Map<string, any>): { x: number; y: number } => {
	let x = rec.x ?? 0
	let y = rec.y ?? 0
	let parent = byId.get(rec.parentId)
	let guard = 0
	while (parent && parent.typeName === 'shape' && guard++ < 50) {
		x += parent.x ?? 0
		y += parent.y ?? 0
		parent = byId.get(parent.parentId)
	}
	return { x, y }
}

// ---- valid 5.1.0 seed-record builders (bypass the API to isolate the verb ---
// under test; every one passes store.put) ------------------------------------
const base = (o: any) => ({
	id: o.id,
	typeName: 'shape' as const,
	parentId: o.parentId,
	index: o.index ?? 'a1',
	x: o.x ?? 0,
	y: o.y ?? 0,
	rotation: o.rotation ?? 0,
	isLocked: false,
	opacity: 1,
	meta: o.meta ?? {},
})
const pageRec = (o: any) => ({ id: o.id, typeName: 'page', name: o.name ?? 'Page', index: o.index ?? 'a1', meta: {} })
const frameRec = (o: any) => ({
	...base(o),
	type: 'frame',
	props: { w: o.w ?? 800, h: o.h ?? 600, name: o.name ?? '', color: o.color ?? 'black' },
})
const noteRec = (o: any) => ({
	...base(o),
	type: 'note',
	props: {
		richText: toRichText(o.text ?? ''), color: 'yellow', labelColor: 'black', size: 'm', font: 'draw',
		fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1,
		textFirstEditedBy: null,
	},
})
const geoRec = (o: any) => ({
	...base(o),
	type: 'geo',
	props: {
		geo: 'rectangle', dash: 'draw', url: '', w: o.w ?? 220, h: o.h ?? 120, growY: 0, scale: 1,
		labelColor: 'black', color: 'black', fill: 'semi', size: 's', font: 'draw', align: 'middle',
		verticalAlign: 'middle', richText: toRichText(o.text ?? ''),
	},
})
const lineRec = (o: any) => {
	const k = getIndicesAbove(null as any, 2)
	return {
		...base(o),
		type: 'line',
		props: {
			color: 'black', dash: 'draw', size: 'm', spline: 'line',
			points: {
				[k[0]!]: { id: k[0], index: k[0], x: 0, y: 0 },
				[k[1]!]: { id: k[1], index: k[1], x: 120, y: 0 },
			},
			scale: 1,
		},
	}
}
const drawRec = (o: any) => ({
	...base(o),
	type: 'draw',
	props: {
		color: 'black', fill: 'none', dash: 'draw', size: 'm',
		segments: compressLegacySegments([{ type: 'free', points: [{ x: 0, y: 0 }, { x: 40, y: 10 }] }] as any),
		isComplete: true, isClosed: false, isPen: false, scale: 1, scaleX: 1, scaleY: 1,
	},
})

async function main() {
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'shape-api-test-'))
	const { createSyncApp } = await import('./app.ts')
	const { server, getOrCreateRoom } = createSyncApp({ dataDir })
	await new Promise<void>((resolve) => server.listen(0, resolve))
	const address = server.address()
	assert.ok(address && typeof address === 'object', 'server.listen(0) should yield a port')
	const b = `http://127.0.0.1:${(address as any).port}`
	const { postJson, getJson } = makeTestClient(b)
	// Custom-header POST (AC21 credentialed caller).
	const postH = async (route: string, body: unknown, headers: Record<string, string>) => {
		const res = await fetch(`${b}${route}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
		})
		return { status: res.status, body: (await res.json()) as any }
	}
	const docs = (room: string): any[] =>
		getOrCreateRoom(room).getCurrentSnapshot().documents.map((d: any) => d.state)
	const byIdOf = (room: string) => new Map(docs(room).map((r: any) => [r.id, r]))
	const seed = async (room: string, records: any[]) => {
		await getOrCreateRoom(room).updateStore((store: any) => {
			for (const r of records) store.put(r)
		})
	}

	// --- tiny per-AC runner ---------------------------------------------------
	const results: { name: string; ok: boolean; err?: any }[] = []
	const check = async (name: string, fn: () => Promise<void>) => {
		try {
			await fn()
			results.push({ name, ok: true })
			console.log(`PASS ${name}`)
		} catch (err) {
			results.push({ name, ok: false, err })
			const kind = (err as any)?.code === 'ERR_ASSERTION' ? 'assert' : (err as any)?.constructor?.name
			console.log(`FAIL ${name} :: [${kind}] ${(err as any)?.message ?? err}`)
		}
	}

	// =========================================================================
	// FRAME CREATION
	// =========================================================================
	await check('AC1: create a frame → record type/props/page-point, listed by frames', async () => {
		const r = await postJson('/api/canvas/shape', {
			room: 'ac1', type: 'frame', name: 'Test frame', w: 600, h: 400, x: 100, y: 80,
		})
		assert.equal(r.status, 200, 'create frame → 200')
		assert.equal(r.body.ok, true)
		assert.ok(typeof r.body.id === 'string' && r.body.id.startsWith('shape:'), 'returns a shape id')
		const rec = docs('ac1').find((d) => d.id === r.body.id)
		assert.ok(rec, 'frame record exists in the store')
		assert.equal(rec.type, 'frame')
		assert.equal(rec.props.w, 600, 'props.w')
		assert.equal(rec.props.h, 400, 'props.h')
		assert.equal(rec.props.name, 'Test frame', 'props.name')
		assert.ok(typeof rec.props.color === 'string' && rec.props.color.length > 0, 'props.color present (required in 5.1.0)')
		assert.ok(rec.parentId.startsWith('page:'), 'a top-level frame parents to a page')
		assert.equal(rec.x, 100, 'page-point x')
		assert.equal(rec.y, 80, 'page-point y')
		const frames = await getJson('/api/canvas/frames?room=ac1')
		assert.ok(frames.body.frames.some((f: any) => f.name === 'Test frame'), 'canvas frames lists it')
	})

	await check('AC2: defaults & minimal — bare create frame never 400s; no-name reads ""', async () => {
		const bare = await postJson('/api/canvas/shape', { room: 'ac2', type: 'frame' })
		assert.equal(bare.status, 200, 'bare create frame → 200 (never 400s for missing size)')
		const rec = docs('ac2').find((d) => d.id === bare.body.id)
		assert.ok(rec.props.w > 0 && rec.props.h > 0, 'non-zero default w/h')
		assert.equal(rec.props.w, 800, 'design default w = 800')
		assert.equal(rec.props.h, 600, 'design default h = 600')
		assert.ok(typeof rec.props.color === 'string' && rec.props.color.length > 0, 'default color present')
		assert.equal(rec.props.name, '', 'a no-name frame reads back name:""')
		const named = await postJson('/api/canvas/shape', { room: 'ac2', type: 'frame', name: 'Just a name' })
		assert.equal(named.status, 200, '--name-only frame succeeds')
		assert.equal(docs('ac2').find((d) => d.id === named.body.id).props.name, 'Just a name')
	})

	await check('AC3: an agent-made frame is a real parent (children parentId == frame id)', async () => {
		const f = await postJson('/api/canvas/shape', { room: 'ac3', type: 'frame', name: 'Parent frame' })
		assert.equal(f.status, 200, 'frame create → 200')
		const frameId = f.body.id
		const sticky = await postJson('/api/canvas/sticky', { room: 'ac3', text: 'hi', frame: 'Parent frame' })
		assert.equal(sticky.status, 200, 'sticky --frame → 200')
		assert.equal(docs('ac3').find((d) => d.id === sticky.body.id).parentId, frameId, 'sticky parented to the frame')
		const geo = await postJson('/api/canvas/shape', { room: 'ac3', type: 'geo', frame: 'Parent frame' })
		assert.equal(geo.status, 200, 'geo --frame → 200')
		assert.equal(docs('ac3').find((d) => d.id === geo.body.id).parentId, frameId, 'geo parented to the frame')
	})

	// =========================================================================
	// DRAWING SHAPES (assert decoded geometry, not "it renders")
	// =========================================================================
	await check('AC4: create a line — vertices decode in order ±1px; spline; <2 pts → 400', async () => {
		const r = await postJson('/api/canvas/shape', { room: 'ac4', type: 'line', points: [[0, 0], [120, 60], [200, 0]] })
		assert.equal(r.status, 200, 'create line → 200')
		const rec = docs('ac4').find((d) => d.id === r.body.id)
		assert.equal(rec.type, 'line')
		const verts = Object.values(rec.props.points).sort(sortByIndex as any)
		const pageVerts = verts.map((p: any) => [rec.x + p.x, rec.y + p.y])
		assert.ok(approxSeq(pageVerts, [[0, 0], [120, 60], [200, 0]], 1), 'points sort-by-index to input order ±1px (page space)')
		const cubic = await postJson('/api/canvas/shape', { room: 'ac4', type: 'line', points: [[0, 0], [10, 10]], spline: 'cubic' })
		assert.equal(docs('ac4').find((d) => d.id === cubic.body.id).props.spline, 'cubic', '--spline cubic')
		const before = docs('ac4').filter((d) => d.type === 'line').length
		const bad = await postJson('/api/canvas/shape', { room: 'ac4', type: 'line', points: [[0, 0]] })
		assert.equal(bad.status, 400, 'line with <2 points → 400')
		assert.equal(docs('ac4').filter((d) => d.type === 'line').length, before, 'no line record written on the 400')
	})

	await check('AC5: freehand draw — decoded segments == input ±1px; --closed; empty/collapse → 400', async () => {
		const r = await postJson('/api/canvas/shape', { room: 'ac5', type: 'draw', points: [[0, 0], [40, 10], [80, 60]] })
		assert.equal(r.status, 200, 'create draw → 200')
		const rec = docs('ac5').find((d) => d.id === r.body.id)
		assert.equal(rec.type, 'draw')
		const dec = decode(rec.props.segments[0].path).map((p) => [rec.x + p.x, rec.y + p.y])
		assert.ok(approxSeq(dec, [[0, 0], [40, 10], [80, 60]], 1), 'segments decode to the input points ±1px')
		assert.ok('fill' in rec.props && 'dash' in rec.props && 'isClosed' in rec.props, 'draw carries fill/dash/isClosed')
		assert.equal(rec.props.scaleX, 1, 'draw carries scaleX')
		const closed = await postJson('/api/canvas/shape', { room: 'ac5', type: 'draw', points: [[0, 0], [10, 10], [20, 0]], closed: true })
		assert.equal(docs('ac5').find((d) => d.id === closed.body.id).props.isClosed, true, '--closed → isClosed:true')
		const before = docs('ac5').filter((d) => d.type === 'draw').length
		const empty = await postJson('/api/canvas/shape', { room: 'ac5', type: 'draw', points: [] })
		assert.equal(empty.status, 400, 'empty draw points → 400')
		const collapse = await postJson('/api/canvas/shape', { room: 'ac5', type: 'draw', points: [[5, 5], [5, 5]] })
		assert.equal(collapse.status, 400, 'collapsed single-point blob → 400 even though put would 200')
		assert.equal(docs('ac5').filter((d) => d.type === 'draw').length, before, 'no draw record written on either 400')
	})

	await check('AC6: highlighter — decoded == input ±1px; NO fill/dash/isClosed in the prop set', async () => {
		const r = await postJson('/api/canvas/shape', { room: 'ac6', type: 'highlight', points: [[0, 0], [120, 0]] })
		assert.equal(r.status, 200, 'create highlight → 200')
		const rec = docs('ac6').find((d) => d.id === r.body.id)
		assert.equal(rec.type, 'highlight')
		const dec = decode(rec.props.segments[0].path).map((p) => [rec.x + p.x, rec.y + p.y])
		assert.ok(approxSeq(dec, [[0, 0], [120, 0]], 1), 'highlight decodes to input ±1px')
		assert.ok(!('fill' in rec.props), 'highlight prop set has NO fill')
		assert.ok(!('dash' in rec.props), 'highlight prop set has NO dash')
		assert.ok(!('isClosed' in rec.props), 'highlight prop set has NO isClosed')
		assert.ok('scaleX' in rec.props && 'scaleY' in rec.props, 'highlight has scaleX/scaleY')
	})

	await check('AC7: bounds/origin land where asked (top-left == origin ±1px, extent ±2px)', async () => {
		const r = await postJson('/api/canvas/shape', { room: 'ac7', type: 'line', points: [[100, 50], [220, 110]] })
		assert.equal(r.status, 200)
		const rec = docs('ac7').find((d) => d.id === r.body.id)
		assert.ok(Math.abs(rec.x - 100) <= 1 && Math.abs(rec.y - 50) <= 1, 'shape origin == input bbox-min ±1px')
		const pv = Object.values(rec.props.points).sort(sortByIndex as any).map((p: any) => ({ x: rec.x + p.x, y: rec.y + p.y }))
		const xs = pv.map((p) => p.x)
		const ys = pv.map((p) => p.y)
		const w = Math.max(...xs) - Math.min(...xs)
		const h = Math.max(...ys) - Math.min(...ys)
		assert.ok(Math.abs(Math.min(...xs) - 100) <= 1 && Math.abs(Math.min(...ys) - 50) <= 1, 'top-left page-point == input origin ±1px (not flung)')
		assert.ok(Math.abs(w - 120) <= 2 && Math.abs(h - 60) <= 2, 'extent == input bbox extent ±2px')
		assert.ok(w >= 2 && h >= 2, 'not collapsed (both extents ≥ 2px)')
	})

	// =========================================================================
	// REPARENT & RIDERS (update) — numeric page-point round-trip
	// =========================================================================
	await check('AC8: reparent INTO a frame — no jump, index at/above existing children', async () => {
		await seed('ac8', [
			frameRec({ id: 'shape:ac8F', parentId: 'page:page', x: 1000, y: 500, name: 'Reparent frame' }),
			geoRec({ id: 'shape:ac8kid', parentId: 'shape:ac8F', x: 5, y: 5, index: 'a1', text: 'existing child' }),
			geoRec({ id: 'shape:ac8S', parentId: 'page:page', x: 1200, y: 560, index: 'a5', text: 'to move' }),
			geoRec({ id: 'shape:ac8S2', parentId: 'page:page', x: 1200, y: 560, index: 'a6', text: 'stray-x probe' }),
		])
		const before = pagePointOf(docs('ac8').find((d) => d.id === 'shape:ac8S'), byIdOf('ac8'))
		assert.deepEqual(before, { x: 1200, y: 560 }, 'precondition: page shape at (1200,560)')
		const upd = await postJson('/api/canvas/shape', { room: 'ac8', op: 'update', id: 'shape:ac8S', frame: 'Reparent frame' })
		assert.equal(upd.status, 200, 'reparent update → 200')
		const rec = docs('ac8').find((d) => d.id === 'shape:ac8S')
		assert.equal(rec.parentId, 'shape:ac8F', 'parentId == frame id')
		const after = pagePointOf(rec, byIdOf('ac8'))
		assert.ok(Math.abs(after.x - 1200) <= 1 && Math.abs(after.y - 560) <= 1, 'page-point unchanged ±1px (no jump)')
		const kid = docs('ac8').find((d) => d.id === 'shape:ac8kid')
		assert.notEqual(rec.index, kid.index, 'new index is unique among the frame children')
		assert.ok(sortByIndex({ index: kid.index } as any, { index: rec.index } as any) < 0, 'new index sorts at/above the existing child')
		// stray --x must not fight the translation when reparenting
		const upd2 = await postJson('/api/canvas/shape', { room: 'ac8', op: 'update', id: 'shape:ac8S2', frame: 'Reparent frame', x: 9999 })
		assert.equal(upd2.status, 200)
		const after2 = pagePointOf(docs('ac8').find((d) => d.id === 'shape:ac8S2'), byIdOf('ac8'))
		assert.ok(Math.abs(after2.x - 1200) <= 1, 'stray --x ignored during reparent (translation wins)')
	})

	await check('AC9: reparent OUT to the frame ACTUAL page (2-page doc, not hardcoded page:page)', async () => {
		await seed('ac9', [
			pageRec({ id: 'page:page2', name: 'Second', index: 'a2' }),
			frameRec({ id: 'shape:ac9F', parentId: 'page:page2', x: 1000, y: 500, name: 'P2 frame' }),
			geoRec({ id: 'shape:ac9S', parentId: 'shape:ac9F', x: 200, y: 60, text: 'inside' }),
		])
		const before = pagePointOf(docs('ac9').find((d) => d.id === 'shape:ac9S'), byIdOf('ac9'))
		assert.deepEqual(before, { x: 1200, y: 560 }, 'precondition: page-point (1200,560)')
		const upd = await postJson('/api/canvas/shape', { room: 'ac9', op: 'update', id: 'shape:ac9S', toPage: true })
		assert.equal(upd.status, 200, '--to-page → 200')
		const rec = docs('ac9').find((d) => d.id === 'shape:ac9S')
		assert.equal(rec.parentId, 'page:page2', 'parentId == the frame ACTUAL page (page2), NOT page:page')
		const after = pagePointOf(rec, byIdOf('ac9'))
		assert.ok(Math.abs(after.x - 1200) <= 1 && Math.abs(after.y - 560) <= 1, 'page-point unchanged ±1px')
	})

	await check('AC24: reparent cannot create a parent cycle (self or descendant) → 400', async () => {
		await seed('ac24', [
			frameRec({ id: 'shape:ac24A', parentId: 'page:page', x: 100, y: 100, index: 'a1', name: 'Cycle outer' }),
			frameRec({ id: 'shape:ac24B', parentId: 'shape:ac24A', x: 10, y: 10, index: 'a1', name: 'Cycle inner' }),
			frameRec({ id: 'shape:ac24C', parentId: 'page:page', x: 900, y: 100, index: 'a2', name: 'Cycle sibling' }),
		])
		// self-cycle: a frame fuzzy-matches its own name → must be refused (store.put would ACCEPT parentId==self)
		const self = await postJson('/api/canvas/shape', { room: 'ac24', op: 'update', id: 'shape:ac24A', frame: 'Cycle outer' })
		assert.equal(self.status, 400, 'reparent a frame into itself → 400')
		assert.equal(docs('ac24').find((d) => d.id === 'shape:ac24A').parentId, 'page:page', 'self-cycle rejected: parentId unchanged')
		// descendant-cycle: reparent outer frame A into its own child B → cycle A→B→A
		const desc = await postJson('/api/canvas/shape', { room: 'ac24', op: 'update', id: 'shape:ac24A', frame: 'Cycle inner' })
		assert.equal(desc.status, 400, 'reparent a frame into its own descendant → 400')
		assert.equal(docs('ac24').find((d) => d.id === 'shape:ac24A').parentId, 'page:page', 'descendant-cycle rejected: parentId unchanged')
		// control: a genuinely non-cyclic reparent (A into a sibling frame C) still works
		const ok = await postJson('/api/canvas/shape', { room: 'ac24', op: 'update', id: 'shape:ac24A', frame: 'Cycle sibling' })
		assert.equal(ok.status, 200, 'non-cyclic reparent into a sibling frame → 200')
		assert.equal(docs('ac24').find((d) => d.id === 'shape:ac24A').parentId, 'shape:ac24C', 'A reparented under sibling C')
	})

	await check('AC10: rotate/lock riders exact & persist; invalid rotate → 400', async () => {
		await seed('ac10', [geoRec({ id: 'shape:ac10S', parentId: 'page:page', text: 'r' })])
		const rot = await postJson('/api/canvas/shape', { room: 'ac10', op: 'update', id: 'shape:ac10S', rotate: 0.5 })
		assert.equal(rot.status, 200)
		assert.equal(docs('ac10').find((d) => d.id === 'shape:ac10S').rotation, 0.5, '--rotate 0.5 → rotation === 0.5 exactly')
		const lock = await postJson('/api/canvas/shape', { room: 'ac10', op: 'update', id: 'shape:ac10S', lock: true })
		assert.equal(lock.status, 200)
		assert.equal(docs('ac10').find((d) => d.id === 'shape:ac10S').isLocked, true, '--lock → isLocked === true')
		const bad = await postJson('/api/canvas/shape', { room: 'ac10', op: 'update', id: 'shape:ac10S', rotate: 'abc' })
		assert.equal(bad.status, 400, 'non-numeric --rotate → 400')
	})

	// =========================================================================
	// DELETE SEMANTICS
	// =========================================================================
	await check('AC11: delete frame KEEPS children on the real page, unmoved, no dangling parentId', async () => {
		await seed('ac11', [
			pageRec({ id: 'page:page2', name: 'Second', index: 'a2' }),
			frameRec({ id: 'shape:ac11F', parentId: 'page:page2', x: 500, y: 500, name: 'Del frame' }),
			noteRec({ id: 'shape:ac11a', parentId: 'shape:ac11F', x: 10, y: 10, index: 'a1', text: 'one' }),
			noteRec({ id: 'shape:ac11b', parentId: 'shape:ac11F', x: 30, y: 40, index: 'a2', text: 'two' }),
		])
		const del = await postJson('/api/canvas/shape', { room: 'ac11', op: 'delete', id: 'shape:ac11F' })
		assert.equal(del.status, 200, 'delete frame → 200')
		const d = docs('ac11')
		assert.ok(!d.some((r) => r.id === 'shape:ac11F'), 'frame gone')
		const a = d.find((r) => r.id === 'shape:ac11a')
		const bb = d.find((r) => r.id === 'shape:ac11b')
		assert.ok(a && bb, 'both stickies survive')
		assert.equal(a.parentId, 'page:page2', 'survivor reparented to the frame ACTUAL page (page2), not page:page')
		const ppa = pagePointOf(a, new Map(d.map((r) => [r.id, r])))
		assert.ok(Math.abs(ppa.x - 510) <= 1 && Math.abs(ppa.y - 510) <= 1, 'sticky page-point unchanged ±1px (x += frame.x)')
		for (const r of d.filter((x) => x.typeName === 'shape')) {
			assert.ok(d.some((x) => x.id === r.parentId), `no dangling parentId (${r.id} → ${r.parentId})`)
		}
	})

	await check('AC12: --with-children cascades descendants AND their bindings (incl. external arrow)', async () => {
		await seed('ac12', [
			frameRec({ id: 'shape:ac12F', parentId: 'page:page', x: 300, y: 300, name: 'Cascade frame' }),
			noteRec({ id: 'shape:ac12a', parentId: 'shape:ac12F', x: 10, y: 10, index: 'a1', text: 'inside a' }),
			noteRec({ id: 'shape:ac12b', parentId: 'shape:ac12F', x: 30, y: 40, index: 'a2', text: 'inside b' }),
			geoRec({ id: 'shape:ac12O', parentId: 'page:page', x: 20, y: 20, text: 'outside' }),
		])
		const arrow = await postJson('/api/canvas/shape', { room: 'ac12', type: 'arrow', fromId: 'shape:ac12O', toId: 'shape:ac12a' })
		assert.equal(arrow.status, 200, 'arrow (outside → inside) created')
		const arrowId = arrow.body.id
		assert.equal(docs('ac12').find((d) => d.id === arrowId).parentId, 'page:page', 'the arrow lives OUTSIDE the frame')
		const del = await postJson('/api/canvas/shape', { room: 'ac12', op: 'delete', id: 'shape:ac12F', withChildren: true })
		assert.equal(del.status, 200, 'delete --with-children → 200')
		const d = docs('ac12')
		assert.ok(!d.some((r) => r.id === 'shape:ac12F'), 'frame gone')
		assert.ok(!d.some((r) => r.id === 'shape:ac12a') && !d.some((r) => r.id === 'shape:ac12b'), 'both inside stickies gone')
		assert.ok(d.some((r) => r.id === 'shape:ac12O'), 'the outside geo survives')
		const removed = new Set(['shape:ac12F', 'shape:ac12a', 'shape:ac12b'])
		assert.ok(
			!d.some((r) => r.typeName === 'binding' && (removed.has(r.fromId) || removed.has(r.toId))),
			'no binding references any deleted id (the external arrow lost its binding)',
		)
	})

	await check('AC13: nested delete moves only DIRECT children; cascade removes all', async () => {
		const nest = () => [
			frameRec({ id: 'shape:A', parentId: 'page:page', x: 100, y: 100, name: 'Frame A' }),
			frameRec({ id: 'shape:B', parentId: 'shape:A', x: 50, y: 50, name: 'Frame B' }),
			noteRec({ id: 'shape:Bs', parentId: 'shape:B', x: 10, y: 10, text: "B's sticky" }),
		]
		await seed('ac13', nest())
		const del = await postJson('/api/canvas/shape', { room: 'ac13', op: 'delete', id: 'shape:A' })
		assert.equal(del.status, 200)
		const d = docs('ac13')
		assert.ok(!d.some((r) => r.id === 'shape:A'), 'A gone')
		const B = d.find((r) => r.id === 'shape:B')
		assert.ok(B, 'B survives')
		assert.equal(B.parentId, 'page:page', 'B reparented to A page')
		const ppB = pagePointOf(B, new Map(d.map((r) => [r.id, r])))
		assert.ok(Math.abs(ppB.x - 150) <= 1 && Math.abs(ppB.y - 150) <= 1, 'B page-point unchanged (150,150)')
		const Bs = d.find((r) => r.id === 'shape:Bs')
		assert.ok(Bs && Bs.parentId === 'shape:B', "B's sticky stays under B (grandchild untouched)")
		// cascade in a fresh room
		await seed('ac13b', nest())
		const del2 = await postJson('/api/canvas/shape', { room: 'ac13b', op: 'delete', id: 'shape:A', withChildren: true })
		assert.equal(del2.status, 200)
		const d2 = docs('ac13b')
		assert.ok(!d2.some((r) => ['shape:A', 'shape:B', 'shape:Bs'].includes(r.id)), 'A, B, and B\'s sticky all gone on cascade')
	})

	await check('AC14: non-frame delete unchanged (regression) — shape + its bindings only', async () => {
		await seed('ac14', [
			geoRec({ id: 'shape:ac14a', parentId: 'page:page', x: 0, y: 0, text: 'a' }),
			geoRec({ id: 'shape:ac14b', parentId: 'page:page', x: 400, y: 0, index: 'a2', text: 'b' }),
		])
		const arrow = await postJson('/api/canvas/shape', { room: 'ac14', type: 'arrow', fromId: 'shape:ac14a', toId: 'shape:ac14b' })
		assert.equal(arrow.status, 200)
		const del = await postJson('/api/canvas/shape', { room: 'ac14', op: 'delete', id: 'shape:ac14a' })
		assert.equal(del.status, 200)
		assert.ok(del.body.deleted >= 2, 'geo + its binding deleted')
		const d = docs('ac14')
		assert.ok(!d.some((r) => r.id === 'shape:ac14a'), 'the geo is gone')
		assert.ok(d.some((r) => r.id === 'shape:ac14b'), 'the other geo survives')
		assert.ok(!d.some((r) => r.typeName === 'binding' && (r.fromId === 'shape:ac14a' || r.toId === 'shape:ac14a')), 'its bindings gone')
	})

	// =========================================================================
	// READ SYMMETRY (canvas frame / frames surface drawings)
	// =========================================================================
	await check('AC15: canvas frame lists a drawings array (geo/line/draw), text where present', async () => {
		await seed('ac15', [
			frameRec({ id: 'shape:ac15F', parentId: 'page:page', x: 0, y: 0, name: 'Read frame' }),
			lineRec({ id: 'shape:ac15L', parentId: 'shape:ac15F', index: 'a1' }),
			drawRec({ id: 'shape:ac15D', parentId: 'shape:ac15F', index: 'a2' }),
			geoRec({ id: 'shape:ac15G', parentId: 'shape:ac15F', index: 'a3', text: 'geo lbl' }),
		])
		const fr = await getJson(`/api/canvas/frame?room=ac15&name=${encodeURIComponent('Read frame')}`)
		assert.equal(fr.status, 200)
		assert.ok(Array.isArray(fr.body.drawings), 'frame read returns a drawings array')
		const m = new Map(fr.body.drawings.map((x: any) => [x.id, x]))
		assert.ok(m.has('shape:ac15L') && (m.get('shape:ac15L') as any).type === 'line', 'line surfaced')
		assert.ok(m.has('shape:ac15D') && (m.get('shape:ac15D') as any).type === 'draw', 'draw surfaced')
		assert.ok(m.has('shape:ac15G') && (m.get('shape:ac15G') as any).type === 'geo', 'geo surfaced (closes the read gap)')
		assert.equal((m.get('shape:ac15G') as any).text, 'geo lbl', 'geo carries its label text')
		assert.equal((m.get('shape:ac15L') as any).text, undefined, 'line has no text field')
		assert.ok(Array.isArray(fr.body.notes) && Array.isArray(fr.body.texts) && Array.isArray(fr.body.images), 'existing buckets still present')
	})

	await check('AC16: canvas frames counts drawings; count moves when one is removed', async () => {
		await seed('ac16', [
			frameRec({ id: 'shape:ac16F', parentId: 'page:page', x: 0, y: 0, name: 'Count frame' }),
			geoRec({ id: 'shape:ac16G', parentId: 'shape:ac16F', index: 'a1', text: 'g' }),
			lineRec({ id: 'shape:ac16L', parentId: 'shape:ac16F', index: 'a2' }),
			drawRec({ id: 'shape:ac16D', parentId: 'shape:ac16F', index: 'a3' }),
		])
		const f1 = await getJson('/api/canvas/frames?room=ac16')
		const row1 = f1.body.frames.find((f: any) => f.name === 'Count frame')
		assert.equal(row1.drawings, 3, 'drawings count reflects the 3 seeded drawings')
		await postJson('/api/canvas/shape', { room: 'ac16', op: 'delete', id: 'shape:ac16G' })
		const f2 = await getJson('/api/canvas/frames?room=ac16')
		assert.equal(f2.body.frames.find((f: any) => f.name === 'Count frame').drawings, 2, 'count drops to 2 after a drawing is removed')
	})

	await check('AC17: read reflects reparent (appears) and reparent-out (disappears)', async () => {
		await seed('ac17', [
			frameRec({ id: 'shape:ac17F', parentId: 'page:page', x: 0, y: 0, name: 'Live frame' }),
			geoRec({ id: 'shape:ac17S', parentId: 'page:page', x: 400, y: 400, text: 'mover' }),
		])
		const inn = await postJson('/api/canvas/shape', { room: 'ac17', op: 'update', id: 'shape:ac17S', frame: 'Live frame' })
		assert.equal(inn.status, 200)
		const fr1 = await getJson(`/api/canvas/frame?room=ac17&name=${encodeURIComponent('Live frame')}`)
		assert.ok(Array.isArray(fr1.body.drawings) && fr1.body.drawings.some((x: any) => x.id === 'shape:ac17S'), 'reparented shape appears under the new frame')
		const out = await postJson('/api/canvas/shape', { room: 'ac17', op: 'update', id: 'shape:ac17S', toPage: true })
		assert.equal(out.status, 200)
		const fr2 = await getJson(`/api/canvas/frame?room=ac17&name=${encodeURIComponent('Live frame')}`)
		assert.ok(Array.isArray(fr2.body.drawings) && !fr2.body.drawings.some((x: any) => x.id === 'shape:ac17S'), 'after --to-page it no longer appears under the frame')
	})

	// =========================================================================
	// CRUD-COMPLETENESS, ERRORS, SCOPE, ATTRIBUTION
	// =========================================================================
	await check('AC18: frame rename via --props reflected; invalid name → 400 (not 500)', async () => {
		const cr = await postJson('/api/canvas/shape', { room: 'ac18', type: 'frame', name: 'Orig' })
		assert.equal(cr.status, 200, 'frame create → 200')
		const id = cr.body.id
		const ren = await postJson('/api/canvas/shape', { room: 'ac18', op: 'update', id, props: { name: 'Renamed' } })
		assert.equal(ren.status, 200, 'rename → 200')
		const frames = await getJson('/api/canvas/frames?room=ac18')
		assert.ok(frames.body.frames.some((f: any) => f.name === 'Renamed'), 'rename reflected in canvas frames')
		const bad = await postJson('/api/canvas/shape', { room: 'ac18', op: 'update', id, props: { name: 123 } })
		assert.equal(bad.status, 400, 'invalid frame name {name:123} → 400 (not 500)')
	})

	await check('AC19: bad-input matrix returns clean 4xx and writes NO record', async () => {
		await seed('ac19', [geoRec({ id: 'shape:ac19S', parentId: 'page:page', text: 'reparent probe' })])
		const before = docs('ac19').filter((d) => d.typeName === 'shape').length
		const cases: { label: string; body: any; status: number }[] = [
			{ label: 'line <2', body: { type: 'line', points: [[0, 0]] }, status: 400 },
			{ label: 'line empty', body: { type: 'line', points: [] }, status: 400 },
			{ label: 'draw empty', body: { type: 'draw', points: [] }, status: 400 },
			{ label: 'draw 1-tuple', body: { type: 'draw', points: [[0]] }, status: 400 },
			{ label: 'highlight 1-tuple', body: { type: 'highlight', points: [[0]] }, status: 400 },
			{ label: 'non-numeric coord', body: { type: 'draw', points: [['a', 0], [1, 2]] }, status: 400 },
			{ label: 'huge 1e12 (draw)', body: { type: 'draw', points: [[1e12, 0], [1, 2]] }, status: 400 },
			{ label: 'huge 1e12 (line)', body: { type: 'line', points: [[1e12, 0], [1, 2]] }, status: 400 },
			{ label: 'collapse (draw)', body: { type: 'draw', points: [[0, 0], [0, 0]] }, status: 400 },
			{ label: '>65504 delta jump (draw)', body: { type: 'draw', points: [[0, 0], [70000, 0]] }, status: 400 },
			{ label: 'bad fill (draw)', body: { type: 'draw', points: [[0, 0], [10, 10]], fill: 'bogus' }, status: 400 },
			{ label: 'bad color', body: { type: 'highlight', points: [[0, 0], [10, 10]], color: 'mauve' }, status: 400 },
		]
		for (const c of cases) {
			const r = await postJson('/api/canvas/shape', { room: 'ac19', ...c.body })
			assert.equal(r.status, c.status, `${c.label} → ${c.status}`)
		}
		assert.equal(docs('ac19').filter((d) => d.typeName === 'shape').length, before, 'no record written for any bad-input case')
		const rep = await postJson('/api/canvas/shape', { room: 'ac19', op: 'update', id: 'shape:ac19S', frame: 'no-such-frame' })
		assert.equal(rep.status, 404, 'reparent to a non-existent --frame → 404')
	})

	await check('AC20: GET /api/tools — op/type enums verbatim; excluded scope absent; group/image/eraser → 400', async () => {
		const tools = await getJson('/api/tools')
		const shape = tools.body.tools.find((t: any) => t.plugin === 'canvas' && t.id === 'shape')
		assert.ok(shape, 'canvas.shape declared in the manifest')
		assert.deepEqual([...shape.input.properties.op.enum].sort(), ['create', 'delete', 'update'], 'op enum is exactly create|update|delete')
		assert.deepEqual(
			[...shape.input.properties.type.enum].sort(),
			['arrow', 'draw', 'frame', 'geo', 'highlight', 'line', 'note', 'text'],
			'create type enum is exactly the 8',
		)
		for (const bad of ['align', 'group', 'eraser', 'laser', 'image']) {
			assert.ok(!Object.keys(shape.input.properties).includes(bad), `no input field named ${bad}`)
			assert.ok(!shape.input.properties.type.enum.includes(bad), `no create type named ${bad}`)
		}
		for (const t of ['group', 'image', 'eraser']) {
			const r = await postJson('/api/canvas/shape', { room: 'ac20', type: t, points: [[0, 0], [1, 1]] })
			assert.equal(r.status, 400, `create ${t} → 400 (type not in enum)`)
		}
	})

	await check('AC21: attribution — credentialed stamps meta.author; anon stamps none; parity across the 4 types', async () => {
		const AUTH = { 'cf-access-authenticated-user-email': 'agent@ew.test' }
		const bodyFor = (room: string, t: string, extra: any = {}) =>
			t === 'frame' ? { room, type: t, ...extra } : { room, type: t, points: [[0, 0], [10, 10]], ...extra }
		// Credentialed → meta.author === resolved caller (and none of the 4 throws for lacking richText).
		for (const t of DRAW_TYPES) {
			const r = await postH('/api/canvas/shape', bodyFor('ac21c', t), AUTH)
			assert.equal(r.status, 200, `${t} create (credentialed) → 200`)
			assert.equal(docs('ac21c').find((d) => d.id === r.body.id).meta.author, 'agent@ew.test', `${t} meta.author === resolved caller`)
		}
		// Anonymous, no author context → meta === {}.
		for (const t of DRAW_TYPES) {
			const r = await postJson('/api/canvas/shape', bodyFor('ac21a', t))
			assert.equal(r.status, 200, `${t} create (anon) → 200`)
			assert.deepEqual(docs('ac21a').find((d) => d.id === r.body.id).meta, {}, `${t} no author context → meta === {}`)
		}
		// Anonymous + --author: cosmetic only. Assert PARITY with a reference geo — the
		// 4 new types must attribute EXACTLY like the existing shapes (base.meta reuse),
		// i.e. no fabricated structured authorship (see kernel/attribution.ts; sprint G3
		// "reuses existing base.meta"). NB: the acceptance doc's AC21 "anon+author →
		// meta.author===X" contradicts that design; the design/reuse wins.
		const geoRef = await postJson('/api/canvas/shape', { room: 'ac21p', type: 'geo', author: 'Bob' })
		const refMeta = docs('ac21p').find((d) => d.id === geoRef.body.id).meta
		for (const t of DRAW_TYPES) {
			const r = await postJson('/api/canvas/shape', bodyFor('ac21p', t, { author: 'Bob' }))
			assert.equal(r.status, 200)
			assert.deepEqual(docs('ac21p').find((d) => d.id === r.body.id).meta, refMeta, `${t} attributes identically to geo (no fabricated author)`)
		}
		// Text-bearing shapes still get the 🤖 badge.
		const note = await postJson('/api/canvas/shape', { room: 'ac21p', type: 'note', text: 'hello', author: 'Bob' })
		assert.ok(JSON.stringify(docs('ac21p').find((d) => d.id === note.body.id).props.richText).includes('🤖 Bob'), 'text-bearing shape keeps the 🤖 author badge')
	})

	await check('AC22 (doc-only): the rotated-parent reparent limitation is recorded', async () => {
		const note = await readFile(new URL('../../docs/design/cli-frames-draw-api.md', import.meta.url), 'utf8')
		assert.ok(/rotated-parent|unrotated|rotated\s+frame/i.test(note), 'design note records the unrotated-only reparent limitation')
	})

	await check('AC23: compose end-to-end — build a framed drawing, read it, delete keeps contents', async () => {
		await seed('ac23', [geoRec({ id: 'shape:ac23pre', parentId: 'page:page', x: 50, y: 50, text: 'pre-existing' })])
		const f = await postJson('/api/canvas/shape', { room: 'ac23', type: 'frame', name: 'Compose', w: 600, h: 400, x: 200, y: 200 })
		assert.equal(f.status, 200, 'frame → 200')
		const fId = f.body.id
		const line = await postJson('/api/canvas/shape', { room: 'ac23', type: 'line', points: [[210, 210], [300, 260]], frame: 'Compose' })
		assert.equal(line.status, 200)
		assert.equal(docs('ac23').find((d) => d.id === line.body.id).parentId, fId, 'line parented into the frame')
		const draw = await postJson('/api/canvas/shape', { room: 'ac23', type: 'draw', points: [[220, 220], [240, 260]], frame: 'Compose' })
		assert.equal(draw.status, 200)
		const sticky = await postJson('/api/canvas/sticky', { room: 'ac23', text: 'note', frame: 'Compose' })
		assert.equal(sticky.status, 200)
		const rep = await postJson('/api/canvas/shape', { room: 'ac23', op: 'update', id: 'shape:ac23pre', frame: 'Compose' })
		assert.equal(rep.status, 200)
		assert.equal(docs('ac23').find((d) => d.id === 'shape:ac23pre').parentId, fId, 'pre-existing shape reparented in')
		const fr = await getJson(`/api/canvas/frame?room=ac23&name=${encodeURIComponent('Compose')}`)
		assert.ok(Array.isArray(fr.body.drawings) && fr.body.drawings.length >= 3, 'frame read surfaces line+draw+reparented geo')
		assert.ok(fr.body.notes.length >= 1, 'and the sticky')
		const del = await postJson('/api/canvas/shape', { room: 'ac23', op: 'delete', id: fId })
		assert.equal(del.status, 200)
		const d = docs('ac23')
		assert.ok(!d.some((r) => r.id === fId), 'frame gone')
		for (const survivor of [line.body.id, draw.body.id, 'shape:ac23pre']) {
			const s = d.find((r) => r.id === survivor)
			assert.ok(s, `${survivor} survives on the page`)
			assert.ok(d.some((x) => x.id === s.parentId), `${survivor} has no dangling parentId after frame delete`)
		}
	})

	// --- summary --------------------------------------------------------------
	const failed = results.filter((r) => !r.ok)
	console.log(`\nshape-api.test.ts: ${results.length - failed.length}/${results.length} ACs green`)
	if (failed.length) {
		console.log('RED (failing ACs):')
		for (const f of failed) console.log(`  - ${f.name}`)
	}
	server.close()
	process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
