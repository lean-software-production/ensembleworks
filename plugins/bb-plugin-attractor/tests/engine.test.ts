import { afterEach, describe, expect, it } from "vitest";
import { parseWorkflowGraph, type WorkflowGraph } from "../dot/graph";
import { runEngine } from "../engine/engine";
import type { Checkpoint, Handler, HandlerRegistry, Outcome, RunEvent } from "../engine/types";
import { createHumanHandler } from "../handlers/human";
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

  it("falls through to fallback_retry_target when retry_target names a node that is itself visit-exhausted", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      a [on_failure="exit", retry_target="used", fallback_retry_target="rescue"]
      used [max_visits=1]
      rescue [shape=box]
      start -> used -> a
    }`);
    const seen: string[] = [];
    const handlers = baseHandlers({
      agent: {
        run: async (input) => {
          seen.push(input.node.id);
          return { status: input.node.id === "a" ? "failed" : "succeeded" };
        },
      },
    });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(seen).toContain("rescue");
    expect(result.status).toBe("succeeded");
  });

  it("a graph-level retry_target does not loop forever once the retry target itself succeeds with no route onward", async () => {
    const graph = graphFrom(`digraph G {
      graph [retry_target="rescue"]
      start  [shape=Mdiamond]
      exit   [shape=Msquare]
      build  [on_failure="exit"]
      rescue [shape=box]
      start -> build -> exit
    }`);
    let rescueRuns = 0;
    const controller = new AbortController();
    const handlers = baseHandlers({
      agent: {
        run: async (input) => {
          if (input.node.id === "rescue") {
            rescueRuns += 1;
            // Safety valve so a regression hangs this test for a few laps
            // instead of forever, rather than actually relying on it.
            if (rescueRuns > 5) controller.abort();
          }
          return { status: input.node.id === "build" ? "failed" : "succeeded" };
        },
      },
    });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: controller.signal, onEvent: () => {} });

    // "rescue" succeeds and has no outgoing edges, so per routing step 8 the
    // run must terminate with rescue's own outcome instead of re-consulting
    // the graph-level retry_target against itself forever.
    expect(rescueRuns).toBe(1);
    expect(result.status).toBe("succeeded");
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

  it("honours a goal_gate on a node executed inside a parallel branch (a branch node is a visited node)", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      fork  [shape=component]
      merge [shape=tripleoctagon]
      lint  [goal_gate=true]
      start -> fork
      fork -> lint
      lint -> merge
      merge -> exit
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ status: "failed" }) });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.goalGateFailures).toEqual(["lint"]);
    expect(result.status).toBe("failed");
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
    // Event-level stageId carries the attempt suffix ("a@1#1", "a@1#2", ...) so
    // two attempts of the same visit don't render as identical timeline rows;
    // the underlying identity (used for the handler/checkpoint) stays "a@1"
    // for both, per the plan's "#<attempt> only in events, never as identity".
    expect(failedEvents).toEqual([
      { type: "stage.failed", runId: "r", ts: expect.any(Number), stageId: "a@1#1", nodeId: "a", visit: 1, attempt: 1, error: "boom 1", willRetry: true },
      { type: "stage.failed", runId: "r", ts: expect.any(Number), stageId: "a@1#2", nodeId: "a", visit: 1, attempt: 2, error: "boom 2", willRetry: true },
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

  it("honours a fork node's max_parallel by never running more branches concurrently than the cap", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      fork  [shape=component, max_parallel=2]
      merge [shape=tripleoctagon]
      b1 [shape=box]
      b2 [shape=box]
      b3 [shape=box]
      b4 [shape=box]
      start -> fork
      fork -> b1 -> merge
      fork -> b2 -> merge
      fork -> b3 -> merge
      fork -> b4 -> merge
      merge -> exit
    }`);
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const handlers = baseHandlers({
      agent: {
        run: async () => {
          inFlight += 1;
          started += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { status: "succeeded" };
        },
      },
    });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(started).toBe(4);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.status).toBe("succeeded");
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
// Defensive: engine writes must never pollute Object.prototype
// ---------------------------------------------------------------------------

describe("engine: last_outcome context key (T4: lets a conditional/diamond node mirror the preceding stage's outcome)", () => {
  it("writes context.last_outcome after every stage, readable by the next node's own outcome-based routing", async () => {
    // "check" (a diamond/conditional node with no prompt/script of its own) routes
    // by "outcome=succeeded|failed" on its own outgoing edges; per the Appendix's
    // BranchLoop example, its own handler must therefore be able to mirror
    // whatever the *previous* stage's outcome was, and `context.last_outcome` is
    // how it reads that.
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      build [shape=parallelogram, script="npm run build"]
      check [shape=diamond]
      fix   [prompt="fix it"]
      start -> build -> check
      check -> exit [condition="outcome=succeeded"]
      check -> fix  [condition="outcome=failed"]
    }`);
    let checkSawLastOutcome: unknown;
    const handlers = baseHandlers({
      command: succeedHandler({ status: "failed", text: "build output" }),
      conditional: {
        run: async (input) => ({ status: (input.context.get("last_outcome") as string) === "failed" ? "failed" : "succeeded" }),
      },
      agent: {
        run: async (input) => {
          checkSawLastOutcome = input.context.get("last_outcome");
          return { status: "succeeded" };
        },
      },
    });
    const { clock } = makeClock();
    const { onEvent } = collector();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent });

    // build failed -> check mirrors "failed" -> routes to fix, which itself then
    // observes check's own (mirrored) outcome as the new last_outcome.
    expect(checkSawLastOutcome).toBe("failed");
    // fix has no outgoing edge, so the run dead-ends on fix's own (succeeded)
    // outcome rather than reaching exit — this test is only about last_outcome.
    expect(result.status).toBe("succeeded");
  });
});

describe("engine: stage_status context key (T4: lets prompt assembly report each prior stage's outcome, not just the latest)", () => {
  it("writes context.stage_status.<nodeId> for every node it visits, keyed by node id rather than overwritten like last_outcome", async () => {
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      plan  [prompt="plan"]
      build [prompt="build"]
      start -> plan -> build -> exit
    }`);
    const handlers = baseHandlers({
      agent: {
        run: async (input) => ({ status: input.node.id === "plan" ? "failed" : "succeeded" }),
      },
    });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    const stageStatus = result.context.stage_status as Record<string, unknown>;
    // Default on_failure="route" lets the walk fall through plan's
    // unconditional edge to "build" despite plan's failure; both nodes' own
    // statuses must remain independently readable rather than one clobbering
    // the other (unlike last_outcome, which only ever holds the latest).
    expect(stageStatus.plan).toBe("failed");
    expect(stageStatus.build).toBe("succeeded");
  });
});

