// The select tool: idle -> pointing(target?) -> dragging(translate) |
// marquee, back to idle on pointerup. Built against a shared ToolContext
// (tool-context.ts) rather than its own hit-test/spatial-index machinery —
// see that module's doc comment for the once-per-commit refresh cadence this
// tool relies on for hitTestTopmost/queryMarquee.
//
// FSM PURITY: SelectState carries everything the FSM needs across events
// (downScreen/targetId/shiftDown/lastClick/grabWorld/startBounds/applied/
// movingIds/excludedIds/snapResult) — there is no mutable field on the
// closure itself. The only closure-captured objects are the ToolContext
// (read-only queries:
// hitTestTopmost/queryMarquee/snapshot/index) and the Editor (read via
// editor.get() for the CURRENT selection/camera, exactly the "read-only
// queries" input.ts's Tool<S> doc comment describes) — never written by this
// file. Given the same (state, event) and the same doc/index snapshot behind
// the ToolContext, onEvent always returns the same (state', intents), so a
// recorded script replays deterministically.
//
// DOUBLE-CLICK-TO-EDIT (Unit 13): a completed click (pointerup resolving a
// sub-threshold Pointing gesture, i.e. NOT a drag/marquee) is remembered on
// the resulting Idle state as `lastClick`. The NEXT pointerdown, while still
// idle, checks whether it lands on the SAME target, within
// input.ts's DOUBLE_CLICK_MS/DOUBLE_CLICK_RADIUS_PX of that remembered click
// (both derived from event.t/x/y deltas ONLY — never a wall clock, per the
// package's determinism rule) — see `isDoubleClick`. If so, the Pointing
// state carries `doubleClick: true`, and when THAT click also resolves
// (pointerup, no drag), the select tool emits `BeginEdit(target)` in place of
// (well, alongside) the ordinary `SetSelection` IFF the target's shape kind
// is TEXT-CAPABLE (canvas-model's `isTextCapableKind`: note/text/geo — never
// an embed kind, never a frame). A drag OR a marquee gesture always resets
// `lastClick` to null on return to idle (neither is a click), and clicking
// empty canvas does too (no target to remember).
//
// SNAP-DURING-DRAG (Unit 13): `computeSnappedDelta` is the ONE seam both the
// Pointing->Dragging transition move AND every subsequent onDragging
// pointermove funnel through — see that function's doc comment. `movingIds`
// (the ids actually being translated) and `excludedIds` (movingIds ∪ every
// descendant — canvas-model's `computeExcludedIds`) are both computed
// EXACTLY ONCE, at the Pointing->Dragging transition (the "drag start" the
// task spec means), and carried unchanged on the Dragging state for the rest
// of the gesture — never recomputed per pointermove (see snapping.ts's own
// documented cost rationale for `opts.excludedIds`: ~2.4ms derived vs
// ~0.02ms precomputed at 1k shapes/999 descendants).
//
// ABSOLUTE-ANCHOR MODEL (Pilot 2 — replaces an earlier incremental model
// that drifted): every pointermove recomputes the drag's TOTAL intended
// translation from the GRAB point (`cursorWorld - grabWorld`, both
// world-space), never a per-move increment off the previous pointer
// position. `computeSnappedDelta` snaps that absolute candidate —
// `startBounds` (the moving selection's world bounds, frozen at the SAME
// Pointing->Dragging transition as movingIds/excludedIds above) shifted by
// the raw TOTAL delta — against the frozen snap snapshot/index, and returns
// the TOTAL (raw + snap) delta from the grab point. The Dragging state's
// `applied` field remembers the total delta actually committed via
// TranslateShapes so far; each move's INTENT is the STEP between the
// newly-computed total and `applied` (`{dx: totalDx - applied.dx, dy:
// totalDy - applied.dy}`), so the shape's on-doc position always equals
// `startBounds + (raw + snap)` for the CURRENT cursor position — never the
// sum of every past move's OWN snap adjustment. That distinction is the fix:
// the prior (incremental) model recomputed each move's snap against the
// shape's ACTUAL current position, which already carried every earlier
// move's snap nudge, so repeatedly crossing a snap band accumulated a drift
// between the shape and the cursor that grew without bound (reproduced by
// interaction-contracts' `drag-cursor-lock` fuzz contract, which is what
// caught it). Under this model a snap adjustment is never carried forward as
// a positional accumulator — it is recomputed FRESH against the
// grab-anchored raw delta on every move, so the shape can never wander more
// than one snap radius from the cursor at any point in the gesture.
//
// REBUILD-CADENCE DISCIPLINE (load-bearing — reviewer-caught before this
// comment existed): tool-context.ts's LAZY REBUILD contract, pinned by
// tool-context.test.ts's "a 50-move drag triggers ZERO rebuilds" assertion,
// means `ctx.snapshot()`/`ctx.index()` must be read AT MOST ONCE per drag
// gesture, not once per pointermove — every commit this tool's OWN drag
// makes marks the context dirty for the NEXT read, so calling either on
// every move would force one full spatial-index rebuild per mouse event
// (exactly the O(shapes)-per-pointermove cost the cadence rule forbids).
// So: `ctx.snapshot()`/`ctx.index()` are read EXACTLY ONCE, at the
// Pointing->Dragging transition (before any TranslateShapes of this gesture
// has committed anything), and the resulting (frozen) doc/index pair is
// carried on Dragging state for snapCandidates' TARGET lookups the whole
// gesture through. Correct with respect to this tool's OWN activity: a
// local drag changes nothing about any OTHER shape's position, size, or
// the document's overall medianSize. Staleness with respect to REMOTE
// activity is exactly snapping.ts's own documented contract, quoted rather
// than paraphrased ("targets are where they were at the last rebuild; the
// moving selection's own correctness comes from the exclusion set, not
// from the index") — snapCandidates reads the index's AABB-family data
// (queryViewport + boundsById), NOT the quad-exact query path, so
// spatial-index.ts's "omissions, never false hits" guarantee does NOT
// apply here: a remote peer moving a target mid-drag CAN produce a snap
// guide (and a snapped delta) at that target's OLD position until the
// gesture ends and the next drag reads a fresh pair. Accepted: a
// one-gesture-stale guide against a concurrently-moving remote target is
// visually self-correcting and far cheaper than an O(shapes) rebuild per
// pointermove. The MOVING shape(s)' own candidate position is likewise
// frozen-relative rather than live-read (see the ABSOLUTE-ANCHOR MODEL note
// above): `startBounds` — captured ONCE at the same Pointing->Dragging
// transition, from the very same frozen snapshot — shifted by the CURRENT
// raw delta from the grab point is the candidate bounds `computeSnappedDelta`
// snaps. There is no read of the moving shape's on-doc position at all after
// drag start; the prior model's `liveBoundsAdapter`/`candidateBoundsAfterDelta`
// live-read shim is gone with it.
import {
  computeExcludedIds,
  isTextCapableKind,
  snapCandidates,
  worldBounds,
  type Bounds,
  type CanvasDocument,
  type SnapResult,
  type SpatialIndex,
} from '@ensembleworks/canvas-model'
import type { Intent } from '../intents.js'
import { crossedThreshold, isDoubleClick, screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

interface Idle {
  readonly mode: 'idle'
  /** The most recently COMPLETED click (a Pointing gesture that resolved at
   * pointerup without crossing the drag threshold) — screen point + target +
   * `event.t`, or null if the previous idle-exit wasn't a click at all (a
   * drag, a marquee) or this is the tool's very first gesture. Consulted by
   * the NEXT pointerdown to decide double-click-ness (see the module
   * header). Only ever set when the click landed on an actual target — an
   * empty-canvas click has nothing to double-click ONTO, so it resets this
   * to null rather than remembering "the user clicked empty space twice". */
  readonly lastClick: { readonly targetId: string; readonly x: number; readonly y: number; readonly t: number } | null
}
interface Pointing {
  readonly mode: 'pointing'
  /** SCREEN point of the pointerdown that started this gesture — threshold
   * comparisons are screen-space (input.ts's crossedThreshold), so this
   * is kept in screen space, not world space. */
  readonly downScreen: { readonly x: number; readonly y: number }
  /** hitTestTopmost's result at pointerdown, or null on a miss. Null steers
   * a drag toward marquee; non-null steers it toward translate. */
  readonly targetId: string | null
  /** shift state AT POINTERDOWN (matches tldraw's own PointingShape.onEnter,
   * which reads info.shiftKey off the pointerdown event that triggered the
   * transition — node_modules/tldraw/src/lib/tools/SelectTool/childStates/
   * PointingShape.ts) — decides add-vs-toggle at click-select time. */
  readonly shiftDown: boolean
  /** True iff THIS pointerdown was recognized, at idle-exit time, as the
   * second half of a double-click on the same target as the previous
   * completed click (see the module header). Decided once, at the
   * idle->pointing transition, off `Idle.lastClick` — never re-derived
   * later, so a click that STARTS as a double-click but then turns into a
   * drag never accidentally becomes a double-click-driven edit (the
   * pointerup branch below only ever inspects this flag from the Pointing
   * state that is still active AT pointerup, i.e. one that never crossed the
   * drag threshold). */
  readonly doubleClick: boolean
}
interface Dragging {
  readonly mode: 'dragging'
  readonly targetId: string
  /** WORLD point under the cursor at the pointerdown that started this drag
   * (`screenToWorld(camera, downScreen)`) — the fixed anchor every
   * subsequent move's translation is computed relative to (see the module
   * header's ABSOLUTE-ANCHOR MODEL section). Never the drag's SCREEN point:
   * a mid-drag camera change re-derives the current cursor's world point
   * under the CURRENT camera, so the grabbed world point stays under the
   * cursor. */
  readonly grabWorld: { readonly x: number; readonly y: number }
  /** The moving selection's UNION world bounds, captured ONCE at the
   * Pointing->Dragging transition from the same frozen snapshot as
   * `snapshot` below — the fixed base every move's candidate bounds
   * (`startBounds` shifted by the raw total delta) is computed against. */
  readonly startBounds: Bounds
  /** The TOTAL (raw + snap) delta from `grabWorld` actually committed via
   * TranslateShapes so far — compared against each move's newly-computed
   * total to derive that move's STEP intent (see the module header's
   * ABSOLUTE-ANCHOR MODEL section). This is what makes each move's snap
   * adjustment ephemeral rather than a positional accumulator. */
  readonly applied: { readonly dx: number; readonly dy: number }
  /** The ids actually being translated — FIXED at the Pointing->Dragging
   * transition (see the module header's SNAP-DURING-DRAG section), never
   * recomputed off a possibly-drifted `editor.get().selection` mid-gesture. */
  readonly movingIds: readonly string[]
  /** `movingIds` ∪ every descendant — computed ONCE via canvas-model's
   * `computeExcludedIds` at the SAME transition, reused verbatim by every
   * subsequent pointermove's `snapCandidates` call (see the module header). */
  readonly excludedIds: ReadonlySet<string>
  /** The doc/index pair `ctx.snapshot()`/`ctx.index()` returned at the
   * Pointing->Dragging transition — read ONCE and frozen for the rest of the
   * gesture (see the module header's REBUILD-CADENCE DISCIPLINE section).
   * Used for snapCandidates' target-shape lookups AND (once, via
   * `startBounds` above) the moving selection's own start position — never
   * re-read live mid-drag. */
  readonly snapshot: CanvasDocument
  readonly snapIndex: SpatialIndex
  /** The most recent snapCandidates result (or null before the first move
   * has computed one) — this is what canvas-react's Overlay ultimately
   * renders as its `snapResult` prop (via the client's tool-loop wiring,
   * Unit 13). Reset to null only by leaving 'dragging' (a fresh drag always
   * starts from a clean slate). */
  readonly snapResult: SnapResult | null
}
interface Marquee {
  readonly mode: 'marquee'
  /** SCREEN point of the pointerdown that started the gesture — the final
   * world rect is computed at pointerup from THIS point and the up event's
   * own (x, y), not accumulated incrementally, so intervening pointermoves
   * need no tracked state at all. */
  readonly downScreen: { readonly x: number; readonly y: number }
}

export type SelectState = Idle | Pointing | Dragging | Marquee

const IDLE: Idle = { mode: 'idle', lastClick: null }

// ============================================================================
// Snap-during-drag helper (shared by the Pointing->Dragging transition move
// AND every subsequent onDragging pointermove — see the module header).
// ============================================================================

/** The union of `ids`' worldBounds under `doc` — used ONCE, at the
 * Pointing->Dragging transition, to capture the moving selection's
 * `startBounds` from the frozen snapshot (see the module header's
 * ABSOLUTE-ANCHOR MODEL section) — never re-read live mid-drag. Reimplemented
 * here rather than imported: canvas-react's combinedWorldBounds
 * (overlay/Selection.tsx) computes the exact same union, but canvas-editor
 * may never import canvas-react (boundary.test.ts forbids a react dependency
 * at all) — this is the same handful of lines, kept package-local. Returns
 * null iff every id is vanished (mirrors combinedWorldBounds' own
 * null-on-empty contract). */
function unionWorldBounds(doc: CanvasDocument, ids: readonly string[]): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false
  for (const id of ids) {
    const shape = doc.byId.get(id)
    if (!shape) continue
    const b = worldBounds(doc, shape)
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    any = true
  }
  return any ? { minX, minY, maxX, maxY } : null
}

