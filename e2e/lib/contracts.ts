// The BROWSER runner (design's "same vocabulary, two runners"). Interprets a
// contract's GestureOp[] as real Playwright pointer/wheel/keyboard input
// against a live ?engine=v2 room and evaluates the invariant against a
// PAGE-backed Obs adapter (bounding boxes, window.getSelection(), focus).
// Only level:'browser' contracts pay this cost. Mirrors lib/canvas-v2.ts's
// helpers — same window.__ew.doc.putShape seeding, same viewport-relative
// screen math.
//
// SAMPLING CADENCE — honest version: this runner samples per GESTURE OP, not
// per interpolated input event. A `move` with `steps: 12` is one Playwright
// call that emits 12 pointermoves, and the invariant is checked ONCE at its
// endpoint (after a rAF settles the render) — coarser than the FSM runner,
// which interprets every step as its own event and checks after each one.
// That coarseness is fine for MONOTONIC invariants (Pilot 3's native
// selection only grows during a sweep — if it ever spanned two bodies
// mid-move it still does at the endpoint), but a TRANSIENT violation that
// self-heals within a single multi-step op would be invisible here; pinning
// those is the FSM lane's job (per-event checks at zero browser cost).
//
// MULTI-ACTOR (Pilot 5): a `GestureOp.actor` beyond the implicit default 'A'
// gets its OWN Playwright browser context, joined to the SAME room as the
// caller-supplied `page` (which is always actor 'A' — never re-provisioned).
// Reuses `canvas-v2.spec.ts`'s two-context pattern exactly (`browser.
// newContext({ storageState: identityState(...) })`, a distinct userId per
// actor) — see `identityForActor` below. Single-actor contracts (the whole
// pre-Pilot-5 library) never mention a second actor, so `actors` here is
// always the singleton `{'A'}`, no extra context is ever provisioned, and
// every sampled value is identical to what this runner produced before this
// extension — BYTE-COMPATIBLE, not just behaviorally equivalent.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { Actor, Anchor, Contract, GestureOp, Obs } from '@ensembleworks/interaction-contracts'
import { mulberry32 } from '@ensembleworks/interaction-contracts'
import { viewportBox, waitForBoot } from './canvas-v2.js'
import { identityState } from './fixtures.js'

// The browser lane runs the fixed CI smoke case only (seed 1 — the same
// "fixed CI smoke case" convention types.ts's Rng doc comment describes and
// library.test.ts's SEEDS array starts at). A wide fuzz campaign at this
// level would be Playwright-round-trip-expensive for little marginal value;
// the FSM lane already fuzzes the shared vocabulary (library.test.ts's
// drag-cursor-lock campaign) — the browser lane's job is proving the SAME
// gesture reproduces the bug in a real DOM, not re-fuzzing it.
const BROWSER_SEED = 1

// RENDER GATE — do not return until every one of `shapes` is actually
// visible on `page`. commit -> doc subscription -> React re-render is
// asynchronous; without this wait a gesture can race the pipeline and sweep
// over an EMPTY canvas, in which case a selection-shaped contract passes
// trivially (spans 0) — a false GREEN masking the very bug the contract
// pins, plus a latent flake. Split out from `seedScene` below so a MULTI-
// ACTOR peer (which never calls putShape itself — it receives the shapes
// over the live WS sync from actor 'A''s room) can wait on the SAME gate
// without re-seeding (re-seeding would double-`putShape` the same ids into
// the shared CRDT doc).
async function waitForShapesVisible(page: Page, shapes: readonly { readonly id: string }[]): Promise<void> {
  for (const s of shapes) {
    await expect(page.locator(`[data-shape-id="${s.id}"][data-shape-kind]`)).toBeVisible({ timeout: 10_000 })
  }
}

