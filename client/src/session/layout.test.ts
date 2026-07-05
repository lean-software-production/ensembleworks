/**
 * Tiny dependency-free test for the session layout geometry.
 * Run with: bun src/session/layout.test.ts
 *
 * Covers the 9 invariants from docs/session-mvp-plan.md, Cycle 1.
 */
import assert from 'node:assert/strict'
import { DEFAULT_SPATIAL_SETTINGS, distance } from '../av/spatial'
import { computeSessionLayout, type SessionLayout, type Vec } from './layout'

const { huddleRadius, falloffEnd } = DEFAULT_SPATIAL_SETTINGS

const CENTERS: Vec[] = [
	{ x: 0, y: 0 },
	{ x: 5000, y: -3000 },
]
const CREW_COUNTS = [2, 3, 4]

function dist(a: Vec, b: Vec): number {
	return distance(a.x, a.y, b.x, b.y)
}

function centroid(points: Vec[]): Vec {
	const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
	return { x: sum.x / points.length, y: sum.y / points.length }
}

/** Run a check for every (crews, center) combination, labelled per case. */
function forEachLayout(check: (layout: SessionLayout, label: string, center: Vec) => void) {
	for (const crews of CREW_COUNTS) {
		for (const center of CENTERS) {
			const label = `crews=${crews} center=(${center.x},${center.y})`
			check(computeSessionLayout({ crews, center }), label, center)
		}
	}
}

// ── Invariant 1: crew count ────────────────────────────────────────────────
// Works for 2, 3, 4 crews; throws RangeError for 1 and 5.

for (const crews of CREW_COUNTS) {
	const layout = computeSessionLayout({ crews, center: { x: 0, y: 0 } })
	assert.equal(layout.crews.length, crews, `expected ${crews} crew zones`)
}
for (const crews of [1, 5]) {
	assert.throws(
		() => computeSessionLayout({ crews, center: { x: 0, y: 0 } }),
		RangeError,
		`crews=${crews} must throw RangeError`
	)
}
console.log('PASS: invariant 1 — crew count (2..4 ok, 1 and 5 throw RangeError)')

// ── Invariant 2: murmur band ───────────────────────────────────────────────
// Pairwise distance between crew zone centres is > 2*huddleRadius (rings
// never overlap) and < falloffEnd (you always hear the murmur).

forEachLayout((layout, label) => {
	for (let i = 0; i < layout.crews.length; i++) {
		for (let j = i + 1; j < layout.crews.length; j++) {
			const d = dist(layout.crews[i].center, layout.crews[j].center)
			assert.ok(
				d > 2 * huddleRadius,
				`${label}: crews ${i},${j} centres only ${d} apart — rings overlap (need > ${2 * huddleRadius})`
			)
			assert.ok(
				d < falloffEnd,
				`${label}: crews ${i},${j} centres ${d} apart — murmur lost (need < ${falloffEnd})`
			)
		}
	}
})
console.log('PASS: invariant 2 — murmur band between crew zone centres')

// ── Invariant 3: out of earshot ────────────────────────────────────────────
// Every pair-huddle centre is > falloffEnd from every crew zone centre,
// from the Brief Lessons frame, and from every other pair huddle.

forEachLayout((layout, label) => {
	assert.equal(
		layout.pairHuddles.length,
		layout.crews.length,
		`${label}: one pair huddle per crew`
	)
	layout.pairHuddles.forEach((huddle, h) => {
		layout.crews.forEach((zone, z) => {
			const d = dist(huddle, zone.center)
			assert.ok(
				d > falloffEnd,
				`${label}: pair huddle ${h} only ${d} from crew ${z} centre (need > ${falloffEnd})`
			)
		})
		const dBrief = dist(huddle, layout.briefLessons)
		assert.ok(
			dBrief > falloffEnd,
			`${label}: pair huddle ${h} only ${dBrief} from Brief Lessons (need > ${falloffEnd})`
		)
		for (let k = h + 1; k < layout.pairHuddles.length; k++) {
			const d = dist(huddle, layout.pairHuddles[k])
			assert.ok(
				d > falloffEnd,
				`${label}: pair huddles ${h},${k} only ${d} apart (need > ${falloffEnd})`
			)
		}
	})
})
console.log('PASS: invariant 3 — pair huddles out of earshot')

