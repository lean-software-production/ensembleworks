/**
 * `ui/run-model.ts` — the pure read model behind the redesigned run UI: the
 * pass grouping rule, progress wording, "Now", the attention card's states,
 * route lines, and the story/raw event readings.
 */
import { describe, expect, it } from "vitest";
import type { GraphView, RunView, StageView } from "../../server/contracts";
import {
  deriveAttention,
  eventMatches,
  gateChoices,
  graphHasLoop,
  groupPasses,
  nowView,
  progressOf,
  rawEventLine,
  routesFrom,
  statusPill,
  storyItems,
  waitSpansByStage,
  type EventView,
} from "../../ui/run-model";

let rowid = 0;
function stage(nodeId: string, visit: number, overrides: Partial<StageView> = {}): StageView {
  rowid += 1;
  return {
    runId: "run-1",
    stageId: `${nodeId}@${visit}#1`,
    nodeId,
    visit,
    attempt: 1,
    status: "succeeded",
    outcomeStatus: "succeeded",
    threadId: null,
    providerId: null,
    model: null,
    reasoningLevel: null,
    actor: null,
    waitingReason: null,
    startedAt: rowid * 1000,
    completedAt: rowid * 1000 + 500,
    ...overrides,
  };
}

function node(id: string, handlerKind = "agent", overrides: Partial<GraphView["nodes"][number]> = {}): GraphView["nodes"][number] {
  return { id, label: id[0]!.toUpperCase() + id.slice(1), shape: "box", handlerKind, goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null, ...overrides };
}

function edge(from: string, to: string, extra: Partial<GraphView["edges"][number]> = {}): GraphView["edges"][number] {
  return { from, to, label: null, condition: null, ...extra };
}

const RUN: RunView = {
  id: "run-1",
  threadId: "thread-1",
  projectId: null,
  environmentId: null,
  title: "Demo",
  source: "",
  status: "running",
  currentNodeId: null,
  context: {},
  goalGateFailures: [],
  finalOutcome: null,
  error: null,
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
};

const LINE: GraphView = {
  rankdir: "TB",
  nodes: [node("start", "start"), node("plan"), node("build", "command"), node("exit", "exit")],
  edges: [edge("start", "plan"), edge("plan", "build"), edge("build", "exit")],
};

const LOOP: GraphView = {
  rankdir: "TB",
  nodes: [node("start", "start"), node("build"), node("check", "command"), node("exit", "exit")],
  edges: [edge("start", "build"), edge("build", "check"), edge("check", "exit", { condition: "outcome=succeeded" }), edge("check", "build", { condition: "outcome=failed" })],
};

describe("groupPasses", () => {
  it("keeps a graph with no loop in one pass", () => {
    const passes = groupPasses([stage("start", 1), stage("plan", 1), stage("build", 1), stage("exit", 1)]);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.stages.map((s) => s.nodeId)).toEqual(["start", "plan", "build", "exit"]);
  });

  it("starts a new pass whenever the run re-enters a node already in the current pass", () => {
    const passes = groupPasses([
      stage("start", 1),
      stage("next", 1),
      stage("plan", 1),
      stage("approve", 1),
      stage("next", 2),
      stage("brief", 1),
      stage("build", 1),
      stage("critic", 1),
      stage("ratchet", 1),
      stage("critic", 2), // ratchet failed -> back to critic: a new pass, not a new "next"
      stage("ratchet", 2),
      stage("next", 3),
    ]);
    expect(passes.map((p) => p.stages.map((s) => s.nodeId))).toEqual([
      ["start", "next", "plan", "approve"],
      ["next", "brief", "build", "critic", "ratchet"],
      ["critic", "ratchet", "next"],
    ]);
    expect(passes.map((p) => p.index)).toEqual([1, 2, 3]);
  });

  it("never starts a pass on a skipped stage (a node the run could not enter)", () => {
    const passes = groupPasses([stage("build", 1), stage("check", 1), stage("build", 2, { status: "skipped" }), stage("exit", 1)]);
    expect(passes).toHaveLength(1);
  });

  it("reports a pass with a stage still in flight as open, with its status", () => {
    const passes = groupPasses([stage("build", 1), stage("build", 2, { status: "blocked", completedAt: null })]);
    expect(passes[1]).toMatchObject({ status: "blocked", endedAt: null });
    expect(passes[0]).toMatchObject({ status: "succeeded" });
    expect(passes[0]!.endedAt).not.toBeNull();
  });
});

