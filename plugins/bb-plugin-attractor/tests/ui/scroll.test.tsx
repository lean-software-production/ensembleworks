// @vitest-environment jsdom
/**
 * Scroll-ownership regression tests for the plugin's four UI surfaces
 * (2026-09-14 "card/panel swallow the scroll" bug).
 *
 * Two rules, one per reported symptom:
 *
 * 1. **Chat/composer surfaces own no scrolling.** The message directive, the
 *    human-gate `pendingInteraction` and the composer banner all render
 *    inside containers BB scrolls (the thread timeline and the composer
 *    stack). A *bounded vertical scroll container* anywhere inside them sits
 *    under the pointer and consumes the wheel, so the thread stops scrolling
 *    while hovering the card — verified in Chromium: wheeling over an inner
 *    `max-height` + `overflow: auto` box leaves the outer scroller's
 *    `scrollTop` untouched, whereas `overflow: hidden`, `overflow-x: auto`
 *    and an exhausted inner scroller all chain to it normally. Nor may they
 *    `preventDefault()` a wheel event.
 *
 * 2. **The flush thread panel owns its scrolling.** `app.tsx` registers the
 *    panel action with `layout: "flush"`, which the SDK documents as "the
 *    full tab area (no padding, definite height, no host scrolling)" — so
 *    the panel root has to be the scroll container itself.
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

function baseRpc() {
  return {
    getRun: () => ({ run: RUN, stages: STAGES }),
    getGraph: () => GRAPH,
    getEvents: () => ({ events: [{ seq: 1, type: "run.started", runId: "run-1", ts: 1000 }] }),
    stopRun: () => ({ stopped: true }),
    activeRuns: () => ({ runs: [{ run: RUN, stages: STAGES, graph: GRAPH }] }),
  };
}

/** The inline/class shapes that make an element a *bounded vertical* scroll container — the one thing that steals the host's wheel. */
function boundedVerticalScrollers(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*")).filter((el) => {
    const overflowY = el.style.overflowY || el.style.overflow;
    const capped = Boolean(el.style.maxHeight || el.style.height);
    const inlineTrap = (overflowY === "auto" || overflowY === "scroll") && capped;
    const classTrap = /(^|\s)overflow(-y)?-(auto|scroll)(\s|$)/.test(el.className) && /(^|\s)(max-h-|h-\d)/.test(el.className);
    return inlineTrap || classTrap;
  });
}

/** Wheel over the deepest element of `root` must reach the host, i.e. nothing may `preventDefault()` it. */
function wheelReachesHost(root: HTMLElement): boolean {
  const targets = Array.from(root.querySelectorAll<HTMLElement>("*"));
  return [root, ...targets].every((el) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    el.dispatchEvent(event);
    return !event.defaultPrevented;
  });
}

describe("scroll ownership: chat and composer surfaces never trap the wheel", () => {
  it("the expanded message-directive card has no bounded scroll container and cancels no wheel event", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    const slot = renderSlot(
      app.messageDirectives[0]!,
      { attributes: { run: "run-1" }, source: '::attractor-run{run="run-1"}', message: { id: "m1", threadId: "thread-1", turnId: null, projectId: null }, openWorkspaceFile: null },
      { rpc: baseRpc() as never },
    );
    fireEvent.click(await slot.findByRole("button", { name: /show stages/i }));
    expect(slot.getByTestId("attractor-stage-list")).toBeTruthy();

    expect(boundedVerticalScrollers(slot.container).map((el) => el.tagName)).toEqual([]);
    expect(wheelReachesHost(slot.container)).toBe(true);
  });

  it("the human gate's review target flows instead of scrolling in a capped box", async () => {
    const app = await loadPluginApp(() => import("../../app"));
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
            // A non-`.md` path takes the `<pre>` branch — the one that used to
            // be `maxHeight: 320; overflow: auto`, i.e. the wheel trap.
            reviewTarget: { path: "plan.txt", content: Array.from({ length: 400 }, (_, i) => `plan line ${i}`).join("\n"), error: null },
          },
        },
        submit: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
      },
      { rpc: baseRpc() as never },
    );
    // The defect itself first: the review target used to be a
    // `maxHeight: 320; overflow: auto` <pre>, i.e. exactly the bounded
    // vertical scroller that eats the thread's wheel.
    expect(boundedVerticalScrollers(slot.container).map((el) => el.tagName)).toEqual([]);
    expect(wheelReachesHost(slot.container)).toBe(true);

    const text = slot.container.querySelector<HTMLElement>("[data-review-target-text]")!;
    expect(text).toBeTruthy();
    expect(text.style.overflow).toBe("");
    expect(text.style.maxHeight).toBe("");
    // Wrapped, so losing the cap does not trade a vertical trap for sideways spill.
    expect(text.style.whiteSpace).toBe("pre-wrap");
  });

  it("the expanded active-runs composer banner has no bounded scroll container and cancels no wheel event", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    const banner = app.composerCustomizations[0]!.banners![0]!;
    const slot = renderSlot(banner, {}, { rpc: baseRpc() as never, composer: { scope: { kind: "thread", threadId: "thread-1" } } });
    await slot.findByText("Plan Implement Review");
    fireEvent.click(slot.getByRole("button", { name: /expand run details/i }));
    expect(await slot.findByRole("img", { name: "Workflow DAG" })).toBeTruthy();

    expect(boundedVerticalScrollers(slot.container).map((el) => el.tagName)).toEqual([]);
    expect(wheelReachesHost(slot.container)).toBe(true);
  });
});

describe("scroll ownership: the flush thread panel scrolls itself", () => {
  it("registers the panel with layout: flush, which makes the component responsible for scrolling", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    expect(app.threadPanelActions[0]!.layout).toBe("flush");
  });

  it("makes the panel root a full-height, min-h-0, vertically scrollable column", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    const slot = renderSlot(app.threadPanelActions[0]!, { threadId: "thread-1", params: { runId: "run-1" } }, { rpc: baseRpc() as never });
    const root = await slot.findByTestId("attractor-run-panel");

    // Without these the flush tab's definite height simply clips the stage
    // table and event log, with nothing able to scroll down to them.
    for (const className of ["h-full", "min-h-0", "overflow-y-auto", "flex", "flex-col"]) {
      expect(root.className.split(/\s+/)).toContain(className);
    }
    // …and the content that used to be clipped is inside that scroller.
    await waitFor(() => expect(root.querySelector('[data-testid="attractor-stage-list"]')).toBeTruthy());
    expect(root.querySelector('[data-testid="attractor-event-timeline"]')).toBeTruthy();
  });
});
