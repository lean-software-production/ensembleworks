// The pure contract vocabulary — imports NOTHING (the design's "one pure,
// dependency-free module both runners import"). Everything a contract
// declaration needs (PRNG, gesture ops, the observation interface) is defined
// here structurally, so canvas-editor's FSM runner and e2e's browser runner
// both compile against the SAME types without either package leaking into the
// other.

/** A deterministic uniform [0,1) source. Seeded so one declaration yields a
 * fixed CI smoke case and a reproducible fuzz campaign. */
export interface Rng {
  next(): number
}

/** mulberry32 — a tiny, well-known, fully deterministic PRNG. Pure integer
 * math; no wall clock, no Math.random (this module is imported by the
 * clean-room FSM runner, whose boundary test forbids both). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return {
    next(): number {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** Structural modifiers (NOT imported from canvas-editor — purity). */
export interface GestureModifiers {
  readonly shift?: boolean
  readonly alt?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
}

/** Which client a gesture op drives, in a MULTI-actor contract (Pilot 5). A
 * plain string (not an enum): the vocabulary stays data-shaped and open —
 * 'A'/'B' are convention, not a closed set. Single-actor contracts never set
 * this (every existing GestureOp omits `actor` and defaults to 'A'), so
 * every pre-Pilot-5 declaration stays byte-compatible. */
export type Actor = string

/** A screen-space anchor a gesture op resolves against. Phase A shipped only
 * the absolute point form; Pilot 2 (Phase C) extends this union with a shape
 * anchor (the library grows per unit — design's bootstrap principle). */
export type Anchor =
  | { readonly ref: 'point'; readonly x: number; readonly y: number }
  /** A seeded shape's centre, plus an optional SCREEN-space offset. The FSM
   * runner resolves this via worldToScreen(camera, centre); the browser runner
   * via the element's bounding box. */
  | { readonly ref: 'shape'; readonly id: string; readonly dx?: number; readonly dy?: number }

/** One primitive gesture step. SCREEN space, exactly like input.ts's
 * InputEvent coordinates — the FSM runner turns these into InputEvents via
 * script.ts, the browser runner into Playwright input. */
// Every variant carries an optional `actor` (Pilot 5's MULTI-actor
// extension — see the `Actor` doc comment above). Default 'A' when omitted:
// single-actor contracts never set it, so every pre-Pilot-5 gesture array
// (built without this field at all) keeps meaning exactly what it always
// did — one implicit actor, routed to the runner's ONE existing page/FSM.
export type GestureOp =
  | { readonly kind: 'down'; readonly at: Anchor; readonly modifiers?: GestureModifiers; readonly actor?: Actor }
  | { readonly kind: 'move'; readonly at: Anchor; readonly steps?: number; readonly modifiers?: GestureModifiers; readonly actor?: Actor }
  | { readonly kind: 'up'; readonly modifiers?: GestureModifiers; readonly actor?: Actor }
  | { readonly kind: 'wheel'; readonly dx: number; readonly dy: number; readonly at: Anchor; readonly modifiers?: GestureModifiers; readonly actor?: Actor }
  | { readonly kind: 'key'; readonly key: string; readonly modifiers?: GestureModifiers; readonly actor?: Actor }

/** The scene a contract wants seeded before its gesture runs. Phase A ships an
 * empty scene (pilot 1 needs no shapes); Pilot 2 adds shapes. Runner-agnostic:
 * the FSM runner seeds the doc directly, the browser runner seeds via
 * window.__ew.doc.putShape (lib/canvas-v2.ts's seedGrid pattern). */
