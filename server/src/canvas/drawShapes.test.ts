// Pure-helper unit contract for EW-CLI-DRAW-0001 (Navigator RED).
// Exercises server/src/canvas/drawShapes.ts in isolation — no HTTP, no store.
// Every assertion pins the REAL expected value a correct implementation must
// produce; a broken encoder / index scheme / translation must fail here.
//
// Numbers are grounded against the installed tldraw 5.1.0 helpers
// (compressLegacySegments / b64Vecs.decodePoints / getIndicesAbove), verified
// empirically before writing (see docs/design/cli-frames-draw-api.md §7 + app.7).
//
// Run with: bun src/canvas/drawShapes.test.ts
import assert from 'node:assert/strict'
import { b64Vecs, compressLegacySegments } from '@tldraw/tlschema'
import { sortByIndex } from '@tldraw/utils'
import { T } from '@tldraw/validate'
import {
	buildLinePoints,
	buildSegments,
	originOf,
	parsePoints,
	toLocal,
	translateForReparent,
	type Vec,
} from './drawShapes.ts'

// Decode a segment's base64 path back to points (the real tldraw round-trip).
const decode = (path: string): { x: number; y: number }[] =>
	(b64Vecs as any).decodePoints(path)

// Max per-axis error between two point sequences.
const maxErr = (a: { x: number; y: number }[], b: { x: number; y: number }[]): number =>
	Math.max(...a.map((p, i) => Math.max(Math.abs(p.x - b[i]!.x), Math.abs(p.y - b[i]!.y))))

