import { describe, expect, it } from "vitest";
import { parseWorkflowGraph, type WorkflowGraph } from "../dot/graph";
import { runEngine } from "../engine/engine";
import type { Checkpoint, Handler, HandlerRegistry, Outcome, RunEvent } from "../engine/types";
import { PLAN_IMPLEMENT_REVIEW, PARALLEL_REVIEW } from "./fixtures/appendix-graphs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function graphFrom(dot: string): WorkflowGraph {
  return parseWorkflowGraph(dot);
}

function succeedHandler(overrides: Partial<Outcome> = {}): Handler {
  return { run: async () => ({ status: "succeeded", ...overrides }) };
}

function baseHandlers(overrides: Partial<HandlerRegistry> = {}): HandlerRegistry {
  return {
    start: succeedHandler(),
    exit: succeedHandler(),
    agent: succeedHandler(),
    prompt: succeedHandler(),
    command: succeedHandler(),
    human: succeedHandler(),
    conditional: succeedHandler(),
    parallel: succeedHandler(),
    "parallel.fan_in": succeedHandler(),
    ...overrides,
  };
}

/** A deterministic clock: sleep() advances the virtual clock instantly and records the requested delay. */
function makeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number, _signal: AbortSignal) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    sleeps,
    tick(ms: number) {
      now += ms;
    },
  };
}

