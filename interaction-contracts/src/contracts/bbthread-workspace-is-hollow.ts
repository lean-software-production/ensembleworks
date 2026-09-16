// bb-thread-frame task — the `bbthread` shape's WORKSPACE (the left two
// thirds, spanning the shape's full local height, where the frame's captured children live)
// stays hollow, exactly like an ordinary frame's interior
// (frame-interior-is-hollow) -- only the right-third thread pane
// (bbthread-pane-is-solid) is solid. This contract proves a drag started
// deep in the workspace region routes to a marquee, not a translate: the
// bbthread shape itself must not move.
//
// RED (recorded verbatim in the task report before the fix landed): the
// 'bbthread' kind did not exist yet, so canvas-model's shapeSchema rejected
// it outright — the FSM runner's seedScene throws
// "seedScene: invalid SceneShape ... (kind \"bbthread\"): invalid props for
// kind bbthread: ..." before the gesture ever plays.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const BBTHREAD_ID = 'shape:bbthread'

export const bbthreadWorkspaceIsHollow: Contract = {
  name: 'bbthread-workspace-is-hollow',
  level: 'fsm',
  when: 'at-end',
  scene: () => [
    { id: BBTHREAD_ID, kind: 'bbthread', x: 0, y: 0, w: 900, h: 600 },
  ],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 200, y: 300 } },
    { kind: 'move', at: { ref: 'point', x: 300, y: 400 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const d = obs.shapeDisplacement(BBTHREAD_ID)
    if (d.dx !== 0 || d.dy !== 0) {
      return `a drag started deep inside the bbthread's hollow workspace region moved the shape itself (Δ=${JSON.stringify(d)}) -- the workspace must stay hollow, routing this gesture to a marquee instead of a translate`
    }
    return null
  },
}
