// Mobile-touch task, scope 1 — PINCH TO ZOOM. Two fingers spreading apart must
// zoom the canvas IN about the point between them: the visible world rectangle
// shrinks, and the world point under the midpoint of the two fingers does not
// move (that midpoint is what the user is holding — if it slides, the canvas
// feels like it is being pulled out of their hands).
//
// This is the user-meaningful half of the gesture; its sibling
// (pinch-does-not-drag-shapes) pins the other half — that the two touches never
// reach a tool as a drag.
//
// VIEWPORT LITERALS: the two fingers are placed symmetrically about (640, 360),
// the centre of the FSM runner's fixed 1280x720 viewport, so "the midpoint"
// IS the centre of the visible rect and the invariant can be expressed against
// `visibleWorldRect` alone (Obs exposes no viewport size). scroll-direction.ts
// sets the precedent for the literal and warns that a point-SENSITIVE contract
// must not copy it blindly — this one is point-sensitive and does so
// DELIBERATELY, which is also why it is level:'fsm' and can never be promoted
// to the browser lane unchanged: a real browser viewport is a different size.
//
// RED (recorded verbatim in the PR body before the fix landed): nothing in the
// input funnel recognizes two pointers, so both touches were handed to the
// select tool as one pointer teleporting around, the camera never changed at
// all, and the visible rect came back identical to its baseline.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

/** Centre of the FSM runner's fixed viewport — see the module header. */
const CX = 640
const CY = 360

export const pinchZoomsAboutTheMidpoint: Contract = {
  name: 'pinch-zooms-about-the-midpoint',
  level: 'fsm',
  when: 'at-end',
  gesture: (_rng: Rng): GestureOp[] => [
    // Two fingers 200px apart, centred on the viewport centre...
    { kind: 'down', at: { ref: 'point', x: CX - 100, y: CY }, pointer: 1, pointerType: 'touch' },
    { kind: 'down', at: { ref: 'point', x: CX + 100, y: CY }, pointer: 2, pointerType: 'touch' },
    // ...spread to 400px apart, each finger moving outward by the same amount
    // so the midpoint never budges. Interpolated, because a real pinch arrives
    // as a stream of small samples and a gesture that only works as one giant
    // jump is not the gesture being claimed.
    { kind: 'move', at: { ref: 'point', x: CX - 200, y: CY }, steps: 5, pointer: 1, pointerType: 'touch' },
    { kind: 'move', at: { ref: 'point', x: CX + 200, y: CY }, steps: 5, pointer: 2, pointerType: 'touch' },
    { kind: 'up', pointer: 1, pointerType: 'touch' },
    { kind: 'up', pointer: 2, pointerType: 'touch' },
  ],
  check: (obs: Obs): string | null => {
    const start = obs.visibleWorldRectAtStart()
    const now = obs.visibleWorldRect()
    const startW = start.maxX - start.minX
    const nowW = now.maxX - now.minX
    if (!(nowW < startW)) {
      return `spreading two fingers did not zoom IN: the visible world width went ${startW} -> ${nowW} (expected to SHRINK)`
    }
    // The spread doubled (200px -> 400px), so the visible world should be half
    // as wide. Generous tolerance: the fingers move one at a time, so the
    // gesture is a product of many samples rather than one clean factor.
    const ratio = startW / nowW
    if (Math.abs(ratio - 2) > 0.05) {
      return `doubling the finger spread should halve the visible world width (zoom ratio ${ratio}, expected ~2)`
    }
    // ...and the world point the fingers were holding stayed put.
    const startMidX = (start.minX + start.maxX) / 2
    const startMidY = (start.minY + start.maxY) / 2
    const nowMidX = (now.minX + now.maxX) / 2
    const nowMidY = (now.minY + now.maxY) / 2
    const drift = Math.max(Math.abs(nowMidX - startMidX), Math.abs(nowMidY - startMidY))
    if (drift > 1e-6) {
      return `the world point under the pinch midpoint drifted by ${drift} world units (expected to stay fixed): (${startMidX},${startMidY}) -> (${nowMidX},${nowMidY})`
    }
    return null
  },
}
