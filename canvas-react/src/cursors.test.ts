// Run: bun src/cursors.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header) with React.createElement, hence `.test.ts` not
// `.test.tsx`.
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { worldToScreen, type Camera } from '@ensembleworks/canvas-editor'
import { colorForKey, Cursors, type RemotePresence } from './overlay/Cursors.js'

const camera: Camera = { x: 10, y: -5, z: 2 }
const viewportSize = { width: 800, height: 600 }

// Fixture guard: every cursor that a test EXPECTS to be suppressed by the
// SELF-FILTER (not by the off-viewport guard) must itself land on-screen —
// otherwise the off-viewport omission would mask a deleted filter and the
// self-exclusion assertion would pass vacuously (exactly the defect the
// first version of this file shipped: self at world (0,0) under this camera
// maps to screen (20,-10), y < 0, off-viewport — so the isOnScreen guard
// suppressed it with or without the filter). Each fixture below asserts its
// own on-screen-ness FIRST, so a future camera/fixture edit that silently
// re-voids the test fails loudly here instead.
function assertOnScreen(label: string, world: { x: number; y: number }): { x: number; y: number } {
  const s = worldToScreen(camera, world)
  assert.ok(
    s.x >= 0 && s.x <= viewportSize.width && s.y >= 0 && s.y <= viewportSize.height,
    `FIXTURE BUG: ${label} at world (${world.x},${world.y}) maps to screen (${s.x},${s.y}) — OFF-viewport, so this test would not exercise the self-filter`,
  )
  return s
}

// ============================================================================
// 1. Self-filtering (GENUINELY RED-VERIFIED — see procedure below): a
//    presence map INCLUDING a self entry whose cursor is asserted-on-screen —
//    the self entry must be ABSENT from the rendered output; the other two
//    peers render at their hand-computed on-screen positions (each fixture
//    point self-checked via assertOnScreen, so the off-viewport guard cannot
//    be what suppresses `self`).
//
//    RED-VERIFICATION PROCEDURE (re-done for real after review caught the
//    first version's vacuous fixture): with self at world (50,50) —
//    screen (120,90), on-screen — the `key !== selfKey` filter in
//    Cursors.tsx was deleted and this file re-run: the
//    "selfKey entry must be absent" assertion FAILED (self rendered its
//    data-presence-key="self" node); the filter was restored and the file
//    went green again. The earlier fixture (self at world (0,0) -> screen
//    (20,-10), off-viewport) did NOT catch the deleted filter — the
//    assertOnScreen guard above exists so that regression class can't
//    silently return.
// ============================================================================
{
  const selfWorld = { x: 50, y: 50 }
  const selfScreen = assertOnScreen('self', selfWorld) // screen (120, 90)
  const expectedA = assertOnScreen('peerA', { x: 100, y: 50 }) // screen (220, 90)
  const expectedB = assertOnScreen('peerB', { x: 20, y: 30 }) // screen (60, 50)

  const presence: Record<string, RemotePresence> = {
    self: { cursor: selfWorld, name: 'Me' },
    peerA: { cursor: { x: 100, y: 50 }, name: 'Alice' },
    peerB: { cursor: { x: 20, y: 30 }, name: 'Bob' },
  }
  const html = renderToStaticMarkup(createElement(Cursors, { presence, selfKey: 'self', camera, viewportSize }))

  assert.doesNotMatch(html, /data-presence-key="self"/, 'the selfKey entry must be absent from the rendered output')
  assert.doesNotMatch(html, />Me</, 'the self entry\'s name must not appear anywhere')
  assert.ok(!html.includes(`${selfScreen.x},${selfScreen.y}`), `self's would-be glyph anchor (${selfScreen.x},${selfScreen.y}) must not appear — it can only come from an unfiltered self render`)

  assert.ok(html.includes(`data-presence-key="peerA"`), 'peerA should render')
  assert.ok(html.includes(`${expectedA.x},${expectedA.y}`), `peerA's cursor glyph should be anchored at (${expectedA.x},${expectedA.y}): ${html}`)
  assert.ok(html.includes(`data-presence-key="peerB"`), 'peerB should render')
  assert.ok(html.includes(`${expectedB.x},${expectedB.y}`), `peerB's cursor glyph should be anchored at (${expectedB.x},${expectedB.y}): ${html}`)
  console.log('ok: Cursors — self entry filtered out (red-verified against an ON-SCREEN self cursor), other peers render at hand-computed positions')
}

