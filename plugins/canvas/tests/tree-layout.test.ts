// W3 — the tidy-tree layout. Run: npx vitest run tests/tree-layout.test.ts
//
// Every document here is built through W0's real builders (tests/lib/
// tree-fixture.ts) and read through W1's real `readTree`, so a layout test can
// never pass against a tree shape the encoding would not accept.
import { describe, expect, it } from "vitest";
import {
  makeDocument,
  localBounds,
  type CanvasDocument,
  type Shape,
} from "@ensembleworks/canvas-model";
import { quarantineTreeShape } from "../canvas/tree/encoding.js";
import { readTree, type Tree } from "../canvas/tree/model.js";
import {
  DEFAULT_NODE_SIZE,
  LEVEL_GAP,
  ROOT_GAP,
  SIBLING_GAP,
  layoutSubtree,
  layoutTree,
  placeNewChild,
  placeNewGoal,
  type NodePlacement,
} from "../canvas/tree/layout.js";
import { EXAMPLE, TREE, docOf, type Spec } from "./lib/tree-fixture.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type Override = { x?: number; y?: number; parentId?: string; props?: Record<string, unknown> };

/** Rebuild a fixture document with per-shape overrides — the positions and
 * sizes layout actually reads. */
const withOverrides = (
  doc: CanvasDocument,
  overrides: Readonly<Record<string, Override>>,
): CanvasDocument =>
  makeDocument({
    pages: [...doc.pages],
    shapes: doc.shapes.map((shape) => {
      const over = overrides[shape.id];
      if (!over) return shape;
      return {
        ...shape,
        ...(over.x === undefined ? {} : { x: over.x }),
        ...(over.y === undefined ? {} : { y: over.y }),
        ...(over.parentId === undefined ? {} : { parentId: over.parentId }),
        ...(over.props === undefined
          ? {}
          : { props: { ...(shape.props as Record<string, unknown>), ...over.props } }),
      } as Shape;
    }),
    bindings: [...doc.bindings],
  });

const treeOf = (spec: Spec, overrides: Readonly<Record<string, Override>> = {}): Tree =>
  readTree(withOverrides(docOf(spec), overrides), spec.treeId ?? TREE);

const at = (placements: readonly NodePlacement[], id: string): NodePlacement => {
  const found = placements.find((placement) => placement.nodeId === id);
  if (!found) throw new Error(`${id} was not placed`);
  return found;
};

/** The box a placement occupies, using the node's real rendered size. */
const boxOf = (tree: Tree, placement: NodePlacement) => {
  const node = tree.nodes.get(placement.nodeId);
  if (!node) throw new Error(`${placement.nodeId} is not a node`);
  const { maxX, maxY } = localBounds(node.shape);
  return {
    minX: placement.x,
    minY: placement.y,
    maxX: placement.x + maxX,
    maxY: placement.y + maxY,
  };
};

const overlaps = (
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

const eachOverlappingPair = (tree: Tree, placements: readonly NodePlacement[]): string[] => {
  const clashes: string[] = [];
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (overlaps(boxOf(tree, placements[i]), boxOf(tree, placements[j]))) {
        clashes.push(`${placements[i].nodeId} / ${placements[j].nodeId}`);
      }
    }
  }
  return clashes;
};

// A tall note: canvas-model sizes a note 200 x (200 + growY).
const TALL = { props: { growY: 400 } };

/** Two branches that each have children. The shape that catches a width pass
 * which forgets that a subtree is as wide as its widest generation: siblings
 * and depth alone still look right, and the COUSINS land on top of each
 * other. */
const COUSINS: Spec = {
  nodes: {
    "shape:goal": "todo",
    "shape:a": "todo",
    "shape:b": "todo",
    "shape:c": "todo",
    "shape:d": "todo",
    "shape:e": "todo",
    "shape:f": "todo",
  },
  edges: [
    ["shape:a", "shape:goal"],
    ["shape:b", "shape:goal"],
    ["shape:c", "shape:a"],
    ["shape:d", "shape:a"],
    ["shape:e", "shape:b"],
    ["shape:f", "shape:b"],
  ],
};

// ---------------------------------------------------------------------------
// Shape of the answer
// ---------------------------------------------------------------------------

