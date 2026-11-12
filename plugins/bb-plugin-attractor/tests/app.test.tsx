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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { GraphView, RunView, StageView } from "../server/contracts";

const packageJson = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")) as {
  name: string;
  bb: { branding: unknown };
};

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
    expect(app.threadPanelActions.map((a) => ({ id: a.id, title: a.title, icon: a.icon }))).toEqual([{ id: "attractor-run", title: "Attractor run", icon: "attractor/main" }]);
  });

  // BB 0.45.0 paints a recognised contribution `icon` (such as the generic
  // "Workflow") ahead of the plugin's branding asset, so Attractor's own mark is
  // declared as the named icon `main` and the panel action names `attractor/main`.
  it("declares its existing mark as the named icon `main` alongside the branding icon", () => {
    // BB derives the plugin id, and so the glyph namespace, from the package name.
    expect(packageJson.name).toBe("bb-plugin-attractor");
    expect(packageJson.bb.branding).toEqual({
      icon: "./assets/icon.svg",
      experimental_icons: { main: "./assets/icon.svg" },
    });
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

  it("renders the directive as the chat attention card: title, status pill, current stage and progress — and no graph", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.messageDirectives[0]!, { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: baseRpc() });
    await slot.findByText("Plan Implement Review");
    const card = slot.getByTestId("attention-card");
    expect(card.getAttribute("data-surface")).toBe("chat");
    expect(card.getAttribute("data-attention")).toBe("running");
    expect(slot.container.querySelector('[data-run-status="running"]')?.textContent).toContain("Running");
    expect(slot.getByTestId("attention-running").textContent).toContain("Plan");
    // No loop in this graph: one progress segment per working node, "n of N stages".
    expect(slot.getByTestId("attractor-progress")).toBeTruthy();
    expect(slot.container.querySelector("svg[aria-label='Workflow DAG']")).toBeNull();
    expect(slot.queryByRole("button", { name: /show stages/i })).toBeNull();
  });

  it("renders the chat card as a BB card (rounded, bordered, at most 28rem wide)", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.messageDirectives[0]!, { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: baseRpc() });
    await slot.findByText("Plan Implement Review");
    const card = slot.getByTestId("attention-card");
    expect(card.className).toContain("rounded-lg");
    expect(card.className).toContain("border-border");
    expect(card.className).toContain("bg-card");
    expect((card as HTMLElement).style.maxWidth).toBe("28rem");
  });

  it("words the status pill by run state on the chat card", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const cases: [RunView["status"], string][] = [
      ["running", "Running"],
      ["succeeded", "Succeeded"],
      ["failed", "Failed"],
      ["cancelled", "Stopped"],
    ];
    for (const [status, word] of cases) {
      const slot = renderSlot(app.messageDirectives[0]!, { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null }, { rpc: baseRpc({ run: { ...RUN, status, finishedAt: status === "running" ? null : 2_000 } }) });
      await waitFor(() => expect(slot.container.querySelector(`[data-run-status="${status}"]`)?.textContent).toContain(word));
      cleanup();
    }
  });

  it("shows a finished run's last stage output on the chat card", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const done: StageView[] = [STAGES[0]!, { ...STAGES[1]!, status: "succeeded", outcomeStatus: "succeeded", completedAt: 1_900 }];
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc({ run: { ...RUN, status: "succeeded", finishedAt: 2_000, currentNodeId: "exit", context: { response: { plan: "The plan is ready." } } }, stages: done }) },
    );
    await waitFor(() => expect(slot.getByTestId("attention-finished")).toBeTruthy());
    expect(slot.getByTestId("attention-finished").textContent).toContain("Plan");
  });

  it("offers Resume on a failed run's chat card and calls resumeRun", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let resumedWith: unknown = null;
    const failed: StageView[] = [STAGES[0]!, { ...STAGES[1]!, status: "failed", outcomeStatus: "failed", completedAt: 1_900 }];
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      {
        rpc: {
          ...baseRpc({ run: { ...RUN, status: "failed", finishedAt: 2_000, error: "worker crashed" }, stages: failed }),
          resumeRun: (input: unknown) => {
            resumedWith = input;
            return { resumed: true, fromNodeId: "plan" };
          },
        },
      },
    );
    await waitFor(() => expect(slot.getByTestId("attention-failed")).toBeTruthy());
    expect(slot.getByTestId("attention-failed").textContent).toContain("worker crashed");
    slot.getByRole("button", { name: /resume from plan/i }).click();
    await waitFor(() => expect(resumedWith).toEqual({ runId: "run-1", threadId: "thread-1" }));
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
    const stopButton = await slot.findByRole("button", { name: /^stop$/i });
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
    await waitFor(() => expect(slot.container.querySelector('[data-run-status="blocked"]')).toBeTruthy());
    expect(slot.queryByRole("button", { name: /^stop$/i })).toBeTruthy();
  });

  it("does not offer a Stop button once the run has finished", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: { runId: "run-1" } },
      { rpc: baseRpc({ run: { ...RUN, status: "succeeded", finishedAt: 2_000 } }) },
    );
    await waitFor(() => expect(slot.container.querySelector('[data-run-status="succeeded"]')).toBeTruthy());
    expect(slot.queryByRole("button", { name: /^stop$/i })).toBeNull();
    expect(slot.queryByRole("button", { name: /^resume$/i })).toBeNull();
  });

  it("replaces Stop with Resume in the panel header once a run has failed or been stopped, calling resumeRun", async () => {
    const app = await loadPluginApp(() => import("../app"));
    for (const status of ["failed", "cancelled"] as const) {
      let resumedWith: unknown = null;
      const slot = renderSlot(
        app.threadPanelActions[0]!,
        { threadId: "thread-1", params: { runId: "run-1" } },
        { rpc: { ...baseRpc({ run: { ...RUN, status, finishedAt: 2_000 } }), resumeRun: (input: unknown) => { resumedWith = input; return { resumed: true, fromNodeId: "plan" }; } } },
      );
      const resume = await slot.findByRole("button", { name: /^resume$/i });
      expect(slot.queryByRole("button", { name: /^stop$/i })).toBeNull();
      resume.click();
      await waitFor(() => expect(resumedWith).toEqual({ runId: "run-1", threadId: "thread-1" }));
      cleanup();
    }
  });

  it("reports a refused resume in the panel header", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: { runId: "run-1" } },
      { rpc: { ...baseRpc({ run: { ...RUN, status: "failed", finishedAt: 2_000 } }), resumeRun: () => ({ resumed: false, reason: "run is already active" }) } },
    );
    (await slot.findByRole("button", { name: /^resume$/i })).click();
    await waitFor(() => expect(slot.getAllByRole("alert").some((el) => el.textContent?.includes("run is already active"))).toBe(true));
  });

  it("lays the panel out as header, attention card, Now, then Graph/History/Event log accordions collapsed by default, remembering open ones", async () => {
    localStorage.clear();
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-1", params: { runId: "run-1" } }, { rpc: baseRpc() });
    await slot.findByText("Plan Implement Review");
    expect(slot.getByTestId("attention-card").getAttribute("data-surface")).toBe("panel");
    const toggles = Array.from(slot.container.querySelectorAll("[data-accordion] button[aria-expanded]"));
    expect(toggles.map((t) => t.textContent)).toEqual([expect.stringContaining("Graph"), expect.stringContaining("History"), expect.stringContaining("Event log")]);
    expect(toggles.map((t) => t.getAttribute("aria-expanded"))).toEqual(["false", "false", "false"]);
    expect(slot.container.querySelector("svg[aria-label='Workflow DAG']")).toBeNull();

    (toggles[0] as HTMLButtonElement).click();
    await waitFor(() => expect(slot.container.querySelector('[data-node-id="plan"][data-status="running"]')).toBeTruthy());
    cleanup();

    // Re-opening the panel keeps the graph open.
    const again = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-1", params: { runId: "run-1" } }, { rpc: baseRpc() });
    await again.findByText("Plan Implement Review");
    expect(again.container.querySelector('[data-node-id="plan"]')).toBeTruthy();
    localStorage.clear();
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
    await waitFor(() => expect(slot.container.querySelector('[data-run-status="running"]')).toBeTruthy());
    await slot.behavior.emitRealtime("attractor-runs", { runId: "run-1", threadId: "thread-1" });
    await waitFor(() => expect(slot.container.querySelector('[data-run-status="succeeded"]')).toBeTruthy());
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