export interface SceneShape {
  readonly id: string
  readonly kind: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The observation interface — the ONLY thing invariants may read. Grows one
 * method per pilot; Phase A ships just what Pilot 1 needs. Never expose FSM
 * internals or DOM nodes here — that is what lets one declaration run at either
 * level. */
export interface Obs {
  /** The world-space rectangle currently visible in the viewport. Pilot 1. */
  visibleWorldRect(): { minX: number; minY: number; maxX: number; maxY: number }
  /** The visible world rect captured ONCE before the gesture's first event —
   * the baseline a "did this gesture move the view?" invariant compares
   * against. Runner-provided; both adapters snapshot it at start. */
  visibleWorldRectAtStart(): { minX: number; minY: number; maxX: number; maxY: number }
  /** Total world-space displacement of a shape from the gesture's start. */
  shapeDisplacement(id: string): { dx: number; dy: number }
  /** Total change in a shape's LOCAL size (w/h) since the gesture's start —
   * the resize analogue of shapeDisplacement. A resize anchored at a corner
   * OTHER than the moving one keeps x/y fixed (only w/h change), so
   * translation alone cannot observe it; this is what lets a handle-drag
   * contract catch a resize under the editing caret. Rotation does NOT
   * register here — localBounds is rotation-independent, so a pure rotate
   * gesture leaves dw/dh at zero; rotate coverage needs a separate
   * observable, and a "no-transform" contract built on this method alone
   * must not be over-trusted as proof against rotation. */
  shapeSizeDelta(id: string): { dw: number; dh: number }
  /** Total world-space displacement of the cursor from the gesture's start
   * (last pointer position, mapped through the CURRENT camera minus the
   * grab-time world point). */
  cursorWorldDisplacement(): { dx: number; dy: number }
  /** The snap threshold radius in world units at the current scene's median
   * shape size — the tolerance the snapped invariant compares against. */
  snapRadius(): number
  /** How many distinct shape bodies the current native text selection
   * intersects (0 when nothing is selected). Browser-only; the FSM adapter may
   * throw 'not observable at fsm level' — a browser-tagged contract never runs
   * on the FSM lane. */
  textSelectionSpans(): number
  /** The shape currently being text-edited, or null. (editor.get().editingId
   * at fsm level; the mounted [data-text-editor-input] element in the browser
   * adapter.) */
  editingShape(): string | null
  /** Observe from a named actor's client (Pilot 5's MULTI-actor extension).
   * Single-actor contracts never call this — every method above answers
   * from actor 'A''s own view by default, exactly as before this method
   * existed. Returns an `Obs` scoped to that actor's page/FSM instance; a
   * runner that has provisioned no such actor throws. */
  on(actor: Actor): Obs
  /** Does THIS Obs's view show a "peer is editing" indicator for `shapeId`?
   * Browser-only (Pilot 5): a remote peer's presence-driven editing badge is
   * a rendered DOM element, not an FSM-observable concept — the FSM adapter
   * throws 'not observable at fsm level', matching textSelectionSpans'
   * established throw-stub pattern for a browser-only observation. */
  peerEditingIndicator(shapeId: string): boolean
}

/** A contract declaration = data. */
export interface Contract {
  readonly name: string
  readonly level: 'fsm' | 'browser'
  readonly when: 'every-event' | 'at-end'
  /** Optional: instantiate once per registered shape kind (design's per-kind
   * conformance-suite subsumption). Unused until a later unit needs it. */
  readonly scope?: 'per-kind'
  /** Which tool FSM the runner drives this contract through. 'select' (the
   * default — click/drag/marquee via tools/select.ts) or 'select+transform'
   * (the client's shipped composite: select PLUS resize/rotate handles via
   * tools/transform.ts). A contract that must exercise handle-dragging (e.g.
   * no-transform-while-typing, Phase E extension) sets 'select+transform'.
   * Pure string union — this module still imports NOTHING. */
  readonly tool?: 'select' | 'select+transform'
  /** Shapes to seed before the gesture. Default: none. */
  scene?(): readonly SceneShape[]
  /** Build the gesture ops from a seeded RNG — deterministic per seed. */
  gesture(rng: Rng): readonly GestureOp[]
  /** Return null if the observation satisfies the contract, or a human failure
   * message. Evaluated after every event (when === 'every-event') or once
   * after the last (at-end). Returning a message (not throwing) keeps the
   * declaration data-shaped and lets the runner attach the seed for repro. */
  check(obs: Obs): string | null
}