// Seed the scene through the live doc (same mechanism as seedGrid). Each
// seeded shape also gets its live text set to `text for <its id>`
// (CanvasDoc.setText) so a text-capable body (note/text/geo — label.ts's
// live-text-wins order) always renders SOMETHING selectable, regardless of a
// fallback label (shape.kind) being present or not — Task D4's RED step needs
// real selectable text spanning both bodies to reproduce the bug.
async function seedScene(page: Page, contract: Contract): Promise<void> {
  const shapes = contract.scene?.() ?? []
  if (shapes.length === 0) return
  await page.evaluate((shapes) => {
    const ew = (window as any).__ew
    for (const s of shapes) {
      ew.doc.putShape({
        id: s.id, kind: s.kind, parentId: ew.editor.pageId, index: 'a1',
        x: s.x, y: s.y, rotation: 0, isLocked: false, opacity: 1, meta: {},
        props: { w: s.w, h: s.h },
      })
      ew.doc.setText(s.id, `text for ${s.id}`)
    }
    ew.doc.commit()
  }, shapes as any)
  await waitForShapesVisible(page, shapes)
}

// A fixed identity per non-'A' actor (mirrors canvas-v2.spec.ts's ctxB
// precedent EXACTLY for 'B' — the only actor Pilot 5's contract uses — so
// this shares the same well-known userId a reader of that spec already
// recognizes). Any OTHER actor letter a future pilot introduces gets a
// deterministic, never-colliding fallback identity generated from its own
// name — never hand-picked ad hoc as new pilots are added.
const KNOWN_ACTOR_IDENTITIES: Readonly<Record<string, { readonly name: string; readonly id: string }>> = {
  B: { name: 'E2E Two', id: 'e2e-user-0000-0000-0002' },
}
function identityForActor(actor: Actor) {
  const known = KNOWN_ACTOR_IDENTITIES[actor]
  if (known) return identityState(known.name, known.id)
  return identityState(`E2E ${actor}`, `e2e-actor-${actor.toLowerCase()}`)
}

// Resolve an anchor to a viewport-relative SCREEN point.
async function resolveAnchor(page: Page, box: { x: number; y: number }, a: Anchor): Promise<{ x: number; y: number }> {
  if (a.ref === 'point') return { x: box.x + a.x, y: box.y + a.y }
  if (a.ref === 'element') {
    // Task P3's 'element' anchor — a rendered CONTROL (e.g. a style-panel
    // swatch) that has no seeded shape id. Mirrors the 'shape' anchor's
    // centre + SCREEN-space-offset resolution below, just via a CSS
    // selector's bounding box instead of a `[data-shape-id]` lookup.
    const rect = await page.locator(a.selector).boundingBox()
    if (!rect) throw new Error(`element anchor ${JSON.stringify(a.selector)} has no bounding box`)
    return { x: rect.x + rect.width / 2 + (a.dx ?? 0), y: rect.y + rect.height / 2 + (a.dy ?? 0) }
  }
  const rect = await page.locator(`[data-shape-id="${a.id}"][data-shape-kind]`).boundingBox()
  if (!rect) throw new Error(`shape anchor ${a.id} has no bounding box`)
  return { x: rect.x + rect.width / 2 + (a.dx ?? 0), y: rect.y + rect.height / 2 + (a.dy ?? 0) }
}

// Pilot 4's Obs.editingShape() doc comment (interaction-contracts/src/
// types.ts) names this exact mechanism for the browser adapter: the shape id
// is read off whichever [data-text-editor-input] element TextEditor.tsx
// mounts (or null when none is mounted) — the DOM equivalent of the FSM
// adapter's `editor.get().editingId`.
async function sampleEditingShape(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-text-editor-input]')
    return el ? el.getAttribute('data-text-editor-input') : null
  })
}

async function sampleTextSelectionSpans(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return 0
    const hit = new Set<string>()
    const bodies = document.querySelectorAll('[data-shape-id][data-shape-kind]')
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i)
      // Count every shape body the selection RANGE intersects (fully-contained
      // OR partially-overlapping — Range.intersectsNode returns true for both),
      // not just the two endpoints: a marquee anchored on empty canvas never
      // puts an endpoint inside the first body it sweeps over, so an
      // endpoint-only walk would miss it.
      bodies.forEach((body) => {
        if (range.intersectsNode(body)) hit.add((body as HTMLElement).getAttribute('data-shape-id')!)
      })
    }
    return hit.size
  })
}

