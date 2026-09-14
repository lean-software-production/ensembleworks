// text-autosize task — the pure, clean-room DECISION half of auto-sizing
// text/note/geo labels: given a shape and a MEASURED label size (measured in
// the DOM by canvas-react's TextEditor.tsx — this module never touches the
// DOM itself, so it stays importable from canvas-editor's boundary-tested
// package), decide what props (if any) an UpdateProps intent should write so
// the shape's rendered box always contains its text — matching tldraw's
// autoSize (text kind: grow w/h) and getGrowY (note/geo kind: grow
// props.growY downward) behaviour.
//
// INJECTED MEASUREMENT, NOT AN INJECTED CAPABILITY ON ToolContext: unlike the
// clock/PRNG (genuinely needed mid-FSM, inside canvas-editor's own tool
// code), no tool in this package ever needs to measure text — only the DOM
// editing surface does, while a shape is being live-edited. So the seam here
// is simpler than a ToolContext capability: canvas-react measures (DOM-only,
// stays in canvas-react/client where DOM access is already allowed) and
// calls this PURE function with the result; the caller (client/src/canvas-v2)
// turns a non-null result into an UpdateProps intent through the ALREADY
// EXISTING generic UpdateProps case in editor.ts (full-shape-inverse undo/
// redo, doc sync) — no new Intent type needed.
//
// growY convention (already modelled, only ever READ until this task):
// canvas-model/src/geometry.ts's `size()` adds `props.growY` to a note's
// fixed 200 baseline and to a geo's stored `props.h` — this module is the
// first WRITER of that field, so it must compute growY against the exact
// same baseline geometry.ts reads against, or the two would silently drift.
import { isTextCapableKind, type Shape } from '@ensembleworks/canvas-model'

/** A measured label box size, in the shape's own local (unscaled) units —
 * i.e. already inclusive of whatever padding the editing surface used to
 * measure, and already at props.scale === 1 (canvas-react divides out any
 * scale before calling this, matching geometry.ts's `size()` scale
 * convention: note/text render at measured-size * props.scale). */
export interface MeasuredTextSize {
  readonly width: number
  readonly height: number
}

// geometry.ts's DEFAULTS/note-special-case, duplicated here as plain
// numbers (not imported — geometry.ts doesn't export its DEFAULTS map) for
// the SAME reason tools/create.ts's own header explains for its rounder
// probe-shape approach not being available here: this module needs the bare
// per-kind baseline as a NUMBER to do growY arithmetic, not a probe shape's
// localBounds. Kept in sync by autosize.test.ts asserting against
// geometry.ts's `localBounds`/`size` for a prop-less shape of each kind.
const NOTE_BASE_HEIGHT = 200
const GEO_DEFAULT_HEIGHT = 120

/** Given `shape` (pre-mutation) and a fresh `measured` label size, returns
 * the props to UpdateProps-merge onto it, or `null` when nothing needs to
 * change (measured size already fits the current box — avoids a redundant
 * no-op dispatch/undo-entry on every keystroke that doesn't actually grow
 * anything). Non-text-capable kinds (canvas-model's isTextCapableKind:
 * note/text/geo) always return null — there is nothing to autosize. */
export function computeAutosizeProps(shape: Shape, measured: MeasuredTextSize): Record<string, unknown> | null {
  if (!isTextCapableKind(shape.kind)) return null
  const p = shape.props as Record<string, unknown>
  const width = Math.max(0, Math.round(measured.width))
  const height = Math.max(0, Math.round(measured.height))

  if (shape.kind === 'text') {
    // tldraw's autoSize: the box grows (or shrinks) to exactly fit the
    // measured glyphs — both axes, every edit. A floor of 1px keeps an
    // emptied-out text shape from collapsing to a zero-size box a click can
    // never re-select.
    const w = Math.max(1, width)
    const h = Math.max(1, height)
    if (p.w === w && p.h === h) return null
    return { w, h }
  }

  // note/geo: grow ONLY downward via growY — geometry.ts's `size()` never
  // reads note/geo's measured WIDTH (note is fixed at 200*scale; geo keeps
  // its stored props.w untouched), so only height ever changes here.
  const baseHeight = shape.kind === 'note' ? NOTE_BASE_HEIGHT : typeof p.h === 'number' ? p.h : GEO_DEFAULT_HEIGHT
  const growY = Math.max(0, height - baseHeight)
  const currentGrowY = typeof p.growY === 'number' ? p.growY : 0
  if (currentGrowY === growY) return null
  return { growY }
}
