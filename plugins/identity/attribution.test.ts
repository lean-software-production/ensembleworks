import { beforeEach, describe, expect, it } from "vitest";
import {
  AttributionLedger,
  decideAttribution,
  lineageOf,
  viaForOrigin,
  type AttributionFacts,
  type KvLike,
  type StarterRecord,
  type StarterSummary,
} from "./attribution.js";

const matt: StarterSummary = { person: "mattwynne", displayName: "Matt", github: "mattwynne" };
const david: StarterSummary = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };

function facts(overrides: Partial<AttributionFacts> = {}): AttributionFacts {
  return {
    threadId: "thr_1",
    email: null,
    person: null,
    origin: null,
    originPluginId: null,
    lineage: [],
    now: 1_000,
    ...overrides,
  };
}

function record(overrides: Partial<StarterRecord> = {}): StarterRecord {
  return {
    threadId: "thr_parent",
    starter: matt,
    email: "matt@example.com",
    via: "browser",
    origin: "app",
    originPluginId: null,
    inheritedFrom: null,
    recordedAt: 500,
    ...overrides,
  };
}

describe("viaForOrigin", () => {
  it.each([
    ["app", "browser"],
    [null, "browser"],
    ["cli", "agent"],
    ["sdk", "agent"],
    ["plugin", "plugin"],
  ] as const)("maps origin %s to via %s", (origin, via) => {
    expect(viaForOrigin(origin)).toBe(via);
  });
});

describe("lineageOf", () => {
  it("collects every lineage field, most specific first, without the thread itself", () => {
    expect(lineageOf({
      threadId: "thr_self",
      parentThreadId: "thr_parent",
      sourceThreadId: "thr_source",
      senderThreadIds: ["thr_sender", null, undefined, "thr_self"],
    })).toEqual(["thr_sender", "thr_parent", "thr_source"]);
  });

  it("de-duplicates repeated ids and drops blanks", () => {
    expect(lineageOf({
      threadId: "thr_self",
      parentThreadId: "thr_a",
      sourceThreadId: "thr_a",
      senderThreadIds: ["thr_a", "  "],
    })).toEqual(["thr_a"]);
  });

  it("is empty for a thread with no lineage", () => {
    expect(lineageOf({ threadId: "thr_self", parentThreadId: null, sourceThreadId: null, senderThreadIds: [] }))
      .toEqual([]);
  });
});

describe("decideAttribution", () => {
  const nothingInherited = () => null;

  it("records the person the request resolved to, with via from the origin", () => {
    expect(decideAttribution(
      facts({ email: "david@example.com", person: david, origin: "app" }),
      nothingInherited,
    )).toEqual({
      threadId: "thr_1",
      starter: david,
      email: "david@example.com",
      via: "browser",
      origin: "app",
      originPluginId: null,
      inheritedFrom: null,
      recordedAt: 1_000,
    });
  });

  it("calls an identified CLI or SDK dispatch an agent", () => {
    expect(decideAttribution(facts({ email: "david@example.com", person: david, origin: "cli" }), nothingInherited))
      .toMatchObject({ starter: david, via: "agent" });
    expect(decideAttribution(facts({ email: "david@example.com", person: david, origin: "sdk" }), nothingInherited))
      .toMatchObject({ starter: david, via: "agent" });
  });

  it("inherits the linked thread's starter when the dispatch has no identity of its own", () => {
    const inherited = (threadId: string) => threadId === "thr_parent" ? record() : null;
    expect(decideAttribution(facts({ origin: "cli", lineage: ["thr_missing", "thr_parent"] }), inherited))
      .toMatchObject({ starter: matt, email: "matt@example.com", via: "agent", inheritedFrom: "thr_parent" });
  });

  it("prefers lineage over an email that resolves to nobody", () => {
    const inherited = (threadId: string) => threadId === "thr_parent" ? record() : null;
    expect(decideAttribution(
      facts({ email: "stranger@example.com", person: null, lineage: ["thr_parent"] }),
      inherited,
    )).toMatchObject({ starter: matt, via: "agent", inheritedFrom: "thr_parent" });
  });

  it("ignores a linked thread whose own starter is unknown", () => {
    const inherited = () => record({ starter: null, email: null, via: "unknown" });
    expect(decideAttribution(facts({ lineage: ["thr_parent"] }), inherited))
      .toMatchObject({ starter: null, via: "unknown", inheritedFrom: null });
  });

  it("marks a plugin dispatch with no identity and no lineage as via plugin", () => {
    expect(decideAttribution(facts({ origin: "plugin", originPluginId: "automations" }), nothingInherited))
      .toMatchObject({ starter: null, via: "plugin", originPluginId: "automations" });
  });

  it("falls back to unknown, never an error, for an unresolvable email", () => {
    expect(decideAttribution(facts({ email: "stranger@example.com", person: null, origin: "app" }), nothingInherited))
      .toMatchObject({ starter: null, email: "stranger@example.com", via: "unknown" });
  });

  it("falls back to unknown with no email at all (a drain, or the startup race)", () => {
    expect(decideAttribution(facts(), nothingInherited)).toMatchObject({ starter: null, email: null, via: "unknown" });
  });
});

