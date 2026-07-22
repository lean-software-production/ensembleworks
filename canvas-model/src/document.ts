import { z } from 'zod'
import type { Shape } from './shape.js'
import { bindingIdField, shapeIdField, pageIdField, assetIdField, type BindingId, type PageId, type ShapeId, type AssetId } from './ids.js'
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

// `index` is OPTIONAL (permissive — every pre-existing page in the D-2
// legacy corpus carries no index; no migration performed) so parse stays
// backward-compatible. orderedPages below treats a missing index as the
// empty string, which sorts before any non-empty index lexically.
export const pageSchema = z.looseObject({ id: pageIdField, name: z.string(), index: z.string().optional() })
export type Page = z.infer<typeof pageSchema>

// The doc's pages, sorted by (index ASC lexical, id ASC lexical) — the SAME
// (index, id) tie-break paint-order.ts's orderForPaint uses for shape
// siblings, for the same reason: convergence. Two peers holding the
// identical converged CRDT state must compute the SAME page order
// regardless of input/iteration order, so this is a pure function of
// (index, id) only, never input array order. A page with no `index` sorts
// as if its index were '' (before every non-empty index).
export function orderedPages(pages: readonly Page[]): Page[] {
  return pages.slice().sort((a, b) => {
    const ai = a.index ?? ''
    const bi = b.index ?? ''
    if (ai < bi) return -1
    if (ai > bi) return 1
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
}

// A canvas asset (tldraw parity: dropped/pasted images live as a SEPARATE
// record referenced by the image shape's assetId, not inline on the shape —
// canvas-editor's Task E1 wires the PutAsset intent, canvas-doc's Task A1
// wires the assets map). LOOSE envelope + LOOSE props so a synced/foreign v1
// asset (video/bookmark, extra props like fileSize/isAnimated) rides through
// untouched. `type` is a plain string (NOT a closed enum) so a foreign kind
// is not dropped — our own tool only ever writes 'image'. `src` is a string
// WHEN PRESENT (rejects a non-string src — the one field the renderer
// resolves), OPTIONAL because a bookmark-style asset legitimately carries
// none.
const assetProps = z.looseObject({
  src: z.string().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  mimeType: z.string().optional(),
  name: z.string().optional(),
})
export const assetSchema = z.looseObject({
  id: assetIdField,
  type: z.string(),
  props: assetProps,
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type Asset = z.infer<typeof assetSchema>

export type AssetValidation = { ok: true; asset: Asset } | { ok: false; error: string }
export function validateAsset(input: unknown): AssetValidation {
  const res = assetSchema.safeParse(input)
  return res.success ? { ok: true, asset: res.data } : { ok: false, error: res.error.message }
}

// Compile-time drift guards (see shape.ts for the pattern): the schema's
// inferred id types must stay assignable to ids.ts's branded types.
type _BindingIdMatches = [Binding['id'] extends BindingId ? true : never, BindingId extends Binding['id'] ? true : never]
type _PageIdMatches = [Page['id'] extends PageId ? true : never, PageId extends Page['id'] ? true : never]
type _FromIdMatches = [Binding['fromId'] extends ShapeId ? true : never, ShapeId extends Binding['fromId'] ? true : never]
type _ToIdMatches = [Binding['toId'] extends ShapeId ? true : never, ShapeId extends Binding['toId'] ? true : never]
type _AssetIdMatches = [Asset['id'] extends AssetId ? true : never, AssetId extends Asset['id'] ? true : never]
const _bindingIdCheck: _BindingIdMatches = [true, true]
const _pageIdCheck: _PageIdMatches = [true, true]
const _fromIdCheck: _FromIdMatches = [true, true]
const _toIdCheck: _ToIdMatches = [true, true]
const _assetIdCheck: _AssetIdMatches = [true, true]
void _bindingIdCheck, void _pageIdCheck, void _fromIdCheck, void _toIdCheck, void _assetIdCheck

// Deeply read-only container: the arrays are ReadonlyArray so mutation (e.g.
// doc.shapes.push) is a compile error and byId can't silently go stale.
export interface CanvasDocument {
  readonly pages: readonly Page[]
  readonly shapes: readonly Shape[]
  readonly bindings: readonly Binding[]
  readonly assets: readonly Asset[]
  /** id → shape, built once at construction. */
  readonly byId: ReadonlyMap<string, Shape>
  /** id → asset, built once at construction (mirror byId). */
  readonly assetById: ReadonlyMap<string, Asset>
}

export function makeDocument(input: {
  pages: readonly Page[]
  shapes: readonly Shape[]
  bindings: readonly Binding[]
  // Defaults to [] so every pre-existing caller (repair.ts,
  // applyRepairToModel, fixtures) keeps compiling unchanged — see A1.
  assets?: readonly Asset[]
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
  // Same dedupe rule as byId, for consistency — dups are not expected for
  // assets (the assets map is keyed by id, so listAssets() output already
  // carries one entry per id), but a caller-built `assets` array is not
  // guaranteed unique, so this stays a content-stable tie-break rather than
  // a traversal-order-dependent last-wins.
  const assets = input.assets ?? []
  const assetById = new Map<string, Asset>()
  for (const a of assets) {
    const prev = assetById.get(a.id)
    if (!prev) assetById.set(a.id, a)
    else if (stableStringify(a) < stableStringify(prev)) assetById.set(a.id, a)
  }
  return { pages: input.pages, shapes: input.shapes, bindings: input.bindings, assets, byId, assetById }
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
