import { describe, expect, it } from "vitest";
import { parseWorkflowGraph } from "../dot/graph";
import { validate } from "../dot/validate";

function codes(source: string): string[] {
  return validate(parseWorkflowGraph(source)).map((d) => d.code);
}

const OK = 'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n->exit }';

describe("dot/validate", () => {
  it("accepts a well-formed graph with no diagnostics", () => {
    expect(validate(parseWorkflowGraph(OK))).toEqual([]);
  });

  it("flags a missing start node", () => {
    const graph = parseWorkflowGraph('digraph G { exit[shape=Msquare] n[prompt="p"] n->exit }');
    expect(codes('digraph G { exit[shape=Msquare] n[prompt="p"] n->exit }')).toContain("no-start-node");
    expect(validate(graph).find((d) => d.code === "no-start-node")?.severity).toBe("error");
  });

  it("flags two (or more) exit nodes", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit1[shape=Msquare] exit2[shape=Msquare] n[prompt="p"] start->n->exit1 n->exit2 }';
    expect(codes(source)).toContain("multiple-exit-nodes");
  });

  it("flags an unreachable node", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] orphan[prompt="p"] start->n->exit }';
    expect(codes(source)).toContain("unreachable-node");
  });

  it("flags an edge to a missing node", () => {
    // build the AST by hand isn't necessary: an edge chain always creates the node,
    // so we simulate a dangling reference via retry_target instead, and separately
    // exercise edge-to-missing-node through a crafted graph object.
    const graph = parseWorkflowGraph(OK);
    graph.edges.push({ from: "n", to: "ghost", weight: 0, freeform: false, attrs: {} });
    expect(validate(graph).map((d) => d.code)).toContain("edge-missing-target");
  });

  it("flags a bad condition expression", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n n->exit[condition="outcome="] }';
    expect(codes(source)).toContain("bad-condition");
  });

  it("flags an agent node without a prompt", () => {
    const source = "digraph G { start[shape=Mdiamond] exit[shape=Msquare] n start->n->exit }";
    expect(codes(source)).toContain("handler-missing-prompt");
  });

  it("flags a command node without a script", () => {
    const source = "digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[shape=parallelogram] start->n->exit }";
    expect(codes(source)).toContain("handler-missing-script");
  });

  it("does not flag a node whose quoted prompt is the numeric-looking string \"0\"", () => {
    const source = 'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="0"] start->n->exit }';
    expect(codes(source)).not.toContain("handler-missing-prompt");
  });

  it("flags a bad condition whose regex is syntactically invalid", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n n->exit[condition="context.x matches \\"[\\""] }';
    expect(codes(source)).toContain("bad-condition");
  });

  it("flags a missing retry target", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", retry_target="ghost"] start->n->exit }';
    expect(codes(source)).toContain("retry-target-missing");
  });

  it("flags a missing graph-level fallback retry target", () => {
    const source =
      'digraph G { graph[fallback_retry_target="ghost"] start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n->exit }';
    expect(codes(source)).toContain("retry-target-missing");
  });

  it("flags a condition on an edge from a selection=random node", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] fork[shape=component, selection=random] a[prompt="p"] start->fork fork->a[condition="outcome=succeeded"] a->exit }';
    expect(codes(source)).toContain("condition-on-random-selection");
  });

  it("does not flag a selection=random node's edges when they have no condition", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] fork[shape=component, selection=random] a[prompt="p"] start->fork fork->a a->exit }';
    expect(codes(source)).not.toContain("condition-on-random-selection");
  });

  it("flags a node-level on_failure value outside route|exit|succeed", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", on_failure=bogus] start->n->exit }';
    expect(codes(source)).toContain("invalid-enum-value");
  });

  it("flags a graph-level on_failure value outside route|exit|succeed", () => {
    const source =
      'digraph G { graph[on_failure=bogus] start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n->exit }';
    expect(codes(source)).toContain("invalid-enum-value");
  });

  it("flags a reasoning_effort value outside low|medium|high", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", reasoning_effort=ultra] start->n->exit }';
    expect(codes(source)).toContain("invalid-enum-value");
  });

  it("does not flag valid on_failure/reasoning_effort values", () => {
    const source =
      'digraph G { graph[on_failure=exit] start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", on_failure=succeed, reasoning_effort=high] start->n->exit }';
    expect(codes(source)).not.toContain("invalid-enum-value");
  });

  it("flags a non-numeric max_visits", () => {
    const source =
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", max_visits=abc] start->n->exit }';
    expect(codes(source)).toContain("invalid-numeric-value");
  });
});
