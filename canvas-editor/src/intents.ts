// The Intent union: the editor's ONLY vocabulary for changing anything,
// either the CRDT-backed document (mutation intents) or the editor-local
// store (view intents — camera/selection/hover/editing; see editor.ts's
// EditorState). Tool FSMs (select/hand/create/arrow/transform, C4-C8) never
// call CanvasDoc methods directly; they emit Intents and the Editor decides
// how each becomes doc ops. This indirection is what makes a tool testable
// as pure (state, InputEvent) -> (state', Intent[]) with no doc at all — see
// script.ts's `run()`.
import type { Asset, Binding, Shape } from '@ensembleworks/canvas-model'

export interface Point { readonly x: number; readonly y: number }

/** The (nx, ny) anchor an arrow endpoint binds to on its target, normalized
 * to the target's local unrotated box — the exact shape resolveArrowAnchor /
 * anchorToWorld (canvas-model/src/snapping.ts) produce and consume. Carried
 * here rather than importing those functions: resolving WHERE an anchor
 * point lands is the arrow tool's job (C7); this module only shapes the
 * Intent payload that carries the tool's answer into the doc. */
export interface ArrowBinding {
  readonly targetId: string
  readonly anchor: { readonly nx: number; readonly ny: number }
}

// ============================================================================
// Mutation intents — applied to the CanvasDoc, one `doc.commit()` per
// apply()/applyAll() batch (see editor.ts's commit-granularity doc comment).
// ============================================================================

/** Upsert `shape` verbatim (id/index/parentId already resolved by the
 * caller — a create tool, C6, owns id generation via the injected
 * `random`/an id factory and z-order via a fractional index; this intent is
 * just "put this fully-formed shape"). */
export interface CreateShape { readonly type: 'CreateShape'; readonly shape: Shape }

/** Upsert `binding` verbatim, IF it passes `bindingSchema` — a validated
 * write, unlike raw `CanvasDoc.putBinding` (a plain `.set()` with no
 * validation at all; see loro-canvas-doc.ts's `putBinding`). `applyOne`
 * (editor.ts) runs `bindingSchema.safeParse(intent.binding)` before ever
 * calling `doc.putBinding`; on failure the WHOLE intent is a silent no-op —
 * no doc write, no undo entry, no throw — mirroring `putShape`'s own
 * reject-invalid write boundary (`validateShape` in loro-canvas-doc.ts).
 * This is the write path paste (Task E1) uses to create cloned bindings from
 * foreign clipboard data, so an invalid binding can never reach the doc even
 * if a bug upstream (decodeClipboard/cloneWithNewIds) let one through.
 *
 * Does NOT itself check that `fromId`/`toId` resolve to shapes that exist —
 * only that the binding is STRUCTURALLY well-formed. A structurally-valid
 * but dangling binding (endpoint doesn't resolve) is accepted and written;
 * CanvasDoc.repair() is what sweeps dangling bindings, the same contract
 * StartArrow/CompleteArrow's own `doc.putBinding` calls above already rely
 * on. Callers that must never create a dangling binding (paste, via
 * cloneWithNewIds/D-4) filter endpoints themselves before emitting this
 * intent — PutBinding's job is schema validation, not referential
 * integrity. */
export interface PutBinding { readonly type: 'PutBinding'; readonly binding: Binding }

/** Upsert `asset` verbatim, IF it passes `assetSchema` — the same
 * validated-write shape as PutBinding above (`applyOne`, editor.ts, runs
 * `assetSchema.safeParse(intent.asset)` before ever calling `doc.putAsset`;
 * a failing asset is a TOTAL no-op: no doc write, no undo entry, no throw).
 * `doc.putAsset` itself is a plain `.set()` with no validation (mirrors
 * `putBinding`/`putPage`) — this intent's `safeParse` IS the write-boundary
 * gate for the untrusted client drop/paste entry point (D-4 in
 * docs/plans/2026-07-22-canvas-v2-assets-image.md).
 *
 * DELIBERATELY CARRIES NO UNDO/REDO INVERSE (unlike PutBinding's
 * deleteBinding/putBinding pair) — there is no `deleteAsset` to invert with
 * (YAGNI'd this cycle), and an undone image is meant to leave its asset
 * behind as harmless orphan garbage, exactly tldraw's own behavior (tldraw
 * never GCs assets on undo). The create flow (client, Task C1) batches
 * PutAsset with a CreateShape in ONE applyAll so the batch still gets a
 * real undo entry — CreateShape's own deleteShape/putShape inverses remove
 * and restore the image shape; the asset just rides along, untouched by
 * either direction. */
