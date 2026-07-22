// The Editor: owns editor-LOCAL state (never persisted to the CRDT — camera,
// selection, hover, the shape being edited) plus the Intent -> doc-op
// translation. This is the one place in the package that touches CanvasDoc
// mutators; everything upstream (tools, scripts, the renderer) only ever
// produces or reads Intents/EditorState.
import type { CanvasDoc } from '@ensembleworks/canvas-doc'
import { bindingSchema, toLocalPoint, type Binding, type CanvasDocument, type Point, type Shape } from '@ensembleworks/canvas-model'
import type { Intent } from './intents.js'

// ============================================================================
// Tiny signals store — the generic primitive EditorState rides on.
// Deliberately minimal (no external deps, per the clean-room rule): a single
// immutable state value plus a listener set. `set()` replaces the value by
// reference (never mutates the previous snapshot in place) and calls every
// listener SYNCHRONOUSLY, in registration order, before returning — a
// subscriber that itself calls `get()` mid-notification always sees the NEW
// value, never a half-applied one, because the reference swap happens
// before any listener runs.
// ============================================================================
function createStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: (): T => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set: (next: T): void => {
      state = next
      for (const fn of listeners) fn()
    },
  }
}

/** Editor-local state — NEVER written to the CanvasDoc/CRDT. `camera` is the
 * viewport transform (canvas-react, Seam D, reads it to set the world
 * container's CSS transform); `selection`/`hover`/`editingId` are per-client
 * UI state that has no business syncing to peers (each collaborator has
 * their own). `selection` is a ReadonlySet so a caller can't mutate it out
 * from under a snapshot that's already been handed out. `nextShapeStyle` is
 * the ARMED style (Task AS1) — a style patch a create tool reads into a
 * newly-created shape's props/opacity (Task AS2), the same way it already
 * reads live `camera`; it is set only via `SetNextStyle` and, like the rest
 * of this interface, never persisted to the doc. */
export interface EditorState {
  readonly camera: { readonly x: number; readonly y: number; readonly z: number }
  readonly selection: ReadonlySet<string>
  readonly hover: string | null
  readonly editingId: string | null
  readonly nextShapeStyle: Record<string, unknown>
}

const INITIAL_STATE: EditorState = {
  camera: { x: 0, y: 0, z: 1 },
  selection: new Set(),
  hover: null,
  editingId: null,
  nextShapeStyle: {},
}

export interface EditorOpts {
  doc: CanvasDoc
  /** Injected clock — the editor core never reads a wall clock directly
   * itself (the boundary test forbids that call); tools that need "now"
   * (double-click timing, a created shape's meta timestamp, …) read it from
   * here. */
  now: () => number
  /** Injected PRNG — the editor core never reads a random source directly
   * itself, for the same reason. Id generation (a create tool assigning a
   * fresh shape id) is the expected consumer, starting in C6. */
  random: () => number
  /** The page new content defaults onto when a tool doesn't say otherwise
   * (e.g. a future create-tool convenience). Not read by anything in this
   * file today — CreateShape/StartArrow both carry an explicit parentId on
   * the shape the caller builds — but every Editor needs a home page, so the
   * constructor demands it now rather than each downstream tool inventing
   * its own default. */
  pageId: string
}

/**
 * The undo/redo replay vocabulary (Task B1's inverse-intent stack): every
 * variant maps 1:1 to a `CanvasDoc` PUBLIC mutator — the exact same
 * putShape/deleteShape/setText/putBinding/deleteBinding calls applyOne
 * itself makes — never a raw Loro tree op and never loro-crdt's
 * UndoManager. This is the binding-mechanism decision from Task A1's probe:
 * UndoManager mutates the tree directly and corrupts LoroCanvasDoc's private
 * id→node index on shape create/delete undo/redo; replaying only through
 * the public mutators keeps that index exactly as correct as a live intent
 * would, and — since only THIS peer's own applyAll calls ever push an entry
 * — gives local-peer-only undo scope for free (a remote peer's incoming
 * shapes are never captured, so undo can never touch them).
 *
 * `putShape` is deliberately doing double duty as the inverse for FIVE
 * different intents (Translate/Resize/RotateShapes, ReparentShapes,
 * CompleteArrow's updateProps, and UpdateProps itself): `CanvasDoc.putShape`
 * is a full-field overwrite (it rewrites kind/parentId/index/x/y/rotation/isLocked/opacity/
 * meta/props all at once — see LoroCanvasDoc.putShape) AND repositions the
 * physical tree node to match `shape.parentId` (via placeInTree) — so
 * "restore the exact Shape object read before the mutation" is already a
 * correct, tolerant (never-throws) inverse for every one of those cases,
 * including a reparent's prior parent. No separate 'reparent' op variant is
 * needed as a result.
 */
type InverseOp =
  | { readonly op: 'putShape'; readonly shape: Shape }
  | { readonly op: 'deleteShape'; readonly id: string }
  | { readonly op: 'setText'; readonly id: string; readonly text: string }
  | { readonly op: 'putBinding'; readonly binding: Binding }
  | { readonly op: 'deleteBinding'; readonly id: string }

/** One undone/redoable unit — exactly one apply()/applyAll() batch's worth
 * of doc mutation. `undo` restores doc state to just before the batch ran;
 * `redo` restores it to just after. Both are pre-computed at apply time (not
 * derived from replaying intents again), so undo/redo never re-run
 * tool/intent logic — including a resize's anchor-clamp or an ancestor
 * dedupe — that could recompute a DIFFERENT result the second time. */
interface UndoEntry {
  readonly undo: readonly InverseOp[]
  readonly redo: readonly InverseOp[]
}

/** Per-call result of applying one intent: whether it touched the CanvasDoc
 * (rolls up into ONE doc.commit() for the whole apply()/applyAll() batch)
 * and whether it produced a new EditorState (rolls up into ONE store
 * notification for the whole batch) — see applyAll's doc comment for why
 * these two are tracked and committed/notified separately. `undo`/`redo`
 * are the InverseOps this ONE intent contributes to the batch's UndoEntry
 * (empty/omitted for a view intent or a mutation that resolved to nothing,
 * e.g. every id in a Translate vanished) — see applyAll for how per-intent
 * arrays combine into one batch-level entry. */
