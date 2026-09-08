import { describe, expect, it } from "vitest";
import {
  LAST_PAGE_KEY_PREFIX,
  lastPageKey,
  readLastPage,
  writeLastPage,
  type PageMemoryStore,
} from "../canvas/pages/last-page.js";

function fakeStore(seed: Record<string, string> = {}): PageMemoryStore & {
  readonly items: Record<string, string>;
} {
  const items: Record<string, string> = { ...seed };
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
    },
  };
}

const hostileStore: PageMemoryStore = {
  getItem() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
  setItem() {
    throw new DOMException("The operation is insecure.", "SecurityError");
  },
};

describe("lastPageKey", () => {
  it("namespaces the memory by room", () => {
    expect(lastPageKey("main")).toBe(`${LAST_PAGE_KEY_PREFIX}main`);
    expect(lastPageKey("retro")).not.toBe(lastPageKey("main"));
  });
});

describe("readLastPage", () => {
  it("returns the page this room was last left on", () => {
    const store = fakeStore({ [lastPageKey("main")]: "page:retro" });
    expect(readLastPage(store, "main")).toBe("page:retro");
  });

  it("does not read another room's memory", () => {
    const store = fakeStore({ [lastPageKey("other")]: "page:retro" });
    expect(readLastPage(store, "main")).toBeNull();
  });

  it("treats a missing, empty, or blank value as no memory", () => {
    expect(readLastPage(fakeStore(), "main")).toBeNull();
    expect(readLastPage(fakeStore({ [lastPageKey("main")]: "" }), "main")).toBeNull();
    expect(readLastPage(fakeStore({ [lastPageKey("main")]: "   " }), "main")).toBeNull();
  });

  it("survives a store that is absent or hostile", () => {
    expect(readLastPage(null, "main")).toBeNull();
    expect(readLastPage(hostileStore, "main")).toBeNull();
  });

  it("leaves document liveness to the page resolver", () => {
    const store = fakeStore({ [lastPageKey("main")]: "page:deleted" });
    expect(readLastPage(store, "main")).toBe("page:deleted");
  });
});

describe("writeLastPage", () => {
  it("records the page under this room's key", () => {
    const store = fakeStore();
    writeLastPage(store, "main", "page:retro");
    expect(store.items[lastPageKey("main")]).toBe("page:retro");
  });

  it("refuses to replace a good value with blank input", () => {
    const store = fakeStore({ [lastPageKey("main")]: "page:retro" });
    writeLastPage(store, "main", "");
    writeLastPage(store, "main", "   ");
    expect(store.items[lastPageKey("main")]).toBe("page:retro");
  });

  it("survives a store that is absent or hostile", () => {
    expect(() => writeLastPage(null, "main", "page:retro")).not.toThrow();
    expect(() => writeLastPage(hostileStore, "main", "page:retro")).not.toThrow();
  });
});