export interface PutAsset { readonly type: 'PutAsset'; readonly asset: Asset }

/** Move every shape in `ids` by (dx, dy) in its own parent's local frame.
 * `ids` is DEDUPED against ancestor/descendant overlap before mutation — see
 * editor.ts's dedupeAncestorOverlap (the rule shared by ALL THREE
 * whole-shape transform intents: Translate/Resize/RotateShapes): a
 * selection containing both a parent and one of its (possibly indirect)
 * children moves the child only once, via the parent's translation, because
 * a child's world position is already relative to its parent (translating
 * the parent moves the child's world position for free; translating the
 * child TOO would double-move it). */
export interface TranslateShapes { readonly type: 'TranslateShapes'; readonly ids: readonly string[]; readonly dx: number; readonly dy: number }

/** Scale every shape in `ids` about the fixed world point `anchor` (e.g. the
 * opposite handle from the one being dragged). Applied per-shape to x/y and,
 * where present, props.w/h — see editor.ts's applyOne (and its
 * worldToParentFrame helper) for the exact transform: `anchor` is WORLD
 * space and is converted into EACH shape's own PARENT frame before composing
 * with that shape's x/y (which already lives there), so a shape nested under
 * a rotated parent resizes correctly, not just a page-rooted one.
 *
 * ANCESTOR DEDUPE (same rule as TranslateShapes — see its doc comment and
 * editor.ts's dedupeAncestorOverlap): a parent + its descendant in the same
 * `ids` scales the PARENT only; the descendant rides along via the parent's
 * frame instead of being transformed a second time.
 *
 * MINIMUM-SIZE CLAMP (editor.ts's clampScale): the per-shape/per-axis scale
 * is floored so stored props.w/h never drop below 1 world unit — in
 * particular a negative scale (corner dragged THROUGH the opposite anchor)
 * can never persist negative stored geometry. tldraw instead FLIPS the
 * shape across the anchor; flip semantics (with their routing/bound-anchor
 * implications) are a documented Phase-4 parity item, not v1 scope. */
export interface ResizeShapes {
  readonly type: 'ResizeShapes'
  readonly ids: readonly string[]
  readonly anchor: Point
  readonly scaleX: number
  readonly scaleY: number
}

/** Rotate every shape in `ids` by `dRadians` about the fixed world point
 * `center`: composes into each shape's x/y (orbits it around `center`) AND
 * its own `rotation` field (spins it in place) — the same "rotations add,
 * position orbits" composition canvas-model/src/geometry.ts's
 * composeTransform documents for parent-child chains, applied here to a
 * transient rotation delta instead of a parent relationship. `center` is
 * WORLD space; editor.ts's applyOne converts it into EACH shape's own PARENT
 * frame (worldToParentFrame) before orbiting that shape's x/y, so a shape
 * nested under a ROTATED parent orbits correctly — only the position needs
 * this conversion, since a shape's own `rotation` field composes additively
 * regardless of the parent's rotation (see worldToParentFrame's doc comment
 * for why). A mixed selection (some shapes root-parented, some nested under
 * a rotated parent) converts each shape independently in the same intent.
 *
 * ANCESTOR DEDUPE (same rule as Translate/ResizeShapes — editor.ts's
 * dedupeAncestorOverlap): a parent + its descendant in the same `ids`
 * rotates the PARENT only — the descendant's world frame follows via
 * composition; rotating it too would double both its world rotation and
 * its orbit (reviewer-probed before this rule covered Rotate/Resize). */
export interface RotateShapes {
  readonly type: 'RotateShapes'
  readonly ids: readonly string[]
  readonly center: Point
  readonly dRadians: number
}

