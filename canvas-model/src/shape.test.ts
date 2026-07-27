// Run: bun src/shape.test.ts
import assert from 'node:assert/strict'
import {
  SHAPE_KINDS,
  TEXT_CAPABLE_KINDS,
  isTextCapableKind,
  shapeSchema,
  validateShape,
  plainText,
  STYLE_VALUE_SETS,
} from './shape.js'
import { validateAsset } from './document.js'

// Every kind the room can contain is enumerated (9 tldraw incl. group + image + 6 custom).
assert.deepEqual(
  [...SHAPE_KINDS].sort(),
  ['arrow','draw','file-viewer','frame','geo','group','highlight','iframe','image','line','neko','note','roadmap','screenshare','terminal','text'].sort(),
)

const note = {
  id: 'shape:n1', kind: 'note', parentId: 'page:p', index: 'a1',
  x: 10, y: 20, rotation: 0, isLocked: false, opacity: 1, meta: {},
  props: { color: 'yellow', richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } },
}
const r = validateShape(note)
assert.equal(r.ok, true)
assert.equal(plainText(note as any), 'hi')

// Unknown props survive (lossless passthrough).
const kept = shapeSchema.parse({ ...note, props: { ...note.props, growY: 7, mystery: 'x' } })
assert.equal((kept.props as any).growY, 7)
assert.equal((kept.props as any).mystery, 'x')

// Bad envelope is rejected with a typed error, never thrown past validateShape.
const bad = validateShape({ ...note, id: 'nope', kind: 'note' })
assert.equal(bad.ok, false)

// Bad per-kind props are rejected too (the superRefine branch): a typed field
// with the wrong type fails validation even though the envelope is fine.
const badProps = validateShape({ ...note, props: { color: 123 } })
assert.equal(badProps.ok, false)
// isTextCapableKind: exactly note/text/geo -- not frame, not any embed kind,
// not any structural kind.
assert.deepEqual([...TEXT_CAPABLE_KINDS].sort(), ['geo', 'note', 'text'])
for (const k of TEXT_CAPABLE_KINDS) assert.equal(isTextCapableKind(k), true, `${k} is text-capable`)
for (const k of SHAPE_KINDS) {
  if ((TEXT_CAPABLE_KINDS as readonly string[]).includes(k)) continue
  assert.equal(isTextCapableKind(k), false, `${k} is NOT text-capable`)
}
console.log('ok: shape schema')

// Task M1 — `color` tightens from `z.string()` to a tldraw-parity enum.
function noteWith(props: Record<string, unknown>) {
  return { ...note, props: { ...note.props, ...props } }
}

// a real palette color validates on a note
assert.ok(validateShape(noteWith({ color: 'blue' })).ok, 'a real tldraw color validates')
// a junk color is now REJECTED (this is the behavior change M1 introduces)
assert.ok(!validateShape(noteWith({ color: 'chartreuse' })).ok, 'a non-tldraw color is rejected')
// unknown NON-style keys still pass through (looseObject preserved)
assert.ok(validateShape(noteWith({ color: 'blue', wobble: 7 })).ok, 'unknown passthrough keys still pass')
// every tldraw color name validates (GUARD, not the killing RED -- z.string()
// would also pass this before M1; kept to catch a missing-value mutant)
for (const c of [
  'black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow',
  'orange', 'green', 'light-green', 'light-red', 'red', 'white',
]) {
  assert.ok(validateShape(noteWith({ color: c })).ok, `tldraw color '${c}' validates`)
}
console.log('ok: color enum (M1)')

// Task M2 -- the remaining style enums (fill/dash/size/font/align/
// verticalAlign/textAlign/geo/arrowheadStart/arrowheadEnd) + the shared
// styleProps(...) fragment builder.
function geoWith(props: Record<string, unknown>) {
  return { ...note, kind: 'geo', props: { ...props } }
}
function arrowWith(props: Record<string, unknown>) {
  return { ...note, kind: 'arrow', props: { ...props } }
}
function textWith(props: Record<string, unknown>) {
  return { ...note, kind: 'text', props: { ...props } }
}

