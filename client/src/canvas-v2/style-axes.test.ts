// Run: bun src/canvas-v2/style-axes.test.ts
// Task P1 (docs/plans/2026-07-21-canvas-v2-styling.md) — pure unit tests for
// style-axes.ts's relevance (`relevantAxes`) and current-value (`currentValue`)
// helpers. No DOM/React: shapes are plain `Shape` object literals.
import assert from 'node:assert/strict'
import { STYLE_VALUE_SETS as MODEL_STYLE_VALUE_SETS, type Shape } from '@ensembleworks/canvas-model'
import { currentValue, relevantAxes, STYLE_VALUE_SETS } from './style-axes.js'

function shape(overrides: Partial<Shape> & Pick<Shape, 'kind'>): Shape {
  return {
    id: 'shape:s1',
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

const note = (props: Record<string, unknown> = {}, extra: Partial<Shape> = {}) =>
  shape({ kind: 'note', props, ...extra })
const geo = (props: Record<string, unknown> = {}, extra: Partial<Shape> = {}) =>
  shape({ kind: 'geo', props, ...extra })

// ============================================================================
// 1. relevantAxes — relevance is the UNION of selected kinds' supported axes.
//    A note-only selection never surfaces geo-only axes (fill/dash/geo); a
//    geo-only selection does. A [note, geo] selection is the union of both —
//    this is the row that kills an "intersection instead of union" mutant,
//    because 'fill'/'dash'/'geo' are geo-exclusive (not in note's row), so an
//    intersection implementation would DROP them from a mixed selection even
//    though the geo shape genuinely supports them.
// ============================================================================
{
  const axes = relevantAxes([note()])
  assert.ok(axes.includes('color') && axes.includes('size') && axes.includes('font') && axes.includes('align'))
  assert.ok(!axes.includes('fill'), 'note-only selection must not surface the geo-only fill axis')
  assert.ok(!axes.includes('dash'), 'note-only selection must not surface the geo-only dash axis')
  assert.ok(!axes.includes('geo'), 'note-only selection must not surface the geo-variant axis')
  console.log('ok: relevantAxes([note]) excludes geo-only axes')
}
{
  const axes = relevantAxes([geo()])
  assert.ok(axes.includes('fill') && axes.includes('dash') && axes.includes('geo'))
  console.log('ok: relevantAxes([geo]) includes fill/dash/geo')
}
{
  // MUTANT KILL: intersection(note, geo) would be exactly note's row minus
  // geo-exclusive axes (since note's axes are a subset of geo's on the
  // shared names) -- i.e. it would equal relevantAxes([note]) and NEVER
  // include 'fill'/'dash'/'geo'. Union must include them.
  const axes = relevantAxes([note(), geo()])
  assert.ok(axes.includes('fill'), 'MUTANT: union([note,geo]) must include geo-exclusive fill axis')
  assert.ok(axes.includes('dash'), 'MUTANT: union([note,geo]) must include geo-exclusive dash axis')
  assert.ok(axes.includes('geo'), 'MUTANT: union([note,geo]) must include geo-exclusive geo axis')
  assert.ok(axes.includes('color'), 'union must still include axes both kinds share')
  console.log('ok: relevantAxes([note, geo]) is the union of both kinds axes (mutant: intersection killed)')
}
{
  assert.deepEqual(relevantAxes([]), [], 'empty selection -> no axes')
  console.log('ok: relevantAxes([]) === []')
}
{
  // opacity is envelope-level -- every kind, including a bare note, offers it.
  assert.ok(relevantAxes([note()]).includes('opacity'), 'opacity is relevant for any non-empty selection')
  console.log('ok: relevantAxes includes opacity for a plain note')
}

// ============================================================================
// 2. currentValue -- mixed vs shared vs unset.
// ============================================================================
{
  const blueNote = note({ color: 'blue' })
  assert.equal(currentValue([blueNote, blueNote], 'color'), 'blue', 'two agreeing shapes -> that shared value')
  console.log('ok: currentValue -- agreeing selection reports the shared color')
}
{
  // MUTANT KILL: an implementation that returns shapes[0]'s value while
  // ignoring divergence would report 'blue' here, not 'mixed'.
  const blueNote = note({ color: 'blue' })
  const redNote = note({ color: 'red' })
  const v = currentValue([blueNote, redNote], 'color')
  assert.equal(v, 'mixed', 'MUTANT: disagreeing selection must report the mixed sentinel, not the first shape value')
  assert.notEqual(v, 'blue', 'MUTANT: must not silently prefer the first shape')
  console.log('ok: currentValue -- disagreeing selection reports "mixed" (mutant: first-value-wins killed)')
}
{
  const bareNote = note({})
  assert.equal(currentValue([bareNote], 'color'), undefined, 'a shape with no color prop set reports undefined')
  console.log('ok: currentValue -- unset prop reports undefined')
}
{
  // opacity reads the ENVELOPE, not props -- this is the R1/E1 contract:
  // opacity is a top-level Shape field, never a props key.
  const dimNote = note({}, { opacity: 0.5 })
  assert.equal(currentValue([dimNote], 'opacity'), 0.5, 'opacity reads shape.opacity, not shape.props.opacity')
  console.log('ok: currentValue -- opacity axis reads the envelope field')
}
{
  // A props.opacity key (if one ever existed) must be ignored -- opacity is
  // never sourced from props.
  const trap = note({ opacity: 0.9 }, { opacity: 0.3 })
  assert.equal(currentValue([trap], 'opacity'), 0.3, 'a props.opacity decoy must not shadow the envelope value')
  console.log('ok: currentValue -- opacity ignores a props.opacity decoy key')
}

// ============================================================================
// 3. legacy align -- a shape carrying a `-legacy` align value maps to its
//    base value for panel display, matching R3's renderer-side
//    normalizeAlign (NoteShape.tsx / GeoShape.tsx render start-legacy
//    identically to start).
// ============================================================================
{
  const legacyNote = note({ align: 'start-legacy' })
  assert.equal(currentValue([legacyNote], 'align'), 'start', 'a -legacy align value normalizes to its base for the panel')
  console.log('ok: currentValue -- start-legacy align normalizes to start')
}
{
  // A legacy value and its already-normalized sibling should read as
  // AGREEING (they render identically), not mixed.
  const legacyNote = note({ align: 'start-legacy' })
  const plainNote = note({ align: 'start' })
  assert.equal(
    currentValue([legacyNote, plainNote], 'align'),
    'start',
    'a -legacy value and its base agree after normalization, not "mixed"'
  )
  console.log('ok: currentValue -- legacy + base align agree after normalization')
}

// ============================================================================
// 4. Task M3 -- style-axes.ts's value LISTS are sourced from
//    @ensembleworks/canvas-model's STYLE_VALUE_SETS, not re-typed local
//    literals. Every axis except `align` (deliberately narrowed to the three
//    primary, non-legacy options -- see ALIGN_PRIMARY in style-axes.ts) and
//    `opacity` (an envelope number, not a model enum) must be reference-equal
//    (same array object) or at minimum value-equal to the model's export --
//    proof that a future model enum edit reaches this file automatically.
// ============================================================================
{
  for (const axis of ['color', 'fill', 'dash', 'size', 'font', 'verticalAlign', 'textAlign', 'geo', 'arrowheadStart', 'arrowheadEnd'] as const) {
    assert.deepEqual(
      [...STYLE_VALUE_SETS[axis]],
      [...MODEL_STYLE_VALUE_SETS[axis]],
      `style-axes.ts's ${axis} value set matches canvas-model's STYLE_VALUE_SETS.${axis} exactly`,
    )
  }
  console.log('ok: style-axes STYLE_VALUE_SETS values match canvas-model STYLE_VALUE_SETS (single-sourced, no hand-copy)')
}
{
  // align is the one deliberate exception: the model accepts 6 (incl. 3
  // -legacy round-trip variants), the panel only offers the 3 primary ones,
  // but that 3 must be a subset of -- and derived from -- the model's 6, not
  // an independently hand-typed literal that happens to match today.
  assert.deepEqual([...STYLE_VALUE_SETS.align], ['start', 'middle', 'end'])
  for (const v of STYLE_VALUE_SETS.align) {
    assert.ok(MODEL_STYLE_VALUE_SETS.align.includes(v), `panel align option '${v}' must be a real model-accepted value`)
  }
  console.log('ok: style-axes align options are the non-legacy subset of canvas-model align values')
}

console.log('ok: style-axes -- all assertions passed')