describe("layoutTree", () => {
  it("places every node of a well-formed tree exactly once", () => {
    const tree = treeOf(EXAMPLE);
    const { placements, skipped } = layoutTree(tree);

    expect(placements.map((p) => p.nodeId)).toEqual([
      "shape:api",
      "shape:goal",
      "shape:schema",
      "shape:ui",
    ]);
    expect(skipped).toEqual([]);
  });

  it("anchors the forest at the smallest-id root's current position", () => {
    // A LOCAL action, not a global one: a reorganise must not teleport the
    // human's goal to the origin.
    const tree = treeOf(
      { nodes: { "shape:goal": "todo" }, edges: [] },
      { "shape:goal": { x: 1234, y: -56 } },
    );
    expect(layoutTree(tree).placements).toEqual([{ nodeId: "shape:goal", x: 1234, y: -56 }]);
  });

  it("centres a parent over its children and spaces siblings by SIBLING_GAP", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo", "shape:a": "todo", "shape:b": "todo" }, edges: [
        ["shape:a", "shape:goal"],
        ["shape:b", "shape:goal"],
      ] },
      { "shape:goal": { x: 0, y: 0 } },
    );
    const { placements } = layoutTree(tree);
    const a = at(placements, "shape:a");
    const b = at(placements, "shape:b");
    const goal = at(placements, "shape:goal");

    expect(b.x - a.x).toBe(DEFAULT_NODE_SIZE.w + SIBLING_GAP);
    expect(a.y).toBe(b.y);
    // The parent sits over the midpoint of the sibling band.
    expect(goal.x + DEFAULT_NODE_SIZE.w / 2).toBe(
      (a.x + b.x + DEFAULT_NODE_SIZE.w) / 2,
    );
  });

  it("drops a child band LEVEL_GAP below the bottom of its own parent", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo", "shape:a": "todo" }, edges: [["shape:a", "shape:goal"]] },
      { "shape:goal": { x: 0, y: 0 } },
    );
    const { placements } = layoutTree(tree);
    expect(at(placements, "shape:a").y).toBe(DEFAULT_NODE_SIZE.h + LEVEL_GAP);
  });

  it("reads each node's real rendered size, so a tall note pushes its children down", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo", "shape:a": "todo" }, edges: [["shape:a", "shape:goal"]] },
      { "shape:goal": { x: 0, y: 0, ...TALL } },
    );
    const { placements } = layoutTree(tree);
    expect(at(placements, "shape:a").y).toBe(DEFAULT_NODE_SIZE.h + 400 + LEVEL_GAP);
  });

  it("never overlaps two nodes, on a tree of mixed sizes and depths", () => {
    const tree = treeOf(
      {
        nodes: {
          "shape:goal": "todo",
          "shape:a": "todo",
          "shape:b": "todo",
          "shape:c": "todo",
          "shape:d": "todo",
          "shape:e": "todo",
        },
        edges: [
          ["shape:a", "shape:goal"],
          ["shape:b", "shape:goal"],
          ["shape:c", "shape:a"],
          ["shape:d", "shape:a"],
          ["shape:e", "shape:c"],
        ],
      },
      { "shape:a": TALL, "shape:c": TALL },
    );
    const { placements } = layoutTree(tree);
    expect(eachOverlappingPair(tree, placements)).toEqual([]);
  });

  it("never overlaps two cousins, the case a per-node width silently breaks", () => {
    const tree = treeOf(COUSINS, { "shape:goal": { x: 0, y: 0 } });
    // Kept apart from the exact-position test below on purpose: `toEqual`
    // fails first and would mask this assertion, which is the one that says
    // what actually goes wrong on the canvas.
    expect(eachOverlappingPair(tree, layoutTree(tree).placements)).toEqual([]);
  });

  it("gives a subtree the width of its widest generation, so cousins cannot collide", () => {
    // THE MUTATION THIS EXISTS FOR. Dropping the `max(own, children's band)`
    // in the width pass leaves every node one node wide, and the tree above
    // still looks fine: siblings are spaced by their own parent's arithmetic,
    // and depth keeps parent off child. What breaks is COUSINS — two branches
    // that each have children — because the band a parent reserves no longer
    // covers what hangs under it. The first version of this suite had no
    // cousins in it and reported the mutation as 27 passed.
    const tree = treeOf(COUSINS, { "shape:goal": { x: 0, y: 0 } });
    const { placements } = layoutTree(tree);
    // The whole packing, pinned: four leaves in one unbroken row, each
    // subtree's band exactly as wide as the generation under it.
    expect(placements).toEqual([
      { nodeId: "shape:a", x: 120, y: 260 },
      { nodeId: "shape:b", x: 600, y: 260 },
      { nodeId: "shape:c", x: 0, y: 520 },
      { nodeId: "shape:d", x: 240, y: 520 },
      { nodeId: "shape:e", x: 480, y: 520 },
      { nodeId: "shape:f", x: 720, y: 520 },
      { nodeId: "shape:goal", x: 360, y: 0 },
    ]);
    expect(eachOverlappingPair(tree, placements)).toEqual([]);
  });

  it("separates several goals by ROOT_GAP, ascending by id, without overlap", () => {
    const tree = treeOf(
      {
        nodes: {
          "shape:goal-a": "todo",
          "shape:goal-b": "todo",
          "shape:kid": "todo",
        },
        edges: [["shape:kid", "shape:goal-a"]],
      },
      { "shape:goal-a": { x: 0, y: 0 }, "shape:goal-b": { x: -900, y: 900 } },
    );
    const { placements } = layoutTree(tree);
    // goal-a's subtree is one node wide; goal-b starts one gap past its right edge.
    expect(at(placements, "shape:goal-b").x).toBe(DEFAULT_NODE_SIZE.w + ROOT_GAP);
    expect(at(placements, "shape:goal-b").y).toBe(0);
    expect(eachOverlappingPair(tree, placements)).toEqual([]);
  });

  it("is a pure function of the tree: shape order in the document changes nothing", () => {
    const spec: Spec = {
      nodes: {
        "shape:goal": "todo",
        "shape:a": "todo",
        "shape:b": "todo",
        "shape:c": "todo",
      },
      edges: [
        ["shape:a", "shape:goal"],
        ["shape:b", "shape:goal"],
        ["shape:c", "shape:b"],
      ],
    };
    const forward = docOf(spec);
    const reversed = makeDocument({
      pages: [...forward.pages],
      shapes: [...forward.shapes].reverse(),
      bindings: [...forward.bindings].reverse(),
    });
    expect(layoutTree(readTree(reversed, TREE))).toEqual(layoutTree(readTree(forward, TREE)));
  });
});

