import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Editor } from "@ensembleworks/canvas-editor";
import { openThreadFromCanvas } from "../canvas/thread-navigation.js";
import { parseThreadReturnRoute, threadReturnSubPath } from "../canvas/thread-return-route.js";
import { createPageRouter, pageIdFromSubPath } from "../canvas/pages/page-route.js";
import type { ReturnBookmark } from "../canvas/thread-return.js";

describe("canvas to full BB thread", () => {
  it("captures the live view before navigating, without editing the document", () => {
    const doc = LoroCanvasDoc.create({ peerId: 31n });
    doc.putPage({ id: "page:p", name: "Release work", index: "a0" });
    doc.commit();
    const editor = new Editor({ doc, pageId: "page:p", now: () => 0, random: () => .5 });
    editor.apply({ type: "SetCamera", x: -123, y: 67, z: .75 });
    const order: string[] = [];
    let saved: ReturnBookmark | null = null;
    openThreadFromCanvas(editor, "thread-a", { toThread: id => {
      order.push(`open:${id}`);
      expect(saved).toMatchObject({ threadId: id, pageId: "page:p", camera: editor.get().camera });
    } }, bookmark => { saved = bookmark; order.push("save"); }, "token-a");
    expect(order).toEqual(["save", "open:thread-a"]);
    expect(saved).toMatchObject({ pageName: "Release work", token: "token-a", selection: [] });
    expect(doc.listPages()).toHaveLength(1);
  });
});

describe("return routes", () => {
  it("keeps the page deep-link readable with or without local return memory", () => {
    const path = threadReturnSubPath("page:release", "token-123");
    expect(pageIdFromSubPath(path)).toBe("page:release");
    expect(parseThreadReturnRoute(path)?.token).toBe("token-123");
    expect(pageIdFromSubPath("page:release")).toBe("page:release");
    expect(parseThreadReturnRoute("page:a/return/../bad")).toBeNull();
  });

  it("adopts a return page, preserves its token, then lets the next tab click navigate", () => {
    const router = createPageRouter();
    const applied: unknown[] = [], navigated: unknown[] = [];
    const ports = { apply: (intent: unknown) => applied.push(intent), navigate: {
      toPluginPanel: (path: string, options: unknown) => navigated.push({ path, options }),
    } };
    const base = { subPath: threadReturnSubPath("page:b", "token-b"), livePageIds: ["page:a", "page:b"] };
    router.reconcile({ ...base, currentPageId: "page:a" }, ports);
    expect(applied).toEqual([{ type: "SetCurrentPage", pageId: "page:b" }]);
    router.reconcile({ ...base, currentPageId: "page:b" }, ports);
    expect(navigated).toEqual([]);
    router.reconcile({ ...base, currentPageId: "page:a" }, ports);
    expect(navigated).toEqual([{ path: "canvas", options: { subPath: "page:a", replace: false } }]);
  });
});
