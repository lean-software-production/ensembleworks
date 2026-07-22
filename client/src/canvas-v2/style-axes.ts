// Task P1 (docs/plans/2026-07-21-canvas-v2-styling.md) — pure, DOM/React-free
// helpers mirroring v1's `useRelevantStyles`: given the current selection,
// (1) which style AXES are worth showing controls for, and (2) the CURRENT
// value per axis across that selection (a shared value, or the `'mixed'`
// sentinel when the selection disagrees).
//
// PURE by design (no DOM, no React, no editor import) so it's unit-testable
// directly and reusable by both the live selection panel (P2) and the armed/
// next-shape-style panel (AS3, via a `relevantAxesForTool` sibling added
// there — not this task).
//
// VALUE-SET SOURCE OF TRUTH — Task M3. All per-axis value lists below (other
// than `opacity`, an envelope number, not an enum) are imported verbatim from
// `@ensembleworks/canvas-model`'s `STYLE_VALUE_SETS`, itself derived from the
// SAME `STYLE_ENUMS` the model uses to validate writes — so this panel can
// never offer a value the write boundary would reject, or omit one it
// accepts. The one deliberate exception is `align`: the model's ALIGN enum
// accepts three `-legacy` variants for round-trip compat (older documents
// carry them), but this panel only ever offers the three primary values as
// choosable options — see `ALIGN_PRIMARY` below.
import { STYLE_VALUE_SETS as MODEL_STYLE_VALUE_SETS, type Shape, type ShapeKind } from '@ensembleworks/canvas-model'

// The five discrete opacity steps tldraw's own opacity control offers
// (Decisions § Parity value-sets, "opacity"). Opacity is an ENVELOPE field
// (`shape.opacity`, already `z.number()` in canvas-model), not a `props` key
// — every shape kind has one, so it is NOT gated by `STYLE_AXES_BY_KIND`
// below; `relevantAxes` adds it unconditionally whenever the selection is
// non-empty, and `currentValue` reads `shape.opacity` directly, never
// `shape.props.opacity`.
const OPACITY_VALUES = [0.1, 0.25, 0.5, 0.75, 1] as const

// The three PRIMARY align controls a panel offers (Decisions § "horizontal
// align"): the panel must not REJECT a shape already carrying a `-legacy`
// value (canvas-model's ALIGN enum types all six), but it only offers these
// three as choosable options — `currentValue` normalizes a `-legacy` raw
// value down to its base for display, matching R3's renderer-side
// `normalizeAlign` (NoteShape.tsx / GeoShape.tsx). Derived by filtering the
// model's own align set (not a separate hand-typed literal) so a future
// non-legacy addition to the model's ALIGN enum still reaches this panel.
const ALIGN_PRIMARY = MODEL_STYLE_VALUE_SETS.align.filter((v) => !v.endsWith('-legacy'))

// One value-set per style axis. Order here is also the canonical display/
// relevance order (`AXIS_ORDER` below derives from `Object.keys`), so it
// doubles as "which order controls appear in" — not just data.
export const STYLE_VALUE_SETS = {
  color: MODEL_STYLE_VALUE_SETS.color,
  fill: MODEL_STYLE_VALUE_SETS.fill,
  dash: MODEL_STYLE_VALUE_SETS.dash,
  size: MODEL_STYLE_VALUE_SETS.size,
  font: MODEL_STYLE_VALUE_SETS.font,
  align: ALIGN_PRIMARY,
  verticalAlign: MODEL_STYLE_VALUE_SETS.verticalAlign,
  textAlign: MODEL_STYLE_VALUE_SETS.textAlign,
  geo: MODEL_STYLE_VALUE_SETS.geo,
  arrowheadStart: MODEL_STYLE_VALUE_SETS.arrowheadStart,
  arrowheadEnd: MODEL_STYLE_VALUE_SETS.arrowheadEnd,
  opacity: OPACITY_VALUES,
} as const

export type StyleAxis = keyof typeof STYLE_VALUE_SETS

// Canonical display/relevance order — every key of STYLE_VALUE_SETS, in
// insertion order. Kept derived (not hand-duplicated) so the two can't drift.
const AXIS_ORDER = Object.keys(STYLE_VALUE_SETS) as readonly StyleAxis[]

