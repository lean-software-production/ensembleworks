import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasBus } from "../canvas/panel-bus.js";
import { createDockCallbacks } from "../canvas/dock/callbacks.js";
import { createDockPlacement, type DockPlacement } from "../canvas/dock/placement.js";
import { createDockRepaint, type DockRepaint } from "../canvas/dock/repaint.js";
import { createDockRoute } from "../canvas/dock/route.js";

interface FakeElement {
  readonly dataset: Record<string, string>;
  isConnected: boolean;
  parentElement: FakeElement | null;
  firstElementChild: FakeElement | null;
  lastElementChild: FakeElement | null;
  readonly style: { setProperty: (name: string, value: string) => void };
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  appendChild: (child: FakeElement) => FakeElement;
  prepend: (child: FakeElement) => void;
  contains: (node: object) => boolean;
  getBoundingClientRect: () => {
    readonly width: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
  };
}

function fakeElement(width = 0): FakeElement {
  const children: FakeElement[] = [];
  const element: FakeElement = {
    dataset: {},
    isConnected: false,
    parentElement: null,
    firstElementChild: null,
    lastElementChild: null,
    style: { setProperty: vi.fn() },
    offsetWidth: 240,
    offsetHeight: 160,
    appendChild(child) {
      children.push(child);
      child.parentElement = element;
      child.isConnected = true;
      element.firstElementChild = children[0] ?? null;
      element.lastElementChild = child;
      return child;
    },
    prepend(child) {
      children.unshift(child);
      child.parentElement = element;
      child.isConnected = true;
      element.firstElementChild = child;
      element.lastElementChild = children[children.length - 1] ?? null;
    },
    contains(node) {
      return node === element || children.some((child) => child === node);
    },
    getBoundingClientRect: () => ({
      width,
      left: 100,
      right: 100 + width,
      top: 40,
      bottom: 80,
    }),
  };
  return element;
}

function installDom(): {
  readonly root: HTMLDivElement;
  readonly row: FakeElement;
  readonly setRowWidth: (width: number) => void;
  readonly setRootConnected: (connected: boolean) => void;
} {
  let rowWidth = 800;
  const row = fakeElement(rowWidth);
  const body = fakeElement();
  body.isConnected = true;
  const documentStub = {
    body,
    head: { appendChild: vi.fn() },
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    title: "Canvas",
    hasFocus: () => true,
    createElement: () => fakeElement(),
    querySelector: (selector: string) =>
      selector === '[data-testid="app-page-header-content-row"]' ? row : null,
    querySelectorAll: () => [],
  };
  class ObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", {
    innerWidth: 1200,
    location: { pathname: "/" },
  });
  vi.stubGlobal("MutationObserver", ObserverStub);
  vi.stubGlobal("ResizeObserver", ObserverStub);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  const root = document.createElement("div");
  return {
    root,
    row,
    setRowWidth: (width) => {
      rowWidth = width;
      row.getBoundingClientRect = () => ({
        width: rowWidth,
        left: 100,
        right: 100 + rowWidth,
        top: 40,
        bottom: 80,
      });
    },
    setRootConnected: (connected) => {
      Object.defineProperty(root, "isConnected", {
        configurable: true,
        value: connected,
      });
    },
  };
}

function resetBus(): void {
  canvasBus.setAv({
    status: "off",
    muted: false,
    cameraOn: false,
    speaking: [],
    video: [],
    self: null,
  });
  canvasBus.clearRoster();
}

let repaint: DockRepaint | null = null;
let placement: DockPlacement | null = null;

afterEach(() => {
  placement?.stop();
  repaint?.stop();
  placement = null;
  repaint = null;
  resetBus();
  vi.unstubAllGlobals();
});

describe("dock callback binding", () => {
  it("late-binds the real route, repaint, and placement consumers", () => {
    const { root, row, setRowWidth, setRootConnected } = installDom();
    const callbacks = createDockCallbacks();
    const render = vi.fn();
    const apply = vi.fn();
    const route = createDockRoute({
      rpc: { call: () => new Promise<unknown>(() => {}) },
      isDisposed: () => false,
      selfIdentity: () => null,
      render: callbacks.render,
      onLocation: () => {},
    });
    repaint = createDockRepaint({ render: callbacks.render });
    const dockPlacement = createDockPlacement({
      root,
      popover: document.createElement("div"),
      route,
      rows: { sync: vi.fn(), clear: vi.fn(), retire: vi.fn() },
      initialSqueeze: "roomy",
      isDisposed: () => false,
      render: callbacks.render,
      apply: callbacks.apply,
    });
    placement = dockPlacement;

    expect(() => route.check()).toThrow("dock render callback is not bound");
    expect(() => canvasBus.setAv({ status: "connecting" })).toThrow(
      "dock render callback is not bound",
    );
    expect(() => dockPlacement.syncAnchor()).toThrow(
      "dock apply callback is not bound",
    );

    callbacks.setRender(render);
    callbacks.setApply(apply);
    window.location.pathname = "/settings";
    route.check();
    canvasBus.setAv({ status: "live" });
    setRootConnected(false);
    dockPlacement.syncAnchor();
    setRowWidth(300);
    dockPlacement.syncSqueeze();

    expect(render).toHaveBeenCalledTimes(4);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ type: "reanchored" });
    expect(row.lastElementChild).toBe(root);
  });
});