// accept a real value, reject junk -- one representative pair per axis.
assert.ok(validateShape(geoWith({ fill: 'solid' })).ok, 'real fill validates')
assert.ok(!validateShape(geoWith({ fill: 'plaid' })).ok, 'junk fill is rejected')
assert.ok(validateShape(geoWith({ dash: 'dotted' })).ok, 'real dash validates')
assert.ok(!validateShape(geoWith({ dash: 'wiggly' })).ok, 'junk dash is rejected')
assert.ok(
  validateShape(geoWith({ size: 'xl', font: 'mono', align: 'end', geo: 'ellipse' })).ok,
  'real size/font/align/geo combo validates',
)
assert.ok(!validateShape(geoWith({ size: 'enormous' })).ok, 'junk size is rejected')
assert.ok(!validateShape(geoWith({ font: 'comic-sans' })).ok, 'junk font is rejected')
assert.ok(!validateShape(geoWith({ align: 'sideways' })).ok, 'junk align is rejected')
assert.ok(!validateShape(geoWith({ geo: 'blob' })).ok, 'junk geo variant is rejected')
assert.ok(validateShape(geoWith({ verticalAlign: 'start' })).ok, 'real verticalAlign validates')
assert.ok(!validateShape(geoWith({ verticalAlign: 'top' })).ok, 'junk verticalAlign is rejected')
assert.ok(validateShape(textWith({ textAlign: 'end' })).ok, 'real textAlign validates')
assert.ok(!validateShape(textWith({ textAlign: 'justify' })).ok, 'junk textAlign is rejected')
assert.ok(
  validateShape(arrowWith({ arrowheadStart: 'triangle', arrowheadEnd: 'none' })).ok,
  'real arrowhead pair validates',
)
assert.ok(!validateShape(arrowWith({ arrowheadEnd: 'grappling-hook' })).ok, 'junk arrowheadEnd is rejected')
assert.ok(!validateShape(arrowWith({ arrowheadStart: 'grappling-hook' })).ok, 'junk arrowheadStart is rejected')

// a kind that does NOT support an axis ignores it as a passthrough key
// (text has no `geo` axis -- must NOT reject, still loose passthrough).
assert.ok(validateShape(textWith({ geo: 'ellipse' })).ok, 'text has no geo axis; passes through loose')

// GUARD rows -- every tldraw value for a sampled axis validates (catches a
// missing-value mutant even though z.string() would also pass these).
for (const f of ['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill']) {
  assert.ok(validateShape(geoWith({ fill: f })).ok, `tldraw fill '${f}' validates`)
}
for (const d of ['draw', 'solid', 'dashed', 'dotted', 'none']) {
  assert.ok(validateShape(geoWith({ dash: d })).ok, `tldraw dash '${d}' validates`)
}
for (const a of ['start', 'middle', 'end', 'start-legacy', 'end-legacy', 'middle-legacy']) {
  assert.ok(validateShape(geoWith({ align: a })).ok, `tldraw align '${a}' validates`)
}
for (const h of ['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none']) {
  assert.ok(validateShape(arrowWith({ arrowheadStart: h })).ok, `tldraw arrowhead '${h}' validates`)
}

// The looseObject tension: a KNOWN style key with a BAD value rejects, but
// UNKNOWN keys on the SAME shape still pass through losslessly.
const mixed = geoWith({ fill: 'solid', totallyUnknownProp: 42 })
assert.ok(validateShape(mixed).ok, 'unknown non-style key survives alongside a valid style key')
const parsed = shapeSchema.parse(mixed)
assert.equal((parsed.props as any).totallyUnknownProp, 42, 'unknown key value is preserved verbatim')

console.log('ok: remaining style enums (M2)')

