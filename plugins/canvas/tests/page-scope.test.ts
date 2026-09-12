// W16/B2 — the document handed to `<Overlay>` is scoped to the page on screen.
//
// THE DEFECT THIS PINS. canvas-react's `Arrows` filters the arrows it draws by
// VIEWPORT and not by PAGE (`canvas-react/src/overlay/Arrows.tsx`), so an arrow
// living on page B is painted over page A whenever its world coordinates fall
// in the camera's box — and pages share one coordinate space, so they routinely
// do. W14's `03-otherpage-recheck.png` is that bug photographed: a black tree
// arrow floating on OtherPage with no shapes at either end, because both ends
// are on the tree page.
//
// WHY THE FIX IS HERE AND NOT UPSTREAM. `<QuarantinedEdges>`, this plugin's own
// sibling of `<Overlay>` in session-view.tsx, already takes `currentPageId` and
// already filters with `pageIdOf` (canvas/tree/edge-view.ts). The plugin is
// therefore already in the business of handing overlay layers a page-scoped
// view; `<Overlay>` was simply the one that never got it.
//
// D5's COST DOES NOT TRANSFER, re-derived rather than inherited. D5 rejected
// "filtering the document handed to <Overlay>" because it "would cost a
// selected arrow its selection outline" — true for the QUARANTINE filter it was
// weighing, where the hidden shape is a live, visible, selectable object on the
// page you are looking at. A PAGE filter removes only shapes that cannot be
// visible in this view at all, so the outline it stops drawing was an outline
// around something the human cannot see. That is not a cost; the last two tests
// below are that argument made checkable.
import { describe, expect, it } from "vitest";
import {
  makeDocument,
  type Binding,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import { pageScopedDocument } from "../canvas/panel/page-scope.js";

const page = (id: Page["id"], name: string): Page => ({ id, name, index: "a1" });

/** Every field canvas-model requires, so the fixtures below say only what is
 * interesting about each shape. */
const shape = (
  id: Shape["id"],
  kind: Shape["kind"],
  parentId: Shape["parentId"],
  props: Record<string, unknown> = {},
): Shape => ({
  id,
  kind,
  parentId,
  index: "a1",
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  isLocked: false,
  props,
  meta: {},
});

const bind = (id: Binding["id"], fromId: Shape["id"], toId: Shape["id"]): Binding => ({
  id,
  fromId,
  toId,
  props: {},
  meta: {},
});

/** Two pages sharing one coordinate space — the arrangement that makes the bug
 * reachable. `shape:frame` on page A holds `shape:in-frame`, so the walk to the
 * page is more than one hop for at least one shape. */
function twoPages() {
  return makeDocument({
    pages: [page("page:a", "A"), page("page:b", "B")],
    shapes: [
      shape("shape:a-note", "note", "page:a"),
      shape("shape:frame", "frame", "page:a"),
      shape("shape:in-frame", "note", "shape:frame"),
      shape("shape:b-note", "note", "page:b"),
      shape("shape:b-arrow", "arrow", "page:b", { end: { x: 50, y: 50 } }),
    ],
    bindings: [
      bind("binding:1", "shape:b-arrow", "shape:b-note"),
      bind("binding:2", "shape:b-arrow", "shape:b-note"),
    ],
  });
}

describe("pageScopedDocument", () => {
  it("keeps only the shapes that live on the page being looked at", () => {
    const scoped = pageScopedDocument(twoPages(), "page:a");
    expect(scoped.shapes.map((shape) => shape.id).sort()).toEqual([
      "shape:a-note",
      "shape:frame",
      "shape:in-frame",
    ]);
  });

  it("drops another page's arrow — the stray W14 photographed", () => {
    const scoped = pageScopedDocument(twoPages(), "page:a");
    expect(scoped.shapes.some((shape) => shape.kind === "arrow")).toBe(false);
  });

  it("follows the parent chain, so a shape inside a frame is not lost with it", () => {
    const scoped = pageScopedDocument(twoPages(), "page:a");
    expect(scoped.byId.get("shape:in-frame")).toBeDefined();
  });

  it("drops the bindings whose ends went, so no overlay layer resolves a ghost", () => {
    const scoped = pageScopedDocument(twoPages(), "page:a");
    expect(scoped.bindings).toEqual([]);
  });

  it("keeps a binding whose ends both stayed", () => {
    const doc = makeDocument({
      pages: [page("page:a", "A")],
      shapes: [
        shape("shape:a-note", "note", "page:a"),
        shape("shape:a-arrow", "arrow", "page:a"),
      ],
      bindings: [bind("binding:1", "shape:a-arrow", "shape:a-note")],
    });
    expect(pageScopedDocument(doc, "page:a").bindings).toHaveLength(1);
  });

  it("keeps the pages and the assets — only shapes are page-scoped", () => {
    const scoped = pageScopedDocument(twoPages(), "page:a");
    expect(scoped.pages).toHaveLength(2);
  });

  it("is the identity, by value, when every shape is already on the page", () => {
    const doc = makeDocument({
      pages: [page("page:a", "A")],
      shapes: [shape("shape:a-note", "note", "page:a")],
      bindings: [],
    });
    const scoped = pageScopedDocument(doc, "page:a");
    expect(scoped.shapes).toEqual(doc.shapes);
  });

  // D5's cost, made checkable. A page filter can only ever remove a shape that
  // is NOT on the page being drawn, so the selection outline it declines to
  // draw is one the human could not have seen anyway. The two tests below are
  // the two halves of that claim.
  it("never removes a shape that IS on the page — so an on-page selection keeps its outline", () => {
    const doc = twoPages();
    const scoped = pageScopedDocument(doc, "page:a");
    for (const shape of doc.shapes) {
      const onPage = ["shape:a-note", "shape:frame", "shape:in-frame"].includes(shape.id);
      expect(scoped.byId.has(shape.id)).toBe(onPage);
    }
  });

  it("removes an OFF-page shape even when it is selected — the outline was the bug", () => {
    // Selection is not an input here, deliberately: this function cannot see
    // it, which is exactly why it cannot make the mistake D5 was guarding
    // against. What it removes is decided by the page and nothing else.
    const scoped = pageScopedDocument(twoPages(), "page:a");
    expect(scoped.byId.has("shape:b-arrow")).toBe(false);
  });
});
