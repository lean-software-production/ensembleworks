// bb-thread-frame task — the `bbthread` shape is a frame-like container
// whose right third is a solid "thread pane" (the BB plugin's ThreadChat
// mount): unlike a frame's fully-hollow interior (frame-interior-is-hollow),
// a pointerdown inside that pane must hit the shape itself and translate
// it, exactly like a solid box. canvas-model's hitTestPoint gets a second
// `bbthreadPaneLocalBounds(shape)` hit region (right third of the body,
// spanning the shape's full local height) alongside the existing frame-like header/edge-
// margin hit — this contract proves the SELECT TOOL routes a pane drag to
// a translate, not a miss/marquee.
//
// RED (recorded verbatim in the task report before the fix landed): the
// 'bbthread' kind did not exist yet, so canvas-model's shapeSchema rejected
// it outright — the FSM runner's seedScene throws
// "seedScene: invalid SceneShape ... (kind \"bbthread\"): invalid props for
// kind bbthread: ..." before the gesture ever plays.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'

export const bbthreadPaneIsSolid: Contract = {
  name: 'bbthread-pane-is-solid',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    // A 900x600 bbthread at the origin. The right third pane spans local x
    // in [600,900], spanning the full local height y in [0,600] (the header band sits above this, at negative y, exactly like a plain frame's). (800,300) is
    // well inside that pane, clear of both the header band and the 8px edge
    // margin on every side.
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 800, y: 300 } },
    { kind: 'move', at: { ref: 'point', x: 850, y: 350 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(BBTHREAD_ID)
    if (d.dx !== 50 || d.dy !== 50) {
      return `a drag started inside the bbthread's solid right-third pane did not translate the shape (Δ=${JSON.stringify(d)}, expected {dx:50,dy:50}) -- the pane must be solid`
    }
    return null
  },
}