// Pilot 5's Obs.peerEditingIndicator() doc comment (interaction-contracts/
// src/types.ts) names this exact mechanism: F4's fix renders a
// `data-overlay="editing" data-editing-shape-id="<id>"` element on any shape
// a peer's presence.editing names. Batched over every scene shape id in ONE
// page.evaluate (not one round-trip per id) — a contract's `check` calls
// `peerEditingIndicator(shapeId)` SYNCHRONOUSLY (Obs methods are sync — see
// pageObs's own doc comment), so every id it might ask about must already be
// pre-sampled before `check` runs, exactly like `editingShape`/
// `textSelectionSpans` are today.
// Task AS4's Obs.selectedShapeIds() doc comment (interaction-contracts/src/
// types.ts) names this exact mechanism for the browser adapter: read
// `window.__ew.editor.get().selection` (a Set<string> at fsm level, per
// editor.ts) and spread it into a plain array — same pre-sample-then-read-
// synchronously shape as every other Obs field here. Needed because a
// created shape's id is minted from crypto-random (create.ts's `makeId`) and
// this runner cannot predict it; the contract discovers it via the create
// tool's auto-selection instead.
async function sampleSelection(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const ew = (window as any).__ew
    return [...ew.editor.get().selection]
  })
}

// Task H1's Obs.shapeCount() doc comment (interaction-contracts/src/types.ts)
// names this exact mechanism for the browser adapter: read
// `window.__ew.doc.listShapes().length` — the browser-side twin of the FSM
// adapter's `editor.doc.listShapes().length`. Needed so K1-K3's copy/paste
// contracts can assert "N shapes now exist" (duplicate/paste) or "still N"
// (a rejected malformed paste never mutates the doc).
async function sampleShapeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ew = (window as any).__ew
    return ew.doc.listShapes().length
  })
}

// Task H1's Obs.paintOrder() doc comment (interaction-contracts/src/types.ts)
// names this exact mechanism for the browser adapter: read DOM document
// order of `[data-shape-id][data-shape-kind]` elements — that IS paint
// order, since ShapeBody paints flat, absolutely-positioned siblings in DOM
// order (the `[data-shape-kind]` qualifier excludes the arrow overlay `<g>`,
// which carries `data-shape-id` but no `data-shape-kind`).
async function samplePaintOrder(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll('[data-shape-id][data-shape-kind]')].map((el) => el.getAttribute('data-shape-id')!)
  })
}

// Task H's Obs.shapeKind(id) doc comment (interaction-contracts/src/types.ts)
// names this exact mechanism for the browser adapter: pre-sample each
// candidate shape's `kind` off the live doc (window.__ew.doc.getShape),
// mirroring sampleShapeStyles' pre-sample-then-read-synchronously shape
// exactly. Sampled for the UNION of seeded scene ids and the current
// selection (see sampleActor below) — same reason shapeStyle unions
// selection into styleIds: a gesture-created shape's id is minted from
// crypto-random and only discoverable via `selectedShapeIds()`.
async function sampleShapeKinds(page: Page, shapeIds: readonly string[]): Promise<Readonly<Record<string, string | null>>> {
  if (shapeIds.length === 0) return {}
  return page.evaluate((ids) => {
    const ew = (window as any).__ew
    const out: Record<string, string | null> = {}
    for (const id of ids) {
      const shape = ew.doc.getShape(id)
      out[id] = shape ? shape.kind : null
    }
    return out
  }, shapeIds)
}

async function samplePeerEditingIndicators(page: Page, shapeIds: readonly string[]): Promise<Record<string, boolean>> {
  if (shapeIds.length === 0) return {}
  return page.evaluate((ids) => {
    const out: Record<string, boolean> = {}
    for (const id of ids) {
      out[id] = document.querySelector(`[data-overlay="editing"][data-editing-shape-id="${id}"]`) !== null
    }
    return out
  }, shapeIds)
}

