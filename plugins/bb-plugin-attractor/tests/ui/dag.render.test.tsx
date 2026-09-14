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
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null, ...overrides };
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
    const graphWithConditional: GraphView = {
      ...GRAPH,
      nodes: [...GRAPH.nodes, node("check", { handlerKind: "conditional", status: null, visit: 0 })],
    };
    const { container } = render(<DagView graph={graphWithConditional} events={[]} />);
    // Fingerprint the node's primary outline element the same way regardless
    // of whether it's a <rect>, <polygon> or <ellipse>, so every pair below
    // is provably distinct even though several used to render byte-identical
    // outlines (same tag, same attributes).
    const selector = (id: string) => `[data-node-id="${id}"] polygon, [data-node-id="${id}"] rect, [data-node-id="${id}"] ellipse`;
    const outlineOf = (id: string) => {
      const el = container.querySelector(selector(id))!;
      return [el.tagName, el.getAttribute("points"), el.getAttribute("rx"), el.getAttribute("width"), el.getAttribute("height")].join("|");
    };
    const shapeOf = (id: string) => container.querySelector(selector(id))?.tagName;
    expect(shapeOf("start")).toBe("polygon");
    expect(shapeOf("approve")).toBe("polygon"); // human
    expect(shapeOf("build")).toBe("polygon"); // command
    expect(shapeOf("plan")).toBe("ellipse"); // prompt
    expect(shapeOf("exit")).toBe("polygon");
    // exit (Msquare) must no longer be a plain rect indistinguishable from an agent/prompt node — it's a distinct shape entirely (polygon vs. ellipse).
    expect(outlineOf("exit")).not.toBe(outlineOf("plan"));
    // start (Mdiamond) must no longer share conditional's plain diamond outline.
    expect(outlineOf("start")).not.toBe(outlineOf("check"));
    // start (diamond) and approve (hexagon) and build (parallelogram) must not share the same outline.
    const shapes = new Set([outlineOf("start"), outlineOf("approve"), outlineOf("build")]);
    expect(shapes.size).toBe(3);
  });

  it("renders agent and prompt nodes as ellipses", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    expect(container.querySelector('[data-node-id="plan"] ellipse')).toBeTruthy();
  });

  it("titles a blocked agent/prompt node with its waiting reason (dogfood-2 fix)", () => {
    const blockedGraph: GraphView = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) => (n.id === "plan" ? { ...n, status: "blocked" as const, waitingReason: "permission" } : n)),
    };
    const { container } = render(<DagView graph={blockedGraph} events={[]} />);
    expect(container.querySelector('[data-node-id="plan"] title')?.textContent).toBe("Waiting: permission in worker thread");
  });

  it("does not title a blocked node when it has no waiting reason (e.g. a human gate)", () => {
    const blockedGraph: GraphView = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) => (n.id === "approve" ? { ...n, status: "blocked" as const } : n)),
    };
    const { container } = render(<DagView graph={blockedGraph} events={[]} />);
    expect(container.querySelector('[data-node-id="approve"] title')).toBeNull();
  });

  it("colors nodes by status", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    expect(container.querySelector('[data-node-id="start"]')?.getAttribute("data-status")).toBe("succeeded");
    expect(container.querySelector('[data-node-id="plan"]')?.getAttribute("data-status")).toBe("running");
    expect(container.querySelector('[data-node-id="build"]')?.getAttribute("data-status")).toBe("failed");
    expect(container.querySelector('[data-node-id="approve"]')?.getAttribute("data-status")).toBe("pending");
  });

  it("fills/strokes each status with the Graphviz-card palette, hollow pending, and a heavier stroke on the running node", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const outlineOf = (id: string) => container.querySelector(`[data-node-id="${id}"] polygon, [data-node-id="${id}"] rect, [data-node-id="${id}"] ellipse`)!;
    const start = outlineOf("start"); // succeeded
    expect(start.getAttribute("fill")).toBe("#dcfce7");
    expect(start.getAttribute("stroke")).toBe("#16a34a");
    const plan = outlineOf("plan"); // running
    expect(plan.getAttribute("fill")).toBe("#dbeafe");
    expect(plan.getAttribute("stroke")).toBe("#2563eb");
    expect(plan.getAttribute("stroke-width")).toBe("2.5");
    const build = outlineOf("build"); // failed
    expect(build.getAttribute("fill")).toBe("#fee2e2");
    expect(build.getAttribute("stroke")).toBe("#dc2626");
    const approve = outlineOf("approve"); // pending — hollow
    expect(approve.getAttribute("fill")).toBe("#ffffff");
    expect(approve.getAttribute("stroke")).toBe("#94a3b8");
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

  it("opens a clickable node's worker thread from the keyboard, with Enter and with Space", () => {
    const onOpenThread = vi.fn();
    const { container } = render(<DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-42" }} onOpenThread={onOpenThread} />);
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    fireEvent.keyDown(planNode, { key: "Enter" });
    fireEvent.keyDown(planNode, { key: " " });
    expect(onOpenThread.mock.calls).toEqual([["thread-42"], ["thread-42"]]);
    // An unrelated key does nothing.
    fireEvent.keyDown(planNode, { key: "a" });
    expect(onOpenThread).toHaveBeenCalledTimes(2);
  });

  it("gives a clickable node a visible affordance: a distinguishing CSS class, and a tooltip naming the worker thread", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-42" }} onOpenThread={() => {}} />);
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    expect(planNode.getAttribute("data-clickable")).toBe("true");
    expect((planNode.getAttribute("class") ?? "")).toMatch(/clickable/);
    expect(planNode.querySelector("title")?.textContent).toBe("Open worker thread thread-42");
  });

  it("does not give a non-clickable node the clickable affordance", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    expect(planNode.getAttribute("data-clickable")).toBe("false");
    expect(planNode.getAttribute("class") ?? "").not.toMatch(/clickable/);
    // A non-clickable node never carries the "open thread" tooltip, even the
    // dogfood-2 waiting-reason title on a *blocked* node stays distinct from it.
    expect(planNode.querySelector("title")?.textContent ?? "").not.toMatch(/^Open worker thread/);

    const approveNode = container.querySelector('[data-node-id="approve"]')!; // human node, never clickable
    expect(approveNode.getAttribute("data-clickable")).toBe("false");
  });

  it("gives every untraversed edge a legible, solid, grey Graphviz-style stroke — not the old near-invisible light dashed line", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const untraversed = container.querySelector('[data-edge="approve->build"]')!;
    expect(untraversed.getAttribute("stroke")).toBe("#94a3b8");
    expect(untraversed.getAttribute("stroke-width")).toBe("1.25");
    expect(untraversed.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("keeps a traversed edge blue/2px with the traversed arrowhead, unaffected by back-edge-ness", () => {
    const { container } = render(<DagView graph={GRAPH} events={EVENTS} />);
    const traversed = container.querySelector('[data-edge="start->plan"]')!;
    expect(traversed.getAttribute("stroke")).toBe("#2563eb");
    expect(traversed.getAttribute("stroke-width")).toBe("2");
    expect(traversed.getAttribute("marker-end")).toContain("attractor-arrow-traversed");
  });

  it("may dash an untraversed back edge while keeping it the same legible stroke colour/width", () => {
    const loopGraph: GraphView = {
      rankdir: "LR",
      nodes: [node("a", { handlerKind: "agent" }), node("b", { handlerKind: "agent" })],
      edges: [
        { from: "a", to: "b", label: null, condition: null },
        { from: "b", to: "a", label: "[R] Retry", condition: null },
      ],
    };
    const { container } = render(<DagView graph={loopGraph} events={[]} />);
    const backEdge = container.querySelector('[data-edge="b->a"]')!;
    expect(backEdge.getAttribute("data-back-edge")).toBe("true");
    expect(backEdge.getAttribute("stroke")).toBe("#94a3b8");
    expect(backEdge.getAttribute("stroke-width")).toBe("1.25");
    expect(backEdge.getAttribute("stroke-dasharray")).not.toBeNull();
  });

  it("draws an edge's DOT label on the diagram at its midpoint with a white text halo (no background rect), and keeps the title tooltip", () => {
    const { container } = render(<DagView graph={GRAPH} events={EVENTS} />);
    const labelGroup = container.querySelector('[data-edge-label="plan->approve"]')!;
    expect(labelGroup).toBeTruthy();
    const text = labelGroup.querySelector("text")!;
    expect(text.textContent).toBe("[A] Approve");
    expect(text.getAttribute("paint-order")).toBe("stroke");
    expect(text.getAttribute("stroke")).toBe("#fff");
    expect(text.getAttribute("stroke-width")).toBe("3");
    expect(text.getAttribute("fill")).toBe("#475569");
    expect(text.getAttribute("font-size")).toBe("11");
    expect(labelGroup.querySelector("rect")).toBeNull();
    expect(container.querySelector('[data-edge="plan->approve"] title')?.textContent).toContain("preferred_label");
  });

  it("falls back to a shortened routing condition as the on-diagram edge label when there is no DOT label", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const labelGroup = container.querySelector('[data-edge-label="build->exit"]')!;
    expect(labelGroup.querySelector("text")?.textContent).toBe("outcome=succeeded");
  });

  it("draws no on-diagram label for an edge with neither a DOT label nor a condition", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    expect(container.querySelector('[data-edge-label="start->plan"]')).toBeNull();
  });

  it("sizes the svg to fill its container width and scale by the natural viewBox aspect ratio, not a fixed 160px box", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(svg.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect((svg as unknown as HTMLElement).style.width).toBe("100%");
    expect((svg as unknown as HTMLElement).style.height).toBe("auto");
    expect(Number.parseInt((svg as unknown as HTMLElement).style.maxHeight, 10)).toBeGreaterThan(0);
    // No fixed white 160px box floor: the element must not carry a
    // `min-height` at all, so a small diagram in a narrow card shrinks with
    // its own viewBox aspect ratio instead of flooring at a fixed height.
    expect((svg as unknown as HTMLElement).style.minHeight).toBe("");
  });

  it("renders two parallel edges between the same node pair as distinct, non-colliding React elements", () => {
    // A legal DOT dialect graph can route two alternative conditions between
    // the same pair of nodes (e.g. two outcomes of a conditional both
    // leading elsewhere then converging). Both edges must render — with no
    // duplicate-key collision — and each keep its own selection reason.
    const graph: GraphView = {
      rankdir: "TB",
      nodes: [node("check", { handlerKind: "conditional" }), node("fix", { handlerKind: "agent" })],
      edges: [
        { from: "check", to: "fix", label: null, condition: "outcome=failed" },
        { from: "check", to: "fix", label: null, condition: "outcome=partially_succeeded" },
      ],
    };
    const events: RunEvent[] = [
      { type: "run.started", runId: "run-1", ts: 1 },
      { type: "edge.selected", runId: "run-1", ts: 2, from: "check", to: "fix", reason: "condition", edgeLabel: "outcome=failed" },
    ];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<DagView graph={graph} events={events} />);
    expect(container.querySelectorAll('[data-edge="check->fix"]')).toHaveLength(2);
    const keyWarning = errorSpy.mock.calls.some((call) => String(call[0]).includes("same key"));
    expect(keyWarning).toBe(false);
    errorSpy.mockRestore();
  });
});
