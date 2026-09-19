import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttributionLedger,
  decideAttribution,
  factsFromDispatch,
  lineageOf,
  viaForOrigin,
  type AttributionFacts,
  type KvLike,
  type StarterRecord,
  type StarterSummary,
  attributeDispatch,
  HOOK_BUDGET_MS,
  SDK_HOOK_DECISION_CEILING_MS,
} from "./attribution.js";

const matt: StarterSummary = { person: "mattwynne", displayName: "Matt", github: "mattwynne" };
const david: StarterSummary = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };

function facts(overrides: Partial<AttributionFacts> = {}): AttributionFacts {
  return {
    threadId: "thr_1",
    email: null,
    person: null,
    viaFallback: false,
    origin: null,
    originPluginId: null,
    lineage: [],
    host: null,
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
      host: null,
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

describe("factsFromDispatch", () => {
  const identity = { email: "david@example.com", person: david };
  const dispatch = {
    thread: { id: "thr_self", parentThreadId: "thr_thread_parent", sourceThreadId: "thr_fork_source" },
    origin: "cli" as const,
    originPluginId: null,
    startedOnBehalfOf: { initiator: "agent" as const, senderThreadId: "thr_sender" },
    parentThreadId: "thr_hook_parent",
    queuedMessage: { senderThreadId: "thr_queued_sender" },
    host: { id: "h1", name: "ew-lsp-001-mrdavidlaing" },
  };

  it("maps every lineage field bb actually exposes, hook context and thread alike", () => {
    expect(factsFromDispatch(dispatch, identity, 7)).toEqual({
      threadId: "thr_self",
      email: "david@example.com",
      person: david,
      viaFallback: false,
      origin: "cli",
      originPluginId: null,
      lineage: ["thr_sender", "thr_queued_sender", "thr_hook_parent", "thr_fork_source"],
      host: { id: "h1", name: "ew-lsp-001-mrdavidlaing" },
      now: 7,
    });
  });

  it("falls back to the thread's own parent when the hook context carries none", () => {
    expect(factsFromDispatch({
      ...dispatch,
      startedOnBehalfOf: null,
      queuedMessage: null,
      parentThreadId: null,
    }, { email: null, person: null }, 7).lineage).toEqual(["thr_thread_parent", "thr_fork_source"]);
  });
});

describe("AttributionLedger cache bounds", () => {
  it("bounds the read-through cache, so queries for unknown threads cannot grow it forever", async () => {
    const kv = new FakeKv();
    const ledger = new AttributionLedger(kv, { cacheMax: 2 });
    await ledger.get("thr_a");
    await ledger.get("thr_b");
    await ledger.get("thr_c");
    kv.reads = 0;
    await ledger.get("thr_a");
    expect(kv.reads).toBe(1);
    await ledger.get("thr_c");
    expect(kv.reads).toBe(1);
  });
});

describe("AttributionLedger timeouts", () => {
  const hangingKv: KvLike = {
    get: () => new Promise<never>(() => {}),
    set: () => new Promise<never>(() => {}),
    delete: () => new Promise<never>(() => {}),
    list: () => new Promise<never>(() => {}),
  };

  it("gives up on a hung read rather than hanging the dispatch hook", async () => {
    const ledger = new AttributionLedger(hangingKv, { timeoutMs: 10 });
    expect(await ledger.get("thr_1")).toBeNull();
  });

  it("gives up on a hung write too", async () => {
    const ledger = new AttributionLedger(hangingKv, { timeoutMs: 10 });
    expect(await ledger.record(record({ threadId: "thr_1" }))).toEqual({ recorded: false, record: null });
  });

  it("does not cache a timed-out read", async () => {
    let calls = 0;
    const slowOnce: KvLike = {
      ...hangingKv,
      get: <T,>(_key: string): Promise<T | undefined> => {
        calls += 1;
        return calls === 1 ? new Promise<never>(() => {}) : Promise.resolve(undefined);
      },
    };
    const ledger = new AttributionLedger(slowOnce, { timeoutMs: 10 });
    expect(await ledger.get("thr_1")).toBeNull();
    expect(await ledger.get("thr_1")).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("attributeDispatch", () => {
  const dispatchContext = {
    thread: { id: "thr_new", parentThreadId: "thr_parent", sourceThreadId: null },
    origin: "app" as const,
    originPluginId: null,
    startedOnBehalfOf: null,
    parentThreadId: null,
    queuedMessage: null,
    host: { id: "h3", name: "ew-lsp-001-main" },
  };

  it("always proceeds, and records the starter", async () => {
    const kv = new FakeKv();
    const ledger = new AttributionLedger(kv);
    const logs: string[] = [];
    const result = await attributeDispatch(dispatchContext, {
      ledger,
      identity: () => ({ email: "david@example.com", person: david }),
      now: () => 4_000,
      log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    });
    expect(result).toEqual({ action: "proceed" });
    expect(await ledger.get("thr_new")).toMatchObject({ starter: david, via: "browser" });
    expect(logs.some((line) => line.startsWith("info:"))).toBe(true);
  });

  it("proceeds and warns when the ledger throws", async () => {
    const logs: string[] = [];
    const exploding = {
      get: () => Promise.reject(new Error("boom")),
      record: () => Promise.reject(new Error("boom")),
    };
    const result = await attributeDispatch(dispatchContext, {
      ledger: exploding,
      identity: () => ({ email: null, person: null }),
      now: () => 4_000,
      log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    });
    expect(result).toEqual({ action: "proceed" });
    expect(logs.join("\n")).toContain("boom");
  });

  it("proceeds when resolving the requester's identity throws", async () => {
    const logs: string[] = [];
    const result = await attributeDispatch(dispatchContext, {
      ledger: new AttributionLedger(new FakeKv()),
      identity: () => { throw new Error("no directory"); },
      now: () => 4_000,
      log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    });
    expect(result).toEqual({ action: "proceed" });
    expect(logs.join("\n")).toContain("no directory");
  });

  it("stays silent about a thread whose starter was already recorded", async () => {
    const ledger = new AttributionLedger(new FakeKv());
    await ledger.record(record({ threadId: "thr_new" }));
    const logs: string[] = [];
    await attributeDispatch(dispatchContext, {
      ledger,
      identity: () => ({ email: "david@example.com", person: david }),
      now: () => 4_000,
      log: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`) },
    });
    expect(logs).toEqual([]);
    expect(await ledger.get("thr_new")).toMatchObject({ starter: matt });
  });
});

describe("attributeDispatch and the machine", () => {
  const onTeamMachine = {
    thread: { id: "thr_new", parentThreadId: null, sourceThreadId: null },
    origin: "app" as const,
    originPluginId: null,
    startedOnBehalfOf: null,
    parentThreadId: null,
    queuedMessage: null,
    host: { id: "h3", name: "ew-lsp-001-main" },
  };
  const deps = (extra: Partial<Parameters<typeof attributeDispatch>[1]> = {}) => ({
    ledger: new AttributionLedger(new FakeKv()),
    identity: () => ({ email: "david@example.com", person: david }),
    now: () => 4_000,
    log: { info: () => undefined, warn: () => undefined },
    ...extra,
  });

  it("records the machine the dispatch was headed for", async () => {
    const ledger = new AttributionLedger(new FakeKv());
    await attributeDispatch(onTeamMachine, deps({ ledger }));
    expect((await ledger.get("thr_new"))?.host).toEqual({ id: "h3", name: "ew-lsp-001-main" });
  });

  it("offers the machine to the host pins, and still proceeds when that throws", async () => {
    const seen: unknown[] = [];
    expect(await attributeDispatch(onTeamMachine, deps({
      observeHost: async (host) => {
        seen.push(host);
      },
    }))).toEqual({ action: "proceed" });
    expect(seen).toEqual([{ id: "h3", name: "ew-lsp-001-main" }]);

    expect(await attributeDispatch(onTeamMachine, deps({
      observeHost: async () => {
        throw new Error("pins are down");
      },
    }))).toEqual({ action: "proceed" });
  });

  it("records no machine when bb named none", async () => {
    const ledger = new AttributionLedger(new FakeKv());
    await attributeDispatch({ ...onTeamMachine, host: null }, deps({ ledger }));
    expect((await ledger.get("thr_new"))?.host).toBeNull();
  });
});

describe("the dispatch hook's time budget", () => {
  // The design note used to say the hook cost "~2 timeouts". It has not been true since
  // step 4 added the host observation, and step 5's guard adds another storage-backed
  // step. This is the pin: one deadline over the whole body, asserted end to end, so the
  // number cannot drift silently as more work is added to the hook.
  const hangingKv: KvLike = {
    get: () => new Promise<never>(() => {}),
    set: () => new Promise<never>(() => {}),
    delete: () => new Promise<never>(() => {}),
    list: () => new Promise<never>(() => {}),
  };
  const context = {
    thread: { id: "thr_new", parentThreadId: "thr_parent", sourceThreadId: "thr_source" },
    origin: "app" as const,
    originPluginId: null,
    startedOnBehalfOf: { senderThreadId: "thr_sender" },
    parentThreadId: "thr_hook_parent",
    queuedMessage: { senderThreadId: "thr_queued" },
    host: { id: "h1", name: "ew-lsp-001-mrdavidlaing" },
  };

  it("stays inside the SDK's fail-closed ceiling", () => {
    expect(HOOK_BUDGET_MS).toBeLessThan(SDK_HOOK_DECISION_CEILING_MS);
  });

  it("answers within the budget even when nothing it depends on ever settles", async () => {
    vi.useFakeTimers();
    try {
      const warnings: string[] = [];
      const decision = attributeDispatch(context, {
        ledger: new AttributionLedger(hangingKv),
        identity: () => ({ email: "david@example.com", person: david }),
        now: () => 4_000,
        log: { info: () => undefined, warn: (m) => warnings.push(m) },
        // Neither of these is bounded by the kv timeout: only the overall deadline saves
        // the dispatch from them.
        observeHost: () => new Promise<never>(() => {}),
        guard: () => new Promise<never>(() => {}),
      });
      let settled = false;
      void decision.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await decision).toEqual({ action: "proceed" });
      expect(warnings.join("\n")).toContain("gave up");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a wedged kv well inside the budget, without the deadline's help", async () => {
    vi.useFakeTimers();
    try {
      const decision = attributeDispatch(context, {
        ledger: new AttributionLedger(hangingKv),
        identity: () => ({ email: "david@example.com", person: david }),
        now: () => 4_000,
        log: { info: () => undefined, warn: () => undefined },
      });
      let settled = false;
      void decision.then(() => {
        settled = true;
      });
      // Every kv call is individually bounded, and the hook's storage phases are
      // parallel-then-sequential: the reads together, then the record's get, set and
      // index append. That arithmetic must finish with a second of the budget to spare,
      // so the deadline stays a backstop rather than the thing normally doing the work.
      await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS - 1_000);
      expect(settled).toBe(true);
      expect(await decision).toEqual({ action: "proceed" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the eviction index, against a kv that hangs", () => {
  it("leaves no unsettled kv call behind, and retries the id it could not index", async () => {
    let indexReads = 0;
    const data = new Map<string, unknown>();
    const flaky: KvLike = {
      async get<T>(key: string) {
        if (key.endsWith("/index")) {
          indexReads += 1;
          if (indexReads === 1) return await new Promise<never>(() => {});
        }
        return data.get(key) as T | undefined;
      },
      async set(key: string, value: unknown) {
        data.set(key, value);
      },
      async delete(key: string) {
        data.delete(key);
      },
      async list(prefix = "") {
        return [...data.keys()].filter((key) => key.startsWith(prefix));
      },
    };
    const ledger = new AttributionLedger(flaky, { timeoutMs: 10 });
    // The first record's index append hangs: the record is written, the id is not indexed.
    expect(await ledger.record(record({ threadId: "thr_1" }))).toMatchObject({ recorded: true });
    expect(data.get("identity/starter/v1/index")).toBeUndefined();
    // The next append retries it, so the un-indexed id is not lost.
    await ledger.record(record({ threadId: "thr_2" }));
    expect(data.get("identity/starter/v1/index")).toEqual(["thr_1", "thr_2"]);
  });
});
