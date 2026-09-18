import { describe, expect, it } from "vitest";
import {
  AUTOMATIONS_PLUGIN_ID,
  decideGuardrail,
  makeGuardrail,
  type GuardrailFacts,
} from "./guardrail.js";
import { AttributionLedger, attributeDispatch, type DispatchContextLike, type StarterSummary } from "./attribution.js";
import type { HostClassification } from "./hosts.js";
import type { KvLike } from "./kv.js";

const david: StarterSummary = { person: "mrdavidlaing", displayName: "David", github: "mrdavidlaing" };
const matt: StarterSummary = { person: "mattwynne", displayName: "Matt", github: "mattwynne" };

const davidsMachine: HostClassification = {
  kind: "person",
  hostId: "h1",
  hostName: "ew-lsp-001-mrdavidlaing",
  person: david,
  conflict: null,
};
const mattsMachine: HostClassification = {
  kind: "person",
  hostId: "h2",
  hostName: "ew-lsp-001-mattwynne",
  person: matt,
  conflict: null,
};
const teamMachine: HostClassification = { kind: "team", hostId: "h3", hostName: "ew-lsp-001-main", conflict: null };
const unclaimed: HostClassification = { kind: "unclaimed", hostId: "h4", hostName: "ew-scratch-002", conflict: null };

const machineNames = { yourMachines: ["ew-lsp-001-mrdavidlaing"], teamMachines: ["ew-lsp-001-main"] };

function facts(overrides: Partial<GuardrailFacts> = {}): GuardrailFacts {
  return { requester: david, recorded: null, host: davidsMachine, origin: "app", originPluginId: null, ...overrides };
}

describe("decideGuardrail, with restrictStarts OFF", () => {
  it("proceeds on everything it would otherwise refuse", () => {
    for (const input of [
      facts({ host: mattsMachine }),
      facts({ recorded: { starter: matt }, host: teamMachine }),
      facts({ requester: null, origin: "plugin", originPluginId: AUTOMATIONS_PLUGIN_ID, host: unclaimed }),
    ]) {
      expect(decideGuardrail(false, input, machineNames)).toEqual({ action: "proceed" });
    }
  });
});

describe("a dispatch with no identity is never a rule violation", () => {
  // S9 (2026-09-18) proved four legitimate paths arrive with no identity and no lineage:
  // an agent's own `bb thread tell`, `bb thread retry`, a plugin follow-up via
  // `threads.send`, and an automation aimed at an existing thread. Refusing anonymous
  // dispatches would break the mechanism agents report into parent threads with.
  it("proceeds for an anonymous dispatch, whatever machine it is headed for", () => {
    for (const host of [davidsMachine, mattsMachine, teamMachine, unclaimed, null]) {
      expect(decideGuardrail(true, facts({ requester: null, origin: null, host }), machineNames))
        .toEqual({ action: "proceed" });
    }
  });

  it("proceeds for an anonymous follow-up on somebody else's thread", () => {
    expect(decideGuardrail(
      true,
      facts({ requester: null, origin: null, recorded: { starter: matt }, host: teamMachine }),
      machineNames,
    )).toEqual({ action: "proceed" });
  });
});

describe("rule A: a start on another person's machine", () => {
  it("refuses, naming the machine, its owner and the fix", () => {
    const decision = decideGuardrail(true, facts({ host: mattsMachine }), machineNames);
    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") return;
    expect(decision.rule).toBe("start-on-another-persons-machine");
    expect(decision.message).toContain("ew-lsp-001-mattwynne is Matt's machine");
    expect(decision.message).toContain("ew-lsp-001-mrdavidlaing");
    expect(decision.message).toContain("ew-lsp-001-main");
    expect(decision.message).toContain("restrictStarts");
  });

  it("allows a person to start on their own machine, the team machine, or an unclaimed one", () => {
    for (const host of [davidsMachine, teamMachine, unclaimed, null]) {
      expect(decideGuardrail(true, facts({ host }), machineNames)).toEqual({ action: "proceed" });
    }
  });

  it("says so plainly when the person has no machines of their own to suggest", () => {
    const decision = decideGuardrail(true, facts({ host: mattsMachine }), { yourMachines: [], teamMachines: [] });
    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") return;
    expect(decision.message).toContain("no machine of your own");
  });
});

