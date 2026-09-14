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


  // Adversarial: the tests above all start from the identity zoom state
  // (scale 1, no pan) and a rect whose x/y ratios match. These two exercise
  // the cases a wrong frame or a mixed-up axis survives: a pre-existing pan,
  // a scale != 1 before the gesture, an off-centre cursor, and a rect whose
  // horizontal and vertical viewBox-to-client ratios differ.
  function stubRect(svg: SVGSVGElement, rect: { left: number; top: number; width: number; height: number }): void {
    svg.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} }) as DOMRect;
  }
  function parseTransform(container: HTMLElement): { tx: number; ty: number; scale: number } {
    const match = getTransform(container).match(/translate\(([-\d.e]+), ([-\d.e]+)\) scale\(([-\d.e]+)\)/);
    expect(match).toBeTruthy();
    return { tx: Number(match![1]), ty: Number(match![2]), scale: Number(match![3]) };
  }

  it("ctrl+wheel keeps the cursor's graph point fixed even with a pre-existing pan, a scale != 1 and a non-square rect", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const [, , vbWidthStr, vbHeightStr] = svg.getAttribute("viewBox")!.split(" ");
    const vbWidth = Number(vbWidthStr);
    const vbHeight = Number(vbHeightStr);
    // Deliberately different horizontal and vertical ratios and a non-zero origin.
    const rect = { left: 37, top: 11, width: vbWidth * 3, height: vbHeight * 1.5 };
    stubRect(svg, rect);
    const ratioX = vbWidth / rect.width;
    const ratioY = vbHeight / rect.height;

    // Pre-existing state: zoomed in twice (scale 1.44) and panned off-origin.
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    fireEvent.pointerDown(svg, { pointerId: 7, button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(svg, { pointerId: 7, clientX: 253, clientY: 121 });
    fireEvent.pointerUp(svg, { pointerId: 7, clientX: 253, clientY: 121 });
    const before = parseTransform(container);
    expect(before.scale).toBeCloseTo(1.44);
    expect(before.tx).not.toBe(0);
    expect(before.ty).not.toBe(0);

    // An off-centre cursor, nowhere near the graph's centre.
    const clientX = rect.left + rect.width * 0.22;
    const clientY = rect.top + rect.height * 0.71;
    // The graph-space point (i.e. pre-transform, dagre coordinates) under it.
    const viewX = (clientX - rect.left) * ratioX;
    const viewY = (clientY - rect.top) * ratioY;
    const graphX = (viewX - before.tx) / before.scale;
    const graphY = (viewY - before.ty) / before.scale;

    fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true, clientX, clientY });

    const after = parseTransform(container);
    expect(after.scale).toBeCloseTo(before.scale * 1.2);
    // That same graph point must still land under the same client pixel:
    // graph -> viewBox via translate(tx,ty) scale(s), viewBox -> client via
    // the rect ratio and origin.
    const backX = (after.tx + after.scale * graphX) / ratioX + rect.left;
    const backY = (after.ty + after.scale * graphY) / ratioY + rect.top;
    expect(backX).toBeCloseTo(clientX);
    expect(backY).toBeCloseTo(clientY);
  });

  it("a pan moves the picture by the pointer's screen delta at any zoom scale (translate is outside the scale)", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const [, , vbWidthStr, vbHeightStr] = svg.getAttribute("viewBox")!.split(" ");
    const vbWidth = Number(vbWidthStr);
    const vbHeight = Number(vbHeightStr);
    const rect = { left: 37, top: 11, width: vbWidth * 3, height: vbHeight * 1.5 };
    stubRect(svg, rect);

    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    const before = parseTransform(container);
    expect(before.scale).toBeCloseTo(1.44);

    const dx = 60;
    const dy = -24;
    fireEvent.pointerDown(svg, { pointerId: 9, button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(svg, { pointerId: 9, clientX: 300 + dx, clientY: 200 + dy });
    fireEvent.pointerUp(svg, { pointerId: 9, clientX: 300 + dx, clientY: 200 + dy });

    const after = parseTransform(container);
    expect(after.scale).toBe(before.scale);
    // The picture must move dx/dy *screen* px — i.e. the translate (which
    // sits outside the scale) changes by the delta in viewBox units, with no
    // division by the zoom scale, and each axis by its own ratio.
    expect((after.tx - before.tx) / (vbWidth / rect.width)).toBeCloseTo(dx);
    expect((after.ty - before.ty) / (vbHeight / rect.height)).toBeCloseTo(dy);
  });


  // jsdom has neither `getScreenCTM` nor `createSVGPoint`, so every test
  // above exercises only the rect-ratio fallback. A real browser takes the
  // CTM branch — these two cover it, and the `display: none` case where a
  // browser's `getScreenCTM()` returns null.
  /** A minimal browser-like CTM: uniform `scale` plus the svg's screen origin. */
  function stubScreenCTM(svg: SVGSVGElement, scale: number, originX: number, originY: number): void {
    const inverse = {
      a: 1 / scale,
      d: 1 / scale,
      e: -originX / scale,
      f: -originY / scale,
    };
    (svg as unknown as { getScreenCTM: () => unknown }).getScreenCTM = () => ({
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      e: originX,
      f: originY,
      inverse: () => inverse,
    });
    (svg as unknown as { createSVGPoint: () => unknown }).createSVGPoint = () => {
      const point: { x: number; y: number; matrixTransform: (m: { a: number; d: number; e: number; f: number }) => { x: number; y: number } } = {
        x: 0,
        y: 0,
        matrixTransform: (m) => ({ x: point.x * m.a + m.e, y: point.y * m.d + m.f }),
      };
      return point;
    };
  }

  it("uses getScreenCTM (the browser path) for both the pan delta and the zoom pivot, honouring its origin", () => {
    const { getByRole, container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    const ctmScale = 2; // the svg renders at 2x its viewBox
    const originX = 64;
    const originY = 18;
    stubScreenCTM(svg, ctmScale, originX, originY);
    // A rect that would give the *wrong* answer, to prove the CTM wins.
    stubRect(svg, { left: 0, top: 0, width: 1, height: 1 });

    // Pan: a 50px screen drag must move the translate by 50 / ctmScale units.
    fireEvent.pointerDown(svg, { pointerId: 3, button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(svg, { pointerId: 3, clientX: 450, clientY: 280 });
    fireEvent.pointerUp(svg, { pointerId: 3, clientX: 450, clientY: 280 });
    const panned = parseTransform(container);
    expect(panned.tx).toBeCloseTo(50 / ctmScale);
    expect(panned.ty).toBeCloseTo(-20 / ctmScale);

    fireEvent.click(getByRole("button", { name: /zoom in/i }));
    const before = parseTransform(container);

    const clientX = 301;
    const clientY = 217;
    const viewX = (clientX - originX) / ctmScale;
    const viewY = (clientY - originY) / ctmScale;
    const graphX = (viewX - before.tx) / before.scale;
    const graphY = (viewY - before.ty) / before.scale;

    fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true, clientX, clientY });

    const after = parseTransform(container);
    expect(after.scale).toBeCloseTo(before.scale * 1.2);
    expect((after.tx + after.scale * graphX) * ctmScale + originX).toBeCloseTo(clientX);
    expect((after.ty + after.scale * graphY) * ctmScale + originY).toBeCloseTo(clientY);
  });

  it("survives a getScreenCTM() that returns null (an svg in a display:none container)", () => {
    const { container } = render(<DagView graph={GRAPH} events={[]} />);
    const svg = container.querySelector("svg")! as SVGSVGElement;
    (svg as unknown as { getScreenCTM: () => null }).getScreenCTM = () => null;
    (svg as unknown as { createSVGPoint: () => never }).createSVGPoint = () => {
      throw new Error("createSVGPoint must not be called when there is no CTM");
    };
    const [, , vbWidthStr] = svg.getAttribute("viewBox")!.split(" ");
    const vbWidth = Number(vbWidthStr);
    stubRect(svg, { left: 0, top: 0, width: vbWidth * 2, height: 100 });

    expect(() => {
      fireEvent.wheel(svg, { deltaY: -100, ctrlKey: true, clientX: 30, clientY: 40 });
      fireEvent.pointerDown(svg, { pointerId: 5, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(svg, { pointerId: 5, clientX: 50, clientY: 10 });
      fireEvent.pointerUp(svg, { pointerId: 5, clientX: 50, clientY: 10 });
    }).not.toThrow();
    // and it still falls back to the rect ratio: 40 screen px -> 20 units.
    const transform = getTransform(container);
    expect(transform).toMatch(/translate\(/);
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
