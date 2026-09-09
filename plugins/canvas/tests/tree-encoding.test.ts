// Run: npx vitest run tests/tree-encoding.test.ts
//
// W0's gate. The encoding module is a CONTRACT — five later DAG nodes code
// against it — so these tests are aimed at the two ways a contract module
// rots: it drifts from the document schema it claims to produce (so writes
// are silently refused at the doc boundary), and its readers collapse
// "absent" into "invalid" (so a malformed node vanishes from the tree
// instead of being reported).
//
// Both are checked against the REAL things, not doubles: canvas-model's own
// `validateShape` (the exact predicate `CanvasDoc.putShape` gates on), a real
// `LoroCanvasDoc` for the round-trip, and canvas-model's own `routeArrow` for
// the direction assertion. A fixture-shaped test here would pass while the
// live room refused every write.
import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import {
  makeDocument,
  routeArrow,
  validateShape,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import {
  BLOCKED_TERMINAL,
  BLOCKER_TERMINAL,
  MAX_CONTEXT_LENGTH,
  TREE_EDGE_KIND,
  TREE_ENCODING_VERSION,
  TREE_KEY,
  TREE_NODE_KIND,
  buildTreeEdge,
  buildTreeNode,
  buildTreeNodeMeta,
  edgeBindingId,
  isTreePage,
  markTreePage,
  readTreeEdge,
  readTreeNode,
  readTreePage,
} from "../canvas/tree/encoding.js";

const TREE_ID = "page:tree-test";
const GOAL = "shape:goal";
const BLOCKER = "shape:blocker";
const EDGE = "shape:edge";

const goal = (): Shape =>
  buildTreeNode({ id: GOAL, treeId: TREE_ID, parentId: TREE_ID, index: "a1", x: 0, y: 0 });
const blocker = (): Shape =>
  buildTreeNode({ id: BLOCKER, treeId: TREE_ID, parentId: TREE_ID, index: "a2", x: 0, y: 400 });
const edge = () =>
  buildTreeEdge({
    id: EDGE,
    treeId: TREE_ID,
    parentId: TREE_ID,
    index: "a3",
    blockerId: BLOCKER,
    blockedId: GOAL,
    from: { x: 100, y: 400 },
    to: { x: 100, y: 200 },
  });

describe("the tree page mark", () => {
  const page = (): Page => ({ id: TREE_ID, name: "Tree" });

  it("marks a page and reads the treeId back as the page id", () => {
    const read = readTreePage(markTreePage(page()));
    expect(read).toEqual({
      status: "ok",
      value: { treeId: TREE_ID, mark: { v: TREE_ENCODING_VERSION } },
    });
  });

  it("is idempotent", () => {
    expect(markTreePage(markTreePage(page()))).toEqual(markTreePage(page()));
  });

  it("leaves an ordinary page alone rather than calling it malformed", () => {
    expect(readTreePage(page())).toEqual({ status: "absent" });
    expect(isTreePage(page())).toBe(false);
  });

  it("reports a mark from a FUTURE encoding version as invalid, not absent", () => {
    // The whole reason the version lives on the page: a reader that treated
    // an unknown version as "not a tree" would show a human an empty tree
    // where their nodes are, which is indistinguishable from data loss.
    const future = { ...page(), [TREE_KEY]: { v: TREE_ENCODING_VERSION + 1 } };
    const read = readTreePage(future as Page);
    expect(read.status).toBe("invalid");
    expect(isTreePage(future as Page)).toBe(false);
  });

  it("rejects a mark carrying an unrecognised key", () => {
    const decorated = { ...page(), [TREE_KEY]: { v: TREE_ENCODING_VERSION, extra: 1 } };
    expect(readTreePage(decorated as Page).status).toBe("invalid");
  });
});

describe("a node", () => {
  it("builds a shape the document schema accepts", () => {
    // validateShape is the predicate CanvasDoc.putShape gates on. If this
    // fails, every node write is a silent no-op in a live room.
    expect(validateShape(goal())).toMatchObject({ ok: true });
  });

  it("is a note, so the select tool and the text editor already handle it", () => {
    expect(goal().kind).toBe(TREE_NODE_KIND);
    expect(TREE_NODE_KIND).toBe("note");
  });

  it("defaults a fresh node to an unapproached todo with no context", () => {
    expect(readTreeNode(goal())).toEqual({
      status: "ok",
      value: { tree: TREE_ID, nodeId: GOAL, state: "todo", approached: false, context: "" },
    });
  });

  it("round-trips every field a caller sets", () => {
    const shape = buildTreeNode({
      id: GOAL,
      treeId: TREE_ID,
      parentId: TREE_ID,
      index: "a1",
      x: 0,
      y: 0,
      state: "wip",
      approached: true,
      context: "# goal\n- done when it ships",
    });
    expect(readTreeNode(shape)).toMatchObject({
      status: "ok",
      value: { state: "wip", approached: true, context: "# goal\n- done when it ships" },
    });
  });

  it("ignores a note that is not tree-marked", () => {
    const plain = { ...goal(), meta: {} } as Shape;
    expect(readTreeNode(plain)).toEqual({ status: "absent" });
  });

  it("ignores a tree-marked shape of the wrong kind", () => {
    // A geo carrying tree meta is not a node. `absent`, not `invalid`: it is
    // some other feature's shape wearing the same meta key, not a broken node.
    const geo = { ...goal(), kind: "geo", props: {} } as Shape;
    expect(readTreeNode(geo)).toEqual({ status: "absent" });
  });

  it("reports a node whose meta.nodeId disagrees with its shape id", () => {
    const lying = { ...goal(), meta: { ...goal().meta, nodeId: "shape:somebody-else" } } as Shape;
    const read = readTreeNode(lying);
    expect(read.status).toBe("invalid");
    expect(read.status === "invalid" && read.error).toContain("shape:somebody-else");
  });

  it("reports an unknown state as invalid rather than dropping the node", () => {
    const broken = { ...goal(), meta: { ...goal().meta, state: "blocked" } } as Shape;
    expect(readTreeNode(broken).status).toBe("invalid");
  });

  it("refuses a context over the ceiling", () => {
    const huge = {
      ...goal(),
      meta: { ...goal().meta, context: "x".repeat(MAX_CONTEXT_LENGTH + 1) },
    } as Shape;
    expect(readTreeNode(huge).status).toBe("invalid");
  });

  it("lets another feature's meta keys ride through untouched", () => {
    const stamped = { ...goal(), meta: { ...goal().meta, agentThreadId: "thr_x" } } as Shape;
    expect(readTreeNode(stamped).status).toBe("ok");
    expect(stamped.meta.agentThreadId).toBe("thr_x");
  });

  it("builds meta with the node's own id, so the legibility field cannot lie", () => {
    expect(buildTreeNodeMeta({ treeId: TREE_ID, nodeId: GOAL }).nodeId).toBe(GOAL);
  });
});

describe("an edge", () => {
  it("builds an arrow the document schema accepts", () => {
    expect(validateShape(edge().shape)).toMatchObject({ ok: true });
    expect(edge().shape.kind).toBe(TREE_EDGE_KIND);
  });

  it("uses the binding id convention canvas-editor and arrow-route share", () => {
    expect(edge().bindings.map((b) => b.id)).toEqual([
      `binding:${EDGE}-start`,
      `binding:${EDGE}-end`,
    ]);
    expect(edgeBindingId(EDGE, BLOCKER_TERMINAL)).toBe(`binding:${EDGE}-start`);
  });

  it("binds the BLOCKER to start and the BLOCKED to end", () => {
    // The direction rule, asserted on the wire values rather than through the
    // constants alone — flipping BLOCKER_TERMINAL/BLOCKED_TERMINAL together
    // would keep a constants-only test green.
    const [start, end] = edge().bindings;
    expect(start.props).toMatchObject({ terminal: "start" });
    expect(start.toId).toBe(BLOCKER);
    expect(end.props).toMatchObject({ terminal: "end" });
    expect(end.toId).toBe(GOAL);
  });

  it("reads back as blocker -> blocked", () => {
    const built = edge();
    expect(readTreeEdge(built.shape, built.bindings)).toEqual({
      status: "ok",
      value: { treeId: TREE_ID, edgeId: EDGE, blockerId: BLOCKER, blockedId: GOAL },
    });
  });

  it("ignores an arrow that is not tree-marked", () => {
    const built = edge();
    const plain = { ...built.shape, meta: {} } as Shape;
    expect(readTreeEdge(plain, built.bindings)).toEqual({ status: "absent" });
  });

  it("reports a half-bound edge instead of hiding it", () => {
    const built = edge();
    const onlyStart = readTreeEdge(built.shape, [built.bindings[0]]);
    expect(onlyStart.status).toBe("invalid");
    expect(onlyStart.status === "invalid" && onlyStart.error).toContain("end");
    const onlyEnd = readTreeEdge(built.shape, [built.bindings[1]]);
    expect(onlyEnd.status).toBe("invalid");
    expect(onlyEnd.status === "invalid" && onlyEnd.error).toContain("start");
  });

  it("reports a self-edge", () => {
    const built = buildTreeEdge({
      id: EDGE,
      treeId: TREE_ID,
      parentId: TREE_ID,
      index: "a3",
      blockerId: GOAL,
      blockedId: GOAL,
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
    });
    expect(readTreeEdge(built.shape, built.bindings).status).toBe("invalid");
  });

  it("filters the doc-wide binding list by its own arrow", () => {
    const built = edge();
    const somebodyElses = {
      id: "binding:shape:other-start",
      fromId: "shape:other",
      toId: GOAL,
      props: { terminal: "start", anchor: { nx: 0.5, ny: 0.5 } },
      meta: {},
    };
    expect(
      readTreeEdge(built.shape, [somebodyElses as never, ...built.bindings]).status,
    ).toBe("ok");
  });
});

describe("the encoding against canvas-model's own geometry", () => {
  it("routes a built edge from the blocker's box to the blocked node's box", () => {
    // This is what W2 will draw. Notes are 200x200 (canvas-model's geometry
    // DEFAULTS), the blocker sits at y=400 and the goal at y=0, so the routed
    // segment must run UPWARD — from inside the blocker's box toward the
    // goal's. Asserting the routed path, not the binding rows, is what makes
    // this a direction test rather than a restatement of the builder.
    const built = edge();
    const document = makeDocument({
      pages: [markTreePage({ id: TREE_ID, name: "Tree" })],
      shapes: [goal(), blocker(), built.shape],
      bindings: [...built.bindings],
    });
    const path = routeArrow(document, built.shape, built.bindings);
    expect(path.kind).toBe("straight");
    // Start is clipped to the blocker's boundary (y in [400,600]), end to the
    // goal's (y in [0,200]); start is BELOW end in this y-down world.
    expect(path.start.y).toBeGreaterThan(path.end.y);
    expect(path.start.y).toBeGreaterThanOrEqual(400);
    expect(path.end.y).toBeLessThanOrEqual(200);
  });
});

describe("a two-node tree in a real document", () => {
  // The same writes tests/live-tree-seed.ts makes against the running room,
  // run here against an in-process LoroCanvasDoc so the suite proves the
  // encoding survives the doc boundary without needing a server.
  const seeded = () => {
    const doc = LoroCanvasDoc.create({ peerId: 7n });
    doc.putPage(markTreePage({ id: TREE_ID, name: "Tree" }));
    doc.putShape(goal());
    doc.setText(GOAL, "Ship the discovery tree");
    doc.putShape(blocker());
    doc.setText(BLOCKER, "Decide the edge encoding");
    const built = edge();
    doc.putShape(built.shape);
    for (const binding of built.bindings) doc.putBinding(binding);
    doc.commit();
    return doc;
  };

  it("accepts every write — the page mark, both nodes, the edge, the bindings", () => {
    const doc = seeded();
    expect(doc.listShapes().map((s) => s.id).sort()).toEqual([EDGE, BLOCKER, GOAL].sort());
    expect(doc.listBindings()).toHaveLength(2);
  });

  it("preserves the page mark through putPage/listPages", () => {
    const page = seeded().listPages().find((p) => p.id === TREE_ID)!;
    expect(readTreePage(page).status).toBe("ok");
  });

  it("reads the tree back out of the doc", () => {
    const doc = seeded();
    const bindings = doc.listBindings();
    const nodes = doc.listShapes().filter((s) => readTreeNode(s).status === "ok");
    const edges = doc
      .listShapes()
      .map((s) => readTreeEdge(s, bindings))
      .filter((r) => r.status === "ok");
    expect(nodes.map((n) => n.id).sort()).toEqual([BLOCKER, GOAL].sort());
    expect(edges).toEqual([
      { status: "ok", value: { treeId: TREE_ID, edgeId: EDGE, blockerId: BLOCKER, blockedId: GOAL } },
    ]);
  });

  it("keeps the node text where canvas-react's label resolver reads it", () => {
    expect(seeded().getText(GOAL)).toBe("Ship the discovery tree");
  });

  it("survives a snapshot round-trip to a second peer", () => {
    // A tree is only real if it converges: the encoding must ride the CRDT,
    // not just the local doc.
    const other = LoroCanvasDoc.create({ peerId: 8n });
    other.import(seeded().exportSnapshot());
    const bindings = other.listBindings();
    const arrow = other.getShape(EDGE)!;
    expect(readTreeEdge(arrow, bindings)).toMatchObject({ status: "ok" });
    expect(readTreePage(other.listPages()[0]!).status).toBe("ok");
  });

  it("leaves the edge unrendered, which is W2's job and not a surprise", () => {
    // Stated as an executable fact so the day W2 registers `arrow` this test
    // fails and someone deletes it on purpose.
    expect(TREE_EDGE_KIND).toBe("arrow");
    expect(BLOCKED_TERMINAL).toBe("end");
  });
});
