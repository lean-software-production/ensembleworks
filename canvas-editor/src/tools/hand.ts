// The hand tool: drag pans the camera; wheel (plain or ctrl/meta) is handled
// uniformly regardless of drag state via camera.ts's applyWheel — the SAME
// function D2's renderer calls for global wheel handling outside any tool,
// so this file owns no wheel policy of its own, only the FSM around
// pointer-drag panning.
//
// FSM: idle -> pointing -> panning (threshold-crossed), back to idle on
// pointerup. Panning recomputes the camera from the DRAG'S ORIGIN each
// event (not incrementally from the last event) — matching tldraw's own
// HandTool Dragging state (installed `tldraw` package,
// node_modules/tldraw/src/lib/tools/HandTool/childStates/Dragging.ts:
// `delta = Sub(currentScreenPoint, originScreenPoint).div(zoom); camera =
// initialCamera.clone().add(delta)`) — recomputing from a fixed origin/
// initialCamera pair avoids incremental floating-point drift over a long
// drag, which an incremental last-point approach (like select.ts's
// translate, which has no such concern since doc writes there are exact
// deltas on plain numbers) would slowly accumulate.
import type { Intent } from '../intents.js'
import { crossedThreshold, type Camera, type InputEvent, type Tool } from '../input.js'
import { applyWheel } from '../camera.js'
import type { ToolContext } from './tool-context.js'

interface Idle {
  readonly mode: 'idle'
}
interface Pointing {
  readonly mode: 'pointing'
  readonly downScreen: { readonly x: number; readonly y: number }
}
interface Panning {
  readonly mode: 'panning'
  readonly originScreen: { readonly x: number; readonly y: number }
  readonly initialCamera: Camera
}

export type HandState = Idle | Pointing | Panning

const IDLE: HandState = { mode: 'idle' }

function panCamera(initialCamera: Camera, originScreen: { readonly x: number; readonly y: number }, here: { readonly x: number; readonly y: number }): Camera {
  // camera.xy += screenDelta / z — the world point under the cursor at
  // gesture start stays under the cursor throughout the pan (our task
  // spec's own formula, matching tldraw's Dragging.update() cited above).
  const dx = (here.x - originScreen.x) / initialCamera.z
  const dy = (here.y - originScreen.y) / initialCamera.z
  return { x: initialCamera.x + dx, y: initialCamera.y + dy, z: initialCamera.z }
}

export function createHandTool(ctx: ToolContext): Tool<HandState> {
  const editor = ctx.editor

  return {
    initialState: IDLE,
    onEvent(state: HandState, event: InputEvent): { state: HandState; intents: Intent[] } {
      // Wheel is handled identically in every mode — panning the camera
      // mid-drag-pan via the wheel is an edge case we don't need to guard
      // against; applyWheel is a pure function of the CURRENT camera either
      // way, so there's nothing mode-specific to get wrong here.
      if (event.type === 'wheel') {
        const next = applyWheel(editor.get().camera, event)
        return { state, intents: [{ type: 'SetCamera', ...next }] }
      }

      switch (state.mode) {
        case 'idle':
          if (event.type === 'pointerdown') {
            return { state: { mode: 'pointing', downScreen: { x: event.x, y: event.y } }, intents: [] }
          }
          return { state, intents: [] }

        case 'pointing': {
          if (event.type === 'pointermove') {
            const here = crossedThreshold(state.downScreen, event)
            if (!here) return { state, intents: [] }
            const initialCamera = editor.get().camera
            const next = panCamera(initialCamera, state.downScreen, here)
            return {
              state: { mode: 'panning', originScreen: state.downScreen, initialCamera },
              intents: [{ type: 'SetCamera', ...next }],
            }
          }
          if (event.type === 'pointerup') return { state: IDLE, intents: [] }
          return { state, intents: [] }
        }

        case 'panning': {
          if (event.type === 'pointermove') {
            const here = { x: event.x, y: event.y }
            const next = panCamera(state.initialCamera, state.originScreen, here)
            return { state, intents: [{ type: 'SetCamera', ...next }] }
          }
          if (event.type === 'pointerup') return { state: IDLE, intents: [] }
          return { state, intents: [] }
        }
      }
    },
  }
}
