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
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { Anchor, Contract, GestureOp, Obs } from '@ensembleworks/interaction-contracts'
import { mulberry32 } from '@ensembleworks/interaction-contracts'
import { viewportBox, waitForBoot } from './canvas-v2.js'

// The browser lane runs the fixed CI smoke case only (seed 1 — the same
// "fixed CI smoke case" convention types.ts's Rng doc comment describes and
// library.test.ts's SEEDS array starts at). A wide fuzz campaign at this
// level would be Playwright-round-trip-expensive for little marginal value;
// the FSM lane already fuzzes the shared vocabulary (library.test.ts's
// drag-cursor-lock campaign) — the browser lane's job is proving the SAME
// gesture reproduces the bug in a real DOM, not re-fuzzing it.
const BROWSER_SEED = 1

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
  // RENDER GATE — do not return until every seeded body is actually visible.
  // commit → doc subscription → React re-render is asynchronous; without this
  // wait the gesture can race the pipeline and sweep over an EMPTY canvas, in
  // which case a selection-shaped contract passes trivially (spans 0) — a
  // false GREEN masking the very bug the contract pins, plus a latent flake.
  for (const s of shapes) {
    await expect(page.locator(`[data-shape-id="${s.id}"][data-shape-kind]`)).toBeVisible({ timeout: 10_000 })
  }
}

// Resolve an anchor to a viewport-relative SCREEN point.
async function resolveAnchor(page: Page, box: { x: number; y: number }, a: Anchor): Promise<{ x: number; y: number }> {
  if (a.ref === 'point') return { x: box.x + a.x, y: box.y + a.y }
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

/** Build a synchronous, pre-sampled Obs for exactly the observation(s) a
 * browser contract's `check` reads. Design tension (module header of the
 * task that introduced this): `Obs` methods are synchronous, but page
 * observations are async — rather than making every `Obs` method async
 * (which would ripple into the FSM adapter for no benefit), the runner reads
 * the specific fields BEFORE calling `check` and returns a snapshot-backed
 * Obs. Keep the sampler minimal (YAGNI) — a later pilot's multi-actor
 * `obs.on('B')` extends this, not today's contracts. */
function pageObs(startRect: { minX: number; minY: number; maxX: number; maxY: number }, textSelectionSpans: number, editingShape: string | null): Obs {
  return {
    visibleWorldRectAtStart: () => startRect,
    visibleWorldRect: () => { throw new Error('sync obs unavailable in browser adapter — use the async sampler') },
    shapeDisplacement: () => { throw new Error('use async sampler') },
    cursorWorldDisplacement: () => { throw new Error('use async sampler') },
    snapRadius: () => { throw new Error('use async sampler') },
    textSelectionSpans: () => textSelectionSpans,
    editingShape: () => editingShape,
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

/** Run one browser-level contract against an already-booted, already-seeded
 * (this function seeds it) v2 page. Returns the first invariant failure
 * message, or null if the contract held for the whole gesture.
 *
 * `when: 'every-event'` here means per GESTURE OP (rAF-settled, then
 * checked) — NOT per interpolated pointermove; a `steps: 12` move is checked
 * once, at its endpoint. See the module header's SAMPLING CADENCE note for
 * why that's sufficient for monotonic invariants and where transient
 * violations must be pinned instead (the FSM lane). */
export async function runContractBrowser(page: Page, contract: Contract): Promise<string | null> {
  await waitForBoot(page)
  await seedScene(page, contract)
  const box = await viewportBox(page)
  const startRect = { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }

  const ops: readonly GestureOp[] = contract.gesture(mulberry32(BROWSER_SEED))

  const check = async (): Promise<string | null> => {
    const spans = await sampleTextSelectionSpans(page)
    const editingShape = await sampleEditingShape(page)
    const obs = pageObs(startRect, spans, editingShape)
    return contract.check(obs)
  }

  for (const op of ops) {
    switch (op.kind) {
      case 'down': {
        const p = await resolveAnchor(page, box, op.at)
        await setModifiers(page, 'down', op.modifiers)
        await page.mouse.move(p.x, p.y)
        await page.mouse.down()
        await setModifiers(page, 'up', op.modifiers)
        break
      }
      case 'move': {
        const p = await resolveAnchor(page, box, op.at)
        await setModifiers(page, 'down', op.modifiers)
        await page.mouse.move(p.x, p.y, { steps: op.steps ?? 1 })
        await setModifiers(page, 'up', op.modifiers)
        break
      }
      case 'up': {
        await setModifiers(page, 'down', op.modifiers)
        await page.mouse.up()
        await setModifiers(page, 'up', op.modifiers)
        break
      }
      case 'wheel': {
        const p = await resolveAnchor(page, box, op.at)
        await page.mouse.move(p.x, p.y)
        await setModifiers(page, 'down', op.modifiers)
        await page.mouse.wheel(op.dx, op.dy)
        await setModifiers(page, 'up', op.modifiers)
        break
      }
      case 'key': {
        await setModifiers(page, 'down', op.modifiers)
        await page.keyboard.press(op.key)
        await setModifiers(page, 'up', op.modifiers)
        break
      }
    }
    if (contract.when === 'every-event') {
      await nextFrame(page)
      const failure = await check()
      if (failure) return failure
    }
  }
  if (contract.when === 'at-end') {
    await nextFrame(page)
    const failure = await check()
    if (failure) return failure
  }
  return null
}
