// The select tool: idle -> pointing(target?) -> dragging(translate) |
// marquee, back to idle on pointerup. Built against a shared ToolContext
// (tool-context.ts) rather than its own hit-test/spatial-index machinery —
// see that module's doc comment for the once-per-commit refresh cadence this
// tool relies on for hitTestTopmost/queryMarquee.
//
// FSM PURITY: SelectState carries everything the FSM needs across events
// (downScreen/targetId/shiftDown/lastScreen) — there is no mutable field on
// the closure itself. The only closure-captured objects are the ToolContext
// (read-only queries: hitTestTopmost/queryMarquee/snapshot) and the Editor
// (read via editor.get() for the CURRENT selection/camera, exactly the "read-
// only queries" input.ts's Tool<S> doc comment describes) — never written by
// this file. Given the same (state, event) and the same doc/index snapshot
// behind the ToolContext, onEvent always returns the same (state', intents),
// so a recorded script replays deterministically.
import type { Intent } from '../intents.js'
import { crossedThreshold, screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

interface Idle {
  readonly mode: 'idle'
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
}
interface Dragging {
  readonly mode: 'dragging'
  readonly targetId: string
  /** SCREEN point of the previous event processed in this drag (pointerdown
   * on entry, then each pointermove) — TranslateShapes deltas are computed
   * incrementally, screen-delta-since-last-event / camera.z, so this is the
   * "last" anchor for that computation, not the drag's origin. */
  readonly lastScreen: { readonly x: number; readonly y: number }
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

const IDLE: Idle = { mode: 'idle' }

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
      return {
        state: { mode: 'pointing', downScreen: { x: event.x, y: event.y }, targetId: hit, shiftDown: event.modifiers.shift },
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
        const selection = editor.get().selection
        const intents: Intent[] = []
        // "If the pressed target wasn't in the selection, selection becomes
        // [target] first" — our documented rule (task spec, C4): a drag that
        // starts on a shape outside the current selection replaces the
        // selection with just that shape before translating, rather than
        // dragging the old selection out from under the new target.
        if (!selection.has(targetId)) intents.push({ type: 'SetSelection', ids: [targetId] })
        const ids = selection.has(targetId) ? [...selection] : [targetId]
        const camera = editor.get().camera
        const from = screenToWorld(camera, state.downScreen)
        const to = screenToWorld(camera, here)
        intents.push({ type: 'TranslateShapes', ids, dx: to.x - from.x, dy: to.y - from.y })
        return { state: { mode: 'dragging', targetId, lastScreen: here }, intents }
      }

      return { state: { mode: 'marquee', downScreen: state.downScreen }, intents: [] }
    }

    if (event.type === 'pointerup') {
      const intents: Intent[] = []
      if (state.targetId !== null) {
        if (state.shiftDown) {
          intents.push({ type: 'SetSelection', ids: toggleOrAdd(editor.get().selection, state.targetId) })
        } else {
          intents.push({ type: 'SetSelection', ids: [state.targetId] })
        }
      } else {
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
      }
      return { state: IDLE, intents }
    }

    return { state, intents: [] }
  }

  function onDragging(state: Dragging, event: InputEvent): { state: SelectState; intents: Intent[] } {
    if (event.type === 'pointermove') {
      const here = { x: event.x, y: event.y }
      const camera = editor.get().camera
      const from = screenToWorld(camera, state.lastScreen)
      const to = screenToWorld(camera, here)
      const dx = to.x - from.x, dy = to.y - from.y
      const intents: Intent[] = []
      // TOLERANCE: a mid-drag remote delete of the target (or any selected
      // id) is not this tool's problem to detect — TranslateShapes already
      // skips unresolvable ids (editor.ts's TOLERANCE CONTRACT), so a
      // vanished target just makes this event a no-op translate, never a
      // throw. We still emit the intent unconditionally; the editor's own
      // per-id skip is what makes that safe.
      //
      // COMMIT CADENCE WATCH-ITEM (owned by the H3 perf rig): each of these
      // per-pointermove TranslateShapes intents becomes ONE doc.commit()
      // (script.ts's run() applies per event), i.e. one sync frame per
      // mouse move during a drag. The ToolContext's lazy rebuild keeps the
      // LOCAL index cost off this path, but the wire/undo-granularity cost
      // of per-move commits is unmeasured until H3 profiles it.
      if (dx !== 0 || dy !== 0) {
        intents.push({ type: 'TranslateShapes', ids: [...editor.get().selection], dx, dy })
      }
      return { state: { ...state, lastScreen: here }, intents }
    }
    if (event.type === 'pointerup') {
      return { state: IDLE, intents: [] }
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