describe("rule B: a follow-up by someone who is not the starter", () => {
  it("refuses a known person sending into another person's thread", () => {
    const decision = decideGuardrail(true, facts({ recorded: { starter: matt }, host: teamMachine }), machineNames);
    expect(decision.action).toBe("reject");
    if (decision.action !== "reject") return;
    expect(decision.rule).toBe("follow-up-by-non-starter");
    expect(decision.message).toContain("Matt");
    expect(decision.message).toContain("read-only");
  });

  it("allows the starter's own follow-up", () => {
    expect(decideGuardrail(true, facts({ recorded: { starter: david }, host: teamMachine }), machineNames))
      .toEqual({ action: "proceed" });
  });

  it("allows a follow-up on a thread whose starter was never recorded", () => {
    expect(decideGuardrail(true, facts({ recorded: { starter: null }, host: teamMachine }), machineNames))
      .toEqual({ action: "proceed" });
  });

  it("does not apply rule A to a follow-up: the machine question was settled at the start", () => {
    expect(decideGuardrail(true, facts({ recorded: { starter: david }, host: mattsMachine }), machineNames))
      .toEqual({ action: "proceed" });
  });
});

describe("rule C: an automation off the team machine", () => {
  const automation = facts({ requester: null, origin: "plugin", originPluginId: AUTOMATIONS_PLUGIN_ID });

  it("refuses an automation headed for a person's or an unclaimed machine", () => {
    for (const host of [mattsMachine, davidsMachine, unclaimed]) {
      const decision = decideGuardrail(true, { ...automation, host }, machineNames);
      expect(decision.action).toBe("reject");
      if (decision.action !== "reject") continue;
      expect(decision.rule).toBe("automation-off-team-machine");
      expect(decision.message).toContain("team machine");
      expect(decision.message).toContain(host.hostName);
    }
  });

  it("allows an automation on the team machine", () => {
    expect(decideGuardrail(true, { ...automation, host: teamMachine }, machineNames)).toEqual({ action: "proceed" });
  });

  it("allows an automation bb named no machine for, because there is nothing to judge", () => {
    expect(decideGuardrail(true, { ...automation, host: null }, machineNames)).toEqual({ action: "proceed" });
  });

  it("cannot see an automation aimed at an existing thread, and so allows it", () => {
    // S9: the plugin-SDK bridge stamps origin/originPluginId on threads.spawn and
    // threads.fork ONLY. `threads.send` — which is how an automation targets an existing
    // thread, and how a workflow posts its completion notice — arrives with every
    // identity field empty. This rule is blind to that shape, by construction.
    expect(decideGuardrail(
      true,
      facts({ requester: null, origin: null, originPluginId: null, host: unclaimed }),
      machineNames,
    )).toEqual({ action: "proceed" });
  });

  it("is blind to another plugin's spawn, which is not an automation", () => {
    expect(decideGuardrail(
      true,
      facts({ requester: null, origin: "plugin", originPluginId: "side-chat", host: unclaimed }),
      machineNames,
    )).toEqual({ action: "proceed" });
  });
});

// ── The whole hook, driven through the real guard ────────────────────────────────

function kv(): KvLike {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
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
}

function dispatch(overrides: Partial<DispatchContextLike> = {}): DispatchContextLike {
  return {
    thread: { id: "thr_new", parentThreadId: null, sourceThreadId: null },
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    parentThreadId: null,
    queuedMessage: null,
    host: { id: "h2", name: "ew-lsp-001-mattwynne" },
    ...overrides,
  };
}

const classify = async (host: { id: string; name: string }): Promise<HostClassification> =>
  host.name === "ew-lsp-001-main"
    ? { ...teamMachine, hostId: host.id, hostName: host.name }
    : host.name === "ew-lsp-001-mattwynne"
      ? { ...mattsMachine, hostId: host.id, hostName: host.name }
      : host.name === "ew-lsp-001-mrdavidlaing"
        ? { ...davidsMachine, hostId: host.id, hostName: host.name }
        : { kind: "unclaimed", hostId: host.id, hostName: host.name, conflict: null };

