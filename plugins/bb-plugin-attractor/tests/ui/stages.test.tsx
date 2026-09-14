// @vitest-environment jsdom
/**
 * `ui/stages.tsx`'s stage list, per T5 acceptance: "Panel: … stage list with
 * timing/visit/provider", and the follow-up compact layout: the table used
 * to have six columns (Node, Status, Visit, Duration, Provider, Thread),
 * which spilled sideways past the message-directive card's `max-w-md`
 * (28rem). It's now four columns (Node, Status, Duration, Thread) —
 * `Visit` folds into `Node` as a "×N" suffix, and `Provider` becomes muted
 * subtext under the node's name — with `table-layout: fixed` so no column
 * can push the table wider than its container. Cells are queried by
 * `data-col` rather than `td:nth-child(n)` so these tests don't re-encode
 * column order.
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
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null, ...overrides };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [node("start", { handlerKind: "start" }), node("plan", { label: "Plan", model: "claude-sonnet-5", provider: "anthropic" })],
  edges: [],
};

const STAGES: StageView[] = [
  { runId: "r1", stageId: "start@1", nodeId: "start", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: 1000, completedAt: 1500 },
  { runId: "r1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "running", outcomeStatus: null, threadId: "thread-9", providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: 2000, completedAt: null },
];

function cell(container: HTMLElement, stageId: string, col: string): string | null | undefined {
  return container.querySelector(`[data-stage-id="${stageId}"] [data-col="${col}"]`)?.textContent;
}

describe("StageList layout", () => {
  it("has exactly four columns: Node, Status, Duration, Thread — no separate Visit/Provider columns", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    const headers = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).toEqual(["Node", "Status", "Duration", "Thread"]);
  });

  it("uses a fixed table layout so no column can push the table wider than its container", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    const table = container.querySelector("table")!;
    expect(table.style.tableLayout).toBe("fixed");
    expect(table.querySelectorAll("colgroup col")).toHaveLength(4);
  });

  it("wraps/truncates cell content instead of growing the column (word-break, not nowrap)", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    const nodeCell = container.querySelector('[data-stage-id="plan@1"] [data-col="node"]') as HTMLElement;
    expect(nodeCell.style.whiteSpace).not.toBe("nowrap");
    expect(["break-word", "anywhere"]).toContain(nodeCell.style.overflowWrap);
  });
});

describe("StageList", () => {
  it("renders one row per stage with node label and status", () => {
    const { getByText } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    expect(getByText("start")).toBeTruthy();
    expect(getByText("Plan")).toBeTruthy();
    expect(getByText("succeeded")).toBeTruthy();
    expect(getByText("running")).toBeTruthy();
  });

  it("folds the visit count into the Node column as a ×N suffix, only when visit > 1", () => {
    const stages: StageView[] = [STAGES[0]!, { ...STAGES[1]!, visit: 2 }];
    const { container } = render(<StageList stages={stages} graph={GRAPH} now={2000} />);
    expect(cell(container, "plan@1", "node")).toContain("×2");
    // visit === 1 (the common case) shows no suffix at all.
    expect(cell(container, "start@1", "node")).not.toContain("×");
  });

  it("shows a completed stage's fixed duration and a running stage's live elapsed time", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000 + 4_000} />);
    expect(cell(container, "start@1", "duration")).toBe("<1s"); // start: 1500-1000
    expect(cell(container, "plan@1", "duration")).toBe("4s"); // plan: still running, now - startedAt
  });

  it("shows the node's declared provider/model as muted subtext under the node name, or nothing when unset", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    expect(cell(container, "plan@1", "node")).toContain("anthropic / claude-sonnet-5");
    expect(cell(container, "start@1", "node")).not.toContain("—"); // no dash placeholder cluttering the compact cell
  });

  it("prefers the stage's actually-resolved provider/model tuple over the node's merely-declared one", () => {
    const stages: StageView[] = [
      { runId: "r1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: "thread-9", providerId: "openai", model: "gpt-5", reasoningLevel: "high", actor: null, waitingReason: null, startedAt: 1000, completedAt: 1500 },
    ];
    const { container } = render(<StageList stages={stages} graph={GRAPH} now={2000} />);
    expect(cell(container, "plan@1", "node")).toContain("openai / gpt-5 (high)");
  });

  it("omits the reasoning level suffix when the resolved stage has none", () => {
    const stages: StageView[] = [
      { runId: "r1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: "thread-9", providerId: "openai", model: "gpt-5", reasoningLevel: null, actor: null, waitingReason: null, startedAt: 1000, completedAt: 1500 },
    ];
    const { container } = render(<StageList stages={stages} graph={GRAPH} now={2000} />);
    expect(cell(container, "plan@1", "node")).toContain("openai / gpt-5");
    expect(cell(container, "plan@1", "node")).not.toContain("(");
  });

  it("falls back to the node's declared provider/model when the stage has no resolved tuple yet", () => {
    const { container } = render(<StageList stages={STAGES} graph={GRAPH} now={2000} />);
    expect(cell(container, "plan@1", "node")).toContain("anthropic / claude-sonnet-5");
  });

  it("shows who answered a human gate stage in the status cell", () => {
    const stages: StageView[] = [
      { runId: "r1", stageId: "gate@1", nodeId: "gate", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null, providerId: null, model: null, reasoningLevel: null, actor: "ui", waitingReason: null, startedAt: 1000, completedAt: 1500 },
    ];
    const { container } = render(<StageList stages={stages} graph={GRAPH} now={2000} />);
    expect(cell(container, "gate@1", "status")).toBe("succeeded (answered via ui)");
  });

  it("shows a blocked agent stage's waiting reason and still offers the Open thread link", () => {
    const stages: StageView[] = [
      { runId: "r1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "blocked", outcomeStatus: null, threadId: "worker-1", providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: "permission: Edit file.ts", startedAt: 1000, completedAt: null },
    ];
    const onOpenThread = vi.fn();
    const { container, getByRole } = render(<StageList stages={stages} graph={GRAPH} now={2000} onOpenThread={onOpenThread} />);
    expect(cell(container, "plan@1", "status")).toBe("blocked (waiting: permission: Edit file.ts)");
    fireEvent.click(getByRole("button", { name: /open thread/i }));
    expect(onOpenThread).toHaveBeenCalledWith("worker-1");
  });

  it("shows what a blocked human gate is reviewing (gate-context follow-up)", () => {
    const stages: StageView[] = [
      {
        runId: "r1",
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
        waitingReason: null,
        gateContext: { context: null, reviewTarget: { path: "PLAN.md", text: "# The plan" } },
        startedAt: 1000,
        completedAt: null,
      },
    ];
    const { container } = render(<StageList stages={stages} graph={GRAPH} now={2000} />);
    expect(cell(container, "gate@1", "status")).toBe("blocked (reviewing PLAN.md)");
  });

  it("does not show 'reviewing' once the gate is no longer blocked", () => {
    const stages: StageView[] = [
      {
        runId: "r1",
        stageId: "gate@1",
        nodeId: "gate",
        visit: 1,
        attempt: 1,
        status: "succeeded",
        outcomeStatus: "succeeded",
        threadId: null,
        providerId: null,
        model: null,
        reasoningLevel: null,
        actor: "ui",
        waitingReason: null,
        gateContext: { context: null, reviewTarget: { path: "PLAN.md", text: "# The plan" } },
        startedAt: 1000,
        completedAt: 1500,
      },
    ];
    const { container } = render(<StageList stages={stages} graph={GRAPH} now={2000} />);
    expect(cell(container, "gate@1", "status")).toBe("succeeded (answered via ui)");
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