// Task M3 -- STYLE_VALUE_SETS is a UI-consumable export of the SAME accepted
// values STYLE_ENUMS validates against, derived (not hand-copied) so it
// cannot drift from the write boundary above. One representative full-set
// assertion per axis, values in the enum's own declared order.
assert.deepEqual(
  [...STYLE_VALUE_SETS.color],
  ['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white'],
  'STYLE_VALUE_SETS.color matches the COLOR enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.fill],
  ['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'],
  'STYLE_VALUE_SETS.fill matches the FILL enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.dash],
  ['draw', 'solid', 'dashed', 'dotted', 'none'],
  'STYLE_VALUE_SETS.dash matches the DASH enum exactly, including the 5th "none" value',
)
assert.deepEqual([...STYLE_VALUE_SETS.size], ['s', 'm', 'l', 'xl'], 'STYLE_VALUE_SETS.size matches the SIZE enum exactly')
assert.deepEqual(
  [...STYLE_VALUE_SETS.font],
  ['draw', 'sans', 'serif', 'mono'],
  'STYLE_VALUE_SETS.font matches the FONT enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.align],
  ['start', 'middle', 'end', 'start-legacy', 'end-legacy', 'middle-legacy'],
  'STYLE_VALUE_SETS.align matches the ALIGN enum exactly, including all three -legacy variants',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.verticalAlign],
  ['start', 'middle', 'end'],
  'STYLE_VALUE_SETS.verticalAlign matches the VERTICAL_ALIGN enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.textAlign],
  ['start', 'middle', 'end'],
  'STYLE_VALUE_SETS.textAlign matches the TEXT_ALIGN enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.geo],
  [
    'cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon',
    'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid',
    'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box',
    'heart',
  ],
  'STYLE_VALUE_SETS.geo matches the GEO enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.arrowheadStart],
  ['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none'],
  'STYLE_VALUE_SETS.arrowheadStart matches the ARROWHEAD enum exactly',
)
assert.deepEqual(
  [...STYLE_VALUE_SETS.arrowheadEnd],
  ['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none'],
  'STYLE_VALUE_SETS.arrowheadEnd matches the ARROWHEAD enum exactly (same set as arrowheadStart)',
)
// Structural drift guard: the exported keys must be exactly STYLE_ENUMS's
// keys -- if a future axis is added to STYLE_ENUMS but the derivation isn't
// updated to walk it, this catches the gap.
assert.deepEqual(
  Object.keys(STYLE_VALUE_SETS).sort(),
  ['align', 'arrowheadEnd', 'arrowheadStart', 'color', 'dash', 'fill', 'font', 'geo', 'size', 'textAlign', 'verticalAlign'].sort(),
  'STYLE_VALUE_SETS has exactly one key per style axis STYLE_ENUMS validates',
)
console.log('ok: STYLE_VALUE_SETS matches STYLE_ENUMS exactly, per axis (M3 drift guard)')

// Task M1 (2026-07-22 draw sub-cycle) -- `draw`'s props schema: segments of
// stroke points + the four style axes (color/fill/dash/size) + isPen/isClosed
// + w/h, typed PERMISSIVELY so both our own strokes and synced v1 draw shapes
// validate. Was `z.looseObject({})` (accepts everything); M1 adds real
// validation on the typed fields while keeping everything else optional/loose.
function drawWith(props: Record<string, unknown>) {
  return { ...note, kind: 'draw', props: { ...props } }
}

// GUARD -- a full v1-shaped draw shape (real segments/points + valid style
// values) validates. This is the permissiveness guard, not the RED (an empty
// looseObject already accepted this before M1).
const v1DrawProps = {
  segments: [{ type: 'free', points: [{ x: 0, y: 0, z: 0.5 }, { x: 10, y: 8, z: 0.7 }] }],
  color: 'blue', fill: 'none', dash: 'draw', size: 'm',
  isPen: true, isComplete: true, isClosed: false, scale: 1,
}
assert.ok(validateShape(drawWith(v1DrawProps)).ok, 'a v1-shaped draw shape (real segments/points) validates')

// RED 1 -- a bad color enum value on a draw shape is now rejected (the color
// axis is typed). Before M1 (empty looseObject) this wrongly validated.
assert.ok(
  !validateShape(drawWith({ ...v1DrawProps, color: 'chartreuse' })).ok,
  'a draw shape with a bad color enum value is rejected',
)

// RED 2 -- a malformed point (missing y / non-number coord) is rejected
// (points are typed). Before M1 this wrongly validated.
assert.ok(
  !validateShape(drawWith({ segments: [{ type: 'free', points: [{ x: 0 }] }] })).ok,
  'a draw shape with a malformed point (missing y) is rejected',
)
assert.ok(
  !validateShape(drawWith({ segments: [{ type: 'free', points: [{ x: 0, y: 'nope' }] }] })).ok,
  'a draw shape with a malformed point (non-number y) is rejected',
)
assert.ok(
  !validateShape(drawWith({ segments: 'not-an-array' })).ok,
  'a draw shape with non-array segments is rejected',
)

// Mutant guard -- making `segments` REQUIRED would wrongly drop a v1 draw
// shape that has no segments key at all (a degenerate/legacy record). It must
// still validate: segments stays optional.
assert.ok(
  validateShape(drawWith({ color: 'red' })).ok,
  'a draw shape with no segments key at all still validates (segments is optional)',
)

// Mutant guard -- typing segment `type` as a closed 'free'|'straight' enum
// would drop a future/unknown segment type. It must still validate: `type`
// stays a loose string.
assert.ok(
  validateShape(drawWith({ segments: [{ type: 'some-future-segment-type', points: [{ x: 0, y: 0 }] }] })).ok,
  'a segment with an unrecognized future type string still validates (type is not a closed enum)',
)