describe("progressOf", () => {
  it("says 'n of N stages' with one segment per node only when the graph has no loop", () => {
    const graph = { ...LINE, nodes: LINE.nodes.map((n) => (n.id === "start" ? { ...n, status: "succeeded" as const } : n.id === "plan" ? { ...n, status: "running" as const } : n)) };
    const progress = progressOf(RUN, [stage("start", 1), stage("plan", 1, { status: "running", completedAt: null })], graph, 60_000);
    expect(progress.text).toBe("2 of 4 stages");
    expect(progress.segments).toEqual(["done", "current", "pending", "pending"]);
    expect(progress.looping).toBe(false);
  });

  it("says elapsed time and the pass count for a looping graph, with no segments", () => {
    const stages = [stage("start", 1), stage("build", 1), stage("check", 1), stage("build", 2, { status: "running", completedAt: null })];
    const progress = progressOf({ ...RUN, createdAt: 0 }, stages, LOOP, 14 * 60_000);
    expect(progress).toEqual({ text: "14m · pass 2", segments: null, looping: true });
  });
});

describe("graphHasLoop", () => {
  it("finds a cycle, and none in a line", () => {
    expect(graphHasLoop(LOOP)).toBe(true);
    expect(graphHasLoop(LINE)).toBe(false);
    expect(graphHasLoop(null)).toBe(false);
  });
});

describe("routesFrom", () => {
  it("describes where each outcome goes in plain language", () => {
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [node("build"), node("candidate", "command"), node("stalled", "human", { label: "A stage failed" }), node("approve", "human"), node("plan"), node("next", "command")],
      edges: [
        edge("build", "candidate", { condition: "outcome=succeeded" }),
        edge("build", "stalled", { condition: "outcome=failed" }),
        edge("approve", "plan", { label: "[R] Revise" }),
        edge("next", "plan", { condition: "command.output contains GO_PLAN" }),
        edge("candidate", "next"),
      ],
    };
    expect(routesFrom(graph, "build")).toEqual([
      { when: "if it succeeds", to: "candidate", toLabel: "Candidate" },
      { when: "if it fails", to: "stalled", toLabel: "A stage failed" },
    ]);
    expect(routesFrom(graph, "approve")[0]!.when).toBe("on “Revise”");
    expect(routesFrom(graph, "next")[0]!.when).toBe("when command.output contains GO_PLAN");
    expect(routesFrom(graph, "candidate")[0]!.when).toBe("next");
  });
});

describe("gateChoices", () => {
  it("lists a gate's labelled edges with where each leads, marking a route back to a visited node", () => {
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [node("research"), node("approve", "human"), node("bump", "command", { label: "Bump versions" })],
      edges: [edge("research", "approve"), edge("approve", "bump", { label: "[A] Approve" }), edge("approve", "research", { label: "[R] Revise", freeform: true })],
    };
    expect(gateChoices(graph, "approve", new Set(["research", "approve"]))).toEqual([
      { raw: "[A] Approve", key: "A", text: "Approve", to: "bump", toLabel: "Bump versions", back: false },
      { raw: "[R] Revise", key: "R", text: "Revise", to: "research", toLabel: "Research", back: true },
    ]);
  });
});

