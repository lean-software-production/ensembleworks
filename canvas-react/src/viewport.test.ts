// Run: bun src/viewport.test.ts
// No DOM emulator in the house test rig (no jsdom/happy-dom dependency) —
// component tests use `renderToStaticMarkup` from react-dom/server (a pure
// string-render, no browser globals needed) and fabricated plain-object
// events (dom-events.ts's mappers accept structural types for exactly this
// reason — see that file's header). This file stays `.test.ts` (not
// `.test.tsx`): every JSX-shaped call below goes through
// `React.createElement` instead of JSX syntax, so this house's test globs
// (this package's test.ts AND the root scripts/run-tests.ts, both
// `**/*.test.ts` only) don't need a `.tsx` variant.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { cameraTransform, WorldLayer } from './WorldLayer.js'
import { Grid } from './Grid.js'
import { keyEventToInput, pointerEventToInput, wheelEventToInput, type KeyEventLike, type PointerEventLike, type RectLike, type WheelEventLike } from './dom-events.js'

// ============================================================================
// 1. cameraTransform: exact string for two hand-picked cameras.
// ============================================================================
{
  const a: Camera = { x: 10, y: -5, z: 2 }
  assert.equal(cameraTransform(a), 'scale(2) translate(10px, -5px)', 'camera A')

  const b: Camera = { x: 0, y: 0, z: 1 }
  assert.equal(cameraTransform(b), 'scale(1) translate(0px, 0px)', 'camera B (identity)')

  console.log('ok: cameraTransform — exact string for two cameras')
}

// ============================================================================
// 2. The transform string MATHEMATICALLY agrees with worldToScreen — not
//    just eyeballed. Independently compute where world point `p` lands
//    under (a) worldToScreen (input.ts's NORMATIVE formula) and (b) the
//    CSS semantics `scale(z) translate(x, y)` actually implements (CSS
//    composes a transform LIST by applying the RIGHTMOST function to the
//    point FIRST — see WorldLayer.tsx's header for the full derivation).
//    Both must agree, for more than one camera/point pair.
// ============================================================================
{
  function cssTransformPoint(camera: Camera, p: { x: number; y: number }): { x: number; y: number } {
    // translate() first (rightmost in "scale(z) translate(x,y)"), then scale().
    const translated = { x: p.x + camera.x, y: p.y + camera.y }
    return { x: translated.x * camera.z, y: translated.y * camera.z }
  }

  const cases: Array<{ camera: Camera; p: { x: number; y: number } }> = [
    { camera: { x: 10, y: -5, z: 2 }, p: { x: 30, y: 40 } },
    { camera: { x: 0, y: 0, z: 1 }, p: { x: 0, y: 0 } },
    { camera: { x: -100, y: 250, z: 0.5 }, p: { x: 400, y: -80 } },
  ]
  for (const { camera, p } of cases) {
    const viaWorldToScreen = worldToScreen(camera, p)
    const viaCss = cssTransformPoint(camera, p)
    assert.deepEqual(viaCss, viaWorldToScreen, `CSS semantics vs worldToScreen for camera=${JSON.stringify(camera)} p=${JSON.stringify(p)}`)
  }
  console.log('ok: CSS transform semantics agree with worldToScreen (not just the string — the actual point math)')
}

// ============================================================================
// 3. WorldLayer actually renders `cameraTransform(camera)` into its style —
//    the pure function isn't just floating unused next to the component.
// ============================================================================
{
  const camera: Camera = { x: 12, y: 34, z: 1.5 }
  const html = renderToStaticMarkup(createElement(WorldLayer, { camera }))
  assert.ok(html.includes(cameraTransform(camera)), `rendered WorldLayer HTML should contain "${cameraTransform(camera)}": ${html}`)
  assert.match(html, /data-canvas-layer="world"/)
  console.log('ok: WorldLayer renders the exact cameraTransform string')
}

// ============================================================================
// 4. Grid's background-size/position track the camera by the same
//    worldToScreen-derived formula (world origin (0,0) lands at
//    (camera.x*z, camera.y*z) on screen; dot pitch scales by z) —
//    independently recomputed here, not copy-pasted from Grid.tsx.
// ============================================================================
{
  const camera: Camera = { x: 7, y: -3, z: 2 }
  const html = renderToStaticMarkup(createElement(Grid, { camera }))
  const originOnScreen = worldToScreen(camera, { x: 0, y: 0 })
  assert.ok(html.includes(`${originOnScreen.x}px ${originOnScreen.y}px`), `Grid background-position should place the world origin at ${JSON.stringify(originOnScreen)}: ${html}`)
  console.log('ok: Grid background-position tracks worldToScreen(camera, origin)')
}

// ============================================================================
// 5. dom-events mappers: fabricated structural events (plain objects — no
//    real DOM class), including a NONZERO getBoundingClientRect-style
//    offset, map to EXACT InputEvents.
// ============================================================================
{
  const rect: RectLike = { left: 50, top: 20 } // nonzero viewport offset
  const pointerEvent: PointerEventLike = {
    type: 'pointerdown', clientX: 150, clientY: 220, buttons: 1,
    shiftKey: false, altKey: false, ctrlKey: true, metaKey: false, timeStamp: 12345,
  }
  assert.deepEqual(
    pointerEventToInput(pointerEvent, rect),
    { type: 'pointerdown', x: 100, y: 200, buttons: 1, modifiers: { shift: false, alt: false, ctrl: true, meta: false }, t: 12345 },
    'pointerEventToInput subtracts the viewport rect offset and carries buttons/modifiers/t verbatim',
  )

  const wheelEvent: WheelEventLike = {
    clientX: 110, clientY: 70, deltaX: 5, deltaY: -3,
    shiftKey: true, altKey: false, ctrlKey: false, metaKey: false, timeStamp: 999,
  }
  assert.deepEqual(
    wheelEventToInput(wheelEvent, rect),
    { type: 'wheel', x: 60, y: 50, dx: 5, dy: -3, modifiers: { shift: true, alt: false, ctrl: false, meta: false }, t: 999 },
    'wheelEventToInput subtracts the viewport rect offset and carries dx/dy UNCHANGED (no re-signing)',
  )

  const keyEvent: KeyEventLike = {
    type: 'keydown', key: 'a', shiftKey: false, altKey: false, ctrlKey: false, metaKey: true, timeStamp: 42,
  }
  assert.deepEqual(
    keyEventToInput(keyEvent),
    { type: 'keydown', key: 'a', modifiers: { shift: false, alt: false, ctrl: false, meta: true }, t: 42 },
    'keyEventToInput carries key/modifiers/t verbatim (no coordinates to offset)',
  )

  console.log('ok: dom-events mappers — exact InputEvents from fabricated structural events, including a nonzero rect offset')
}

console.log('ok: viewport (transform string, worldToScreen agreement, WorldLayer/Grid rendering, dom-events mappers)')
