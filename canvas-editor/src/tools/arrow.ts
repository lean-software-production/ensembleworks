// The arrow tool: idle -> drawing, back to idle on pointerup. Built against
// the shared ToolContext (tool-context.ts) exactly like select/create — see
// that module's doc comment for the once-per-commit hitTestTopmost/snapshot
// refresh cadence this tool relies on for resolving a binding target.
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
// reason about.
import { resolveArrowAnchor, type Shape } from '@ensembleworks/canvas-model'
import type { ArrowBinding, Intent } from '../intents.js'
import { crossedThreshold, screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

interface Idle {
  readonly mode: 'idle'
}
interface Drawing {
  readonly mode: 'drawing'
  readonly id: string
}

export type ArrowState = Idle | Drawing

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

export function createArrowTool(ctx: ToolContext): Tool<ArrowState> {
  const editor = ctx.editor
  const pageId = editor.pageId

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
          const worldPt = worldOf(event)
          const id = makeId(event, editor.random)
          // SELF-BINDING (OURS, matching tldraw parity): allowed. Start and
          // end may bind to the SAME target shape — no special-casing here
          // or in routeArrow (canvas-model/src/arrow-route.ts), which
          // resolves each terminal's binding independently regardless of
          // whether they happen to name the same toId.
          const shape: Shape = {
            id, kind: 'arrow', parentId: pageId, index: 'a1', x: worldPt.x, y: worldPt.y, rotation: 0,
            isLocked: false, opacity: 1, meta: {}, props: { end: { x: 0, y: 0 } },
          } as Shape
          const fromBinding = bindingAt(worldPt, id)
          return { state: { mode: 'drawing', id }, intents: [{ type: 'StartArrow', shape, fromBinding }] }
        }

        case 'drawing': {
          if (event.type === 'pointermove') {
            const worldPt = worldOf(event)
            // Live preview only — see the module header: no toBinding here.
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