describe("deriveAttention", () => {
  const GATED: GraphView = {
    rankdir: "TB",
    nodes: [node("research"), node("approve", "human", { label: "Approve the plan?" }), node("bump", "command"), node("build")],
    edges: [edge("research", "approve"), edge("approve", "bump", { label: "[A] Approve" }), edge("approve", "research", { label: "[R] Revise", freeform: true }), edge("bump", "build")],
  };

  it("blames the last working stage that failed, not a routing node that merely passed its outcome on, and says when a visit limit ended the run", () => {
    // A real panel-check run: test fails, the diamond routes back, and the
    // fifth entry into prep is skipped for max_node_visits, ending the run.
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [node("start", "start"), node("prep", "command", { label: "Prepare" }), node("test", "command", { label: "Test" }), node("check", "conditional"), node("exit", "exit")],
      edges: [edge("start", "prep"), edge("prep", "test"), edge("test", "check"), edge("check", "prep", { condition: "outcome=failed" }), edge("check", "exit", { condition: "outcome=succeeded" })],
    };
    const failed = { status: "failed" as const, outcomeStatus: "failed" as const };
    const stages = [stage("start", 1), stage("prep", 1), stage("test", 1, failed), stage("check", 1, failed), stage("prep", 2), stage("test", 2, failed), stage("check", 2, failed), stage("prep", 3, { stageId: "prep@3", status: "skipped", outcomeStatus: null })];
    const events = [
      { seq: 1, runId: "run-1", ts: 1, type: "stage.completed", stageId: "test@2#1", nodeId: "test", visit: 2, attempt: 1, outcome: { status: "failed", failureReason: "exit code 1", text: "1 failing\n" }, wallTimeMs: 1 },
      { seq: 2, runId: "run-1", ts: 2, type: "stage.completed", stageId: "check@2#1", nodeId: "check", visit: 2, attempt: 1, outcome: { status: "failed" }, wallTimeMs: 0 },
      { seq: 3, runId: "run-1", ts: 3, type: "stage.skipped", stageId: "prep@3", nodeId: "prep", reason: "max_visits_exceeded" },
      { seq: 4, runId: "run-1", ts: 4, type: "run.completed", status: "failed", goalGateFailures: [] },
    ] as unknown as EventView[];
    const run: RunView = { ...RUN, status: "failed", currentNodeId: "check", context: { response: { test: "1 failing\n" } } };
    const attention = deriveAttention(run, stages, graph, events);
    expect(attention).toMatchObject({ kind: "failed", label: "Test", reason: "exit code 1", output: "1 failing\n", endedBy: "Prepare reached its visit limit" });
  });

  it("is 'running' with the stages in flight when nothing needs a human", () => {
    const attention = deriveAttention(RUN, [stage("research", 1, { status: "running", completedAt: null })], GATED);
    expect(attention.kind).toBe("running");
    expect(statusPill(RUN, attention)).toEqual({ word: "Running", tone: "run" });
  });

  it("shows a human gate's options, where they lead, whether it takes free text, and what it is reviewing", () => {
    const run = { ...RUN, status: "blocked" as const };
    const gate = stage("approve", 1, {
      status: "blocked",
      completedAt: null,
      gateContext: { context: { nodeId: "research", label: null, text: "plan", threadId: "thr-research" }, reviewTarget: { path: ".local/plan.md", text: "# Plan" } },
    });
    const attention = deriveAttention(run, [stage("research", 1, { threadId: "thr-research" }), gate], GATED);
    expect(attention.kind).toBe("requests");
    if (attention.kind !== "requests") return;
    const request = attention.requests[0]!;
    expect(request).toMatchObject({ kind: "gate", label: "Approve the plan?", freeform: true, reviewTarget: { path: ".local/plan.md" }, after: { nodeId: "research", label: "Research", threadId: "thr-research" } });
    if (request.kind !== "gate") return;
    expect(request.choices.map((c) => `${c.text}->${c.back ? "back:" : ""}${c.toLabel}`)).toEqual(["Approve->Bump", "Revise->back:Research"]);
    expect(statusPill(run, attention)).toEqual({ word: "Needs you", tone: "run" });
  });

  it("shows a provider pause with its retry time as data, and the reason without the time", () => {
    const run = { ...RUN, status: "blocked" as const };
    const paused = stage("build", 9, { status: "blocked", completedAt: null, threadId: "thr-x9", waitingReason: "Rate limited, retrying at 2026-11-12 20:20 UTC", waitingSince: 5_000, waitingUntil: 9_000 });
    const attention = deriveAttention(run, [paused], GATED);
    expect(attention).toEqual({ kind: "requests", requests: [expect.objectContaining({ kind: "provider-pause", reason: "Rate limited", retryAt: 9_000, since: 5_000, threadId: "thr-x9" })] });
    expect(statusPill(run, attention)).toEqual({ word: "Paused", tone: "warn" });
  });

  it("shows a worker's own prompt as 'open worker to answer', not as a pause", () => {
    const run = { ...RUN, status: "blocked" as const };
    const waiting = stage("build", 1, { status: "blocked", completedAt: null, threadId: "thr-w", waitingReason: "approval", waitingSince: 7_000 });
    const attention = deriveAttention(run, [waiting], GATED);
    expect(attention).toEqual({ kind: "requests", requests: [expect.objectContaining({ kind: "worker-prompt", what: "approval", threadId: "thr-w", since: 7_000 })] });
  });

  it("lists several requests in priority order: gates, then worker prompts, then pauses", () => {
    const run = { ...RUN, status: "blocked" as const };
    const stages = [
      stage("build", 1, { status: "blocked", completedAt: null, waitingReason: "Rate limited, retrying at x", waitingUntil: 9_000, parallelGroupId: "fork@1", branchIndex: 0 }),
      stage("research", 1, { status: "blocked", completedAt: null, waitingReason: "approval", parallelGroupId: "fork@1", branchIndex: 1 }),
      stage("approve", 1, { status: "blocked", completedAt: null }),
    ];
    const attention = deriveAttention(run, stages, GATED);
    expect(attention.kind === "requests" && attention.requests.map((r) => r.kind)).toEqual(["gate", "worker-prompt", "provider-pause"]);
  });

  it("names the failed stage, why it failed, its output, and the node Resume re-enters", () => {
    const run = { ...RUN, status: "failed" as const, currentNodeId: "bump", context: { response: { bump: "line 1\nerror TS2307: Cannot find module 'vite/client'\n" } } };
    const events: EventView[] = [{ seq: 4, type: "stage.completed", runId: "run-1", ts: 4, stageId: "bump@1#1", nodeId: "bump", visit: 1, attempt: 1, wallTimeMs: 10, outcome: { status: "failed", failureReason: "exit 1" } }];
    const attention = deriveAttention(run, [stage("research", 1), stage("bump", 1, { status: "failed", outcomeStatus: "failed" })], GATED, events);
    expect(attention).toMatchObject({ kind: "failed", cancelled: false, label: "Bump", handlerKind: "command", reason: "exit 1", resumeLabel: "Bump" });
    expect(attention.kind === "failed" && attention.output).toContain("TS2307");
    expect(statusPill(run, attention)).toEqual({ word: "Failed", tone: "bad" });
  });

  it("falls back to the run's own error, then to a failed goal gate, for the reason", () => {
    expect(deriveAttention({ ...RUN, status: "failed", error: "host went away" }, [stage("research", 1)], GATED)).toMatchObject({ reason: "host went away" });
    expect(deriveAttention({ ...RUN, status: "failed", goalGateFailures: ["bump"] }, [stage("bump", 1, { outcomeStatus: "failed", status: "failed" })], GATED)).toMatchObject({
      label: "Bump",
      reason: "goal gate Bump did not succeed",
    });
  });

  it("says who stopped a cancelled run and where, with no failure reason", () => {
    const run = { ...RUN, status: "cancelled" as const, currentNodeId: "build" };
    const attention = deriveAttention(run, [stage("research", 1), stage("build", 1, { status: "cancelled" })], GATED);
    expect(attention).toMatchObject({ kind: "failed", cancelled: true, label: "Build", reason: null, resumeLabel: "Build" });
    expect(statusPill(run, attention)).toEqual({ word: "Stopped", tone: "muted" });
  });

  it("shows a finished run's last working stage and its own output", () => {
    const graph: GraphView = { rankdir: "TB", nodes: [node("start", "start"), node("pr", "command", { label: "Open PR" }), node("exit", "exit")], edges: [edge("start", "pr"), edge("pr", "exit")] };
    const run = { ...RUN, status: "succeeded" as const, context: { response: { pr: "opened #151\n" } } };
    expect(deriveAttention(run, [stage("start", 1), stage("pr", 1), stage("exit", 1)], graph)).toEqual({ kind: "finished", label: "Open PR", output: "opened #151", threadId: null });
  });

  it("takes a finished run's result from its last agent or command stage, not a closing human gate (the decision is listed separately)", () => {
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [node("start", "start"), node("test", "command", { label: "Test" }), node("gate", "human", { label: "Ship it?" }), node("exit", "exit")],
      edges: [edge("start", "test"), edge("test", "gate"), edge("gate", "exit", { label: "[A] Approve" })],
    };
    const run = { ...RUN, status: "succeeded" as const, context: { response: { test: "all green\n", gate: "Approve" } } };
    expect(deriveAttention(run, [stage("start", 1), stage("test", 1), stage("gate", 1), stage("exit", 1)], graph)).toMatchObject({ kind: "finished", label: "Test", output: "all green" });
  });

  it("drops an empty detail after a failure reason's colon in the story", () => {
    const graph: GraphView = { rankdir: "TB", nodes: [node("test", "command", { label: "Test" })], edges: [] };
    const events = [{ seq: 1, runId: "run-1", ts: 1, type: "stage.completed", stageId: "test@1#1", nodeId: "test", visit: 1, attempt: 1, outcome: { status: "failed", failureReason: "exit code 1: \n" }, wallTimeMs: 2000 }] as unknown as EventView[];
    expect(storyItems(events, [stage("test", 1, { status: "failed" })], graph)[0]!.text).toBe("failed: exit code 1");
  });
});

