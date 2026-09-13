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
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, ...overrides };
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

  it("stacks a top-to-bottom (rankdir=TB) chain with strictly increasing y and roughly equal x", () => {
    const laidOut = layoutGraph(LINEAR_GRAPH);
    const ys = laidOut.nodes.map((n) => n.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    const xs = laidOut.nodes.map((n) => n.x);
    for (const x of xs) expect(Math.abs(x - xs[0])).toBeLessThan(1);
  });

  it("lays a left-to-right (rankdir=LR) chain out with strictly increasing x", () => {
    const laidOut = layoutGraph({ ...LINEAR_GRAPH, rankdir: "LR" });
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
