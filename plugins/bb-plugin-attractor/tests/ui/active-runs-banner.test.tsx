// @vitest-environment jsdom
/**
 * `ui/active-runs-banner.tsx`'s composer banner. Since the run-panel
 * redesign each row is the attention card (`surface="banner"`): the same
 * derived state as the chat card and the panel, so a gate's options, a
 * provider pause's reset time and a worker's prompt read the same in all
 * three. Renders nothing with zero active runs; the chevron opens the panel
 * with the run and thread ids; the row no longer expands into a graph.
 *
 * Rendered through the SDK's `loadPluginApp`/`renderSlot` harness, as
 * tests/app.test.tsx does for the directive/panel — the banner calls
 * `useComposerView()`/`useRpc()`/`useBbNavigate()` directly, which only
 * resolve against fakes once the plugin's app module has been evaluated
 * after the test runtime is installed.
 */
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

  it("renders each row as the attention card: title, status pill, the current stage and progress — and no graph", async () => {
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: RUN, stages: STAGES, graph: GRAPH }] }) });
    await slot.findByText("Plan Implement Review");
    const card = slot.getByTestId("attention-card");
    expect(card.getAttribute("data-surface")).toBe("banner");
    expect(card.getAttribute("data-attention")).toBe("running");
    expect(slot.container.querySelector('[data-run-status="running"]')?.textContent).toContain("Running");
    expect(slot.getByText("Plan")).toBeTruthy();
    // A graph with no loop: one progress segment per node.
    expect(slot.container.querySelectorAll('[data-testid="attractor-progress"] [data-segment]')).toHaveLength(3);
    expect(slot.queryByRole("img", { name: "Workflow DAG" })).toBeNull();
    expect(slot.queryByRole("button", { name: /expand run details/i })).toBeNull();
  });

  it("renders a blocked human gate's options as answer buttons saying where each leads, calling answerGate with the raw edge label", async () => {
    let answerCalledWith: unknown = null;
    const slot = await renderBanner({
      activeRuns: () => ({ runs: [{ run: GATE_RUN, stages: GATE_STAGES, graph: GATE_GRAPH }] }),
      answerGate: (input: unknown) => {
        answerCalledWith = input;
        return { answered: true };
      },
    });
    await slot.findByText("Gate run");
    expect(slot.container.querySelector('[data-run-status="blocked"]')?.textContent).toContain("Needs you");
    expect(slot.getByTestId("gate-routes").textContent).toBe("Approve → exit · Revise → Revise");
    expect(slot.getByRole("button", { name: "Revise" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(answerCalledWith).toEqual({ runId: "run-2", threadId: "thread-1", answer: "[A] Approve" }));
  });

  it("reports a refused answer inline instead of failing silently", async () => {
    const slot = await renderBanner({
      activeRuns: () => ({ runs: [{ run: GATE_RUN, stages: GATE_STAGES, graph: GATE_GRAPH }] }),
      answerGate: () => ({ answered: false, reason: "no pending human gate for this run" }),
    });
    await slot.findByText("Gate run");
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    expect((await slot.findByRole("alert")).textContent).toContain("no pending human gate");
  });

  it("shows the reviewed file and opens the gate's predecessor thread", async () => {
    const stagesWithContext: StageView[] = GATE_STAGES.map((stage) =>
      stage.nodeId === "gate"
        ? {
            ...stage,
            gateContext: {
              context: { nodeId: "plan", label: "Plan", text: "1. do the thing", threadId: "plan-worker-thread" },
              reviewTarget: { path: "PLAN.md", text: "# Plan" },
            },
          }
        : stage,
    );
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: GATE_RUN, stages: stagesWithContext, graph: GATE_GRAPH }] }) });
    await slot.findByText("Gate run");
    expect(slot.getByText("PLAN.md")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /open plan’s thread/i }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "plan-worker-thread" });
  });

  it("shows a provider pause with its reset time and a countdown", async () => {
    const retryAt = Date.now() + 61 * 60_000 + 30_000;
    const paused: StageView[] = [
      STAGES[0]!,
      { ...STAGES[1]!, status: "blocked", waitingReason: "Rate limited, retrying at 2026-11-12 20:20 UTC", waitingSince: Date.now() - 60_000, waitingUntil: retryAt },
    ];
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: { ...RUN, status: "blocked" }, stages: paused, graph: GRAPH }] }) });
    await slot.findByText("Plan Implement Review");
    expect(slot.container.querySelector('[data-run-status="blocked"]')?.textContent).toContain("Paused");
    const hh = String(new Date(retryAt).getHours()).padStart(2, "0");
    const mm = String(new Date(retryAt).getMinutes()).padStart(2, "0");
    expect(slot.getByTestId("attention-request").textContent).toBe(`Usage limit reached. Resumes by itself at ${hh}:${mm}, in 1h 01m.`);
  });

  it("offers 'Open worker to answer' for a worker's own prompt", async () => {
    const waiting: StageView[] = [STAGES[0]!, { ...STAGES[1]!, status: "blocked", waitingReason: "approval", waitingSince: Date.now() }];
    const slot = await renderBanner({ activeRuns: () => ({ runs: [{ run: { ...RUN, status: "blocked" }, stages: waiting, graph: GRAPH }] }) });
    await slot.findByText("Plan’s worker is waiting on approval");
    fireEvent.click(slot.getByRole("button", { name: "Open worker to answer" }));
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "worker-thread-1" });
  });

  it("keeps the last known rows when an activeRuns refresh fails, so a blocked run's banner does not vanish on a transient error", async () => {
    let calls = 0;
    const slot = await renderBanner({
      activeRuns: () => {
        calls += 1;
        if (calls === 1) return { runs: [{ run: GATE_RUN, stages: GATE_STAGES, graph: GATE_GRAPH }] };
        throw new Error("transient");
      },
    });
    await slot.findByText("Gate run");

    await slot.behavior.emitRealtime("attractor-runs", { runId: "run-2", threadId: "thread-1" });
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    // The failed refresh must not collapse the banner into the empty state.
    expect(slot.getByText("Gate run")).toBeTruthy();
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
