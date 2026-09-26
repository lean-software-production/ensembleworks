import { describe, expect, it } from "vitest";
import type { WhoAmI } from "../server.js";
import { PICKER_STATUSES } from "../settings-admin.js";
import { PICKER_CHAIN, precedenceLadder, type Rung } from "./precedence.js";

const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const picker = { enabled: true, status: "ready", people: [{ person: "alex", displayName: "Alex Rivera" }] };
const whoami = (over: Partial<WhoAmI>): WhoAmI =>
  ({ email: null, person: null, provenance: "unknown", selection: null, picker, ...over });
const states = (rungs: Rung[]) => rungs.map((rung) => `${rung.id}:${rung.state}`);
const detail = (rungs: Rung[], id: Rung["id"]) => rungs.find((rung) => rung.id === id)!.detail;

describe("precedenceLadder", () => {
  it("decides on the Access email, above everything else", () => {
    const rungs = precedenceLadder(whoami({ email: "alex@example.test", person: alex, provenance: "upstream-header" }),
      { fallbackConfigured: true });
    expect(states(rungs)).toEqual(["access:decided", "selection:not-reached", "fallback:not-reached",
      "anonymous:not-reached"]);
    expect(rungs.map((rung) => rung.label)).toEqual(["Access email", "Name chosen in this browser", "Fallback email",
      "Anonymous"]);
    expect(detail(rungs, "access")).toContain("alex@example.test");
    expect(detail(rungs, "access")).toContain("Alex Rivera");
  });

  it("says when an Access email outranks this browser's choice", () => {
    const rungs = precedenceLadder(whoami({ email: "alex@example.test", person: alex, provenance: "upstream-header",
      selection: { status: "overridden" } }), { fallbackConfigured: false });
    expect(states(rungs)).toEqual(["access:decided", "selection:skipped", "fallback:not-reached",
      "anonymous:not-reached"]);
    expect(detail(rungs, "selection")).toBe("Your Access email outranks this browser's choice.");
  });

  it("decides on a valid browser choice when there is no Access email", () => {
    const rungs = precedenceLadder(whoami({ person: alex, provenance: "self-selected", selection: { status: "valid" } }),
      { fallbackConfigured: true });
    expect(states(rungs)).toEqual(["access:skipped", "selection:decided", "fallback:not-reached",
      "anonymous:not-reached"]);
    expect(detail(rungs, "selection")).toContain("Alex Rivera");
    expect(detail(rungs, "selection")).toContain("never the guardrail");
  });

  it("decides on the fallback email only when nothing above it applies", () => {
    const rungs = precedenceLadder(whoami({ email: "solo@example.test", person: alex,
      provenance: "configured-fallback" }), { fallbackConfigured: true });
    expect(states(rungs)).toEqual(["access:skipped", "selection:skipped", "fallback:decided",
      "anonymous:not-reached"]);
    expect(detail(rungs, "fallback")).toContain("solo@example.test");
  });

  it("decides anonymous when nothing names you", () => {
    const rungs = precedenceLadder(whoami({}), { fallbackConfigured: false });
    expect(states(rungs)).toEqual(["access:skipped", "selection:skipped", "fallback:skipped", "anonymous:decided"]);
    expect(detail(rungs, "fallback")).toBe("No fallback email is set.");
    expect(detail(rungs, "anonymous"))
      .toBe("Threads you start show no starter, and the person rules (A and B) never refuse you.");
  });

  it.each(["stale", "expired", "invalid"] as const)(
    "decides anonymous for a %s choice even with a fallback configured",
    (status) => {
      const rungs = precedenceLadder(whoami({ selection: { status } }), { fallbackConfigured: true });
      expect(states(rungs)).toEqual(["access:skipped", "selection:skipped", "fallback:skipped", "anonymous:decided"]);
      expect(detail(rungs, "selection"))
        .toBe(`This browser's choice is ${status}; Identity treats you as anonymous rather than falling back.`);
      expect(detail(rungs, "fallback")).toMatch(/never falls through/);
    },
  );

  it("decides anonymous for a bad choice even if the answer claims the fallback", () => {
    const rungs = precedenceLadder(whoami({ email: "solo@example.test", provenance: "configured-fallback",
      selection: { status: "expired" } }), { fallbackConfigured: true });
    expect(rungs.find((rung) => rung.state === "decided")!.id).toBe("anonymous");
  });

  it("always has exactly one decided rung: skipped above it, not reached below", () => {
    const cases: WhoAmI[] = [
      whoami({ email: "a@example.test", provenance: "upstream-header" }),
      whoami({ person: alex, provenance: "self-selected", selection: { status: "valid" } }),
      whoami({ email: "a@example.test", provenance: "configured-fallback" }),
      whoami({}),
      whoami({ selection: { status: "stale" } }),
    ];
    for (const answer of cases) {
      const rungs = precedenceLadder(answer, { fallbackConfigured: true });
      expect(rungs.map((rung) => rung.id)).toEqual(["access", "selection", "fallback", "anonymous"]);
      const decided = rungs.findIndex((rung) => rung.state === "decided");
      expect(rungs.filter((rung) => rung.state === "decided")).toHaveLength(1);
      rungs.forEach((rung, index) => {
        if (index < decided) expect(rung.state).toBe("skipped");
        if (index > decided) expect(rung.state).toBe("not-reached");
      });
    }
  });
});

describe("PICKER_CHAIN", () => {
  it("walks every picker status once, in the order the server checks them, ending at ready", () => {
    expect(PICKER_CHAIN.map((step) => step.status)).toEqual([...PICKER_STATUSES]);
    expect(PICKER_CHAIN.at(-1)!.status).toBe("ready");
    for (const step of PICKER_CHAIN) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.fix.length).toBeGreaterThan(0);
    }
  });
});
