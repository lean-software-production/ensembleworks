// Run: npx vitest run tests/tree-service.test.ts
//
// W5's gate. The service is the QUERY SURFACE the server exposes over a live
// room's document: the agent tools (W6), the per-turn digest (W7), the write
// guards (W10) and `bb canvas tree` (W13) all ask their questions here rather
// than each rebuilding a tree from shapes.
//
// What these tests are actually aimed at, because they are the ways this
// layer goes wrong once it is between an agent and a human's canvas:
//
//  1. NO LEAKED INTERNALS. Every answer must be plain, serialisable data. A
//     `Shape` (or a `Map`) reaching an agent tool's JSON boundary either
//     throws at the wire or silently ships a document's worth of props.
//  2. A MISS IS DATA, NOT A THROW. "no such node" is the single most common
//     answer an agent gets — it holds ids from a turn ago, and the human has
//     since deleted one. A thrown error there is an agent-visible outage.
//  3. BOUNDED OUTPUT. `subtree` and `digest` are read by something with a
//     character budget (W7's 4096-char cap). A big tree must DEGRADE and SAY
//     it degraded, never blow the budget and never lie about being complete.
//  4. FRESHNESS. The document is a live CRDT; the service holds no cached
//     tree, so a shape written between two calls is visible to the second.
import { describe, expect, it } from "vitest";
import {
  makeDocument,
  type Binding,
  type CanvasDocument,
  type Page,
  type Shape,
} from "@ensembleworks/canvas-model";
import {
  buildTreeEdge,
  buildTreeNode,
  markTreePage,
  type NodeState,
} from "../canvas/tree/encoding.js";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { treeServiceForDoc } from "../canvas/tree/doc-source.js";
import {
  DIGEST_MAX_CHARS,
  createTreeService,
  type TreeQuery,
  type TreeService,
} from "../canvas/tree/service.js";
// The document builder these tests are written against — shared with W6's
// agent-tool suite so both read W0's encoding through one set of calls.
import {
  EXAMPLE,
  TREE,
  docOf,
  serviceOf,
  withTitle,
  type Spec,
} from "./lib/tree-fixture.js";

/** Assert a query answered, and hand back its value. A failure here prints
 * the service's own `detail`, which is the whole reason that field exists. */
const unwrap = <T>(result: TreeQuery<T>): T => {
  if (!result.ok) expect.unreachable(`query failed: ${result.reason} — ${result.detail}`);
  return result.value;
};

describe("node(id)", () => {
  it("answers with a flat, serialisable view of one node", () => {
    const view = unwrap<Record<string, unknown>>(
      serviceOf(EXAMPLE).node("shape:api") as never,
    );
    expect(view).toEqual({
      id: "shape:api",
      treeId: TREE,
      title: "Tree service",
      state: "wip",
      approached: false,
      context: "",
      parentIds: ["shape:goal"],
      childIds: ["shape:schema"],
      isRoot: false,
      isReady: false,
    });
    // JSON round-trips with nothing lost: no Map, no Shape, no undefined.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("finds a node without being told which tree it is in", () => {
    const doc = docOf(EXAMPLE);
    const second = docOf({ ...EXAMPLE, treeId: "page:other" });
    const merged = makeDocument({
      pages: [...doc.pages, ...second.pages],
      shapes: [...doc.shapes],
      bindings: [...doc.bindings],
    });
    const service = createTreeService({ document: () => merged });
    expect(unwrap<{ treeId: string }>(service.node("shape:goal") as never).treeId).toBe(TREE);
  });

  it("reports a missing node as data rather than throwing", () => {
    const result = serviceOf(EXAMPLE).node("shape:ghost");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("no-such-node");
    expect(result.ok === false && result.detail).toContain("shape:ghost");
  });

  it("marks a root as a root and a ready leaf as ready", () => {
    const service = serviceOf(EXAMPLE);
    const goal = unwrap<{ isRoot: boolean; isReady: boolean }>(service.node("shape:goal") as never);
    const schema = unwrap<{ isRoot: boolean; isReady: boolean }>(
      service.node("shape:schema") as never,
    );
    expect(goal.isRoot).toBe(true);
    expect(goal.isReady).toBe(false);
    expect(schema.isRoot).toBe(false);
    expect(schema.isReady).toBe(true);
  });

  // Caught by mutation: making `isReady` ignore `state` left every test green,
  // because the only done-leaf assertion went through `readyLeaves`. The view
  // is what an agent actually reads about ONE node, so it needs its own.
  it("does not call a done leaf ready", () => {
    const service = serviceOf({
      ...EXAMPLE,
      nodes: { ...EXAMPLE.nodes, "shape:ui": ["done", "Arrow renderer"] },
    });
    const done = unwrap<{ isReady: boolean; state: string }>(service.node("shape:ui") as never);
    expect(done.state).toBe("done");
    expect(done.isReady).toBe(false);
  });

  it("carries the node's context through unchanged", () => {
    const service = serviceOf({ ...EXAMPLE, context: { "shape:api": "## Goal\nRead the tree." } });
    expect(unwrap<{ context: string }>(service.node("shape:api") as never).context).toBe(
      "## Goal\nRead the tree.",
    );
  });
});

