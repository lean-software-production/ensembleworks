// The Intent union: the editor's ONLY vocabulary for changing anything,
// either the CRDT-backed document (mutation intents) or the editor-local
// store (view intents — camera/selection/hover/editing; see editor.ts's
// EditorState). Tool FSMs (select/hand/create/arrow/transform, C4-C8) never
// call CanvasDoc methods directly; they emit Intents and the Editor decides
// how each becomes doc ops. This indirection is what makes a tool testable
// as pure (state, InputEvent) -> (state', Intent[]) with no doc at all — see
// script.ts's `run()`.
import type { Shape } from '@ensembleworks/canvas-model'

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

/** Move every shape in `ids` by (dx, dy) in its own parent's local frame.
 * `ids` is DEDUPED against ancestor/descendant overlap before mutation — see
 * editor.ts's dedupeForTranslate: a selection containing both a parent and
 * one of its (possibly indirect) children moves the child only once, via the
 * parent's translation, because a child's world position is already
 * relative to its parent (translating the parent moves the child's world
 * position for free; translating the child TOO would double-move it). */
export interface TranslateShapes { readonly type: 'TranslateShapes'; readonly ids: readonly string[]; readonly dx: number; readonly dy: number }

/** Scale every shape in `ids` about the fixed world point `anchor` (e.g. the
 * opposite handle from the one being dragged). Applied per-shape to x/y and,
 * where present, props.w/h — see editor.ts's applyOne for the exact
 * transform and its documented scope limit (assumes `anchor` and each
 * shape's x/y share a coordinate frame; nested-rotated-parent resize is
 * deferred to C8 alongside the rest of tldraw-parity). */
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
 * transient rotation delta instead of a parent relationship. SCOPE LIMIT
 * (the same one ResizeShapes documents above, for the same reason):
 * `center` and each shape's x/y are assumed to share a coordinate frame —
 * correct for page-rooted, unrotated-ancestor shapes; a shape nested under
 * a ROTATED parent is silently wrong here (its x/y lives in the parent's
 * rotated local frame while `center` is world — orbiting one around the
 * other mixes frames). Nested-rotated-parent correctness is deferred to C8
 * (the transform tool), which owns converting center/anchor into each
 * shape's parent frame before emitting these intents. */
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

export type Intent =
  | CreateShape
  | TranslateShapes
  | ResizeShapes
  | RotateShapes
  | ReparentShapes
  | DeleteShapes
  | SetText
  | StartArrow
  | CompleteArrow
  | SetCamera
  | SetSelection
  | SetHover
  | BeginEdit
  | EndEdit
