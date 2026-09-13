import { describe, expect, it } from "vitest";
import { parseDot } from "../dot/parser";
import { buildWorkflowGraph, parseWorkflowGraph } from "../dot/graph";

describe("dot/graph: shape -> handler mapping", () => {
  it.each([
    ["Mdiamond", "start"],
    ["Msquare", "exit"],
    ["box", "agent"],
    ["tab", "prompt"],
    ["parallelogram", "command"],
    ["hexagon", "human"],
    ["diamond", "conditional"],
    ["component", "parallel"],
    ["tripleoctagon", "parallel.fan_in"],
  ] as const)("shape=%s -> handlerKind=%s", (shape, handlerKind) => {
    const graph = parseWorkflowGraph(`digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[shape=${shape}, prompt="p", script="s"] start->n->exit }`);
    expect(graph.nodes.get("n")?.handlerKind).toBe(handlerKind);
  });

  it("defaults to the agent handler for a node with no shape", () => {
    const graph = parseWorkflowGraph('digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n->exit }');
    expect(graph.nodes.get("n")?.handlerKind).toBe("agent");
    expect(graph.nodes.get("n")?.shape).toBe("box");
  });

  it("lets an explicit type= attribute override the shape", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[shape=box, type=command, script="s"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.handlerKind).toBe("command");
  });

  it("treats reserved ids as start/exit when no shape/type is given", () => {
    const graph = parseWorkflowGraph("digraph G { start exit start -> exit }");
    expect(graph.nodes.get("start")?.handlerKind).toBe("start");
    expect(graph.nodes.get("exit")?.handlerKind).toBe("exit");
    const graph2 = parseWorkflowGraph("digraph G { Start End Start -> End }");
    expect(graph2.nodes.get("Start")?.handlerKind).toBe("start");
    expect(graph2.nodes.get("End")?.handlerKind).toBe("exit");
  });
});

describe("dot/graph: attribute typing", () => {
  it("types graph-level attributes", () => {
    const graph = parseWorkflowGraph(
      'digraph G { graph [goal="Ship it", rankdir=LR, default_max_retries=2, on_failure="exit", max_node_visits=4] start[shape=Mdiamond] exit[shape=Msquare] start->exit }',
    );
    expect(graph.goal).toBe("Ship it");
    expect(graph.rankdir).toBe("LR");
    expect(graph.defaultMaxRetries).toBe(2);
    expect(graph.onFailure).toBe("exit");
    expect(graph.maxNodeVisits).toBe(4);
  });

  it("defaults graph rankdir and onFailure", () => {
    const graph = parseWorkflowGraph("digraph G { start[shape=Mdiamond] exit[shape=Msquare] start->exit }");
    expect(graph.rankdir).toBe("TB");
    expect(graph.onFailure).toBe("route");
    expect(graph.maxNodeVisits).toBe(0);
  });

  it("types node-level booleans, integers and durations", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", timeout="20m", max_visits=3, max_retries=2, goal_gate=true, allow_partial=false] start->n->exit }',
    );
    const n = graph.nodes.get("n")!;
    expect(n.timeoutMs).toBe(20 * 60_000);
    expect(n.maxVisits).toBe(3);
    expect(n.maxRetries).toBe(2);
    expect(n.goalGate).toBe(true);
    expect(n.allowPartial).toBe(false);
  });

  it("parses bare (unquoted) durations too", () => {
    const graph = parseWorkflowGraph(
      "digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[shape=parallelogram, script=cmd, timeout=250ms] start->n->exit }",
    );
    expect(graph.nodes.get("n")?.timeoutMs).toBe(250);
  });

  it("splits the class attribute into a classes array", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", class="expensive slow"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.classes).toEqual(["expensive", "slow"]);
  });

  it("keeps unknown attributes (e.g. selection) available on the raw attrs bag", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[shape=component, selection=random] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.attrs.selection).toBe("random");
  });

  it("types edge-level weight, freeform and condition", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] start->exit[weight=5, freeform=true, condition="outcome=succeeded", label="Go"] }',
    );
    const edge = graph.edges[0];
    expect(edge.weight).toBe(5);
    expect(edge.freeform).toBe(true);
    expect(edge.condition).toBe("outcome=succeeded");
    expect(edge.label).toBe("Go");
  });

  it("defaults edge weight to 0 and freeform to false", () => {
    const graph = parseWorkflowGraph("digraph G { start[shape=Mdiamond] exit[shape=Msquare] start->exit }");
    expect(graph.edges[0].weight).toBe(0);
    expect(graph.edges[0].freeform).toBe(false);
  });

  it("parses the routing output_schema keyword and JSON schema literals", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", output_schema="routing"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.outputSchema).toBe("routing");

    const graph2 = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", output_schema="{\\"type\\":\\"object\\"}"] start->n->exit }',
    );
    expect(graph2.nodes.get("n")?.outputSchema).toEqual({ type: "object" });
  });
});

