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
  /** Pilot P3 extension — a CSS selector resolved to an element's bounding-
   * box centre, plus an optional SCREEN-space offset. For addressing a
   * rendered CONTROL that has no seeded shape id (e.g. a style-panel
   * swatch) — mirrors the 'shape' anchor's shape but resolved via
   * `page.locator(selector).boundingBox()` instead of a shape id. Browser-
   * only: the FSM runner has no DOM to query, so it throws there (matching
   * the established throw-stub pattern for browser-only observations). */
  | { readonly ref: 'element'; readonly selector: string; readonly dx?: number; readonly dy?: number }

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
  /** Task K (assets/image sub-cycle) — a real HTML5 file drop at a screen
   * anchor, carrying a data-URL payload (so a contract embeds its fixture
   * inline rather than reading a file off disk). Browser-only by
   * construction: there is no DOM/File/DataTransfer at the FSM level (the
   * FSM runner throws — see fsm-runner.ts's opsToEvents), matching the
   * established throw-stub pattern for a browser-only primitive
   * (textSelectionSpans/peerEditingIndicator/the 'element' anchor). The
   * browser runner (e2e/lib/contracts.ts) builds a real `File` from
   * `dataUrl` + `mimeType`/`name`, wraps it in a `DataTransfer`, and
   * dispatches `dragenter`/`dragover`/`drop` DragEvents at the resolved
   * anchor point — Playwright's `mouse` API cannot carry a file payload. */
  | { readonly kind: 'dropFile'; readonly at: Anchor; readonly dataUrl: string; readonly name?: string; readonly mimeType?: string; readonly actor?: Actor }

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
  /** A shape's stored style value: props[key], or the envelope opacity when
   * key === 'opacity', or null when the shape/prop is absent. Task P3.
   * Available at BOTH levels (reads doc state, not the DOM) — no
   * throw-stub: the FSM adapter reads `editor.doc.getShape`, the browser
   * adapter pre-samples `window.__ew.doc.getShape` per scene shape. */
  shapeStyle(id: string, key: string): string | number | null
  /** The current editor selection, as a plain array. Task AS4. Available at
   * BOTH levels (reads editor state, not the DOM) — no throw-stub: the FSM
   * adapter reads `[...editor.get().selection]` directly, the browser
   * adapter pre-samples `window.__ew.editor.get().selection`. General and
   * reusable (not a styling-specific probe) — AS4's armed-style contract
   * uses this to discover a just-created shape's id (minted from
   * crypto-random, so the runner cannot predict it up front) via the create
   * tool's auto-selection (create.ts's `finalizeIntents`), then reuses
   * `shapeStyle` above for the value assertion. */
  selectedShapeIds(): readonly string[]
  /** Total count of shapes currently in the doc (all pages/kinds). Task H1 —
   * the copy/paste contracts (K1-K3) need a total-count read to prove "N
   * shapes created" (duplicate/paste) or "0 created" (a rejected malformed
   * paste); the existing Obs set has no such probe. Available at BOTH levels
   * (reads doc state, not the DOM) — no throw-stub: the FSM adapter reads
   * `editor.doc.listShapes().length` directly, the browser adapter samples
   * `window.__ew.doc.listShapes().length`. */
  shapeCount(): number
  /** Shape ids in PAINT order — first painted (bottommost) to last painted
   * (topmost, "on top"). Task H1 — the z-order sub-cycle's bring-to-front
   * contract (Z1) needs to observe the RENDERER's actual paint order, not
   * doc/model state, to prove "bring-to-front moves a shape to the top".
   * Browser-only by construction: paint order is a rendering concept the
   * headless FSM has no notion of (same precedent as textSelectionSpans /
   * peerEditingIndicator / the 'element' anchor) — the browser adapter reads
   * DOM document order of `[data-shape-id][data-shape-kind]` elements (IS
   * paint order, since ShapeBody paints flat absolutely-positioned siblings
   * in DOM order), the FSM adapter throws 'not observable at fsm level'. */
  paintOrder(): readonly string[]
  /** A shape's `kind` (the envelope discriminant — 'geo', 'draw', 'note', …),
   * or null when the shape is absent. Task H — `shapeStyle` cannot answer
   * this: kind lives on the envelope, not `props`, and isn't a
   * string/number prop value. Available at BOTH levels (reads doc state,
   * not the DOM) — no throw-stub: the FSM adapter reads
   * `editor.doc.getShape(id)?.kind ?? null` directly, the browser adapter
   * pre-samples kinds for the union of scene ids + selection (same reason
   * `shapeStyle`/`sampleActor` union selection into `styleIds` — a
   * gesture-created shape's id is minted from crypto-random and only
   * discoverable via `selectedShapeIds()`). */
  shapeKind(id: string): string | null
  /** A SHAPE's resolved image-asset source: `props.assetId` on the shape
   * looked up against the doc's asset map, returning that asset's
   * `props.src` — or null when the shape is absent, carries no
   * (string) `assetId`, or the resolved asset has no `src`. Task K
   * (assets/image sub-cycle) — proves an image shape's `assetId`
   * genuinely resolves to a STORED asset (e.g. an `/uploads/...` src from
   * a real upload), not merely that a shape of kind 'image' exists.
   * Available at BOTH levels (reads doc state, not the DOM) — no
   * throw-stub: the FSM adapter reads `editor.doc.getShape`/`getAsset`
   * directly, the browser adapter pre-samples via `window.__ew.doc`. */
  assetSrc(id: string): string | null
  /** Total count of PAGES currently in the doc. Task H1 (pages sub-cycle,
   * docs/plans/2026-07-22-canvas-v2-pages.md) — Z1's switching-page contract
   * needs a model-level "a page was created" read that doesn't depend on the
   * render filter it's also proving, so a failure of the COUNT assertion can
   * never be confused with a failure of the paint-order assertion. Available
   * at BOTH levels (reads doc state, not the DOM) — no throw-stub: the FSM
   * adapter reads `editor.doc.listPages().length` directly, the browser
   * adapter samples `window.__ew.doc.listPages().length`. */
  pageCount(): number
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
  /** Task H1 — a payload to pre-seed the OS clipboard with, BEFORE the
   * gesture runs. Browser-only by construction: only `e2e/lib/contracts.ts`
   * reads this field (`level:'browser'` contracts write it via
   * `navigator.clipboard.writeText` ahead of the gesture); the FSM runner
   * never runs a `level:'browser'` contract (library.test.ts filters
   * CONTRACTS to `level === 'fsm'`), so it never reads `clipboard` at all —
   * no throw-stub needed, unlike an `Obs` method. Seeded from the same `rng`
   * the gesture itself gets, for a reproducible-per-seed hostile payload
   * (K3's malformed-clipboard contract). */
  clipboard?(rng: Rng): string
  /** Build the gesture ops from a seeded RNG — deterministic per seed. */
  gesture(rng: Rng): readonly GestureOp[]
  /** Return null if the observation satisfies the contract, or a human failure
   * message. Evaluated after every event (when === 'every-event') or once
   * after the last (at-end). Returning a message (not throwing) keeps the
   * declaration data-shaped and lets the runner attach the seed for repro. */
  check(obs: Obs): string | null
}
