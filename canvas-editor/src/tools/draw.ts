// The pen tool: idle -> drawing, back to idle on pointerup. Built against
// the shared ToolContext exactly like select/create/arrow — see
// tool-context.ts's doc comment for the once-per-commit
// hitTestTopmost/snapshot refresh cadence (unused here — the pen tool never
// hit-tests) and create.ts's header for the size/id/index machinery this
// file mirrors.
//
// NO THRESHOLD GATE (deliberate divergence from create.ts/arrow.ts — D-5 in
// the plan, tldraw parity): pointerdown commits IMMEDIATELY, a one-point
// (dot) draw shape — there is no "pointing" state waiting to see if the
// gesture crosses DRAG_THRESHOLD. A bare click is a valid, intentional dot
// stroke, not an abandoned gesture. Pinned by draw.test.ts's click=dot case.
//
// POINT CAPTURE POLICY: every pointermove while 'drawing' appends exactly
// one point (no simplification/decimation) — matches create.ts's
// per-pointermove commit cadence (one doc.commit() per event, script.ts's
// run() applies once per event) and keeps capture a pure, replay-deterministic
// function of the event stream: nothing is dropped, nothing is resampled.
//
// PRESSURE SOURCING (D-3, replay-safe): pressure is READ off the injected
// `event.pressure` field, never sampled from a clock/DOM/device inside this
// FSM. `z = event.pressure ?? 0.5` — a real pen supplies pressure and a
// mouse/touch event (no `pressure`) gets the neutral middle value 0.5,
// mirroring tldraw's own "simulate from velocity later, default to 0.5 now"
// split (the velocity-simulation itself lives in the renderer's freehand
// geometry, G2, not here). `isPen` is latched ONCE, off the DOWN event only
// (`downEvent.pressure !== undefined`) — a stroke's device identity doesn't
// change mid-gesture even if a later synthetic event happened to omit
// pressure.
//
// COORDINATE NORMALIZATION (D-1, load-bearing): unlike create.ts/arrow.ts,
// which store shapes at their raw world position, this tool NORMALIZES on
// every emission — `shape.x/y` is the point-cloud's min corner and every
// stored point is relative to it, landing in `[0,w]x[0,h]`. This makes
// geometry.ts's generic `size()` branch (which reads `props.w/h`) exact for
// our own strokes with zero geometry.ts changes — see the plan's Decision 1
// coordinate note. Recomputed on every point (points/bbox are the tool's
// own local state, not a doc read — cheap, and there is no cross-move
// state to preserve incorrectly, unlike create.ts's `index`).
//
// ABANDONMENT GAP: shared with create.ts's drag-to-size and arrow.ts's
// drawing state — once pointerdown commits, every pointermove's upserted
// CreateShape lands in the doc immediately, so a gesture that never reaches
// pointerup (tool switched mid-stroke, tab close, unmount) leaves the
// in-progress stroke permanently in the doc. The cancel path (Escape/blur/
// unmount deleting the in-flight id) is the Seam D/G3 wiring's job, same as
// every other drag-capable tool here; this FSM never sees those events.
import { indexBetween, STYLE_VALUE_SETS, type Shape } from '@ensembleworks/canvas-model'
import type { Intent } from '../intents.js'
import { screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

/** One captured stroke point, world space, with pressure carried as `z` —
 * matches v1's VecModel convention (`{x, y, z}` where z = pressure 0..1),
 * the exact shape M1's `drawPoint` schema validates. */
interface StrokePoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface Idle {
  readonly mode: 'idle'
}
interface Drawing {
  readonly mode: 'drawing'
  readonly id: string
  readonly index: string
  readonly isPen: boolean
  /** Every world-space point captured so far, oldest first (the down point,
   * then one per pointermove). Immutable — each event produces a NEW array
   * via spread, never a mutation of the previous state's array (replay
   * determinism: two independent runs of the same script must not be able
   * to observe/share mutable state). */
  readonly worldPoints: readonly StrokePoint[]
}

export type DrawState = Idle | Drawing

const IDLE: DrawState = { mode: 'idle' }

// Id factory: mirrors create.ts's/arrow.ts's makeId exactly (same COLLISION
// PRECONDITION contract documented in create.ts — event.t monotonicity
// within one clock domain plus the random() draw separating cross-domain
// twins). Not imported: makeId is module-private in create.ts, and arrow.ts
// already independently reimplements this same five-line helper rather than
// coupling otherwise-independent tool FSMs over it — same call here.
function makeId(event: { readonly t: number; readonly x: number; readonly y: number }, random: () => number): string {
  const salt = Math.floor(random() * 1e9).toString(36)
  return `shape:${event.t}-${Math.round(event.x)}-${Math.round(event.y)}-${salt}`
}

// Top-of-stack index at creation, mirrors create.ts's/arrow.ts's topIndex
// exactly (same not-imported rationale as makeId above). Computed ONCE, at
// pointerdown — every later pointermove/pointerup in 'drawing' reuses the
// stored `state.index`, never recomputing it (create.ts's Dragging-state
// doc comment explains why: by the second move, this same shape's own prior
// commit is already a sibling in ctx.snapshot(), so a naive per-event
// topIndex call would mint a strictly-increasing index every move —
// non-deterministic under replay and pointless churn).
function topIndex(ctx: ToolContext, parentId: string): string {
  const siblings = ctx.snapshot().shapes.filter((s) => s.parentId === parentId)
  let max: string | null = null
  for (const s of siblings) {
    if (max === null || s.index > max) max = s.index
  }
  return indexBetween(max, null)
}

// Armed-style whitelist: mirrors create.ts's whitelistStyleProps exactly
// (same not-imported rationale — module-private there). Derived from
// canvas-model's STYLE_VALUE_SETS, the same set the write boundary
// validates prop values against, so this can never drift from what the
// model recognizes as a style axis.
const STYLE_AXIS_KEYS: ReadonlySet<string> = new Set(Object.keys(STYLE_VALUE_SETS))

function whitelistStyleProps(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(style)) {
    if (STYLE_AXIS_KEYS.has(key)) out[key] = style[key]
  }
  return out
}