// Task P3's Obs.shapeStyle(id, key) doc comment (interaction-contracts/src/
// types.ts) names this exact mechanism for the browser adapter: pre-sample
// each scene shape's FULL props object + envelope opacity off the live doc
// (window.__ew.doc.getShape, same read `seedScene` above uses to write),
// then answer `shapeStyle(id, key)` synchronously from that snapshot —
// mirrors editingIndicators' pre-sample-then-read-synchronously shape
// exactly. Sampling the whole props object (not just a fixed axis list)
// means this adapter never needs to know the style-axis vocabulary itself —
// it stays generic over whatever key a contract's `check` asks for, exactly
// like the FSM adapter's `shape.props[key]` read.
async function sampleShapeStyles(
  page: Page,
  shapeIds: readonly string[],
): Promise<Readonly<Record<string, { readonly opacity: number; readonly props: Readonly<Record<string, unknown>> } | null>>> {
  if (shapeIds.length === 0) return {}
  return page.evaluate((ids) => {
    const ew = (window as any).__ew
    const out: Record<string, { opacity: number; props: Record<string, unknown> } | null> = {}
    for (const id of ids) {
      const shape = ew.doc.getShape(id)
      out[id] = shape ? { opacity: shape.opacity, props: shape.props } : null
    }
    return out
  }, shapeIds)
}

/** One actor's pre-sampled observation values — see `pageObs`'s doc comment
 * for why these must be sampled BEFORE `contract.check` runs rather than
 * read lazily from inside an `Obs` method. */
interface ActorSample {
  readonly spans: number
  readonly editingShape: string | null
  readonly editingIndicators: Readonly<Record<string, boolean>>
  readonly styles: Readonly<Record<string, { readonly opacity: number; readonly props: Readonly<Record<string, unknown>> } | null>>
  readonly selection: readonly string[]
  readonly shapeCount: number
  readonly paintOrder: readonly string[]
  readonly kinds: Readonly<Record<string, string | null>>
}

/** Samples everything ANY browser contract's `check` might read off one
 * actor's page: settles a render frame first (the same RENDER-SETTLING gate
 * `nextFrame` always was, just now scoped per actor instead of the single
 * caller-supplied `page`), then reads text selection spans, the locally-
 * mounted text editor's shape id, (Pilot 5) which of the scene's shapes show
 * a peer-editing indicator on THIS actor's own screen, each scene shape's
 * stored style, and (Task AS4) the current editor selection. */
async function sampleActor(page: Page, sceneShapeIds: readonly string[]): Promise<ActorSample> {
  await nextFrame(page)
  const spans = await sampleTextSelectionSpans(page)
  const editingShape = await sampleEditingShape(page)
  const editingIndicators = await samplePeerEditingIndicators(page, sceneShapeIds)
  const selection = await sampleSelection(page)
  // Task AS4: `shapeStyle` must also answer for a shape `check` discovers
  // via `selectedShapeIds()` — e.g. armed-style-applies-to-created-shape's
  // newly-created shape, which was never in `contract.scene()` (seeded
  // scene shapes have known ids up front; a GESTURE-created shape's id is
  // minted from crypto-random and only exists once the gesture runs, so it
  // can only be discovered through the selection it auto-lands in). Sample
  // styles for the UNION of seeded scene ids and the current selection, not
  // just the former, or `shapeStyle(createdId, ...)` would silently read as
  // "shape absent" (null) regardless of the shape's real stored props.
  const styleIds = [...new Set([...sceneShapeIds, ...selection])]
  const styles = await sampleShapeStyles(page, styleIds)
  const shapeCount = await sampleShapeCount(page)
  const paintOrder = await samplePaintOrder(page)
  // Task H: same union rationale as styleIds above — a gesture-created
  // shape's id (e.g. the pen tool's freshly-drawn stroke) is only
  // discoverable via `selection`, never present in the seeded `sceneShapeIds`.
  const kinds = await sampleShapeKinds(page, styleIds)
  return { spans, editingShape, editingIndicators, styles, selection, shapeCount, paintOrder, kinds }
}

