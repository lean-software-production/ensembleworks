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

console.log('ok: note-shape (color -> v1 fill mapping, author badge from meta.author, handwriting font, shared label resolver)')
