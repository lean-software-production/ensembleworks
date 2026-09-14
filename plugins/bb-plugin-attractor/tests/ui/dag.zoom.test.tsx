// @vitest-environment jsdom
/**
 * Zoom/pan controls for `ui/dag.tsx`'s `DagView` — a small overlaid control
 * cluster (zoom in / zoom out / fit), ctrl+wheel zoom (a plain wheel must
 * pass through untouched so the host still scrolls, per
 * tests/ui/scroll.test.tsx and the README's "Scroll ownership" section),
 * and pointer-drag panning.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("ctrl+wheel zooms about the cursor, keeping the graph point under it fixed on screen", () => {
    // A rect offset from the origin and scaled relative to the viewBox, so
    // the client->viewBox conversion actually has work to do.
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const [, , viewBoxWidthStr, viewBoxHeightStr] = svg.getAttribute("viewBox")!.split(" ");
    const viewBoxWidth = Number(viewBoxWidthStr);
    const viewBoxHeight = Number(viewBoxHeightStr);
    const rect = { left: 50, top: 20, width: viewBoxWidth * 2, height: viewBoxHeight * 2 };
    svg.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} }) as DOMRect;

    const clientX = 150;
    const clientY = 90;
    // Pivot in viewBox user units, replicating the conversion the fix must do.
    const pivot = { x: (clientX - rect.left) * (viewBoxWidth / rect.width), y: (clientY - rect.top) * (viewBoxHeight / rect.height) };

    fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true, clientX, clientY });

    const match = getTransform(container).match(/translate\(([-\d.]+), ([-\d.]+)\) scale\(([-\d.]+)\)/);
    expect(match).toBeTruthy();
    const [, txStr, tyStr, scaleStr] = match!;
    const tx = Number(txStr);
    const ty = Number(tyStr);
    const scale = Number(scaleStr);
    expect(scale).toBeCloseTo(1.2);
    // zoomAround's invariant: pivot stays fixed on screen, i.e.
    // tx + scale * localX == pivot.x for the local point under the pivot.
    const appliedFactor = scale / 1; // starting scale was 1
    const expectedTx = pivot.x - (pivot.x - 0) * appliedFactor;
    const expectedTy = pivot.y - (pivot.y - 0) * appliedFactor;
    expect(tx).toBeCloseTo(expectedTx);
    expect(ty).toBeCloseTo(expectedTy);
  });

  it("ctrl+wheel at the viewport centre matches the zoom-in button", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const [, , viewBoxWidthStr, viewBoxHeightStr] = svg.getAttribute("viewBox")!.split(" ");
    const viewBoxWidth = Number(viewBoxWidthStr);
    const viewBoxHeight = Number(viewBoxHeightStr);
    const rect = { left: 0, top: 0, width: viewBoxWidth, height: viewBoxHeight };
    svg.getBoundingClientRect = () => ({ ...rect, right: rect.width, bottom: rect.height, x: 0, y: 0, toJSON() {} }) as DOMRect;

    fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true, clientX: viewBoxWidth / 2, clientY: viewBoxHeight / 2 });
    const wheelTransform = getTransform(container);

    cleanup();
    const rerendered = render(<DagView graph={GRAPH} events={[]} />);
    fireEvent.click(rerendered.getByRole("button", { name: /zoom in/i }));
    const buttonTransform = getTransform(rerendered.container);

    expect(wheelTransform).toBe(buttonTransform);
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

  it("pans by the pointer delta converted into SVG viewBox units, not raw screen pixels", () => {
    // The <svg> renders scaled to its container (viewBox width !=
    // getBoundingClientRect().width here), so a screen-pixel drag delta must
    // be converted into viewBox user units before it's added to the
    // translate — otherwise the graph tracks the cursor at the wrong rate.
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const [, , viewBoxWidthStr] = svg.getAttribute("viewBox")!.split(" ");
    const viewBoxWidth = Number(viewBoxWidthStr);
    const renderedWidth = viewBoxWidth * 2; // svg rendered twice as wide as its viewBox
    svg.getBoundingClientRect = () =>
      ({ width: renderedWidth, height: 100, left: 0, top: 0, right: renderedWidth, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;

    fireEvent.pointerDown(svg, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 140, clientY: 100 }); // dx = 40 screen px
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 140, clientY: 100 });

    const match = getTransform(container).match(/translate\(([-\d.]+), ([-\d.]+)\)/);
    expect(match).toBeTruthy();
    const tx = Number(match![1]);
    // 40 screen px * (viewBoxWidth / renderedWidth) = 40 * 0.5 = 20 viewBox units.
    expect(tx).toBeCloseTo(40 * (viewBoxWidth / renderedWidth));
  });

  it("the DAG box wrapper uses overflow: hidden, never overflow: auto", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const wrapper = container.querySelector('[data-testid="dag-viewport"]') as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.style.overflow).toBe("hidden");
  });

  it("a drag that starts on a clickable node pans, and does not also open that node's worker thread", () => {
    // The two features have to coexist: grabbing the DAG to pan often means
    // grabbing it *by* a node, and the browser synthesises a click on that
    // node when the drag ends. Before the slop threshold + click suppression
    // that click navigated the human straight into the worker thread.
    const onOpenThread = vi.fn();
    const { container } = render(<DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-1" }} onOpenThread={onOpenThread} />);
    const svg = container.querySelector("svg")!;
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    const before = getTransform(container);

    fireEvent.pointerDown(planNode, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 120, clientY: 60 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 120, clientY: 60 });
    fireEvent.click(planNode);

    expect(getTransform(container)).not.toBe(before); // it really did pan
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("a plain click on a node (with the pixel or two of wobble a real press has) still opens its worker thread", () => {
    const onOpenThread = vi.fn();
    const { container } = render(<DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-1" }} onOpenThread={onOpenThread} />);
    const svg = container.querySelector("svg")!;
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    const before = getTransform(container);

    fireEvent.pointerDown(planNode, { pointerId: 1, button: 0, clientX: 10, clientY: 10, bubbles: true });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 11, clientY: 12 }); // under the threshold
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 11, clientY: 12 });
    fireEvent.click(planNode);

    expect(getTransform(container)).toBe(before); // no pan from a wobble
    expect(onOpenThread).toHaveBeenCalledWith("thread-1");
  });

  it("a drag never captures the pointer until it has actually become a pan", () => {
    // Pointer capture re-targets the browser's synthesised `click` to the
    // capturing element, so capturing on pointerdown would break node clicks.
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const capture = vi.fn();
    (svg as unknown as { setPointerCapture: unknown }).setPointerCapture = capture;
    (svg as unknown as { releasePointerCapture: unknown }).releasePointerCapture = vi.fn();

    fireEvent.pointerDown(svg, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    expect(capture).not.toHaveBeenCalled();
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 11, clientY: 11 });
    expect(capture).not.toHaveBeenCalled(); // still under the threshold
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 80, clientY: 80 });
    expect(capture).toHaveBeenCalledWith(1);
  });

  it("releases pointer capture on pointerup and on pointercancel", () => {
    for (const endEvent of ["pointerUp", "pointerCancel"] as const) {
      const { container, unmount } = render(<DagView graph={GRAPH} events={[]} />);
      const svg = container.querySelector("svg")! as SVGSVGElement;
      const release = vi.fn();
      (svg as unknown as { setPointerCapture: unknown }).setPointerCapture = vi.fn();
      (svg as unknown as { releasePointerCapture: unknown }).releasePointerCapture = release;

      fireEvent.pointerDown(svg, { pointerId: 7, button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(svg, { pointerId: 7, clientX: 90, clientY: 90 });
      fireEvent[endEvent](svg, { pointerId: 7, clientX: 90, clientY: 90 });
      expect(release, endEvent).toHaveBeenCalledWith(7);
      unmount();
    }
  });

  it("removes its native wheel listener on unmount (no leaked listener on a detached DAG)", () => {
    const { container, unmount } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")!;
    // Sanity: while mounted, a ctrl+wheel is ours and gets preventDefault-ed.
    expect(fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true })).toBe(false);

    unmount();

    // After unmount the handler must be gone — a ctrl+wheel on the detached
    // node is now nobody's, so nothing cancels it.
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, ctrlKey: true });
    svg.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("still exposes nodes as focusable buttons when a click handler is provided", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} threadIdByNode={{ plan: "thread-1" }} onOpenThread={() => {}} />);
    const planNode = container.querySelector('[data-node-id="plan"]')!;
    expect(planNode.getAttribute("role")).toBe("button");
    expect(planNode.getAttribute("tabindex")).toBe("0");
  });
});
