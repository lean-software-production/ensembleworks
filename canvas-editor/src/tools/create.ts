// Create tools: one parameterized factory for all four box-ish kinds this
// seam covers (note/text/geo/frame). FSM: idle -> pointing -> dragging
// (threshold-crossed), back to idle on pointerup — structurally the same
// shape as hand.ts's pan FSM, parameterized by `kind` instead of by drag
// direction.
//
// SIZE DEFAULTS, SINGLE SOURCE OF TRUTH: rather than duplicating
// canvas-model/geometry.ts's per-kind DEFAULTS map (which isn't exported —
// it's a module-private const) and its note-special-case (notes are ALWAYS
// 200x200*scale, never read from props.w/h), this file asks geometry.ts's
// own EXPORTED `localBounds` what a bare, prop-less shape of a given kind
// measures. That is exactly the computation pageBounds/worldBounds already
// trust, so a future change to a kind's default size (or the note special
// case) is picked up here for free, with zero duplicated numbers.
import { indexBetween, localBounds, STYLE_VALUE_SETS, type Bounds, type Shape } from '@ensembleworks/canvas-model'
import type { Intent } from '../intents.js'
import { crossedThreshold, screenToWorld, type InputEvent, type Tool } from '../input.js'
import type { ToolContext } from './tool-context.js'

export type CreateKind = 'note' | 'text' | 'geo' | 'frame'

interface Idle {
  readonly mode: 'idle'
}
interface Pointing {
  readonly mode: 'pointing'
  readonly downScreen: { readonly x: number; readonly y: number }
}
interface Dragging {
  readonly mode: 'dragging'
  readonly id: string
  readonly downWorld: { readonly x: number; readonly y: number }
  /** The top-of-stack index computed ONCE at the pointing->dragging
   * transition (see topIndex below) and threaded through every subsequent
   * per-pointermove re-emission of this same shape. NOT recomputed per
   * move: by the second move, THIS SAME shape's first-move commit is
   * already sitting in ctx.snapshot() as a sibling of itself (create.ts's
   * frame-capture SELF-EXCLUSION note documents the same per-move-commit
   * cadence), so a naive per-event topIndex(ctx, pageId) call would read
   * its own prior index as the max and keep minting a strictly-increasing
   * index every move -- replay-nondeterministic and pointless churn. D-5. */
  readonly index: string
}

export type CreateState = Idle | Pointing | Dragging

const IDLE: CreateState = { mode: 'idle' }

// A bare probe shape (kind-only, no props) purely to ask geometry.ts's
// localBounds what this kind's DEFAULT local box is — position/rotation/etc
// are irrelevant to localBounds (it only reads props + kind), so every other
// envelope field is a throwaway placeholder.
function probeShape(kind: CreateKind, parentId: string): Shape {
  return {
    id: 'shape:__probe__', kind, parentId, index: 'a1', x: 0, y: 0, rotation: 0,
    isLocked: false, opacity: 1, meta: {}, props: {},
  } as Shape
}

function defaultSize(kind: CreateKind, pageId: string): { w: number; h: number } {
  const b = localBounds(probeShape(kind, pageId))
  return { w: b.maxX - b.minX, h: b.maxY - b.minY }
}

// note's geometry (geometry.ts's `size()`) hardcodes 200x200*scale
// regardless of props.w/h — it never reads them. geo/text/frame DO read
// props.w/h (falling back to their own DEFAULTS entry when absent). We
// still WRITE explicit w/h onto geo/text/frame (so a later resize — C8's
// ResizeShapes, which only touches props.w/h when present — has something
// to scale) but deliberately omit them for note, matching that kind's
// documented "notes never store w/h" invariant instead of writing dead
// passthrough fields.
function propsFor(kind: CreateKind, w: number, h: number): Record<string, unknown> {
  return kind === 'note' ? {} : { w, h }
}

// Task C1 (D-5) — top-of-stack index at creation, tldraw parity: a new shape
// lands ABOVE every existing sibling (same parentId), never at the fixed
// legacy 'a1'. Reads the CURRENT doc (ctx.snapshot(), the same lazily-rebuilt
// pair every other query in this file already reads -- see tool-context.ts's
// COHERENCE GUARANTEE) filtered to `parentId`'s children, takes the lexical
// max `index` among them (or `null` on an empty/first-shape page), and asks
// A1's deterministic `indexBetween` for a key strictly above it.
// `indexBetween(null, null)` on an empty page returns a valid starting key
// ('a0') -- no special-casing needed for the empty case.
// CALLER DISCIPLINE (see the Dragging state's doc comment): call this ONCE
// per gesture, at click-time or at the pointing->dragging transition, and
// thread the result through -- never call it again mid-drag against a doc
// that may already contain this same shape's own prior commit.
function topIndex(ctx: ToolContext, parentId: string): string {
  const siblings = ctx.snapshot().shapes.filter((s) => s.parentId === parentId)
  let max: string | null = null
  for (const s of siblings) {
    if (max === null || s.index > max) max = s.index
  }
  return indexBetween(max, null)
}