interface ApplyResult {
  readonly state: EditorState
  readonly docMutated: boolean
  readonly stateChanged: boolean
  readonly undo?: readonly InverseOp[]
  readonly redo?: readonly InverseOp[]
}

export class Editor {
  readonly doc: CanvasDoc
  readonly now: () => number
  readonly random: () => number
  readonly pageId: string
  private readonly store = createStore<EditorState>(INITIAL_STATE)
  // LOCAL-PEER-ONLY by construction: entries are pushed exclusively from
  // THIS editor instance's own applyAll calls (never from doc.subscribe or
  // an import() callback), so a remote peer's incoming shapes are never
  // captured here and can never be undone by this peer — see the InverseOp
  // doc comment above for the full binding-mechanism rationale.
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []

  constructor(opts: EditorOpts) {
    this.doc = opts.doc
    this.now = opts.now
    this.random = opts.random
    this.pageId = opts.pageId
  }

  /** Immutable snapshot of the editor-local state (NOT the doc — read the
   * doc via `editor.doc.listShapes()` etc). Immutability is RUNTIME, not
   * just TypeScript: each call builds a FRESH snapshot detached from the
   * canonical state — the snapshot object and its camera are Object.frozen
   * (writes throw in strict mode, i.e. in every ES module), and `selection`
   * is a per-call COPY of the canonical Set, because freeze does not stop
   * Set.prototype.add — a frozen Set is still mutable, so handing out a
   * shared reference would let one caller's .add() corrupt the editor for
   * everyone. Selections are small (a hand-picked set of shapes), so a copy
   * per get() is cheap. Consequence of "fresh per call": two get() calls
   * never compare reference-equal, even with no state change in between —
   * detect change via subscribe(), not by comparing snapshot identities.
   * Safe to hold onto: no future apply() can ever mutate a snapshot you
   * already have. Pinned by editor.test.ts's snapshot-corruption probe. */
  get(): EditorState {
    const s = this.store.get()
    return Object.freeze({
      camera: Object.freeze({ ...s.camera }),
      selection: new Set(s.selection),
      hover: s.hover,
      editingId: s.editingId,
      nextShapeStyle: Object.freeze({ ...s.nextShapeStyle }),
    })
  }

  /** `fn` fires SYNCHRONOUSLY, at most once per apply()/applyAll() call —
   * never once per Intent inside a batch (see applyAll). The trigger is
   * PER-INTENT-TYPE, not value-equality: any view intent in the batch
   * (SetCamera/SetSelection/SetHover/BeginEdit/EndEdit/SetNextStyle) counts as "state
   * changed" even when the new value happens to equal the old one — e.g. a
   * SetSelection carrying the identical ids DOES notify. No value-equality
   * dedup is performed; a caller that needs it keeps its last snapshot and
   * compares against a fresh get(). A batch of only mutation intents (no
   * view intents) fires zero times, since EditorState didn't change even
   * though the doc did. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void { return this.store.subscribe(fn) }

  /** Apply a single intent. Equivalent to `applyAll([intent])` — defined in
   * terms of it so the commit/notify granularity rule has exactly one
   * implementation. */
  apply(intent: Intent): void { this.applyAll([intent]) }

  /**
   * Apply a batch of intents as ONE unit: at most one `doc.commit()` (iff
   * any intent in the batch mutated the doc) and at most one store
   * notification (iff any intent in the batch changed EditorState) for the
   * WHOLE batch, not per intent.
   *
   * COMMIT GRANULARITY (the undo/sync unit this package establishes): every
   * apply()/applyAll() call is exactly one commit. A tool driving a
   * multi-event gesture (e.g. a drag: pointerdown -> N pointermoves ->
   * pointerup) that wants ONE undo step for the whole gesture must batch
   * those intents into a single applyAll() call (or accumulate them across
   * events and commit once at pointerup) rather than calling apply() per
   * pointermove — script.ts's `run()` calls applyAll() once per InputEvent,
   * so a tool that wants gesture-level undo granularity must say so by
   * returning all of a gesture's intents from ONE onEvent call (typically
   * the terminating event), not by relying on run()'s dispatch loop to
   * coalesce for it.
   *
   * Doc-model reads for intents that need a shape's CURRENT fields
   * (Translate/Resize/Rotate/CompleteArrow) go straight through
   * `this.doc.getShape(id)` rather than a cached whole-document snapshot —
   * deliberately: a snapshot taken once at the top of a multi-intent batch
   * would go stale the moment an earlier intent in the SAME batch mutates
   * the doc (e.g. CreateShape then TranslateShapes on the shape it just
   * created), and invalidating/rebuilding it correctly is more moving parts
   * than just reading the doc live. Reading live costs O(depth) per id for
   * the ancestor-dedupe walk (see dedupeAncestorOverlap) instead of O(1) off a
   * snapshot — a fine trade at editor-interaction scale.
   *
   * TOLERANCE CONTRACT: mutation intents NEVER throw on stale/vanished
   * targets — they SKIP the unresolvable id and keep going. This is
   * load-bearing, not politeness: Loro mutations apply to the doc the
   * moment the mutator is called, BEFORE this method's single commit(), so
   * an exception between an earlier intent's mutation and the batch commit
   * would leave that mutation uncommitted — it would then leak into the
   * NEXT unrelated apply()'s commit and ship to peers attributed to the
   * wrong batch. Concretely: Translate/Resize/Rotate/CompleteArrow skip via
   * getShape, SetText/DeleteShapes ride CanvasDoc's own silent-no-op
   * contract, and ReparentShapes PRE-VALIDATES each id (see the case below)
   * because doc.reparent is the one CanvasDoc mutator whose contract THROWS
   * on an unknown parent/cycle.
   */
  applyAll(intents: readonly Intent[]): void {
    if (intents.length === 0) return
    let state = this.store.get()
    let docMutated = false
    let stateChanged = false
    // Per-intent InverseOp arrays, kept in APPLICATION order — combined into
    // one batch-level UndoEntry below, once the loop (and therefore every
    // intent's doc mutation) has finished.
    const undoByIntent: (readonly InverseOp[])[] = []
    const redoByIntent: (readonly InverseOp[])[] = []
    for (const intent of intents) {
      const result = this.applyOne(intent, state)
      state = result.state
      docMutated = docMutated || result.docMutated
      stateChanged = stateChanged || result.stateChanged
      if (result.undo && result.undo.length > 0) undoByIntent.push(result.undo)
      if (result.redo && result.redo.length > 0) redoByIntent.push(result.redo)
    }
    if (docMutated) {
      this.doc.commit()
      // UNDO STACK (Task B1): one entry per batch, matching the commit
      // granularity above — undoing a batch undoes the WHOLE batch as one
      // step, never a single intent within it. Ordering: `undo` replays
      // intents' inverses in REVERSE application order (a later intent in
      // the same batch may depend on an earlier one's mutation — e.g.
      // CreateShape then TranslateShapes on the shape it just created — so
      // undoing must unwind the translate before the create); `redo`
      // replays in forward order (reapplying the batch exactly as it first
      // ran). Each intent's OWN InverseOp array keeps its own internal
      // order as computed in applyOne (e.g. DeleteShapes's cascade-restore
      // is already parent-before-child) — only the ORDER OF INTENTS is
      // reversed for undo, not the ops within one intent.
      this.undoStack.push({
        undo: undoByIntent.slice().reverse().flat(),
        redo: redoByIntent.flat(),
      })
      // Standard undo/redo semantics: any new doc-mutating batch from the
      // user invalidates whatever was previously redoable. undo()/redo()
      // themselves never reach this branch (they replay InverseOps
      // directly against the doc — see below — not through applyAll), so
      // this only fires for genuine forward intents, never as a side
      // effect of undo/redo replay.
      this.redoStack = []
    }
    if (stateChanged) this.store.set(state)
  }