describe("engine: context writes never pollute Object.prototype", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted2;
  });

  it("running a workflow whose node id is __proto__.polluted2 does not leak onto Object.prototype", async () => {
    // engine.ts writes `response.<node.id>`; a node id containing "__proto__"
    // must not let that write reach through to Object.prototype, reachable
    // with no direct Context access at all.
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      "__proto__.polluted2" [shape=box]
      start -> "__proto__.polluted2"
    }`);
    const handlers = baseHandlers({ agent: succeedHandler({ text: "pwned" }) });
    const { clock } = makeClock();
    // The engine-level context write now throws on an unsafe path rather than
    // silently writing through; the run must still finish (as failed), not
    // pollute the prototype, and must not throw out of runEngine itself.
    const result = await runEngine({ graph, handlers, runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    const probe = {} as Record<string, unknown>;
    expect(probe.polluted2).toBeUndefined();
    expect(result.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Human gate routing (T6), driven end to end through the real engine with a
// fake HumanInterviewer standing in for server/human.ts's real bb.ui-backed
// one.
// ---------------------------------------------------------------------------

describe("engine: human gate routing", () => {
  const HUMAN_GATE_GRAPH = `digraph G {
    start [shape=Mdiamond]
    exit  [shape=Msquare]
    revise [label="Revise"]
    gate  [shape=hexagon, label="Approve plan?"]
    start -> gate
    gate -> exit   [label="[A] Approve"]
    gate -> revise [label="R) Revise"]
    revise -> exit
  }`;

  it("routes to the edge matching the human's chosen label via preferred_label", async () => {
    const graph = graphFrom(HUMAN_GATE_GRAPH);
    const human = createHumanHandler(
      { ask: async () => ({ kind: "choice", option: { raw: "[A] Approve", key: "A", text: "Approve", to: "exit" } }) },
      { threadId: "thread-1" },
    );
    const { events, onEvent } = collector();
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers: baseHandlers({ human }), runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(result.status).toBe("succeeded");
    expect(events).toContainEqual(expect.objectContaining({ type: "edge.selected", from: "gate", to: "exit", reason: "preferred_label" }));
    expect(events.filter((e) => e.type === "human.requested")).toHaveLength(1);
    expect(events.filter((e) => e.type === "human.answered")).toHaveLength(1);
  });

  it("routes to a different edge when the human picks the other option", async () => {
    const graph = graphFrom(HUMAN_GATE_GRAPH);
    const human = createHumanHandler(
      { ask: async () => ({ kind: "choice", option: { raw: "R) Revise", key: "R", text: "Revise", to: "revise" } }) },
      { threadId: "thread-1" },
    );
    const { events, onEvent } = collector();
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers: baseHandlers({ human }), runId: "r", clock, signal: NEVER_ABORT, onEvent });

    expect(result.status).toBe("succeeded");
    expect(events).toContainEqual(expect.objectContaining({ type: "edge.selected", from: "gate", to: "revise", reason: "preferred_label" }));
  });

  it("falls back to the human.default_choice context value on a timeout and still routes correctly", async () => {
    const graph = graphFrom(HUMAN_GATE_GRAPH);
    const human = createHumanHandler({ ask: async () => ({ kind: "timeout" }) }, { threadId: "thread-1" });
    const { clock } = makeClock();
    const result = await runEngine({
      graph,
      handlers: baseHandlers({ human }),
      runId: "r",
      initialContext: { human: { default_choice: "[A] Approve" } },
      clock,
      signal: NEVER_ABORT,
      onEvent: () => {},
    });

    expect(result.status).toBe("succeeded");
  });

  it("fails the run when the human gate times out with nothing to fall back to", async () => {
    // `on_failure="exit"` so the gate's failed outcome actually ends the run
    // (step 5) instead of falling through to step 6's unconditional edges —
    // both outgoing edges here carry only a `label`, no `condition`, so
    // without this they'd still be picked as "unconditional" per the routing
    // cascade even though the stage itself failed.
    const graph = graphFrom(`digraph G {
      start [shape=Mdiamond]
      exit  [shape=Msquare]
      revise [label="Revise"]
      gate  [shape=hexagon, label="Approve plan?", on_failure="exit"]
      start -> gate
      gate -> exit   [label="[A] Approve"]
      gate -> revise [label="R) Revise"]
      revise -> exit
    }`);
    const human = createHumanHandler({ ask: async () => ({ kind: "timeout" }) }, { threadId: "thread-1" });
    const { clock } = makeClock();
    const result = await runEngine({ graph, handlers: baseHandlers({ human }), runId: "r", clock, signal: NEVER_ABORT, onEvent: () => {} });

    expect(result.status).toBe("failed");
    expect(result.finalOutcome?.failureReason).toMatch(/default_choice/);
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