// Post-review hardening: the WHITELIST of style-axis keys `nextShapeStyle`
// is allowed to carry into a created shape's props. Derived from
// canvas-model's `STYLE_VALUE_SETS` (Task M3, canvas-model/src/shape.ts) —
// the exact same axis set the write boundary validates prop values against
// — so this can never drift from what the model actually recognizes as a
// style axis. VERIFIED (2026-07-22): `STYLE_VALUE_SETS`'s keys are
// `color/fill/dash/size/font/align/verticalAlign/textAlign/geo/
// arrowheadStart/arrowheadEnd` — 11 keys. It does NOT include `opacity`;
// that's an envelope field handled separately below, never a props-level
// style axis (the client's OWN wider `STYLE_VALUE_SETS`, in
// client/src/canvas-v2/style-axes.ts, adds an `opacity` entry for its own
// panel-facing purposes, but canvas-editor is clean-room and never imports
// client — this whitelist reads only the model's narrower set, which is
// exactly right: opacity must NOT pass through the props whitelist, it has
// its own destructure-and-route path just below).
//
// Without this, `SetNextStyle` — a PUBLIC view intent, not a panel-only
// channel — could carry arbitrary keys (a future caller, or a malformed
// replayed script) that would silently ride into props as inert junk. The
// panel itself only ever arms known axes, so this is unreachable through
// today's UI, but closing it structurally costs nothing.
const STYLE_AXIS_KEYS: ReadonlySet<string> = new Set(Object.keys(STYLE_VALUE_SETS))

function whitelistStyleProps(style: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(style)) {
    if (STYLE_AXIS_KEYS.has(key)) out[key] = style[key]
  }
  return out
}

// Task AS2 — stamp the ARMED style (Task AS1's `EditorState.nextShapeStyle`)
// onto a newly-minted shape. `style` is read LIVE from `editor.get()` by the
// caller (see `clickShape`/`dragShape` below) at the moment of creation, the
// same purity posture as this tool's existing live `camera` read via
// `worldOf` — it is never captured into `CreateState` (see the plan's
// Decisions armed-style block: that was considered and rejected).
//
// `opacity` is special-cased out of `style` and onto the shape's ENVELOPE
// `opacity` field, never `props.opacity`: `nextShapeStyle` is a single flat
// record (`SetNextStyle` has no separate opacity field, unlike `SetStyle`),
// but `opacity` itself is an envelope field on `Shape`, not a style axis —
// style-axes.ts's `currentValue` reads `shape.opacity` directly and treats a
// stray `props.opacity` key as a decoy to ignore, so leaving it in props
// would silently produce a shape that never renders at its armed opacity.
// The REMAINING keys are whitelisted (`whitelistStyleProps` above) before
// merging — a key that is neither `opacity` nor a recognized style axis
// (e.g. a stray `parentId`, or any future-unknown key) is dropped entirely,
// not merely rendered inert.
//
// Merge order for the whitelisted style keys is (armed style, THEN geometry
// props): `{ ...styleProps, ...propsFor(kind, w, h) }` — so `w`/`h` (and any
// other geometry key `propsFor` ever grows) always win over a same-named
// armed key. Style keys never touch anything outside `props`/`opacity` —
// `id`/`parentId`/`index`/`rotation`/`isLocked` are computed here, not
// spread from `style`.
function makeShape(
  kind: CreateKind, id: string, pageId: string, x: number, y: number, w: number, h: number,
  style: Record<string, unknown>, index: string,
): Shape {
  const { opacity, ...rest } = style
  const styleProps = whitelistStyleProps(rest)
  return {
    id, kind, parentId: pageId, index, x, y, rotation: 0,
    isLocked: false, opacity: typeof opacity === 'number' ? opacity : 1, meta: {},
    props: { ...styleProps, ...propsFor(kind, w, h) },
  } as Shape
}

