// The select+transform COMPOSITE — the union tldraw users expect from "the
// select tool": click/drag/marquee-select (select.ts) PLUS drag a resize/
// rotate handle when something is already selected (transform.ts). On every
// pointerdown while composite-idle, transform.ts gets FIRST CRACK (it reacts
// only to a pointerdown that lands on a handle — every other event is a no-op
// returning its own unchanged idle state); if it grabbed a handle, the
// composite's active leg becomes 'transform' until transform's FSM returns to
// idle (pointerup) — otherwise the event forwards to select.ts. Composed at
// the dispatch layer, not inside either FSM.
//
// RELOCATED (Phase E extension, 2026-07-16): this composite previously lived
// in client/src/canvas-v2/tool-loop.ts. It is pure, DOM-free FSM logic (no
// client/React/DOM import), so it belongs in the clean-room editor beside the
// two FSMs it unions — AND hosting it here lets the interaction-contracts FSM
// runner drive the REAL composite the client ships (not a re-derivation that
// could drift from the handoff rule below). tool-loop.ts now re-exports it, so
// the client's public surface is unchanged. See git history for the full
// original prose.
import type { Intent } from '../intents.js'
import type { Tool } from '../input.js'
import { createSelectTool, type SelectState } from './select.js'
import { createTransformTool, type TransformState } from './transform.js'
import type { ToolContext } from './tool-context.js'

export interface SelectAndTransformState {
  readonly active: 'select' | 'transform'
  readonly select: SelectState
  readonly transform: TransformState
}

export function createSelectAndTransformTool(ctx: ToolContext): Tool<SelectAndTransformState> {
  const select = createSelectTool(ctx)
  const transform = createTransformTool(ctx)
  const initialState: SelectAndTransformState = { active: 'select', select: select.initialState, transform: transform.initialState }

  return {
    initialState,
    onEvent(state, event): { state: SelectAndTransformState; intents: Intent[] } {
      if (state.active === 'transform') {
        const r = transform.onEvent(state.transform, event)
        const active = r.state.mode === 'idle' ? 'select' : 'transform'
        return { state: { ...state, active, transform: r.state }, intents: r.intents }
      }
      if (event.type === 'pointerdown') {
        const rt = transform.onEvent(state.transform, event)
        if (rt.state.mode !== 'idle') {
          // HANDOFF RESETS THE SELECT LEG (quality-review fix — verbatim from
          // the original; pinned by tool-loop.test.ts's click-resize-click
          // probe): an entire resize/rotate gesture routes EXCLUSIVELY through
          // transform, so select's double-click memory (lastClick) must not
          // survive it, or a click after the gesture spuriously BeginEdits.
          return { state: { active: 'transform', select: select.initialState, transform: rt.state }, intents: rt.intents }
        }
      }
      const rs = select.onEvent(state.select, event)
      return { state: { ...state, select: rs.state }, intents: rs.intents }
    },
  }
}
