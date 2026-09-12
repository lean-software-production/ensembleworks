// W16/B2 — THE DOCUMENT ONE PAGE'S OVERLAY IS ALLOWED TO SEE.
//
// Pages share one world coordinate space in this model: page B's shapes sit at
// the same x/y a page A shape could sit at, and which page you are looking at
// is a fact about the VIEW, not about the coordinates. Every layer that draws
// from a document therefore has to page-scope for itself, and each one either
// does or is a bug:
//
//   * `ShapeLayer` scopes (it draws the current page's shapes and no others).
//   * `<QuarantinedEdges>`, this plugin's own layer, scopes — it takes
//     `currentPageId` and filters with `pageIdOf` (canvas/tree/edge-view.ts).
//   * `<Overlay>` did NOT. canvas-react's `Arrows` filters by VIEWPORT only, so
//     an arrow on page B is painted over page A whenever its world box falls in
//     the camera's, which for two pages in one coordinate space is routine.
//
// W14's `03-otherpage-recheck.png` is that third case photographed: a black
// tree arrow floating on OtherPage with nothing at either end, because both
// ends are shapes on the tree's page. Before this feature existed, `arrow` was
// not even a registered kind in this plugin — so while the upstream filter is
// genuinely pre-existing, the tree is the sole producer of the shapes that
// reach it, and merging without this would make rooms that render nothing
// wrong today start rendering strays.
//
// WHY IN THE PLUGIN AND NOT UPSTREAM. Teaching `Arrows` about pages is a
// canvas-react change; canvas-react is symlinked into `client/` as well, so it
// would change what the v2 canvas engine draws and owes an interaction contract
// under CONTRIBUTING's rules. That is a separate node with a separate proof.
// Handing `<Overlay>` a scoped document needs neither: it is one call in
// session-view.tsx, it is the posture the sibling layer already has, and it
// leaves the shared packages byte-identical.
//
// D5's COST, RE-DERIVED FOR A PAGE FILTER RATHER THAN INHERITED. D5 rejected
// "filtering the document handed to <Overlay>" because it "would cost a
// selected arrow its selection outline". That was weighed for a QUARANTINE
// filter, where the shape being hidden is live, visible and selectable on the
// page you are looking at — losing its outline is a real loss. A PAGE filter
// removes only shapes that cannot be visible in this view at all. `Overlay`
// spends the document on three things and each is fine:
//
//   1. `Arrows` — the fix itself.
//   2. `Selection` — looks each selected id up in the document. An id it can no
//      longer resolve is one whose shape is on another page, so the outline it
//      stops drawing was an outline around something invisible. That leak is a
//      defect, not a feature being paid for.
//   3. `combinedWorldBounds` → `Handles` — same ids, same argument: handles
//      sized to include off-page geometry are handles that do not match what
//      is on screen.
//
// So the cost does not transfer, and tests/page-scope.test.ts holds the two
// halves of that claim as assertions rather than as this paragraph.
import { makeDocument, pageIdOf, type CanvasDocument } from "@ensembleworks/canvas-model";

/**
 * The same document, holding only the shapes that live on `currentPageId`.
 *
 * PAGE MEMBERSHIP IS THE PARENT CHAIN, not `parentId === pageId` — a note
 * inside a frame names the FRAME as its parent, and dropping it because its
 * parent is not the page would empty every framed page on screen.
 * `canvas-model`'s `pageIdOf` walks that chain and is the same question
 * `agents-view.ts`, `edge-view.ts` and `reveal.ts` already ask; a fourth
 * private answer here would be a fourth thing to get wrong.
 *
 * BINDINGS GO WITH THEIR ENDS. A binding whose shape was filtered out would
 * have an overlay layer resolving an id the document no longer holds; the
 * layers survive that (canvas-react's `terminalBounds` falls back to the
 * arrow's own stored point), but a document that describes a relationship
 * between a shape it has and a shape it does not is not a document anybody
 * should have to reason about.
 *
 * PAGES AND ASSETS ARE KEPT WHOLE. Neither is page-scoped: the page list is
 * what the tab strip is drawn from, and an asset is addressed by id from
 * whichever shape references it.
 *
 * NOT MEMOISED HERE. It is a pure function of `(doc, pageId)`; the caller holds
 * the render-cycle knowledge of when those change, and session-view.tsx wraps
 * it in a `useMemo` on exactly that pair.
 */
export function pageScopedDocument(
  doc: CanvasDocument,
  currentPageId: string,
): CanvasDocument {
  const shapes = doc.shapes.filter((shape) => pageIdOf(doc, shape) === currentPageId);
  if (shapes.length === doc.shapes.length) return doc;
  const kept = new Set(shapes.map((shape) => shape.id));
  return makeDocument({
    pages: doc.pages,
    shapes,
    bindings: doc.bindings.filter(
      (binding) => kept.has(binding.fromId) && kept.has(binding.toId),
    ),
    assets: doc.assets,
  });
}