// Id factory: no id-generation helper exists yet in canvas-model/src/ids.ts
// (only branded-type predicates) — editor.ts's own doc comment names id
// generation as `random`'s expected first consumer, "starting in C6" (here).
// PURITY REQUIREMENT: the FSM must stay a pure function of (state, event) —
// no hidden mutable counter in this file's closure (that would break
// replay: the same recorded script must produce the same ids every time it
// runs). A fixed/constant random() (as most of this package's tests inject)
// would make a counter-free `random()`-only id collide across every call, so
// this folds in the EVENT's own varying fields (t, x, y — all part of the
// deterministic InputEvent the FSM is already threading through) alongside
// one random() draw, rather than a monotonic counter living outside state.
//
// COLLISION PRECONDITION (explicit contract, not an afterthought):
// uniqueness rides on BOTH of
//   1. event.t being monotone within ONE clock domain — true inside a
//      single session (script.ts guarantees strictly-increasing t; a real
//      DOM event stream's timestamps are monotone per page), but NOT across
//      independently-initialized sessions: two tabs/peers each starting
//      their event clock at 0 (or a reload resetting a relative-origin
//      clock) can replay identical (t, x, y) triples; and
//   2. the random() draw separating those cross-domain twins.
// Two sessions with equal (t, x, y) AND colliding random() outputs (e.g.
// both injected a constant — reviewer-reproduced) WILL therefore mint the
// same id, and CreateShape's upsert semantics silently merge the two shapes.
// Division of labor for closing this for real: D2 owns wiring real DOM
// timestamps (a shared wall-clock domain instead of per-session relative
// origins); G3 owns injecting real entropy for `random`. Until both land,
// treat cross-session id uniqueness as UNGUARANTEED by this factory.
function makeId(event: { readonly t: number; readonly x: number; readonly y: number }, random: () => number): string {
  const salt = Math.floor(random() * 1e9).toString(36)
  return `shape:${event.t}-${Math.round(event.x)}-${Math.round(event.y)}-${salt}`
}

// Frame capture (v1 rule, our choice): when a newly-created FRAME's final
// world bounds fully CONTAIN existing shapes, those shapes are reparented
// into it. Only ROOT-LEVEL shapes (parentId === pageId) are eligible — a
// shape already nested under some OTHER frame/group is never stolen, even
// if it's geometrically contained too. `frame` is root-level and
// rotation-0 by construction (this tool never creates a rotated frame), so
// its own x/y/w/h ARE its world bounds directly — no doc/parent-chain walk
// needed.
//
// SELF-EXCLUSION: on a DRAG-create the frame itself is already in the
// context's snapshot by pointerup — the drag's per-pointermove CreateShape
// upserts each committed, so the lazily-rebuilt snapshot this query runs
// against contains the in-progress frame, whose bounds trivially "contain"
// themselves (inclusive containment). The editor's canReparent would skip
// the resulting self-parent anyway (degenerate cycle), but relying on the
// downstream tolerance to swallow an intent we KNOW is wrong at emission
// time would be sloppy — filter it here. (Click-create never hits this: no
// commit happens mid-gesture, so the frame isn't in the snapshot yet.)
function frameCaptureIntents(ctx: ToolContext, frame: Shape): Intent[] {
  const w = (frame.props as { w?: number }).w ?? 0
  const h = (frame.props as { h?: number }).h ?? 0
  const bounds: Bounds = { minX: frame.x, minY: frame.y, maxX: frame.x + w, maxY: frame.y + h }
  const pageId = frame.parentId
  const contained = ctx.queryMarquee(bounds, 'contain')
    .filter((id) => id !== frame.id && ctx.snapshot().byId.get(id)?.parentId === pageId)
  if (contained.length === 0) return []
  return [{ type: 'ReparentShapes', ids: contained, parentId: frame.id }]
}

function finalizeIntents(ctx: ToolContext, shape: Shape): Intent[] {
  const intents: Intent[] = [{ type: 'CreateShape', shape }, { type: 'SetSelection', ids: [shape.id] }]
  if (shape.kind === 'frame') intents.push(...frameCaptureIntents(ctx, shape))
  return intents
}

/** One parameterized factory for note/text/geo/frame — see this module's
 * header for the shared size/props/id/frame-capture machinery every kind
 * reuses. */