  /** Undo the most recent undoable batch (a no-op if the stack is empty —
   * e.g. nothing has mutated the doc yet, or every prior batch has already
   * been undone). Replays that batch's pre-computed InverseOps directly
   * against `this.doc`'s public mutators (see the InverseOp doc comment for
   * why that's both correct and index-safe) and commits once, matching the
   * "one commit per undo/redo step" granularity applyAll establishes for
   * forward intents. Does NOT touch EditorState (camera/selection/hover/
   * editingId) — view state was never captured onto the stack in the first
   * place (see applyOne: view intents return no undo/redo arrays), so there
   * is nothing to restore there; a caller that wants "select the
   * shapes an undo just restored" does so itself via a follow-up
   * SetSelection. */
  undo(): void {
    const entry = this.undoStack.pop()
    if (!entry) return
    this.replay(entry.undo)
    this.redoStack.push(entry)
  }

  /** Redo the most recently undone batch (a no-op if there's nothing to
   * redo — the redo stack is empty, or a new mutation since the last undo
   * already cleared it). See `undo()`'s doc comment for the replay/commit
   * granularity and why EditorState is untouched. */
  redo(): void {
    const entry = this.redoStack.pop()
    if (!entry) return
    this.replay(entry.redo)
    this.undoStack.push(entry)
  }