describe("dot/graph: node/edge default scoping", () => {
  it("applies node[] and edge[] defaults to subsequent statements", () => {
    const graph = parseWorkflowGraph(
      'digraph G { node [timeout="10m"] edge [weight=2] start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.timeoutMs).toBe(10 * 60_000);
    expect(graph.edges[0].weight).toBe(2);
  });

  it("lets explicit node attributes override node[] defaults", () => {
    const graph = parseWorkflowGraph(
      'digraph G { node [timeout="10m"] start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", timeout="1m"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.timeoutMs).toBe(60_000);
  });

  it("scopes node[] defaults set inside a subgraph to that subgraph", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] subgraph c { node [shape=parallelogram] build[script="s"] } deploy[prompt="p"] start->build->deploy->exit }',
    );
    expect(graph.nodes.get("build")?.handlerKind).toBe("command");
    expect(graph.nodes.get("deploy")?.handlerKind).toBe("agent");
  });
});

describe("dot/graph: node/edge collection", () => {
  it("registers nodes implicitly referenced only by edges", () => {
    const ast = parseDot("digraph G { a -> b }");
    const graph = buildWorkflowGraph(ast);
    expect([...graph.nodes.keys()]).toEqual(["a", "b"]);
  });

  it("preserves node declaration order", () => {
    const graph = parseWorkflowGraph("digraph G { c b a c->b->a }");
    expect(graph.nodeOrder).toEqual(["c", "b", "a"]);
  });

  it("expands an edge chain a->b->c into two edges", () => {
    const graph = parseWorkflowGraph("digraph G { a -> b -> c }");
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b" });
    expect(graph.edges[1]).toMatchObject({ from: "b", to: "c" });
  });
});

describe("dot/graph: quoted scalars keep their string kind", () => {
  it("keeps a quoted numeric-looking label as a string", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[label="404", prompt="p"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.label).toBe("404");
    expect(typeof graph.nodes.get("n")?.label).toBe("string");
  });

  it("keeps a quoted numeric-looking prompt as a string (a prompt of \"0\" is still a prompt)", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="0"] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.prompt).toBe("0");
  });

  it("keeps a quoted numeric edge label as a string (numbered human-gate choices)", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] gate[shape=hexagon] a[prompt="p"] start->gate gate->a[label="1"] gate->exit[label="2"] a->exit }',
    );
    const edge = graph.edges.find((e) => e.from === "gate" && e.to === "a")!;
    expect(edge.label).toBe("1");
    expect(typeof edge.label).toBe("string");
    expect(() => (edge.label as string).replace(/^\[\w+\]\s*/, "")).not.toThrow();
  });

  it("keeps a quoted boolean-looking label as a string", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] start->exit[label="true"] }',
    );
    expect(graph.edges[0].label).toBe("true");
  });

  it("still coerces bare (unquoted) numeric and boolean attribute values", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", max_visits=3] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.maxVisits).toBe(3);
  });
});

describe("dot/graph: hyphenated bare values", () => {
  it("parses a bare hyphenated model id", () => {
    const graph = parseWorkflowGraph(
      'digraph G { start[shape=Mdiamond] exit[shape=Msquare] n[prompt="p", model=claude-sonnet-5] start->n->exit }',
    );
    expect(graph.nodes.get("n")?.model).toBe("claude-sonnet-5");
  });

  it("parses a bare negative edge weight", () => {
    const graph = parseWorkflowGraph(
      "digraph G { start[shape=Mdiamond] exit[shape=Msquare] start->exit[weight=-1] }",
    );
    expect(graph.edges[0].weight).toBe(-1);
  });
});
