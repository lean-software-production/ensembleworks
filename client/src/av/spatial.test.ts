/**
 * Tiny dependency-free test for the spatial gain model.
 * Run with: bun src/av/spatial.test.ts
 */
import {
	DEFAULT_SPATIAL_SETTINGS,
	DEFAULT_VIEWPORT_SPATIAL_SETTINGS,
	distance,
	gainForDistance,
	gainForViewportDistance,
	screenDistanceOutsideRect,
} from './spatial'

function expectClose(label: string, actual: number, expected: number, eps = 1e-9) {
	if (Math.abs(actual - expected) > eps) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`)
	}
	console.log(`PASS: ${label} = ${actual}`)
}

const s = DEFAULT_SPATIAL_SETTINGS // huddleRadius 600, falloffEnd 3500, floor 0.04

expectClose('inside huddle radius is full volume', gainForDistance(0, s), 1)
expectClose('at huddle radius is full volume', gainForDistance(600, s), 1)
expectClose('beyond falloff end is the floor', gainForDistance(5000, s), 0.04)
expectClose('midpoint of falloff is halfway to floor', gainForDistance(2050, s), 1 - (1 - 0.04) / 2)
expectClose('NaN distance falls back to floor', gainForDistance(NaN, s), 0.04)

const g1 = gainForDistance(1000, s)
const g2 = gainForDistance(2000, s)
if (!(g1 > g2)) throw new Error('gain must decrease with distance')
console.log('PASS: gain is monotonically decreasing')

expectClose('distance is euclidean', distance(0, 0, 3, 4), 5)

// --- viewport-rect (screen-space) gain -----------------------------------

const vs = DEFAULT_VIEWPORT_SPATIAL_SETTINGS // falloffFraction 1, floor 0.04
// A 1600×1200 page-space viewport at zoom 1: halfDiagonal = 1000 px.
const halfDiag = 1000
const rect = { minX: 0, minY: 0, maxX: 1600, maxY: 1200 }

// Distance-outside-rect geometry.
expectClose('cursor inside the viewport is distance 0', screenDistanceOutsideRect(800, 600, rect, 1), 0)
expectClose('cursor ON the viewport edge is distance 0', screenDistanceOutsideRect(1600, 600, rect, 1), 0)
expectClose(
	'beyond one edge is the straight-line shortfall',
	screenDistanceOutsideRect(1900, 600, rect, 1),
	300
)
expectClose(
	'beyond a corner is the euclidean shortfall',
	screenDistanceOutsideRect(1900, 1600, rect, 1),
	500
)
expectClose(
	'zoom scales the page shortfall to screen pixels',
	screenDistanceOutsideRect(1900, 600, rect, 2),
	600
)

// Gain: the rect IS the huddle — anywhere in view is full volume.
expectClose('cursor in view is full volume', gainForViewportDistance(0, halfDiag, vs), 1)
expectClose(
	'at falloffFraction × half-diagonal past the edge it is the floor',
	gainForViewportDistance(1000, halfDiag, vs),
	0.04
)
expectClose(
	'halfway out is halfway to the floor',
	gainForViewportDistance(500, halfDiag, vs),
	1 - (1 - 0.04) / 2
)

{
	const near = gainForViewportDistance(200, halfDiag, vs)
	const far = gainForViewportDistance(700, halfDiag, vs)
	if (!(near > far)) throw new Error(`gain must decrease beyond the viewport: ${near} vs ${far}`)
	console.log('PASS: gain decreases with distance beyond the viewport')
}

// Continuity at the boundary: stepping just outside barely changes the gain
// (no cliff at the viewport edge).
{
	const justOutside = gainForViewportDistance(1, halfDiag, vs)
	if (!(justOutside > 0.99)) {
		throw new Error(`crossing the edge must not cliff: gain(1px out) = ${justOutside}`)
	}
	console.log('PASS: no cliff at the viewport edge')
}

// Guards: non-finite inputs and a degenerate viewport fall back to the floor.
expectClose('NaN outside-distance → floor', gainForViewportDistance(NaN, halfDiag, vs), 0.04)
expectClose('zero half-diagonal → floor', gainForViewportDistance(100, 0, vs), 0.04)

console.log('ALL SPATIAL AUDIO TESTS PASSED')