// ---------------------------------------------------------------------------
// Broken trees: terminate, never throw
// ---------------------------------------------------------------------------

describe("layoutTree on a tree that is not a tree", () => {
  it("places a node caught in a cycle below a root exactly once, and terminates", () => {
    // goal <- a <- b <- a: the walk must not follow the loop back round.
    const tree = treeOf({
      nodes: { "shape:goal": "todo", "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:goal"],
        ["shape:b", "shape:a"],
        ["shape:a", "shape:b"],
      ],
    });
    const { placements } = layoutTree(tree);
    expect(placements.map((p) => p.nodeId)).toEqual(["shape:a", "shape:b", "shape:goal"]);
    expect(eachOverlappingPair(tree, placements)).toEqual([]);
  });

  it("places nothing, and says why, when every node is inside a cycle", () => {
    // No node blocks nothing, so the tree has no root to lay out from.
    const tree = treeOf({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const { placements, skipped } = layoutTree(tree);
    expect(placements).toEqual([]);
    expect(skipped.map((s) => [s.nodeId, s.reason])).toEqual([
      ["shape:a", "unreachable"],
      ["shape:b", "unreachable"],
    ]);
  });

  it("gives a node with two parents one place, under the first parent to reach it", () => {
    const tree = treeOf({
      nodes: { "shape:goal-a": "todo", "shape:goal-b": "todo", "shape:kid": "todo" },
      edges: [
        ["shape:kid", "shape:goal-a"],
        ["shape:kid", "shape:goal-b"],
      ],
    });
    const { placements } = layoutTree(tree);
    expect(placements.filter((p) => p.nodeId === "shape:kid")).toHaveLength(1);
    // goal-a is the smaller root id, so it claims the child.
    expect(at(placements, "shape:kid").y).toBeGreaterThan(at(placements, "shape:goal-a").y);
    expect(eachOverlappingPair(tree, placements)).toEqual([]);
  });

  it("lays out an edgeless page as a row of goals", () => {
    const tree = treeOf({
      nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo" },
      edges: [],
    });
    const { placements, skipped } = layoutTree(tree);
    expect(placements.map((p) => p.y)).toEqual([0, 0, 0]);
    expect(skipped).toEqual([]);
  });

  it("places nothing for an empty tree", () => {
    expect(layoutTree(treeOf({ nodes: {}, edges: [] }))).toEqual({
      placements: [],
      skipped: [],
    });
  });

  it("terminates on a deep chain without blowing the call stack", () => {
    const nodes: Record<string, "todo"> = {};
    const edges: [string, string][] = [];
    const id = (i: number) => `shape:n${String(i).padStart(5, "0")}`;
    for (let i = 0; i < 3000; i += 1) {
      nodes[id(i)] = "todo";
      if (i > 0) edges.push([id(i), id(i - 1)]);
    }
    const { placements, skipped } = layoutTree(treeOf({ nodes, edges }));
    expect(placements).toHaveLength(3000);
    expect(skipped).toEqual([]);
  });

  it("is blind to a quarantined edge, exactly as readTree is", () => {
    // Quarantine moves meta.tree to meta.treeQuarantine (W10c/W11), so the
    // edge is not in the tree at all — the child becomes a goal of its own.
    // Layout must inherit that, not re-implement the check.
    const doc = docOf({
      nodes: { "shape:goal": "todo", "shape:kid": "todo" },
      edges: [["shape:kid", "shape:goal"]],
    });
    const quarantined = makeDocument({
      pages: [...doc.pages],
      shapes: doc.shapes.map((shape) => {
        if (shape.id !== "shape:edge-0") return shape;
        const held = quarantineTreeShape(shape, { reason: "reparented", detail: "moved" });
        if (held.status !== "ok") throw new Error("fixture: edge was not quarantined");
        return held.value;
      }),
      bindings: [...doc.bindings],
    });
    const tree = readTree(quarantined, TREE);
    const { placements } = layoutTree(tree);
    // Two roots side by side, not a parent and a child.
    expect(at(placements, "shape:goal").y).toBe(at(placements, "shape:kid").y);
  });

  it("skips a node living in another frame rather than placing it in the wrong space", () => {
    // x/y are relative to the shape's parent, so a node inside a frame and a
    // node on the page are not measured in the same coordinates.
    const tree = treeOf(
      {
        nodes: { "shape:goal": "todo", "shape:inside": "todo" },
        edges: [["shape:inside", "shape:goal"]],
      },
      { "shape:inside": { parentId: "shape:frame" } },
    );
    const { placements, skipped } = layoutTree(tree);
    expect(placements.map((p) => p.nodeId)).toEqual(["shape:goal"]);
    expect(skipped.map((s) => [s.nodeId, s.reason])).toEqual([["shape:inside", "foreign-frame"]]);
  });
});

// ---------------------------------------------------------------------------
// layoutSubtree — the reorganise-one-branch entry point
// ---------------------------------------------------------------------------

describe("layoutSubtree", () => {
  it("pins its own root and moves only what hangs below it", () => {
    const tree = treeOf(
      {
        nodes: {
          "shape:goal": "todo",
          "shape:a": "todo",
          "shape:x": "todo",
          "shape:y": "todo",
        },
        edges: [
          ["shape:a", "shape:goal"],
          ["shape:x", "shape:a"],
          ["shape:y", "shape:a"],
        ],
      },
      { "shape:a": { x: 700, y: 400 } },
    );
    const held = layoutSubtree(tree, "shape:a");
    if (held.status !== "ok") throw new Error(`expected ok, got ${held.status}`);
    const { placements } = held.value;

    expect(at(placements, "shape:a")).toEqual({ nodeId: "shape:a", x: 700, y: 400 });
    expect(placements.map((p) => p.nodeId)).toEqual(["shape:a", "shape:x", "shape:y"]);
    expect(at(placements, "shape:x").y).toBe(400 + DEFAULT_NODE_SIZE.h + LEVEL_GAP);
    expect(eachOverlappingPair(tree, placements)).toEqual([]);
  });

  it("answers absent for a node the tree does not hold", () => {
    expect(layoutSubtree(treeOf(EXAMPLE), "shape:nope").status).toBe("absent");
  });

  it("places a leaf as itself and nothing else", () => {
    const held = layoutSubtree(treeOf(EXAMPLE), "shape:schema");
    if (held.status !== "ok") throw new Error(`expected ok, got ${held.status}`);
    expect(held.value.placements.map((p) => p.nodeId)).toEqual(["shape:schema"]);
  });
});

// ---------------------------------------------------------------------------
// placeNewChild — the entry point W4 calls, one node, nothing else moves
// ---------------------------------------------------------------------------

describe("placeNewChild", () => {
  it("puts a first child centred under its parent, one level down", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo" }, edges: [] },
      { "shape:goal": { x: 100, y: 50 } },
    );
    const held = placeNewChild(tree, "shape:goal");
    if (held.status !== "ok") throw new Error(`expected ok, got ${held.status}`);
    expect(held.value).toEqual({ x: 100, y: 50 + DEFAULT_NODE_SIZE.h + LEVEL_GAP });
  });

  it("puts a later child beside the rightmost sibling, on the same band", () => {
    const tree = treeOf(
      {
        nodes: { "shape:goal": "todo", "shape:a": "todo", "shape:b": "todo" },
        edges: [
          ["shape:a", "shape:goal"],
          ["shape:b", "shape:goal"],
        ],
      },
      {
        "shape:goal": { x: 0, y: 0 },
        "shape:a": { x: 0, y: 260 },
        "shape:b": { x: 240, y: 260 },
      },
    );
    const held = placeNewChild(tree, "shape:goal");
    if (held.status !== "ok") throw new Error(`expected ok, got ${held.status}`);
    expect(held.value).toEqual({ x: 240 + DEFAULT_NODE_SIZE.w + SIBLING_GAP, y: 260 });
  });

  // THE PLACEHOLDER-PINNING TEST THAT USED TO SIT HERE IS GONE, DELIBERATELY.
  // W3 left a test asserting that `placeNewChild` reproduced writes.ts's
  // NODE_STEP_X/NODE_STEP_Y placeholder, as the proof that W4's swap would
  // change nothing. W4 made the swap, the constants are gone, and a test
  // comparing two constants could only ever have agreed with itself. Its
  // replacement is behavioural and lives where the write happens:
  // tests/tree-write-tools.test.ts's "addChild places the new node where W3
  // says" — including the case the placeholder got WRONG (a sibling the human
  // dragged), which is what makes the swap worth having.

  it("respects a size the caller gives it", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo" }, edges: [] },
      { "shape:goal": { x: 0, y: 0 } },
    );
    const held = placeNewChild(tree, "shape:goal", { w: 100, h: 100 });
    if (held.status !== "ok") throw new Error("expected ok");
    // Centred: the parent is 200 wide, the newcomer 100.
    expect(held.value).toEqual({ x: 50, y: DEFAULT_NODE_SIZE.h + LEVEL_GAP });
  });

  it("measures the parent's real size rather than assuming the default", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo" }, edges: [] },
      { "shape:goal": { x: 0, y: 0, ...TALL } },
    );
    const held = placeNewChild(tree, "shape:goal");
    if (held.status !== "ok") throw new Error("expected ok");
    expect(held.value.y).toBe(DEFAULT_NODE_SIZE.h + 400 + LEVEL_GAP);
  });

  it("does not overlap any existing sibling", () => {
    const tree = treeOf(
      {
        nodes: { "shape:goal": "todo", "shape:a": "todo" },
        edges: [["shape:a", "shape:goal"]],
      },
      { "shape:goal": { x: 0, y: 0 }, "shape:a": { x: 0, y: 260, ...TALL } },
    );
    const held = placeNewChild(tree, "shape:goal");
    if (held.status !== "ok") throw new Error("expected ok");
    const newcomer = {
      minX: held.value.x,
      minY: held.value.y,
      maxX: held.value.x + DEFAULT_NODE_SIZE.w,
      maxY: held.value.y + DEFAULT_NODE_SIZE.h,
    };
    expect(overlaps(newcomer, boxOf(tree, { nodeId: "shape:a", x: 0, y: 260 }))).toBe(false);
  });

  it("answers absent for a parent the tree does not hold", () => {
    expect(placeNewChild(treeOf(EXAMPLE), "shape:nope").status).toBe("absent");
  });

  it("ignores a sibling that lives in another frame", () => {
    // Its x/y are in the frame's space; treating them as page coordinates
    // would push the newcomer to an arbitrary place.
    const tree = treeOf(
      {
        nodes: { "shape:goal": "todo", "shape:a": "todo" },
        edges: [["shape:a", "shape:goal"]],
      },
      {
        "shape:goal": { x: 0, y: 0 },
        "shape:a": { x: 9000, y: 9000, parentId: "shape:frame" },
      },
    );
    const held = placeNewChild(tree, "shape:goal");
    if (held.status !== "ok") throw new Error("expected ok");
    expect(held.value).toEqual({ x: 0, y: DEFAULT_NODE_SIZE.h + LEVEL_GAP });
  });
});

