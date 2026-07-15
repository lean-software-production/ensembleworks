/**
 * Tiny dependency-free test for the spatial gain model.
 * Run with: bun src/av/spatial.test.ts
 */
import {
	DEFAULT_SCREEN_SPATIAL_SETTINGS,
	DEFAULT_SPATIAL_SETTINGS,
	distance,
	gainForDistance,
	gainForScreenDistance,
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

// --- screen-space (viewport-relative) gain ------------------------------

const ss = DEFAULT_SCREEN_SPATIAL_SETTINGS // huddleFraction 0.45, falloffFraction 1.6, floor 0.04
// A 1600×1200 viewport: halfDiagonal = 1000 px → huddle 450 px, falloff end 1600 px.
const halfDiag = 1000

expectClose(
	'zero page distance is full volume at any zoom',
	gainForScreenDistance(0, 0.1, halfDiag, ss),
	1
)
expectClose(
	'inside huddle at zoom 1 (400px screen) is full volume',
	gainForScreenDistance(400, 1, halfDiag, ss),
	1
)
expectClose(
	'beyond falloff end at zoom 1 (2000px screen) is the floor',
	gainForScreenDistance(2000, 1, halfDiag, ss),
	0.04
)

// Zoom is reach: the SAME page distance is louder when zoomed out.
{
	const zoomedIn = gainForScreenDistance(1200, 2, halfDiag, ss) // 2400px screen
	const zoomedOut = gainForScreenDistance(1200, 0.2, halfDiag, ss) // 240px screen
	if (!(zoomedOut > zoomedIn)) {
		throw new Error(`zooming out must raise gain: out=${zoomedOut} in=${zoomedIn}`)
	}
	expectClose('fully zoomed out pulls a far peer into the huddle', zoomedOut, 1)
	console.log('PASS: zoom is reach (same page distance, higher gain when zoomed out)')
}

// Equivalence with the page-space curve: screen settings are just
// gainForDistance with pixel radii derived from the half-diagonal.
expectClose(
	'screen-space midpoint matches gainForDistance with derived radii',
	gainForScreenDistance(1025, 1, halfDiag, ss),
	gainForDistance(1025, { huddleRadius: 450, falloffEnd: 1600, floor: 0.04 })
)

// Guards: non-finite inputs and a degenerate viewport fall back to the floor.
expectClose('NaN page distance → floor', gainForScreenDistance(NaN, 1, halfDiag, ss), 0.04)
expectClose('NaN zoom → floor', gainForScreenDistance(100, NaN, halfDiag, ss), 0.04)
expectClose('zero half-diagonal → floor', gainForScreenDistance(100, 1, 0, ss), 0.04)

console.log('ALL SPATIAL AUDIO TESTS PASSED')