// ============================================================================
// 2. Null-cursor peer: a presence entry with cursor: null is simply absent
//    (no published/expired cursor), never a crash or a stray glyph at (0,0).
//    The self entry here is ALSO on-screen (assertOnScreen), so the "no
//    cursor glyph at all" assertion doubles as a second filter probe: an
//    unfiltered self would render a glyph and fail it.
// ============================================================================
{
  const selfWorld = { x: 50, y: 50 }
  assertOnScreen('self (test 2)', selfWorld)
  const presence: Record<string, RemotePresence> = {
    self: { cursor: selfWorld },
    peerNone: { cursor: null, name: 'Ghost' },
  }
  const html = renderToStaticMarkup(createElement(Cursors, { presence, selfKey: 'self', camera, viewportSize }))
  assert.doesNotMatch(html, /data-overlay="cursor"/, 'a null-cursor peer (and the filtered, ON-SCREEN self entry) renders no cursor glyph at all')
  assert.doesNotMatch(html, />Ghost</, 'the null-cursor peer\'s name never appears either — no glyph means no label')
  console.log('ok: Cursors — null-cursor peer renders nothing')
}

// ============================================================================
// 3. Deterministic color: the SAME key produces the SAME color across
//    repeated calls and across renders (no color prop supplied — falls back
//    to colorForKey(key)); two different keys are not asserted to differ
//    (a hash may collide) but the SAME key must be perfectly stable.
// ============================================================================
{
  const c1 = colorForKey('peer-xyz')
  const c2 = colorForKey('peer-xyz')
  assert.equal(c1, c2, 'colorForKey is a pure function of its input — repeated calls agree')

  const presence: Record<string, RemotePresence> = { peerC: { cursor: { x: 5, y: 10 } } }
  const htmlOnce = renderToStaticMarkup(createElement(Cursors, { presence, selfKey: 'self', camera, viewportSize }))
  const htmlTwice = renderToStaticMarkup(createElement(Cursors, { presence, selfKey: 'self', camera, viewportSize }))
  assert.equal(htmlOnce, htmlTwice, 'rendering the same presence map twice (no explicit color) yields byte-identical output — the color is deterministic across renders')
  assert.ok(htmlOnce.includes(`fill="${colorForKey('peerC')}"`), `peerC's glyph should use colorForKey('peerC'): ${htmlOnce}`)
  console.log('ok: Cursors — deterministic color assignment (same key -> same color, stable across renders)')
}

// ============================================================================
// 4. An explicit `color` on a peer OVERRIDES the hash-derived default.
// ============================================================================
{
  const presence: Record<string, RemotePresence> = { peerD: { cursor: { x: 5, y: 5 }, color: '#123456' } }
  const html = renderToStaticMarkup(createElement(Cursors, { presence, selfKey: 'self', camera, viewportSize }))
  assert.ok(html.includes('fill="#123456"'), `explicit color should override colorForKey: ${html}`)
  console.log('ok: Cursors — explicit color overrides the deterministic default')
}

// ============================================================================
// 5. Off-viewport cursors are OMITTED (not clamped) — a peer whose world
//    cursor lands far outside [0,width]x[0,height] under this camera.
// ============================================================================
{
  const presence: Record<string, RemotePresence> = {
    inView: { cursor: { x: 50, y: 50 } },
    farAway: { cursor: { x: 1_000_000, y: 1_000_000 } },
  }
  const html = renderToStaticMarkup(createElement(Cursors, { presence, selfKey: 'self', camera, viewportSize }))
  assert.ok(html.includes(`data-presence-key="inView"`), 'the in-viewport peer should render')
  assert.doesNotMatch(html, /data-presence-key="farAway"/, 'the off-viewport peer should be OMITTED entirely')
  console.log('ok: Cursors — off-viewport cursor omitted (v1 policy, no edge-clamp indicator)')
}

console.log('ok: cursors (self-filtered, null-cursor omission, deterministic color, off-viewport omission)')