// Kind -> the axes that kind's `props` actually carries (Decisions § "Typed
// props (M1/M2)" kind->axis map, mirrored 1:1 from canvas-model/src/
// shape.ts's `propsByKind` `styleProps(...)` calls). `opacity` is
// deliberately absent from every row — it's envelope-level, added
// unconditionally by `relevantAxes` instead (see OPACITY_VALUES comment
// above). Kinds with no row (frame, group, line, draw, highlight, image, and
// the six embed kinds) carry none of these `props` axes — a selection of
// only those kinds gets just `['opacity']`.
const STYLE_AXES_BY_KIND: Partial<Record<ShapeKind, readonly StyleAxis[]>> = {
  note: ['color', 'size', 'font', 'align', 'verticalAlign'],
  text: ['color', 'size', 'font', 'textAlign'],
  geo: ['color', 'fill', 'dash', 'size', 'font', 'align', 'verticalAlign', 'geo'],
  arrow: ['color', 'fill', 'dash', 'size', 'font', 'arrowheadStart', 'arrowheadEnd'],
}

/**
 * Which style axes are worth showing a control for, given the current
 * selection — the UNION of every selected shape's supported axes (parity
 * with v1's `useRelevantStyles`: show a control iff AT LEAST ONE selected
 * shape supports it, never the intersection — an intersection would hide a
 * control a subset of the selection genuinely supports just because a mixed-
 * kind selection includes a shape that doesn't). Empty selection -> `[]`
 * (armed-tool relevance, when nothing is selected, is `relevantAxesForTool`,
 * added in AS3 — out of scope here).
 */
export function relevantAxes(shapes: readonly Shape[]): StyleAxis[] {
  if (shapes.length === 0) return []
  const relevant = new Set<StyleAxis>(['opacity'])
  for (const shape of shapes) {
    const axes = STYLE_AXES_BY_KIND[shape.kind]
    if (!axes) continue
    for (const axis of axes) relevant.add(axis)
  }
  return AXIS_ORDER.filter((axis) => relevant.has(axis))
}

export type StyleValue = string | number

/** `props.align` (or a legacy `-legacy` variant) stripped of the suffix, so
 * the panel's three-way control reads a legacy value as its base — matching
 * R3's renderer-side `normalizeAlign` (NoteShape.tsx / GeoShape.tsx), which
 * renders `start-legacy` identically to `start`. Only applied to the `align`
 * axis — `textAlign` carries no legacy variants in tldraw's schema. */
function normalizeAlign(raw: string): string {
  return raw.endsWith('-legacy') ? raw.slice(0, -'-legacy'.length) : raw
}

/**
 * The value shared by `axis` across `shapes`, or `'mixed'` when they
 * disagree, or `undefined` when no shape in the selection has an opinion
 * (either none support the axis, or every shape that supports it leaves the
 * prop unset). A shape whose kind doesn't support `axis` at all contributes
 * NO opinion — it neither forces `'mixed'` nor gets defaulted; parity with
 * v1, where `useRelevantStyles` only folds in shapes that actually carry the
 * given `StyleProp`. `opacity` is the one axis read from the shape's
 * ENVELOPE (`shape.opacity`) rather than `shape.props` — see the module
 * header.
 */
export function currentValue(shapes: readonly Shape[], axis: StyleAxis): StyleValue | 'mixed' | undefined {
  const values: StyleValue[] = []
  for (const shape of shapes) {
    if (axis === 'opacity') {
      values.push(shape.opacity)
      continue
    }
    const axes = STYLE_AXES_BY_KIND[shape.kind]
    if (!axes || !axes.includes(axis)) continue // this shape's kind has no opinion on `axis`
    const raw = (shape.props as Record<string, unknown>)[axis]
    if (typeof raw !== 'string') continue // unset on this shape -> no opinion
    values.push(axis === 'align' ? normalizeAlign(raw) : raw)
  }
  if (values.length === 0) return undefined
  const [first, ...rest] = values
  return rest.every((v) => v === first) ? first! : 'mixed'
}
