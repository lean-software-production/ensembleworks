import { z } from 'zod'

// Branded id helpers. Ids are the verbatim tldraw ids ("shape:…", "page:…",
// "binding:…") so the model round-trips losslessly and v2 responses reference
// the same ids agents already hold.
export type ShapeId = `shape:${string}`
export type PageId = `page:${string}`
export type BindingId = `binding:${string}`
// Task M1 (2026-07-22 assets/image sub-cycle) — a canvas asset record id
// (tldraw's TLAssetId shape), mirroring the other branded template-literal
// ids on this page. Not part of ParentId: an asset is never a shape's
// parent, only referenced by an image shape's assetId prop (shape.ts).
export type AssetId = `asset:${string}`
export type ParentId = ShapeId | PageId

export const isShapeId = (s: string): s is ShapeId => s.startsWith('shape:')
export const isPageId = (s: string): s is PageId => s.startsWith('page:')
export const isBindingId = (s: string): s is BindingId => s.startsWith('binding:')
export const isAssetId = (s: string): s is AssetId => s.startsWith('asset:')
export const parentKind = (id: string): 'shape' | 'page' | 'other' =>
  isShapeId(id) ? 'shape' : isPageId(id) ? 'page' : 'other'

// Zod id-field schemas: template literals so inferred types are the branded id
// types above. The id prefix rules live here only — schema modules (shape.ts,
// document.ts) consume these instead of restating the prefixes.
export const shapeIdField = z.templateLiteral(['shape:', z.string()])
export const pageIdField = z.templateLiteral(['page:', z.string()])
export const bindingIdField = z.templateLiteral(['binding:', z.string()])
export const assetIdField = z.templateLiteral(['asset:', z.string()])
export const parentIdField = z.union([shapeIdField, pageIdField])
