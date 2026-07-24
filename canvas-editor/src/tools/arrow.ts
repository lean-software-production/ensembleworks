// The arrow tool: idle -> pointing -> drawing (threshold-crossed), back to
// idle on pointerup. Built against the shared ToolContext (tool-context.ts)
// exactly like select/create — see that module's doc comment for the
// once-per-commit hitTestTopmost/snapshot refresh cadence this tool relies
// on for resolving a binding target.
//
// THRESHOLD GATE (same discipline as create.ts — nothing commits until the
// gesture proves it's a drag): pointerdown only records the down point;
// StartArrow (the first doc write) fires at the first pointermove that
// crosses DRAG_THRESHOLD, and a bare click / sub-threshold wiggle commits
// NOTHING (idle again on pointerup, zero intents — a click-only arrow would
// be a zero-length orphan, useless by construction). Without this gate a
// pointerdown with no completing gesture would permanently orphan a
// zero-length arrow visible to all peers. Pinned by arrow.test.ts's
// bare-click test.
//
// ABANDONMENT GAP (shared across ALL drag-capable tools — create.ts's
// drag-to-size and this tool alike; noted here because the arrow preview is
// the most user-visible case): once the threshold IS crossed, the in-flight
// preview shape is committed to the doc on every pointermove (see the
// COMMIT CADENCE note in the drawing state), so a gesture that never
// reaches pointerup — tool switched mid-drag, tab close/WS disconnect,
// component unmount — leaves the preview shape permanently in the doc,
// visible to every peer. The cancel path (Escape/blur/unmount emitting
// DeleteShapes for the in-flight id) is owned by the Seam D/G3 wiring that
// owns those lifecycle events; this package's FSMs never see them.
//
// LIVE PREVIEW, NO SPECULATIVE BINDINGS (the "CreateShape-upsert pattern or
// props update" choice the task spec asks for): every pointermove during
// 'drawing' emits a CompleteArrow with the CURRENT world point and
// `toBinding: undefined` — CompleteArrow's editor.ts case always calls
// doc.updateProps({ end }) regardless of whether a binding is supplied, so
// this is exactly a live "props update" of the arrow's end, reusing the
// intent that already exists rather than inventing a new one. The binding
// itself is resolved and written EXACTLY ONCE, at pointerup, with whatever
// target the pointer is over at that final instant. This sidesteps a real
// hazard: if an intermediate pointermove wrote a binding whenever it
// happened to be hovering a shape, then a LATER pointermove that drags off
// that shape onto empty canvas has no way to retract it (CompleteArrow can
// only WRITE a binding, never clear one — see intents.ts), leaving a stale/
// wrong binding from a shape the arrow no longer visually touches. Resolving
// once, at the end, means there is only ever one binding-writing moment to
// reason about. Pinned by arrow.test.ts's no-bindings-mid-draw test.
import { indexBetween, resolveArrowAnchor, type Shape } from '@ensembleworks/canvas-model'
import type { ArrowBinding, Intent } from '../intents.js'
import { crossedThreshold, screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

interface Idle {
  readonly mode: 'idle'
}
interface Pointing {
  readonly mode: 'pointing'
  /** SCREEN point of the pointerdown — the arrow's start point (converted
   * to world at threshold-crossing time) AND the crossedThreshold origin. */
  readonly downScreen: { readonly x: number; readonly y: number }
  /** The pointerdown's timestamp, kept for makeId: the id is minted at
   * threshold-crossing time but derives from the DOWN event's own t/x/y —
   * the gesture's identity is where it started, not where it crossed. */
  readonly downT: number
}
interface Drawing {
  readonly mode: 'drawing'
  readonly id: string
}

export type ArrowState = Idle | Pointing | Drawing

const IDLE: ArrowState = { mode: 'idle' }

// Id factory: mirrors create.ts's makeId exactly (same COLLISION
// PRECONDITION contract documented there — event.t monotonicity within one
// clock domain plus the random() draw separating cross-domain twins; see
// that file for the full writeup). Not imported from create.ts: makeId is
// module-private there, and pulling two otherwise-independent tool FSMs
// together over a five-line id helper is not worth the coupling.
function makeId(event: { readonly t: number; readonly x: number; readonly y: number }, random: () => number): string {
  const salt = Math.floor(random() * 1e9).toString(36)
  return `shape:${event.t}-${Math.round(event.x)}-${Math.round(event.y)}-${salt}`
}

// Task C1 (D-5) — top-of-stack index at creation, mirrors create.ts's
// topIndex exactly (same rationale as makeId above for NOT importing it:
// module-private there, and coupling two independent tool FSMs over a
// five-line helper isn't worth it). No threading/state-storage concern here
// unlike create.ts's drag-to-size: StartArrow (below) is the ONLY intent
// that ever sets this arrow's index -- every later pointermove in 'drawing'
// emits CompleteArrow, which is a props-only `end` update (see the module
// header's LIVE PREVIEW note) and never touches index, so a single inline
// call at the pointing->drawing transition is inherently "compute once."
function topIndex(ctx: ToolContext, parentId: string): string {
  const siblings = ctx.snapshot().shapes.filter((s) => s.parentId === parentId)
  let max: string | null = null
  for (const s of siblings) {
    if (max === null || s.index > max) max = s.index
  }
  return indexBetween(max, null)
}

export function createArrowTool(ctx: ToolContext): Tool<ArrowState> {
  const editor = ctx.editor

  function worldOf(screen: { readonly x: number; readonly y: number }) {
    return screenToWorld(editor.get().camera, screen)
  }

  // Resolve a binding candidate at `worldPt`, if the pointer is currently
  // over a shape OTHER than `excludeId` (the arrow's own in-progress shape
  // id — the arrow itself is already IN the context's snapshot mid-drag,
  // per create.ts's frame-capture SELF-EXCLUSION note, so without this
  // guard the arrow could bind to itself once its own bounding box grows
  // under the cursor).
  function bindingAt(worldPt: { readonly x: number; readonly y: number }, excludeId: string): ArrowBinding | undefined {
    const hit = ctx.hitTestTopmost(worldPt)
    if (!hit || hit === excludeId) return undefined
    const anchor = resolveArrowAnchor(ctx.snapshot(), hit, worldPt)
    return { targetId: hit, anchor }
  }

  return {
    initialState: IDLE,
    onEvent(state: ArrowState, event: InputEvent): { state: ArrowState; intents: Intent[] } {
      switch (state.mode) {
        case 'idle': {
          if (event.type !== 'pointerdown') return { state, intents: [] }
          // No doc write yet — see the THRESHOLD GATE note in the header.
          return { state: { mode: 'pointing', downScreen: { x: event.x, y: event.y }, downT: event.t }, intents: [] }
        }

        case 'pointing': {
          if (event.type === 'pointermove') {
            const here = crossedThreshold(state.downScreen, event)
            if (!here) return { state, intents: [] }
            const startWorld = worldOf(state.downScreen)
            const id = makeId({ t: state.downT, x: state.downScreen.x, y: state.downScreen.y }, editor.random)
            // pageId (Task E2, D-1): read LIVE from editor.get().currentPageId
            // at the moment of creation, the same purity posture as the
            // `camera` read via worldOf above -- never the constructor's
            // frozen `editor.pageId`. StartArrow is the ONLY intent that ever
            // sets this arrow's parentId (topIndex doc comment above), so one
            // live read here suffices for the whole gesture.
            const pageId = editor.get().currentPageId
            // SELF-BINDING (OURS, matching tldraw parity): allowed. Start
            // and end may bind to the SAME target shape — no special-casing
            // here or in routeArrow (canvas-model/src/arrow-route.ts), which
            // resolves each terminal's binding independently regardless of
            // whether they happen to name the same toId.
            const index = topIndex(ctx, pageId)
            const shape: Shape = {
              id, kind: 'arrow', parentId: pageId, index, x: startWorld.x, y: startWorld.y, rotation: 0,
              isLocked: false, opacity: 1, meta: {}, props: { end: { x: 0, y: 0 } },
            } as Shape
            const fromBinding = bindingAt(startWorld, id)
            // StartArrow + the first live end-point preview share ONE batch
            // (one commit — editor.ts's commit granularity): the arrow
            // appears already stretched to the pointer, never as a
            // zero-length flicker frame.
            return {
              state: { mode: 'drawing', id },
              intents: [
                { type: 'StartArrow', shape, fromBinding },
                { type: 'CompleteArrow', id, end: worldOf(here) },
              ],
            }
          }
          // Bare click / sub-threshold gesture: abandon with ZERO doc writes
          // (see the THRESHOLD GATE note in the header).
          if (event.type === 'pointerup') return { state: IDLE, intents: [] }
          return { state, intents: [] }
        }

        case 'drawing': {
          if (event.type === 'pointermove') {
            const worldPt = worldOf(event)
            // Live preview only — see the module header: no toBinding here.
            //
            // COMMIT CADENCE WATCH-ITEM (owned by the H3 perf rig): each of
            // these per-pointermove CompleteArrow previews becomes ONE
            // doc.commit() (script.ts's run() applies per event) — one sync
            // frame per mouse move for the whole draw gesture. The
            // ToolContext's lazy rebuild keeps the LOCAL index cost off
            // this path; the wire/undo-granularity cost of per-move commits
            // is unmeasured until H3 profiles it. Same note in select.ts's
            // onDragging, create.ts's dragging state, and transform.ts's
            // onResizing.
            return { state, intents: [{ type: 'CompleteArrow', id: state.id, end: worldPt }] }
          }
          if (event.type === 'pointerup') {
            const worldPt = worldOf(event)
            const toBinding = bindingAt(worldPt, state.id)
            return { state: IDLE, intents: [{ type: 'CompleteArrow', id: state.id, end: worldPt, toBinding }] }
          }
          return { state, intents: [] }
        }
      }
    },
  }
}