// ── Invariant 4: painted ring ──────────────────────────────────────────────
// ringRadius === huddleRadius for every zone.

forEachLayout((layout, label) => {
	for (const zone of layout.crews) {
		assert.equal(
			zone.ringRadius,
			huddleRadius,
			`${label}: zone ${zone.index} ringRadius must equal huddleRadius`
		)
	}
})
console.log('PASS: invariant 4 — painted ring radius equals huddleRadius')

// ── Invariant 5: parking spot ──────────────────────────────────────────────
// Distance from zone centre is strictly between huddleRadius and
// 1.5 * huddleRadius (just outside the ring).

forEachLayout((layout, label) => {
	for (const zone of layout.crews) {
		const d = dist(zone.parkingSpot, zone.center)
		assert.ok(
			d > huddleRadius && d < 1.5 * huddleRadius,
			`${label}: zone ${zone.index} parking spot at ${d} from centre (need strictly between ${huddleRadius} and ${1.5 * huddleRadius})`
		)
	}
})
console.log('PASS: invariant 5 — parking spot just outside the ring')

// ── Invariant 6: sightline rule ────────────────────────────────────────────
// draftingTable-to-terminal distance >= 800, while both stay within
// huddleRadius + 200 of the zone centre.

forEachLayout((layout, label) => {
	for (const zone of layout.crews) {
		const dSightline = dist(zone.draftingTable, zone.terminal)
		assert.ok(
			dSightline >= 800,
			`${label}: zone ${zone.index} draftingTable↔terminal only ${dSightline} apart (need >= 800)`
		)
		const dDrafting = dist(zone.draftingTable, zone.center)
		assert.ok(
			dDrafting <= huddleRadius + 200,
			`${label}: zone ${zone.index} draftingTable ${dDrafting} from centre (need <= ${huddleRadius + 200})`
		)
		const dTerminal = dist(zone.terminal, zone.center)
		assert.ok(
			dTerminal <= huddleRadius + 200,
			`${label}: zone ${zone.index} terminal ${dTerminal} from centre (need <= ${huddleRadius + 200})`
		)
	}
})
console.log('PASS: invariant 6 — sightline rule (drafting table vs terminal)')

// ── Invariant 7: shared frames central ─────────────────────────────────────
// briefLessons and ranking are each within 2*huddleRadius of the centroid
// of crew zone centres.

forEachLayout((layout, label) => {
	const c = centroid(layout.crews.map((z) => z.center))
	const dBrief = dist(layout.briefLessons, c)
	assert.ok(
		dBrief <= 2 * huddleRadius,
		`${label}: briefLessons ${dBrief} from centroid (need <= ${2 * huddleRadius})`
	)
	const dRanking = dist(layout.ranking, c)
	assert.ok(
		dRanking <= 2 * huddleRadius,
		`${label}: ranking ${dRanking} from centroid (need <= ${2 * huddleRadius})`
	)
})
console.log('PASS: invariant 7 — shared frames near the crew centroid')

// ── Invariant 8: determinism ───────────────────────────────────────────────
// Two calls with the same options return deeply equal results.

for (const crews of CREW_COUNTS) {
	for (const center of CENTERS) {
		const a = computeSessionLayout({ crews, center })
		const b = computeSessionLayout({ crews, center })
		assert.deepEqual(
			a,
			b,
			`crews=${crews} center=(${center.x},${center.y}): repeated calls must be deeply equal`
		)
	}
}
console.log('PASS: invariant 8 — determinism')

// ── Invariant 9: centering ─────────────────────────────────────────────────
// The centroid of crew zone centres is within huddleRadius of opts.center.

forEachLayout((layout, label, center) => {
	const c = centroid(layout.crews.map((z) => z.center))
	const d = dist(c, center)
	assert.ok(
		d <= huddleRadius,
		`${label}: crew centroid ${d} from opts.center (need <= ${huddleRadius})`
	)
})
console.log('PASS: invariant 9 — layout centred on opts.center')

console.log('ALL SESSION LAYOUT TESTS PASSED')