export function createCreateTool(ctx: ToolContext, kind: CreateKind): Tool<CreateState> {
  const editor = ctx.editor
  const pageId = editor.pageId

  function worldOf(screen: { readonly x: number; readonly y: number }) {
    return screenToWorld(editor.get().camera, screen)
  }

  // CLICK placement: CENTERED on the click point — tldraw parity, checked:
  // both the box-shape tool (geo/frame; the tldraw-org editor package's
  // node_modules directory, under editor/src/lib/editor/tools/
  // BaseBoxShapeTool/children/Pointing.ts's `complete()`: `delta = new
  // Vec(w/2, h/2); newPoint = shape.x - delta.x, shape.y - delta.y`) and
  // the note tool (the top-level installed `tldraw` package,
  // node_modules/tldraw/src/lib/shapes/note/toolStates/Pointing.ts's
  // `createNoteShape`: `newPoint = shape.x - bounds.width/2, shape.y -
  // bounds.height/2`) center the shape on the click point rather than using
  // it as a corner. We apply the same centering uniformly to text too (our
  // choice — tldraw's real TextShapeUtil auto-sizes from typed content,
  // which this clean-room model has no rendering/measurement to emulate).
  function clickShape(id: string, worldPt: { readonly x: number; readonly y: number }, index: string): Shape {
    const { w, h } = defaultSize(kind, pageId)
    return makeShape(kind, id, pageId, worldPt.x - w / 2, worldPt.y - h / 2, w, h, editor.get().nextShapeStyle, index)
  }

  // DRAG-TO-SIZE placement: top-left at the drag rect's min corner (NOT
  // centered) — matches tldraw's box tool, whose drag creates the shape at
  // originPagePoint and grows it toward the current point (the tldraw-org
  // editor package's node_modules directory, editor/src/lib/editor/tools/
  // BaseBoxShapeTool/children/Pointing.ts's onPointerMove). UNIFORM ACROSS
  // ALL FOUR KINDS (our choice, for one parameterized factory): tldraw
  // itself diverges here per kind — its real Note tool has NO drag-to-size
  // at all (NoteShapeTool's Pointing.onPointerMove transitions to
  // 'select.translating', i.e. dragging the about-to-be-created note around
  // rather than resizing it). We use the shared drag-rect FSM for note too;
  // it's harmless (see propsFor's note comment) since note's geometry
  // ignores props.w/h regardless of what the drag rect computed.
  function dragShape(id: string, a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }, index: string): Shape {
    const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y)
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y)
    return makeShape(kind, id, pageId, minX, minY, w, h, editor.get().nextShapeStyle, index)
  }

  return {
    initialState: IDLE,
    onEvent(state: CreateState, event: InputEvent): { state: CreateState; intents: Intent[] } {
      switch (state.mode) {
        case 'idle': {
          if (event.type === 'pointerdown') {
            return { state: { mode: 'pointing', downScreen: { x: event.x, y: event.y } }, intents: [] }
          }
          return { state, intents: [] }
        }

        case 'pointing': {
          if (event.type === 'pointermove') {
            const here = crossedThreshold(state.downScreen, event)
            if (!here) return { state, intents: [] }
            // CreateShape upserts (a plain "put this shape") repeatedly
            // during the drag — deliberately NOT ResizeShapes (which scales
            // an EXISTING doc shape's props about an anchor and needs a live
            // doc read): the create tool already owns the full shape state
            // locally in its own closure/state, so re-emitting a corrected
            // CreateShape for the SAME id each event is simpler and avoids a
            // doc round-trip for information this tool already has.
            const id = makeId(event, editor.random)
            const downWorld = screenToWorld(editor.get().camera, state.downScreen)
            // Computed ONCE here, at the pointing->dragging transition --
            // BEFORE this shape's first CreateShape intent below has been
            // applied/committed by the caller, so ctx.snapshot() here still
            // reflects only PRE-EXISTING siblings (see topIndex's and
            // Dragging's doc comments for why every later pointermove in
            // 'dragging' below reuses this same value instead of
            // recomputing it).
            const index = topIndex(ctx, pageId)
            const shape = dragShape(id, downWorld, worldOf(here), index)
            return {
              state: { mode: 'dragging', id, downWorld, index },
              intents: [{ type: 'CreateShape', shape }, { type: 'SetSelection', ids: [id] }],
            }
          }
          if (event.type === 'pointerup') {
            const worldPt = worldOf({ x: event.x, y: event.y })
            const id = makeId(event, editor.random)
            // CLICK-create: a single emission, no prior commit of this shape
            // exists yet -- compute inline, same as the drag transition above.
            const index = topIndex(ctx, pageId)
            const shape = clickShape(id, worldPt, index)
            return { state: IDLE, intents: finalizeIntents(ctx, shape) }
          }
          return { state, intents: [] }
        }

        case 'dragging': {
          if (event.type === 'pointermove') {
            // COMMIT CADENCE WATCH-ITEM (owned by the H3 perf rig): each of
            // these per-pointermove CreateShape upserts becomes ONE
            // doc.commit() (script.ts's run() applies per event) — one sync
            // frame per mouse move for the whole drag-to-size gesture. The
            // ToolContext's lazy rebuild keeps the LOCAL index cost off this
            // path; the wire/undo-granularity cost of per-move commits is
            // unmeasured until H3 profiles it. Same note in select.ts's
            // onDragging.
            const shape = dragShape(state.id, state.downWorld, worldOf({ x: event.x, y: event.y }), state.index)
            return { state, intents: [{ type: 'CreateShape', shape }] }
          }
          if (event.type === 'pointerup') {
            const shape = dragShape(state.id, state.downWorld, worldOf({ x: event.x, y: event.y }), state.index)
            return { state: IDLE, intents: finalizeIntents(ctx, shape) }
          }
          return { state, intents: [] }
        }
      }
    },
  }
}
