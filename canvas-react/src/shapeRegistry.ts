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
//
// EMBED FLAG (D8): a kind may be registered with `{ embed: true }` — the
// heavy custom shapes (terminal/iframe/screenshare, ported in Seam E) that
// need the culling-safe EmbedHost/EmbedLayer lifecycle instead of
// ShapeLayer's plain cull-and-unmount treatment (see ShapeLayer.tsx's
// CULLING UNMOUNTS BODIES header and embed/embedLifecycle.ts). `isEmbedKind`
// is the single source of truth both ShapeLayer (to SKIP embed kinds) and
// EmbedLayer (to SELECT embed kinds) consult, so the two layers can never
// disagree about which kind renders where. Defaults to non-embed (`false`)
// for any kind registered via the two-argument call, so every pre-D8
// `registerShape(kind, Component)` call site keeps working unchanged.
import type { ComponentType } from 'react'
import type { CanvasDocument, Shape } from '@ensembleworks/canvas-model'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { BoxShape } from './shapes/BoxShape.js'

export interface ShapeBodyProps {
  readonly shape: Shape
  readonly snapshot: CanvasDocument
  readonly editorState: EditorState
  /** Reads a shape's live `LoroText` content by id (`editor.doc.getText` —
   * the SAME accessor TextEditor.tsx uses for its editing textarea's
   * `value`, and the SAME "reading editor.doc through its public surface is
   * not an import" posture that file's module header establishes). Threaded
   * from ShapeLayer down through ShapeBody so a text-capable kind's body
   * (BoxShape's fallback, today) can render the doc's actual text content
   * instead of only ever showing `props.richText`/`props.name` — see
   * BoxShape.tsx's labelOf for the closed review gap this fixes: without
   * this accessor, `SetText` (the plain-text editing mount's whole-string
   * write) had NO rendering consumer anywhere — not for a remote peer, not
   * even for the SAME client once its own edit ended, since `props.richText`
   * is a completely different (and, this phase, unwritten-by-typing) field.
   * Optional so a fixture/test that doesn't care about live text (goldens'
   * static `richText`-only fixtures, most of shape-layer.test.ts) can omit
   * it — BoxShape's labelOf falls back to its pre-existing richText/name/kind
   * chain whenever this is absent OR returns an empty string. */
  readonly getText?: (id: string) => string
}

export interface RegisterShapeOptions {
  /** True iff `kind` is a heavy embed (terminal/iframe/screenshare, …) that
   * must survive being panned off-screen — see the module header. Defaults
   * to false. */
  readonly embed?: boolean
}

interface RegistryEntry {
  readonly component: ComponentType<ShapeBodyProps>
  readonly embed: boolean
}

const registry = new Map<string, RegistryEntry>()

/** Register (or REPLACE — a second call for the same kind overwrites the
 * first, no error) the component that renders shapes of `kind`, and whether
 * `kind` is an embed (see EMBED FLAG above). */
export function registerShape(kind: string, component: ComponentType<ShapeBodyProps>, options: RegisterShapeOptions = {}): void {
  registry.set(kind, { component, embed: options.embed ?? false })
}

/** The component for `kind`, or BoxShape if `kind` has no registered
 * component (see FALLBACK POLICY above). */
export function lookupShapeComponent(kind: string): ComponentType<ShapeBodyProps> {
  return registry.get(kind)?.component ?? BoxShape
}

/** True iff `kind` was registered with `{ embed: true }`. An unregistered
 * kind is never an embed (BoxShape's fallback is stateless — see FALLBACK
 * POLICY). */
export function isEmbedKind(kind: string): boolean {
  return registry.get(kind)?.embed ?? false
}
