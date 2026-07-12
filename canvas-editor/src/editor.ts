// The Editor: owns editor-LOCAL state (never persisted to the CRDT — camera,
// selection, hover, the shape being edited) plus the Intent -> doc-op
// translation. This is the one place in the package that touches CanvasDoc
// mutators; everything upstream (tools, scripts, the renderer) only ever
// produces or reads Intents/EditorState.
import type { CanvasDoc } from '@ensembleworks/canvas-doc'
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
 * from under a snapshot that's already been handed out. */
export interface EditorState {
  readonly camera: { readonly x: number; readonly y: number; readonly z: number }
  readonly selection: ReadonlySet<string>
  readonly hover: string | null
  readonly editingId: string | null
}

const INITIAL_STATE: EditorState = {
  camera: { x: 0, y: 0, z: 1 },
  selection: new Set(),
  hover: null,
  editingId: null,
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

/** Per-call result of applying one intent: whether it touched the CanvasDoc
 * (rolls up into ONE doc.commit() for the whole apply()/applyAll() batch)
 * and whether it produced a new EditorState (rolls up into ONE store
 * notification for the whole batch) — see applyAll's doc comment for why
 * these two are tracked and committed/notified separately. */
interface ApplyResult {
  readonly state: EditorState
  readonly docMutated: boolean
  readonly stateChanged: boolean
}

export class Editor {
  readonly doc: CanvasDoc
  readonly now: () => number
  readonly random: () => number
  readonly pageId: string
  private readonly store = createStore<EditorState>(INITIAL_STATE)

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
    })
  }

  /** `fn` fires SYNCHRONOUSLY, at most once per apply()/applyAll() call —
   * never once per Intent inside a batch (see applyAll). The trigger is
   * PER-INTENT-TYPE, not value-equality: any view intent in the batch
   * (SetCamera/SetSelection/SetHover/BeginEdit/EndEdit) counts as "state
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
   * the translate dedupe walk (see dedupeForTranslate) instead of O(1) off a
   * snapshot — a fine trade at editor-interaction scale.
   */
  applyAll(intents: readonly Intent[]): void {
    if (intents.length === 0) return
    let state = this.store.get()
    let docMutated = false
    let stateChanged = false
    for (const intent of intents) {
      const result = this.applyOne(intent, state)
      state = result.state
      docMutated = docMutated || result.docMutated
      stateChanged = stateChanged || result.stateChanged
    }
    if (docMutated) this.doc.commit()
    if (stateChanged) this.store.set(state)
  }

  private applyOne(intent: Intent, state: EditorState): ApplyResult {
    switch (intent.type) {
      case 'CreateShape':
        this.doc.putShape(intent.shape)
        return { state, docMutated: true, stateChanged: false }

      case 'TranslateShapes': {
        const ids = dedupeForTranslate(this.doc, intent.ids)
        let mutated = false
        for (const id of ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          this.doc.putShape({ ...shape, x: shape.x + intent.dx, y: shape.y + intent.dy })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false }
      }

      case 'ResizeSelection': {
        let mutated = false
        for (const id of intent.ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          // Scale the shape's own origin about the fixed anchor, then scale
          // any explicit w/h props by the same per-axis factor. SCOPE LIMIT
          // (documented on ResizeSelection in intents.ts): anchor and
          // shape.x/y are assumed to share a coordinate frame — correct for
          // page-rooted, unrotated-ancestor shapes (the common case a
          // marquee-resize acts on); a shape nested under a rotated parent
          // would need anchor/x/y both converted to that parent's local
          // frame first. Deferred to C8 alongside tldraw-parity polish.
          const x = intent.anchor.x + (shape.x - intent.anchor.x) * intent.scaleX
          const y = intent.anchor.y + (shape.y - intent.anchor.y) * intent.scaleY
          const props: Record<string, unknown> = { ...shape.props }
          if (typeof props.w === 'number') props.w = props.w * intent.scaleX
          if (typeof props.h === 'number') props.h = props.h * intent.scaleY
          this.doc.putShape({ ...shape, x, y, props })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false }
      }

      case 'RotateSelection': {
        let mutated = false
        const cos = Math.cos(intent.dRadians), sin = Math.sin(intent.dRadians)
        for (const id of intent.ids) {
          const shape = this.doc.getShape(id)
          if (!shape) continue
          // Orbit the shape's origin around `center` by dRadians AND spin
          // its own rotation field by the same delta — "rotations add,
          // position orbits", the same composition rule
          // canvas-model/src/geometry.ts's composeTransform documents for a
          // parent-child pair, applied here to a transient rotation instead.
          // SCOPE LIMIT (identical to ResizeSelection's above, documented
          // in both places so C8's implementer finds it either way):
          // `center` and shape.x/y are assumed to share a coordinate frame
          // — correct for page-rooted, unrotated-ancestor shapes; a shape
          // nested under a ROTATED parent is silently wrong here (x/y is in
          // the parent's rotated local frame, center is world). Deferred to
          // C8, which owns converting center into each shape's parent frame
          // before emitting the intent.
          const dx = shape.x - intent.center.x, dy = shape.y - intent.center.y
          const x = intent.center.x + (dx * cos - dy * sin)
          const y = intent.center.y + (dx * sin + dy * cos)
          this.doc.putShape({ ...shape, x, y, rotation: shape.rotation + intent.dRadians })
          mutated = true
        }
        return { state, docMutated: mutated, stateChanged: false }
      }

      case 'ReparentShapes': {
        for (const id of intent.ids) this.doc.reparent(id, intent.parentId)
        return { state, docMutated: intent.ids.length > 0, stateChanged: false }
      }

      case 'DeleteShapes': {
        for (const id of intent.ids) this.doc.deleteShape(id)
        return { state, docMutated: intent.ids.length > 0, stateChanged: false }
      }

      case 'SetText':
        this.doc.setText(intent.id, intent.text)
        return { state, docMutated: true, stateChanged: false }

      case 'StartArrow': {
        this.doc.putShape(intent.shape)
        if (intent.fromBinding) {
          this.doc.putBinding({
            id: `binding:${intent.shape.id}-start` as any,
            fromId: intent.shape.id,
            toId: intent.fromBinding.targetId as any,
            props: { terminal: 'start', anchor: intent.fromBinding.anchor },
            meta: {},
          })
        }
        return { state, docMutated: true, stateChanged: false }
      }

      case 'CompleteArrow': {
        const shape = this.doc.getShape(intent.id)
        if (shape) {
          this.doc.updateProps(intent.id, { end: { x: intent.end.x - shape.x, y: intent.end.y - shape.y } })
        }
        if (intent.toBinding) {
          this.doc.putBinding({
            id: `binding:${intent.id}-end` as any,
            fromId: intent.id as any,
            toId: intent.toBinding.targetId as any,
            props: { terminal: 'end', anchor: intent.toBinding.anchor },
            meta: {},
          })
        }
        return { state, docMutated: true, stateChanged: false }
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
    }
  }
}

// Drop any id whose selection has an ANCESTOR also present in `ids` — the
// TranslateShapes dedupe rule (see TranslateShapes's doc comment in
// intents.ts). Reads the doc LIVE (doc.getShape) rather than via a snapshot:
// this walk only needs each id's own parent chain, not the whole document,
// so there's no snapshot to invalidate. Literal duplicate ids in the input
// collapse for free (a Set dedupes them before the ancestor filter runs).
// Cycle-safe: a `visited` set stops the climb the first time a parentId
// repeats, matching geometry.ts's worldTransform guard.
function dedupeForTranslate(doc: CanvasDoc, ids: readonly string[]): string[] {
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
