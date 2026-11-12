// @vitest-environment jsdom
/**
 * `ui/attention-card.tsx`, the one card the chat, the composer banner and the
 * top of the side panel all share (run-panel redesign). These render the
 * panel surface directly — the chat and banner surfaces add only a header,
 * covered through the real host harness in tests/app.test.tsx and
 * tests/ui/active-runs-banner.test.tsx — and walk the card's states: a human
 * gate, a worker's own prompt, a provider pause, several requests at once,
 * running, failed, stopped and finished.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttentionCard, type AttentionActions } from "../../ui/attention-card";
import type { EventView } from "../../ui/run-model";
import type { GraphView, RunView, StageView } from "../../server/contracts";

afterEach(cleanup);

const NOW = new Date(2026, 10, 12, 18, 0, 0).getTime();

function node(id: string, handlerKind: string, label = id, extra: Partial<GraphView["nodes"][number]> = {}): GraphView["nodes"][number] {
  return { id, label, shape: "box", handlerKind, goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null, ...extra };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [node("start", "start"), node("research", "agent", "Research"), node("approve", "human", "Approve plan?"), node("bump", "agent", "Bump versions"), node("exit", "exit")],
  edges: [
    { from: "start", to: "research", label: null, condition: null },
    { from: "research", to: "approve", label: null, condition: null },
    { from: "approve", to: "bump", label: "[A] Approve", condition: null },
    { from: "approve", to: "research", label: "[R] Revise", condition: null, freeform: true },
    { from: "bump", to: "exit", label: null, condition: null },
  ],
};

const RUN: RunView = {
  id: "run-1", threadId: "thread-1", projectId: "p", environmentId: "e", title: "Upgrade", source: "", status: "running",
  currentNodeId: "research", context: {}, goalGateFailures: [], finalOutcome: null, error: null, createdAt: NOW - 10 * 60_000, updatedAt: NOW, finishedAt: null,
};

function stage(nodeId: string, overrides: Partial<StageView> = {}): StageView {
  return {
    runId: "run-1", stageId: `${nodeId}@1`, nodeId, visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null,
    providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: NOW - 9 * 60_000, completedAt: NOW - 8 * 60_000,
    ...overrides,
  };
}

function actions(overrides: Partial<AttentionActions> = {}): AttentionActions & { answer: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; openThread: ReturnType<typeof vi.fn> } {
  return { answer: vi.fn(async () => null), resume: vi.fn(async () => null), openThread: vi.fn(), ...overrides } as never;
}

function card(run: RunView, stages: StageView[], acts = actions(), events: EventView[] = []) {
  const utils = render(<AttentionCard surface="panel" run={run} stages={stages} graph={GRAPH} events={events} now={NOW} actions={acts} />);
  return { ...utils, acts };
}

const GATE_STAGES: StageView[] = [
  stage("start"),
  stage("research", { threadId: "research-thread" }),
  stage("approve", {
    status: "blocked", outcomeStatus: null, completedAt: null, startedAt: NOW - 3 * 60_000,
    gateContext: { context: { nodeId: "research", label: "Research", text: "the plan", threadId: "research-thread" }, reviewTarget: { path: "PLAN.md", text: "# Migration plan" } },
  }),
];

describe("AttentionCard — human gate", () => {
  it("asks the question with what it follows, previews the review target, and says where each option leads", () => {
    const { getByTestId, getByText, getByRole } = card({ ...RUN, status: "blocked" }, GATE_STAGES);
    expect(getByTestId("attention-card").getAttribute("data-attention")).toBe("requests");
    const request = getByTestId("attention-request");
    expect(request.textContent).toContain("Approve plan?");
    expect(request.textContent).toContain("Asked after Research · waiting 3m");
    expect(getByText("# Migration plan")).toBeTruthy();
    expect(getByTestId("gate-routes").textContent).toBe("Approve → Bump versions · Revise → back to Research");
    expect(getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(getByRole("button", { name: "Revise" })).toBeTruthy();
  });

  it("answers with the option's raw edge label, or with free text when the gate allows it", async () => {
    const { getByRole, getByLabelText, acts } = card({ ...RUN, status: "blocked" }, GATE_STAGES);
    fireEvent.click(getByRole("button", { name: "Revise" }));
    await waitFor(() => expect(acts.answer).toHaveBeenCalledWith("[R] Revise"));
    fireEvent.change(getByLabelText("Answer Approve plan? in your own words"), { target: { value: "split it in two" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() => expect(acts.answer).toHaveBeenCalledWith("split it in two"));
  });

  it("shows a refused answer inline", async () => {
    const { getByRole, findByRole } = card({ ...RUN, status: "blocked" }, GATE_STAGES, actions({ answer: vi.fn(async () => "no pending human gate") }));
    fireEvent.click(getByRole("button", { name: "Approve" }));
    expect((await findByRole("alert")).textContent).toContain("no pending human gate");
  });

  it("opens the predecessor's thread", () => {
    const { getByRole, acts } = card({ ...RUN, status: "blocked" }, GATE_STAGES);
    fireEvent.click(getByRole("button", { name: "Open Research’s thread" }));
    expect(acts.openThread).toHaveBeenCalledWith("research-thread");
  });
});

describe("AttentionCard — worker prompt and provider pause", () => {
  it("offers only 'Open worker to answer' for a worker's own prompt", () => {
    const stages = [stage("start"), stage("research", { status: "blocked", completedAt: null, threadId: "w-1", waitingReason: "permission", waitingSince: NOW - 60_000 })];
    const { getByTestId, getByRole, acts } = card({ ...RUN, status: "blocked" }, stages);
    expect(getByTestId("attention-request").textContent).toContain("Research’s worker is waiting on permission");
    fireEvent.click(getByRole("button", { name: "Open worker to answer" }));
    expect(acts.openThread).toHaveBeenCalledWith("w-1");
  });

  it("shows a provider pause's reset time, countdown and progress", () => {
    const retryAt = NOW + 30 * 60_000;
    const stages = [
      stage("start"),
      stage("research", { status: "blocked", completedAt: null, threadId: "w-1", waitingReason: "Rate limited, retrying at 18:30", waitingSince: NOW - 30 * 60_000, waitingUntil: retryAt }),
    ];
    const { getByTestId } = card({ ...RUN, status: "blocked" }, stages);
    const request = getByTestId("attention-request");
    expect(request.textContent).toContain("Waiting for your usage limit to reset");
    expect(request.textContent).toContain("Resumes 18:30 · in 30m");
    expect((getByTestId("pause-progress") as HTMLElement).style.width).toBe("50%");
  });

  it("shows one request at a time with a count, gates first, and steps through them with Next", () => {
    const stages = [...GATE_STAGES, stage("bump", { status: "blocked", completedAt: null, threadId: "w-2", waitingReason: "permission", waitingSince: NOW })];
    const { getByTestId, getByRole } = card({ ...RUN, status: "blocked" }, stages);
    expect(getByTestId("attention-count").textContent).toBe("1 of 2");
    expect(getByTestId("attention-request").textContent).toContain("Approve plan?");
    fireEvent.click(getByRole("button", { name: "Next request" }));
    expect(getByTestId("attention-count").textContent).toBe("2 of 2");
    expect(getByTestId("attention-request").textContent).toContain("Bump versions’s worker is waiting on permission");
  });
});

describe("AttentionCard — running, failed, finished", () => {
  it("says nothing needs you while a stage runs", () => {
    const { getByTestId } = card(RUN, [stage("start"), stage("research", { status: "running", outcomeStatus: null, completedAt: null, startedAt: NOW - 2 * 60_000 })]);
    expect(getByTestId("attention-running").textContent).toContain("Research");
    expect(getByTestId("attention-running").textContent).toContain("Nothing needs you right now.");
  });

  it("names the failed stage and why, with the output tail, and resumes from the checkpoint", async () => {
    const run: RunView = { ...RUN, status: "failed", finishedAt: NOW, currentNodeId: "research", context: { response: { research: "line 1\nline 2\nboom" } } };
    const events = [{ seq: 1, runId: "run-1", ts: NOW, type: "stage.failed", stageId: "research@1#1", nodeId: "research", visit: 1, attempt: 1, error: "worker crashed", willRetry: false }] as unknown as EventView[];
    const { getByTestId, getByRole, acts } = card(run, [stage("start"), stage("research", { status: "failed", outcomeStatus: "failed", threadId: "w-1" })], actions(), events);
    const failed = getByTestId("attention-failed");
    expect(failed.textContent).toContain("Research failed");
    expect(failed.textContent).toContain("worker crashed");
    expect(failed.textContent).toContain("boom");
    fireEvent.click(getByRole("button", { name: "Resume from Research" }));
    await waitFor(() => expect(acts.resume).toHaveBeenCalled());
    fireEvent.click(getByRole("button", { name: "Open worker" }));
    expect(acts.openThread).toHaveBeenCalledWith("w-1");
  });

  it("words a stopped run as the user's own doing", () => {
    const { getByTestId } = card({ ...RUN, status: "cancelled", finishedAt: NOW }, [stage("start"), stage("research", { status: "cancelled", outcomeStatus: null })]);
    expect(getByTestId("attention-failed").textContent).toContain("You stopped this run at Research");
  });

  it("shows a finished run's last output, the decisions taken and the time split", () => {
    const run: RunView = { ...RUN, status: "succeeded", finishedAt: NOW, currentNodeId: "exit", context: { response: { bump: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") } } };
    const events = [{ seq: 1, runId: "run-1", ts: NOW, type: "human.answered", stageId: "approve@1", nodeId: "approve", answer: "[A] Approve", actor: "ui" }] as unknown as EventView[];
    const { getByTestId, getByRole, acts } = card(run, [stage("start"), stage("research"), stage("approve"), stage("bump", { threadId: "bump-thread" })], actions(), events);
    const finished = getByTestId("attention-finished");
    expect(finished.textContent).toContain("Finished at Bump versions");
    expect(finished.textContent).toContain("line 8");
    expect(finished.textContent).not.toContain("line 9");
    expect(finished.textContent).toContain("Approve plan?: Approve");
    fireEvent.click(getByRole("button", { name: "Show all (4 more lines)" }));
    expect(getByTestId("attention-finished").textContent).toContain("line 12");
    fireEvent.click(getByRole("button", { name: "Open Bump versions’s thread" }));
    expect(acts.openThread).toHaveBeenCalledWith("bump-thread");
  });
});