function collector(): { events: RunEvent[]; onEvent(e: RunEvent): void } {
  const events: RunEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

const NEVER_ABORT = new AbortController().signal;

// ---------------------------------------------------------------------------
// Full event-sequence walk of the PlanImplementReview example
// ---------------------------------------------------------------------------

describe("engine: PlanImplementReview example, full event sequence", () => {
  function project(e: RunEvent): unknown {
    switch (e.type) {
      case "run.started":
        return { type: e.type };
      case "run.completed":
        return { type: e.type, status: e.status, goalGateFailures: e.goalGateFailures };
      case "stage.started":
        return { type: e.type, nodeId: e.nodeId, visit: e.visit, attempt: e.attempt };
      case "stage.completed":
        return { type: e.type, nodeId: e.nodeId, visit: e.visit, attempt: e.attempt, outcomeStatus: e.outcome.status };
      case "edge.selected":
        return { type: e.type, from: e.from, to: e.to, reason: e.reason };
      default:
        return { type: e.type };
    }
  }

  it("revises the plan once, fails the test once, then reaches exit — exact event sequence", async () => {
    const graph = graphFrom(PLAN_IMPLEMENT_REVIEW);
    let approveCalls = 0;
    let implementCalls = 0;
    let testCalls = 0;
    let reviewCalls = 0;

    const handlers = baseHandlers({
      human: {
        run: async () => {
          approveCalls += 1;
          return approveCalls === 1
            ? { status: "succeeded", preferredLabel: "Revise" }
            : { status: "succeeded", preferredLabel: "Approve" };
        },
      },
      command: {
        run: async () => {
          testCalls += 1;
          return testCalls === 1 ? { status: "failed" } : { status: "succeeded" };
        },
      },
      agent: {
        run: async (input) => {
          if (input.node.id === "implement") {
            implementCalls += 1;
            return { status: "succeeded" };
          }
          if (input.node.id === "review") {
            reviewCalls += 1;
            return { status: "succeeded", preferredLabel: "Accept" };
          }
          return { status: "succeeded" };
        },
      },
    });

    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers,
      runId: "run-1",
      clock,
      signal: NEVER_ABORT,
      onEvent,
    });

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
    expect(approveCalls).toBe(2);
    expect(implementCalls).toBe(2);
    expect(testCalls).toBe(2);
    expect(reviewCalls).toBe(1);

    expect(events.map(project)).toEqual([
      { type: "run.started" },
      { type: "stage.started", nodeId: "start", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "start", visit: 1, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "start", to: "plan", reason: "unconditional" },
      { type: "stage.started", nodeId: "plan", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "plan", visit: 1, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "plan", to: "approve", reason: "unconditional" },
      { type: "stage.started", nodeId: "approve", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "approve", visit: 1, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "approve", to: "plan", reason: "preferred_label" },
      { type: "stage.started", nodeId: "plan", visit: 2, attempt: 1 },
      { type: "stage.completed", nodeId: "plan", visit: 2, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "plan", to: "approve", reason: "unconditional" },
      { type: "stage.started", nodeId: "approve", visit: 2, attempt: 1 },
      { type: "stage.completed", nodeId: "approve", visit: 2, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "approve", to: "implement", reason: "preferred_label" },
      { type: "stage.started", nodeId: "implement", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "implement", visit: 1, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "implement", to: "test", reason: "unconditional" },
      { type: "stage.started", nodeId: "test", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "test", visit: 1, attempt: 1, outcomeStatus: "failed" },
      { type: "edge.selected", from: "test", to: "implement", reason: "condition" },
      { type: "stage.started", nodeId: "implement", visit: 2, attempt: 1 },
      { type: "stage.completed", nodeId: "implement", visit: 2, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "implement", to: "test", reason: "unconditional" },
      { type: "stage.started", nodeId: "test", visit: 2, attempt: 1 },
      { type: "stage.completed", nodeId: "test", visit: 2, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "test", to: "review", reason: "condition" },
      { type: "stage.started", nodeId: "review", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "review", visit: 1, attempt: 1, outcomeStatus: "succeeded" },
      { type: "edge.selected", from: "review", to: "exit", reason: "condition" },
      { type: "stage.started", nodeId: "exit", visit: 1, attempt: 1 },
      { type: "stage.completed", nodeId: "exit", visit: 1, attempt: 1, outcomeStatus: "succeeded" },
      { type: "run.completed", status: "succeeded", goalGateFailures: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// max_visits exhaustion
// ---------------------------------------------------------------------------

describe("engine: max_visits exhaustion", () => {
  it("skips a node once its visit limit is reached and fails the run when no retry target applies", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [max_visits=2]
      start -> a
      a -> a [condition="outcome=failed"]
      a -> exit [condition="outcome=succeeded"]
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "failed" }) });
    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(result.status).toBe("failed");
    const skipped = events.filter((e) => e.type === "stage.skipped");
    expect(skipped).toEqual([
      { type: "stage.skipped", runId: "r", ts: expect.any(Number), stageId: "a@3", nodeId: "a", reason: "max_visits_exceeded" },
    ]);
    // "exit" is never reached: outcome routes back to "a" every time it fails.
    expect(events.some((e) => e.type === "stage.started" && e.nodeId === "exit")).toBe(false);
  });

  it("reroutes to the completing node's configured retry_target once its normal edge target is exhausted", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      a [max_visits=1, retry_target="rescue"]
      rescue [shape=box]
      start -> a -> a
    }`);
    // "a" always succeeds and its only outgoing edge loops back to itself, but its
    // own max_visits (1) is already used up by the time that edge is chosen, so
    // routing falls back to a's retry_target instead of re-entering "a".
    let rescueCalls = 0;
    const handlers = baseHandlers({
      agent: {
        run: async (input) => {
          if (input.node.id === "rescue") rescueCalls += 1;
          return { status: "succeeded" };
        },
      },
    });
    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(rescueCalls).toBe(1);
    expect(result.status).toBe("succeeded");
    const retryEdges = events.filter((e) => e.type === "edge.selected" && e.reason === "retry_target");
    expect(retryEdges).toEqual([
      { type: "edge.selected", runId: "r", ts: expect.any(Number), from: "a", to: "rescue", reason: "retry_target" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Goal gates
// ---------------------------------------------------------------------------

describe("engine: goal gates", () => {
  it("fails the run when a visited goal-gated node's last outcome was not succeeded/partially_succeeded, even though the run reaches exit", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate [goal_gate=true]
      start -> gate -> exit
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "failed" }) });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("failed");
    expect(result.goalGateFailures).toEqual(["gate"]);
    expect(result.finalOutcome?.status).toBe("succeeded"); // exit itself succeeded; the gate is what fails the run
  });

  it("succeeds when the goal-gated node's last outcome was succeeded", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate [goal_gate=true]
      start -> gate -> exit
    }`);
    const handlers = baseHandlers();
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
  });

  it("a partially_succeeded last outcome also satisfies the gate", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      gate [goal_gate=true]
      start -> gate -> exit
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "partially_succeeded" }) });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("succeeded");
    expect(result.goalGateFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// on_failure policies
// ---------------------------------------------------------------------------

describe("engine: on_failure route/exit/succeed", () => {
  it("on_failure=exit ends the run on a failed outcome without ever reaching the exit node", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [on_failure="exit"]
      start -> a -> exit
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "failed" }) });
    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(result.status).toBe("failed");
    expect(result.finalOutcome).toEqual({ status: "failed" });
    expect(events.some((e) => e.type === "stage.started" && e.nodeId === "exit")).toBe(false);
  });

  it("on_failure=route falls through to the unconditional edge despite the failed outcome", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [on_failure="route"]
      start -> a -> exit
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "failed" }) });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("succeeded"); // reaches exit, which succeeds; no goal gates configured
  });

  it("on_failure=succeed rewrites the outcome for routing, selecting a succeeded-only conditional edge", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [on_failure="succeed"]
      start -> a
      a -> exit [condition="outcome=succeeded"]
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "failed" }) });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// Retries with a fake clock
// ---------------------------------------------------------------------------

