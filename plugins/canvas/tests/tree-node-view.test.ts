// Run: npx vitest run tests/tree-node-view.test.ts
//
// W18's first half, and the more important one: CAN A HUMAN LOOK AT THE TREE
// AND SEE WHAT IS DONE, without selecting nodes one at a time.
//
// The defect this closes (plan.md follow-up 1, C3's "F1 in mirror image"): an
// agent reads and writes `state`, `approached` and `context` on every node,
// and NOTHING on the canvas renders any of them. The agent has been seeing
// strictly more of the tree than the person who drew it.
//
// The claims are about the DIFFERENCE between states — a mark is only worth
// its ability to distinguish — and about what is NOT marked: a shape that is
// not a readable tree node gets no mark at all, because a mark invented for a
// shape whose meta does not parse would state a fact the document does not
// hold (edge-view.ts made the same call for an unreadable quarantine record).
import { describe, expect, it } from "vitest";
import { localBounds, makeDocument, type CanvasDocument, type Page, type Shape } from "@ensembleworks/canvas-model";
import type { Camera } from "@ensembleworks/canvas-editor";
import { buildTreeEdge, buildTreeNode, markTreePage } from "../canvas/tree/encoding.js";
import {
  APPROACHED_LABEL,
  STATE_INK,
  STATE_LABELS,
  nodeStateMarks,
} from "../canvas/tree/node-view.js";

const TREE_ID = "page:tree-marks";
const OTHER_PAGE = "page:elsewhere";
const CAMERA: Camera = { x: 0, y: 0, z: 1 };
const SIZE = { width: 1280, height: 800 };

const node = (id: string, x: number, over: Partial<Parameters<typeof buildTreeNode>[0]> = {}): Shape =>
  buildTreeNode({ id, treeId: TREE_ID, parentId: TREE_ID, index: "a1", x, y: 0, ...over });

function docOf(shapes: readonly Shape[], pages?: readonly Page[]): CanvasDocument {
  return makeDocument({
    pages: pages ?? [markTreePage({ id: TREE_ID, name: "Tree" })],
    shapes: [...shapes],
    bindings: [],
  });
}

describe("a node's state, on the node", () => {
  it("marks every readable node of the page in document order", () => {
    const doc = docOf([
      node("shape:a", 0, { state: "todo" }),
      node("shape:b", 400, { state: "wip" }),
      node("shape:c", 800, { state: "done" }),
    ]);
    const marks = nodeStateMarks(doc, CAMERA, SIZE, TREE_ID);
    expect(marks.map((mark) => mark.nodeId)).toEqual(["shape:a", "shape:b", "shape:c"]);
    expect(marks.map((mark) => mark.label)).toEqual([
      STATE_LABELS.todo,
      STATE_LABELS.wip,
      STATE_LABELS.done,
    ]);
  });

  it("draws the three states differently — a mark is only worth what it distinguishes", () => {
    const labels = new Set(Object.values(STATE_LABELS));
    const inks = new Set(Object.values(STATE_INK));
    expect(labels.size).toBe(3);
    expect(inks.size).toBe(3);
  });

  it("anchors the mark to the node's own top-left corner, so it tracks pan and zoom", () => {
    const doc = docOf([node("shape:a", 500)]);
    const bounds = localBounds(doc.byId.get("shape:a") as Shape);
    const zoomed = nodeStateMarks(doc, { x: -100, y: -50, z: 2 }, SIZE, TREE_ID);
    const [mark] = zoomed;
    expect(mark?.left).toBe((500 - 100) * 2);
    expect(mark?.top).toBe((0 - 50) * 2);
    // Sanity: the node really does start where the mark is put.
    expect(bounds.minX).toBe(0);
  });

  it("says whether the node has been approached, and says nothing when it has not", () => {
    const doc = docOf([
      node("shape:looked", 0, { approached: true }),
      node("shape:not", 400, { approached: false }),
    ]);
    const [looked, not] = nodeStateMarks(doc, CAMERA, SIZE, TREE_ID);
    expect(looked?.approached).toBe(true);
    expect(not?.approached).toBe(false);
    expect(APPROACHED_LABEL.length).toBeGreaterThan(0);
  });

  it("marks nothing on another page's nodes", () => {
    const doc = docOf(
      [
        node("shape:here", 0),
        {
          ...node("shape:there", 0),
          id: "shape:there",
          parentId: OTHER_PAGE,
          meta: { ...(node("shape:there", 0).meta as Record<string, unknown>), tree: OTHER_PAGE, nodeId: "shape:there" },
        } as Shape,
      ],
      [markTreePage({ id: TREE_ID, name: "Tree" }), markTreePage({ id: OTHER_PAGE, name: "Other" })],
    );
    expect(nodeStateMarks(doc, CAMERA, SIZE, TREE_ID).map((mark) => mark.nodeId)).toEqual([
      "shape:here",
    ]);
  });

  it("marks nothing for a shape that is not a tree node, and nothing for an edge", () => {
    const edge = buildTreeEdge({
      id: "shape:edge",
      treeId: TREE_ID,
      parentId: TREE_ID,
      index: "b1",
      blockerId: "shape:a",
      blockedId: "shape:b",
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
    });
    const loose = { ...node("shape:loose", 0), meta: {} } as Shape;
    const doc = docOf([node("shape:a", 0), node("shape:b", 400), loose, edge.shape]);
    expect(nodeStateMarks(doc, CAMERA, SIZE, TREE_ID).map((mark) => mark.nodeId)).toEqual([
      "shape:a",
      "shape:b",
    ]);
  });

  it("invents no state for a tree-marked note whose meta does not parse", () => {
    const broken = {
      ...node("shape:broken", 0),
      meta: { tree: TREE_ID, nodeId: "shape:broken", state: "sideways", approached: false, context: "" },
    } as Shape;
    const doc = docOf([broken]);
    expect(nodeStateMarks(doc, CAMERA, SIZE, TREE_ID)).toEqual([]);
  });

  it("drops a node the camera has left far off screen", () => {
    const doc = docOf([node("shape:far", 100_000)]);
    expect(nodeStateMarks(doc, CAMERA, SIZE, TREE_ID)).toEqual([]);
  });
});
