// @vitest-environment jsdom
/**
 * `ui/history.tsx`, the side panel's History accordion (run-panel redesign):
 * grouped by pass by default (a pass starts whenever the run re-enters a node
 * already in the current group — no graph analysis), one flat timeline for a
 * run that never looped, fan-out branches indented under their fork, and a
 * "List" view that is newest first with a text filter and kind chips.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { History, historyCount } from "../../ui/history";
import type { GraphView, StageView } from "../../server/contracts";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function node(id: string, handlerKind: string, label = id): GraphView["nodes"][number] {
  return { id, label, shape: "box", handlerKind, goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [node("start", "start"), node("build", "agent", "Build"), node("check", "command", "Check"), node("gate", "human", "Ship?"), node("fork", "parallel", "Fork"), node("a", "agent", "Branch A"), node("b", "agent", "Branch B"), node("exit", "exit")],
  edges: [],
};

let t = 0;
function stage(nodeId: string, visit: number, overrides: Partial<StageView> = {}): StageView {
  t += 10;
  return {
    runId: "r1", stageId: `${nodeId}@${visit}`, nodeId, visit, attempt: 1, status: "succeeded", outcomeStatus: "succeeded", threadId: null,
    providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: t, completedAt: t + 5, ...overrides,
  };
}

function looped(passes: number): StageView[] {
  t = 0;
  const out = [stage("start", 1)];
  for (let v = 1; v <= passes; v++) out.push(stage("build", v, { threadId: `build-${v}` }), stage("check", v, v === passes ? {} : { status: "failed", outcomeStatus: "failed" }));
  return out;
}

const renderHistory = (stages: StageView[], onOpenThread = vi.fn()) => ({ ...render(<History stages={stages} graph={GRAPH} events={[]} now={10_000} onOpenThread={onOpenThread} />), onOpenThread });

describe("History — by pass", () => {
  it("shows a run that never looped as one flat timeline with no pass headers", () => {
    t = 0;
    const { container } = renderHistory([stage("start", 1), stage("build", 1), stage("check", 1)]);
    expect(container.querySelectorAll("[data-pass], [data-pass-fold]")).toHaveLength(0);
    expect(Array.from(container.querySelectorAll("[data-history-stage]")).map((el) => el.getAttribute("data-history-stage"))).toEqual(["start@1", "build@1", "check@1"]);
  });

  it("starts a new pass on re-entering a node, keeps the last two passes open and folds the older ones", () => {
    const { container, getByRole } = renderHistory(looped(4));
    expect(Array.from(container.querySelectorAll("[data-pass]")).map((el) => el.getAttribute("data-pass"))).toEqual(["3", "4"]);
    const fold = getByRole("button", { name: /Passes 1–2/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    // The two open passes show their own stages; the folded ones do not.
    expect(container.querySelector('[data-history-stage="build@4"]')).toBeTruthy();
    expect(container.querySelector('[data-history-stage="build@1"]')).toBeNull();
    fireEvent.click(fold);
    expect(Array.from(container.querySelectorAll("[data-pass]")).map((el) => el.getAttribute("data-pass"))).toEqual(["1", "2", "3", "4"]);
  });

  it("links each pass's worker threads", () => {
    const { getAllByRole, onOpenThread } = renderHistory(looped(2));
    fireEvent.click(getAllByRole("button", { name: "Open Build" }).at(-1)!);
    expect(onOpenThread).toHaveBeenCalledWith("build-2");
  });

  it("indents fan-out branches under their fork, in branch order", () => {
    t = 0;
    const stages = [stage("start", 1), stage("fork", 1), stage("b", 1, { parallelGroupId: "fork@1", branchIndex: 1 }), stage("a", 1, { parallelGroupId: "fork@1", branchIndex: 0 }), stage("exit", 1)];
    const { container } = renderHistory(stages);
    const rows = Array.from(container.querySelectorAll("[data-history-stage]")).map((el) => [el.getAttribute("data-history-stage"), el.getAttribute("data-depth")]);
    expect(rows).toEqual([["start@1", "0"], ["fork@1", "0"], ["a@1", "1"], ["b@1", "1"], ["exit@1", "0"]]);
  });

  it("counts stages and, once looped, passes for the accordion header", () => {
    t = 0;
    expect(historyCount([stage("start", 1)])).toBe("1 stage");
    expect(historyCount(looped(3))).toBe("7 stages · 3 passes");
  });
});

describe("History — list", () => {
  it("lists stages newest first with their pass, filtered by text and by kind chip", () => {
    const { container, getByRole, getByLabelText } = renderHistory([...looped(2), stage("gate", 1, { status: "blocked", completedAt: null })]);
    fireEvent.click(getByRole("button", { name: "List" }));
    const ids = () => Array.from(container.querySelectorAll("[data-history-row]")).map((el) => el.getAttribute("data-history-row"));
    expect(ids()).toEqual(["gate@1", "check@2", "build@2", "check@1", "build@1", "start@1"]);
    expect(container.querySelector('[data-history-row="build@1"]')?.textContent).toContain("pass 1");

    fireEvent.click(getByRole("button", { name: /^Failed \d/ }));
    expect(ids()).toEqual(["check@1"]);
    fireEvent.click(getByRole("button", { name: /^Gates \d/ }));
    expect(ids()).toEqual(["gate@1"]);
    fireEvent.click(getByRole("button", { name: /^Agents \d/ }));
    expect(ids()).toEqual(["build@2", "build@1"]);

    fireEvent.click(getByRole("button", { name: /^All \d/ }));
    fireEvent.change(getByLabelText("Filter stages"), { target: { value: "check" } });
    expect(ids()).toEqual(["check@2", "check@1"]);
  });

  it("remembers the chosen view", () => {
    const first = renderHistory(looped(2));
    fireEvent.click(first.getByRole("button", { name: "List" }));
    first.unmount();
    expect(renderHistory(looped(2)).getByTestId("history-list")).toBeTruthy();
  });
});