/** Move every shape in `ids` under `parentId` (a shape or page id).
 * Tolerant PER ID, never throwing (the applyAll TOLERANCE CONTRACT in
 * editor.ts — a throw mid-batch would leak earlier intents' uncommitted
 * mutations into the next commit): an id is SKIPPED — the rest still
 * apply — when the id itself doesn't resolve, when `parentId` names a
 * shape that doesn't currently resolve (e.g. vanished under a concurrent
 * remote delete), or when the move would create a cycle (self-parent
 * included). The editor pre-validates all of this itself
 * (Editor.canReparent) rather than leaning on CanvasDoc.reparent's
 * throw-on-unknown-parent contract. A page-id target is always placeable
 * (reparent's "move to root" semantics). */
export interface ReparentShapes { readonly type: 'ReparentShapes'; readonly ids: readonly string[]; readonly parentId: string }

/** Delete every shape in `ids` (cascades to each shape's subtree — see
 * CanvasDoc.deleteShape's contract). Does NOT also clear selection/hover/
 * editingId that may reference a deleted id — that cleanup is the emitting
 * tool's job (it can follow up with SetSelection/SetHover/EndEdit in the
 * same batch) rather than an implicit side effect here. */
export interface DeleteShapes { readonly type: 'DeleteShapes'; readonly ids: readonly string[] }

/** Overwrite a shape's plain-text content. Silent no-op on an unknown id
 * (CanvasDoc.setText's contract) — ProseMirror rich text is a canvas-react
 * concern (Seam D); this intent only carries the plain string. */
export interface SetText { readonly type: 'SetText'; readonly id: string; readonly text: string }

/** Generic shape-prop write: SHALLOW-merges `props` into the shape's current
 * props map — `{...current, ...props}`, exactly CanvasDoc.updateProps's own
 * merge contract (loro-canvas-doc.ts's `updateProps`), never a full
 * overwrite. This is the write-path the ported embeds (Seam D) use for their
 * own prop fields (e.g. an iframe embed's `url`, a poll's `votes`) — it does
 * NOT know or care what's inside `props`; that's each embed's own schema.
 * Silent no-op on an unknown id (mirrors SetText/DeleteShapes's tolerance —
 * see editor.ts's applyOne TOLERANCE CONTRACT): no throw, docMutated:false. */
export interface UpdateProps { readonly type: 'UpdateProps'; readonly id: string; readonly props: Record<string, unknown> }

/** Batch style write across a whole selection. Shallow-merges `props` into
 * EACH id's props map (like UpdateProps, but multi-id) AND, when `opacity`
 * is present, sets each id's ENVELOPE `opacity` — a field UpdateProps cannot
 * reach because CanvasDoc.updateProps only ever merges the props map (see
 * canvas-doc/src/canvas-doc.ts's updateProps contract comment). Per-id
 * tolerant: an unresolved id is SKIPPED (the applyAll TOLERANCE CONTRACT),
 * never thrown. The intent is DUMB about relevance — it applies the given
 * patch to every id in `ids` regardless of shape kind; the PANEL (Task P4)
 * decides which props a kind actually supports before emitting one of
 * these. This is why SetStyle exists instead of extending UpdateProps:
 * UpdateProps stays single-id and props-only, reserved for the ported
 * embeds' own prop writes (Seam D). */
export interface SetStyle {
  readonly type: 'SetStyle'
  readonly ids: readonly string[]
  readonly props?: Record<string, unknown>
  readonly opacity?: number
}

/** Begin drawing an arrow: puts `shape` (kind 'arrow') verbatim, exactly
 * like CreateShape, then — if `fromBinding` is present — puts a binding
 * pinning the arrow's START endpoint to `fromBinding.targetId` at
 * `fromBinding.anchor`. Binding id convention: `binding:<arrowId>-start`
 * (CompleteArrow's end binding is `binding:<arrowId>-end`) — distinct ids so
 * an arrow can be bound at both ends without one binding clobbering the
 * other in the doc's flat bindings map. The arrow TOOL (drag gesture, live
 * anchor preview, unbound-endpoint handling) is C7's job; this only defines
 * the payload the tool will emit and the doc ops it produces. */
export interface StartArrow {
  readonly type: 'StartArrow'
  readonly shape: Shape
  readonly fromBinding?: ArrowBinding
}