// ---------------------------------------------------------------------------
// placeNewGoal — W4's other creation gesture
// ---------------------------------------------------------------------------
//
// "Add a goal" has no parent to hang off, so `placeNewChild` has nothing to
// say about it. The slot is beside the whole existing forest, for the same
// reason `layoutTree` packs goals `ROOT_GAP` apart: the eye has to read "a
// second tree", not "a wide first one". Like every other entry point here it
// MOVES NOTHING — it answers one position.
describe("placeNewGoal", () => {
  it("puts the first goal of an empty tree at the origin", () => {
    expect(placeNewGoal(treeOf({ nodes: {}, edges: [] }))).toEqual({ x: 0, y: 0 });
  });

  it("puts a second goal ROOT_GAP right of the first, on the same band", () => {
    const tree = treeOf(
      { nodes: { "shape:goal": "todo" }, edges: [] },
      { "shape:goal": { x: 40, y: 80 } },
    );
    expect(placeNewGoal(tree)).toEqual({ x: 40 + DEFAULT_NODE_SIZE.w + ROOT_GAP, y: 80 });
  });

  it("clears the WHOLE forest, not just the goal row", () => {
    // A child hanging further right than any root is exactly the case a
    // roots-only extent misses: the new goal would land on top of it.
    const tree = treeOf(
      {
        nodes: { "shape:goal": "todo", "shape:a": "todo" },
        edges: [["shape:a", "shape:goal"]],
      },
      { "shape:goal": { x: 0, y: 0 }, "shape:a": { x: 600, y: 260 } },
    );
    expect(placeNewGoal(tree)).toEqual({ x: 600 + DEFAULT_NODE_SIZE.w + ROOT_GAP, y: 0 });
  });

  it("measures a node's real width rather than assuming the default", () => {
    // A note ignores props.w — canvas-model sizes it 200*scale wide — so the
    // scaled goal is the honest way to ask this question.
    const tree = treeOf(
      { nodes: { "shape:goal": "todo" }, edges: [] },
      { "shape:goal": { x: 0, y: 0, props: { scale: 1.5 } } },
    );
    expect(placeNewGoal(tree).x).toBe(300 + ROOT_GAP);
  });

  it("lines the newcomer up with the TOPMOST goal, not with a lower one", () => {
    const tree = treeOf(
      {
        nodes: { "shape:goal": "todo", "shape:other": "todo" },
        edges: [],
      },
      { "shape:goal": { x: 0, y: 500 }, "shape:other": { x: 300, y: 100 } },
    );
    expect(placeNewGoal(tree).y).toBe(100);
  });

  it("still answers on a tree that is nothing but a cycle", () => {
    // No roots at all, so there is no goal band to line up with — the topmost
    // NODE is the honest fallback. Answering is the point: a broken tree must
    // not stop a human adding a fresh goal beside it.
    const tree = treeOf(
      {
        nodes: { "shape:a": "todo", "shape:b": "todo" },
        edges: [
          ["shape:a", "shape:b"],
          ["shape:b", "shape:a"],
        ],
      },
      { "shape:a": { x: 0, y: 300 }, "shape:b": { x: 0, y: 700 } },
    );
    expect(placeNewGoal(tree)).toEqual({ x: DEFAULT_NODE_SIZE.w + ROOT_GAP, y: 300 });
  });

  it("ignores a node that lives in another frame", () => {
    // Its x/y are the frame's coordinates; measuring the page's forest against
    // them would push the newcomer to an arbitrary place. The frame that
    // counts is the smallest-id root's, which is `layoutTree`'s own rule —
    // hence the ids: `shape:a-goal` sorts first and sits on the page.
    const tree = treeOf(
      {
        nodes: { "shape:a-goal": "todo", "shape:z-framed": "todo" },
        edges: [],
      },
      {
        "shape:a-goal": { x: 0, y: 0 },
        "shape:z-framed": { x: 9000, y: 0, parentId: "shape:a-goal" },
      },
    );
    expect(placeNewGoal(tree)).toEqual({ x: DEFAULT_NODE_SIZE.w + ROOT_GAP, y: 0 });
  });
});
