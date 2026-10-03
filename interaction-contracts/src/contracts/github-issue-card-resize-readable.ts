import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:github-issue-card'

/** A selected issue card remains readable when its SE resize handle is pulled inward. */
export const githubIssueCardResizeReadable: Contract = {
  name: 'github-issue-card-resize-readable',
  level: 'fsm',
  tool: 'select+transform',
  when: 'at-end',
  scene: () => [{ id: ID, kind: 'github-issue', x: 100, y: 100, w: 470, h: 256,
    props: { schemaVersion: 1, repo: 'owner/repo', number: 123 } }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 570, y: 356 } },
    { kind: 'move', at: { ref: 'point', x: 200, y: 200 }, steps: 4 },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (!obs.selectedShapeIds().includes(ID)) return 'issue card must remain selected after click and resize'
    const w = obs.shapeProp(ID, 'w')
    const h = obs.shapeProp(ID, 'h')
    if (typeof w !== 'number' || typeof h !== 'number' || w < 260 || h < 170 || w >= 470 || h >= 256) {
      return `issue card resize must stop at readable compact bounds 260x170 (got ${JSON.stringify({ w, h })})`
    }
    return null
  },
}