  /** True iff undo()/redo() would currently do something — for a caller
   * that wants to enable/disable undo/redo UI without poking at internals. */
  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }

  // Replay a pre-computed InverseOp batch through CanvasDoc's public
  // mutators ONLY (never a raw tree op, never UndoManager — see the
  // InverseOp doc comment), then ONE commit for the whole batch.
  //
  // TOLERANCE CONTRACT (mirrors applyAll's — a throw mid-replay would leak
  // this batch's earlier, already-applied inverse ops into the NEXT
  // unrelated commit, attributed to the wrong batch): each op is guarded
  // and SKIPPED on failure. Most variants are already no-throw by contract
  // (deleteShape/setText/deleteBinding silent-no-op on an unknown id;
  // putBinding is a plain upsert) — but `putShape` is NOT: CanvasDoc.putShape
  // THROWS on Loro's native cycle guard when `shape.parentId` names a
  // CURRENT descendant of the node (loro-canvas-doc.ts putShape/placeInTree).
  // A ReparentShapes inverse replays a parentId that differs from the
  // shape's live parent, so a concurrent remote reparent can make that
  // inverse un-appliable (e.g. local moved X A->B, a remote peer then moved
  // A under X; undoing X back under A would close a cycle). The forward
  // ReparentShapes path already tolerates exactly this (canReparent
  // pre-check + try/catch around doc.reparent); the inverse gets the same
  // treatment here — skip the un-appliable op, keep replaying the rest.
  //
  // SECOND SKIP MODE (added with the write boundary): `putShape` now also
  // silently REJECTS a shape that fails validateShape — a rejection this
  // try/catch never observes, because it does not throw. A shape can reach the
  // undo stack already invalid — it arrives through import(), the one path
  // into this peer's doc that bypasses the write boundary. That covers both a
  // live remote peer and a room whose stored SQLite predates the boundary:
  // the server loads such a room via fromSnapshot and relays it here as an
  // ordinary import, so there is ONE route in, not two. (This peer's own doc
  // is never built by fromSnapshot — see client-peer.ts, where it is an
  // unconditional LoroCanvasDoc.create.) Replaying such a shape is a no-op rather
  // than a restore. Deliberate — restoring it would only re-manufacture state
  // repair() is obliged to cascade-delete. User-visible effect: an undo step
  // that appears to do nothing for that shape.
  private replay(ops: readonly InverseOp[]): void {
    if (ops.length === 0) return
    for (const op of ops) {
      try {
        switch (op.op) {
          case 'putShape': this.doc.putShape(op.shape); break
          case 'deleteShape': this.doc.deleteShape(op.id); break
          case 'setText': this.doc.setText(op.id, op.text); break
          case 'putBinding': this.doc.putBinding(op.binding); break
          case 'deleteBinding': this.doc.deleteBinding(op.id); break
        }
      } catch { /* un-appliable inverse (e.g. a cycle from concurrent remote churn) — skip, same as the forward path */ }
    }
    this.doc.commit()
  }

  private applyOne(intent: Intent, state: EditorState): ApplyResult {
    switch (intent.type) {
      case 'CreateShape':
        this.doc.putShape(intent.shape)
        return {
          state, docMutated: true, stateChanged: false,
          undo: [{ op: 'deleteShape', id: intent.shape.id }],
          redo: [{ op: 'putShape', shape: intent.shape }],
        }

      // Validated binding write (Task E2): closes the gap that raw
      // CanvasDoc.putBinding performs NO validation at all (unlike
      // putShape's validateShape gate above) — see intents.ts's PutBinding
      // doc comment. A binding that fails bindingSchema is a TOTAL no-op:
      // no doc.putBinding call, no undo/redo entry, no throw — the same
      // reject-invalid contract putShape already has for shapes.
      case 'PutBinding': {
        const parsed = bindingSchema.safeParse(intent.binding)
        if (!parsed.success) return { state, docMutated: false, stateChanged: false }
        const binding = parsed.data
        this.doc.putBinding(binding)
        return {
          state, docMutated: true, stateChanged: false,
          undo: [{ op: 'deleteBinding', id: binding.id }],
          redo: [{ op: 'putBinding', binding }],
        }
      }

      case 'TranslateShapes': {
        const ids = dedupeAncestorOverlap(this.doc, intent.ids)
        let mutated = false
        const undo: InverseOp[] = []
        const redo: InverseOp[] = []
        for (const id of ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          const next = { ...shape, x: shape.x + intent.dx, y: shape.y + intent.dy }
          this.doc.putShape(next)
          undo.push({ op: 'putShape', shape })
          redo.push({ op: 'putShape', shape: next })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false, undo, redo }
      }

      case 'ResizeShapes': {
        // Scale the shape's own origin about the fixed anchor, then scale
        // any explicit w/h props by the same per-axis factor — CLAMPED per
        // shape/axis so stored w/h can never go negative or below
        // MIN_STORED_SIZE (see clampScale). ANCESTOR DEDUPE (the same rule
        // TranslateShapes has always had, extended here after a reviewer
        // probe proved the double-transform): a selection containing both a
        // parent and its descendant transforms the PARENT only — the
        // child's world frame follows the parent's via composition, and
        // transforming the child too would (a) apply the change twice and
        // (b) convert against the already-mutated parent read live
        // mid-batch, compounding the error. C8 DEFERRAL CLOSURE:
        // `intent.anchor` is WORLD space but shape.x/y lives in the shape's
        // OWN PARENT's frame — worldToParentFrame converts the anchor into
        // that frame, per shape, before composing (see its doc comment).
        // props.w/h scale independently of any frame (a shape's own local,
        // unrotated dimensions), unaffected by that conversion.
        const ids = dedupeAncestorOverlap(this.doc, intent.ids)
        let mutated = false
        const undo: InverseOp[] = []
        const redo: InverseOp[] = []
        for (const id of ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          const props: Record<string, unknown> = { ...shape.props }
          const w = typeof props.w === 'number' ? props.w : undefined
          const h = typeof props.h === 'number' ? props.h : undefined
          // Per-shape clamp: the SAME clamped factor drives both the
          // position math and the w/h scaling, so a clamped shape stays
          // internally consistent (its origin never crosses the anchor
          // while its size floors). Different shapes in one intent may
          // clamp to different factors (each has its own w/h) — the
          // per-shape putShape below already makes that coherent.
          const scaleX = clampScale(intent.scaleX, w)
          const scaleY = clampScale(intent.scaleY, h)
          const anchor = worldToParentFrame(this.doc, shape, intent.anchor)
          const x = anchor.x + (shape.x - anchor.x) * scaleX
          const y = anchor.y + (shape.y - anchor.y) * scaleY
          if (w !== undefined) props.w = w * scaleX
          if (h !== undefined) props.h = h * scaleY
          const next = { ...shape, x, y, props }
          this.doc.putShape(next)
          undo.push({ op: 'putShape', shape })
          redo.push({ op: 'putShape', shape: next })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false, undo, redo }
      }

      case 'RotateShapes': {
        // Orbit the shape's origin around `center` by dRadians AND spin its
        // own rotation field by the same delta — "rotations add, position
        // orbits", the same composition rule canvas-model/src/geometry.ts's
        // composeTransform documents for a parent-child pair, applied here
        // to a transient rotation instead. ANCESTOR DEDUPE (same as
        // ResizeShapes above — see that case's comment for the reviewer-
        // probed double-transform this prevents): parent+descendant
        // selections rotate the parent only; the child's world frame
        // follows for free. C8 DEFERRAL CLOSURE: `center` is WORLD space
        // but shape.x/y lives in the shape's own PARENT's frame —
        // worldToParentFrame converts it per shape before orbiting (see
        // its doc comment). The rotation-field update itself (`shape.rotation
        // + dRadians`) needs NO such conversion and is UNCHANGED by this
        // fix — worldToParentFrame's doc comment explains why adding
        // dRadians to the shape's own local rotation is already correct
        // regardless of the parent's rotation.
        const ids = dedupeAncestorOverlap(this.doc, intent.ids)
        let mutated = false
        const undo: InverseOp[] = []
        const redo: InverseOp[] = []
        const cos = Math.cos(intent.dRadians), sin = Math.sin(intent.dRadians)
        for (const id of ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          const center = worldToParentFrame(this.doc, shape, intent.center)
          const dx = shape.x - center.x, dy = shape.y - center.y
          const x = center.x + (dx * cos - dy * sin)
          const y = center.y + (dx * sin + dy * cos)
          const next = { ...shape, x, y, rotation: shape.rotation + intent.dRadians }
          this.doc.putShape(next)
          undo.push({ op: 'putShape', shape })
          redo.push({ op: 'putShape', shape: next })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false, undo, redo }
      }

      case 'ReparentShapes': {
        // NEVER lean on doc.reparent's throw contract (unknown parent /
        // cycle both throw — the ONE CanvasDoc mutator that does): a throw
        // here is exactly the uncommitted-mutation leak the applyAll
        // TOLERANCE CONTRACT forbids. Pre-validate per id and SKIP the ids
        // that can't move, so valid ids in the same intent still apply
        // (per-id atomicity: no "first id moved, then the second threw").
        let mutated = false
        const undo: InverseOp[] = []
        const redo: InverseOp[] = []
        for (const id of intent.ids) {
          if (!this.canReparent(id, intent.parentId)) continue
          // Captured BEFORE the reparent call: canReparent already proved
          // `id` resolves, so this read is safe. The inverse is
          // putShape(shape) — NOT a dedicated 'reparent' InverseOp — since
          // putShape's placeInTree already restores the exact prior
          // physical parent (and every other field) in one tolerant call;
          // see the InverseOp doc comment.
          const shape = this.doc.getShape(id)!
          // Belt-and-braces: canReparent walks the MODEL parent chain
          // (data.parentId); in pathological split-brain states (duplicate
          // ids under concurrent churn — see LoroCanvasDoc.nodesByShapeId)
          // the PHYSICAL tree can disagree and Loro's native cycle guard
          // could still throw where the model walk said fine. The contract
          // is "never leak", so the engine's own guard is caught and
          // treated as one more skip, not propagated.
          try {
            this.doc.reparent(id, intent.parentId)
            mutated = true
            undo.push({ op: 'putShape', shape })
            redo.push({ op: 'putShape', shape: { ...shape, parentId: intent.parentId as Shape['parentId'] } })
          } catch { /* skip */ }
        }
        return { state, docMutated: mutated, stateChanged: false, undo, redo }
      }

      case 'DeleteShapes': {
        // Real mutated flag: only true if an id actually resolved and was
        // deleted. deleteShape on a missing id is a silent no-op, and
        // committing a no-op batch HAPPENS to be harmless on Loro (an empty
        // commit emits nothing) — but that's an engine detail, not a
        // CanvasDoc contract, so the flag must not rely on it.
        //
        // CASCADE-AWARE INVERSE (Task B1's flagged correctness trap):
        // deleteShape cascades to the shape's ENTIRE subtree (see
        // CanvasDoc.deleteShape's contract — a frame's children die with
        // it), so the inverse of a delete is NOT "recreate one shape" — it's
        // "recreate every deleted shape, PARENTS BEFORE CHILDREN". If a
        // child's putShape ran before its parent existed, placeInTree would
        // fall through to its detach-to-root branch (loro-canvas-doc.ts):
        // the child would come back with the correct parentId DATA but
        // PHYSICALLY at root — a split-brain where re-deleting the parent no
        // longer cascades the child away.
        //
        // Two collapses make parent-before-child hold ACROSS ids, not just
        // within one subtree (the cross-id ordering bug this rewrite fixes —
        // `intent.ids` is user multi-select order, e.g. [child, frame], NOT
        // depth-sorted):
        //   1. SNAPSHOT ALL, THEN DELETE: every requested id's subtree is
        //      captured BEFORE any deletion, so a cascade from one id can't
        //      hide a shape from a later id's collect. The union is deduped
        //      by shape id (a child named explicitly AND covered by its
        //      frame's cascade is one entry).
        //   2. GLOBAL DEPTH SORT: the deduped union is ordered by how many
        //      of its ancestors are also in the set (orderParentBeforeChild),
        //      so a parent always precedes every one of its descendants
        //      regardless of the order they were requested in.
        const toRestore = new Map<string, Shape>()
        const resolvedIds: string[] = []
        for (const id of intent.ids) {
          if (!this.doc.getShape(id)) continue
          resolvedIds.push(id)
          for (const s of collectSubtreeParentFirst(this.doc, id)) {
            if (!toRestore.has(s.id)) toRestore.set(s.id, s)
          }
        }
        if (resolvedIds.length === 0) return { state, docMutated: false, stateChanged: false }
        for (const id of resolvedIds) this.doc.deleteShape(id)
        const undo: InverseOp[] = orderParentBeforeChild([...toRestore.values()], toRestore)
          .map((shape) => ({ op: 'putShape', shape }))
        // redo re-deletes only the originally-requested (resolved) ids; each
        // deleteShape cascades its subtree again, so descendants need no
        // explicit redo op (and a redo op for an id an earlier cascade
        // already removed is a harmless silent no-op).
        const redo: InverseOp[] = resolvedIds.map((id) => ({ op: 'deleteShape', id }))
        return { state, docMutated: true, stateChanged: false, undo, redo }
      }

      case 'SetText': {
        // Consistent with DeleteShapes/TranslateShapes/etc: a real mutated
        // flag gated on the id actually resolving, not CanvasDoc.setText's
        // own silent-no-op contract — committing a no-op batch happens to be
        // harmless on Loro, but that's an engine detail the mutated flag
        // must not lean on (same reasoning as DeleteShapes's comment above).
        // Housekeeping fix (Unit 5 review item): this case used to report
        // docMutated: true unconditionally, unlike every other mutation
        // intent in this switch.
        if (!this.doc.getShape(intent.id)) return { state, docMutated: false, stateChanged: false }
        const priorText = this.doc.getText(intent.id)
        this.doc.setText(intent.id, intent.text)
        return {
          state, docMutated: true, stateChanged: false,
          undo: [{ op: 'setText', id: intent.id, text: priorText }],
          redo: [{ op: 'setText', id: intent.id, text: intent.text }],
        }
      }

      case 'UpdateProps': {
        // Consistent with SetText/DeleteShapes: a real mutated flag gated on
        // the id actually resolving — silent no-op (no throw, docMutated:
        // false) on an unknown id, never leaning on CanvasDoc.updateProps's
        // own silent-no-op contract for the flag itself.
        const shape = this.doc.getShape(intent.id)
        if (!shape) return { state, docMutated: false, stateChanged: false }
        this.doc.updateProps(intent.id, intent.props)
        // Full-shape-inverse convention (same as CompleteArrow's updateProps
        // call above, and Resize/Rotate/Reparent's putShape inverses):
        // `shape` read BEFORE the mutation already holds the pre-image props
        // map, so putShape(shape) is a correct, tolerant restore — no
        // field-surgical "only undo the keys that changed" logic is needed.
        // (A surgical inverse is a documented DEFERRED follow-up, not this
        // unit's scope — see Task D1's plan notes.)
        const undo: InverseOp[] = [{ op: 'putShape', shape }]
        const redo: InverseOp[] = [{ op: 'putShape', shape: { ...shape, props: { ...shape.props, ...intent.props } } }]
        return { state, docMutated: true, stateChanged: false, undo, redo }
      }

      case 'SetStyle': {
        // Batch version of UpdateProps's full-shape-inverse convention (see
        // that case above): for EACH id, read the pre-image, shallow-merge
        // `props` and overwrite `opacity` when given, then putShape the
        // whole next shape — a full putShape (not doc.updateProps) is what
        // lets this intent reach the ENVELOPE opacity field, which
        // updateProps's contract can never touch. Same tolerant per-id skip
        // as Translate/Resize/Rotate (applyAll TOLERANCE CONTRACT): an
        // unresolved id is dropped, never thrown.
        let mutated = false
        const undo: InverseOp[] = []
        const redo: InverseOp[] = []
        for (const id of intent.ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          const next = {
            ...shape,
            props: intent.props ? { ...shape.props, ...intent.props } : shape.props,
            opacity: intent.opacity ?? shape.opacity,
          }
          this.doc.putShape(next)
          undo.push({ op: 'putShape', shape })
          redo.push({ op: 'putShape', shape: next })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false, undo, redo }
      }

      case 'StartArrow': {
        // Malformed intent (kind !== 'arrow') is SKIPPED, not asserted: a
        // throw mid-batch would leak earlier intents' uncommitted mutations
        // (the applyAll TOLERANCE CONTRACT), and there is no safe partial-
        // commit alternative. A skipped StartArrow is loudly visible to its
        // emitting tool (the arrow it expects never appears).
        if (intent.shape.kind !== 'arrow') return { state, docMutated: false, stateChanged: false }
        this.doc.putShape(intent.shape)
        const undo: InverseOp[] = [{ op: 'deleteShape', id: intent.shape.id }]
        const redo: InverseOp[] = [{ op: 'putShape', shape: intent.shape }]
        if (intent.fromBinding) {
          const binding: Binding = {
            id: `binding:${intent.shape.id}-start` as any,
            fromId: intent.shape.id,
            toId: intent.fromBinding.targetId as any,
            props: { terminal: 'start', anchor: intent.fromBinding.anchor },
            meta: {},
          }
          this.doc.putBinding(binding)
          // Binding inverse ordered before the shape's own inverse: not
          // load-bearing for CanvasDoc (bindings/shapes are independent
          // maps — deleteShape does not touch the bindings map, so either
          // order leaves the doc equally correct), but keeps "undo the
          // thing that references X before X itself" as the READING
          // convention for this array.
          undo.unshift({ op: 'deleteBinding', id: binding.id })
          redo.push({ op: 'putBinding', binding })
        }
        return { state, docMutated: true, stateChanged: false, undo, redo }
      }

      case 'CompleteArrow': {
        // BOTH halves gate on the arrow still resolving: if the arrow
        // vanished (remote delete racing the local gesture), writing the
        // end binding anyway would create a DANGLING binding pointing at a
        // dead fromId — repair() would eventually sweep it, but the editor
        // must not manufacture garbage for repair to clean.
        const shape = this.doc.getShape(intent.id)
        if (!shape) return { state, docMutated: false, stateChanged: false }
        const end = { x: intent.end.x - shape.x, y: intent.end.y - shape.y }
        this.doc.updateProps(intent.id, { end })
        // updateProps MERGES ({...cur, ...props}), but `shape` (read before
        // the call) already holds every OTHER field plus the OLD props
        // untouched — putShape(shape) is a full overwrite, so replaying it
        // exactly reverses this updateProps call (same "putShape as a
        // universal restore-prior-state inverse" pattern as Resize/Rotate/
        // Reparent above).
        const undo: InverseOp[] = [{ op: 'putShape', shape }]
        const redo: InverseOp[] = [{ op: 'putShape', shape: { ...shape, props: { ...shape.props, end } } }]
        if (intent.toBinding) {
          const binding: Binding = {
            id: `binding:${intent.id}-end` as any,
            fromId: intent.id as any,
            toId: intent.toBinding.targetId as any,
            props: { terminal: 'end', anchor: intent.toBinding.anchor },
            meta: {},
          }
          this.doc.putBinding(binding)
          undo.unshift({ op: 'deleteBinding', id: binding.id })
          redo.push({ op: 'putBinding', binding })
        }
        return { state, docMutated: true, stateChanged: false, undo, redo }
      }

      case 'SetCamera':
        return { state: { ...state, camera: { x: intent.x, y: intent.y, z: intent.z } }, docMutated: false, stateChanged: true }

      case 'SetSelection':
        return { state: { ...state, selection: new Set(intent.ids) }, docMutated: false, stateChanged: true }

      case 'SetHover':
        return { state: { ...state, hover: intent.id }, docMutated: false, stateChanged: true }

      case 'BeginEdit':
        return { state: { ...state, editingId: intent.id }, docMutated: false, stateChanged: true }

      case 'EndEdit':
        return { state: { ...state, editingId: null }, docMutated: false, stateChanged: true }

      case 'SetNextStyle':
        // View intent (Task AS1): shallow-merges `props` into the existing
        // nextShapeStyle — arming color then arming size accumulates both,
        // it does not replace. No doc.putShape/updateProps, no undo/redo
        // arrays — mirrors SetCamera/SetSelection/SetHover/BeginEdit/EndEdit
        // above exactly.
        return {
          state: { ...state, nextShapeStyle: { ...state.nextShapeStyle, ...intent.props } },
          docMutated: false,
          stateChanged: true,
        }
    }
  }

  // Can `id` legally move under `parentId` RIGHT NOW? The ReparentShapes
  // pre-validation (see that case): doc.reparent throws on an unknown
  // parent or a cycle, and the applyAll TOLERANCE CONTRACT forbids letting
  // either throw reach a batch. Rules, in order:
  //   1. `id` must itself resolve (reparent of a missing id is a silent
  //      no-op in CanvasDoc, but "applied" would be a lie for the mutated
  //      flag — treat it as a skip).
  //   2. A page target is always placeable (reparent's own semantics: any
  //      'page:' prefix means "move to root"; it does not check the page
  //      exists, and neither do we — same tolerance).
  //   3. A shape target must resolve via getShape.
  //   4. The move must not create a cycle: self-parenting is the degenerate
  //      case, and otherwise the TARGET's parent chain must not pass
  //      through `id` (if it does, id is the target's ancestor and moving
  //      it under the target closes a loop). The walk is over MODEL
  //      parentIds (getShape), visited-set-guarded so a pre-existing
  //      malformed cycle in the chain terminates instead of hanging —
  //      same discipline as geometry.ts's worldTransform.
  private canReparent(id: string, parentId: string): boolean {
    if (!this.doc.getShape(id)) return false
    if (parentId.startsWith('page:')) return true
    if (parentId === id) return false // self-parent: degenerate cycle
    const target = this.doc.getShape(parentId)
    if (!target) return false // vanished/unknown parent — skip, never throw
    const visited = new Set<string>([parentId])
    let current: typeof target | undefined = target
    while (current) {
      const nextId: string = current.parentId
      if (nextId === id) return false // target sits under `id` — the move would cycle
      if (visited.has(nextId)) break // malformed pre-existing cycle: stop climbing
      visited.add(nextId)
      current = this.doc.getShape(nextId) // undefined once the chain reaches a page
    }
    return true
  }
}

