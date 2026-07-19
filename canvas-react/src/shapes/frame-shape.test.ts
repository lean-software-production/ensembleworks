// Run: bun src/shapes/frame-shape.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header for why) with React.createElement, not JSX, so
// this file stays `.test.ts` (same convention as note-shape.test.ts).
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import { FrameShape, frameLabel } from './FrameShape.js'

function frameShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:frame1',
    kind: 'frame',
    parentId: 'page:p',
    index: 'a1',
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {},
    ...overrides,
  } as Shape
}

// ============================================================================
// 1. frameLabel: props.name wins when present/non-blank; an absent or
//    whitespace-only name falls back to v1's literal "Frame" placeholder
//    (frameHelpers.ts's defaultEmptyAs — NOT label.ts's shared resolver,
//    which would fall through to the raw kind string "frame" — see
//    FrameShape.tsx's GROUNDING header, LABEL TEXT section).
// ============================================================================
{
  const named = frameShape({ props: { name: 'Design review' } })
  assert.equal(frameLabel(named), 'Design review', 'a named frame renders props.name verbatim')

  const missing = frameShape({ props: {} })
  assert.equal(frameLabel(missing), 'Frame', 'a frame with no name prop falls back to v1s literal "Frame" placeholder')

  const blank = frameShape({ props: { name: '   ' } })
  assert.equal(frameLabel(blank), 'Frame', 'a whitespace-only name is treated the same as an absent one')

  const empty = frameShape({ props: { name: '' } })
  assert.equal(frameLabel(empty), 'Frame', 'an explicitly empty-string name falls back the same way')
  console.log('ok: frameLabel — props.name wins, absent/blank falls back to v1s literal "Frame"')
}

// ============================================================================
// 2. Rendered header: the label text lands in a header element, tagged so a
//    consumer/test can find it, distinct from the frame's chrome body.
// ============================================================================
{
  const shape = frameShape({ props: { name: 'Sprint board' } })
  const html = renderToStaticMarkup(createElement(FrameShape, { shape, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(html.includes('data-shape-body="frame"'), 'FrameShape is tagged data-shape-body="frame"')
  assert.ok(html.includes('data-shape-frame-header'), 'the name label renders inside a dedicated header element')
  assert.ok(html.includes('Sprint board'), 'the header shows the frames name')
  console.log('ok: FrameShape — renders a header bar carrying props.name')
}

// ============================================================================
// 3. No children rendered — FrameShape is chrome-only. ShapeLayer renders
//    every shape (including a frame's children) as FLAT SIBLINGS inside
//    WorldLayer's one transformed container (ShapeBody.tsx's FLAT SIBLINGS
//    header); a frame body that DOM-nested its children would double-apply
//    the parent transform. FrameShape must not try to render any child-shape
//    DOM at all: it never reads `snapshot`, so there is no data path by which
//    it even COULD render a child.
// ============================================================================
{
  const shape = frameShape({ props: { name: 'Container' } })
  const html = renderToStaticMarkup(createElement(FrameShape, { shape, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(!html.includes('data-shape-id'), 'FrameShape renders no nested data-shape-id DOM — no child shape is DOM-nested inside it')
  assert.ok(!html.includes('data-shape-kind'), 'FrameShape renders no nested data-shape-kind DOM either')
  console.log('ok: FrameShape — chrome only, no DOM-nested children')
}

// ============================================================================
// 4. Rendered fill/border/header colors actually land in the DOM style (not
//    just asserted in the module header) — belt-and-suspenders against a
//    wiring slip, same pattern as note-shape.test.ts's test 5.
// ============================================================================
{
  const shape = frameShape({ props: { name: 'Chrome check' } })
  const html = renderToStaticMarkup(createElement(FrameShape, { shape, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(html.includes('#ffffff'), 'rendered frame body carries v1s frameFill (black-palette, light theme)')
  assert.ok(html.includes('#717171'), 'rendered frame body border carries v1s frameStroke')
  assert.ok(html.includes('#f9fafb'), 'rendered header carries v1s negativeSpace fill/border')
  console.log('ok: FrameShape — chrome colors actually reach the rendered DOM, not just the pure helper')
}

// ============================================================================
// 5. Header x-offset: with showColors off (this app's mode), v1 shifts the
//    header left of the frame's left edge by translateX(-7)
//    (FrameShapeUtil.tsx:284 offsetX, applied FrameHeading.tsx:69) — we
//    reproduce this as left:-7px. A flush left:0 would register as a ~7px
//    diff in the Seam F screenshot parity harness.
// ============================================================================
{
  const shape = frameShape({ props: { name: 'Offset check' } })
  const html = renderToStaticMarkup(createElement(FrameShape, { shape, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(html.includes('left:-7px'), 'rendered header is shifted left by v1s -7px offset (showColors off), not flush at 0')
  console.log('ok: FrameShape — header carries v1s -7px left offset (parity)')
}

console.log('ok: frame-shape (label from props.name with v1s "Frame" fallback, chrome-only body, no DOM-nested children)')
