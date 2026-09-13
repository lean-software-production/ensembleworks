import { describe, expect, it } from "vitest";
import { parseWorkflowGraph, type WorkflowGraph } from "../dot/graph";
import { selectRoute, selectRetryTargetCandidates } from "../engine/router";

// The engine walks the full candidate cascade (applying max_visits to each);
// these tests only care about its first existing entry.
const selectRetryTarget = (...args: Parameters<typeof selectRetryTargetCandidates>) => selectRetryTargetCandidates(...args)[0];
import type { Outcome } from "../engine/types";

function graphFrom(dot: string): WorkflowGraph {
  return parseWorkflowGraph(dot);
}

function outcome(overrides: Partial<Outcome> & { status: Outcome["status"] }): Outcome {
  return { ...overrides };
}

describe("engine/router: routing cascade steps 1-8", () => {
  it("step 1: jump_to_node bypasses edges entirely, even ones that would otherwise match", () => {
    const graph = graphFrom(`digraph G {
      a -> b [condition="outcome=succeeded"]
      a -> c
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", jumpToNode: "c" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "c", reason: "jump" });
  });

  it("step 1: a jump to a node not in the graph is ignored, falling through to normal edges", () => {
    const graph = graphFrom(`digraph G { a -> b }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", jumpToNode: "ghost" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "b", reason: "unconditional" });
  });

  it("step 2: a true conditional edge wins over an unconditional edge", () => {
    const graph = graphFrom(`digraph G {
      a -> b [condition="outcome=succeeded"]
      a -> c
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "b", reason: "condition" });
  });

  it("step 2: among matching conditional edges, highest weight wins", () => {
    const graph = graphFrom(`digraph G {
      a -> b [condition="outcome=succeeded", weight=1]
      a -> c [condition="outcome=succeeded", weight=5]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "c", reason: "condition" });
  });

  it("step 2: on a weight tie among matching conditional edges, lexicographically smallest target wins", () => {
    const graph = graphFrom(`digraph G {
      a -> zeta [condition="outcome=succeeded"]
      a -> beta [condition="outcome=succeeded"]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "beta", reason: "condition" });
  });

  it("step 2: conditions can read context. paths", () => {
    const graph = graphFrom(`digraph G {
      a -> b [condition="context.score > 3"]
      a -> c
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: { score: 5 },
    });
    expect(decision).toEqual({ nodeId: "b", reason: "condition" });
  });

  it("step 3: preferred_label matches an edge label, stripping accelerator prefixes on both sides", () => {
    const graph = graphFrom(`digraph G {
      a -> approve [label="[A] Approve"]
      a -> revise  [label="[R] Revise"]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", preferredLabel: "Approve" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "approve", reason: "preferred_label", edgeLabel: "[A] Approve" });
  });

  it("step 3: preferred_label with its own accelerator prefix still matches", () => {
    const graph = graphFrom(`digraph G { a -> approve [label="Approve"] }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", preferredLabel: "[A] Approve" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "approve", reason: "preferred_label", edgeLabel: "Approve" });
  });

  it("step 3: only one accelerator prefix is stripped, so a label whose text itself starts like one survives intact", () => {
    // "[A] B) Go" carries the "[A] " accelerator; its text is "B) Go". A human
    // gate hands back the raw label; a sequential strip would reduce both
    // sides to "Go" and match the wrong edge.
    const graph = graphFrom(`digraph G {
      a -> wrong [label="Go"]
      a -> right [label="[A] B) Go"]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", preferredLabel: "[A] B) Go" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "right", reason: "preferred_label", edgeLabel: "[A] B) Go" });
  });

  it("step 3: a legitimate label containing ')' is not mistaken for a 'K) ' accelerator prefix", () => {
    // "run(x) thing" has no leading accelerator at all, but its first word
    // happens to contain ')'; stripping must not treat "run(x" as the
    // accelerator key K and eat it, or this label collides with an
    // unrelated "thing"-labelled edge.
    const graph = graphFrom(`digraph G {
      a -> wrong   [label="thing"]
      a -> literal [label="run(x) thing"]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", preferredLabel: "run(x) thing" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "literal", reason: "preferred_label", edgeLabel: "run(x) thing" });
  });

  it("step 4: suggested_next_ids picks the first suggestion that names an outgoing edge target", () => {
    const graph = graphFrom(`digraph G { a -> b  a -> c }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", suggestedNextIds: ["ghost", "c", "b"] }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "c", reason: "suggested" });
  });

  it("step 3: preferred_label can select a conditional edge whose condition evaluated false in step 2", () => {
    const graph = graphFrom(`digraph G {
      a -> exit  [label="Accept", condition="context.mode = strict"]
      a -> other [label="Other"]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", preferredLabel: "Accept" }),
      context: { mode: "lenient" },
    });
    expect(decision).toEqual({ nodeId: "exit", reason: "preferred_label", edgeLabel: "Accept" });
  });

  it("step 4: suggested_next_ids can select a conditional edge whose condition evaluated false in step 2", () => {
    const graph = graphFrom(`digraph G {
      a -> exit  [condition="context.mode = strict"]
      a -> other
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded", suggestedNextIds: ["exit"] }),
      context: { mode: "lenient" },
    });
    expect(decision).toEqual({ nodeId: "exit", reason: "suggested" });
  });

  it("step 5 on_failure=route: a failed outcome with no matching edge falls through to unconditional edges", () => {
    const graph = graphFrom(`digraph G {
      graph [on_failure="route"]
      a -> b
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "failed" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "b", reason: "unconditional" });
  });

  it("step 5 on_failure=exit: a failed outcome skips unconditional edges (step 6 is not consulted)", () => {
    const graph = graphFrom(`digraph G {
      a [on_failure="exit"]
      a -> b
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "failed" }),
      context: {},
    });
    expect(decision).toBeNull();
  });

  it("step 5 on_failure=succeed: rewrites the outcome and re-runs 2-6, so a succeeded-only conditional edge now matches", () => {
    const graph = graphFrom(`digraph G {
      a [on_failure="succeed"]
      a -> b [condition="outcome=succeeded"]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "failed" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "b", reason: "condition" });
  });

  it("node-level on_failure overrides the graph default", () => {
    const graph = graphFrom(`digraph G {
      graph [on_failure="exit"]
      a [on_failure="route"]
      a -> b
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "failed" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "b", reason: "unconditional" });
  });

  it("step 6: a succeeded outcome with no conditional/preferred/suggested match takes the unconditional edge", () => {
    const graph = graphFrom(`digraph G { a -> b }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "b", reason: "unconditional" });
  });

  it("step 6: among unconditional edges, highest weight wins", () => {
    const graph = graphFrom(`digraph G {
      a -> b [weight=1]
      a -> c [weight=9]
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "c", reason: "unconditional" });
  });

  it("step 6: on a weight tie among unconditional edges, lexicographically smallest target wins", () => {
    const graph = graphFrom(`digraph G {
      a -> zeta
      a -> beta
    }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toEqual({ nodeId: "beta", reason: "unconditional" });
  });

  it("step 8: no outgoing edges at all yields null (caller terminates the run with this node's outcome)", () => {
    const graph = graphFrom(`digraph G { a [shape=box] }`);
    const decision = selectRoute({
      node: graph.nodes.get("a")!,
      graph,
      outcome: outcome({ status: "succeeded" }),
      context: {},
    });
    expect(decision).toBeNull();
  });
});

describe("engine/router: step 7 retry_target / fallback_retry_target resolution", () => {
  it("prefers the node's own retry_target", () => {
    const graph = graphFrom(`digraph G {
      graph [retry_target="graphTarget"]
      a [retry_target="nodeTarget", fallback_retry_target="nodeFallback"]
      nodeTarget [shape=box]
      nodeFallback [shape=box]
      graphTarget [shape=box]
    }`);
    expect(selectRetryTarget(graph.nodes.get("a")!, graph)).toBe("nodeTarget");
  });

  it("falls back to the node's fallback_retry_target when it has no retry_target", () => {
    const graph = graphFrom(`digraph G {
      a [fallback_retry_target="nodeFallback"]
      nodeFallback [shape=box]
    }`);
    expect(selectRetryTarget(graph.nodes.get("a")!, graph)).toBe("nodeFallback");
  });

  it("falls back to the graph's retry_target when the node has neither", () => {
    const graph = graphFrom(`digraph G {
      graph [retry_target="graphTarget"]
      a [shape=box]
      graphTarget [shape=box]
    }`);
    expect(selectRetryTarget(graph.nodes.get("a")!, graph)).toBe("graphTarget");
  });

  it("falls back to the graph's fallback_retry_target as a last resort", () => {
    const graph = graphFrom(`digraph G {
      graph [fallback_retry_target="graphFallback"]
      a [shape=box]
      graphFallback [shape=box]
    }`);
    expect(selectRetryTarget(graph.nodes.get("a")!, graph)).toBe("graphFallback");
  });

  it("skips a candidate that does not name an existing node and tries the next one", () => {
    const graph = graphFrom(`digraph G {
      graph [retry_target="graphTarget"]
      a [retry_target="ghost"]
      graphTarget [shape=box]
    }`);
    expect(selectRetryTarget(graph.nodes.get("a")!, graph)).toBe("graphTarget");
  });

  it("returns undefined when no retry target is configured anywhere", () => {
    const graph = graphFrom(`digraph G { a [shape=box] }`);
    expect(selectRetryTarget(graph.nodes.get("a")!, graph)).toBeUndefined();
  });

  it("selectRetryTargetCandidates exposes the full existing-node cascade, not just its first entry, so the engine can apply max_visits to each in turn", () => {
    const graph = graphFrom(`digraph G {
      graph [retry_target="graphTarget", fallback_retry_target="graphFallback"]
      a [retry_target="nodeTarget", fallback_retry_target="nodeFallback"]
      nodeTarget [shape=box]
      nodeFallback [shape=box]
      graphTarget [shape=box]
      graphFallback [shape=box]
    }`);
    expect(selectRetryTargetCandidates(graph.nodes.get("a")!, graph)).toEqual([
      "nodeTarget",
      "nodeFallback",
      "graphTarget",
      "graphFallback",
    ]);
  });
});
