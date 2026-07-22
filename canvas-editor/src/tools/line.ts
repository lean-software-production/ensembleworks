// The line tool: idle -> pointing -> drawing (threshold-crossed), back to
// idle on pointerup — Task T1 (2026-07-22 line sub-cycle), D-4. Structurally
// the 2-point-drag shape of arrow.ts (threshold gate, no doc write until the
// gesture proves it's a drag) FUSED with create.ts's per-pointermove
// CreateShape-upsert + finalize-with-SetSelection pattern (arrow instead uses
// a props-only CompleteArrow update and never auto-selects — see below for
// why this tool diverges from arrow on both points).
//
// THRESHOLD GATE (same discipline as arrow.ts/create.ts, NOT draw.ts):
// pointerdown only records the down point; nothing is written to the doc
// until the first pointermove that crosses DRAG_THRESHOLD. A bare click
// would be a zero-length line, useless by construction — abandon with ZERO
// intents on a sub-threshold pointerup. Pinned by line.test.ts's bare-click
// test.
//
// AUTO-SELECT (the plan's ground-truth correction — DIVERGES FROM ARROW):
// arrow.ts emits no SetSelection at all; this tool emits SetSelection([id])
// on BOTH the pointing->drawing transition AND at pointerup, mirroring
// create.ts's finalizeIntents. This is deliberate: the line sub-cycle's
// browser contract (Task K) discovers the newly-created shape's id via
// selectedShapeIds(), so the tool must leave it selected the same way
// create/draw already do.
//
// COORDINATE NORMALIZATION (D-1/D-4, load-bearing, reuses draw.ts's exact
// approach): `shape.x/y` is the two-point bbox's min corner; each of the two
// stored handles is relative to that min. This makes geometry.ts's generic
// `size()` branch (which reads `props.w/h`) exact for our own lines with
// zero geometry.ts changes.
//
// KEYED-MAP POINTS, FIXED HANDLE KEYS (D-4): unlike a future multi-point tool
// (which would mint handle ids/indices via indexBetween), this MVP 2-point
// tool writes exactly two handles under the FIXED keys 'a1'/'a2' with
// `index` fields 'a1' < 'a2' (plain string compare) — deterministic and
// sufficient for exactly two handles; the renderer (R1's flattenLinePoints)
// sorts by `index` so start ('a1') always precedes end ('a2') regardless of
// map insertion/enumeration order.
//
// COMMIT CADENCE (shared with create.ts's drag-to-size and arrow.ts's
// drawing state): each pointermove while 'drawing' re-emits ONE upserted
// CreateShape for the SAME id with the recomputed end handle — one doc
// commit per move. The ABANDONMENT GAP documented in arrow.ts/create.ts
// applies identically here (an in-flight line whose gesture never reaches
// pointerup is left in the doc; the cancel path is Seam D/G3's job, not this
// FSM's).
import { indexBetween, STYLE_VALUE_SETS, type Shape } from '@ensembleworks/canvas-model'
import type { Intent } from '../intents.js'
import { crossedThreshold, screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

interface Idle {
  readonly mode: 'idle'
}
interface Pointing {
  readonly mode: 'pointing'
  /** SCREEN point of the pointerdown — the line's start point (converted to
   * world at threshold-crossing time) AND the crossedThreshold origin. */
  readonly downScreen: { readonly x: number; readonly y: number }
  readonly downT: number
}
interface Drawing {
  readonly mode: 'drawing'
  readonly id: string
  readonly index: string
  readonly downWorld: { readonly x: number; readonly y: number }
}

export type LineState = Idle | Pointing | Drawing

const IDLE: LineState = { mode: 'idle' }

// Id factory: mirrors arrow.ts's/create.ts's/draw.ts's makeId exactly (same
// COLLISION PRECONDITION contract documented in create.ts). Not imported:
// makeId is module-private in each of those files, and each independently
// reimplements this same five-line helper rather than coupling otherwise-
// independent tool FSMs over it — same call here.
function makeId(event: { readonly t: number; readonly x: number; readonly y: number }, random: () => number): string {
  const salt = Math.floor(random() * 1e9).toString(36)
  return `shape:${event.t}-${Math.round(event.x)}-${Math.round(event.y)}-${salt}`
}

// Top-of-stack index at creation, mirrors arrow.ts's/create.ts's/draw.ts's
// topIndex exactly (same not-imported rationale as makeId above). Computed
// ONCE at the pointing->drawing transition and threaded through every
// subsequent pointermove/pointerup in 'drawing' — never recomputed
// mid-gesture (by the second move this same shape's own prior commit is
// already a sibling in ctx.snapshot(), so a naive per-event call would mint
// a strictly-increasing index every move: non-deterministic under replay).
function topIndex(ctx: ToolContext, parentId: string): string {
  const siblings = ctx.snapshot().shapes.filter((s) => s.parentId === parentId)
  let max: string | null = null
  for (const s of siblings) {
    if (max === null || s.index > max) max = s.index
  }
  return indexBetween(max, null)
}

// Armed-style whitelist: mirrors arrow.ts's/create.ts's/draw.ts's
// whitelistStyleProps exactly (same not-imported rationale — module-private
// there). Derived from canvas-model's STYLE_VALUE_SETS, the same set the
// write boundary validates prop values against. `spline` is NOT a
// STYLE_VALUE_SETS key (D-1: kept line-local, not added to STYLE_ENUMS), so
// it is never carried by this whitelist — buildShape below writes it
// explicitly.
const STYLE_AXIS_KEYS: ReadonlySet<string> = new Set(Object.keys(STYLE_VALUE_SETS))

function whitelistStyleProps(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(style)) {
    if (STYLE_AXIS_KEYS.has(key)) out[key] = style[key]
  }
  return out
}

