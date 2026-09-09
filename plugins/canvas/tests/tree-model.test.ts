// Run: npx vitest run tests/tree-model.test.ts
//
// W1's gate. The model turns a canvas document into a Tree: nodes, edges,
// roots, children, blockers, path-to-root, ready leaves, plus the invariant
// pass (acyclic, endpoints exist, every node reachable).
//
// Three things these tests are actually aimed at, because they are the three
// ways a reader like this goes wrong in a live room:
//
//  1. DIRECTION. `blocker BLOCKS blocked` is fixed in W0's encoding, and the
//     whole of children/parents/roots/path-to-root hangs off getting it the
//     right way round. Every structural assertion below names WHICH node it
//     expects, never just a count, so a flipped edge cannot pass.
//  2. SILENT DROPS. A malformed node, a half-bound edge, an edge pointing at
//     a shape that is not in this tree — each must appear as a PROBLEM, not
//     vanish. A tree that quietly omits a human's node is worse than one that
//     reports it broken.
//  3. DETERMINISM. Two peers holding the identical converged CRDT state
//     iterate shapes in different orders. Every output here must be a pure
//     function of ids, never of input array order — the same reason
//     canvas-model's `orderedPages` sorts.
//
// Built on the REAL things: canvas-model's `makeDocument`/`validateShape` and
// W0's own builders, so a fixture that the live document would refuse cannot
// pass here.
import { describe, expect, it } from "vitest";
import {
  makeDocument,
  validateShape,
  type Binding,
  type CanvasDocument,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import {
  TREE_KEY,
  buildTreeEdge,
  buildTreeNode,
  markTreePage,
  type NodeState,
} from "../canvas/tree/encoding.js";
import {
  childrenOf,
  checkTreeInvariants,
  listTrees,
  parentsOf,
  pathToRoot,
  readTree,
  readyNodes,
  roots,
  treeNodes,
  type Tree,
  type TreeProblem,
} from "../canvas/tree/model.js";

const TREE = "page:tree";
const OTHER = "page:other";

/** ids only, so every assertion below names nodes rather than counting them. */
const ids = (nodes: readonly { id: string }[]): string[] => nodes.map((n) => n.id);
const kinds = (problems: readonly TreeProblem[]): string[] => problems.map((p) => p.kind);

interface Spec {
  /** node id -> its state (default "todo"). */
  readonly nodes: Readonly<Record<string, NodeState>>;
  /** `[blockerId, blockedId]` — "blocker BLOCKS blocked", W0's fixed direction. */
  readonly edges: readonly (readonly [string, string])[];
  readonly treeId?: Page["id"];
  readonly markPage?: boolean;
  readonly extraShapes?: readonly Shape[];
  readonly extraBindings?: readonly Binding[];
  readonly extraPages?: readonly Page[];
}

/**
 * Build a real CanvasDocument for a spec. Node shapes are laid out on a line
 * — position is irrelevant to every function under test, and W3 owns layout.
 */
function docOf(spec: Spec): CanvasDocument {
  const treeId = spec.treeId ?? TREE;
  const nodeIds = Object.keys(spec.nodes);
  const shapes: Shape[] = nodeIds.map((id, i) =>
    buildTreeNode({
      id,
      treeId,
      parentId: treeId,
      index: `a${i}`,
      x: i * 200,
      y: 0,
      state: spec.nodes[id],
    }),
  );
  const bindings: Binding[] = [];
  spec.edges.forEach(([blockerId, blockedId], i) => {
    const built = buildTreeEdge({
      id: `shape:edge-${i}`,
      treeId,
      parentId: treeId,
      index: `b${i}`,
      blockerId,
      blockedId,
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
    });
    shapes.push(built.shape);
    bindings.push(...built.bindings);
  });
  const page: Page = { id: treeId, name: "Tree" };
  return makeDocument({
    pages: [
      spec.markPage === false ? page : markTreePage(page),
      ...(spec.extraPages ?? []),
    ],
    shapes: [...shapes, ...(spec.extraShapes ?? [])],
    bindings: [...bindings, ...(spec.extraBindings ?? [])],
  });
}

const treeOf = (spec: Spec): Tree => readTree(docOf(spec), spec.treeId ?? TREE);

/**
 * The running example, and the one that fixes direction:
 *
 *     goal          <- root: it blocks nothing
 *      ^   ^
 *    api   ui       <- children of goal (they BLOCK it)
 *      ^
 *    schema         <- child of api, a ready leaf
 */
const example: Spec = {
  nodes: { "shape:goal": "todo", "shape:api": "todo", "shape:ui": "done", "shape:schema": "todo" },
  edges: [
    ["shape:api", "shape:goal"],
    ["shape:ui", "shape:goal"],
    ["shape:schema", "shape:api"],
  ],
};

describe("finding the trees in a document", () => {
  it("lists only pages carrying a valid mark", () => {
    const doc = docOf({ ...example, extraPages: [{ id: OTHER, name: "Plain" }] });
    expect(listTrees(doc)).toEqual([TREE]);
  });

  it("sorts by page id, so two peers agree on the order", () => {
    const doc = docOf({
      ...example,
      extraPages: [markTreePage({ id: "page:aaa", name: "A" })],
    });
    expect(listTrees(doc)).toEqual(["page:aaa", TREE]);
  });
});

describe("reading a tree out of a document", () => {
  it("collects every node and every edge, and nothing else", () => {
    const tree = treeOf(example);
    expect(ids(treeNodes(tree))).toEqual([
      "shape:api",
      "shape:goal",
      "shape:schema",
      "shape:ui",
    ]);
    expect(tree.edges.map((e) => [e.blockerId, e.blockedId])).toEqual([
      ["shape:api", "shape:goal"],
      ["shape:ui", "shape:goal"],
      ["shape:schema", "shape:api"],
    ]);
    expect(tree.problems).toEqual([]);
  });

  it("keeps each node's meta and its shape, so a caller need not re-read", () => {
    const tree = treeOf(example);
    const api = tree.nodes.get("shape:api");
    expect(api?.meta).toMatchObject({ tree: TREE, nodeId: "shape:api", state: "todo" });
    expect(api?.shape.kind).toBe("note");
  });

  it("ignores shapes belonging to a DIFFERENT tree", () => {
    const foreign = buildTreeNode({
      id: "shape:elsewhere",
      treeId: OTHER,
      parentId: OTHER,
      index: "a9",
      x: 0,
      y: 0,
    });
    const tree = readTree(docOf({ ...example, extraShapes: [foreign] }), TREE);
    expect(tree.nodes.has("shape:elsewhere")).toBe(false);
    expect(tree.problems).toEqual([]);
  });

  it("does not depend on the order shapes arrive in", () => {
    const forward = docOf(example);
    const reversed = makeDocument({
      pages: [...forward.pages].reverse(),
      shapes: [...forward.shapes].reverse(),
      bindings: [...forward.bindings].reverse(),
    });
    expect(readTree(reversed, TREE)).toEqual(readTree(forward, TREE));
  });

  it("builds only shapes the document schema accepts", () => {
    for (const shape of docOf(example).shapes) {
      expect(validateShape(shape)).toMatchObject({ ok: true });
    }
  });
});

describe("what the reader refuses to swallow", () => {
  it("reports a tree whose page carries no mark, rather than reading it silently", () => {
    const tree = treeOf({ ...example, markPage: false });
    expect(kinds(tree.problems)).toEqual(["unmarked-page"]);
    // The nodes are still read: a missing mark is a fact to repair, not a
    // reason to show the human an empty tree where their work is.
    expect(treeNodes(tree)).toHaveLength(4);
  });

  it("reports a page that is missing from the document entirely", () => {
    const doc = makeDocument({ pages: [], shapes: [], bindings: [] });
    expect(kinds(readTree(doc, TREE).problems)).toEqual(["unmarked-page"]);
  });

  it("reports a malformed node instead of dropping it", () => {
    const broken = {
      ...buildTreeNode({ id: "shape:bad", treeId: TREE, parentId: TREE, index: "a8", x: 0, y: 0 }),
      meta: { tree: TREE, nodeId: "shape:bad", state: "nonsense", approached: false, context: "" },
    } as unknown as Shape;
    const tree = readTree(docOf({ ...example, extraShapes: [broken] }), TREE);
    expect(kinds(tree.problems)).toEqual(["invalid-node"]);
    expect(tree.problems[0]?.subjects).toEqual(["shape:bad"]);
    expect(tree.nodes.has("shape:bad")).toBe(false);
  });

  it("reports a half-bound edge — the state W11's repair exists to find", () => {
    const built = buildTreeEdge({
      id: "shape:half",
      treeId: TREE,
      parentId: TREE,
      index: "b9",
      blockerId: "shape:schema",
      blockedId: "shape:goal",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
    });
    const tree = readTree(
      docOf({ ...example, extraShapes: [built.shape], extraBindings: [built.bindings[0]] }),
      TREE,
    );
    expect(kinds(tree.problems)).toEqual(["invalid-edge"]);
    expect(tree.edges).toHaveLength(3);
  });

  it("reports an edge pointing at a shape that is not a node of this tree", () => {
    const built = buildTreeEdge({
      id: "shape:dangling",
      treeId: TREE,
      parentId: TREE,
      index: "b9",
      blockerId: "shape:schema",
      blockedId: "shape:ghost",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
    });
    const tree = readTree(
      docOf({ ...example, extraShapes: [built.shape], extraBindings: [...built.bindings] }),
      TREE,
    );
    expect(kinds(tree.problems)).toEqual(["dangling-edge"]);
    expect(tree.problems[0]?.subjects).toEqual(["shape:dangling", "shape:ghost"]);
    // A dangling edge is NOT in the graph: every function below can then
    // assume both endpoints resolve, with no null-guard at each call site.
    expect(tree.edges.map((e) => e.edgeId)).not.toContain("shape:dangling");
  });

  it("reports a tree-marked shape of a kind that is neither node nor edge", () => {
    const geo = {
      id: "shape:geo",
      kind: "geo",
      parentId: TREE,
      index: "a7",
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: { [TREE_KEY]: TREE },
      props: {},
    } as unknown as Shape;
    const tree = readTree(docOf({ ...example, extraShapes: [geo] }), TREE);
    expect(kinds(tree.problems)).toEqual(["foreign-kind"]);
    expect(tree.problems[0]?.subjects).toEqual(["shape:geo"]);
  });

  it("reports a second edge restating a relationship that already exists", () => {
    const tree = treeOf({
      ...example,
      edges: [...example.edges, ["shape:api", "shape:goal"]],
    });
    expect(kinds(tree.problems)).toEqual(["duplicate-edge"]);
    // Both edge ids are named: repair has to know which rows to consider.
    expect(tree.problems[0]?.subjects).toEqual(["shape:edge-0", "shape:edge-3"]);
    // ...and the relationship still exists exactly once structurally.
    expect(ids(childrenOf(tree, "shape:goal"))).toEqual(["shape:api", "shape:ui"]);
  });
});

describe("the shape of the tree", () => {
  it("calls a node that blocks nothing a root", () => {
    expect(ids(roots(treeOf(example)))).toEqual(["shape:goal"]);
  });

  it("finds every root when a page holds more than one goal", () => {
    const tree = treeOf({
      nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo" },
      edges: [["shape:c", "shape:a"]],
    });
    expect(ids(roots(tree))).toEqual(["shape:a", "shape:b"]);
  });

  it("makes a node's CHILDREN the nodes that block it", () => {
    const tree = treeOf(example);
    expect(ids(childrenOf(tree, "shape:goal"))).toEqual(["shape:api", "shape:ui"]);
    expect(ids(childrenOf(tree, "shape:api"))).toEqual(["shape:schema"]);
    expect(ids(childrenOf(tree, "shape:schema"))).toEqual([]);
  });

  it("makes a node's PARENTS the nodes it blocks", () => {
    const tree = treeOf(example);
    expect(ids(parentsOf(tree, "shape:schema"))).toEqual(["shape:api"]);
    expect(ids(parentsOf(tree, "shape:goal"))).toEqual([]);
  });

  it("answers with nothing for an id that is not in the tree", () => {
    const tree = treeOf(example);
    expect(childrenOf(tree, "shape:ghost")).toEqual([]);
    expect(parentsOf(tree, "shape:ghost")).toEqual([]);
  });

  it("walks path-to-root from a node up through what it blocks", () => {
    const read = pathToRoot(treeOf(example), "shape:schema");
    expect(read.status).toBe("ok");
    expect(read.status === "ok" && ids(read.value)).toEqual([
      "shape:schema",
      "shape:api",
      "shape:goal",
    ]);
  });

  it("gives a root a path of just itself", () => {
    const read = pathToRoot(treeOf(example), "shape:goal");
    expect(read.status === "ok" && ids(read.value)).toEqual(["shape:goal"]);
  });

  it("says ABSENT for a node the tree does not hold — not an empty path", () => {
    expect(pathToRoot(treeOf(example), "shape:ghost")).toEqual({ status: "absent" });
  });

  it("refuses to loop forever when a cycle sits above a node", () => {
    const tree = treeOf({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const read = pathToRoot(tree, "shape:a");
    expect(read.status).toBe("invalid");
    expect(read.status === "invalid" && read.error).toMatch(/cycle/i);
  });

  it("calls an undone node with no blockers a ready leaf", () => {
    // schema blocks api and has nothing under it; ui is done; goal and api
    // both still have work beneath them.
    expect(ids(readyNodes(treeOf(example)))).toEqual(["shape:schema"]);
  });

  it("does not call a done leaf ready", () => {
    const tree = treeOf({ nodes: { "shape:a": "done", "shape:b": "wip" }, edges: [] });
    expect(ids(readyNodes(tree))).toEqual(["shape:b"]);
  });
});

describe("the invariant pass", () => {
  it("is quiet on a well-formed tree", () => {
    expect(checkTreeInvariants(treeOf(example))).toEqual([]);
  });

  it("does not mistake a redundant edge row for a second parent", () => {
    // Caught a real defect on first run: adjacency built straight off the
    // edge list counted the duplicate twice, so a tree whose only fault was a
    // redundant row also reported multiple-parents and listed a child twice.
    const tree = treeOf({
      ...example,
      edges: [...example.edges, ["shape:api", "shape:goal"]],
    });
    expect(kinds(checkTreeInvariants(tree))).toEqual([]);
    expect(ids(parentsOf(tree, "shape:api"))).toEqual(["shape:goal"]);
  });

  it("names the nodes in a cycle", () => {
    const tree = treeOf({
      nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:c"],
        ["shape:c", "shape:a"],
      ],
    });
    const problems = checkTreeInvariants(tree);
    expect(kinds(problems)).toContain("cycle");
    const cycle = problems.find((p) => p.kind === "cycle");
    // Canonical rotation (smallest id first) so two peers report the SAME
    // cycle, whichever node their traversal happened to reach first.
    expect(cycle?.subjects).toEqual(["shape:a", "shape:b", "shape:c"]);
  });

  it("reports a cycle in canonical form even when the walk enters it elsewhere", () => {
    // `a` blocks `y`, and `y`/`x` block each other. The walk reaches the
    // cycle at `y`, so the raw stack slice is [y, x]; the reported subjects
    // must still start at the cycle's smallest id, or the SAME cycle would be
    // described two ways depending on which node happened to lead into it.
    const tree = treeOf({
      nodes: { "shape:a": "todo", "shape:x": "todo", "shape:y": "todo" },
      edges: [
        ["shape:a", "shape:y"],
        ["shape:y", "shape:x"],
        ["shape:x", "shape:y"],
      ],
    });
    const cycle = checkTreeInvariants(tree).find((p) => p.kind === "cycle");
    expect(cycle?.subjects).toEqual(["shape:x", "shape:y"]);
  });

  it("reports the same cycle whichever direction the shapes were iterated", () => {
    const spec: Spec = {
      nodes: { "shape:a": "todo", "shape:b": "todo", "shape:c": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:c"],
        ["shape:c", "shape:a"],
      ],
    };
    const forward = docOf(spec);
    const reversed = makeDocument({
      pages: [...forward.pages],
      shapes: [...forward.shapes].reverse(),
      bindings: [...forward.bindings].reverse(),
    });
    expect(checkTreeInvariants(readTree(reversed, TREE))).toEqual(
      checkTreeInvariants(readTree(forward, TREE)),
    );
  });

  it("reports a node that blocks two different things", () => {
    // Legal on a DAG, NOT on a tree: path-to-root stops being one answer.
    const tree = treeOf({
      nodes: { "shape:goal": "todo", "shape:other": "todo", "shape:api": "todo" },
      edges: [
        ["shape:api", "shape:goal"],
        ["shape:api", "shape:other"],
      ],
    });
    const problems = checkTreeInvariants(tree);
    expect(kinds(problems)).toEqual(["multiple-parents"]);
    expect(problems[0]?.subjects).toEqual(["shape:api", "shape:goal", "shape:other"]);
  });

  it("still answers path-to-root deterministically under multiple parents", () => {
    const tree = treeOf({
      nodes: { "shape:goal": "todo", "shape:other": "todo", "shape:api": "todo" },
      edges: [
        ["shape:api", "shape:other"],
        ["shape:api", "shape:goal"],
      ],
    });
    const read = pathToRoot(tree, "shape:api");
    expect(read.status === "ok" && ids(read.value)).toEqual(["shape:api", "shape:goal"]);
  });

  it("reports nodes cut off from every root", () => {
    // Only reachable when a cycle exists: with no cycle, walking up from any
    // node terminates at a root, so unreachable is empty by construction.
    const tree = treeOf({
      nodes: { "shape:root": "todo", "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const unreachable = checkTreeInvariants(tree).filter((p) => p.kind === "unreachable");
    expect(unreachable.map((p) => p.subjects[0]).sort()).toEqual(["shape:a", "shape:b"]);
  });

  it("does not report an isolated node as unreachable — it is its own root", () => {
    const tree = treeOf({ nodes: { "shape:lonely": "todo" }, edges: [] });
    expect(checkTreeInvariants(tree)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C1 rework — readiness, and an ambiguous terminal
// ---------------------------------------------------------------------------

describe("readiness is about blockers, not leaves", () => {
  it("calls a node ready once every blocker is done", () => {
    // The frontier has to MOVE. With its only blocker done, the goal is the
    // work that can be picked up next; a strict-leaf rule reports nothing.
    const tree = treeOf({
      nodes: { "shape:goal": "todo", "shape:api": "done" },
      edges: [["shape:api", "shape:goal"]],
    });
    expect(ids(readyNodes(tree))).toEqual(["shape:goal"]);
  });

  it("does not call a node with an unfinished blocker ready", () => {
    const tree = treeOf({
      nodes: { "shape:goal": "todo", "shape:api": "wip" },
      edges: [["shape:api", "shape:goal"]],
    });
    expect(ids(readyNodes(tree))).toEqual(["shape:api"]);
  });
});

describe("an edge whose terminal is bound twice", () => {
  it("is reported as invalid, naming the conflicting bindings", () => {
    const built = buildTreeEdge({
      id: "shape:ambiguous",
      treeId: TREE,
      parentId: TREE,
      index: "b9",
      blockerId: "shape:schema",
      blockedId: "shape:goal",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
    });
    const extra = {
      id: "binding:shape:ambiguous-start-2",
      fromId: "shape:ambiguous",
      toId: "shape:ui",
      props: { terminal: "start", anchor: { nx: 0.5, ny: 0.5 } },
      meta: {},
    } as unknown as Binding;
    const tree = readTree(
      docOf({
        ...example,
        extraShapes: [built.shape],
        extraBindings: [...built.bindings, extra],
      }),
      TREE,
    );
    expect(kinds(tree.problems)).toEqual(["invalid-edge"]);
    expect(tree.problems[0]?.subjects).toEqual([
      "shape:ambiguous",
      "binding:shape:ambiguous-start",
      "binding:shape:ambiguous-start-2",
    ]);
    // And it is NOT in the graph: an ambiguous edge must not be traversed.
    expect(tree.edges.map((e) => e.edgeId)).not.toContain("shape:ambiguous");
  });
});
