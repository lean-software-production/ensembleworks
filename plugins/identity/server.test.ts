import { describe, expect, it } from "vitest";
import { LEASE_TTL_MS, PresenceStore, TYPING_TTL_MS, ownershipFor, parseHostList, publicMachineList, publicRoster, publicStarter } from "./server.js";
import type { HostClassification } from "./hosts.js";

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
      people: [],
    });
  });

  it("moves a tab between threads without leaving stale presence", () => {
    const store = new PresenceStore();
    store.heartbeat("tab", "viewer", { kind: "thread", threadId: "old" }, 1_000);
    store.heartbeat("tab", "viewer", { kind: "thread", threadId: "new" }, 2_000);

    expect(store.snapshot("someone-else", 2_000)).toEqual([
      { threadId: "new", viewers: 1, typing: 0, people: [] },
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

  describe("named presence", () => {
    const matt = { person: "mattwynne", displayName: "Matt", github: "mattwynne" };
    const trevoke = { person: "trevoke", displayName: "Trevoke", github: "Trevoke" };
    const david = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };
    const here = { kind: "thread", threadId: "t" } as const;

    it("lists named people sorted by displayName, excluding the caller's viewer", () => {
      const store = new PresenceStore();
      store.heartbeat("tab-t", "viewer-t", here, 1_000, trevoke);
      store.heartbeat("tab-m", "viewer-m", here, 1_000, matt);
      store.heartbeat("tab-d", "viewer-d", here, 1_000, david);

      expect(store.thread("t", "viewer-d", 1_000)).toEqual({
        threadId: "t",
        viewers: 2,
        typing: 0,
        people: [
          { ...matt, typing: false },
          { ...trevoke, typing: false },
        ],
      });
    });

    it("counts one person in two browsers once", () => {
      const store = new PresenceStore();
      store.heartbeat("laptop-tab", "laptop-viewer", here, 1_000, matt);
      store.heartbeat("phone-tab", "phone-viewer", here, 1_000, matt);
      store.setTyping("phone-tab", "phone-viewer", "t", true, 1_000, matt);

      expect(store.thread("t", "local", 1_000)).toEqual({
        threadId: "t",
        viewers: 1,
        typing: 1,
        people: [{ ...matt, typing: true }],
      });
    });

    it("lets named and anonymous viewers coexist", () => {
      const store = new PresenceStore();
      store.heartbeat("tab-m", "viewer-m", here, 1_000, matt);
      store.heartbeat("tab-a", "anon-a", here, 1_000, null);
      store.heartbeat("tab-b", "anon-b", here, 1_000);
      store.setTyping("tab-a", "anon-a", "t", true, 1_000, null);

      const presence = store.thread("t", "local", 1_000);
      expect(presence).toMatchObject({ viewers: 3, typing: 1, people: [{ ...matt, typing: false }] });
      expect(presence.viewers - presence.people.length).toBe(2);
    });

    it("carries identity through snapshot per thread", () => {
      const store = new PresenceStore();
      store.heartbeat("tab-m", "viewer-m", { kind: "thread", threadId: "a" }, 1_000, matt);
      store.heartbeat("tab-t", "viewer-t", { kind: "thread", threadId: "b" }, 1_000, trevoke);

      expect(store.snapshot("local", 1_000)).toEqual([
        { threadId: "a", viewers: 1, typing: 0, people: [{ ...matt, typing: false }] },
        { threadId: "b", viewers: 1, typing: 0, people: [{ ...trevoke, typing: false }] },
      ]);
    });

    it("reports a change when a tab's identity changes in place", () => {
      const store = new PresenceStore();
      store.heartbeat("tab", "viewer", here, 1_000, null);
      expect([...store.heartbeat("tab", "viewer", here, 2_000, null)]).toEqual([]);
      expect([...store.heartbeat("tab", "viewer", here, 3_000, matt)]).toEqual(["t"]);
      expect(store.thread("t", "local", 3_000).people).toEqual([{ ...matt, typing: false }]);
    });
  });
});

describe("publicStarter", () => {
  const stored = {
    threadId: "thr_1",
    starter: { person: "mattwynne", displayName: "Matt", github: "mattwynne" },
    email: "matt@example.com",
    via: "browser" as const,
    origin: "app" as const,
    originPluginId: null,
    inheritedFrom: null,
    recordedAt: 500,
  };

  it("is null when nothing was recorded", () => {
    expect(publicStarter(null)).toBeNull();
  });

  it("drops the private email and keeps only the contract's fields", () => {
    expect(publicStarter(stored)).toEqual({
      threadId: "thr_1",
      starter: stored.starter,
      via: "browser",
      inheritedFrom: null,
      recordedAt: 500,
      host: null,
    });
  });

  it("validates its output against the RPC contract's schema, on both arms", () => {
    expect(() => publicStarter({ ...stored, via: "telepathy" as unknown as typeof stored.via })).toThrow();
  });
});

describe("publicStarter, with the machine the thread ran on", () => {
  const stored = {
    threadId: "thr_1",
    starter: { person: "mattwynne", displayName: "Matt", github: "mattwynne" },
    email: "matt@example.com",
    via: "browser" as const,
    origin: "app" as const,
    originPluginId: null,
    inheritedFrom: null,
    recordedAt: 500,
    host: { id: "h1", name: "ew-lsp-001-mattwynne" },
  };

  it("carries the recorded host through", () => {
    expect(publicStarter(stored)?.host).toEqual({ id: "h1", name: "ew-lsp-001-mattwynne" });
  });

  it("reads a record written before hosts were recorded as no host", () => {
    const { host: _host, ...older } = stored;
    expect(publicStarter(older)?.host).toBeNull();
  });
});

describe("ownershipFor", () => {
  const classified: HostClassification = {
    kind: "team",
    hostId: "h3",
    hostName: "ew-lsp-001-main",
    conflict: null,
  };

  it("is an unknown, never-null-looking view when nothing was recorded", () => {
    expect(ownershipFor("thr_1", null, null)).toEqual({
      threadId: "thr_1",
      starter: null,
      via: "unknown",
      inheritedFrom: null,
      host: null,
    });
  });

  it("classifies the recorded host", () => {
    const view = ownershipFor("thr_1", publicStarter({
      threadId: "thr_1",
      starter: { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" },
      email: null,
      via: "browser",
      origin: "app",
      originPluginId: null,
      inheritedFrom: null,
      recordedAt: 1,
      host: { id: "h3", name: "ew-lsp-001-main" },
    }), classified);
    expect(view.host?.kind).toBe("team");
    expect(view.starter?.displayName).toBe("David");
  });
});

describe("parseHostList", () => {
  it("reads bb's own GET /api/v1/hosts payload", () => {
    expect(parseHostList({ hosts: [{ id: "h1", name: "ew-lsp-001-main", lifecycle: { phase: "active" } }] }))
      .toEqual([{ id: "h1", name: "ew-lsp-001-main" }]);
  });

  it("reads a bare array, and ignores anything that is not a host", () => {
    expect(parseHostList([{ id: "h1", name: "a" }, { id: 2 }, null, "x"])).toEqual([{ id: "h1", name: "a" }]);
  });

  it("is empty for a payload it does not understand", () => {
    expect(parseHostList({ error: "nope" })).toEqual([]);
  });
});

describe("publicMachineList", () => {
  const listed = {
    me: { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" },
    meViaFallback: false,
    roster: ["mrdavidlaing"],
    colors: { mrdavidlaing: "#ff0000" },
    sharedMachineUser: "ensembleworks-agent",
    enforcement: "off" as const,
    machines: [{ kind: "team" as const, hostId: "h3", hostName: "ew-lsp-001-main", conflict: null }],
    unavailable: null,
  };

  it("validates against the contract's own schema", () => {
    expect(publicMachineList(listed)).toEqual(listed);
  });

  it("carries the chosen colours, so the sidebar paints an override without a second call", () => {
    expect(publicMachineList(listed).colors).toEqual({ mrdavidlaing: "#ff0000" });
  });

  it("refuses a payload carrying anything the contract does not publish", () => {
    // The real bug this guards: the internal cache row also carries `at`, and spreading
    // it whole into the answer failed strict output validation at runtime.
    expect(() => publicMachineList({ ...listed, at: 1 } as unknown as typeof listed)).toThrow();
  });
});

describe("publicRoster", () => {
  const alice = { person: "alice", github: "AliceH", displayName: "Alice", emails: ["alice@example.com"] };
  const bob = { person: "bob", github: "bobby", displayName: "Bob", emails: ["bob@example.com"] };
  const machines: HostClassification[] = [
    { kind: "person", hostId: "h1", hostName: "box-alice", person: { person: "alice", displayName: "Alice", github: "AliceH" }, conflict: null },
  ];

  const answer = () => publicRoster({
    me: { person: "bob", displayName: "Bob", github: "bobby" },
    meViaFallback: false,
    people: [alice, bob],
    overrides: { alice: "#ff0000" },
    machines,
    seen: { alice: 1_700_000_000_000 },
    unavailable: null,
  });

  it("answers the rows the people page renders", () => {
    const rows = answer().people;
    expect(rows.map((row) => row.person)).toEqual(["alice", "bob"]);
    expect(rows[0]).toMatchObject({
      displayName: "Alice",
      github: "AliceH",
      emails: ["alice@example.com"],
      color: "#ff0000",
      overridden: true,
      machines: ["box-alice"],
      seen: true,
    });
  });

  it("names who is asking, so the page can say whose colour it is changing", () => {
    expect(answer().me).toEqual({ person: "bob", displayName: "Bob", github: "bobby" });
  });

  it("carries the seen-state caveat, so the UI cannot imply more than Identity knows", () => {
    expect(answer().seenCaveat).toMatch(/retain/i);
  });

  it("is VALIDATED against the contract's own output schema", () => {
    // The guard step 4 earned the hard way: an internal field leaking into an RPC answer
    // fails STRICT output validation at runtime, in the browser, where the only symptom
    // is a silently empty panel.
    //
    // `publicRoster` is safer than `publicMachineList` was by construction — it names
    // every field it copies, so a caller's stray key cannot reach the answer at all. The
    // live risk is the other direction: `buildRoster` growing a row field that the
    // contract does not publish. The strict `roster.parse` is what catches that, and
    // this pins the published key set so a new field has to be declared deliberately.
    expect(Object.keys(answer().people[0]!).sort()).toEqual([
      "clashesWith", "color", "dealt", "displayName", "emails", "github",
      "ink", "machines", "overridden", "person", "seen", "seenAt",
    ]);
    expect(Object.keys(answer()).sort()).toEqual(["me", "meViaFallback", "people", "seenCaveat", "unavailable"]);
  });

  it("reports why the machine list is missing rather than showing everyone as machine-less", () => {
    const listed = publicRoster({
      me: null, meViaFallback: false, people: [alice], overrides: {}, machines: [],
      seen: {}, unavailable: "the machine list could not be read (bb answered 500)",
    });
    expect(listed.unavailable).toMatch(/could not be read/);
    expect(listed.people[0]!.machines).toEqual([]);
  });
});
