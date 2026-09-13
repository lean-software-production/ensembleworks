// @vitest-environment jsdom
/**
 * `ui/stages.tsx`'s stage list, per T5 acceptance: "Panel: … stage list with
 * timing/visit/provider".
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageList, formatDuration } from "../../ui/stages";
import type { GraphView, StageView } from "../../server/contracts";

// See tests/ui/events.test.tsx's identical `afterEach(cleanup)` comment:
// this project's vitest config has no `test.globals`, so testing-library's
// own auto-cleanup never engages and `getByText`/`getByRole` (which query
// `document.body`) can otherwise see a previous test's leftover render.
afterEach(cleanup);

describe("formatDuration", () => {
  it("formats sub-second durations in whole seconds", () => {
    expect(formatDuration(400)).toBe("<1s");
  });
  it("formats seconds", () => {
    expect(formatDuration(12_000)).toBe("12s");
  });
  it("formats minutes and seconds", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
  it("formats hours, minutes and seconds", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });
});

function node(id: string, overrides: Partial<GraphView["nodes"][number]> = {}): GraphView["nodes"][number] {
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, ...overrides };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [node("start", { handlerKind: "start" }), node("plan", { label: "Plan", model: "claude-sonnet-5", provider: "anthropic" })],
  edges: [],
};

const STAGES: StageView[] = [
  { runId: "r1", stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, startedAt: 1000, completedAt: 1500 },
  { runId: "r1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: "thread-9", startedAt: 2000, completedAt: null },
];

describe("StageList", () => {
  it("renders one row per stage with node label, status, and visit", () => {
    const { getByText } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    expect(getByText("start")).toBeTruthy();
    expect(getByText("Plan")).toBeTruthy();
    expect(getByText("succeeded")).toBeTruthy();
    expect(getByText("running")).toBeTruthy();
  });

  it("shows a completed stage's fixed duration and a running stage's live elapsed time", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000 + 4_000} />);
    const durationOf = (stageId: string) => container.querySelector(`[data-stage-id="${stageId}"] td:nth-child(4)`)?.textContent;
    expect(durationOf("start@1")).toBe("<1s"); // start: 1500-1000
    expect(durationOf("plan@1")).toBe("4s"); // plan: still running, now - startedAt
  });

  it("shows the node's declared provider/model, or a placeholder when unset", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    const providerOf = (stageId: string) => container.querySelector(`[data-stage-id="${stageId}"] td:nth-child(5)`)?.textContent;
    expect(providerOf("plan@1")).toBe("anthropic / claude-sonnet-5");
    expect(providerOf("start@1")).toBe("—"); // start has no declared model/provider
  });

  it("opens a stage's worker thread when its thread link is clicked", () => {
    const onOpenThread = vi.fn();
    const { getByRole } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} onOpenThread={onOpenThread} />);
    fireEvent.click(getByRole("button", { name: /open thread/i }));
    expect(onOpenThread).toHaveBeenCalledWith("thread-9");
  });

  it("renders nothing scary when the graph hasn't loaded yet", () => {
    const { getByText } = render(<StageList stages={STAGES} graph={null} now={2000} />);
    // Falls back to the raw node id as the label.
    expect(getByText("plan")).toBeTruthy();
  });
});
