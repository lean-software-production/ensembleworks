import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ID = 'shape:unlinked-github-issue'

/** An unlinked card is a normal canvas shape before anyone enters a URL. */
export const unlinkedGithubIssueCardResize: Contract = {
  name: 'unlinked-github-issue-card-resize',
  level: 'fsm', tool: 'select+transform', when: 'at-end',
  scene: () => [{ id: ID, kind: 'github-issue', x: 100, y: 100, w: 470, h: 256,
    props: { schemaVersion: 2 } }],
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'shape', id: ID } }, { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 570, y: 356 } },
    { kind: 'move', at: { ref: 'point', x: 200, y: 200 }, steps: 4 }, { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    if (!obs.selectedShapeIds().includes(ID)) return 'unlinked card must remain selectable'
    if (obs.shapeProp(ID, 'issueUrl') !== undefined) return 'unlinked card must not have an issue link'
    const w = obs.shapeProp(ID, 'w'), h = obs.shapeProp(ID, 'h')
    if (typeof w !== 'number' || typeof h !== 'number' || w < 260 || h < 170 || w >= 470 || h >= 256)
      return `unlinked card must resize to readable bounds (got ${JSON.stringify({ w, h })})`
    return null
  },
}
