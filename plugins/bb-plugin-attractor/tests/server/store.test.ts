import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../server/store";

function makeStore() {
  return new RunStore(new Database(":memory:"));
}

const graph = { name: "G", goal: "g", nodes: [], edges: [] };

describe("RunStore", () => {
  it("creates a run and reads it back with defaults", () => {
    const store = makeStore();
    const run = store.createRun({
      id: "run-1",
      threadId: "thread-1",
      projectId: "project-1",
      environmentId: "env-1",
      title: "My run",
      source: "digraph G {}",
      graph,
      initialContext: { a: 1 },
    });
    expect(run.status).toBe("running");
    expect(run.currentNodeId).toBeNull();
    expect(run.goalGateFailures).toEqual([]);
    expect(store.getRun("run-1")).toEqual(run);
  });

  it("rejects creating a second run with the same id", () => {
    const store = makeStore();
    const input = { id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} };
    store.createRun(input);
    expect(() => store.createRun(input)).toThrow(/already exists/);
  });

  it("saves a checkpoint and reflects it on the run", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    const run = store.saveCheckpoint("run-1", {
      runId: "run-1",
      nextNodeId: "plan",
      context: { last_stage: "start" },
      visitCounts: { start: 1 },
      goalGateOutcomes: {},
    });
    expect(run.currentNodeId).toBe("plan");
    expect(run.context).toEqual({ last_stage: "start" });
    expect(store.loadCheckpoint("run-1")).toEqual({
      runId: "run-1",
      nextNodeId: "plan",
      context: { last_stage: "start" },
      visitCounts: { start: 1 },
      goalGateOutcomes: {},
    });
  });

  it("records a finished run", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    const run = store.recordFinish("run-1", {
      status: "succeeded",
      finalOutcome: { status: "succeeded", text: "done" },
      goalGateFailures: [],
      context: { last_stage: "exit" },
    });
    expect(run.status).toBe("succeeded");
    expect(run.finishedAt).not.toBeNull();
    expect(run.finalOutcome).toEqual({ status: "succeeded", text: "done" });
  });

  it("upserts stages keyed by (runId, nodeId, visit) and lists them in visit order", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.upsertStage("run-1", { stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: null, startedAt: 1 });
    store.upsertStage("run-1", { stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, startedAt: 1, completedAt: 2 });
    store.upsertStage("run-1", { stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: "thread-worker", startedAt: 3 });
    const stages = store.listStages("run-1");
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({ nodeId: "start", status: "succeeded", completedAt: 2 });
    expect(stages[1]).toMatchObject({ nodeId: "plan", status: "running", threadId: "thread-worker" });
  });

  it("attaches a worker threadId to an already-started stage (agent.thread event)", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.upsertStage("run-1", { stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: null, startedAt: 1 });
    store.setStageThreadId("run-1", "plan", 1, "worker-thread");
    expect(store.listStages("run-1")[0]).toMatchObject({ threadId: "worker-thread" });
  });

  it("appends events with an increasing seq and lists them since a cursor", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    const s1 = store.appendEvent("run-1", { type: "run.started", runId: "run-1", ts: 1 });
    const s2 = store.appendEvent("run-1", { type: "run.completed", runId: "run-1", ts: 2, status: "succeeded", goalGateFailures: [] });
    expect(s2).toBe(s1 + 1);
    expect(store.listEvents("run-1")).toHaveLength(2);
    expect(store.listEvents("run-1", s1)).toHaveLength(1);
    expect(store.listEvents("run-1", s1)[0].type).toBe("run.completed");
  });

  it("lists runs for a thread newest-last with a cursor", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.createRun({ id: "run-2", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.createRun({ id: "run-3", threadId: "other", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    const page = store.listRuns({ threadId: "t", limit: 1 });
    expect(page.runs.map((r) => r.id)).toEqual(["run-1"]);
    expect(page.nextCursor).not.toBeNull();
    const next = store.listRuns({ threadId: "t", limit: 1, after: page.nextCursor! });
    expect(next.runs.map((r) => r.id)).toEqual(["run-2"]);
  });

  it("lists running run ids for background resume", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.createRun({ id: "run-2", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.recordFinish("run-2", { status: "succeeded", finalOutcome: { status: "succeeded" }, goalGateFailures: [], context: {} });
    expect(store.listRunningRunIds()).toEqual(["run-1"]);
  });

  it("also lists blocked run ids for background resume (T6: a restart mid-human-gate must not strand the run)", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.createRun({ id: "run-2", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.setStatus("run-2", "blocked");
    expect(store.listRunningRunIds().sort()).toEqual(["run-1", "run-2"]);
  });

  it("throws a clear error for an unknown run id", () => {
    const store = makeStore();
    expect(() => store.getRun("missing")).toThrow(/not found/);
  });

  it("sets a run's status directly (T6: blocked while a human gate waits)", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    const blocked = store.setStatus("run-1", "blocked");
    expect(blocked.status).toBe("blocked");
    const running = store.setStatus("run-1", "running");
    expect(running.status).toBe("running");
  });

  it("sets a stage's status directly without disturbing its other fields (T6: blocked while a human gate waits)", () => {
    const store = makeStore();
    store.createRun({ id: "run-1", threadId: "t", projectId: null, environmentId: null, title: null, source: "digraph G{}", graph, initialContext: {} });
    store.upsertStage("run-1", { stageId: "gate@1", nodeId: "gate", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: null, startedAt: 1 });
    store.setStageStatus("run-1", "gate", 1, "blocked");
    expect(store.listStages("run-1")[0]).toMatchObject({ nodeId: "gate", visit: 1, status: "blocked" });
    store.setStageStatus("run-1", "gate", 1, "running");
    expect(store.listStages("run-1")[0]).toMatchObject({ status: "running" });
  });
});