/** Given the RAW (pre-snap) TOTAL delta from the drag's grab point (NOT a
 * per-move increment — see the module header's ABSOLUTE-ANCHOR MODEL
 * section), returns the TOTAL delta (raw + snap adjustment) to actually
 * apply via TranslateShapes, plus the SnapResult to carry on the Dragging
 * state for the renderer. `startBounds` is the moving selection's world
 * bounds captured ONCE at drag start (unionWorldBounds, above) — this
 * function shifts it by `rawDx/rawDy` and snaps THAT candidate; it never
 * reads the moving shape's own on-doc position, so a snap adjustment from an
 * earlier move can never leak into a later move's candidate (the fix for the
 * cursor-lock drift the `drag-cursor-lock` contract catches). `frozenSnap`/
 * `frozenIndex` MUST be the pair read ONCE at the Pointing->Dragging
 * transition (see the module header's REBUILD-CADENCE DISCIPLINE section) —
 * used ONLY for target lookups (medianSize + candidate bounds). `excluded`
 * MUST likewise be the drag-start-computed set, passed straight through to
 * snapCandidates' `opts.excludedIds` escape hatch so this never re-derives it
 * per move. */
function computeSnappedDelta(
  startBounds: Bounds,
  frozenSnap: CanvasDocument,
  frozenIndex: SpatialIndex,
  movingIds: readonly string[],
  excluded: ReadonlySet<string>,
  rawDx: number,
  rawDy: number,
): { dx: number; dy: number; snapResult: SnapResult } {
  const bounds: Bounds = {
    minX: startBounds.minX + rawDx, minY: startBounds.minY + rawDy,
    maxX: startBounds.maxX + rawDx, maxY: startBounds.maxY + rawDy,
  }
  const snapResult = snapCandidates(frozenIndex, frozenSnap, movingIds, bounds, { excludedIds: excluded })
  return { dx: rawDx + snapResult.dx, dy: rawDy + snapResult.dy, snapResult }
}

