// @vitest-environment happy-dom
// The BB page chrome is outside the shared canvas gesture runners. Exercise
// its real React hooks and controls against an Editor and Loro document here.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Editor } from "@ensembleworks/canvas-editor";
import { dumpModel, LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { usePageSwitcher } from "../canvas/pages/switcher/use-page-switcher.js";
import { pageDoor } from "../canvas/pages/page-door.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mount(width = 1000) {
  const doc = LoroCanvasDoc.create({ peerId: 1n });
  doc.putPage({ id: "page:p", name: "Sketches", index: "a0" });
  doc.commit();
  const editor = new Editor({ doc, pageId: "page:p", now: () => 0, random: () => 0.5 });
  const writes = vi.spyOn(editor, "applyAll");
  // Electron throws for prompt(). Return null here to emulate an unavailable
  // dialog without an uncaught event exception masking the missing editor.
  const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
  function Harness() {
    const { tabs, overlays } = usePageSwitcher({ editor, snapshot: dumpModel(doc),
      currentPageId: "page:p", containerWidth: width });
    return <>{tabs}{overlays}</>;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
  return { doc, writes, prompt };
}

function input(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>('[data-canvas-page-rename="page:p"]');
  expect(node, "rename must open an inline editor in BB").not.toBeNull();
  return node!;
}

async function type(text: string) {
  const node = input();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(key: string) {
  await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true,
  })));
}

async function begin(entry: "tab" | "context" | "popover") {
  if (entry === "popover") {
    await act(async () => { pageDoor.open(); });
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Rename Sketches"]')!.click());
  } else {
    const tab = document.querySelector('[data-canvas-page-tab="page:p"]')!;
    await act(async () => tab.dispatchEvent(new MouseEvent(entry === "tab" ? "dblclick" : "contextmenu", {
      bubbles: true, cancelable: true,
    })));
    if (entry === "context") {
      await act(async () => document.querySelector<HTMLButtonElement>('[data-canvas-page-tab-menu-item="rename"]')!.click());
    }
  }
}

it.each(["tab", "context", "popover"] as const)("renames from %s with one committed document write", async (entry) => {
  const { doc, writes, prompt } = await mount(entry === "popover" ? 160 : 1000);
  await begin(entry);
  expect(input().value).toBe("Sketches");
  expect(document.activeElement).toBe(input());
  expect(input().selectionStart).toBe(0);
  expect(input().selectionEnd).toBe("Sketches".length);
  await type("Design review");
  expect(writes).not.toHaveBeenCalled();
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Sketches");
  await key("Enter");
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Design review");
  expect(writes).toHaveBeenCalledExactlyOnceWith([{ type: "RenamePage", id: "page:p", name: "Design review" }]);
  expect(prompt).not.toHaveBeenCalled();
  expect(document.querySelector("[data-canvas-page-rename]")).toBeNull();
});

it("Escape discards the draft and leaves the Pages menu open", async () => {
  const { doc, writes } = await mount(160);
  await begin("popover");
  await type("Discard me");
  await key("Escape");
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Sketches");
  expect(writes).not.toHaveBeenCalled();
  expect(document.querySelector("[data-canvas-page-rename]")).toBeNull();
  expect(document.querySelector("[data-canvas-page-menu]")).not.toBeNull();
});

it("blur saves the draft once", async () => {
  const { doc, writes } = await mount();
  await begin("tab");
  await type("Save on blur");
  await act(async () => input().blur());
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Save on blur");
  expect(writes).toHaveBeenCalledTimes(1);
});

it.each(["", "Sketches"])("refuses an empty or unchanged name (%j)", async (draft) => {
  const { doc, writes } = await mount();
  await begin("tab");
  await type(draft);
  await key("Enter");
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Sketches");
  expect(writes).not.toHaveBeenCalled();
});

it("renames from the Pages menu when the tab strip is also visible", async () => {
  const { doc, writes } = await mount(1000);
  await begin("popover");
  expect(document.querySelectorAll("[data-canvas-page-rename]")).toHaveLength(1);
  await type("Wide panel");
  await key("Enter");
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Wide panel");
  expect(writes).toHaveBeenCalledTimes(1);
});

it("clicking outside the Pages menu saves before dismissing its rename input", async () => {
  const { doc, writes } = await mount(160);
  await begin("popover");
  await type("Save on dismiss");
  const outside = document.createElement("button");
  document.body.append(outside);
  await act(async () => outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await act(async () => outside.focus());
  expect(doc.listPages().find(page => page.id === "page:p")?.name).toBe("Save on dismiss");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-canvas-page-menu]")).toBeNull();
});