describe("nowView", () => {
  it("lists a fan-out's branches together, finished ones included, with what they converge on", () => {
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [node("fork", "parallel", { label: "Fan out" }), node("security"), node("quality"), node("merge", "parallel.fan_in", { label: "Merge" })],
      edges: [edge("fork", "security"), edge("fork", "quality"), edge("security", "merge"), edge("quality", "merge")],
    };
    const stages = [
      stage("fork", 1),
      stage("security", 1, { status: "running", completedAt: null, parallelGroupId: "fork@1", branchIndex: 0 }),
      stage("quality", 1, { parallelGroupId: "fork@1", branchIndex: 1 }),
    ];
    const now = nowView(stages, graph);
    expect(now.stages).toEqual([]);
    expect(now.fanOuts).toEqual([{ groupId: "fork@1", forkLabel: "Fan out", stages: [stages[1], stages[2]], joinLabel: "Merge" }]);
  });
});

describe("storyItems", () => {
  const graph: GraphView = {
    rankdir: "TB",
    nodes: [node("start", "start"), node("build"), node("check", "command", { label: "Ratchet" }), node("exit", "exit")],
    edges: LOOP.edges,
  };
  const events: EventView[] = [
    { seq: 1, type: "run.started", runId: "r", ts: 1 },
    { seq: 2, type: "stage.started", runId: "r", ts: 2, stageId: "start@1#1", nodeId: "start", visit: 1, attempt: 1 },
    { seq: 3, type: "stage.completed", runId: "r", ts: 3, stageId: "start@1#1", nodeId: "start", visit: 1, attempt: 1, wallTimeMs: 1, outcome: { status: "succeeded" } },
    { seq: 4, type: "edge.selected", runId: "r", ts: 4, from: "start", to: "build", reason: "unconditional" },
    { seq: 5, type: "checkpoint.saved", runId: "r", ts: 5, stageId: "build" },
    { seq: 6, type: "stage.started", runId: "r", ts: 6, stageId: "build@1#1", nodeId: "build", visit: 1, attempt: 1 },
    { seq: 7, type: "agent.thread", runId: "r", ts: 7, stageId: "build@1", nodeId: "build", threadId: "thr-b1", provider: "claude-code", model: "opus", reasoningLevel: "high" },
    { seq: 8, type: "stage.completed", runId: "r", ts: 600_008, stageId: "build@1#1", nodeId: "build", visit: 1, attempt: 1, wallTimeMs: 590_000, outcome: { status: "succeeded" } },
    { seq: 9, type: "stage.started", runId: "r", ts: 9, stageId: "check@1#1", nodeId: "check", visit: 1, attempt: 1 },
    { seq: 10, type: "stage.completed", runId: "r", ts: 10, stageId: "check@1#1", nodeId: "check", visit: 1, attempt: 1, wallTimeMs: 400, outcome: { status: "succeeded", text: "result=win status=active\nmore" } },
    { seq: 11, type: "stage.started", runId: "r", ts: 11, stageId: "build@2#1", nodeId: "build", visit: 2, attempt: 1 },
    { seq: 12, type: "agent.waiting", runId: "r", ts: 12, stageId: "build@2", nodeId: "build", threadId: "thr-b2", interactionId: "req", kind: "Rate limited, retrying at …", title: "Rate limited", retryAt: new Date(2026, 10, 12, 20, 20).getTime() },
  ];
  const stages = [stage("start", 1), stage("build", 1), stage("check", 1), stage("build", 2, { status: "blocked", completedAt: null })];

  it("keeps milestones, tags routing and checkpoint events so they can be hidden and counted, and places each in its pass", () => {
    const items = storyItems(events, stages, graph);
    const milestones = items.filter((i) => i.kind === "milestone");
    expect(milestones.map((i) => `${i.pass}|${i.subject ?? ""}|${i.text}`)).toEqual([
      "1||Run started",
      "1|Build|started",
      "1|Build|finished",
      "1|Ratchet|: result=win status=active",
      "2|Build|started",
      "2|Build|paused: rate limited, retry queued for 20:20",
    ]);
    expect(items.filter((i) => i.kind === "routing")).toHaveLength(2); // start's completion + the edge
    expect(items.filter((i) => i.kind === "checkpoint")).toHaveLength(1);
  });

  it("folds a worker's thread into its stage's 'started' line", () => {
    const started = storyItems(events, stages, graph).find((i) => i.seq === 6)!;
    expect(started.threadId).toBe("thr-b1");
  });
});

