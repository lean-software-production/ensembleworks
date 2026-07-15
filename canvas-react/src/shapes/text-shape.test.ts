// Run: bun src/shapes/text-shape.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header for why) with React.createElement, not JSX, so
// this file stays `.test.ts` (same convention as note-shape.test.ts /
// frame-shape.test.ts).
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import { TextShape, textContent, textStyle } from './TextShape.js'

function textShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:text1',
    kind: 'text',
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
// 1. textStyle color: props.color -> v1's 'solid' variant per named color
//    (TextShape.tsx's GROUNDING header — NOT noteText/frameText; text uses
//    getColorValue(colors, color, 'solid')). Default 'black' -> #1d1d1d
//    (NOT '#000000' — that's notes' fixed noteText, a different variant).
// ============================================================================
{
  const black = textStyle(textShape({ props: {} }))
  assert.equal(black.color, '#1d1d1d', 'a text shape with no color prop defaults to v1s own default color (black), solid variant #1d1d1d')

  const blue = textStyle(textShape({ props: { color: 'blue' } }))
  assert.equal(blue.color, '#4465e9', 'blue text.color maps to v1s solid variant #4465e9')

  const red = textStyle(textShape({ props: { color: 'red' } }))
  assert.equal(red.color, '#e03131', 'red text.color maps to v1s solid variant #e03131')

  const unknown = textStyle(textShape({ props: { color: 'not-a-real-color' } }))
  assert.equal(unknown.color, '#1d1d1d', 'an unrecognized color string falls back to the default black solid rather than rendering undefined')
  console.log('ok: textStyle — v1-grounded color -> solid-variant mapping, with a sane default for missing/unknown colors')
}

// ============================================================================
// 2. textStyle font: props.font -> v1's DefaultFontFamilies, default 'draw'.
// ============================================================================
{
  const draw = textStyle(textShape({ props: {} }))
  assert.equal(draw.fontFamily, "'tldraw_draw', sans-serif", 'a text shape with no font prop defaults to v1s own default font (draw)')

  const mono = textStyle(textShape({ props: { font: 'mono' } }))
  assert.equal(mono.fontFamily, "'tldraw_mono', monospace", 'mono text.font maps to v1s DefaultFontFamilies.mono')

  const sans = textStyle(textShape({ props: { font: 'sans' } }))
  assert.equal(sans.fontFamily, "'tldraw_sans', sans-serif", 'sans text.font maps to v1s DefaultFontFamilies.sans')
  console.log('ok: textStyle — font -> v1s DefaultFontFamilies mapping')
}

// ============================================================================
// 3. textStyle size: props.size -> v1's text FONT_SIZES scale * theme.fontSize
//    (16), default 'm' -> 24px.
// ============================================================================
{
  const m = textStyle(textShape({ props: {} }))
  assert.equal(m.fontSize, 24, 'a text shape with no size prop defaults to v1s own default size (m) -> 24px (16 * 1.5)')

  const s = textStyle(textShape({ props: { size: 's' } }))
  assert.equal(s.fontSize, 18, 'size s -> 18px (16 * 1.125)')

  const l = textStyle(textShape({ props: { size: 'l' } }))
  assert.equal(l.fontSize, 36, 'size l -> 36px (16 * 2.25)')

  const xl = textStyle(textShape({ props: { size: 'xl' } }))
  assert.equal(xl.fontSize, 44, 'size xl -> 44px (16 * 2.75)')

  assert.equal(m.lineHeight, 1.35, 'lineHeight matches v1s theme.lineHeight')
  console.log('ok: textStyle — size -> v1s text FONT_SIZES scale, px values')
}

// ============================================================================
// 4. textStyle align: props.textAlign (NOT props.align — the real tldraw/
//    model field name) -> start/middle/end -> left/center/right, default
//    'start' -> 'left'.
// ============================================================================
{
  const start = textStyle(textShape({ props: {} }))
  assert.equal(start.textAlign, 'left', 'a text shape with no textAlign prop defaults to v1s own default (start) -> left')

  const middle = textStyle(textShape({ props: { textAlign: 'middle' } }))
  assert.equal(middle.textAlign, 'center', 'textAlign middle -> center')

  const end = textStyle(textShape({ props: { textAlign: 'end' } }))
  assert.equal(end.textAlign, 'right', 'textAlign end -> right')

  // A model-level `align` key (not `textAlign`) is NOT v1s real field name
  // and must be ignored, falling back to the default rather than being
  // silently accepted as an alias.
  const wrongKey = textStyle(textShape({ props: { align: 'end' } }))
  assert.equal(wrongKey.textAlign, 'left', 'a stray `align` prop (not `textAlign`) is ignored, not treated as an alias')
  console.log('ok: textStyle — textAlign -> left/center/right, with v1s real field name (not `align`)')
}