/** Bbox of `points` — the point-cloud min/max corners the shape builder
 * normalizes against. `points` is always non-empty in this file's call
 * sites (pointerdown seeds `worldPoints` with one point before this is ever
 * called). */
function bbox(points: readonly StrokePoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Pure, deterministic shape builder (D-1's normalization): computes the
 * point-cloud bbox, sets `shape.x/y` to its min corner, stores every point
 * relative to that min (landing in [0,w]x[0,h]), and writes `props.w/h` to
 * the bbox size. */
function buildShape(
  id: string, pageId: string, index: string, worldPoints: readonly StrokePoint[], isPen: boolean, style: Record<string, unknown>,
): Shape {
  const { minX, minY, maxX, maxY } = bbox(worldPoints)
  const localPoints = worldPoints.map((p) => ({ x: p.x - minX, y: p.y - minY, z: p.z }))
  const { opacity, ...rest } = style
  const styleProps = whitelistStyleProps(rest)
  return {
    id, kind: 'draw', parentId: pageId, index, x: minX, y: minY, rotation: 0,
    isLocked: false, opacity: typeof opacity === 'number' ? opacity : 1, meta: {},
    props: {
      ...styleProps,
      segments: [{ type: 'free', points: localPoints }],
      isPen,
      w: maxX - minX,
      h: maxY - minY,
    },
  } as Shape
}

function finalizeIntents(shape: Shape): Intent[] {
  return [{ type: 'CreateShape', shape }, { type: 'SetSelection', ids: [shape.id] }]
}

export function createDrawTool(ctx: ToolContext): Tool<DrawState> {
  const editor = ctx.editor

  function worldOf(screen: { readonly x: number; readonly y: number }) {
    return screenToWorld(editor.get().camera, screen)
  }

  return {
    initialState: IDLE,
    onEvent(state: DrawState, event: InputEvent): { state: DrawState; intents: Intent[] } {
      switch (state.mode) {
        case 'idle': {
          if (event.type !== 'pointerdown') return { state, intents: [] }
          const id = makeId(event, editor.random)
          // pageId (Task E2, D-1): read LIVE from editor.get().currentPageId,
          // the same purity posture as the `camera` read via worldOf below --
          // never the constructor's frozen `editor.pageId`.
          const pageId = editor.get().currentPageId
          const index = topIndex(ctx, pageId)
          const isPen = event.pressure !== undefined
          const pt: StrokePoint = { ...worldOf(event), z: event.pressure ?? 0.5 }
          const worldPoints = [pt]
          const shape = buildShape(id, pageId, index, worldPoints, isPen, editor.get().nextShapeStyle)
          return {
            state: { mode: 'drawing', id, index, isPen, worldPoints },
            intents: finalizeIntents(shape),
          }
        }

        case 'drawing': {
          if (event.type === 'pointermove') {
            const pt: StrokePoint = { ...worldOf(event), z: event.pressure ?? 0.5 }
            // IMMUTABLE append — a new array each event, never a push onto
            // the previous state's array (see the Drawing interface's doc
            // comment: replay determinism depends on this).
            const worldPoints = [...state.worldPoints, pt]
            const pageId = editor.get().currentPageId
            const shape = buildShape(state.id, pageId, state.index, worldPoints, state.isPen, editor.get().nextShapeStyle)
            return { state: { ...state, worldPoints }, intents: [{ type: 'CreateShape', shape }] }
          }
          if (event.type === 'pointerup') {
            const pt: StrokePoint = { ...worldOf(event), z: event.pressure ?? 0.5 }
            const worldPoints = [...state.worldPoints, pt]
            const pageId = editor.get().currentPageId
            const shape = buildShape(state.id, pageId, state.index, worldPoints, state.isPen, editor.get().nextShapeStyle)
            return { state: IDLE, intents: finalizeIntents(shape) }
          }
          return { state, intents: [] }
        }
      }
    },
  }
}
