// The kind -> component registry ShapeBody consults to find what to render
// inside its positioned wrapper div. A single module-level Map (one registry
// for the whole app — canvas-react has no notion of "which room" or
// "which canvas", so there's exactly one registry per JS realm, same as any
// other process-wide lookup table).
//
// SHAPEBODYPROPS CONTRACT (kept deliberately lean/extendable): every
// registered component receives exactly `{ shape, snapshot, editorState }`.
//   - `shape`: the one shape this body renders (canvas-model's Shape —
//     kind/props/x/y/rotation/etc).
//   - `snapshot`: the whole CanvasDocument this shape came from — needed
//     because some shapes will want to read SIBLINGS/CHILDREN (Seam E's
//     roadmap/file-viewer shapes almost certainly do), not just their own
//     fields; passing the whole doc once is cheaper and simpler than
//     inventing a per-kind "what related data do you need" query API.
//   - `editorState`: the editor-local EditorState (camera/selection/hover/
//     editingId) — needed for a shape to know e.g. "am I selected/hovered/
//     being edited" so it can style itself accordingly (D4's selection
//     overlay is a SEPARATE layer, but a shape's OWN body may still want
//     hover/editing state — e.g. showing an edit caret).
// One props object, not three separate props, so a future field (Seam E/D7)
// is one contract change instead of a signature change at every call site.
//
// MEMO STRATEGY (design constraint Seam E implements against — see
// ShapeBody.tsx's MEMO STRATEGY block for the full derivation): reference-
// based React.memo on these props is USELESS — dumpModel materializes
// all-new shape objects on every doc commit even for untouched shapes, and
// the whole-document `snapshot` prop changes identity every commit
// regardless. Heavy embeds (terminal/iframe/screenshare) MUST memo on
// CONTENT (`a.shape.id === b.shape.id && stableStringify(a.shape) ===
// stableStringify(b.shape)` — canvas-model exports stableStringify) and
// SHOULD NOT read `snapshot` at all: it is OPTIONAL-BY-CONVENTION — always
// passed (the type keeps it required so a component that genuinely needs
// sibling/children data, roadmap/file-viewer plausibly, just uses it), but
// reading it forfeits any content-memo win, since no per-shape comparator
// can prove the rest of the document irrelevant. Read `snapshot` only if
// you truly render from other shapes' data — and then you own the
// re-render cost.
//
// FALLBACK POLICY: an unregistered kind renders as BoxShape, not an error
// and not a blank div — this unit ships the six custom shapes' EVENTUAL kind
// strings (terminal/iframe/neko/roadmap/screenshare/file-viewer) and the
// core tldraw kinds (note/text/geo/frame/...) all unregistered, so every
// shape in a real doc renders as SOME box today; Seam E registers the six
// custom shapes with their real components, and D7 is expected to give the
// core kinds their own richer bodies. Until then, "falls back to a labeled
// box" is a safe, visible default — never a shape silently disappearing
// because its kind has no registered renderer yet.
import type { ComponentType } from 'react'
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { BoxShape } from './shapes/BoxShape.js'

export interface ShapeBodyProps {
  readonly shape: Shape
  readonly snapshot: CanvasDocument
  readonly editorState: EditorState
}

const registry = new Map<string, ComponentType<ShapeBodyProps>>()

/** Register (or REPLACE — a second call for the same kind overwrites the
 * first, no error) the component that renders shapes of `kind`. */
export function registerShape(kind: string, component: ComponentType<ShapeBodyProps>): void {
  registry.set(kind, component)
}

/** The component for `kind`, or BoxShape if `kind` has no registered
 * component (see FALLBACK POLICY above). */
export function lookupShapeComponent(kind: string): ComponentType<ShapeBodyProps> {
  return registry.get(kind) ?? BoxShape
}
