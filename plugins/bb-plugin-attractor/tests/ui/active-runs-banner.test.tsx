// @vitest-environment jsdom
/**
 * `ui/active-runs-banner.tsx`'s composer banner, per the active-runs
 * composer banner follow-up's acceptance list: "renders nothing with zero
 * active runs; renders a row with title/status/stage count; expand reveals
 * the DAG; blocked human gate renders option buttons that call answerGate
 * with the chosen label; chevron opens the panel with the run and thread
 * ids."
 *
 * Rendered through the SDK's `loadPluginApp`/`renderSlot` harness, as
 * tests/app.test.tsx does for the directive/panel — the banner calls
 * `useComposerView()`/`useRpc()`/`useBbNavigate()` directly, which only
 * resolve against fakes once the plugin's app module has been evaluated
 * after the test runtime is installed.
 */
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { GraphView, RunView, StageView } from "../../server/contracts";

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
    { id: "plan", label: "Plan", shape: "tab", handlerKind: "prompt", goalGate: false, status: "running", visit: 1, model: null, provider: null, waitingReason: null },
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

const GATE_RUN: RunView = { ...RUN, id: "run-2", title: "Gate run", status: "blocked", currentNodeId: "gate" };

const GATE_GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [
    { id: "start", label: "start", shape: "Mdiamond", handlerKind: "start", goalGate: false, status: "succeeded", visit: 1, model: null, provider: null, waitingReason: null },
    { id: "gate", label: "Approve plan?", shape: "hexagon", handlerKind: "human", goalGate: false, status: "blocked", visit: 1, model: null, provider: null, waitingReason: null },
    { id: "exit", label: "exit", shape: "Msquare", handlerKind: "exit", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null },
    { id: "revise", label: "Revise", shape: "box", handlerKind: "prompt", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null },
  ],
  edges: [
    { from: "start", to: "gate", label: null, condition: null },
    { from: "gate", to: "exit", label: "[A] Approve", condition: null },
    { from: "gate", to: "revise", label: "R) Revise", condition: null },
  ],
};

const GATE_STAGES: StageView[] = [
  { runId: "run-2", stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: 1_000, completedAt: 1_200 },
  {
    runId: "run-2",
    stageId: "gate@1",
    nodeId: "gate",
    visit: 1,
    attempt: 1,
    status: "blocked",
    outcomeStatus: null,
    threadId: null,
    providerId: null,
    model: null,
    reasoningLevel: null,
    actor: null,
    waitingReason: "human",
    gateContext: { context: null, reviewTarget: null },
    startedAt: 1_200,
    completedAt: null,
  },
];

async function renderBanner(rpc: Record<string, (...args: never[]) => unknown>, threadId: string | null = "thread-1") {
  const app = await loadPluginApp(() => import("../../app"));
  const banner = app.composerCustomizations[0]!.banners![0]!;
  const slot = renderSlot(
    banner,
    {},
    {
      rpc: rpc as never,
      composer: threadId === null ? { scope: { kind: "new-thread", projectId: null } } : { scope: { kind: "thread", threadId } },
    },
  );
  return slot;
}

describe("ActiveRunsBanner", () => {
  it("renders nothing when the thread has no active runs", async () => {
    const slot = await renderBanner({ activeRuns: () => ({ runs: [] }) });
    await waitFor(() => expect(slot.inspection.rpcCalls.some((c) => c.method === "activeRuns")).toBe(true));
    expect(slot.container.firstChild).toBeNull();
  });

  it("renders nothing outside a thread composer scope, even with active runs somewhere", async () => {
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: RUN, stages: STAGES, graph: GRAPH }] }) }, null);
    expect(slot.container.firstChild).toBeNull();
  });

  it("renders a row with the run's title, status, and stage count", async () => {
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: RUN, stages: STAGES, graph: GRAPH }] }) });
    await slot.findByText("Plan Implement Review");
    expect(slot.container.querySelector('[data-run-status="running"]')).toBeTruthy();
    expect(slot.getByText("2/3 stages")).toBeTruthy();
  });

  it("expand reveals the DAG and stage list", async () => {
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: RUN, stages: STAGES, graph: GRAPH }] }) });
    await slot.findByText("Plan Implement Review");
    expect(slot.queryByRole("img", { name: "Workflow DAG" })).toBeNull();

    const expandButton = slot.getByRole("button", { name: /expand run details/i });
    fireEvent.click(expandButton);

    expect(await slot.findByRole("img", { name: "Workflow DAG" })).toBeTruthy();
    expect(slot.getByTestId("attractor-stage-list")).toBeTruthy();
  });

  it("renders inline option buttons for a blocked human gate, calling answerGate with the chosen edge label", async () => {
    let answerCalledWith: unknown = null;
    const slot = await renderBanner({
      activeRuns: () => ({ runs: [{ run: GATE_RUN, stages: GATE_STAGES, graph: GATE_GRAPH }] }),
      answerGate: (input: unknown) => {
        answerCalledWith = input;
        return { answered: true };
      },
    });
    await slot.findByText("Gate run");

    const approveButton = slot.getByRole("button", { name: "[A] Approve" });
    expect(slot.getByRole("button", { name: "[R] Revise" })).toBeTruthy();
    fireEvent.click(approveButton);

    await waitFor(() => expect(answerCalledWith).toEqual({ runId: "run-2", threadId: "thread-1", answer: "[A] Approve" }));
  });

  it("opens the thread panel with the run and thread ids from the chevron", async () => {
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: RUN, stages: STAGES, graph: GRAPH }] }) });
    await slot.findByText("Plan Implement Review");

    const openButton = slot.getByRole("button", { name: /open in (right )?panel/i });
    openButton.click();

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "attractor-run", params: { runId: "run-1", threadId: "thread-1" }, title: "Plan Implement Review" },
    });
  });
});
