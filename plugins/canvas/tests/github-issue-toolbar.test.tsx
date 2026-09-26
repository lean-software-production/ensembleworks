// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { CanvasChrome } from "../canvas/panel/session-view.js";
import { useGithubIssueDraft } from "../canvas/panel/github-draft.js";
import { GithubIssueShape } from "../canvas/shapes/GithubIssueShape.js";
import { githubCache } from "../canvas/github-cache-client.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { githubCache.configure(null); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount(placing: boolean) {
  const openAtCenter = vi.fn();
  const issueDraft = { placing, draftUi: null, arm: vi.fn(), cancel: vi.fn(), openAtCenter };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(CanvasChrome, {
    canvas: { activeToolId: "select", selectTool: vi.fn() }, editorState: { nextShapeStyle: {} }, issueDraft,
  } as any)));
  return { button: host.querySelector('[data-canvas-tool="github-issue"]') as HTMLButtonElement, openAtCenter, root };
}

it.each(["Enter", " "])("%s opens the armed issue draft from the keyboard", async (key) => {
  const { button, openAtCenter, root } = await mount(true);
  button.focus();
  await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  expect(openAtCenter).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("uses the shared coarse pointer target size", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const { button, root } = await mount(false);
  expect(button.style.width).toBe("44px");
  expect(button.style.height).toBe("44px");
  await act(async () => root.unmount());
});

it("creates a selected unlinked shape at the viewport centre after keyboard activation", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const canvas = { activeToolId: "select", selectTool: vi.fn(), dispatch: vi.fn() };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  function Harness() {
    const viewportRef = useRef<HTMLDivElement>(null);
    const issueDraft = useGithubIssueDraft({ get: () => ({ camera: { x: 0, y: 0, z: 1 } }) } as any,
      canvas as any, { shapes: [] } as any, viewportRef);
    return createElement("div", null,
      createElement("div", { ref: (element: HTMLDivElement | null) => {
        viewportRef.current = element;
        if (element) { Object.defineProperty(element, "clientWidth", { value: 800 }); Object.defineProperty(element, "clientHeight", { value: 600 }); }
      } }),
      createElement(CanvasChrome, { canvas, editorState: { nextShapeStyle: {} }, issueDraft } as any));
  }
  await act(async () => root.render(createElement(Harness)));
  const button = host.querySelector('[data-canvas-tool="github-issue"]') as HTMLButtonElement;
  await act(async () => button.click());
  expect(button.getAttribute("aria-pressed")).toBe("true");
  button.focus();
  await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(canvas.dispatch).toHaveBeenCalledOnce();
  const intents = canvas.dispatch.mock.calls[0][0];
  expect(intents[0].type).toBe("CreateShape");
  expect(intents[0].shape.props).toEqual({ w: 470, h: 256, schemaVersion: 2 });
  expect({ x: intents[0].shape.x, y: intents[0].shape.y }).toEqual({ x: 165, y: 172 });
  expect(intents[1]).toEqual({ type: "SetSelection", ids: [intents[0].shape.id] });
  expect(button.getAttribute("aria-pressed")).toBe("false");
  await act(async () => root.unmount());
});

it("places once, then gives later canvas pointer input back to other elements", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const canvas = { activeToolId: "select", selectTool: vi.fn(), dispatch: vi.fn() };
  const otherPointer = vi.fn();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  function Harness() {
    const viewportRef = useRef<HTMLDivElement>(null);
    const issueDraft = useGithubIssueDraft({ get: () => ({ camera: { x: 0, y: 0, z: 1 }, currentPageId: "page:p" }) } as any,
      canvas as any, { shapes: [] } as any, viewportRef);
    return createElement("div", null,
      createElement("div", { ref: viewportRef, onPointerDownCapture: issueDraft.place, "data-test-viewport": "" },
        createElement("div", { onPointerDown: otherPointer, "data-test-other": "" })),
      createElement(CanvasChrome, { canvas, editorState: { nextShapeStyle: {} }, issueDraft } as any));
  }
  await act(async () => root.render(createElement(Harness)));
  await act(async () => (host.querySelector('[data-canvas-tool="github-issue"]') as HTMLButtonElement).click());
  const other = host.querySelector('[data-test-other]') as HTMLElement;
  await act(async () => other.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })));
  expect(canvas.dispatch).toHaveBeenCalledOnce();
  expect(otherPointer).not.toHaveBeenCalled();
  await act(async () => other.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })));
  expect(canvas.dispatch).toHaveBeenCalledOnce();
  expect(otherPointer).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("leaves an unlinked card in place after a rejected URL, then links it through the project cache", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), dispatch = vi.fn();
  githubCache.configure({ call: async (_method: string, input: any) => ({
    state: input?.repo === "owner/repo" ? "ready" : "untracked", lastSyncedAt: null, issues: [],
  }) } as any);
  const shape = { id: "shape:issue", kind: "github-issue", parentId: "page:p", index: "a1", x: 0, y: 0,
    rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 470, h: 256, schemaVersion: 2 } };
  await act(async () => root.render(createElement(GithubIssueShape, { shape, dispatch } as any)));
  const input = host.querySelector('input[role="combobox"]') as HTMLInputElement;
  const form = host.querySelector("form") as HTMLFormElement;
  const setUrl = async (url: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, url);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await setUrl("https://github.com/other/repo/issues/1");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(dispatch).not.toHaveBeenCalled();
  expect(host.querySelector('[data-github-issue-unlinked]')).not.toBeNull();
  expect(host.textContent).toContain("not tracked");
  await setUrl("https://github.com/owner/repo/issues/42");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(dispatch).toHaveBeenCalledWith([{ type: "UpdateProps", id: shape.id,
    props: { issueUrl: "https://github.com/owner/repo/issues/42" } }]);
  await act(async () => root.unmount());
});
