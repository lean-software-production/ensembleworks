/**
 * Pure dagre-layout tests for ui/dag.ts's `layoutGraph`, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5 acceptance: "layout
 * helper test (deterministic positions for a 5-node graph)". No DOM
 * involved — dagre itself needs none — so this runs under vitest's default
 * "node" environment (see vitest.config.ts), not jsdom.
 */

import { describe, expect, it } from "vitest";
import { layoutGraph } from "../../ui/dag";
import type { GraphView } from "../../server/contracts";

function node(id: string, overrides: Partial<GraphView["nodes"][number]> = {}): GraphView["nodes"][number] {
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null, ...overrides };
}

const LINEAR_GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [
    node("start", { handlerKind: "start", shape: "Mdiamond" }),
    node("plan", { handlerKind: "prompt", shape: "tab" }),
    node("approve", { handlerKind: "human", shape: "hexagon" }),
    node("implement", { handlerKind: "agent", shape: "box" }),
    node("exit", { handlerKind: "exit", shape: "Msquare" }),
  ],
  edges: [
    { from: "start", to: "plan", label: null, condition: null },
    { from: "plan", to: "approve", label: null, condition: null },
    { from: "approve", to: "implement", label: "[A] Approve", condition: null },
    { from: "implement", to: "exit", label: null, condition: null },
  ],
};