// ============================================================================
// 5. textContent: live getText wins first; falls back to flattened richText
//    when no live text; truly-empty (no live text, no richText) renders the
//    EMPTY STRING, never the shape's kind string ("text") — the empty-text
//    requirement this task exists to satisfy.
// ============================================================================
{
  const shape = textShape({ props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fallback text' }] }] } } })

  const withLiveText = textContent(shape, (id) => (id === shape.id ? 'live doc text wins' : ''))
  assert.equal(withLiveText, 'live doc text wins', 'textContent prefers LIVE getText content first')

  const withoutLiveText = textContent(shape, () => '')
  assert.equal(withoutLiveText, 'fallback text', 'with no live text, textContent falls back to the richText chain')

  const trulyEmpty = textContent(textShape({ props: {} }), () => '')
  assert.equal(trulyEmpty, '', 'a text shape with no live text and no richText renders the EMPTY STRING, never the "text" kind string')

  const noGetText = textContent(textShape({ props: {} }))
  assert.equal(noGetText, '', 'textContent with no getText accessor at all still renders empty, not the kind string')
  console.log('ok: textContent — live getText first, richText fallback, empty (never kind string) as the true-empty case')
}

// ============================================================================
// 6. Empty-text renders an EMPTY body in the actual component, NOT the
//    "text" kind-string label (see BoxShape/label.ts's kind-string tail —
//    this is the exact regression this task closes for the text kind).
// ============================================================================
{
  const empty = textShape({ props: {} })
  const html = renderToStaticMarkup(createElement(TextShape, { shape: empty, snapshot: undefined as any, editorState: undefined as any, getText: () => '' }))
  assert.ok(!html.includes('>text<'), 'an empty text shape never renders the literal kind string "text" as its body')
  assert.ok(html.includes('data-shape-body="text"'), 'TextShape is tagged data-shape-body="text"')
  console.log('ok: TextShape — empty text shape renders an empty body, not the "text" kind string')
}

// ============================================================================
// 7. Rendered style actually lands in the DOM (not just the pure textStyle
//    helper) — belt-and-suspenders against a wiring slip, same pattern as
//    note-shape.test.ts's test 5 / frame-shape.test.ts's test 4.
// ============================================================================
{
  const shape = textShape({ props: { color: 'green', font: 'mono', size: 'xl', textAlign: 'middle' } })
  const html = renderToStaticMarkup(createElement(TextShape, { shape, snapshot: undefined as any, editorState: undefined as any, getText: () => 'hello world' }))
  assert.ok(html.includes('#099268'), 'rendered text carries the green solid color')
  assert.ok(html.includes('tldraw_mono'), 'rendered text carries the mono font-family')
  assert.ok(html.includes('44'), 'rendered text carries the xl 44px font-size')
  assert.ok(html.includes('center'), 'rendered text carries the middle -> center alignment')
  assert.ok(html.includes('hello world'), 'rendered text shows the live text content')
  console.log('ok: TextShape — color/font/size/align actually reach the rendered DOM, not just the pure helper')
}

// ============================================================================
// 8. Background/border: a text shape is bare text — no box fill, no border
//    (confirmed against v1s TextShapeUtil.component(), which renders only a
//    RichTextLabel, no background rect at all — unlike NoteShape/FrameShape).
// ============================================================================
{
  const shape = textShape({ props: {} })
  const html = renderToStaticMarkup(createElement(TextShape, { shape, snapshot: undefined as any, editorState: undefined as any, getText: () => 'x' }))
  assert.ok(html.includes('background:transparent') || html.includes('background:rgba(0,0,0,0)'), 'TextShape renders a transparent background, no box fill')
  assert.ok(!html.includes('border:1px') && !html.includes('border-bottom'), 'TextShape renders no border/box chrome')
  console.log('ok: TextShape — transparent background, no border (bare text, no box)')
}

console.log('ok: text-shape (live text first with richText fallback, v1 font/size/color/align styling, transparent/borderless, empty renders empty)')
