import { describe, expect, it, vi } from "vitest";
import {
  COLOR_OVERRIDES_KEY,
  MAX_COLOR_OVERRIDES,
  PersonColorStore,
  SEEN_KEY,
  SEEN_WRITE_COALESCE_MS,
  SeenPeople,
} from "./person-store.js";
import type { KvLike } from "./kv.js";

function fakeKv(seed: Record<string, unknown> = {}): KvLike & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>(Object.entries(seed));
  return {
    rows,
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    set: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    list: async (prefix?: string) => [...rows.keys()].filter((k) => k.startsWith(prefix ?? "")),
  };
}

/** A kv that never answers — the wedged-storage case every store here must survive. */
const wedgedKv: KvLike = {
  get: () => new Promise(() => undefined),
  set: () => new Promise(() => undefined),
  delete: () => new Promise(() => undefined),
  list: () => new Promise(() => undefined),
};

/** A kv that throws on every call. */
const throwingKv: KvLike = {
  get: () => Promise.reject(new Error("kv is broken")),
  set: () => Promise.reject(new Error("kv is broken")),
  delete: () => Promise.reject(new Error("kv is broken")),
  list: () => Promise.reject(new Error("kv is broken")),
};

const directory = ["alice", "bob"];

describe("PersonColorStore", () => {
  it("starts empty", async () => {
    const store = new PersonColorStore(fakeKv());
    expect(await store.all()).toEqual({});
  });

  it("stores a colour for a person in the directory", async () => {
    const kv = fakeKv();
    const store = new PersonColorStore(kv);
    const result = await store.set("alice", "#FF0000", directory);
    expect(result).toEqual({ ok: true, person: "alice", from: null, to: "#ff0000" });
    expect(await store.all()).toEqual({ alice: "#ff0000" });
  });

  it("writes the overrides to their OWN kv row, never near the directory setting", async () => {
    const kv = fakeKv();
    await new PersonColorStore(kv).set("alice", "#ff0000", directory);
    expect([...kv.rows.keys()]).toEqual([COLOR_OVERRIDES_KEY]);
  });

  it("reports the colour it replaced, so the audit line can say from and to", async () => {
    const store = new PersonColorStore(fakeKv());
    await store.set("alice", "#ff0000", directory);
    expect(await store.set("alice", "#00ff00", directory)).toEqual({
      ok: true, person: "alice", from: "#ff0000", to: "#00ff00",
    });
  });

  it("refuses a person who is not in the directory, rather than accumulating junk", async () => {
    const kv = fakeKv();
    const store = new PersonColorStore(kv);
    const result = await store.set("nobody", "#ff0000", directory);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/not in Identity's directory/i);
    expect(await store.all()).toEqual({});
    expect(kv.rows.size).toBe(0);
  });

  it("refuses a colour it cannot normalise", async () => {
    const store = new PersonColorStore(fakeKv());
    const result = await store.set("alice", "chartreuse", directory);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/#rrggbb/);
    expect(await store.all()).toEqual({});
  });

  it("clears a colour, returning the person to the dealt one", async () => {
    const store = new PersonColorStore(fakeKv());
    await store.set("alice", "#ff0000", directory);
    expect(await store.clear("alice")).toEqual({ ok: true, person: "alice", from: "#ff0000", to: null });
    expect(await store.all()).toEqual({});
  });

  it("clearing a person who has no override is a success, not an error", async () => {
    const store = new PersonColorStore(fakeKv());
    expect(await store.clear("alice")).toEqual({ ok: true, person: "alice", from: null, to: null });
  });

  it("clears a person the directory no longer lists — that is how junk LEAVES", async () => {
    const store = new PersonColorStore(fakeKv({ [COLOR_OVERRIDES_KEY]: { departed: "#ff0000" } }));
    expect(await store.clear("departed")).toEqual({ ok: true, person: "departed", from: "#ff0000", to: null });
    expect(await store.all()).toEqual({});
  });

  it("is bounded: it refuses a new person past the cap rather than growing forever", async () => {
    const seeded: Record<string, string> = {};
    const roster: string[] = [];
    for (let index = 0; index < MAX_COLOR_OVERRIDES; index += 1) {
      seeded[`p${index}`] = "#ff0000";
      roster.push(`p${index}`);
    }
    roster.push("overflow");
    const store = new PersonColorStore(fakeKv({ [COLOR_OVERRIDES_KEY]: seeded }));
    const result = await store.set("overflow", "#00ff00", roster);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/at most/i);
    // But an existing person may still CHANGE theirs — the cap is on how many, not on edits.
    expect((await store.set("p0", "#0000ff", roster)).ok).toBe(true);
  });

  it("drops rows it cannot read back as a colour, rather than rendering them", async () => {
    const store = new PersonColorStore(fakeKv({
      [COLOR_OVERRIDES_KEY]: { alice: "#ff0000", bob: "javascript:alert(1)", carol: 42 },
    }));
    expect(await store.all()).toEqual({ alice: "#ff0000" });
  });

  it("survives a stored row that is not an object at all", async () => {
    expect(await new PersonColorStore(fakeKv({ [COLOR_OVERRIDES_KEY]: "nonsense" })).all()).toEqual({});
  });

  it("answers empty against a wedged kv instead of hanging", async () => {
    const store = new PersonColorStore(wedgedKv, { timeoutMs: 5 });
    expect(await store.all()).toEqual({});
    const result = await store.set("alice", "#ff0000", directory);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/storage/i);
  });

  it("never throws when kv throws", async () => {
    const store = new PersonColorStore(throwingKv);
    expect(await store.all()).toEqual({});
    expect((await store.set("alice", "#ff0000", directory)).ok).toBe(false);
    expect((await store.clear("alice")).ok).toBe(false);
  });

  it("serves later reads from memory, so the settings page does not re-read kv per render", async () => {
    const kv = fakeKv();
    const spy = vi.spyOn(kv, "get");
    const store = new PersonColorStore(kv);
    await store.all();
    await store.all();
    await store.all();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("SeenPeople", () => {
  it("starts with nobody seen", async () => {
    expect(await new SeenPeople(fakeKv()).all()).toEqual({});
  });

  it("records a person the first time a thread is attributed to them", async () => {
    const kv = fakeKv();
    const seen = new SeenPeople(kv);
    await seen.observe("alice", 1_000);
    expect(await seen.all()).toEqual({ alice: 1_000 });
    expect([...kv.rows.keys()]).toEqual([SEEN_KEY]);
  });

  it("does NOT write again for a person seen a moment ago — the write path is a dispatch", async () => {
    const kv = fakeKv();
    const seen = new SeenPeople(kv);
    await seen.observe("alice", 1_000);
    const spy = vi.spyOn(kv, "set");
    await seen.observe("alice", 1_000 + SEEN_WRITE_COALESCE_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    await seen.observe("alice", 1_000 + SEEN_WRITE_COALESCE_MS + 1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ignores an unnamed starter", async () => {
    const kv = fakeKv();
    await new SeenPeople(kv).observe(null, 1_000);
    expect(kv.rows.size).toBe(0);
  });

  it("is bounded: the oldest sighting is dropped past the cap", async () => {
    const seen = new SeenPeople(fakeKv(), { max: 3 });
    await seen.observe("a", 1);
    await seen.observe("b", 2);
    await seen.observe("c", 3);
    await seen.observe("d", 4);
    expect(Object.keys(await seen.all()).sort()).toEqual(["b", "c", "d"]);
  });

  it("drops rows that are not timestamps", async () => {
    const seen = new SeenPeople(fakeKv({ [SEEN_KEY]: { alice: 1_000, bob: "yesterday", carol: null } }));
    expect(await seen.all()).toEqual({ alice: 1_000 });
  });

  it("never throws, and never hangs, on a broken or wedged kv", async () => {
    expect(await new SeenPeople(throwingKv).all()).toEqual({});
    await expect(new SeenPeople(throwingKv).observe("alice", 1)).resolves.toBeUndefined();
    const wedged = new SeenPeople(wedgedKv, { timeoutMs: 5 });
    expect(await wedged.all()).toEqual({});
    await expect(wedged.observe("alice", 1)).resolves.toBeUndefined();
  });

  describe("backfill", () => {
    it("sweeps the retained records ONCE, and never again", async () => {
      const kv = fakeKv();
      const seen = new SeenPeople(kv);
      const sweep = vi.fn(async () => ["alice", "alice", "bob"]);
      await seen.backfill(sweep, 5_000);
      expect(await seen.all()).toEqual({ alice: 5_000, bob: 5_000 });
      expect(sweep).toHaveBeenCalledTimes(1);

      // A second call on a fresh instance (a restart) must not sweep again: the marker
      // is durable, because the sweep is the one unbounded-ish thing this plugin does.
      const afterRestart = new SeenPeople(kv);
      await afterRestart.backfill(sweep, 6_000);
      expect(sweep).toHaveBeenCalledTimes(1);
    });

    it("does not overwrite a fresher sighting with the sweep's flat timestamp", async () => {
      const kv = fakeKv();
      const seen = new SeenPeople(kv);
      await seen.observe("alice", 9_000);
      await seen.backfill(async () => ["alice"], 5_000);
      expect(await seen.all()).toEqual({ alice: 9_000 });
    });

    it("leaves the marker unset when the sweep fails, so it can be retried", async () => {
      const kv = fakeKv();
      const seen = new SeenPeople(kv);
      const failing = vi.fn(async () => { throw new Error("kv is broken"); });
      await expect(seen.backfill(failing, 5_000)).resolves.toBeUndefined();
      await new SeenPeople(kv).backfill(failing, 6_000);
      expect(failing).toHaveBeenCalledTimes(2);
    });
  });
});