function hookDeps(options: { enabled: boolean; identity: () => { email: string | null; person: StarterSummary | null }; ledger?: AttributionLedger }) {
  const ledger = options.ledger ?? new AttributionLedger(kv());
  return {
    ledger,
    identity: options.identity,
    now: () => 4_000,
    log: { info: () => undefined, warn: () => undefined },
    guard: makeGuardrail({
      enabled: () => options.enabled,
      classify,
      machines: () => machineNames,
    }),
  };
}

describe("attributeDispatch with the guardrail wired in", () => {
  it("refuses David's start on Matt's machine, and records nothing for it", async () => {
    const ledger = new AttributionLedger(kv());
    const decision = await attributeDispatch(
      dispatch({ origin: "app" }),
      hookDeps({ enabled: true, identity: () => ({ email: "david@example.com", person: david }), ledger }),
    );
    expect(decision).toEqual({
      action: "reject",
      message: expect.stringContaining("ew-lsp-001-mattwynne is Matt's machine") as unknown as string,
    });
    expect(await ledger.get("thr_new")).toBeNull();
  });

  it("proceeds and records when the setting is off", async () => {
    const ledger = new AttributionLedger(kv());
    expect(await attributeDispatch(
      dispatch({ origin: "app" }),
      hookDeps({ enabled: false, identity: () => ({ email: "david@example.com", person: david }), ledger }),
    )).toEqual({ action: "proceed" });
    expect(await ledger.get("thr_new")).toMatchObject({ starter: david });
  });

  it("proceeds for the four identity-less paths S9 found, with the setting ON", async () => {
    const anonymous = () => ({ email: null, person: null });
    const paths: Array<[string, DispatchContextLike]> = [
      // 1. An agent's own `bb thread tell` into a thread it did not start: no header, no
      //    origin, and bb does not pass the CLI's senderThreadId to the hook.
      ["bb thread tell from inside a thread", dispatch({ thread: { id: "thr_started", parentThreadId: null, sourceThreadId: null } })],
      // 2. `bb thread retry`: no identity, no lineage, no origin.
      ["bb thread retry", dispatch({ thread: { id: "thr_started", parentThreadId: null, sourceThreadId: null } })],
      // 3. A plugin follow-up via threads.send (workflow completion notice): unstamped.
      ["plugin threads.send follow-up", dispatch({ thread: { id: "thr_started", parentThreadId: null, sourceThreadId: null } })],
      // 4. An automation aimed at an existing thread: the same anonymous shape.
      ["automation into an existing thread", dispatch({ thread: { id: "thr_started", parentThreadId: null, sourceThreadId: null } })],
    ];
    for (const [name, context] of paths) {
      const ledger = new AttributionLedger(kv());
      // The target thread was started by Matt in a browser — the hardest case for rule B.
      await ledger.record({
        threadId: "thr_started",
        starter: matt,
        email: "matt@example.com",
        via: "browser",
        origin: "app",
        originPluginId: null,
        inheritedFrom: null,
        recordedAt: 1,
        host: { id: "h2", name: "ew-lsp-001-mattwynne" },
      });
      expect([name, await attributeDispatch(context, hookDeps({ enabled: true, identity: anonymous, ledger }))])
        .toEqual([name, { action: "proceed" }]);
    }
  });

  it("refuses Matt's follow-up on David's thread", async () => {
    const ledger = new AttributionLedger(kv());
    await ledger.record({
      threadId: "thr_new",
      starter: david,
      email: "david@example.com",
      via: "browser",
      origin: "app",
      originPluginId: null,
      inheritedFrom: null,
      recordedAt: 1,
      host: { id: "h1", name: "ew-lsp-001-mrdavidlaing" },
    });
    const decision = await attributeDispatch(
      dispatch({ host: { id: "h1", name: "ew-lsp-001-mrdavidlaing" } }),
      hookDeps({ enabled: true, identity: () => ({ email: "matt@example.com", person: matt }), ledger }),
    );
    expect(decision.action).toBe("reject");
  });

  it("proceeds when the guard itself throws, because a guardrail may not break bb", async () => {
    const decision = await attributeDispatch(dispatch({ origin: "app" }), {
      ledger: new AttributionLedger(kv()),
      identity: () => ({ email: "david@example.com", person: david }),
      now: () => 4_000,
      log: { info: () => undefined, warn: () => undefined },
      guard: () => {
        throw new Error("guard is broken");
      },
    });
    expect(decision).toEqual({ action: "proceed" });
  });
});