/** Build a synchronous, pre-sampled Obs for exactly the observation(s) a
 * browser contract's `check` reads. Design tension (module header of the
 * task that introduced this): `Obs` methods are synchronous, but page
 * observations are async — rather than making every `Obs` method async
 * (which would ripple into the FSM adapter for no benefit), the runner reads
 * the specific fields BEFORE calling `check` and returns a snapshot-backed
 * Obs. Keep the sampler minimal (YAGNI).
 *
 * MULTI-ACTOR (Pilot 5): `samples` holds ONE `ActorSample` per provisioned
 * actor (keyed by actor letter); `on(actor)` looks itself up in that SAME
 * map via `obsFor`, so `obs.on('B').peerEditingIndicator(id)` reads B's own
 * pre-sampled values, never A's. A single-actor contract's `samples` map has
 * exactly one entry ('A') and never calls `on` at all — every field it DOES
 * read (`textSelectionSpans`/`editingShape`/`visibleWorldRectAtStart`)
 * resolves identically to the pre-Pilot-5 shape of this function. */
function pageObs(
  startRect: { minX: number; minY: number; maxX: number; maxY: number },
  actor: Actor,
  samples: ReadonlyMap<Actor, ActorSample>,
  obsFor: (actor: Actor) => Obs,
): Obs {
  const sample = samples.get(actor)
  if (!sample) throw new Error(`obs.on(${JSON.stringify(actor)}): no such actor was provisioned for this contract's gesture`)
  return {
    visibleWorldRectAtStart: () => startRect,
    visibleWorldRect: () => { throw new Error('sync obs unavailable in browser adapter — use the async sampler') },
    shapeDisplacement: () => { throw new Error('use async sampler') },
    shapeSizeDelta: () => { throw new Error('use async sampler') },
    cursorWorldDisplacement: () => { throw new Error('use async sampler') },
    snapRadius: () => { throw new Error('use async sampler') },
    textSelectionSpans: () => sample.spans,
    editingShape: () => sample.editingShape,
    on: (a: Actor) => obsFor(a),
    peerEditingIndicator: (shapeId: string) => sample.editingIndicators[shapeId] ?? false,
    shapeStyle: (id: string, key: string) => {
      const shape = sample.styles[id]
      if (!shape) return null
      if (key === 'opacity') return shape.opacity
      const raw = shape.props[key]
      return typeof raw === 'string' || typeof raw === 'number' ? raw : null
    },
    selectedShapeIds: () => sample.selection,
    shapeCount: () => sample.shapeCount,
    paintOrder: () => sample.paintOrder,
    shapeKind: (id: string) => sample.kinds[id] ?? null,
  }
}

// MODIFIER CONVENTION: modifiers are pressed just before, and released just
// after, THE ONE OP that declares them — never held across ops. That matches
// the FSM runner's semantics, where modifiers are per-event boolean flags on
// the interpreted input (no key up/down events exist at that level), so a
// contract that wants shift held across a whole drag must say so on every op.
type OpModifiers = { readonly shift?: boolean; readonly alt?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }
async function setModifiers(page: Page, direction: 'down' | 'up', modifiers?: OpModifiers): Promise<void> {
  if (!modifiers) return
  if (modifiers.shift) await page.keyboard[direction]('Shift')
  if (modifiers.alt) await page.keyboard[direction]('Alt')
  if (modifiers.ctrl) await page.keyboard[direction]('Control')
  if (modifiers.meta) await page.keyboard[direction]('Meta')
}

// Waits one animation frame so React has painted the effects of the op just
// dispatched before we sample. This is a RENDER-SETTLING gate, not a
// per-event check cadence — see the module header's SAMPLING CADENCE note:
// the browser lane checks once per GestureOp (at a multi-step move's
// endpoint), coarser than the FSM runner's per-interpolated-event checks.
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
}

