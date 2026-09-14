// @vitest-environment jsdom
/**
 * Zoom/pan controls for `ui/dag.tsx`'s `DagView` — a small overlaid control
 * cluster (zoom in / zoom out / fit), ctrl+wheel zoom (a plain wheel must
 * pass through untouched so the host still scrolls, per
 * tests/ui/scroll.test.tsx and the README's "Scroll ownership" section),
 * and pointer-drag panning.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DagView } from "../../ui/dag";
import type { GraphView } from "../../server/contracts";

afterEach(cleanup);

function node(id: string, overrides: Partial<GraphView["nodes"][number]> = {}): GraphView["nodes"][number] {
  return { id, label: id, shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0, model: null, provider: null, waitingReason: null, ...overrides };
}

const GRAPH: GraphView = {
  rankdir: "TB",
  nodes: [node("start", { handlerKind: "start" }), node("plan", { handlerKind: "prompt" }), node("exit", { handlerKind: "exit" })],
  edges: [
    { from: "start", to: "plan", label: null, condition: null },
    { from: "plan", to: "exit", label: null, condition: null },
  ],
};

function getTransform(container: HTMLElement): string {
  return container.querySelector('[data-testid="dag-zoom-group"]')!.getAttribute("transform") ?? "";
}

describe("DagView zoom/pan controls", () => {
  it("renders a zoom-in, zoom-out and fit control overlaid on the DAG box", () => {
    const { getByRole } = render(<DagView graph={GRAPH} events={[]} />);
    expect(getByRole("button", { name: /zoom in/i })).toBeTruthy();
    expect(getByRole("button", { name: /zoom out/i })).toBeTruthy();
    expect(getByRole("button", { name: /fit/i })).toBeTruthy();
  });

  it("the zoom-in button increases the inner group's scale", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    const before = getTransform(container);
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    const after = getTransform(container);
    expect(after).not.toBe(before);
    expect(after).toMatch(/scale\(1\.[1-9]/);
  });

  it("the zoom-out button decreases the inner group's scale", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    const zoomedIn = getTransform(container);
    fireEvent.click(getByRole("button", { name: /zoom out/i }));
    const afterOut = getTransform(container);
    expect(afterOut).not.toBe(zoomedIn);
  });

  it("clamps zoom to a minimum and maximum scale", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    for (let i = 0; i < 30; i++) fireEvent.click(getByRole("button", { name: /zoom in/i }));
    const maxed = getTransform(container);
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    expect(getTransform(container)).toBe(maxed);

    for (let i = 0; i < 60; i++) fireEvent.click(getByRole("button", { name: /zoom out/i }));
    const minned = getTransform(container);
    fireEvent.click(getByRole("button", { name: /zoom out/i }));
    expect(getTransform(container)).toBe(minned);
  });

  it("the fit button restores the default fit-to-width transform after zooming", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    const initial = getTransform(container);
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    expect(getTransform(container)).not.toBe(initial);
    fireEvent.click(getByRole("button", { name: /fit/i }));
    expect(getTransform(container)).toBe(initial);
  });

  it("a plain wheel over the DAG does not zoom and does not call preventDefault (host must keep scrolling)", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")!;
    const before = getTransform(container);
    const notCancelled = fireEvent.wheel(svg, { deltaY: -100 });
    expect(notCancelled).toBe(true); // dispatchEvent returns false only when preventDefault was called
    expect(getTransform(container)).toBe(before);
  });

  it("ctrl+wheel over the DAG zooms and calls preventDefault", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")!;
    const before = getTransform(container);
    const notCancelled = fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true });
    expect(notCancelled).toBe(false);
    expect(getTransform(container)).not.toBe(before);
  });

  it("meta+wheel (pinch on macOS) also zooms", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")!;
    const before = getTransform(container);
    fireEvent.wheel(svg, { deltaY: -100, metaKey: true });
    expect(getTransform(container)).not.toBe(before);
  });

  it("pans via pointer drag once zoomed in", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    const zoomedTransform = getTransform(container);
    const svg = container.querySelector("svg")!;
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 140, clientY: 130 });
    const pannedTransform = getTransform(container);
    expect(pannedTransform).not.toBe(zoomedTransform);
  });

  it("the DAG box wrapper uses overflow: hidden, never overflow: auto", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const wrapper = container.querySelector('[data-testid="dag-viewport"]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.style.overflow).toBe("hidden");
  });

  it("still exposes nodes as focusable buttons when a click handler is provided", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-1" }} onOpenThread={() => {}} />);
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    expect(planNode.getAttribute("role")).toBe("button");
    expect(planNode.getAttribute("tabindex")).toBe("0");
  });
});
