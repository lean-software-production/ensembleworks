// The BROWSER runner (design's "same vocabulary, two runners"). Interprets a
// contract's GestureOp[] as real Playwright pointer/wheel/keyboard input
// against a live ?engine=v2 room, samples the invariant per animation frame
// (when: 'every-event'), and evaluates it against a PAGE-backed Obs adapter
// (bounding boxes, window.getSelection(), focus). Only level:'browser'
// contracts pay this cost. Mirrors lib/canvas-v2.ts's helpers — same
// window.__ew.doc.putShape seeding, same viewport-relative screen math.
import type { Page } from '@playwright/test'
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
// seeded shape also gets its live text set to its own id (CanvasDoc.setText)
// so a text-capable body (note/text/geo — label.ts's live-text-wins order)
// always renders SOMETHING selectable, regardless of a fallback label
// (shape.kind) being present or not — Task D4's RED step needs real
// selectable text spanning both bodies to reproduce the bug.
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
}

// Resolve an anchor to a viewport-relative SCREEN point.
async function resolveAnchor(page: Page, box: { x: number; y: number }, a: Anchor): Promise<{ x: number; y: number }> {
  if (a.ref === 'point') return { x: box.x + a.x, y: box.y + a.y }
  const rect = await page.locator(`[data-shape-id="${a.id}"][data-shape-kind]`).boundingBox()
  if (!rect) throw new Error(`shape anchor ${a.id} has no bounding box`)
  return { x: rect.x + rect.width / 2 + (a.dx ?? 0), y: rect.y + rect.height / 2 + (a.dy ?? 0) }
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
function pageObs(startRect: { minX: number; minY: number; maxX: number; maxY: number }, textSelectionSpans: number): Obs {
  return {
    visibleWorldRectAtStart: () => startRect,
    visibleWorldRect: () => { throw new Error('sync obs unavailable in browser adapter — use the async sampler') },
    shapeDisplacement: () => { throw new Error('use async sampler') },
    cursorWorldDisplacement: () => { throw new Error('use async sampler') },
    snapRadius: () => { throw new Error('use async sampler') },
    textSelectionSpans: () => textSelectionSpans,
  }
}

async function resolveModifiers(page: Page, modifiers?: { readonly shift?: boolean; readonly alt?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }): Promise<void> {
  if (!modifiers) return
  if (modifiers.shift) await page.keyboard.down('Shift')
  if (modifiers.alt) await page.keyboard.down('Alt')
  if (modifiers.ctrl) await page.keyboard.down('Control')
  if (modifiers.meta) await page.keyboard.down('Meta')
}

async function releaseModifiers(page: Page, modifiers?: { readonly shift?: boolean; readonly alt?: boolean; readonly ctrl?: boolean; readonly meta?: boolean }): Promise<void> {
  if (!modifiers) return
  if (modifiers.shift) await page.keyboard.up('Shift')
  if (modifiers.alt) await page.keyboard.up('Alt')
  if (modifiers.ctrl) await page.keyboard.up('Control')
  if (modifiers.meta) await page.keyboard.up('Meta')
}

// Waits one animation frame — the per-rAF sample point for `when:
// 'every-event'` contracts, mirroring the FSM runner's after-every-event
// check() call at the browser layer's own natural cadence.
async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))))
}

/** Run one browser-level contract against an already-booted, already-seeded
 * (this function seeds it) v2 page. Returns the first invariant failure
 * message, or null if the contract held for the whole gesture. */
export async function runContractBrowser(page: Page, contract: Contract): Promise<string | null> {
  await waitForBoot(page)
  await seedScene(page, contract)
  const box = await viewportBox(page)
  const startRect = { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }

  const ops: readonly GestureOp[] = contract.gesture(mulberry32(BROWSER_SEED))

  const check = async (): Promise<string | null> => {
    const spans = await sampleTextSelectionSpans(page)
    const obs = pageObs(startRect, spans)
    return contract.check(obs)
  }

  for (const op of ops) {
    switch (op.kind) {
      case 'down': {
        const p = await resolveAnchor(page, box, op.at)
        await resolveModifiers(page, op.modifiers)
        await page.mouse.move(p.x, p.y)
        await page.mouse.down()
        await releaseModifiers(page, op.modifiers)
        break
      }
      case 'move': {
        const p = await resolveAnchor(page, box, op.at)
        await resolveModifiers(page, op.modifiers)
        await page.mouse.move(p.x, p.y, { steps: op.steps ?? 1 })
        await releaseModifiers(page, op.modifiers)
        break
      }
      case 'up': {
        await resolveModifiers(page, op.modifiers)
        await page.mouse.up()
        await releaseModifiers(page, op.modifiers)
        break
      }
      case 'wheel': {
        const p = await resolveAnchor(page, box, op.at)
        await page.mouse.move(p.x, p.y)
        await resolveModifiers(page, op.modifiers)
        await page.mouse.wheel(op.dx, op.dy)
        await releaseModifiers(page, op.modifiers)
        break
      }
      case 'key': {
        await resolveModifiers(page, op.modifiers)
        await page.keyboard.press(op.key)
        await releaseModifiers(page, op.modifiers)
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
