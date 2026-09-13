// @vitest-environment jsdom
/**
 * app.tsx registrations + the `::attractor-run` message directive / thread
 * panel, per docs/plans/2026-09-13-attractor-runner-plan.md T5 acceptance:
 * "jsdom tests for the directive (invalid attributes message; renders nodes
 * and statuses from a fake RPC)". Uses the SDK's own test harness (as
 * plugins/bb-plugin-assembly-lines/app.test.tsx does), not raw
 * `@testing-library/react` render, so `useRpc`/`useRealtime`/`useBbNavigate`
 * resolve against fakes instead of throwing.
 */
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { GraphView, RunView, StageView } from "../server/contracts";

// See tests/ui/events.test.tsx's identical `afterEach(cleanup)` comment:
// `renderSlot` renders through `@testing-library/react` too, so without this
// a later test's `slot.getByText`/`findByRole` (which query `document.body`)
// can match a previous test's leftover DOM.
afterEach(cleanup);

const RUN: RunView = {
  id: "run-1",
  threadId: "thread-1",
  projectId: "project-1",
  environmentId: "env-1",
  title: "Plan Implement Review",
  source: "digraph G {}",
  status: "running",
  currentNodeId: "plan",
  context: {},
  goalGateFailures: [],
  finalOutcome: null,
  error: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  finishedAt: null,
};

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [
    { id: "start", label: "start", shape: "Mdiamond", handlerKind: "start", goalGate: false, status: "succeeded", visit: 1, model: null, provider: null },
    { id: "plan", label: "Plan", shape: "tab", handlerKind: "prompt", goalGate: false, status: "running", visit: 1, model: "claude-sonnet-5", provider: "anthropic" },
    { id: "exit", label: "exit", shape: "Msquare", handlerKind: "exit", goalGate: false, status: null, visit: 0, model: null, provider: null },
  ],
  edges: [
    { from: "start", to: "plan", label: null, condition: null },
    { from: "plan", to: "exit", label: null, condition: null },
  ],
};

const STAGES: StageView[] = [
  { runId: "run-1", stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, startedAt: 1_000, completedAt: 1_200 },
  { runId: "run-1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: "worker-thread-1", startedAt: 1_200, completedAt: null },
];

function baseRpc(overrides: Partial<{ run: RunView | null; stages: StageView[]; graph: GraphView | null }> = {}) {
  const run = "run" in overrides ? overrides.run : RUN;
  const stages = overrides.stages ?? STAGES;
  const graph = "graph" in overrides ? overrides.graph : GRAPH;
  return {
    getRun: () => ({ run, stages }),
    getGraph: () => graph,
    getEvents: () => ({ events: [{ seq: 1, type: "run.started", runId: "run-1", ts: 1000 }] }),
    stopRun: () => ({ stopped: true }),
  };
}

describe("Attractor app", () => {
  it("registers the attractor-run message directive and thread panel action", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.messageDirectives.map((d) => d.id)).toEqual(["attractor-run"]);
    expect(app.threadPanelActions.map((a) => ({ id: a.id, title: a.title }))).toEqual([{ id: "attractor-run", title: "Attractor run" }]);
  });

  it("shows an error when the directive has no run id", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: {}, source: "::attractor-run", message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    expect(slot.getByText(/no run id/i)).toBeTruthy();
  });

  it("shows an error when the directive's run id is blank", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "   " }, source: '::attractor-run{run="   "}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    expect(slot.getByText(/no run id/i)).toBeTruthy();
  });

  it("renders the run's header, DAG nodes, and per-node status from the RPC", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    await slot.findByText("Plan Implement Review");
    expect(slot.getByText("running")).toBeTruthy();
    expect(slot.container.querySelector('[data-node-id="plan"][data-status="running"]')).toBeTruthy();
    expect(slot.container.querySelector('[data-node-id="start"][data-status="succeeded"]')).toBeTruthy();
  });

  it("opens the thread panel from the directive's 'Open in right panel' action", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    const openButton = await slot.findByRole("button", { name: /open in (right )?panel/i });
    openButton.click();
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "attractor-run", params: { runId: "run-1" }, title: "Plan Implement Review" },
    });
  });

  it("renders the panel with a Stop button that calls stopRun while the run is active", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let stopCalledWith: unknown = null;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: { runId: "run-1" } },
      { rpc: { ...baseRpc(), stopRun: (input: unknown) => { stopCalledWith = input; return { stopped: true }; } } },
    );
    const stopButton = await slot.findByRole("button", { name: /stop/i });
    stopButton.click();
    await waitFor(() => expect(stopCalledWith).toEqual({ runId: "run-1", threadId: "thread-1" }));
  });

  it("does not offer a Stop button once the run has finished", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: { runId: "run-1" } },
      { rpc: baseRpc({ run: { ...RUN, status: "succeeded", finishedAt: 2_000 } }) },
    );
    await waitFor(() => expect(slot.container.querySelector("[data-run-status]")?.textContent).toBe("succeeded"));
    expect(slot.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("refetches when a realtime attractor-runs signal names this run", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let calls = 0;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: { runId: "run-1" } },
      {
        rpc: {
          ...baseRpc(),
          getRun: () => {
            calls += 1;
            return { run: { ...RUN, status: calls > 1 ? "succeeded" : "running" }, stages: STAGES };
          },
        },
      },
    );
    await waitFor(() => expect(slot.container.querySelector("[data-run-status]")?.textContent).toBe("running"));
    await slot.behavior.emitRealtime("attractor-runs", { runId: "run-1", threadId: "thread-1" });
    await waitFor(() => expect(slot.container.querySelector("[data-run-status]")?.textContent).toBe("succeeded"));
    expect(calls).toBeGreaterThan(1);
  });

  it("renders a load error from the RPC", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: { ...baseRpc(), getRun: () => { throw new Error("run unavailable"); } } },
    );
    await waitFor(() => expect(slot.getByText(/could not load/i)).toBeTruthy());
  });

  it("shows a not-found message when the run doesn't exist (or isn't owned by this thread)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc({ run: null, stages: [] }) },
    );
    await waitFor(() => expect(slot.getByText(/not found/i)).toBeTruthy());
  });
});