describe("children(id)", () => {
  it("answers with the nodes that BLOCK this one, ascending", () => {
    const kids = unwrap<{ id: string }[]>(serviceOf(EXAMPLE).children("shape:goal") as never);
    expect(kids.map((k) => k.id)).toEqual(["shape:api", "shape:ui"]);
  });

  it("answers with an empty list for a leaf, and a miss for a ghost", () => {
    const service = serviceOf(EXAMPLE);
    expect(unwrap<unknown[]>(service.children("shape:schema") as never)).toEqual([]);
    expect(service.children("shape:ghost").ok).toBe(false);
  });
});

describe("pathToRoot(id)", () => {
  it("answers node-first, root-last", () => {
    const path = unwrap<{ id: string }[]>(serviceOf(EXAMPLE).pathToRoot("shape:schema") as never);
    expect(path.map((n) => n.id)).toEqual(["shape:schema", "shape:api", "shape:goal"]);
  });

  it("answers a root with just itself", () => {
    const path = unwrap<{ id: string }[]>(serviceOf(EXAMPLE).pathToRoot("shape:goal") as never);
    expect(path.map((n) => n.id)).toEqual(["shape:goal"]);
  });

  it("refuses to invent a path out of a cycle", () => {
    const service = serviceOf({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const result = service.pathToRoot("shape:a");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("cycle");
  });
});

describe("subtree(id, depth)", () => {
  it("nests the blockers under the node they block", () => {
    const tree = unwrap<Record<string, unknown>>(
      serviceOf(EXAMPLE).subtree("shape:goal", 3) as never,
    );
    expect(tree).toMatchObject({
      node: { id: "shape:goal" },
      elided: null,
      children: [
        {
          node: { id: "shape:api" },
          elided: null,
          children: [{ node: { id: "shape:schema" }, children: [], elided: null }],
        },
        { node: { id: "shape:ui" }, children: [], elided: null },
      ],
    });
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
  });

  it("stops at the requested depth and says it stopped", () => {
    const tree = unwrap<{ children: { node: { id: string }; elided: string | null }[] }>(
      serviceOf(EXAMPLE).subtree("shape:goal", 1) as never,
    );
    expect(tree.children.map((c) => c.node.id)).toEqual(["shape:api", "shape:ui"]);
    // api still has a child below the cut; ui genuinely has none.
    expect(tree.children.map((c) => c.elided)).toEqual(["depth", null]);
  });

  it("depth 0 is the node alone, marked elided when it has blockers", () => {
    const tree = unwrap<{ children: unknown[]; elided: string | null }>(
      serviceOf(EXAMPLE).subtree("shape:goal", 0) as never,
    );
    expect(tree.children).toEqual([]);
    expect(tree.elided).toBe("depth");
  });

  it("terminates on a cycle and names it as the reason", () => {
    const service = serviceOf({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const tree = unwrap<{ children: { elided: string | null }[] }>(
      service.subtree("shape:a", 10) as never,
    );
    const elisions: string[] = [];
    const walk = (n: { elided: string | null; children: unknown[] }): void => {
      if (n.elided) elisions.push(n.elided);
      for (const child of n.children) walk(child as never);
    };
    walk(tree as never);
    expect(elisions).toContain("cycle");
  });

  it("reports a missing node rather than an empty subtree", () => {
    expect(serviceOf(EXAMPLE).subtree("shape:ghost", 2).ok).toBe(false);
  });
});

describe("ready(treeId)", () => {
  it("lists the work that can be picked up, ascending", () => {
    const leaves = unwrap<{ id: string }[]>(serviceOf(EXAMPLE).ready(TREE) as never);
    expect(leaves.map((l) => l.id)).toEqual(["shape:schema", "shape:ui"]);
  });

  it("drops a leaf once it is done", () => {
    const leaves = unwrap<{ id: string }[]>(
      serviceOf({ ...EXAMPLE, nodes: { ...EXAMPLE.nodes, "shape:ui": ["done", "Arrow renderer"] } })
        .ready(TREE) as never,
    );
    expect(leaves.map((l) => l.id)).toEqual(["shape:schema"]);
  });

  it("reports an unknown tree as data", () => {
    const result = serviceOf(EXAMPLE).ready("page:nope");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("no-such-tree");
  });

  it("still serves a tree whose page lost its mark, rather than hiding the nodes", () => {
    const result = serviceOf({ ...EXAMPLE, markPage: false }).ready(TREE);
    expect(result.ok).toBe(true);
    expect(unwrap<{ id: string }[]>(result as never).map((l) => l.id)).toEqual([
      "shape:schema",
      "shape:ui",
    ]);
  });
});

describe("trees()", () => {
  it("lists the marked pages, ascending", () => {
    const service = serviceOf({
      ...EXAMPLE,
      extraPages: [markTreePage({ id: "page:aaa", name: "Other" }), { id: "page:plain", name: "P" }],
    });
    expect(service.trees()).toEqual(["page:aaa", TREE]);
  });
});

describe("digest(treeId)", () => {
  it("summarises the tree as an outline a human or an agent can read", () => {
    const digest = unwrap<{ text: string; counts: Record<string, number>; truncated: boolean }>(
      serviceOf(EXAMPLE).digest(TREE) as never,
    );
    expect(digest.counts).toMatchObject({ nodes: 4, done: 0, wip: 1, todo: 3, edges: 3 });
    expect(digest.truncated).toBe(false);
    // The outline states structure and state, and marks what is startable.
    expect(digest.text).toContain("Ship discovery trees");
    expect(digest.text).toContain("Tree service");
    expect(digest.text).toMatch(/ready:.*shape:schema/);
  });

  it("names the roots and ready leaves as ids, not prose", () => {
    const digest = unwrap<{ roots: string[]; ready: string[] }>(
      serviceOf(EXAMPLE).digest(TREE) as never,
    );
    expect(digest.roots).toEqual(["shape:goal"]);
    expect(digest.ready).toEqual(["shape:schema", "shape:ui"]);
  });

  it("surfaces both structural and invariant problems", () => {
    const digest = unwrap<{ problems: { kind: string }[]; text: string }>(
      serviceOf({
        nodes: { "shape:a": "todo", "shape:b": "todo" },
        edges: [
          ["shape:a", "shape:b"],
          ["shape:b", "shape:a"],
        ],
      }).digest(TREE) as never,
    );
    expect(digest.problems.map((p) => p.kind)).toContain("cycle");
    expect(digest.text).toContain("cycle");
  });

  it("stays inside the character budget on a big tree, and says it truncated", () => {
    const nodes: Record<string, readonly [NodeState, string]> = {};
    const edges: (readonly [string, string])[] = [];
    for (let i = 0; i < 400; i += 1) {
      nodes[`shape:n${String(i).padStart(3, "0")}`] = ["todo", `Node number ${i} with a long title`];
      if (i > 0) edges.push([`shape:n${String(i).padStart(3, "0")}`, "shape:n000"]);
    }
    const digest = unwrap<{ text: string; truncated: boolean; counts: { nodes: number } }>(
      serviceOf({ nodes, edges }).digest(TREE) as never,
    );
    expect(digest.counts.nodes).toBe(400);
    expect(digest.truncated).toBe(true);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    // Degrading must keep the header — the counts are what orient a reader
    // when the outline is gone.
    expect(digest.text).toContain("400 nodes");
    expect(digest.text).toContain("not shown");
  });

  // Regression for the defect the budget test above found on first run: the
  // `ready:` line was itself unbounded, so a wide tree spent the whole budget
  // naming ready leaves and the hard-cut then sliced off the very note that
  // said the digest was incomplete.
  it("caps the ready list instead of letting it eat the whole budget", () => {
    const nodes: Record<string, NodeState> = { "shape:goal": "todo" };
    const edges: (readonly [string, string])[] = [];
    for (let i = 0; i < 60; i += 1) {
      nodes[`shape:leaf${String(i).padStart(2, "0")}`] = "todo";
      edges.push([`shape:leaf${String(i).padStart(2, "0")}`, "shape:goal"]);
    }
    const digest = unwrap<{ text: string; ready: string[]; truncated: boolean }>(
      serviceOf({ nodes, edges }).digest(TREE) as never,
    );
    const readyLine = digest.text.split("\n").find((line) => line.startsWith("ready:")) ?? "";
    expect(readyLine).toMatch(/and \d+ more/);
    expect(readyLine.length).toBeLessThan(DIGEST_MAX_CHARS / 2);
    // The prose is capped; the structured answer is still whole.
    expect(digest.ready).toHaveLength(60);
    expect(digest.truncated).toBe(true);
  });

  it("caps the problem list the same way", () => {
    const nodes: Record<string, NodeState> = {};
    const edges: (readonly [string, string])[] = [];
    // Thirty two-node cycles: 30 `cycle` problems, one tree.
    for (let i = 0; i < 30; i += 1) {
      const a = `shape:a${String(i).padStart(2, "0")}`;
      const b = `shape:b${String(i).padStart(2, "0")}`;
      nodes[a] = "todo";
      nodes[b] = "todo";
      edges.push([a, b], [b, a]);
    }
    const digest = unwrap<{ text: string; problems: { kind: string }[] }>(
      serviceOf({ nodes, edges }).digest(TREE) as never,
    );
    expect(digest.text).toMatch(/and \d+ more problems/);
    expect(digest.problems.length).toBeGreaterThanOrEqual(30);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  // Also caught by mutation: dropping `listsCut` from `truncated` stayed green
  // because every other truncation case ALSO trimmed the outline. This is the
  // case where the outline fits whole and only the ready list was cut — the
  // one place `listsCut` is the sole reason the text is incomplete.
  it("reports truncation when only a list was capped and the outline fits", () => {
    const nodes: Record<string, NodeState> = { "shape:goal": "todo" };
    const edges: (readonly [string, string])[] = [];
    for (let i = 0; i < 12; i += 1) {
      nodes[`shape:leaf${i}`] = "todo";
      edges.push([`shape:leaf${i}`, "shape:goal"]);
    }
    const digest = unwrap<{ text: string; truncated: boolean; counts: { nodes: number } }>(
      serviceOf({ nodes, edges }).digest(TREE) as never,
    );
    // Every node is in the outline...
    expect(digest.text).not.toContain("not shown");
    for (const id of Object.keys(nodes)) expect(digest.text).toContain(id);
    // ...and yet the digest is still not the whole truth, because `ready:` is.
    expect(digest.text).toMatch(/ready:.*and 2 more/);
    expect(digest.truncated).toBe(true);
  });

  it("honours a caller's tighter budget", () => {
    const digest = unwrap<{ text: string; truncated: boolean }>(
      serviceOf(EXAMPLE).digest(TREE, { maxChars: 120 }) as never,
    );
    expect(digest.text.length).toBeLessThanOrEqual(120);
    expect(digest.truncated).toBe(true);
  });

  it("reports an unknown tree as data", () => {
    expect(serviceOf(EXAMPLE).digest("page:nope").ok).toBe(false);
  });
});

describe("freshness", () => {
  it("reads the document again on every call, holding no cached tree", () => {
    let doc = docOf(EXAMPLE);
    const service = createTreeService({ document: () => doc });
    expect(unwrap<{ id: string }[]>(service.children("shape:api") as never).map((n) => n.id)).toEqual(
      ["shape:schema"],
    );
    doc = docOf({
      ...EXAMPLE,
      nodes: { ...EXAMPLE.nodes, "shape:extra": ["todo", "Late arrival"] },
      edges: [...EXAMPLE.edges, ["shape:extra", "shape:api"]],
    });
    expect(unwrap<{ id: string }[]>(service.children("shape:api") as never).map((n) => n.id)).toEqual(
      ["shape:extra", "shape:schema"],
    );
  });

  it("reads the document exactly once per call, so one answer cannot straddle two states", () => {
    let reads = 0;
    const doc = docOf(EXAMPLE);
    const service = createTreeService({
      document: () => {
        reads += 1;
        return doc;
      },
    });
    service.digest(TREE);
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The server seam
// ---------------------------------------------------------------------------

// The service above is proved against a fixture document. This proves the ONE
// line that points it at a live room's doc — a real LoroCanvasDoc, written
// through the same putPage/putShape/putBinding gate the room uses, so a
// mistake in the doc -> document conversion cannot hide behind a fixture that
// the reader itself built.
describe("treeServiceForDoc", () => {
  it("reads a tree out of a real CanvasDoc", () => {
    const doc = LoroCanvasDoc.create({ peerId: 7n });
    doc.putPage(markTreePage({ id: TREE, name: "Tree" }));
    const goal = withTitle(
      buildTreeNode({ id: "shape:goal", treeId: TREE, parentId: TREE, index: "a1", x: 0, y: 0 }),
      "Ship discovery trees",
    );
    const blocker = buildTreeNode({
      id: "shape:api",
      treeId: TREE,
      parentId: TREE,
      index: "a2",
      x: 200,
      y: 0,
      state: "wip",
    });
    doc.putShape(goal);
    doc.putShape(blocker);
    const edge = buildTreeEdge({
      id: "shape:edge",
      treeId: TREE,
      parentId: TREE,
      index: "b1",
      blockerId: "shape:api",
      blockedId: "shape:goal",
      from: { x: 0, y: 0 },
      to: { x: 200, y: 0 },
    });
    doc.putShape(edge.shape);
    for (const binding of edge.bindings) doc.putBinding(binding);
    doc.commit();

    const service = treeServiceForDoc(doc);
    expect(service.trees()).toEqual([TREE]);
    const view = unwrap<{ title: string; childIds: string[] }>(
      service.node("shape:goal") as never,
    );
    expect(view.title).toBe("Ship discovery trees");
    // Direction survives the real doc: the blocker is the CHILD of the goal.
    expect(view.childIds).toEqual(["shape:api"]);
    expect(unwrap<{ id: string }[]>(service.ready(TREE) as never).map((l) => l.id)).toEqual([
      "shape:api",
    ]);

    // And it is not a snapshot: a write after the service was built is seen.
    doc.putShape(
      buildTreeNode({ id: "shape:new", treeId: TREE, parentId: TREE, index: "a3", x: 400, y: 0 }),
    );
    doc.commit();
    expect(unwrap<{ id: string }[]>(service.ready(TREE) as never).map((l) => l.id)).toEqual([
      "shape:api",
      "shape:new",
    ]);
  });
});

// ---------------------------------------------------------------------------
// C1 rework — the frontier, and a character budget that cannot be starved
// ---------------------------------------------------------------------------

describe("readiness is about blockers, not leaves", () => {
  const FRONTIER: Spec = {
    nodes: { "shape:goal": ["todo", "Ship it"], "shape:api": ["done", "Tree service"] },
    edges: [["shape:api", "shape:goal"]],
  };

  it("calls a node with no unfinished blockers ready", () => {
    const goal = unwrap<{ isReady: boolean }>(serviceOf(FRONTIER).node("shape:goal") as never);
    expect(goal.isReady).toBe(true);
  });

  it("still has a frontier once the first layer is done", () => {
    const ready = unwrap<{ id: string }[]>(serviceOf(FRONTIER).ready(TREE) as never);
    expect(ready.map((n) => n.id)).toEqual(["shape:goal"]);
  });

  it("says so in the digest, which is what an agent is handed every turn", () => {
    const digest = unwrap<{ text: string; ready: string[] }>(
      serviceOf(FRONTIER).digest(TREE) as never,
    );
    expect(digest.ready).toEqual(["shape:goal"]);
    expect(digest.text).toMatch(/ready:.*shape:goal/);
  });
});

describe("the digest's budget is characters, not entries", () => {
  /** One 240-node cycle: ONE problem line naming 240 subjects. */
  const cyclic = (): Spec => {
    const id = (i: number) => `shape:c${String(i).padStart(3, "0")}`;
    const nodes: Record<string, NodeState> = {};
    const edges: (readonly [string, string])[] = [];
    for (let i = 0; i < 240; i += 1) {
      nodes[id(i)] = "todo";
      edges.push([id(i), id((i + 1) % 240)]);
    }
    return { nodes, edges };
  };

  it("keeps the ready line and the omission marker when one problem is enormous", () => {
    const digest = unwrap<{ text: string; truncated: boolean }>(
      serviceOf(cyclic()).digest(TREE) as never,
    );
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.truncated).toBe(true);
    // The two things a reader cannot afford to lose: what is startable, and
    // the admission that this is not the whole tree.
    expect(digest.text).toMatch(/^ready:/m);
    expect(digest.text).toContain("not shown");
  });

  it("cannot let one huge title spend the whole budget", () => {
    const digest = unwrap<{ text: string }>(
      serviceOf({
        nodes: {
          "shape:goal": ["todo", "T".repeat(5_000)],
          "shape:leaf": ["todo", "small"],
        },
        edges: [["shape:leaf", "shape:goal"]],
      }).digest(TREE) as never,
    );
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(digest.text).toMatch(/^ready:/m);
    // The oversized line is cut, and the line under it still gets its turn.
    expect(digest.text).toContain("shape:leaf");
  });

  // Mutation survivors, each caught by nothing until its own test existed:
  // dropping the per-line share, dropping the `…` a cut line ends with, and
  // demoting `ready` back below the problems. The first and third defend the
  // same property from different sides, so each masked the other.
  it("does not let one huge line cost the whole outline", () => {
    // Twelve ready ids of 400 characters each: the `ready:` line alone is
    // twice the whole budget, and the ten-entry cap does not shorten it.
    const nodes: Record<string, NodeState> = {};
    const edges: (readonly [string, string])[] = [];
    for (let i = 0; i < 12; i += 1) {
      nodes[`shape:${String(i).padStart(2, "0")}${"w".repeat(400)}`] = "todo";
    }
    const digest = unwrap<{ text: string }>(serviceOf({ nodes, edges }).digest(TREE) as never);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    // The outline still got its turn.
    expect(digest.text).toMatch(/^- shape:/m);
  });

  it("ends a cut line with an ellipsis, so the line itself says it was cut", () => {
    const digest = unwrap<{ text: string }>(
      serviceOf({
        nodes: { "shape:goal": ["todo", "T".repeat(5_000)], "shape:leaf": ["todo", "small"] },
        edges: [["shape:leaf", "shape:goal"]],
      }).digest(TREE) as never,
    );
    const goalLine = digest.text.split("\n").find((line) => line.includes("shape:goal")) ?? "";
    expect(goalLine.endsWith("…")).toBe(true);
  });

  it("keeps the frontier above the problems, however many problems there are", () => {
    // Twelve 30-node cycles: ten problem lines, each longer than its share.
    // Ranked below them, `ready:` never gets rendered at all.
    const nodes: Record<string, NodeState> = {};
    const edges: (readonly [string, string])[] = [];
    for (let c = 0; c < 12; c += 1) {
      const id = (i: number) => `shape:c${c}-n${String(i).padStart(2, "0")}`;
      for (let i = 0; i < 30; i += 1) {
        nodes[id(i)] = "todo";
        edges.push([id(i), id((i + 1) % 30)]);
      }
    }
    const digest = unwrap<{ text: string }>(serviceOf({ nodes, edges }).digest(TREE) as never);
    const lines = digest.text.split("\n");
    expect(lines[0]).toContain("360 nodes");
    expect(lines[1]).toMatch(/^ready:/);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it("never overshoots the budget, whatever the budget is", () => {
    for (const maxChars of [40, 120, 300, 1_000, DIGEST_MAX_CHARS]) {
      const digest = unwrap<{ text: string }>(
        serviceOf(cyclic()).digest(TREE, { maxChars }) as never,
      );
      expect(digest.text.length).toBeLessThanOrEqual(maxChars);
    }
  });
});
