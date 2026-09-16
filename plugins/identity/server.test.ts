import { describe, expect, it } from "vitest";
import { LEASE_TTL_MS, PresenceStore, TYPING_TTL_MS } from "./server.js";

describe("PresenceStore", () => {
  it("excludes the local viewer and aggregates another viewer's tabs", () => {
    const store = new PresenceStore();
    store.heartbeat("local-tab", "local-viewer", { kind: "thread", threadId: "thread-1" }, 1_000);
    store.heartbeat("other-tab-1", "other-viewer", { kind: "thread", threadId: "thread-1" }, 1_000);
    store.heartbeat("other-tab-2", "other-viewer", { kind: "thread", threadId: "thread-1" }, 1_000);

    expect(store.thread("thread-1", "local-viewer", 1_000)).toEqual({
      threadId: "thread-1",
      viewers: 1,
      typing: 0,
    });
  });

  it("moves a tab between threads without leaving stale presence", () => {
    const store = new PresenceStore();
    store.heartbeat("tab", "viewer", { kind: "thread", threadId: "old" }, 1_000);
    store.heartbeat("tab", "viewer", { kind: "thread", threadId: "new" }, 2_000);

    expect(store.snapshot("someone-else", 2_000)).toEqual([
      { threadId: "new", viewers: 1, typing: 0 },
    ]);
  });

  it("expires typing before it expires the viewer lease", () => {
    const store = new PresenceStore();
    store.setTyping("tab", "viewer", "thread-1", true, 1_000);

    expect(store.thread("thread-1", "local", 1_000 + TYPING_TTL_MS)).toMatchObject({ viewers: 1, typing: 1 });
    expect(store.thread("thread-1", "local", 1_001 + TYPING_TTL_MS)).toMatchObject({ viewers: 1, typing: 0 });
    expect(store.thread("thread-1", "local", 1_001 + LEASE_TTL_MS)).toMatchObject({ viewers: 0, typing: 0 });
  });

  it("removes a hidden or closed tab immediately", () => {
    const store = new PresenceStore();
    store.heartbeat("tab", "viewer", { kind: "thread", threadId: "thread-1" }, 1_000);
    store.leave("tab");

    expect(store.thread("thread-1", "local", 1_000)).toMatchObject({ viewers: 0 });
  });

  it("does not recreate a departed lease when typing cleanup arrives late", () => {
    const store = new PresenceStore();
    store.heartbeat("tab", "viewer", { kind: "thread", threadId: "thread-1" }, 1_000);
    store.leave("tab");
    store.setTyping("tab", "viewer", "thread-1", false, 1_001);

    expect(store.thread("thread-1", "local", 1_001)).toMatchObject({ viewers: 0 });
  });
});
