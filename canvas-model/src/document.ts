import { z } from 'zod'
import type { Shape } from './shape.js'
import { bindingIdField, shapeIdField, pageIdField, type BindingId, type PageId, type ShapeId } from './ids.js'

// NOTE: checkInvariants' validProps rule covers shapes only; bindingSchema and
// pageSchema are consumed by the converter seam later, not by the invariants.
export const bindingSchema = z.looseObject({
  id: bindingIdField,
  fromId: shapeIdField, // the arrow shape
  toId: shapeIdField, // the bound shape
  props: z.record(z.string(), z.unknown()),
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
  const byId = new Map(input.shapes.map((s) => [s.id, s]))
  return { pages: input.pages, shapes: input.shapes, bindings: input.bindings, byId }
}

// Accessors return fresh (mutable) arrays built via filter.
export const shapeById = (doc: CanvasDocument, id: string): Shape | undefined => doc.byId.get(id)
export const childrenOf = (doc: CanvasDocument, parentId: string): Shape[] =>
  doc.shapes.filter((s) => s.parentId === parentId)
export const rootShapes = (doc: CanvasDocument): Shape[] =>
  doc.shapes.filter((s) => s.parentId.startsWith('page:'))
export const frames = (doc: CanvasDocument): Shape[] => doc.shapes.filter((s) => s.kind === 'frame')
