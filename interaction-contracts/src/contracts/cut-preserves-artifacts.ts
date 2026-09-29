import type { Contract } from '../types.js'

/** Release N can preserve artifact history but cannot paste it. Cutting a
 * mixed selection keeps artifact-containing subtrees; unrelated roots cut
 * normally. Browser-only: clipboard shortcuts live in useCanvasSession. */
export const cutPreservesArtifacts: Contract = {
  name: 'cut-preserves-artifacts', level: 'browser', when: 'at-end',
  scene: () => [
    { id: 'shape:keep', kind: 'frame', x: 100, y: 100, w: 250, h: 250 },
    { id: 'shape:artifact', kind: 'artifact', parentId: 'shape:keep', x: 30, y: 30, w: 100, h: 100,
      props: { schemaVersion: 1, source: 'thread-storage', threadId: 'thr_fixture01', path: 'reports/deck.html', title: 'Deck' } },
    { id: 'shape:cut', kind: 'geo', x: 450, y: 100, w: 100, h: 100 },
  ],
  gesture: () => [
    { kind: 'down', at: { ref: 'shape', id: 'shape:cut' } },
    { kind: 'up' },
    { kind: 'key', key: 'a', modifiers: { ctrl: true } },
    { kind: 'key', key: 'x', modifiers: { ctrl: true } },
  ],
  check: obs => {
    const ids = obs.listShapeIds()
    if (!ids.includes('shape:artifact')) return 'Cut deleted an artifact excluded from the clipboard'
    if (!ids.includes('shape:keep')) return 'Cut deleted the parent of an uncopied artifact'
    if (ids.includes('shape:cut')) return 'Cut failed to remove the unrelated copyable selection'
    if (obs.shapeProp('shape:artifact', 'path') !== 'reports/deck.html') return 'Cut changed the stored artifact'
    return null
  },
}
