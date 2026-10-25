import { describe, expect, it } from "vitest";
import { parseWorkflowGraph } from "../dot/graph";
import { validate } from "../dot/validate";
import { PLAN_IMPLEMENT_REVIEW, PARALLEL_REVIEW, BRANCH_LOOP } from "./fixtures/appendix-graphs";
import { FABRO_REFACTOR_SIMPLE, FABRO_REFACTOR_GOAL_GATED } from "./fixtures/fabro-graphs";

describe("dot front-end: appendix example graphs parse and validate cleanly", () => {
  it("PlanImplementReview", () => {
    const graph = parseWorkflowGraph(PLAN_IMPLEMENT_REVIEW);
    expect(graph.name).toBe("PlanImplementReview");
    expect(graph.rankdir).toBe("LR");
    expect(graph.nodes.get("start")?.handlerKind).toBe("start");
    expect(graph.nodes.get("exit")?.handlerKind).toBe("exit");
    expect(graph.nodes.get("approve")?.handlerKind).toBe("human");
    expect(graph.nodes.get("test")?.handlerKind).toBe("command");
    expect(graph.nodes.get("review")?.outputSchema).toBe("routing");
    expect(graph.nodes.get("implement")?.maxVisits).toBe(3);
    expect(validate(graph)).toEqual([]);
  });

  it("ParallelReview", () => {
    const graph = parseWorkflowGraph(PARALLEL_REVIEW);
    expect(graph.nodes.get("fork")?.handlerKind).toBe("parallel");
    expect(graph.nodes.get("merge")?.handlerKind).toBe("parallel.fan_in");
    expect(graph.edges.filter((e) => e.from === "fork")).toHaveLength(3);
    expect(validate(graph)).toEqual([]);
  });

  it("BranchLoop", () => {
    const graph = parseWorkflowGraph(BRANCH_LOOP);
    expect(graph.maxNodeVisits).toBe(4);
    expect(graph.onFailure).toBe("route");
    expect(graph.nodes.get("check")?.handlerKind).toBe("conditional");
    expect(graph.nodes.get("build")?.goalGate).toBe(true);
    expect(validate(graph)).toEqual([]);
  });
});

describe("dot front-end: real Fabro workflow graphs parse and validate cleanly", () => {
  it("the simple (max_visits-gated) refactor graph", () => {
    const graph = parseWorkflowGraph(FABRO_REFACTOR_SIMPLE);
    expect(graph.name).toBe("RefactorCodeQuality");
    expect(graph.onFailure).toBe("exit");
    expect(graph.nodes.get("validate")?.retryTarget).toBe("attempt");
    expect(graph.nodes.get("attempt")?.timeoutMs).toBe(20 * 60_000); // inherited from node[] default
    expect(validate(graph)).toEqual([]);
  });

  it("the goal-gated refactor graph", () => {
    const graph = parseWorkflowGraph(FABRO_REFACTOR_GOAL_GATED);
    expect(graph.nodes.get("plan")?.goalGate).toBe(true);
    expect(graph.nodes.get("review")?.outputSchema).toBe("routing");
    expect(validate(graph)).toEqual([]);
  });
});