// Unknown extra props still ride through (looseObject forward-compat) -- an
// unknown key on a draw shape survives even alongside a valid typed field.
const drawMixed = drawWith({ color: 'blue', totallyUnknownDrawProp: 42 })
assert.ok(validateShape(drawMixed).ok, 'unknown draw prop key survives alongside a valid typed field')
const parsedDraw = shapeSchema.parse(drawMixed)
assert.equal((parsedDraw.props as any).totallyUnknownDrawProp, 42, 'unknown draw key value preserved verbatim')

// The REAL v1 shape this codebase's own write path produces: segments carry
// `path` (base64 delta-encoded), not `points` -- verified against the
// installed tldraw tlschema dependency (5.1.0, shapes/TLDrawShape.ts's DrawShapeSegment) and
// server/src/canvas/drawShapes.ts's compressLegacySegments call, which is
// what this repo's legacy v1 draw-shape write path actually emits (the
// plan's `points`-based JSDoc example predates that migration). `path` isn't
// a typed field but rides through as a passthrough key on the loose
// `drawSegment`, so this format validates too -- confirming M1 doesn't drop
// the CURRENT real v1 shape, not just the older points-based one.
const v1PathEncodedDraw = drawWith({
  segments: [{ type: 'free', path: 'AAAAAAAAAAAAAAAAAAA=' }],
  color: 'black', fill: 'none', dash: 'solid', size: 'm',
  isPen: false, isComplete: true, isClosed: false, scale: 1, scaleX: 1, scaleY: 1,
})
assert.ok(validateShape(v1PathEncodedDraw).ok, 'the current path-encoded v1 draw segment format also validates')

// draw is NOT text-capable (unchanged by M1 -- structural kind, no text body).
assert.equal(isTextCapableKind('draw' as any), false, 'draw remains non-text-capable')

console.log('ok: draw props schema (M1, draw sub-cycle)')

// Task M1 (2026-07-22 line sub-cycle) -- `line`'s props schema: a KEYED-MAP
// `points` ({[id]: {id, index, x, y}}, matching the installed tldraw
// dependency's line shape exactly -- verified against the installed schema
// package's line-shape module (its `points` field is a keyed dict, NOT an
// array) + `spline` ('line'|'cubic', a line-local closed enum, not a
// STYLE_ENUMS axis) + the three style axes tldraw line carries
// (color/dash/size) + w/h, typed PERMISSIVELY so both our own lines and
// synced v1 line shapes validate. Was `z.looseObject({})` (accepts
// everything); M1 adds real validation on the typed fields while keeping
// everything else optional/loose.
function lineWith(props: Record<string, unknown>) {
  return { ...note, kind: 'line', props: { ...props } }
}

// GUARD -- a full v1-shaped line (real KEYED-MAP points + valid style values)
// validates. This is the permissiveness guard AND the data-loss guard: it is
// what the "type points as array" mutant breaks (a keyed map fails
// z.array(linePoint)'s type check), which is the exact failure mode this task
// exists to avoid -- an over-typed `points` would silently drop every real
// synced v1 line at the write boundary.
const v1LineProps = {
  points: {
    a1: { id: 'a1', index: 'a1', x: 0, y: 0 },
    a2: { id: 'a2', index: 'a2', x: 100, y: 50 },
  },
  color: 'blue', dash: 'solid', size: 'm', spline: 'line', scale: 1,
}
assert.ok(validateShape(lineWith(v1LineProps)).ok, 'a v1-shaped line (real keyed-map points) validates')

// RED 1 -- a bad color enum value on a line is now rejected (the color axis
// is typed). Before M1 (empty looseObject) this wrongly validated.
assert.ok(
  !validateShape(lineWith({ ...v1LineProps, color: 'chartreuse' })).ok,
  'a line shape with a bad color enum value is rejected',
)

// RED 2 -- a bad spline enum value is rejected (spline is a closed line-local
// enum). Before M1 this wrongly validated.
assert.ok(
  !validateShape(lineWith({ ...v1LineProps, spline: 'wiggly' })).ok,
  'a line shape with a bad spline value is rejected',
)

