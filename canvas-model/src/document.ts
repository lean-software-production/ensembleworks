import { z } from 'zod'
import { type Shape, shapeSchema } from './shape.js'
import type { BindingId, PageId, ShapeId } from './ids.js'

// Branded id fields, matching the style established in shape.ts.
const bindingIdField = z.templateLiteral(['binding:', z.string()])
const shapeIdField = z.templateLiteral(['shape:', z.string()])
const pageIdField = z.templateLiteral(['page:', z.string()])

export const bindingSchema = z.looseObject({
  id: bindingIdField,
  fromId: shapeIdField, // the arrow shape
  toId: shapeIdField, // the bound shape
  props: z.record(z.string(), z.unknown()),
})
export type Binding = z.infer<typeof bindingSchema>

export const pageSchema = z.looseObject({ id: pageIdField, name: z.string() })
export type Page = z.infer<typeof pageSchema>

// Compile-time drift guards (see shape.ts lines ~56-63 for the pattern): the
// schema's inferred id types must stay assignable to ids.ts's branded types.
type _BindingIdMatches = [Binding['id'] extends BindingId ? true : never, BindingId extends Binding['id'] ? true : never]
type _PageIdMatches = [Page['id'] extends PageId ? true : never, PageId extends Page['id'] ? true : never]
const _bindingIdCheck: _BindingIdMatches = [true, true]
const _pageIdCheck: _PageIdMatches = [true, true]
void _bindingIdCheck, void _pageIdCheck
// (fromId/toId brand to ShapeId via the same shapeIdField as shape.ts's id.)
type _FromIdMatches = [Binding['fromId'] extends ShapeId ? true : never, ShapeId extends Binding['fromId'] ? true : never]
const _fromIdCheck: _FromIdMatches = [true, true]
void _fromIdCheck

export interface CanvasDocument {
  readonly pages: Page[]
  readonly shapes: Shape[]
  readonly bindings: Binding[]
  /** id → shape, built once at construction. */
  readonly byId: ReadonlyMap<string, Shape>
}

export function makeDocument(input: { pages: Page[]; shapes: Shape[]; bindings: Binding[] }): CanvasDocument {
  const byId = new Map(input.shapes.map((s) => [s.id, s]))
  return { pages: input.pages, shapes: input.shapes, bindings: input.bindings, byId }
}

export const shapeById = (doc: CanvasDocument, id: string): Shape | undefined => doc.byId.get(id)
export const childrenOf = (doc: CanvasDocument, parentId: string): Shape[] =>
  doc.shapes.filter((s) => s.parentId === parentId)
export const rootShapes = (doc: CanvasDocument): Shape[] =>
  doc.shapes.filter((s) => s.parentId.startsWith('page:'))
export const frames = (doc: CanvasDocument): Shape[] => doc.shapes.filter((s) => s.kind === 'frame')

export { shapeSchema }