// A byId-only CanvasDocument adapter over LIVE doc.getShape reads.
// canvas-model/src/geometry.ts's worldTransform/toLocalPoint — the ONLY
// canvas-model functions worldToParentFrame below calls — touch NOTHING on
// their `doc` argument except `.byId.get`, so this minimal shim lets
// Resize/RotateShapes reuse those NORMATIVE conversions against LIVE reads
// (this.doc.getShape) instead of a whole-doc dumpModel() snapshot —
// consistent with applyAll's documented "read live, never snapshot
// mid-batch" discipline (see its big doc comment above) and avoiding an
// O(shapes) dumpModel call on every Resize/Rotate intent.
function liveDocAdapter(doc: CanvasDoc): CanvasDocument {
  return {
    pages: [], shapes: [], bindings: [],
    byId: { get: (id: string) => doc.getShape(id) } as unknown as CanvasDocument['byId'],
  }
}

// DeleteShapes's undo helper (Task B1's flagged correctness trap): the full
// pre-image of `rootId`'s subtree, PARENT-BEFORE-CHILD ordered (a
// breadth-first walk starting at the root, so every parent is emitted before
// any of its descendants) — the exact order undo must recreate the cascade
// in, so a child's putShape never runs before its parent's. Returns [] if
// `rootId` itself doesn't resolve (mirrors DeleteShapes's own "vanished id,
// skip" tolerance — this is only ever called right after the caller's own
// getShape check confirms the root exists, so that branch is defense-in-
// depth, not a live path). Reads the WHOLE doc via listShapes() once per
// call — O(shapes), same trade-off liveDocAdapter's neighbor comment above
// already accepts for this package ("fine at editor-interaction scale") —
// rather than trying to answer "does X have children" without a full scan,
// since CanvasDoc exposes no children-of-id query of its own.
function collectSubtreeParentFirst(doc: CanvasDoc, rootId: string): Shape[] {
  const root = doc.getShape(rootId)
  if (!root) return []
  const childrenByParent = new Map<string, Shape[]>()
  for (const s of doc.listShapes()) {
    const arr = childrenByParent.get(s.parentId)
    if (arr) arr.push(s); else childrenByParent.set(s.parentId, [s])
  }
  const result: Shape[] = [root]
  const queue: string[] = [rootId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const child of childrenByParent.get(parentId) ?? []) {
      result.push(child)
      queue.push(child.id)
    }
  }
  return result
}

