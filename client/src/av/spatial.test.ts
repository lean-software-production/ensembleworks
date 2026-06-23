/**
 * Tiny dependency-free test for the spatial gain model.
 * Run with: npx tsx src/av/spatial.test.ts
 */
import { DEFAULT_SPATIAL_SETTINGS, distance, gainForDistance } from './spatial'

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

console.log('ALL SPATIAL AUDIO TESTS PASSED')
