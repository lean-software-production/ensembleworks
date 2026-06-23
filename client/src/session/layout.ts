/**
 * Pure geometry for the augmented-session canvas layout.
 *
 * All distances derive from the spatial-audio model in ../av/spatial:
 * crew zones sit in the "murmur band" (rings never overlap, but every crew
 * stays audible), pair huddles sit fully out of earshot, and the painted
 * ring marks exactly the full-volume huddle radius.
 *
 * Deterministic: no randomness, no Date — same options, same layout.
 */
import { DEFAULT_SPATIAL_SETTINGS } from '../av/spatial'

export interface Vec {
	x: number
	y: number
}

export interface CrewZone {
	index: number // 0-based
	name: string // 'crew-a', 'crew-b', …
	center: Vec
	ringRadius: number // painted ring radius == huddleRadius
	draftingTable: Vec // top-left of the drafting frame
	launchPad: Vec // top-left of the launch-pad frame
	terminal: Vec // top-left of the terminal shape
	benchPreview: Vec // top-left of the preview iframe
	benchAdvice: Vec // top-left of the advice frame
	parkingSpot: Vec // centre of the ⊗ client parking marker
}

export interface SessionLayout {
	crews: CrewZone[]
	briefLessons: Vec // top-left of the shared Brief Lessons frame
	ranking: Vec // top-left of the 25/10 ranking frame
	pairHuddles: Vec[] // centres; one per crew, used in phases 1–2
}

const { huddleRadius, falloffEnd } = DEFAULT_SPATIAL_SETTINGS

/**
 * Crew zone centres sit on a circle of this radius around opts.center.
 *
 * For N crews evenly spaced, the closest pair is the adjacent chord
 * 2R·sin(π/N) and the farthest pair is at most the diameter 2R. R = 1450
 * keeps every pair inside the murmur band for N = 2..4:
 *   N=2: min = max = 2900        (1200 < 2900 < 3500)
 *   N=3: min = max ≈ 2511        (1200 < 2511 < 3500)
 *   N=4: min ≈ 2051, max = 2900  (1200 < 2051, 2900 < 3500)
 */
const CREW_CIRCLE_RADIUS = 1450

/**
 * Pair huddles sit on a much larger circle so that they are > falloffEnd
 * from every crew centre (worst case 9000 − 1450 = 7550), from the shared
 * frames near the centroid, and from each other (adjacent chord for N=4 is
 * 9000·√2 ≈ 12728).
 */
const PAIR_HUDDLE_RADIUS = 9000

/** Parking spot distance from the zone centre — just outside the ring. */
const PARKING_DISTANCE = huddleRadius * 1.25

export function computeSessionLayout(opts: { crews: number; center: Vec }): SessionLayout {
	const { crews, center } = opts
	if (!Number.isInteger(crews) || crews < 2 || crews > 4) {
		throw new RangeError(`crews must be an integer between 2 and 4, got ${crews}`)
	}

	const zones: CrewZone[] = []
	for (let i = 0; i < crews; i++) {
		// Start at the top of the circle and go clockwise.
		const angle = -Math.PI / 2 + (i * 2 * Math.PI) / crews
		const ux = Math.cos(angle)
		const uy = Math.sin(angle)
		const c: Vec = {
			x: center.x + CREW_CIRCLE_RADIUS * ux,
			y: center.y + CREW_CIRCLE_RADIUS * uy,
		}
		zones.push({
			index: i,
			name: `crew-${String.fromCharCode(97 + i)}`,
			center: c,
			ringRadius: huddleRadius,
			// Drafting table on the left, terminal on the right: 850 apart
			// (sightline rule, >= 800) while both stay inside huddleRadius +
			// 200 of the centre so the crew shares one audio huddle.
			draftingTable: { x: c.x - 650, y: c.y - 350 },
			terminal: { x: c.x + 200, y: c.y - 350 },
			launchPad: { x: c.x - 650, y: c.y + 420 },
			benchPreview: { x: c.x + 200, y: c.y + 80 },
			benchAdvice: { x: c.x + 850, y: c.y - 350 },
			// Just outside the painted ring, radially outward from the layout
			// centre so it never points into the middle of the room.
			parkingSpot: { x: c.x + PARKING_DISTANCE * ux, y: c.y + PARKING_DISTANCE * uy },
		})
	}

	// Shared frames in the open middle of the crew circle (the centroid of
	// the evenly spaced zones is exactly opts.center).
	const briefLessons: Vec = { x: center.x - 750, y: center.y - 520 }
	const ranking: Vec = { x: center.x + 50, y: center.y + 60 }

	// Pair huddles far out, on directions offset half a step from the crews.
	const pairHuddles: Vec[] = []
	for (let i = 0; i < crews; i++) {
		const angle = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / crews
		pairHuddles.push({
			x: center.x + PAIR_HUDDLE_RADIUS * Math.cos(angle),
			y: center.y + PAIR_HUDDLE_RADIUS * Math.sin(angle),
		})
	}

	return { crews: zones, briefLessons, ranking, pairHuddles }
}
