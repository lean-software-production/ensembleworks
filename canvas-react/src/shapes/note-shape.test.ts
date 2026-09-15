// Run: bun src/shapes/note-shape.test.ts
// Component tests use renderToStaticMarkup (no DOM emulator — see
// viewport.test.ts's header for why) with React.createElement, not JSX, so
// this file stays `.test.ts` (same convention as shape-layer.test.ts).
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { NoteShape, authorOf, noteStyle, noteLabel, noteShadow } from './NoteShape.js'

function editorStateWith(overrides: Partial<EditorState> = {}): EditorState {
  return { camera: { x: 0, y: 0, z: 1 }, selection: new Set(), hover: null, editingId: null, editingRegion: null, nextShapeStyle: {}, currentPageId: 'page:p', ...overrides }
}

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
// 4. Label resolution: NoteShape's own `noteLabel` resolver — live getText
//    wins first, then falls back to richText (same ORDER as label.ts's
//    shared `labelOf`, but truncated before the props.name/kind-string
//    tail — see section 8 below for the empty case this truncation fixes).
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

// ============================================================================
// 8. EMPTY NOTE RENDERS NO LABEL TEXT (gap fix): a brand-new note (props: {},
//    no live text) must render NEITHER the literal kind string "note" NOR
//    any other placeholder — v1's RichTextLabel returns null when
//    `!isEditing && isEmpty`. noteLabel's own final fallback is '', never
//    shape.kind.
// ============================================================================
{
  const empty = noteShape({ props: {} })
  assert.equal(noteLabel(empty), '', 'noteLabel on a truly empty note is the empty string, never the kind string')
  assert.equal(noteLabel(empty, () => ''), '', 'an empty live-text accessor still resolves to the empty string')

  const html = renderToStaticMarkup(createElement(NoteShape, { shape: empty, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(!html.includes('>note<'), 'a brand-new empty note never renders the literal word "note" as its body text')
  console.log('ok: NoteShape — an empty note renders no label text at all, never the kind string')
}

// ============================================================================
// 9. LABEL FONT SIZE follows props.size (LABEL_FONT_SIZES s/m/l/xl ->
//    18/22/26/32px, default 'm' -> 22px) — previously hardcoded to 16px for
//    every note regardless of size.
// ============================================================================
{
  assert.equal(noteStyle(noteShape({ props: { size: 's' } })).fontSize, 18, "size:'s' -> 18px")
  assert.equal(noteStyle(noteShape({ props: { size: 'm' } })).fontSize, 22, "size:'m' -> 22px")
  assert.equal(noteStyle(noteShape({ props: { size: 'l' } })).fontSize, 26, "size:'l' -> 26px")
  assert.equal(noteStyle(noteShape({ props: { size: 'xl' } })).fontSize, 32, "size:'xl' -> 32px")
  assert.equal(noteStyle(noteShape({ props: {} })).fontSize, 22, 'an absent size prop defaults to m -> 22px')
  assert.equal(noteStyle(noteShape({ props: { size: 'not-a-real-size' } })).fontSize, 22, 'an unrecognized size falls back to the default (22px), not undefined')

  const html = renderToStaticMarkup(
    createElement(NoteShape, { shape: noteShape({ props: { size: 'xl' } }), snapshot: undefined as any, editorState: undefined as any, getText: () => 'hi' }),
  )
  assert.ok(html.includes('font-size:32px'), `an xl note should render at 32px, got: ${html}`)
  console.log('ok: NoteShape — label font size follows props.size (18/22/26/32px), not a fixed 16px')
}

// ============================================================================
// 10. `font` style axis (draw/sans/serif/mono) — previously hardcoded to
//     the handwriting family for every note regardless of props.font.
// ============================================================================
{
  assert.equal(noteStyle(noteShape({ props: { font: 'sans' } })).fontFamily, "'tldraw_sans', sans-serif", "font:'sans'")
  assert.equal(noteStyle(noteShape({ props: { font: 'serif' } })).fontFamily, "'tldraw_serif', serif", "font:'serif'")
  assert.equal(noteStyle(noteShape({ props: { font: 'mono' } })).fontFamily, "'tldraw_mono', monospace", "font:'mono'")
  assert.equal(noteStyle(noteShape({ props: {} })).fontFamily, "'tldraw_draw', sans-serif", 'an absent font prop defaults to draw (unchanged)')
  console.log('ok: NoteShape — props.font picks any of the four families, not just the hardcoded handwriting one')
}

// ============================================================================
// 11. MULTI-LINE labels: a note's label must preserve newlines (a textarea
//     happily accepts Enter — TextEditor.tsx — but the body previously had
//     no `white-space` override, so the browser's default `normal` would
//     collapse them on blur).
// ============================================================================
{
  const html = renderToStaticMarkup(
    createElement(NoteShape, {
      shape: noteShape({ props: {} }),
      snapshot: undefined as any,
      editorState: undefined as any,
      getText: () => 'line one\nline two',
    }),
  )
  assert.ok(html.includes('white-space:pre-wrap'), `note body should set white-space:pre-wrap so newlines survive, got: ${html}`)
  assert.ok(html.includes('line one\nline two'), 'the literal newline character reaches the rendered markup')
  console.log('ok: NoteShape — white-space:pre-wrap so multi-line labels survive')
}

// ============================================================================
// 12. STATIC LABEL HIDDEN WHILE EDITING: while `editorState.editingId` is
//     this shape's id, the body must not render its own copy of the label
//     text — TextEditor.tsx's sibling textarea overlay is the only visible
//     copy. Not editing (a different id, or null/absent editorState) still
//     renders the label as before.
// ============================================================================
{
  const shape = noteShape({ props: {} })
  const editingHtml = renderToStaticMarkup(
    createElement(NoteShape, { shape, snapshot: undefined as any, editorState: editorStateWith({ editingId: shape.id }), getText: () => 'hello' }),
  )
  assert.ok(!editingHtml.includes('hello'), `NoteShape must not render its own label text while this shape is being edited, got: ${editingHtml}`)

  const notEditingHtml = renderToStaticMarkup(
    createElement(NoteShape, { shape, snapshot: undefined as any, editorState: editorStateWith({ editingId: 'shape:someone-else' }), getText: () => 'hello' }),
  )
  assert.ok(notEditingHtml.includes('hello'), 'a different shape being edited must not hide THIS note\'s label')

  const noEditorStateHtml = renderToStaticMarkup(
    createElement(NoteShape, { shape, snapshot: undefined as any, editorState: undefined as any, getText: () => 'hello' }),
  )
  assert.ok(noEditorStateHtml.includes('hello'), 'an absent editorState (most fixtures/goldens) renders the label normally')
  console.log('ok: NoteShape — static label hidden while this shape is being edited, shown otherwise')
}

// ============================================================================
// 13. DROP SHADOW / ROUNDED CORNER / ZOOM-DEPENDENT BORDER: at a normal zoom
//     (camera.z >= 0.25) a note renders a seeded box-shadow + 1px border-
//     radius, no flat border. Zoomed out below the threshold, it falls back
//     to the cheap flat borderBottom (v1's own degraded state) with no
//     shadow. The shadow must be a PURE function of shape.id (deterministic,
//     no Math.random) so the same note always renders identically.
// ============================================================================
{
  const shape = noteShape({ id: 'shape:shadow-note' })
  const zoomedIn = renderToStaticMarkup(
    createElement(NoteShape, { shape, snapshot: undefined as any, editorState: editorStateWith({ camera: { x: 0, y: 0, z: 1 } }) }),
  )
  assert.ok(zoomedIn.includes('box-shadow'), `at normal zoom, a note should render a box-shadow, got: ${zoomedIn}`)
  assert.ok(zoomedIn.includes('border-radius:1px'), `a note should render v1's 1px border-radius, got: ${zoomedIn}`)

  const zoomedOut = renderToStaticMarkup(
    createElement(NoteShape, { shape, snapshot: undefined as any, editorState: editorStateWith({ camera: { x: 0, y: 0, z: 0.1 } }) }),
  )
  assert.ok(zoomedOut.includes('border-bottom'), `zoomed out below 0.25, a note should fall back to the flat borderBottom, got: ${zoomedOut}`)
  assert.ok(!zoomedOut.includes('box-shadow:0px'), `zoomed out below 0.25, no seeded box-shadow value should render, got: ${zoomedOut}`)
  assert.ok(zoomedOut.includes('2px solid'), `the zoomed-out fallback is v1's cheap 2px border, got: ${zoomedOut}`)

  const noEditorState = renderToStaticMarkup(createElement(NoteShape, { shape, snapshot: undefined as any, editorState: undefined as any }))
  assert.ok(noEditorState.includes('box-shadow'), 'an absent editorState defaults to zoomed-in-enough (shadow), not the degraded fallback')

  assert.equal(noteShadow('shape:a', 0), noteShadow('shape:a', 0), 'noteShadow is a pure, deterministic function of (id, rotation)')
  assert.notEqual(noteShadow('shape:a', 0), noteShadow('shape:b', 0), 'different ids get different seeded shadows')
  console.log('ok: NoteShape — seeded drop shadow + border-radius at normal zoom, cheap flat border below the 0.25 zoom threshold')
}

console.log('ok: note-shape (color -> v1 fill mapping, author badge from meta.author, handwriting font, shared label resolver, align)')