describe("engine: retries", () => {
  it("retries a throwing handler with 1s/2s/4s delays, succeeding on the final attempt within max_retries", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [max_retries=2]
      start -> a -> exit
    }`);
    let calls = 0;
    const handlers = baseHandlers({
      agent: {
        run: async () => {
          calls += 1;
          if (calls < 3) throw new Error(`boom ${calls}`);
          return { status: "succeeded" };
        },
      },
    });
    const { clock, sleeps } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(result.status).toBe("succeeded");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 2000]);

    const failedEvents = events.filter((e) => e.type === "stage.failed");
    expect(failedEvents).toEqual([
      { type: "stage.failed", runId: "r", ts: expect.any(Number), stageId: "a@1", nodeId: "a", visit: 1, attempt: 1, error: "boom 1", willRetry: true },
      { type: "stage.failed", runId: "r", ts: expect.any(Number), stageId: "a@1", nodeId: "a", visit: 1, attempt: 2, error: "boom 2", willRetry: true },
    ]);
  });

  it("gives up after max_retries is exhausted, producing a failed outcome and no further retry", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [max_retries=1, on_failure="exit"]
      start -> a -> exit
    }`);
    let calls = 0;
    const handlers = baseHandlers({
      agent: {
        run: async () => {
          calls += 1;
          throw new Error("always fails");
        },
      },
    });
    const { clock, sleeps } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(calls).toBe(2); // initial attempt + 1 retry
    expect(sleeps).toEqual([1000]);
    expect(result.status).toBe("failed");
    const failedEvents = events.filter((e) => e.type === "stage.failed");
    expect(failedEvents.map((e) => (e as { willRetry: boolean }).willRetry)).toEqual([true, false]);
  });
});

// ---------------------------------------------------------------------------
// Parallel fan-out / fan-in
// ---------------------------------------------------------------------------