// Order `shapes` PARENT-BEFORE-CHILD globally (DeleteShapes's undo helper —
// the cross-id ordering fix): a shape is placed after every one of its
// ancestors that is ALSO in the set. Keyed by depth = the number of a
// shape's ancestors present in `byId` (its own parentId chain, counting only
// hops that stay inside the set — an ancestor outside the set, e.g. the page
// or an undeleted frame, is a "root" for ordering and stops the count). A
// parent always has strictly smaller depth than any of its descendants, so a
// stable ascending sort by depth guarantees parent-before-child; siblings
// (equal depth) keep their relative order, which is irrelevant to
// correctness. Cycle-safe: a `visited` set stops the climb if the parentId
// chain ever repeats (a pre-existing malformed cycle), matching the
// visited-guard discipline dedupeAncestorOverlap/geometry.ts use. O(n·depth),
// same editor-interaction-scale trade-off as collectSubtreeParentFirst above.
// EXPORTED (Task F1, canvas-phase4): the parity harness's masked-diff
// screenshot comparison surfaced a real ShapeLayer paint-order bug
// (canvas-react/src/ShapeLayer.tsx maps `queryViewport`'s result directly,
// which returns ids in spatial-index/hash-grid iteration order, NOT
// document/z order — an opaque container (e.g. a frame body) can therefore
// paint AFTER, and fully occlude, a child rendered earlier in that
// arbitrary order). This exact depth-sort already solves that class of
// problem for undo; canvas-react reuses it rather than re-deriving an
// equivalent sort.
export function orderParentBeforeChild(shapes: Shape[], byId: ReadonlyMap<string, Shape>): Shape[] {
  const depthOf = (s: Shape): number => {
    let depth = 0
    const visited = new Set<string>([s.id])
    let parent = byId.get(s.parentId)
    while (parent && !visited.has(parent.id)) {
      depth += 1
      visited.add(parent.id)
      parent = byId.get(parent.parentId)
    }
    return depth
  }
  // Array.prototype.sort is stable in every JS engine since ES2019, so
  // equal-depth siblings keep insertion order (no correctness dependence on
  // it — noted only so a reader isn't surprised by the deterministic result).
  return shapes.map((s) => ({ s, d: depthOf(s) })).sort((a, b) => a.d - b.d).map((x) => x.s)
}

