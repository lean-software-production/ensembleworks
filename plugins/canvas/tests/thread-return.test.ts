import { describe, expect, it } from "vitest";
import { LoroCanvasDoc } from "@ensembleworks/canvas-doc";
import { Editor } from "@ensembleworks/canvas-editor";
import type { Page, Shape } from "@ensembleworks/canvas-model";
import { createReturnMemory, restoreThreadReturn, type ReturnBookmark } from "../canvas/thread-return.js";

const page = (id: string, name = id): Page => ({ id: id as Page["id"], name, index: "a0" });
const shape = (id: string, parentId: string): Shape => ({ id: id as Shape["id"], kind: "geo", parentId: parentId as Shape["id"] | Page["id"], index: "a1", x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { w: 10, h: 10 } });
const bookmark = (patch: Partial<ReturnBookmark> = {}): ReturnBookmark => ({ token: "tok", threadId: "thread", pageId: "page:a", pageName: "A", camera: { x: 12, y: -8, z: 2 }, selection: ["shape:a", "shape:b"], ...patch });

function memoryStore(initial: string | null = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; }, raw: () => value };
}

describe("createReturnMemory", () => {
  it("finds the newest bookmark by thread and token, bounded to 40", () => {
    const store = memoryStore();
    const memory = createReturnMemory(store);
    for (let i = 0; i < 45; i++) memory.save(bookmark({ token: `t${i}`, threadId: "same" }));
    expect(memory.forToken("t0")).toBeNull();
    expect(memory.forThread("same")?.token).toBe("t44");
  });

  it("keeps thread lookups isolated and writes large records that read back", () => {
    const store = memoryStore();
    const memory = createReturnMemory(store);
    for (let i = 0; i < 45; i++) {
      memory.save(bookmark({ token: `large-${i}`, threadId: `thread-${i}`, selection: Array.from({ length: 300 }, (_, n) => `shape:${i}-${n}`) }));
    }
    expect(memory.forThread("thread-7")?.token).toBe("large-7");
    expect(memory.forThread("thread-8")?.token).toBe("large-8");
    const reopened = createReturnMemory(store);
    expect(reopened.forToken("large-39")?.threadId).toBe("thread-39");
    expect(reopened.forToken("large-0")).toBeNull();
  });

  it("offers distinct locations for one thread without including another thread", () => {
    const memory = createReturnMemory(null);
    memory.save(bookmark({ token: "a" }));
    memory.save(bookmark({ token: "b", pageId: "page:b" }));
    memory.save(bookmark({ token: "c", threadId: "other" }));
    memory.save(bookmark({ token: "a-again" }));
    expect(memory.visitsForThread("thread").map(b => b.token)).toEqual(["a-again", "b"]);
    expect(memory.forToken("a")?.pageId).toBe("page:a");
  });

  it("falls back to memory when storage throws and ignores corrupt records", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const memory = createReturnMemory(blocked);
    memory.save(bookmark());
    expect(memory.forToken("tok")?.threadId).toBe("thread");
    expect(createReturnMemory({ getItem: () => "not-json", setItem: () => {} }).forToken("tok")).toBeNull();
  });

  it("keeps the new bookmark when a later write is blocked", () => {
    let raw: string | null = null;
    let writes = 0;
    const store = {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        writes++;
        if (writes > 1) throw new Error("quota");
        raw = value;
      },
    };
    const memory = createReturnMemory(store);
    memory.save(bookmark({ token: "first" }));
    memory.save(bookmark({ token: "second" }));
    expect(memory.forToken("second")?.token).toBe("second");
  });

  it("rejects malformed camera values", () => {
    const store = memoryStore();
    const memory = createReturnMemory(store);
    memory.save(bookmark({ camera: { x: 0, y: 0, z: 0 } }));
    expect(memory.forToken("tok")).toBeNull();
  });
});

describe("restoreThreadReturn", () => {
  it("restores page, camera, edit state, and only surviving shapes on that page", () => {
    const doc = LoroCanvasDoc.create({ peerId: 1n });
    doc.putPage(page("page:a", "A")); doc.putPage(page("page:b", "B"));
    doc.putShape(shape("shape:a", "page:a")); doc.putShape(shape("shape:b", "page:b"));
    doc.putShape(shape("shape:gone", "page:a")); doc.deleteShape("shape:gone"); doc.commit();
    const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: "page:b" });
    const before = JSON.stringify({ pages: doc.listPages(), shapes: doc.listShapes(), bindings: doc.listBindings(), assets: doc.listAssets() });
    editor.applyAll([{ type: "BeginEdit", id: "shape:b" }, { type: "SetSelection", ids: ["shape:b"] }]);
    expect(restoreThreadReturn(editor, bookmark({ selection: ["shape:a", "shape:b", "shape:gone"] }))).toBe(true);
    expect(editor.get().currentPageId).toBe("page:a");
    expect(editor.get().camera).toEqual({ x: 12, y: -8, z: 2 });
    expect([...editor.get().selection]).toEqual(["shape:a"]);
    expect(editor.get().editingId).toBeNull();
    expect(JSON.stringify({ pages: doc.listPages(), shapes: doc.listShapes(), bindings: doc.listBindings(), assets: doc.listAssets() })).toBe(before);
  });

  it("does not apply anything when the page was deleted", () => {
    const doc = LoroCanvasDoc.create({ peerId: 2n }); doc.putPage(page("page:b")); doc.commit();
    const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: "page:b" });
    expect(restoreThreadReturn(editor, bookmark())).toBe(false);
    expect(editor.get().currentPageId).toBe("page:b");
  });
});