describe("engine: parallel fan-out", () => {
  it("gives each branch an isolated context copy and nests results under parallel.results only", async () => {
    const graph = graphFrom(PARALLEL_REVIEW);
    const handlers = baseHandlers({
      agent: {
        run: async (input) => {
          const seenBefore = input.context.get("shared_seen") ?? null;
          input.context.set("shared_seen", input.node.id);
          return { status: "succeeded", contextUpdates: { seenBefore } };
        },
      },
    });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("succeeded");
    const context = result.context as Record<string, unknown>;
    // Each branch only ever sees its own pre-fork context ("seenBefore: null" for
    // all three below), never another branch's write — proving isolation — even
    // though the shared main-walk context legitimately picks up later writes
    // (from "merge"/"summarise", which run after the branches converge).
    const parallel = context.parallel as { results: unknown[]; branch_count: number };
    expect(parallel.branch_count).toBe(3);
    expect(parallel.results).toEqual([
      { id: "security", index: 0, status: "succeeded", context_updates: { seenBefore: null } },
      { id: "architecture", index: 1, status: "succeeded", context_updates: { seenBefore: null } },
      { id: "quality", index: 2, status: "succeeded", context_updates: { seenBefore: null } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("engine: cancellation via AbortSignal", () => {
  it("returns cancelled immediately, without running any stage, when already aborted", async () => {
    const graph = graphFrom(`digraph G { start [shape=Mdiamond] exit [shape=Msquare] start -> exit }`);
    const controller = new AbortController();
    controller.abort();
    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers: baseHandlers(), runId: "r", clock, signal: controller.signal, onEvent });

    expect(result.status).toBe("cancelled");
    expect(events).toEqual([{ type: "run.cancelled", runId: "r", ts: expect.any(Number) }]);
  });

  it("stops advancing once a stage notices the signal was aborted mid-run", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [shape=box]
      start -> a -> exit
    }`);
    const controller = new AbortController();
    const handlers = baseHandlers({
      agent: {
        run: async () => {
          controller.abort(); // simulate an external cancel arriving while this stage is in flight
          return { status: "succeeded" };
        },
      },
    });
    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: controller.signal, onEvent });

    expect(result.status).toBe("cancelled");
    expect(events.some((e) => e.type === "stage.started" && e.nodeId === "exit")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "run.cancelled", runId: "r", ts: expect.any(Number) });
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe("engine: checkpoint save + resume", () => {
  it("saves a checkpoint after every non-terminal stage, but not after the terminal stage", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [shape=box]
      start -> a -> exit
    }`);
    const saved: Checkpoint[] = [];
    const { clock } = makeClock();
    await runEngine({
      graph,
      handlers: baseHandlers(),
      runId: "r",
      clock,
      signal: NEVER_ABORT,
      onEvent: () => {},
      checkpoint: { save: async (cp) => void saved.push(cp) },
    });

    expect(saved.map((cp) => cp.nextNodeId)).toEqual(["a", "exit"]);
  });

  it("resuming from a checkpoint replays nothing before nextNodeId and continues the walk from there", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      a [shape=box]
      start -> a -> exit
    }`);
    const saved: Checkpoint[] = [];
    const { clock: clock1 } = makeClock();
    await runEngine({
      graph,
      handlers: baseHandlers({ agent: succeedHandler({ text: "the plan" }) }),
      runId: "r",
      clock: clock1,
      signal: NEVER_ABORT,
      onEvent: () => {},
      checkpoint: { save: async (cp) => void saved.push(cp) },
    });

    const checkpointAfterA = saved.find((cp) => cp.nextNodeId === "exit")!;
    expect(checkpointAfterA).toBeDefined();

    // Resume: start/​a must never run again — their handlers throw if invoked.
    const explode: Handler = { run: async () => { throw new Error("must not be called on resume"); } };
    const { clock: clock2 } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({
      graph,
      handlers: baseHandlers({ start: explode, agent: explode }),
      runId: "r",
      clock: clock2,
      signal: NEVER_ABORT,
      onEvent,
      checkpoint: { save: async () => {}, load: checkpointAfterA },
    });

    expect(result.status).toBe("succeeded");
    expect(result.context.last_stage).toBe("exit");
    expect(result.context.response).toEqual({ a: "the plan" }); // carried over from the checkpointed context
    expect(events[0]).not.toEqual(expect.objectContaining({ type: "run.started" }));
    expect(events.filter((e) => e.type === "stage.started")).toHaveLength(1);
    expect(events.filter((e) => e.type === "stage.started")[0]).toMatchObject({ nodeId: "exit" });
  });
});

// ---------------------------------------------------------------------------
// Defensive: an unexpected engine-level error is reported as run.failed
// ---------------------------------------------------------------------------

describe("engine: run.failed for engine-level errors", () => {
  it("emits run.failed and a failed result when the graph has no start node", async () => {
    const graph = graphFrom(`digraph G { a [shape=box] }`);
    const { clock } = makeClock();
    const { events, onEvent } = collector();
    const result = await runEngine({ graph, handlers: baseHandlers(), runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(result.status).toBe("failed");
    expect(events).toEqual([{ type: "run.failed", runId: "r", ts: expect.any(Number), error: expect.stringContaining("no start node") }]);
  });
});