function toggleOrAdd(current: ReadonlySet<string>, id: string): string[] {
  // Shift-click TOGGLE (our documented choice to match tldraw parity):
  // node_modules/tldraw/src/lib/tools/SelectTool/childStates/PointingShape.ts
  // — onEnter adds the shape to the selection only if it wasn't already
  // present (lines ~51-60); if it WAS already present, onEnter's early-return
  // guard (line ~37: `selectedShapeIds.includes(outermostSelectingShape.id)`)
  // routes to onPointerUp's additive branch, which calls
  // `this.editor.deselect(selectingShape)` for a shape already in the
  // selection under the additive (shift/accel) key. Net effect: shift-click
  // ADDS an unselected shape, REMOVES an already-selected one — a toggle, not
  // an add-only. We reproduce that exact net effect here in one step (no
  // separate onEnter/onPointerUp split, since our FSM decides everything at
  // pointerup for symmetry with the miss case — see PointingCanvas note
  // below).
  if (current.has(id)) return [...current].filter((existing) => existing !== id)
  return [...current, id]
}

export function createSelectTool(ctx: ToolContext): Tool<SelectState> {
  const editor = ctx.editor

  function worldOf(screen: { readonly x: number; readonly y: number }) {
    return screenToWorld(editor.get().camera, screen)
  }

  return {
    initialState: IDLE,
    onEvent(state: SelectState, event: InputEvent): { state: SelectState; intents: Intent[] } {
      switch (state.mode) {
        case 'idle':
          return onIdle(state, event)
        case 'pointing':
          return onPointing(state, event)
        case 'dragging':
          return onDragging(state, event)
        case 'marquee':
          return onMarquee(state, event)
      }
    },
  }

  function onIdle(state: Idle, event: InputEvent): { state: SelectState; intents: Intent[] } {
    if (event.type === 'pointerdown') {
      const hit = ctx.hitTestTopmost(worldOf(event))
      // Double-click candidacy, decided ONCE here (see the module header):
      // same target as the last completed click, within the shared
      // isDoubleClick window/radius (event.t/x/y deltas only).
      const doubleClick =
        hit !== null &&
        state.lastClick !== null &&
        state.lastClick.targetId === hit &&
        isDoubleClick(state.lastClick, event)
      return {
        state: { mode: 'pointing', downScreen: { x: event.x, y: event.y }, targetId: hit, shiftDown: event.modifiers.shift, doubleClick },
        intents: [],
      }
    }
    if (event.type === 'pointermove') {
      // SetHover only while idle (per the task spec) — mid-gesture hover is
      // not tracked; the pressed/dragged shape is unambiguous without it.
      const hit = ctx.hitTestTopmost(worldOf(event))
      return { state, intents: [{ type: 'SetHover', id: hit }] }
    }
    return { state, intents: [] }
  }

  function onPointing(state: Pointing, event: InputEvent): { state: SelectState; intents: Intent[] } {
    if (event.type === 'pointermove') {
      const here = crossedThreshold(state.downScreen, event)
      if (!here) return { state, intents: [] }

      if (state.targetId !== null) {
        const targetId = state.targetId
        // MODALITY: never drag the shape currently being text-edited (pilot
        // 4 — interaction-contracts' 'no-drag-while-typing'). The editing
        // textarea owns the pointer while editingId === targetId; treat this
        // pointerdown-turned-drag as a no-op for translation rather than
        // starting a Dragging gesture. Guarded here (the Pointing->Dragging
        // transition), not at pointerdown/onIdle, so click-to-place-caret
        // (handled by the DOM textarea itself, not this FSM) keeps working —
        // only the DRAG is suppressed, and only for a drag that targets the
        // shape actively being edited; a drag started on ANY OTHER shape
        // while editing continues unaffected below.
        // A click (pointerdown+up, no drag) on the shape being edited can
        // re-fire `BeginEdit(target)` on pointerup; that is IDEMPOTENT
        // (editingId is already `=== target`, so re-applying BeginEdit is a
        // no-op), and in the browser the TextEditor textarea's
        // stopPropagation belt (Task E4) means the canvas never even sees
        // that pointer pair.
        // This `editingId` read is LIVE at the threshold-crossing move, not
        // captured at pointerdown; if editing happens to END mid-Pointing (an
        // EndEdit lands between the pointerdown and this move), the live read
        // returns `null` and the drag proceeds normally — benign, because
        // editing is already over, so a translate is exactly what the user
        // now wants.
        if (editor.get().editingId === targetId) return { state, intents: [] }
        const selection = editor.get().selection
        const intents: Intent[] = []
        // "If the pressed target wasn't in the selection, selection becomes
        // [target] first" — our documented rule (task spec, C4): a drag that
        // starts on a shape outside the current selection replaces the
        // selection with just that shape before translating, rather than
        // dragging the old selection out from under the new target.
        if (!selection.has(targetId)) intents.push({ type: 'SetSelection', ids: [targetId] })
        const movingIds = selection.has(targetId) ? [...selection] : [targetId]
        // DRAG START (Unit 13): the ToolContext's doc/index pair is read
        // EXACTLY ONCE here and frozen for the whole gesture (see the module
        // header's REBUILD-CADENCE DISCIPLINE section) — excludedIds is
        // derived from this SAME read, never a separate one.
        const snapshot = ctx.snapshot()
        const snapIndex = ctx.index()
        const excludedIds = computeExcludedIds(snapshot, movingIds)
        const camera = editor.get().camera
        // ABSOLUTE-ANCHOR MODEL (see the module header): grabWorld is the
        // WORLD point under the cursor at pointerdown — the fixed anchor
        // every move (this one and every later one) computes its TOTAL
        // translation relative to. startBounds is the moving selection's
        // world bounds, captured ONCE here from the frozen snapshot.
        const grabWorld = screenToWorld(camera, state.downScreen)
        const startBounds = unionWorldBounds(snapshot, movingIds) ?? {
          minX: grabWorld.x, minY: grabWorld.y, maxX: grabWorld.x, maxY: grabWorld.y,
        }
        const to = screenToWorld(camera, here)
        const rawDx = to.x - grabWorld.x, rawDy = to.y - grabWorld.y
        const { dx, dy, snapResult } = computeSnappedDelta(startBounds, snapshot, snapIndex, movingIds, excludedIds, rawDx, rawDy)
        intents.push({ type: 'TranslateShapes', ids: movingIds, dx, dy })
        return {
          state: { mode: 'dragging', targetId, grabWorld, startBounds, applied: { dx, dy }, movingIds, excludedIds, snapshot, snapIndex, snapResult },
          intents,
        }
      }

      return { state: { mode: 'marquee', downScreen: state.downScreen }, intents: [] }
    }

    if (event.type === 'pointerup') {
      const intents: Intent[] = []
      if (state.targetId !== null) {
        const targetId = state.targetId
        // DOUBLE-CLICK-TO-EDIT (Unit 13): a recognized double-click (set at
        // the idle->pointing transition — see the module header) on a
        // TEXT-CAPABLE target begins editing, in place of the ordinary
        // shift/toggle-or-replace selection logic below. A double-click on
        // a non-text-capable kind (an embed, a frame, …) falls through to
        // the normal single-click resolution unchanged — canvas-model's
        // isTextCapableKind is the ENTIRE gate; there is no separate
        // "did the shape actually resolve" check needed because a vanished
        // target can't be hit-tested as `targetId` in the first place.
        const shape = ctx.snapshot().byId.get(targetId)
        if (state.doubleClick && shape && isTextCapableKind(shape.kind)) {
          intents.push({ type: 'SetSelection', ids: [targetId] })
          intents.push({ type: 'BeginEdit', id: targetId })
        } else if (state.shiftDown) {
          intents.push({ type: 'SetSelection', ids: toggleOrAdd(editor.get().selection, targetId) })
        } else {
          intents.push({ type: 'SetSelection', ids: [targetId] })
        }
        return { state: { mode: 'idle', lastClick: { targetId, x: event.x, y: event.y, t: event.t } }, intents }
      }
      // Click on empty canvas deselects, REGARDLESS of shift — our
      // simplification. tldraw instead skips clearing when the additive
      // (shift/accel) key is held (node_modules/tldraw/src/lib/tools/
      // SelectTool/childStates/PointingCanvas.ts's onEnter: `if
      // (!additiveSelectionKey) { ... selectNone() }`), and does so
      // immediately at pointerDOWN rather than waiting for pointerup. We
      // decide uniformly at pointerup instead (both the hit and miss cases
      // resolve at the same FSM edge, keeping the tool's mutation point
      // singular and easy to reason about/test), and don't special-case
      // shift for the miss case.
      intents.push({ type: 'SetSelection', ids: [] })
      return { state: IDLE, intents } // no target: nothing to remember for a future double-click
    }

    return { state, intents: [] }
  }

  function onDragging(state: Dragging, event: InputEvent): { state: SelectState; intents: Intent[] } {
    if (event.type === 'pointermove') {
      const camera = editor.get().camera
      const cursorWorld = screenToWorld(camera, { x: event.x, y: event.y })
      // ABSOLUTE target translation from the grab point (world-anchored — a
      // mid-drag camera change re-derives cursorWorld under the new camera, so
      // the grabbed world point stays under the cursor; the drift-prone
      // incremental screen anchor is gone). Mirrors transform.ts's
      // recompute-from-gesture-start-anchors pattern.
      const rawDx = cursorWorld.x - state.grabWorld.x
      const rawDy = cursorWorld.y - state.grabWorld.y
      // Reuses the FROZEN startBounds/snapshot/index from drag start
      // (state.startBounds/state.snapshot/state.snapIndex) — never a fresh
      // ctx.snapshot()/ctx.index() read here (see the module header's
      // REBUILD-CADENCE DISCIPLINE section), and never the moving shape's
      // own on-doc position either (see ABSOLUTE-ANCHOR MODEL). totalDx/
      // totalDy is the TOTAL (raw + snap) delta from the grab point — NOT a
      // per-move increment.
      const { dx: totalDx, dy: totalDy, snapResult } = computeSnappedDelta(
        state.startBounds, state.snapshot, state.snapIndex, state.movingIds, state.excludedIds, rawDx, rawDy,
      )
      // The STEP to commit this move is the difference between the newly
      // computed TOTAL and what was already `applied` — this is what keeps a
      // snap adjustment from becoming a positional accumulator (see the
      // module header). TOLERANCE: a mid-drag remote delete of the target
      // (or any moving id) is not this tool's problem to detect —
      // TranslateShapes already skips unresolvable ids (editor.ts's
      // TOLERANCE CONTRACT); computeSnappedDelta itself never depends on the
      // moving shape still existing (startBounds was captured once, at drag
      // start, while it did). We still emit the intent unconditionally; the
      // editor's own per-id skip is what makes that safe.
      const stepDx = totalDx - state.applied.dx
      const stepDy = totalDy - state.applied.dy
      const intents: Intent[] = []
      // COMMIT CADENCE WATCH-ITEM (owned by the H3 perf rig): each of these
      // per-pointermove TranslateShapes intents becomes ONE doc.commit()
      // (script.ts's run() applies per event), i.e. one sync frame per
      // mouse move during a drag. The ToolContext's lazy rebuild keeps the
      // LOCAL index cost off this path, but the wire/undo-granularity cost
      // of per-move commits is unmeasured until H3 profiles it.
      if (stepDx !== 0 || stepDy !== 0) {
        intents.push({ type: 'TranslateShapes', ids: state.movingIds, dx: stepDx, dy: stepDy })
      }
      return { state: { ...state, applied: { dx: totalDx, dy: totalDy }, snapResult }, intents }
    }
    if (event.type === 'pointerup') {
      return { state: IDLE, intents: [] } // a drag is never a click: nothing to remember for double-click
    }
    return { state, intents: [] }
  }

  function onMarquee(state: Marquee, event: InputEvent): { state: SelectState; intents: Intent[] } {
    if (event.type === 'pointermove') {
      return { state, intents: [] } // no live-preview intent exists yet (D2's problem, deferred)
    }
    if (event.type === 'pointerup') {
      const camera = editor.get().camera
      const a = screenToWorld(camera, state.downScreen)
      const b = screenToWorld(camera, { x: event.x, y: event.y })
      const bounds = {
        minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
      }
      // MODE CHOICE: 'intersect' (quad-accurate), pending golden-parity
      // calibration — our documented default, not a confirmed tldraw match.
      // tldraw's own Brushing.ts (node_modules/tldraw/src/lib/tools/
      // SelectTool/childStates/Brushing.ts) actually uses 'intersect'-style
      // semantics by DEFAULT too (a shape is selected once the brush box
      // collides its bounds and a per-edge line-segment hit test against its
      // true geometry succeeds — see hitTestBrushEdges) and only requires
      // full CONTAINMENT in "wrap mode" (a user preference, isWrapMode/
      // ctrlKey-inverted — see Brushing.onEnter/hitTestShapes). So
      // 'intersect' as our default is at minimum directionally aligned with
      // tldraw's non-wrap-mode default, though the exact per-shape test
      // differs (SAT-against-true-quad here vs. line-segment-vs-geometry
      // there) — hence "pending golden-parity calibration" rather than a
      // confirmed match.
      const ids = ctx.queryMarquee(bounds, 'intersect')
      return { state: IDLE, intents: [{ type: 'SetSelection', ids }] }
    }
    return { state, intents: [] }
  }
}