// Convert a WORLD point into the frame `shape.x`/`shape.y` ITSELF lives in —
// i.e. `shape`'s PARENT's world rigid transform, NOT the shape's own (which
// would additionally undo the shape's OWN rotation — the wrong operation:
// x/y is defined relative to the PARENT, prior to the shape composing its
// own rotate-then-translate on top, per geometry.ts's ROTATION CONVENTION/
// composeTransform). THE C8 DEFERRAL CLOSURE this function exists for:
// ResizeShapes/RotateShapes below convert their world-space anchor/center
// through this before composing with a shape's x/y, fixing both cases'
// previously-documented SCOPE LIMIT — a nested shape under a ROTATED parent
// was silently wrong because anchor/center (world) and shape.x/y (parent-
// local) were composed as though they shared one frame, which coincidentally
// holds for a ROOT-parented shape (the page has no rotation of its own) but
// not for a shape nested under a rotated ancestor.
//
// Missing parent (shape.parentId names a page, or a vanished ancestor — the
// same "treat as page-root" tolerance canvas-model's worldTransform itself
// documents for this exact situation) means the parent's frame IS the world
// frame, so the point passes through unchanged with no canvas-model call at
// all — this is also why a ROOT-parented shape's Resize/Rotate math is
// UNCHANGED by this fix (worldToParentFrame is the identity for it).
//
// Only the position (anchor/center) needs this conversion — a shape's own
// `rotation` field composes additively regardless of the parent's rotation
// (world rotation = parent.rotation + shape.rotation, and parent.rotation is
// untouched by rotating a child), so RotateShapes's `shape.rotation +
// intent.dRadians` needs no corresponding fix.
function worldToParentFrame(doc: CanvasDoc, shape: Shape, worldPoint: Point): Point {
  const parent = doc.getShape(shape.parentId)
  if (!parent) return worldPoint
  return toLocalPoint(liveDocAdapter(doc), parent, worldPoint)
}

