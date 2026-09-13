// @vitest-environment jsdom
/**
 * Rendering tests for ui/dag.tsx's `DagView`, per T5 acceptance: "node shape
 * hints (start/exit/human/command distinct); status colours …; visit badge
 * when > 1; current node highlighted; traversed edges emphasised with the
 * last-selected reason in a title; click on an agent node opens its worker
 * thread".
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DagView } from "../../ui/dag";
import type { GraphView } from "../../server/contracts";

// See tests/ui/events.test.tsx's identical `afterEach(cleanup)` comment.
afterEach(cleanup);
import type { RunEvent } from "../../engine/types";

function node(id: string, overrides: Partial<GraphView["nodes"][number]> = {}): GraphView["nodes"][number] {
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, ...overrides };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [
    node("start", { handlerKind: "start", status: "succeeded", visit: 1 }),
    node("plan", { handlerKind: "prompt", status: "running", visit: 1 }),
    node("approve", { handlerKind: "human", status: null, visit: 0 }),
    node("build", { handlerKind: "command", status: "failed", visit: 3 }),
    node("exit", { handlerKind: "exit", status: null, visit: 0 }),
  ],
  edges: [
    { from: "start", to: "plan", label: null, condition: null },
    { from: "plan", to: "approve", label: "[A] Approve", condition: null },
    { from: "approve", to: "build", label: null, condition: null },
    { from: "build", to: "exit", label: null, condition: "outcome=succeeded" },
  ],
};

const EVENTS: RunEvent[] = [
  { type: "run.started", runId: "run-1", ts: 1 },
  { type: "edge.selected", runId: "run-1", ts: 2, from: "start", to: "plan", reason: "unconditional" },
  { type: "edge.selected", runId: "run-1", ts: 3, from: "plan", to: "approve", reason: "preferred_label", edgeLabel: "Approve" },
];

describe("DagView", () => {
  it("gives start/exit/human/command nodes distinct shape hints", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const shapeOf = (id: string) => container.querySelector(`[data-node-id="${id}"] polygon, [data-node-id="${id}"] rect`)?.tagName;
    const pointsOf = (id: string) => container.querySelector(`[data-node-id="${id}"] polygon`)?.getAttribute("points");
    expect(shapeOf("start")).toBe("polygon");
    expect(shapeOf("approve")).toBe("polygon"); // human
    expect(shapeOf("build")).toBe("polygon"); // command
    expect(shapeOf("exit")).toBe("rect"); // exit stays a plain rect
    // start (diamond) and approve (hexagon) and build (parallelogram) must not share the same outline.
    const shapes = new Set([pointsOf("start"), pointsOf("approve"), pointsOf("build")]);
    expect(shapes.size).toBe(3);
  });

  it("colors nodes by status", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    expect(container.querySelector('[data-node-id="start"]')?.getAttribute("data-status")).toBe("succeeded");
    expect(container.querySelector('[data-node-id="plan"]')?.getAttribute("data-status")).toBe("running");
    expect(container.querySelector('[data-node-id="build"]')?.getAttribute("data-status")).toBe("failed");
    expect(container.querySelector('[data-node-id="approve"]')?.getAttribute("data-status")).toBe("pending");
  });

  it("shows a visit badge only when visit > 1", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    expect(container.querySelector('[data-node-id="build"] [data-visit-badge]')?.textContent).toBe("3");
    expect(container.querySelector('[data-node-id="start"] [data-visit-badge]')).toBeNull();
  });

  it("highlights the current node", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} currentNodeId="plan" />);
    expect(container.querySelector('[data-node-id="plan"]')?.getAttribute("data-current")).toBe("true");
    expect(container.querySelector('[data-node-id="build"]')?.getAttribute("data-current")).toBe("false");
  });

  it("emphasises traversed edges and titles them with the last-selected reason", () => {
    const { container } = render(<DagView graph={GRAPH} events={EVENTS} />);
    const traversed = container.querySelector('[data-edge="start->plan"]');
    expect(traversed?.getAttribute("data-traversed")).toBe("true");
    expect(traversed?.querySelector("title")?.textContent).toContain("unconditional");
    const withLabel = container.querySelector('[data-edge="plan->approve"]');
    expect(withLabel?.querySelector("title")?.textContent).toContain("preferred_label");
    expect(withLabel?.querySelector("title")?.textContent).toContain("Approve");
    const untraversed = container.querySelector('[data-edge="approve->build"]');
    expect(untraversed?.getAttribute("data-traversed")).toBe("false");
  });

  it("opens the worker thread when an agent/prompt node with a known thread is clicked", () => {
    const onOpenThread = vi.fn();
    const { container } = render(
      <DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-42" }} onOpenThread={onOpenThread} />,
    );
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    expect(planNode.getAttribute("role")).toBe("button");
    fireEvent.click(planNode);
    expect(onOpenThread).toHaveBeenCalledWith("thread-42");

    // A human node never opens a worker thread, even with a stray threadId mapping.
    const approveNode = container.querySelector('[data-node-id="approve"]')!;
    expect(approveNode.getAttribute("role")).toBeNull();
  });

  it("does not make a node clickable when its thread id is unknown", () => {
    const onOpenThread = vi.fn();
    const { container } = render(<DagView graph={GRAPH} events={[]} onOpenThread={onOpenThread} />);
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    expect(planNode.getAttribute("role")).toBeNull();
    fireEvent.click(planNode);
    expect(onOpenThread).not.toHaveBeenCalled();
  });
});
