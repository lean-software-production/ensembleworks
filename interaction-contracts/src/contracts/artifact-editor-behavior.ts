// Stage 1b: stored artifact history only, seeded through test-only raw writes.
// No viewer, iframe, bridge or Present assertions belong to this stage.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'
import { bbthreadPaneDoubleClickBeginsEditing } from './bbthread-pane-double-click-begins-editing.js'

const ID = 'shape:artifact'
const W = 720, H = 540
const scene = () => [{
  id: ID, kind: 'artifact', x: 120, y: 80, w: W, h: H,
  props: { schemaVersion: 1, source: 'thread-storage', threadId: 'thr_fixture', path: 'reports/fixture.html', title: '' },
}]
const doubleClick = (rng: Rng): GestureOp[] => {
  // Vary the body point, safely clear of all edges/handles at every seed.
  const at = { ref: 'point' as const, x: 350 + rng.next() * 100, y: 250 + rng.next() * 100 }
  return [{ kind: 'down', at }, { kind: 'up' }, { kind: 'down', at }, { kind: 'up' }]
}

export const artifactBodyDoubleClickBeginsEditing: Contract = {
  name: 'artifact-body-double-click-begins-editing', level: 'fsm', when: 'at-end', scene,
  gesture: doubleClick,
  check: (obs: Obs) => {
    const edit = obs.editingState()
    return edit.id === ID && edit.region === 'body' ? null
      : `artifact double-click did not enter private body edit (editingState: ${JSON.stringify(edit)}, expected {"id":"${ID}","region":"body"})`
  },
}

export const artifactResizeRespectsMin: Contract = {
  name: 'artifact-resize-respects-min', level: 'fsm', tool: 'select+transform', when: 'at-end', scene,
  gesture: (rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    // Bottom-right corner -> well below BOTH floors, but not across anchor.
    { kind: 'down', at: { ref: 'point', x: 120 + W, y: 80 + H } },
    { kind: 'move', at: { ref: 'point', x: 180 + rng.next() * 20, y: 120 + rng.next() * 20 }, steps: 6 },
    { kind: 'up' },
  ],
  check: (obs: Obs) => {
    const w = obs.shapeProp(ID, 'w'), h = obs.shapeProp(ID, 'h')
    return typeof w === 'number' && typeof h === 'number' && Math.abs(w - 320) < 1e-6 && Math.abs(h - 200) < 1e-6 ? null
      : `artifact resize did not clamp to 320x200 (stored size: ${w}x${h})`
  },
}

// GREEN baseline regression guard: explicitly seed an already-focused body.
// Do NOT rely on double-click to establish focus here: that is RED before
// Stage 1b and would make an exit-only check pass vacuously.
export const artifactOutsideClickEndsEditing: Contract = {
  name: 'artifact-outside-click-ends-editing', level: 'fsm', when: 'at-end', scene,
  initialEdit: { id: ID, region: 'body' },
  gesture: (rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 1000 + rng.next() * 50, y: 640 } }, { kind: 'up' },
  ],
  check: (obs: Obs) => {
    const edit = obs.editingState()
    return edit.id === null && edit.region === null ? null : `outside click left artifact editingState ${JSON.stringify(edit)}`
  },
}

// GREEN baseline regression guard: an idle body's click reaches canvas
// selection, rather than being captured by an embedded viewer.
export const artifactIdleBodyDoesNotCapture: Contract = {
  name: 'artifact-idle-body-does-not-capture', level: 'fsm', when: 'at-end', scene,
  gesture: (rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'point', x: 350 + rng.next() * 100, y: 300 } }, { kind: 'up' },
  ],
  check: (obs: Obs) => obs.selectedShapeIds().length === 1 && obs.selectedShapeIds()[0] === ID && obs.editingState().id === null ? null
    : `idle artifact body did not route to canvas selection (selection: ${JSON.stringify(obs.selectedShapeIds())}, edit: ${JSON.stringify(obs.editingState())})`,
}

export const artifactIdleWheelPansCanvas: Contract = {
  name: 'artifact-idle-wheel-pans-canvas', level: 'fsm', when: 'at-end', scene,
  gesture: (rng: Rng): GestureOp[] => [
    { kind: 'wheel', dx: 0, dy: 80 + rng.next() * 40, at: { ref: 'shape', id: ID } },
  ],
  check: (obs: Obs) => Math.abs(obs.visibleWorldRect().minY - obs.visibleWorldRectAtStart().minY) > 10 ? null
    : 'idle artifact body captured wheel instead of panning the canvas',
}

// Same existing thread gesture, now also pin its BODY region. Existing
// bbthread header/workspace/divider contracts remain in the registry.
export const bbthreadBodyEditPreservesRegion: Contract = {
  ...bbthreadPaneDoubleClickBeginsEditing,
  name: 'bbthread-body-edit-preserves-region',
  check: (obs: Obs) => {
    const edit = obs.editingState()
    return edit.id === 'shape:bbthread' && edit.region === 'body' ? null
      : `bbthread pane body editing changed: ${JSON.stringify(edit)}`
  },
}

export const bbthreadHeaderEditPreservesRegion: Contract = {
  name: 'bbthread-header-edit-preserves-region', level: 'fsm', when: 'at-end',
  scene: () => [{ id: 'shape:bbthread', kind: 'bbthread', x: 100, y: 100, w: 900, h: 600 }],
  gesture: (rng: Rng): GestureOp[] => {
    const at = { ref: 'point' as const, x: 300 + rng.next() * 100, y: 80 }
    return [{ kind: 'down', at }, { kind: 'up' }, { kind: 'down', at }, { kind: 'up' }]
  },
  check: (obs: Obs) => {
    const edit = obs.editingState()
    return edit.id === 'shape:bbthread' && edit.region === 'name' ? null
      : `bbthread header rename changed: ${JSON.stringify(edit)}`
  },
}

export const ARTIFACT_EDITOR_CONTRACTS: readonly Contract[] = [
  artifactBodyDoubleClickBeginsEditing, artifactResizeRespectsMin,
  artifactOutsideClickEndsEditing, artifactIdleBodyDoesNotCapture,
  artifactIdleWheelPansCanvas, bbthreadBodyEditPreservesRegion, bbthreadHeaderEditPreservesRegion,
]