async function main() {
	// -----------------------------------------------------------------------
	// parsePoints — the single input guard (line + draw + highlight)
	// -----------------------------------------------------------------------
	{
		// Good input round-trips to VecModels (AC4/AC5/AC6 happy path).
		const good = parsePoints([[0, 0], [120, 0]], 2)
		assert.equal(good.length, 2, 'two points in ⇒ two points out')
		assert.equal(good[0]!.x, 0, 'p0.x')
		assert.equal(good[0]!.y, 0, 'p0.y')
		assert.equal(good[1]!.x, 120, 'p1.x')
		assert.equal(good[1]!.y, 0, 'p1.y')

		// A three-tuple carries pen pressure through as z.
		const withZ = parsePoints([[0, 0, 0.7], [120, 0, 0.3]], 2)
		assert.equal(withZ[0]!.z, 0.7, 'pressure z survives on a triple')

		// Non-collinear polyline preserves order + coords.
		const poly = parsePoints([[0, 0], [120, 60], [200, 0]], 2)
		assert.equal(poly.length, 3, 'three-vertex polyline parses')
		assert.equal(poly[1]!.x, 120)
		assert.equal(poly[2]!.x, 200)

		// --- the AC19 rejection matrix: each throws (→ 400 at the HTTP layer) ---
		assert.throws(() => parsePoints('nope' as any, 2), 'non-array raw throws')
		assert.throws(() => parsePoints(42 as any, 2), 'non-array number throws')
		assert.throws(() => parsePoints({} as any, 2), 'non-array object throws')
		assert.throws(() => parsePoints([], 2), 'empty array throws (< min)')
		assert.throws(() => parsePoints([[0, 0]], 2), 'single point throws (< min 2)')
		assert.throws(() => parsePoints([[0, 0], [1, 0], [2, 0]], 4), 'below explicit min throws')
		assert.throws(() => parsePoints([[0]], 2), 'a 1-tuple point throws')
		assert.throws(() => parsePoints([[0, 0, 0, 0]], 2) as any, 'a 4-tuple point throws')
		assert.throws(() => parsePoints([['a', 0], [1, 2]] as any, 2), 'non-numeric coord throws')
		assert.throws(() => parsePoints([[0, Number.NaN], [1, 2]], 2), 'NaN coord throws')
		assert.throws(() => parsePoints([[0, Number.POSITIVE_INFINITY], [1, 2]], 2), 'Infinity coord throws')
		assert.throws(() => parsePoints([[1e12, 0], [1, 2]], 2), '|coord| > 1e6 throws (1e12)')
		assert.throws(() => parsePoints([[-1e12, 0], [1, 2]], 2), '|coord| > 1e6 throws (-1e12)')
		assert.throws(() => parsePoints([[0, 0], [0, 0]], 2), 'fewer than 2 distinct points throws (collapse)')
		console.log('ok: parsePoints validates count/finiteness/magnitude/distinctness')
	}

	// -----------------------------------------------------------------------
	// buildSegments — base64 delta-encoded path + the LOAD-BEARING Float16 guard
	// -----------------------------------------------------------------------
	{
		// (a) Round-trip fidelity for real (small) strokes: decode(path) ≈ input.
		//     These are the exact AC5/AC6 inputs; the encoder must reproduce them.
		const ac5 = [{ x: 0, y: 0 }, { x: 40, y: 10 }, { x: 80, y: 60 }] as Vec[]
		const s5 = buildSegments(ac5)
		assert.ok(Array.isArray(s5) && s5.length >= 1, 'buildSegments returns ≥1 segment')
		assert.equal(typeof s5[0]!.path, 'string', 'segment.path is a base64 string')
		const d5 = decode(s5[0]!.path)
		assert.ok(maxErr(d5, ac5) <= 1, `AC5 draw decodes within ±1px (got ${maxErr(d5, ac5)})`)

		const ac6 = [{ x: 0, y: 0 }, { x: 120, y: 0 }] as Vec[] // zero y-extent highlight
		const d6 = decode(buildSegments(ac6)[0]!.path)
		assert.ok(maxErr(d6, ac6) <= 1, `AC6 zero-y highlight decodes within ±1px (got ${maxErr(d6, ac6)})`)

		// (b) The Float16 delta ceiling (65504). The consecutive delta 70000 overflows
		//     to Infinity in the stored path even though every |coord| ≤ 1e6, so
		//     buildSegments MUST throw. This is the defect that failed the adversarial
		//     gate — an unguarded compressLegacySegments returns 200 with a garbage path.
		assert.throws(
			() => buildSegments([{ x: 0, y: 0 }, { x: 70000, y: 0 }]),
			'consecutive delta 70000 > 65504 throws (Float16 overflow guard)',
		)
		// Just below the ceiling: succeeds and decodes FINITE (precision degrades to
		// ~8px at 65000 — Float16 delta precision, NOT ±1px; assert finiteness, the
		// load-bearing distinction from the overflow case above).
		const big = decode(buildSegments([{ x: 0, y: 0 }, { x: 65000, y: 0 }])[0]!.path)
		assert.ok(
			big.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
			'65000 delta stays finite (below the 65504 ceiling)',
		)
		const small = decode(buildSegments([{ x: 0, y: 0 }, { x: 120, y: 0 }])[0]!.path)
		assert.ok(maxErr(small, [{ x: 0, y: 0 }, { x: 120, y: 0 }]) <= 1, '120px stroke decodes ±1px')

		// Sanity: the decode oracle itself flags the overflow (proves the guard is
		// necessary — the raw encoder would NOT throw on 70000, it corrupts silently).
		const raw = compressLegacySegments([{ type: 'free', points: [{ x: 0, y: 0 }, { x: 70000, y: 0 }] }] as any)
		assert.ok(
			decode(raw[0]!.path).some((p) => !Number.isFinite(p.x)),
			'oracle: unguarded encode of 70000 yields a non-finite decoded point',
		)
		console.log('ok: buildSegments round-trips small strokes ±1px and guards the 65504 Float16 ceiling')
	}

	// -----------------------------------------------------------------------
	// buildLinePoints — keyed dict of valid IndexKeys (key === id === index)
	// -----------------------------------------------------------------------
	{
		const input = [{ x: 0, y: 0 }, { x: 120, y: 60 }, { x: 200, y: 0 }] as Vec[]
		const dict = buildLinePoints(input)
		const pairs = Object.entries(dict)
		assert.equal(pairs.length, 3, 'N points ⇒ N dict entries')
		for (const [key, v] of pairs) {
			assert.ok(T.indexKey.isValid(v.index), `index ${v.index} is a valid IndexKey`)
			assert.equal(key, v.id, 'dict key === point.id')
			assert.equal(key, v.index, 'dict key === point.index (tldraw convention)')
		}
		// Do NOT assert literal 'a1'/'a2' — getIndicesAbove jitters keys outside
		// NODE_ENV==='test'. Assert validity + that sorting by index reproduces order.
		const sorted = Object.values(dict).sort(sortByIndex as any)
		assert.deepEqual(
			sorted.map((p) => [p.x, p.y]),
			[[0, 0], [120, 60], [200, 0]],
			'sort by index reproduces the input vertex order + coords',
		)
		console.log('ok: buildLinePoints builds a valid-IndexKey dict that sorts back to input order')
	}

	// -----------------------------------------------------------------------
	// originOf / toLocal — bbox-min normalization (AC7 by construction)
	// -----------------------------------------------------------------------
	{
		const pts = [{ x: 10, y: 20 }, { x: 130, y: 20 }, { x: 130, y: 80 }] as Vec[]
		const o = originOf(pts)
		assert.equal(o.x, 10, 'origin.x = min x')
		assert.equal(o.y, 20, 'origin.y = min y')
		const local = toLocal(pts, o)
		assert.deepEqual(
			local.map((p) => [p.x, p.y]),
			[[0, 0], [120, 0], [120, 60]],
			'toLocal re-anchors the bbox top-left at (0,0)',
		)
		console.log('ok: originOf/toLocal normalize to a local bbox-min origin')
	}

	// -----------------------------------------------------------------------
	// translateForReparent — preserve page position across a parent change
	// -----------------------------------------------------------------------
	{
		// Synthetic store: page p1, frame F at page (1000,0), nested frame G at
		// page (1100,100), free shape S at page (50,30).
		const page = { id: 'page:p1', typeName: 'page' }
		const F = { id: 'shape:F', typeName: 'shape', type: 'frame', parentId: 'page:p1', x: 1000, y: 0 }
		const G = { id: 'shape:G', typeName: 'shape', type: 'frame', parentId: 'shape:F', x: 100, y: 100 }
		const S = { id: 'shape:S', typeName: 'shape', type: 'geo', parentId: 'page:p1', x: 50, y: 30 }
		const byId = new Map<string, any>([
			[page.id, page], [F.id, F], [G.id, G], [S.id, S],
		])

		// page → frame F: new local = page-point(50,30) − frame page-point(1000,0).
		const intoF = translateForReparent(S, 'shape:F', byId)
		assert.equal(intoF.x, -950, 'reparent into F: local x = 50 − 1000')
		assert.equal(intoF.y, 30, 'reparent into F: local y = 30 − 0')

		// A shape already local to F, back out to the page: local becomes its page-point.
		const S2 = { id: 'shape:S2', typeName: 'shape', type: 'geo', parentId: 'shape:F', x: -950, y: 30 }
		byId.set(S2.id, S2)
		const toPage = translateForReparent(S2, 'page:p1', byId)
		assert.equal(toPage.x, 50, 'reparent to page: local x = restored page-point 50')
		assert.equal(toPage.y, 30, 'reparent to page: local y = 30')

		// page → nested frame G (page-point 1100,100): local = (50−1100, 30−100).
		const intoG = translateForReparent(S, 'shape:G', byId)
		assert.equal(intoG.x, -1050, 'reparent into nested G: local x = 50 − 1100')
		assert.equal(intoG.y, -70, 'reparent into nested G: local y = 30 − 100')
		console.log('ok: translateForReparent preserves page position for frame↔page moves')
	}
}

main().then(
	() => {
		console.log('drawShapes.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	},
)