// RED 3 -- a malformed point (missing y / non-number coord) is rejected
// (linePoint's x/y are required numbers). Before M1 this wrongly validated.
assert.ok(
  !validateShape(lineWith({ points: { a1: { id: 'a1', index: 'a1', x: 0 } } })).ok,
  'a line shape with a malformed point (missing y) is rejected',
)
assert.ok(
  !validateShape(lineWith({ points: { a1: { id: 'a1', index: 'a1', x: 0, y: 'nope' } } })).ok,
  'a line shape with a malformed point (non-number y) is rejected',
)

// RED 4 -- points as an ARRAY (the wrong shape -- v1 is always a keyed map,
// so this is never a real v1 case) is rejected: z.record's own type check
// refuses a non-record (array) value. This is the flip side of the data-loss
// guard above: the schema must accept the keyed map AND refuse the array,
// not silently coerce one into the other.
assert.ok(
  !validateShape(lineWith({
    points: [
      { id: 'a1', index: 'a1', x: 0, y: 0 },
      { id: 'a2', index: 'a2', x: 100, y: 50 },
    ],
  })).ok,
  'a line shape with array-shaped points (not the real v1 keyed-map shape) is rejected',
)

// Mutant guard -- making `points` or `spline` REQUIRED would wrongly drop a
// v1 line lacking one key at all (a degenerate/legacy record). Both stay
// optional.
assert.ok(validateShape(lineWith({ color: 'red' })).ok, 'a line shape with no points/spline key at all still validates')

// Unknown extra props still ride through (looseObject forward-compat) -- an
// unknown key on a line survives even alongside a valid typed field.
const lineMixed = lineWith({ color: 'blue', totallyUnknownLineProp: 42 })
assert.ok(validateShape(lineMixed).ok, 'unknown line prop key survives alongside a valid typed field')
const parsedLine = shapeSchema.parse(lineMixed)
assert.equal((parsedLine.props as any).totallyUnknownLineProp, 42, 'unknown line key value preserved verbatim')

// line is NOT text-capable (unchanged by M1 -- structural kind, no text body).
assert.equal(isTextCapableKind('line' as any), false, 'line remains non-text-capable')

console.log('ok: line props schema (M1, line sub-cycle)')

// --- Task M2 (2026-07-22 assets/image sub-cycle) -- image shape assetId prop ---
function imageWith(props: Record<string, unknown>) {
  return {
    id: 'shape:img1', kind: 'image', parentId: 'page:p', index: 'a1',
    x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
    props: { w: 10, h: 10, ...props },
  }
}

// A real created image (guard): assetId referencing an asset validates.
assert.ok(validateShape(imageWith({ assetId: 'asset:x' })).ok, 'an image with a real assetId validates')

// A v1 image with assetId:null (unset asset) plus other v1 fields still
// validates -- kills a "required, non-null" mutant.
assert.ok(
  validateShape(imageWith({ assetId: null, crop: null, playing: true })).ok,
  'a v1 image with assetId:null validates',
)

// An image with no assetId key at all still validates -- kills a "required"
// mutant (both nullable-required and non-nullable-required variants).
assert.ok(validateShape(imageWith({})).ok, 'an image with no assetId key at all validates')

// A bad assetId (non-string, non-null) is now REJECTED -- the M2 RED: today
// `image: box` rides assetId through UNTYPED, so this wrongly validates
// before M2's fix.
assert.ok(!validateShape(imageWith({ assetId: 123 })).ok, 'a non-string, non-null assetId is rejected')

// Unknown keys (crop/flipX/flipY/playing/url/altText -- tldraw's other
// TLImageShape props) still ride through untyped (only assetId gains teeth).
assert.ok(
  validateShape(imageWith({ assetId: 'asset:x', crop: { x: 0 }, flipX: true, url: 'https://x' })).ok,
  'unknown image props (crop/flipX/url/etc) still ride through',
)

// Data-loss guard: a realistic converted v1 image + its asset BOTH validate
// together (not just each in isolation) -- the pairing a v1→v2 converter
// actually produces.
{
  const v1Asset = validateAsset({
    id: 'asset:v1img',
    type: 'image',
    props: { src: '/uploads/abc123-photo.png', w: 640, h: 480, mimeType: 'image/png', name: 'photo.png' },
    meta: {},
  })
  assert.ok(v1Asset.ok, 'a realistic v1-shaped image asset validates')
  const v1Image = validateShape(
    imageWith({ assetId: v1Asset.ok ? v1Asset.asset.id : undefined, w: 640, h: 480, crop: null, flipX: false, flipY: false }),
  )
  assert.ok(v1Image.ok, 'a realistic v1-shaped image shape referencing that asset validates')
}

console.log('ok: image props schema (M2, assets/image sub-cycle)')