/** Retries `check` until it returns null (pass) or `timeoutMs` elapses,
 * returning the LAST failure seen if it never passes. Pilot 5's reason this
 * exists: an 'at-end' multi-actor check reads a REMOTE peer's presence,
 * which must cross the network (WS relay) and then wait for that peer's own
 * `PRESENCE_POLL_MS` (150ms) re-render poll — a single post-gesture sample,
 * the pre-Pilot-5 behavior, would flake or permanently fail on convergence
 * lag alone, independent of whether the feature actually works. Scoped to
 * ONLY the 'at-end' branch (see `runContractBrowser` below) — the
 * 'every-event' branch keeps its original immediate single-check semantics
 * unconditionally, because `cross-widget-selection` (this library's one
 * 'every-event' browser contract) needs to catch a TRANSIENT same-tick
 * violation, which retrying would mask, not prove. No pre-Pilot-5 contract
 * uses 'at-end' at the browser level, so this addition changes nothing for
 * the existing library — a single-actor 'at-end' contract (were one ever
 * added) just passes on its first attempt, at zero added latency. */
async function pollUntilPass(check: () => Promise<string | null>, timeoutMs: number, intervalMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let failure = await check()
  while (failure !== null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    failure = await check()
  }
  return failure
}

const AT_END_POLL_TIMEOUT_MS = 10_000
const AT_END_POLL_INTERVAL_MS = 100

/** Run one browser-level contract against an already-booted, already-seeded
 * (this function seeds it) v2 page. Returns the first invariant failure
 * message, or null if the contract held for the whole gesture.
 *
 * `when: 'every-event'` here means per GESTURE OP (rAF-settled, then
 * checked) — NOT per interpolated pointermove; a `steps: 12` move is checked
 * once, at its endpoint. See the module header's SAMPLING CADENCE note for
 * why that's sufficient for monotonic invariants and where transient
 * violations must be pinned instead (the FSM lane).
 *
 * MULTI-ACTOR (Pilot 5): `browser` is REQUIRED only when the contract's
 * gesture names an actor other than 'A' — every pre-Pilot-5 contract omits
 * `actor` on every op, so `actors` below is always the singleton `{'A'}` and
 * `browser` is never even read. A caller that always threads `browser`
 * through (as `contracts.spec.ts` now does for every contract, not just
 * multi-actor ones) pays nothing extra for a single-actor declaration. */
