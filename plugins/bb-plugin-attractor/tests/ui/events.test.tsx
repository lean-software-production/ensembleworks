// @vitest-environment jsdom
/**
 * `ui/events.tsx`'s Event log (run-panel redesign): "story" by default —
 * milestones grouped by pass with clock times, routing and checkpoint events
 * hidden and counted — and "raw": every event one per line, a filter, one
 * list (no pages), Copy and JSON export. The view choice is remembered.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../../ui/events";
import type { EventView } from "../../ui/run-model";
import type { GraphView, StageView } from "../../server/contracts";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function node(id: string, handlerKind: string, label = id): GraphView["nodes"][number] {
  return { id, label, shape: "box", handlerKind, goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [node("start", "start"), node("build", "agent", "Build"), node("check", "command", "Check"), node("exit", "exit")],
  edges: [
    { from: "start", to: "build", label: null, condition: null },
    { from: "build", to: "check", label: null, condition: null },
    { from: "check", to: "build", label: null, condition: "outcome=fail" },
    { from: "check", to: "exit", label: null, condition: "outcome=success" },
  ],
};

function stage(nodeId: string, visit: number, startedAt: number, completedAt: number | null): StageView {
  return {
    runId: "r1", stageId: `${nodeId}@${visit}`, nodeId, visit, attempt: 1, status: completedAt ? "succeeded" : "running",
    outcomeStatus: completedAt ? "succeeded" : null, threadId: null, providerId: null, model: null, reasoningLevel: null,
    actor: null, waitingReason: null, startedAt, completedAt,
  };
}

const STAGES: StageView[] = [stage("start", 1, 1, 2), stage("build", 1, 3, 10), stage("check", 1, 11, 12), stage("build", 2, 13, null)];

let seq = 0;
const ev = (e: Record<string, unknown>) => ({ runId: "r1", ts: 1_000, seq: ++seq, ...e }) as unknown as EventView;
function events(): EventView[] {
  seq = 0;
  return [
    ev({ type: "run.started" }),
    ev({ type: "checkpoint.saved", stageId: "build" }),
    ev({ type: "edge.selected", from: "start", to: "build", reason: "unconditional" }),
    ev({ type: "stage.started", stageId: "build@1#1", nodeId: "build", visit: 1, attempt: 1 }),
    ev({ type: "agent.thread", stageId: "build@1", nodeId: "build", visit: 1, threadId: "worker-1", provider: "claude-code", model: "sonnet", reasoningLevel: null }),
    ev({ type: "stage.completed", stageId: "build@1#1", nodeId: "build", visit: 1, attempt: 1, outcome: { status: "succeeded" }, wallTimeMs: 7_000 }),
    ev({ type: "stage.started", stageId: "check@1#1", nodeId: "check", visit: 1, attempt: 1 }),
    ev({ type: "stage.completed", stageId: "check@1#1", nodeId: "check", visit: 1, attempt: 1, outcome: { status: "fail", text: "2 failing\nmore" }, wallTimeMs: 1_000 }),
    ev({ type: "edge.selected", from: "check", to: "build", reason: "condition" }),
    ev({ type: "stage.started", stageId: "build@2#1", nodeId: "build", visit: 2, attempt: 1 }),
  ];
}

function renderLog(evts = events(), onOpenThread = vi.fn()) {
  const utils = render(<EventLog runId="r1-abcdefgh" events={evts} stages={STAGES} graph={GRAPH} onOpenThread={onOpenThread} />);
  return { ...utils, onOpenThread };
}

describe("EventLog — story", () => {
  it("is the default, shows milestones grouped by pass, and hides and counts routing and checkpoint events", () => {
    const { container, getByTestId } = renderLog();
    expect(getByTestId("event-story")).toBeTruthy();
    const kinds = Array.from(container.querySelectorAll("[data-story-kind]")).map((el) => el.getAttribute("data-story-kind"));
    expect(new Set(kinds)).toEqual(new Set(["milestone"]));
    expect(Array.from(container.querySelectorAll("[data-story-pass]")).map((el) => el.textContent)).toEqual(["Pass 1", "Pass 2"]);
    expect(getByTestId("event-story").textContent).toContain("Hidden: 2 routing, 1 checkpoint events");
    // A command's first output line is its story.
    expect(getByTestId("event-story").textContent).toContain("Check: 2 failing");
  });

  it("brings routing and checkpoint events back with the chips", () => {
    const { container, getByRole } = renderLog();
    fireEvent.click(getByRole("button", { name: "+ Routing" }));
    expect(container.querySelectorAll('[data-story-kind="routing"]')).toHaveLength(2);
    fireEvent.click(getByRole("button", { name: "+ Checkpoints" }));
    expect(container.querySelectorAll('[data-story-kind="checkpoint"]')).toHaveLength(1);
  });

  it("links a started agent stage to its worker thread", () => {
    const { getAllByRole, onOpenThread } = renderLog();
    fireEvent.click(getAllByRole("button", { name: "worker" })[0]!);
    expect(onOpenThread).toHaveBeenCalledWith("worker-1");
  });

  it("shows no pass headers when the run has not looped", () => {
    const { container } = render(<EventLog runId="r1" events={events().slice(0, 6)} stages={STAGES.slice(0, 2)} graph={GRAPH} />);
    expect(container.querySelectorAll("[data-story-pass]")).toHaveLength(0);
  });
});

describe("EventLog — raw", () => {
  it("lists every event one per line in a single list, with no pages", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ type: "log", runId: "r1", ts: 0, seq: i + 1, message: `entry ${i + 1}` }) as unknown as EventView);
    const { container, getByRole } = renderLog(many);
    fireEvent.click(getByRole("button", { name: "Raw" }));
    expect(container.querySelectorAll("[data-event-seq]")).toHaveLength(120);
    expect(container.querySelector('[data-event-seq="1"]')?.textContent).toMatch(/^#1 \d\d:\d\d:\d\d log entry 1$/);
    expect(container.textContent).not.toMatch(/older|newer/i);
  });

  it("filters by type, node or text and says how many match", () => {
    const { container, getByRole, getByLabelText } = renderLog();
    fireEvent.click(getByRole("button", { name: "Raw" }));
    fireEvent.change(getByLabelText("Filter events"), { target: { value: "edge.selected" } });
    expect(Array.from(container.querySelectorAll("[data-event-seq]")).map((el) => el.getAttribute("data-event-type"))).toEqual(["edge.selected", "edge.selected"]);
    expect(container.textContent).toContain("2 of 10 match");
  });

  it("copies the matching lines", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { getByRole, getByLabelText } = renderLog();
    fireEvent.click(getByRole("button", { name: "Raw" }));
    fireEvent.change(getByLabelText("Filter events"), { target: { value: "run.started" } });
    fireEvent.click(getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/^#1 \d\d:\d\d:\d\d run\.started$/));
  });

  it("remembers the chosen view", () => {
    const first = renderLog();
    fireEvent.click(first.getByRole("button", { name: "Raw" }));
    first.unmount();
    const second = renderLog();
    expect(second.getByTestId("event-raw")).toBeTruthy();
  });
});