class FakeKv implements KvLike {
  readonly rows = new Map<string, unknown>();
  reads = 0;

  async get<T>(key: string): Promise<T | undefined> {
    this.reads += 1;
    return this.rows.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.rows.set(key, JSON.parse(JSON.stringify(value)) as unknown);
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    return [...this.rows.keys()].filter((key) => prefix === undefined || key.startsWith(prefix));
  }
}

describe("AttributionLedger", () => {
  let kv: FakeKv;
  let ledger: AttributionLedger;

  beforeEach(() => {
    kv = new FakeKv();
    ledger = new AttributionLedger(kv);
  });

  it("has no record for a thread it has never seen", async () => {
    expect(await ledger.get("thr_1")).toBeNull();
  });

  it("records a starter and reads it back", async () => {
    const written = record({ threadId: "thr_1" });
    expect(await ledger.record(written)).toEqual({ recorded: true, record: written });
    expect(await ledger.get("thr_1")).toEqual(written);
  });

  it("keeps the first write: a later dispatch never rewrites the starter", async () => {
    const first = record({ threadId: "thr_1", starter: matt, email: "matt@example.com" });
    await ledger.record(first);
    const second = record({ threadId: "thr_1", starter: david, email: "david@example.com", recordedAt: 900 });
    expect(await ledger.record(second)).toEqual({ recorded: false, record: first });
    expect(await ledger.get("thr_1")).toEqual(first);
  });

  it("survives a new ledger over the same storage", async () => {
    await ledger.record(record({ threadId: "thr_1" }));
    expect(await new AttributionLedger(kv).get("thr_1")).toEqual(record({ threadId: "thr_1" }));
  });

  it("caches reads so the dispatch hook does not hit storage twice", async () => {
    await ledger.record(record({ threadId: "thr_1" }));
    kv.reads = 0;
    await ledger.get("thr_1");
    await ledger.get("thr_1");
    expect(kv.reads).toBe(0);
  });

  it("caches the absence of a record too", async () => {
    await ledger.get("thr_absent");
    kv.reads = 0;
    expect(await ledger.get("thr_absent")).toBeNull();
    expect(kv.reads).toBe(0);
  });

  it("bounds storage by evicting the oldest records past the cap", async () => {
    const small = new AttributionLedger(kv, { max: 3 });
    for (const id of ["a", "b", "c", "d"]) await small.record(record({ threadId: id }));
    expect(await small.get("a")).toBeNull();
    expect(await small.get("d")).not.toBeNull();
    expect((await kv.list("identity/starter/v1/thread/")).sort())
      .toEqual([
        "identity/starter/v1/thread/b",
        "identity/starter/v1/thread/c",
        "identity/starter/v1/thread/d",
      ]);
  });

  it("ignores a corrupt stored row rather than throwing", async () => {
    await kv.set("identity/starter/v1/thread/thr_bad", { nonsense: true });
    expect(await ledger.get("thr_bad")).toBeNull();
  });

  it("never lets a storage failure escape", async () => {
    const broken: KvLike = {
      get: () => Promise.reject(new Error("kv down")),
      set: () => Promise.reject(new Error("kv down")),
      delete: () => Promise.reject(new Error("kv down")),
      list: () => Promise.reject(new Error("kv down")),
    };
    const unlucky = new AttributionLedger(broken);
    expect(await unlucky.get("thr_1")).toBeNull();
    expect(await unlucky.record(record({ threadId: "thr_1" }))).toEqual({ recorded: false, record: null });
  });
});
