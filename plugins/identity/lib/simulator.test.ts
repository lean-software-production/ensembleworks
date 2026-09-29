import { afterEach, describe, expect, it, vi } from "vitest";
import * as guardrail from "../guardrail.js";
import { simulate, simulationFacts, type SimMachine, type SimWhat, type SimWho } from "./simulator.js";

// Wrap the REAL decideGuardrail in a spy: the simulator must call it, never model it.
vi.mock("../guardrail.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../guardrail.js")>();
  return { ...real, decideGuardrail: vi.fn(real.decideGuardrail) };
});
const decide = vi.mocked(guardrail.decideGuardrail);
afterEach(() => decide.mockClear());

const WHO: readonly SimWho[] = ["access-person", "browser-name", "fallback", "anonymous", "automation"];
const WHAT: readonly SimWhat[] = ["start", "follow-up-own", "follow-up-others"];
const MACHINE: readonly SimMachine[] = ["own", "another-persons", "team", "unclaimed"];
const every = WHO.flatMap((who) => WHAT.flatMap((what) => MACHINE.map((machine) => ({ who, what, machine }))));
const label = ({ who, what, machine }: (typeof every)[number]) => `${who} · ${what} · ${machine}`;

describe("simulate", () => {
  it.each(every.map((input) => [label(input), input] as const))("%s: one real decision, three modes", (_name, input) => {
    const outcomes = simulate(input);
    expect(outcomes.map((outcome) => outcome.mode)).toEqual(["off", "audit", "enforce"]);
    const [off, audit, enforce] = outcomes;

    // (i) off never decides anything.
    expect(off).toEqual({ mode: "off", result: "allowed", rule: null, message: null });
    // (ii) audit and enforce carry the same decision; only what happens next differs.
    expect(audit.rule).toBe(enforce.rule);
    expect(audit.message).toBe(enforce.message);
    expect(audit.result).toBe(enforce.rule === null ? "allowed" : "logged-would-refuse");
    expect(enforce.result).toBe(enforce.rule === null ? "allowed" : "refused");

    // (v) the real decideGuardrail ran exactly once, enabled, and its own text is what is shown.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0]).toBe(true);
    const { facts, machines } = simulationFacts(input);
    expect(decide.mock.calls[0][1]).toEqual(facts);
    expect(decide.mock.calls[0][2]).toEqual(machines);
    const decision = decide.mock.results[0].value as guardrail.GuardrailDecision;
    expect(enforce.message).toBe(decision.action === "reject" ? decision.message : null);
    expect(enforce.rule).toBe(decision.action === "reject" ? decision.rule : null);

    // (iii) only a person identified by their Access email can hit rule A or B.
    if (input.who !== "access-person") {
      expect(enforce.rule).not.toBe("start-on-another-persons-machine");
      expect(enforce.rule).not.toBe("follow-up-by-non-starter");
    }
    // Browser names and the fallback email are never refused, whatever they do.
    if (input.who === "browser-name" || input.who === "fallback" || input.who === "anonymous") {
      expect(enforce.result).toBe("allowed");
    }
  });

  it("builds a person requester only for an Access identity", () => {
    for (const who of WHO) {
      const { facts } = simulationFacts({ who, what: "start", machine: "own" });
      expect(facts.requester !== null).toBe(who === "access-person");
    }
  });

  it("refuses a person's start on someone else's machine (rule A) and their message into someone else's thread (rule B)", () => {
    const start = simulate({ who: "access-person", what: "start", machine: "another-persons" })[2];
    expect(start.rule).toBe("start-on-another-persons-machine");
    expect(start.result).toBe("refused");
    expect(start.message).toContain("(Refused by Identity's machine-ownership guardrail.)");

    const followUp = simulate({ who: "access-person", what: "follow-up-others", machine: "own" })[2];
    expect(followUp.rule).toBe("follow-up-by-non-starter");
    expect(simulate({ who: "access-person", what: "follow-up-own", machine: "own" })[2].result).toBe("allowed");
    for (const machine of ["own", "team", "unclaimed"] as const) {
      expect(simulate({ who: "access-person", what: "start", machine })[2].result).toBe("allowed");
    }
  });

  it("refuses a stamped automation start off a team machine (rule C)", () => {
    for (const machine of MACHINE) {
      const enforce = simulate({ who: "automation", what: "start", machine })[2];
      expect(enforce.rule).toBe(machine === "team" ? null : "automation-off-team-machine");
    }
    const { facts } = simulationFacts({ who: "automation", what: "start", machine: "unclaimed" });
    expect(facts.origin).toBe("plugin");
    expect(facts.originPluginId).toBe(guardrail.AUTOMATIONS_PLUGIN_ID);
  });

  it("lets an automation's message into an existing thread through, because it arrives unstamped", () => {
    for (const what of ["follow-up-own", "follow-up-others"] as const) {
      const { facts } = simulationFacts({ who: "automation", what, machine: "unclaimed" });
      expect(facts.origin).toBeNull();
      expect(facts.originPluginId).toBeNull();
      expect(simulate({ who: "automation", what, machine: "unclaimed" })[2].result).toBe("allowed");
    }
  });

  it("records another starter only for a follow-up into someone else's thread", () => {
    const me = simulationFacts({ who: "access-person", what: "follow-up-own", machine: "own" }).facts;
    const other = simulationFacts({ who: "access-person", what: "follow-up-others", machine: "own" }).facts;
    expect(simulationFacts({ who: "access-person", what: "start", machine: "own" }).facts.recorded).toBeNull();
    expect(me.recorded?.starter?.person).toBe(me.requester?.person);
    expect(other.recorded?.starter?.person).not.toBe(other.requester?.person);
  });
});