/** Pure, deterministic shape builder (D-4's normalization + keyed-map
 * construction): given the two WORLD points `a` (start, the pointerdown
 * point) and `b` (end, the current pointer point), computes the bbox,
 * normalizes both handles relative to its min corner, and writes the
 * M1-shaped keyed-map `props.points` with two FIXED-key handles ('a1' start,
 * 'a2' end) whose `index` fields are ordered ('a1' < 'a2') so R1's
 * flattenLinePoints always renders start->end regardless of map enumeration
 * order. */
function buildShape(
  id: string, pageId: string, index: string,
  a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number },
  style: Record<string, unknown>,
): Shape {
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x, b.x)
  const maxY = Math.max(a.y, b.y)
  const { opacity, ...rest } = style
  const styleProps = whitelistStyleProps(rest)
  return {
    id, kind: 'line', parentId: pageId, index, x: minX, y: minY, rotation: 0,
    isLocked: false, opacity: typeof opacity === 'number' ? opacity : 1, meta: {},
    props: {
      ...styleProps,
      points: {
        a1: { id: 'a1', index: 'a1', x: a.x - minX, y: a.y - minY },
        a2: { id: 'a2', index: 'a2', x: b.x - minX, y: b.y - minY },
      },
      spline: 'line',
      w: maxX - minX,
      h: maxY - minY,
    },
  } as Shape
}

function finalizeIntents(shape: Shape): Intent[] {
  return [{ type: 'CreateShape', shape }, { type: 'SetSelection', ids: [shape.id] }]
}

export function createLineTool(ctx: ToolContext): Tool<LineState> {
  const editor = ctx.editor

  function worldOf(screen: { readonly x: number; readonly y: number }) {
    return screenToWorld(editor.get().camera, screen)
  }

  return {
    initialState: IDLE,
    onEvent(state: LineState, event: InputEvent): { state: LineState; intents: Intent[] } {
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
            const downWorld = worldOf(state.downScreen)
            const id = makeId({ t: state.downT, x: state.downScreen.x, y: state.downScreen.y }, editor.random)
            // pageId (Task E2, D-1): read LIVE from editor.get().currentPageId,
            // the same purity posture as the `camera` read via worldOf above --
            // never the constructor's frozen `editor.pageId`.
            const pageId = editor.get().currentPageId
            const index = topIndex(ctx, pageId)
            const shape = buildShape(id, pageId, index, downWorld, worldOf(here), editor.get().nextShapeStyle)
            return {
              state: { mode: 'drawing', id, index, downWorld },
              intents: finalizeIntents(shape),
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
            const pageId = editor.get().currentPageId
            const shape = buildShape(state.id, pageId, state.index, state.downWorld, worldPt, editor.get().nextShapeStyle)
            // Live preview only — one upserted CreateShape per move (create.ts's
            // drag-to-size pattern), NOT a SetSelection re-emission every move
            // (finalize below already selects once at threshold-crossing and
            // again at pointerup; re-selecting every move would be redundant
            // churn, not a correctness requirement).
            return { state, intents: [{ type: 'CreateShape', shape }] }
          }
          if (event.type === 'pointerup') {
            const worldPt = worldOf(event)
            const pageId = editor.get().currentPageId
            const shape = buildShape(state.id, pageId, state.index, state.downWorld, worldPt, editor.get().nextShapeStyle)
            return { state: IDLE, intents: finalizeIntents(shape) }
          }
          return { state, intents: [] }
        }
      }
    },
  }
}