describe("raw event lines", () => {
  const e: EventView = { seq: 215, type: "agent.waiting", runId: "r", ts: new Date(2026, 10, 12, 18, 41, 27).getTime(), stageId: "build@9", nodeId: "build", threadId: "thr-x9", interactionId: "i", kind: "Rate limited, retrying at 2026-11-12 20:20 UTC", title: "Rate limited" };

  it("formats one event as one line with its sequence number and clock time", () => {
    expect(rawEventLine(e)).toBe("#215 18:41:27 agent.waiting build@9 Rate limited, retrying at 2026-11-12 20:20 UTC (Rate limited)");
  });

  it("matches a filter against type, node and text, case-insensitively", () => {
    expect(eventMatches(e, "BUILD")).toBe(true);
    expect(eventMatches(e, "agent.waiting")).toBe(true);
    expect(eventMatches(e, "thr-x9")).toBe(true);
    expect(eventMatches(e, "critic")).toBe(false);
    expect(eventMatches(e, "  ")).toBe(true);
  });
});

describe("waitSpansByStage", () => {
  it("pairs each worker wait with the resume (or completion) that ended it", () => {
    const events: EventView[] = [
      { seq: 1, type: "agent.waiting", runId: "r", ts: 10, stageId: "build@1", nodeId: "build", threadId: "t", interactionId: "i", kind: "k", title: null },
      { seq: 2, type: "agent.resumed", runId: "r", ts: 20, stageId: "build@1", nodeId: "build", threadId: "t" },
      { seq: 3, type: "agent.waiting", runId: "r", ts: 30, stageId: "build@1", nodeId: "build", threadId: "t", interactionId: "i", kind: "k", title: null },
    ];
    expect(waitSpansByStage(events).get("build@1")).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: null },
    ]);
  });
});