describe("layoutGraph", () => {
  it("is deterministic across repeated calls", () => {
    const first = layoutGraph(LINEAR_GRAPH);
    const second = layoutGraph(LINEAR_GRAPH);
    expect(second).toEqual(first);
  });

  it("returns one laid-out node per graph node, in the graph's own order, each with a positive size", () => {
    const laidOut = layoutGraph(LINEAR_GRAPH);
    expect(laidOut.nodes.map((n) => n.id)).toEqual(["start", "plan", "approve", "implement", "exit"]);
    for (const n of laidOut.nodes) {
      expect(n.width).toBeGreaterThan(0);
      expect(n.height).toBeGreaterThan(0);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("stacks a top-to-bottom chain with strictly increasing y and roughly equal x, by default (no direction given)", () => {
    const laidOut = layoutGraph(LINEAR_GRAPH);
    const ys = laidOut.nodes.map((n) => n.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    const xs = laidOut.nodes.map((n) => n.x);
    for (const x of xs) expect(Math.abs(x - xs[0])).toBeLessThan(1);
  });

  it("ignores the DOT graph's own rankdir and still lays out top-to-bottom by default", () => {
    // LINEAR_GRAPH's own rankdir is "TB"; declare "LR" on the graph itself to
    // prove the default direction below comes from layoutGraph's own
    // parameter, never graph.rankdir.
    const laidOut = layoutGraph({ ...LINEAR_GRAPH, rankdir: "LR" });
    const ys = laidOut.nodes.map((n) => n.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });

  it('lays a chain out with strictly increasing x when given direction "LR" — regardless of the graph\'s own declared rankdir', () => {
    const laidOut = layoutGraph(LINEAR_GRAPH, "LR");
    const xs = laidOut.nodes.map((n) => n.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  });

  it("produces one edge per graph edge, each with at least two routed points", () => {
    const laidOut = layoutGraph(LINEAR_GRAPH);
    expect(laidOut.edges).toHaveLength(4);
    expect(laidOut.edges.map((e) => [e.from, e.to])).toEqual([
      ["start", "plan"],
      ["plan", "approve"],
      ["approve", "implement"],
      ["implement", "exit"],
    ]);
    for (const e of laidOut.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
  });

  it("reports an overall canvas size that contains every node", () => {
    const laidOut = layoutGraph(LINEAR_GRAPH);
    for (const n of laidOut.nodes) {
      expect(n.x + n.width / 2).toBeLessThanOrEqual(laidOut.width + 1);
      expect(n.y + n.height / 2).toBeLessThanOrEqual(laidOut.height + 1);
    }
    expect(laidOut.width).toBeGreaterThan(0);
    expect(laidOut.height).toBeGreaterThan(0);
  });

  it("marks a loop edge (target rank <= source rank) as a back edge, and a forward edge as not one", () => {
    const laidOut = layoutGraph(LINEAR_GRAPH);
    for (const edge of laidOut.edges) expect(edge.isBackEdge).toBe(false);
  });

  it("identifies the dogfood graph's loop edges (approve->plan, check->implement, review->implement) as back edges", () => {
    const graph: GraphView = {
      rankdir: "LR",
      nodes: [
        node("start", { handlerKind: "start" }),
        node("plan", { handlerKind: "prompt" }),
        node("approve", { handlerKind: "human" }),
        node("implement", { handlerKind: "agent" }),
        node("check", { handlerKind: "command" }),
        node("review", { handlerKind: "conditional" }),
        node("exit", { handlerKind: "exit" }),
      ],
      edges: [
        { from: "start", to: "plan", label: null, condition: null },
        { from: "plan", to: "approve", label: null, condition: null },
        { from: "approve", to: "plan", label: "[R] Revise", condition: null },
        { from: "approve", to: "implement", label: "[A] Approve", condition: null },
        { from: "implement", to: "check", label: null, condition: null },
        { from: "check", to: "implement", label: "[R] Retry", condition: "outcome=failed" },
        { from: "check", to: "review", label: null, condition: "outcome=succeeded" },
        { from: "review", to: "implement", label: null, condition: "outcome=failed" },
        { from: "review", to: "exit", label: null, condition: "outcome=succeeded" },
      ],
    };
    const laidOut = layoutGraph(graph);
    const backEdgeOf = (from: string, to: string) => laidOut.edges.find((e) => e.from === from && e.to === to)!.isBackEdge;
    expect(backEdgeOf("approve", "plan")).toBe(true);
    expect(backEdgeOf("check", "implement")).toBe(true);
    expect(backEdgeOf("review", "implement")).toBe(true);
    expect(backEdgeOf("start", "plan")).toBe(false);
    expect(backEdgeOf("plan", "approve")).toBe(false);
    expect(backEdgeOf("approve", "implement")).toBe(false);
    expect(backEdgeOf("implement", "check")).toBe(false);
    expect(backEdgeOf("check", "review")).toBe(false);
    expect(backEdgeOf("review", "exit")).toBe(false);
  });

  const DOGFOOD_GRAPH: GraphView = {
    rankdir: "LR",
    nodes: [
      node("start", { handlerKind: "start" }),
      node("plan", { handlerKind: "prompt" }),
      node("approve", { handlerKind: "human" }),
      node("implement", { handlerKind: "agent" }),
      node("check", { handlerKind: "command" }),
      node("review", { handlerKind: "conditional" }),
      node("exit", { handlerKind: "exit" }),
    ],
    edges: [
      { from: "start", to: "plan", label: null, condition: null },
      { from: "plan", to: "approve", label: null, condition: null },
      { from: "approve", to: "plan", label: "[R] Revise", condition: null },
      { from: "approve", to: "implement", label: "[A] Approve", condition: null },
      { from: "implement", to: "check", label: null, condition: null },
      { from: "check", to: "implement", label: "[R] Retry", condition: "outcome=failed" },
      { from: "check", to: "review", label: null, condition: "outcome=succeeded" },
      { from: "review", to: "implement", label: null, condition: "outcome=failed" },
      { from: "review", to: "exit", label: null, condition: "outcome=succeeded" },
    ],
  };

  it("lays the dogfood graph's main path out with strictly increasing x when given direction \"LR\" and keeps check's y within one node height of implement/review, despite its loop edges", () => {
    const laidOut = layoutGraph(DOGFOOD_GRAPH, "LR");
    const byId = new Map(laidOut.nodes.map((n) => [n.id, n]));
    const mainPath = ["start", "plan", "approve", "implement", "check", "review", "exit"].map((id) => byId.get(id)!);
    for (let i = 1; i < mainPath.length; i++) expect(mainPath[i]!.x).toBeGreaterThan(mainPath[i - 1]!.x);

    const check = byId.get("check")!;
    const implement = byId.get("implement")!;
    const review = byId.get("review")!;
    expect(Math.abs(check.y - implement.y)).toBeLessThanOrEqual(check.height);
    expect(Math.abs(check.y - review.y)).toBeLessThanOrEqual(check.height);
  });

  it("lays the dogfood graph's main path out with strictly increasing y by default (TB) and keeps check's x within one node width of implement/review, despite its loop edges", () => {
    const laidOut = layoutGraph(DOGFOOD_GRAPH);
    const byId = new Map(laidOut.nodes.map((n) => [n.id, n]));
    const mainPath = ["start", "plan", "approve", "implement", "check", "review", "exit"].map((id) => byId.get(id)!);
    for (let i = 1; i < mainPath.length; i++) expect(mainPath[i]!.y).toBeGreaterThan(mainPath[i - 1]!.y);

    const check = byId.get("check")!;
    const implement = byId.get("implement")!;
    const review = byId.get("review")!;
    expect(Math.abs(check.x - implement.x)).toBeLessThanOrEqual(check.width);
    expect(Math.abs(check.x - review.x)).toBeLessThanOrEqual(check.width);
  });

  // Follow-up-1 fix for the dogfood-polish round-1 finding: the test above
  // ("lays the dogfood graph's main path out...") stays green whether or
  // not `layoutGraph` zero-weights back edges — the dogfood graph's own
  // ranks are already correct from `ranksep`/`nodesep` tuning alone, so it
  // cannot discriminate the two-pass mechanism from a no-op. This graph has
  // three back edges converging on `x` (`z->x`, `y->x`, `t->s` — `t->s`
  // does not target `x` but still pulls the shared rank-balancing pass) so
  // a single, uniformly-weighted dagre pass visibly bows the main path
  // (measured directly: x/y/z land at y=86/112/86, a 26px arc) while
  // zero-weighting those back edges on the second pass flattens it to a
  // single y for x, y and z. Confirmed RED against a reverted, single-pass
  // `layoutGraph` before writing the fix (see README "Deviations from the
  // plan").
  it("zero-weights back edges so a multi-loop graph's main path lands flat, not bowed by a uniform-weight dagre pass", () => {
    const graph: GraphView = {
      rankdir: "LR",
      nodes: [node("s", { handlerKind: "start" }), node("x"), node("y"), node("z"), node("t", { handlerKind: "exit" })],
      edges: [
        { from: "s", to: "x", label: null, condition: null },
        { from: "x", to: "y", label: null, condition: null },
        { from: "y", to: "z", label: null, condition: null },
        { from: "z", to: "t", label: null, condition: null },
        { from: "z", to: "x", label: null, condition: null },
        { from: "y", to: "x", label: null, condition: null },
        { from: "t", to: "s", label: null, condition: null },
      ],
    };
    // Explicit direction "LR": this test's whole premise (the bow shows up
    // in .y, the perpendicular axis) is specific to a left-to-right layout —
    // layoutGraph's own default direction is "TB" regardless of this
    // graph's declared rankdir, per the vertical-by-default restyle.
    const laidOut = layoutGraph(graph, "LR");
    const byId = new Map(laidOut.nodes.map((n) => [n.id, n]));
    // A single uniform-weight pass gives x/y/z distinct y's (86/112/86); the
    // fix's second, zero-weighted pass must collapse them to one shared y.
    expect(byId.get("x")!.y).toBe(byId.get("y")!.y);
    expect(byId.get("y")!.y).toBe(byId.get("z")!.y);
  });

  it("handles a fan-out/fan-in graph (parallel branches) without throwing", () => {
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [
        node("start", { handlerKind: "start" }),
        node("fork", { handlerKind: "parallel" }),
        node("security", { handlerKind: "prompt" }),
        node("quality", { handlerKind: "prompt" }),
        node("merge", { handlerKind: "parallel.fan_in" }),
        node("exit", { handlerKind: "exit" }),
      ],
      edges: [
        { from: "start", to: "fork", label: null, condition: null },
        { from: "fork", to: "security", label: null, condition: null },
        { from: "fork", to: "quality", label: null, condition: null },
        { from: "security", to: "merge", label: null, condition: null },
        { from: "quality", to: "merge", label: null, condition: null },
        { from: "merge", to: "exit", label: null, condition: null },
      ],
    };
    const laidOut = layoutGraph(graph);
    expect(laidOut.nodes).toHaveLength(6);
    expect(laidOut.edges).toHaveLength(6);
  });
});
