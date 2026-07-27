// Run: bun src/shapes/note-shape.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header for why) with React.createElement, not JSX, so
// this file stays `.test.ts` (same convention as shape-layer.test.ts).
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import { NoteShape, authorOf, noteStyle } from './NoteShape.js'

function noteShape(overrides: Partial<Shape> = {}): Shape {
  return {
    id: 'shape:note1',
    kind: 'note',
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
// 1. noteStyle: props.color -> v1's exact light-theme noteFill hex (see
//    NoteShape.tsx's GROUNDING header — copied verbatim from
//    @tldraw/editor's defaultThemes.ts). A couple of named colors plus the
//    'black'-default fallback for a missing/unrecognized color.
// ============================================================================
{
  const yellow = noteStyle(noteShape({ props: { color: 'yellow' } }))
  assert.equal(yellow.background, '#FED49A', 'yellow note.color maps to v1 noteFill #FED49A')

  const blue = noteStyle(noteShape({ props: { color: 'blue' } }))
  assert.equal(blue.background, '#8AA3FF', 'blue note.color maps to v1 noteFill #8AA3FF')

  const missing = noteStyle(noteShape({ props: {} }))
  assert.equal(missing.background, '#FCE19C', 'a note with no color prop defaults to v1s own default color (black -> #FCE19C), not an invented color')

  const unknown = noteStyle(noteShape({ props: { color: 'not-a-real-color' } }))
  assert.equal(unknown.background, '#FCE19C', 'an unrecognized color string falls back to the same default rather than rendering undefined')

  assert.equal(yellow.borderColor, 'rgb(144, 144, 144)', 'borderColor matches v1s theme.colors.light.noteBorder')
  assert.equal(yellow.color, '#000000', 'label text color matches v1s noteText (black in every light-theme color)')
  console.log('ok: noteStyle — v1-grounded color -> fill mapping, with a sane default for missing/unknown colors')
}

// ============================================================================
// 2. Handwriting font-family: every note gets v1's 'draw' font family
//    string, regardless of color.
// ============================================================================
{
  const style = noteStyle(noteShape({ props: { color: 'green' } }))
  assert.equal(style.fontFamily, "'tldraw_draw', sans-serif", 'font-family matches @tldraw/tlschemas DefaultFontFamilies.draw')
  console.log('ok: noteStyle — handwriting font-family matches v1s tldraw_draw family')
}

// ============================================================================
// 3. authorOf / the rendered badge: shape.meta.author is the confirmed key
//    (server/src/features/sticky.ts + shape.ts's `meta: { author: ... }` via
//    kernel/attribution.ts, passed through verbatim by
//    server/src/canvas-v2/convert.ts). Present -> renders; absent (the real
//    e2e-seeded-note case, an anonymous write's meta is `{}`) -> no badge at
//    all, not a placeholder.
// ============================================================================
{
  const withAuthor = noteShape({ meta: { author: 'trevoke@gmail.com' }, props: { color: 'yellow' } })
  assert.equal(authorOf(withAuthor), 'trevoke@gmail.com', 'authorOf reads shape.meta.author')

  const anon = noteShape({ meta: {}, props: { color: 'yellow' } })
  assert.equal(authorOf(anon), null, 'authorOf is null when meta.author is absent (an anonymous-authored note, e.g. e2e seedGoldenBoard)')

  const htmlWithAuthor = renderToStaticMarkup(createElement(NoteShape, { shape: withAuthor, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(htmlWithAuthor.includes('data-shape-note-author'), 'a note with meta.author renders the author badge element')
  assert.ok(htmlWithAuthor.includes('trevoke@gmail.com'), 'the badge shows the exact meta.author string')

  const htmlAnon = renderToStaticMarkup(createElement(NoteShape, { shape: anon, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(!htmlAnon.includes('data-shape-note-author'), 'a note with no meta.author renders NO badge at all')
  console.log('ok: NoteShape — author badge sourced from shape.meta.author, absent gracefully when unset')
}

// ============================================================================
// 4. Label resolution: NoteShape uses the SAME shared resolver as BoxShape —
//    live getText wins first, then falls back down label.ts's chain.
// ============================================================================
{
  const shape = noteShape({ props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fallback text' }] }] } } })

  const withLiveText = renderToStaticMarkup(
    createElement(NoteShape, {
      shape,
      snapshot: undefined as any,
      editorState: undefined as any,
      getText: (id: string) => (id === shape.id ? 'live doc text wins' : ''),
    }),
  )
  assert.ok(withLiveText.includes('live doc text wins'), 'NoteShape renders LIVE getText content first')
  assert.ok(!withLiveText.includes('fallback text'), 'live text wins over richText fallback')

  const withoutLiveText = renderToStaticMarkup(
    createElement(NoteShape, { shape, snapshot: undefined as any, editorState: undefined as any, getText: () => '' }),
  )
  assert.ok(withoutLiveText.includes('fallback text'), 'with no live text, NoteShape falls back to the richText chain (same as BoxShape)')
  console.log('ok: NoteShape — label comes from the shared label.ts resolver (live getText, then richText fallback)')
}

// ============================================================================
// 5. Rendered fill/font actually land in the DOM style (not just the pure
//    noteStyle function) — belt-and-suspenders against a wiring slip between
//    noteStyle and the component.
// ============================================================================
{
  const shape = noteShape({ props: { color: 'violet' } })
  const html = renderToStaticMarkup(createElement(NoteShape, { shape, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(html.includes('#DB91FD'), 'rendered note carries the violet noteFill as its background')
  assert.ok(html.includes('tldraw_draw'), 'rendered note carries the handwriting font-family')
  assert.ok(html.includes('data-shape-body="note"'), 'NoteShape is tagged data-shape-body="note"')
  console.log('ok: NoteShape — color/font actually reach the rendered DOM, not just the pure helper')
}

// ============================================================================
// 6. Task R3 — NoteShape honors props.align (DefaultHorizontalAlignStyle's
//    six values: start/middle/end + the three -legacy variants, default
//    'middle'). start -> left/flex-start; end -> right/flex-end; middle
//    (and absent) -> center/center — the pre-R3 always-centered default.
//    The -legacy variants MUST render identically to their base value — a
//    switch that only handles the 3 primary values and defaults -legacy
//    ones to center would mis-render a legacy note.
// ============================================================================
{
  const noteDiv = (html: string) => {
    const m = html.match(/<div data-shape-body="note" style="([^"]*)"/)
    return m ? m[1] : null
  }
  const render = (align: string | undefined) =>
    renderToStaticMarkup(
      createElement(NoteShape, {
        shape: noteShape({ props: align === undefined ? {} : { align } }),
        snapshot: undefined as any,
        editorState: undefined as any,
        getText: () => 'hi',
      }),
    )

  const start = noteDiv(render('start'))
  assert.ok(start, `expected a note body div in: ${render('start')}`)
  assert.match(start!, /text-align:left/, `align:'start' should render text-align:left, got: ${start}`)
  assert.match(start!, /justify-content:flex-start/, `align:'start' should render justify-content:flex-start, got: ${start}`)

  const end = noteDiv(render('end'))
  assert.match(end!, /text-align:right/, `align:'end' should render text-align:right, got: ${end}`)
  assert.match(end!, /justify-content:flex-end/, `align:'end' should render justify-content:flex-end, got: ${end}`)

  const middle = noteDiv(render('middle'))
  assert.match(middle!, /text-align:center/, `align:'middle' should render text-align:center, got: ${middle}`)
  assert.match(middle!, /justify-content:center/, `align:'middle' should render justify-content:center, got: ${middle}`)

  const absent = noteDiv(render(undefined))
  assert.match(absent!, /text-align:center/, `an absent align prop defaults to v1's own default (middle) -> center, got: ${absent}`)
  assert.match(absent!, /justify-content:center/, `an absent align prop defaults to center, got: ${absent}`)

  const startLegacy = noteDiv(render('start-legacy'))
  assert.match(startLegacy!, /text-align:left/, `align:'start-legacy' must render IDENTICALLY to 'start' (left), got: ${startLegacy}`)
  assert.match(startLegacy!, /justify-content:flex-start/, `align:'start-legacy' must render IDENTICALLY to 'start' (flex-start), got: ${startLegacy}`)

  const endLegacy = noteDiv(render('end-legacy'))
  assert.match(endLegacy!, /text-align:right/, `align:'end-legacy' must render IDENTICALLY to 'end' (right), got: ${endLegacy}`)
  assert.match(endLegacy!, /justify-content:flex-end/, `align:'end-legacy' must render IDENTICALLY to 'end' (flex-end), got: ${endLegacy}`)

  const middleLegacy = noteDiv(render('middle-legacy'))
  assert.match(middleLegacy!, /text-align:center/, `align:'middle-legacy' must render IDENTICALLY to 'middle' (center), got: ${middleLegacy}`)
  assert.match(middleLegacy!, /justify-content:center/, `align:'middle-legacy' must render IDENTICALLY to 'middle' (center), got: ${middleLegacy}`)

  console.log('ok: NoteShape — props.align honored (start/middle/end + -legacy variants rendering identically to their base), default middle/center')
}

// ============================================================================
// 7. Task R3 — NoteShape honors props.verticalAlign (start/middle/end,
//    default 'middle'). start -> align-items:flex-start; end ->
//    align-items:flex-end; middle/absent -> align-items:center.
// ============================================================================
{
  const noteDiv = (html: string) => {
    const m = html.match(/<div data-shape-body="note" style="([^"]*)"/)
    return m ? m[1] : null
  }
  const render = (verticalAlign: string | undefined) =>
    renderToStaticMarkup(
      createElement(NoteShape, {
        shape: noteShape({ props: verticalAlign === undefined ? {} : { verticalAlign } }),
        snapshot: undefined as any,
        editorState: undefined as any,
        getText: () => 'hi',
      }),
    )

  const start = noteDiv(render('start'))
  assert.match(start!, /align-items:flex-start/, `verticalAlign:'start' should render align-items:flex-start, got: ${start}`)

  const end = noteDiv(render('end'))
  assert.match(end!, /align-items:flex-end/, `verticalAlign:'end' should render align-items:flex-end, got: ${end}`)

  const absent = noteDiv(render(undefined))
  assert.match(absent!, /align-items:center/, `an absent verticalAlign prop defaults to v1's own default (middle) -> center, got: ${absent}`)

  console.log('ok: NoteShape — props.verticalAlign honored (start/middle/end), default middle/center')
}

console.log('ok: note-shape (color -> v1 fill mapping, author badge from meta.author, handwriting font, shared label resolver, align)')
