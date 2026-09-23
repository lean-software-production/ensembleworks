import { describe, expect, it } from "vitest";
import { QueuedRequesterLedger, digestQueuedContent, type QueuedRequester } from "./queued-requester.js";
import type { KvLike } from "./kv.js";

function fakeKv(): KvLike {
  const data = new Map<string, unknown>();
  return { get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => { data.set(key, value); }, delete: async (key) => { data.delete(key); },
    list: async (prefix = "") => [...data.keys()].filter((key) => key.startsWith(prefix)) };
}
const snapshot = (id: string, person: string | null): QueuedRequester => ({
  v: 1, id, threadId: "thr_1", email: null, person: person ? { person, displayName: person, github: person } : null,
  provenance: person ? "self-selected" : "unknown", requestId: "req_1", capturedAt: 1000,
});

describe("queued requester ledger", () => {
  it("keeps the first row across generations and bounds storage", async () => {
    const kv = fakeKv();
    const first = new QueuedRequesterLedger(kv, 2);
    await first.record(snapshot("q1", "matt"));
    const reloaded = new QueuedRequesterLedger(kv, 2);
    expect(await reloaded.record(snapshot("q1", "david"))).toBe(false);
    expect((await reloaded.lookup("q1"))?.person?.person).toBe("matt");
    await reloaded.record(snapshot("q2", "david"));
    await reloaded.record(snapshot("q3", null));
    expect(await reloaded.lookup("q1")).toBeNull();
  });
  it("detects edits without storing message content", () => {
    const before = digestQueuedContent([{ type: "text", text: "before" }]);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(before).not.toContain("before");
    expect(digestQueuedContent([{ type: "text", text: "after" }])).not.toBe(before);
  });
  it("does not erase older index entries when its index read fails", async () => {
    const kv = fakeKv();
    const normal = new QueuedRequesterLedger(kv);
    await normal.record(snapshot("older", "matt"));
    const broken: KvLike = { ...kv, get: async <T>(key: string) => {
      if (key.endsWith("/index")) throw new Error("index down");
      return kv.get<T>(key);
    } };
    expect(await new QueuedRequesterLedger(broken).record(snapshot("newer", "david"))).toBe(false);
    expect((await new QueuedRequesterLedger(kv).lookup("older"))?.person?.person).toBe("matt");
    expect(await new QueuedRequesterLedger(kv).lookup("newer")).toBeNull();
  });
  it("keeps first capture, including unknown, through a later drain", async () => {
    const ledger = new QueuedRequesterLedger(fakeKv());
    expect(await ledger.record(snapshot("q1", null))).toBe(true);
    expect(await ledger.record(snapshot("q1", "matt"))).toBe(false);
    expect((await ledger.lookup("q1"))?.person).toBeNull();
  });
  it("reports capture miss and removes dispatched rows", async () => {
    const ledger = new QueuedRequesterLedger(fakeKv());
    expect(await ledger.lookup("missing")).toBeNull();
    await ledger.record(snapshot("q2", "david"));
    await ledger.forget("q2");
    expect(await ledger.lookup("q2")).toBeNull();
    expect(await ledger.record(snapshot("q2", "matt"))).toBe(false);
  });
});
