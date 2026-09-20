// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { CanvasChrome } from "../canvas/panel/session-view.js";
import { useGithubIssueDraft } from "../canvas/panel/github-draft.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

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

it("opens and focuses a local draft at the viewport centre after keyboard activation", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const canvas = { activeToolId: "select", selectTool: vi.fn() };
  function Harness() {
    const viewportRef = useRef<HTMLDivElement>(null);
    const issueDraft = useGithubIssueDraft({ get: () => ({ camera: { x: 0, y: 0, z: 1 } }) } as any,
      canvas as any, { shapes: [] } as any, viewportRef);
    return createElement("div", null,
      createElement("div", { ref: (element: HTMLDivElement | null) => {
        viewportRef.current = element;
        if (element) { Object.defineProperty(element, "clientWidth", { value: 800 }); Object.defineProperty(element, "clientHeight", { value: 600 }); }
      } }, issueDraft.draftUi),
      createElement(CanvasChrome, { canvas, editorState: { nextShapeStyle: {} }, issueDraft } as any));
  }
  await act(async () => root.render(createElement(Harness)));
  const button = host.querySelector('[data-canvas-tool="github-issue"]') as HTMLButtonElement;
  await act(async () => button.click());
  expect(button.getAttribute("aria-pressed")).toBe("true");
  button.focus();
  await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  const draft = host.querySelector('[data-canvas-github-draft]') as HTMLElement;
  expect(draft).not.toBeNull();
  expect(draft.style.left).toBe("165px");
  expect(draft.style.top).toBe("172px");
  expect(document.activeElement).toBe(draft.querySelector('input[aria-label="GitHub issue URL"]'));
  await act(async () => root.unmount());
});