// The ResizeShapes minimum stored size, in world units: stored props.w/h may
// never drop below this (and, transitively, never go NEGATIVE — a corner
// dragged THROUGH the opposite anchor implies a negative scale, which
// uncorrected would persist inverted geometry forever; geometry.ts's size()
// clamps the RENDERED size to >= 0, but the STORED envelope would stay
// corrupt and every other consumer of props.w/h would see it). tldraw
// instead FLIPS the shape across the anchor — real scope (routing/anchor
// implications for bound arrows, handle relabeling), deferred as a
// documented Phase-4 parity item; the clamp is the safe v1 behavior.
const MIN_STORED_SIZE = 1

// Clamp one axis's scale factor so `dim * scale` (the stored size this
// resize would write) stays >= MIN_STORED_SIZE. Shapes without a stored
// dimension on this axis (note — kind-default-sized, no props.w/h) pass the
// scale through untouched: there is no stored geometry to corrupt, and their
// position legitimately scales about the anchor like any other shape's. A
// degenerate stored dim (<= 0 — pre-existing corrupt data this clamp exists
// to prevent, or a legacy zero) can't derive a meaningful floor factor;
// forbid sign flips (scale floored at 0) so the corruption at least never
// gets WORSE. NOTE (behavioral edge, documented not hidden): once a drag
// gesture's absolute scale is clamped here, the emitting tool's own
// incremental-ratio bookkeeping (transform.ts) diverges from the doc until
// the pointer returns past the floor — dragging through the anchor and back
// lands near the floor rather than exactly retracing; exact retrace (like
// flip itself) is part of the same Phase-4 parity item.
function clampScale(scale: number, dim: number | undefined): number {
  if (dim === undefined) return scale
  if (!(dim > 0)) return Math.max(scale, 0)
  return Math.max(scale, MIN_STORED_SIZE / dim)
}

// Drop any id that has an ANCESTOR also present in `ids` — the shared
// dedupe rule for ALL THREE whole-shape transform intents
// (Translate/Resize/RotateShapes; see their doc comments in intents.ts): a
// child's world transform is parentWorld ∘ local (geometry.ts's
// composeTransform), so transforming the parent already carries every
// descendant's world frame — transforming a selected descendant TOO would
// apply the change twice, and for Resize/Rotate would additionally convert
// against the already-mutated parent read live mid-batch (reviewer-probed:
// parent+child rotate about the parent's position left the child at DOUBLE
// the intended world rotation before this rule covered those intents).
// Reads the doc LIVE (doc.getShape) rather than via a snapshot: this walk
// only needs each id's own parent chain, not the whole document, so
// there's no snapshot to invalidate. Literal duplicate ids in the input
// collapse for free (a Set dedupes them before the ancestor filter runs).
// Cycle-safe: a `visited` set stops the climb the first time a parentId
// repeats, matching geometry.ts's worldTransform guard.
function dedupeAncestorOverlap(doc: CanvasDoc, ids: readonly string[]): string[] {
  const idSet = new Set(ids)
  return [...idSet].filter((id) => !hasAncestorIn(doc, id, idSet))
}

function hasAncestorIn(doc: CanvasDoc, id: string, idSet: ReadonlySet<string>): boolean {
  const visited = new Set<string>([id])
  let current = doc.getShape(id)
  while (current) {
    const parentId = current.parentId
    if (visited.has(parentId)) return false // cycle guard: parent chain repeats, stop
    visited.add(parentId)
    if (idSet.has(parentId)) return true
    current = doc.getShape(parentId) // undefined once parentId names a page — chain ends there
  }
  return false
}
