// Pilot 1 — the scroll-direction contract. A wheel-down gesture (positive DOM
// deltaY, input.ts's SIGN CONVENTION) must REVEAL CONTENT BELOW: the top edge
// of the visible world rectangle moves DOWN in world space (its minY
// increases). This is the user-meaningful semantics, independent of the camera
// formula's internals.
import type { Contract, Obs, Rng } from '../types.js'

export const scrollDirection: Contract = {
  name: 'scroll-direction-reveals-below',
  level: 'fsm',
  when: 'every-event',
  gesture: (_rng: Rng) => [
    // A single wheel-DOWN tick at the viewport centre. (Seeding the magnitude
    // is a Pilot-2 concern; direction is all pilot 1 needs.)
    { kind: 'wheel', dx: 0, dy: 100, at: { ref: 'point', x: 640, y: 360 } },
  ],
  check: (obs: Obs): string | null => {
    const start = obs.visibleWorldRectAtStart()
    const now = obs.visibleWorldRect()
    return now.minY > start.minY
      ? null
      : `wheel-down did not reveal content below: visible top minY ${start.minY} -> ${now.minY} (expected to INCREASE)`
  },
}
