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
    { id: "start", label: "start", shape: "Mdiamond", handlerKind: "start", goalGate: false, status: "succeeded", visit: 1, model: null, provider: null, waitingReason: null },
    { id: "plan", label: "Plan", shape: "tab", handlerKind: "prompt", goalGate: false, status: "running", visit: 1, model: "claude-sonnet-5", provider: "anthropic", waitingReason: null },
    { id: "exit", label: "exit", shape: "Msquare", handlerKind: "exit", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null },
  ],
  edges: [
    { from: "start", to: "plan", label: null, condition: null },
    { from: "plan", to: "exit", label: null, condition: null },
  ],
};

const STAGES: StageView[] = [
  { runId: "run-1", stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: 1_000, completedAt: 1_200 },
  { runId: "run-1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: "worker-thread-1", providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: 1_200, completedAt: null },
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

  it("registers the active-runs composer banner, scoped to the thread composer (active-runs composer banner follow-up)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.composerCustomizations.map((c) => ({ id: c.id, scopes: c.scopes, banners: c.banners?.map((b) => ({ id: b.id, chrome: b.chrome })) }))).toEqual([
      { id: "attractor-status", scopes: ["thread"], banners: [{ id: "active-runs", chrome: "bare" }] },
    ]);
  });

  it("registers the human-gate pendingInteraction renderer (T6)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.pendingInteractions.map((p) => p.id)).toEqual(["attractor-human-gate"]);
  });

  it("renders the human-gate pendingInteraction with its options as buttons", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const submit = () => Promise.resolve();
    const slot = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "interaction-1",
          threadId: "thread-1",
          title: "Approve plan?",
          createdAt: 0,
          expiresAt: null,
          payload: {
            runId: "run-1",
            nodeId: "gate",
            question: "Approve plan?",
            options: [{ raw: "[A] Approve", key: "A", text: "Approve", to: "exit" }],
            freeform: false,
            questionType: null,
          },
        },
        submit,
        cancel: () => Promise.resolve(),
      },
      { rpc: baseRpc() },
    );
    expect(slot.getByRole("button", { name: "[A] Approve" })).toBeTruthy();
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

  it("cross-thread cards: uses the directive's thread attribute (not the hosting message's thread) for every RPC call", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: "run-1", thread: "origin-thread" },
        source: '::attractor-run{run="run-1" thread="origin-thread"}',
        message: { id: "m1", threadId: "pasted-into-thread", turnId: null, projectId: null },
        openWorkspaceFile: null,
      },
      { rpc: baseRpc() },
    );
    await slot.findByText("Plan Implement Review");
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "getRun", input: { runId: "run-1", threadId: "origin-thread" } });
  });

  it("cross-thread cards: falls back to the hosting message's own thread when the directive has no thread attribute", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    await slot.findByText("Plan Implement Review");
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "getRun", input: { runId: "run-1", threadId: "thread-1" } });
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

  it("puts the chevron ('Open in right panel') in the card's header row, separate from the footer's 'Show stages' toggle", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    const showStages = await slot.findByRole("button", { name: /show stages/i });
    const chevron = await slot.findByRole("button", { name: /open in (right )?panel/i });
    expect(chevron).not.toBe(showStages);
    expect(chevron.parentElement).not.toBe(showStages.parentElement);
    // The toggle is the card's own footer row, inside the card rather than a
    // sibling below it, so the card reads as one unit (restyle follow-up).
    const card = slot.container.querySelector(".rounded-lg.border.border-border.bg-card")!;
    expect(card.contains(showStages)).toBe(true);
    expect(showStages.closest("[data-card-footer]")).toBeTruthy();
  });

  it("renders the directive as a dark BB card (rounded, bordered, max-w-md)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    await slot.findByText("Plan Implement Review");
    const card = slot.container.querySelector(".rounded-lg.border.border-border.bg-card")!;
    expect(card).toBeTruthy();
    expect(card.className).toContain("max-w-md");
    expect(card.className).toContain("shadow-sm");
  });

  it("colors the status word by run status", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const cases: [string, string][] = [
      ["running", "text-amber-600"],
      ["blocked", "text-amber-600"],
      ["succeeded", "text-green-600"],
      ["failed", "text-destructive"],
      ["cancelled", "text-muted-foreground"],
    ];
    for (const [status, expectedClass] of cases) {
      const slot = renderSlot(
        app.messageDirectives[0]!,
        { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
        { rpc: baseRpc({ run: { ...RUN, status: status as RunView["status"] } }) },
      );
      await waitFor(() => expect(slot.container.querySelector("[data-run-status]")?.textContent).toBe(status));
      expect(slot.container.querySelector("[data-run-status]")?.className).toContain(expectedClass);
      cleanup();
    }
  });

  it("shows the first 8 characters of the run id in monospace, next to the status", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    await slot.findByText("Plan Implement Review");
    const shortId = slot.getByText(RUN.id.slice(0, 8));
    expect(shortId.className).toContain("font-mono");
    expect(shortId.className).toContain("text-xs");
    expect(shortId.className).toContain("text-muted-foreground");
  });

  it("shows the stages/elapsed summary line and a legend with Completed/Running/Failed/Blocked/Pending", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    await slot.findByText(/Stages: \d+\/\d+/);
    expect(slot.getByText(/Elapsed:/)).toBeTruthy();
    expect(slot.getByText("Completed")).toBeTruthy();
    expect(slot.getByText("Running")).toBeTruthy();
    expect(slot.getByText("Failed")).toBeTruthy();
    expect(slot.getByText("Blocked")).toBeTruthy();
    expect(slot.getByText("Pending")).toBeTruthy();
  });

  it("shows a 'Waiting: <node label>' summary suffix when the run is blocked", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const stages: StageView[] = [
      { ...STAGES[0]!, },
      { ...STAGES[1]!, status: "blocked" },
    ];
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc({ run: { ...RUN, status: "blocked" }, stages }) },
    );
    await waitFor(() => expect(slot.container.querySelector("[data-run-status]")?.textContent).toBe("blocked"));
    expect(slot.getByText(/Waiting: Plan/)).toBeTruthy();
  });

  it("wraps the DAG's svg inside a white rounded box", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() },
    );
    await slot.findByText("Plan Implement Review");
    const box = slot.container.querySelector(".bg-white.rounded-md")!;
    expect(box).toBeTruthy();
    expect(box.querySelector("svg")).toBeTruthy();
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
      // Carries this card's threadId along (cross-thread cards follow-up):
      // app.tsx's `Panel` reads `params.threadId` back so the opened panel
      // keeps addressing the run's actual origin thread.
      options: { actionId: "attractor-run", params: { runId: "run-1", threadId: "thread-1" }, title: "Plan Implement Review" },
    });
  });

  it("opens the thread panel carrying a cross-thread card's origin threadId, not the panel-hosting thread", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: "run-1", thread: "origin-thread" },
        source: '::attractor-run{run="run-1" thread="origin-thread"}',
        message: { id: "m1", threadId: "pasted-into-thread", turnId: null, projectId: null },
        openWorkspaceFile: null,
      },
      { rpc: baseRpc() },
    );
    const openButton = await slot.findByRole("button", { name: /open in (right )?panel/i });
    openButton.click();
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "attractor-run", params: { runId: "run-1", threadId: "origin-thread" }, title: "Plan Implement Review" },
    });
  });

  it("cross-thread cards: the thread panel uses params.threadId over its own hosting thread", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "panel-hosting-thread", params: { runId: "run-1", threadId: "origin-thread" } }, { rpc: baseRpc() });
    await slot.findByText("Plan Implement Review");
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "getRun", input: { runId: "run-1", threadId: "origin-thread" } });
  });

  it("cross-thread cards: the thread panel falls back to its own hosting thread when params carries none", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-1", params: { runId: "run-1" } }, { rpc: baseRpc() });
    await slot.findByText("Plan Implement Review");
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "getRun", input: { runId: "run-1", threadId: "thread-1" } });
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

  it("still offers a Stop button while the run is blocked on a human gate (T6)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: { runId: "run-1" } },
      { rpc: baseRpc({ run: { ...RUN, status: "blocked" } }) },
    );
    await waitFor(() => expect(slot.container.querySelector("[data-run-status]")?.textContent).toBe("blocked"));
    expect(slot.queryByRole("button", { name: /stop/i })).toBeTruthy();
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
