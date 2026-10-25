// Test-only factories shared by canvas-sync's house-style test files (and the
// E1 convergence rig). Not itself a .test.ts file, so the boundary test DOES
// scan it — it must stay clean-room (no ws/express/tldraw/server imports, no
// Date.now/Math.random) just like every other src/ file.
import type { CanvasDocument } from '@ensembleworks/canvas-model'

/** The envelope fields every fixture shape shares — deliberately minimal. */
export const base = () => ({ index: 'a1', x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} })

/** A minimal valid 'note' shape fixture, defaulting to parented at 'page:p'. */
export const shape = (id: string, over: any = {}) =>
  ({ id, kind: 'note', parentId: 'page:p', props: {}, ...base(), ...over }) as any

/** Sort key for cross-peer comparison — id order is arbitrary once independent
 * docs converge, so comparisons must normalize on something stable. Secondary
 * key is the full serialized item: Array.sort is stable, so WITHOUT this,
 * ties on id (two items sharing an id — see loro-canvas-doc.ts's
 * nodesByShapeId comment: heavy concurrent churn can converge more than one
 * physical Loro node onto one application-level shapeId) would keep their
 * INPUT order, which tracks Loro's internal tree traversal order — NOT
 * guaranteed identical across independently-converged peers even when they
 * hold the exact same multiset of data (probe-proven by the E1 convergence
 * rig: two peers, same versionBytes, same two 'shape:a' entries, opposite
 * order). The secondary key makes the sort order a pure function of content,
 * so byte-identical multisets always normalize to byte-identical arrays. */
export const byIdAsc = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b))

/** Normalize a CanvasDocument for cross-peer/cross-doc equality checks: Loro's
 * list order need not match array order across independently-built docs, so
 * sort each collection by id before comparing. */
export const normalize = (m: CanvasDocument) => ({
  pages: [...m.pages].sort(byIdAsc),
  shapes: [...m.shapes].sort(byIdAsc),
  bindings: [...m.bindings].sort(byIdAsc),
})