export async function runContractBrowser(page: Page, contract: Contract, browser?: Browser): Promise<string | null> {
  await waitForBoot(page)
  await seedScene(page, contract)
  const sceneShapes = contract.scene?.() ?? []
  const sceneShapeIds = sceneShapes.map((s) => s.id)

  // Task H1: a single seeded rng stream feeds BOTH `contract.clipboard` (if
  // present) and `contract.gesture` below — same "deterministic per seed"
  // contract every other declaration gets, just shared across the two calls
  // instead of each minting its own mulberry32(BROWSER_SEED). Clipboard is
  // seeded BEFORE the gesture runs (K3's malformed-clipboard contract needs
  // the hostile payload sitting in the clipboard before Ctrl+V fires).
  const rng = mulberry32(BROWSER_SEED)
  if (contract.clipboard) {
    const payload = contract.clipboard(rng)
    await page.evaluate((text) => navigator.clipboard.writeText(text), payload)
  }
  const ops: readonly GestureOp[] = contract.gesture(rng)
  const actors = new Set<Actor>(ops.map((op) => op.actor ?? 'A'))
  actors.add('A')
  // An OBSERVER-only actor (Pilot 5's 'B': it never performs a single
  // gesture op, it only watches via `obs.on('B')` inside `check`) is
  // invisible to the op-scan above by construction — there is no op to
  // carry its actor tag. Statically scanning `check`'s own source text for
  // `.on('X')` calls closes that gap without growing `Contract` a redundant
  // `actors` field a declaration could forget to keep in sync with what
  // `check` actually calls. Same "read the raw text, don't execute it"
  // trick this house already uses elsewhere (boundary.test.ts's import-
  // boundary scan) — safe here because `Function.prototype.toString()` on a
  // contract's own plain function literal is just reading source, never
  // evaluating anything.
  for (const m of contract.check.toString().matchAll(/\.on\(\s*['"]([^'"]+)['"]\s*\)/g)) actors.add(m[1]!)

  const pages = new Map<Actor, Page>([['A', page]])
  const boxes = new Map<Actor, { x: number; y: number; width: number; height: number }>([['A', await viewportBox(page)]])
  const extraContexts: BrowserContext[] = []

  try {
    if (actors.size > 1) {
      if (!browser) {
        throw new Error(
          `contract ${contract.name} names an actor beyond 'A' but runContractBrowser was not given a 'browser' fixture to provision extra contexts with`,
        )
      }
      const room = new URL(page.url()).searchParams.get('room')
      if (!room) throw new Error(`runContractBrowser: page.url() ${JSON.stringify(page.url())} has no ?room= — cannot join actor B to the same room`)
      for (const actor of actors) {
        if (actor === 'A') continue
        const ctx = await browser.newContext({ storageState: identityForActor(actor) })
        extraContexts.push(ctx)
        const actorPage = await ctx.newPage()
        actorPage.on('dialog', (d) => {
          throw new Error(`unexpected dialog on actor ${actor} (identity fixture broken?): ${d.message()}`)
        })
        await actorPage.goto(`/?room=${room}&engine=v2`)
        await waitForBoot(actorPage)
        // NOT seedScene: actor 'A' already created these shapes in the SHARED
        // CRDT doc (same room) — this peer only needs to wait for them to
        // arrive over the live sync and render, never re-`putShape` them
        // (which would double-create under the same ids).
        await waitForShapesVisible(actorPage, sceneShapes)
        pages.set(actor, actorPage)
        boxes.set(actor, await viewportBox(actorPage))
      }
    }

    const startBox = boxes.get('A')!
    const startRect = { minX: startBox.x, minY: startBox.y, maxX: startBox.x + startBox.width, maxY: startBox.y + startBox.height }

    const check = async (): Promise<string | null> => {
      const samples = new Map<Actor, ActorSample>()
      for (const [actor, actorPage] of pages) samples.set(actor, await sampleActor(actorPage, sceneShapeIds))
      const obsFor = (a: Actor): Obs => pageObs(startRect, a, samples, obsFor)
      return contract.check(obsFor('A'))
    }

    for (const op of ops) {
      const actor = op.actor ?? 'A'
      const actorPage = pages.get(actor)
      if (!actorPage) throw new Error(`gesture op targets actor ${JSON.stringify(actor)}, which was never provisioned`)
      const actorBox = boxes.get(actor)!
      switch (op.kind) {
        case 'down': {
          const p = await resolveAnchor(actorPage, actorBox, op.at)
          await setModifiers(actorPage, 'down', op.modifiers)
          await actorPage.mouse.move(p.x, p.y)
          await actorPage.mouse.down()
          await setModifiers(actorPage, 'up', op.modifiers)
          break
        }
        case 'move': {
          const p = await resolveAnchor(actorPage, actorBox, op.at)
          await setModifiers(actorPage, 'down', op.modifiers)
          await actorPage.mouse.move(p.x, p.y, { steps: op.steps ?? 1 })
          await setModifiers(actorPage, 'up', op.modifiers)
          break
        }
        case 'up': {
          await setModifiers(actorPage, 'down', op.modifiers)
          await actorPage.mouse.up()
          await setModifiers(actorPage, 'up', op.modifiers)
          break
        }
        case 'wheel': {
          const p = await resolveAnchor(actorPage, actorBox, op.at)
          await actorPage.mouse.move(p.x, p.y)
          await setModifiers(actorPage, 'down', op.modifiers)
          await actorPage.mouse.wheel(op.dx, op.dy)
          await setModifiers(actorPage, 'up', op.modifiers)
          break
        }
        case 'key': {
          await setModifiers(actorPage, 'down', op.modifiers)
          await actorPage.keyboard.press(op.key)
          await setModifiers(actorPage, 'up', op.modifiers)
          break
        }
      }
      if (contract.when === 'every-event') {
        // Immediate, single check — see pollUntilPass's doc comment for why
        // 'every-event' deliberately does NOT retry.
        const failure = await check()
        if (failure) return failure
      }
    }
    if (contract.when === 'at-end') {
      const failure = await pollUntilPass(check, AT_END_POLL_TIMEOUT_MS, AT_END_POLL_INTERVAL_MS)
      if (failure) return failure
    }
    return null
  } finally {
    for (const ctx of extraContexts) await ctx.close()
  }
}
