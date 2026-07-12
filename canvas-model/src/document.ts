import { z } from 'zod'
import type { Shape } from './shape.js'
import { bindingIdField, shapeIdField, pageIdField, type BindingId, type PageId, type ShapeId } from './ids.js'
import { stableStringify } from './stable-stringify.js'

// NOTE: checkInvariants' validProps rule covers shapes only; bindingSchema and
// pageSchema are consumed by the converter seam later, not by the invariants.
export const bindingSchema = z.looseObject({
  id: bindingIdField,
  fromId: shapeIdField, // the arrow shape
  toId: shapeIdField, // the bound shape
  props: z.record(z.string(), z.unknown()),
  // Carried verbatim for lossless round-trip through the converter seam.
  // default({}) keeps pre-existing fixtures (built without meta) valid while
  // the parsed type always carries meta.
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type Binding = z.infer<typeof bindingSchema>

export const pageSchema = z.looseObject({ id: pageIdField, name: z.string() })
export type Page = z.infer<typeof pageSchema>

// Compile-time drift guards (see shape.ts for the pattern): the schema's
// inferred id types must stay assignable to ids.ts's branded types.
type _BindingIdMatches = [Binding['id'] extends BindingId ? true : never, BindingId extends Binding['id'] ? true : never]
type _PageIdMatches = [Page['id'] extends PageId ? true : never, PageId extends Page['id'] ? true : never]
type _FromIdMatches = [Binding['fromId'] extends ShapeId ? true : never, ShapeId extends Binding['fromId'] ? true : never]
type _ToIdMatches = [Binding['toId'] extends ShapeId ? true : never, ShapeId extends Binding['toId'] ? true : never]
const _bindingIdCheck: _BindingIdMatches = [true, true]
const _pageIdCheck: _PageIdMatches = [true, true]
const _fromIdCheck: _FromIdMatches = [true, true]
const _toIdCheck: _ToIdMatches = [true, true]
void _bindingIdCheck, void _pageIdCheck, void _fromIdCheck, void _toIdCheck

// Deeply read-only container: the arrays are ReadonlyArray so mutation (e.g.
// doc.shapes.push) is a compile error and byId can't silently go stale.
export interface CanvasDocument {
  readonly pages: readonly Page[]
  readonly shapes: readonly Shape[]
  readonly bindings: readonly Binding[]
  /** id → shape, built once at construction. */
  readonly byId: ReadonlyMap<string, Shape>
}

export function makeDocument(input: {
  pages: readonly Page[]
  shapes: readonly Shape[]
  bindings: readonly Binding[]
}): CanvasDocument {
  // byId under DUPLICATE ids (reachable via the offline delete+recreate
  // reconnect race — see invariants.ts's uniqueIds rule): keep the CONTENT
  // winner — smallest stableStringify — i.e. exactly the entry the dedupe
  // repair will keep. Two reasons this is load-bearing, both rig-proven:
  // 1. Determinism: a last-entry-wins byId tracks Loro's tree traversal
  //    order, which differs across converged peers, so byId-based analysis
  //    (noCycles walks parents through byId) could compute DIFFERENT
  //    violations — hence different repair plans — on peers holding the
  //    identical converged multiset.
  // 2. One-pass repair: noCycles must analyze the topology that will exist
  //    AFTER dedupe collapses the duplicates; sampling a losing entry's
  //    parentId can hide a cycle that dedupe then surfaces, leaving a
  //    standing violation after a single repair() (the E1 rig caught exactly
  //    this at seed 27 before this rule existed).
  // stableStringify costs are collision-only: unique ids never pay it.
  const byId = new Map<string, Shape>()
  for (const s of input.shapes) {
    const prev = byId.get(s.id)
    if (!prev) byId.set(s.id, s)
    else if (stableStringify(s) < stableStringify(prev)) byId.set(s.id, s)
  }
  return { pages: input.pages, shapes: input.shapes, bindings: input.bindings, byId }
}

// Accessors return fresh (mutable) arrays built via filter.
export const shapeById = (doc: CanvasDocument, id: string): Shape | undefined => doc.byId.get(id)
export const childrenOf = (doc: CanvasDocument, parentId: string): Shape[] =>
  doc.shapes.filter((s) => s.parentId === parentId)
export const rootShapes = (doc: CanvasDocument): Shape[] =>
  doc.shapes.filter((s) => s.parentId.startsWith('page:'))
// All shapes transitively under a parent (BFS over childrenOf), so containers
// like groups don't hide their contents from structural reads. Cycle-safe: a
// malformed parent cycle terminates via the seen set instead of looping.
export const descendantsOf = (doc: CanvasDocument, id: string): Shape[] => {
  const out: Shape[] = []
  const seen = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    for (const child of childrenOf(doc, queue.shift()!)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}
export const frames = (doc: CanvasDocument): Shape[] => doc.shapes.filter((s) => s.kind === 'frame')