/** Finish an arrow started by StartArrow: sets `props.end` on the arrow
 * shape to `end` expressed as a LOCAL offset from the shape's own x/y (the
 * arrow's x/y is its start point, by StartArrow's convention above), then —
 * if `toBinding` is present — puts the END binding (see StartArrow's id
 * convention). If `id` doesn't resolve (the arrow vanished — e.g. a remote
 * delete raced the local gesture) the WHOLE intent is a silent no-op:
 * neither the props update NOR the binding is written, so a vanished arrow
 * can never leave a dangling binding behind. */
export interface CompleteArrow {
  readonly type: 'CompleteArrow'
  readonly id: string
  readonly end: Point
  readonly toBinding?: ArrowBinding
}

// ============================================================================
// View intents — touch ONLY the editor-local store (camera/selection/hover/
// editing). Never call doc.commit(); see editor.ts's applyOne.
// ============================================================================

export interface SetCamera { readonly type: 'SetCamera'; readonly x: number; readonly y: number; readonly z: number }
export interface SetSelection { readonly type: 'SetSelection'; readonly ids: readonly string[] }
export interface SetHover { readonly type: 'SetHover'; readonly id: string | null }
export interface BeginEdit { readonly type: 'BeginEdit'; readonly id: string }
export interface EndEdit { readonly type: 'EndEdit' }

/** Arm the style a NEWLY-CREATED shape will inherit (Task AS1/AS2) — parity
 * with tldraw arming a color on the tool before you draw. Editor-local, like
 * every other view intent here: shallow-MERGES `props` into the existing
 * `EditorState.nextShapeStyle` (arming color, then arming size, accumulates
 * both — it does NOT replace), never touches the doc, never pushes an undo
 * entry. See editor.ts's applyOne. */
export interface SetNextStyle { readonly type: 'SetNextStyle'; readonly props: Record<string, unknown> }

/** Switch which page THIS peer is currently looking at (Task E1,
 * docs/plans/2026-07-22-canvas-v2-pages.md, D-2) — editor-LOCAL, like every
 * other view intent here: touches only `EditorState.currentPageId`, never the
 * doc, never pushes an undo entry. Switching pages is a VIEW change, not an
 * undoable one — undoing a switch would silently jump the user's viewport
 * back, a surprising side effect view intents don't have machinery for
 * anyway. See editor.ts's applyOne. */
export interface SetCurrentPage { readonly type: 'SetCurrentPage'; readonly pageId: string }

/** Index-only whole-shape write: overwrites a shape's ENVELOPE `index` field
 * (the fractional-index z-order key — canvas-model's `fractional-index.ts`,
 * Task A1) to `index` verbatim. Single-id, not batch — like UpdateProps, not
 * SetStyle: the reorder emitter (Task E2, `reorderSelectionIntents`)
 * computes one literal index PER shape at emission time and freezes each
 * into its own SetIndex intent, then submits all of them together via one
 * `editor.applyAll(...)` call — batching lives at the applyAll layer (one
 * commit/one undo step for N SetIndex intents), not inside this intent.
 * `index` is an ENVELOPE field, so — exactly like SetStyle's `opacity`
 * handling above — UpdateProps's props-only merge can never reach it; this
 * intent's `applyOne` case writes it via a whole-shape `doc.putShape`
 * mirroring UpdateProps/SetStyle's full-shape-inverse convention (undo/redo
 * replay `putShape` of the pre-image / next-image respectively). Silent
 * no-op on an unknown id (the applyAll TOLERANCE CONTRACT) and a no-op (no
 * commit, no undo entry) when `index` already equals the shape's current
 * index, to avoid manufacturing an empty undo step. */
export interface SetIndex { readonly type: 'SetIndex'; readonly id: string; readonly index: string }

export type Intent =
  | CreateShape
  | PutBinding
  | PutAsset
  | TranslateShapes
  | ResizeShapes
  | RotateShapes
  | ReparentShapes
  | DeleteShapes
  | SetText
  | UpdateProps
  | SetStyle
  | StartArrow
  | CompleteArrow
  | SetCamera
  | SetSelection
  | SetHover
  | BeginEdit
  | EndEdit
  | SetNextStyle
  | SetIndex
  | SetCurrentPage
