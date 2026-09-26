import type { StarterSummary } from "../attribution.js";
import type { EnforcementMode } from "../audit.js";
import {
  AUTOMATIONS_PLUGIN_ID,
  decideGuardrail,
  type GuardrailFacts,
  type GuardrailMachines,
  type GuardrailRule,
} from "../guardrail.js";
import type { HostClassification } from "../hosts.js";

/**
 * The Rules tab's guardrail simulator. It builds the facts the dispatch hook would build
 * (`makeGuardrail`) for one imagined dispatch and hands them to the REAL
 * `decideGuardrail` — once, since `audit` and `enforce` take the same decision and only
 * act on it differently. A simulator that modelled the rules instead would be a second
 * copy of them, free to drift.
 *
 * The example cast is fixed: Alex asks, Sam is someone else, and each machine kind has
 * one host.
 */
export type SimWho = "access-person" | "browser-name" | "fallback" | "anonymous" | "automation";
export type SimWhat = "start" | "follow-up-own" | "follow-up-others";
export type SimMachine = "own" | "another-persons" | "team" | "unclaimed";
export type SimOutcome = {
  mode: EnforcementMode;
  result: "allowed" | "logged-would-refuse" | "refused";
  rule: GuardrailRule | null;
  message: string | null;
};
export type SimInput = { who: SimWho; what: SimWhat; machine: SimMachine };

export const SIM_ASKER: StarterSummary = { person: "alex", displayName: "Alex", github: "alex" };
export const SIM_OTHER: StarterSummary = { person: "sam", displayName: "Sam", github: "sam" };
const OWN_HOST = "ew-lab-001-alex";
const TEAM_HOST = "ew-main";

const HOSTS: Record<SimMachine, HostClassification> = {
  own: { kind: "person", hostId: "sim-own", hostName: OWN_HOST, person: SIM_ASKER, conflict: null },
  "another-persons": { kind: "person", hostId: "sim-other", hostName: "ew-lab-002-sam", person: SIM_OTHER, conflict: null },
  team: { kind: "team", hostId: "sim-team", hostName: TEAM_HOST, conflict: null },
  unclaimed: { kind: "unclaimed", hostId: "sim-unclaimed", hostName: "scratch-7", conflict: null },
};

/**
 * The facts and machine names for one imagined dispatch, shaped as `makeGuardrail`
 * shapes them:
 * - only an Access identity is a requester — a browser name or the fallback email is a
 *   label, never a person asking;
 * - an automation is stamped (`origin: "plugin"`, the automations plugin id) only when it
 *   spawns a thread. Sending into an existing thread goes through `threads.send`, which
 *   arrives unstamped, so that shape is built unstamped too.
 */
export function simulationFacts({ who, what, machine }: SimInput): { facts: GuardrailFacts; machines: GuardrailMachines } {
  const requester = who === "access-person" ? SIM_ASKER : null;
  const stamped = who === "automation" && what === "start";
  const origin: GuardrailFacts["origin"] = stamped ? "plugin"
    : who === "anonymous" || who === "automation" ? null
    : "app";
  return {
    facts: {
      requester,
      recorded: what === "start" ? null : { starter: what === "follow-up-own" ? SIM_ASKER : SIM_OTHER },
      host: HOSTS[machine],
      origin,
      originPluginId: stamped ? AUTOMATIONS_PLUGIN_ID : null,
    },
    machines: { yourMachines: requester === null ? [] : [OWN_HOST], teamMachines: [TEAM_HOST] },
  };
}

/** The outcome in each mode, in the order off, audit, enforce. */
export function simulate(input: SimInput): SimOutcome[] {
  const { facts, machines } = simulationFacts(input);
  const decision = decideGuardrail(true, facts, machines);
  const reject = decision.action === "reject" ? decision : null;
  const rule = reject?.rule ?? null;
  const message = reject?.message ?? null;
  return [
    { mode: "off", result: "allowed", rule: null, message: null },
    { mode: "audit", result: reject === null ? "allowed" : "logged-would-refuse", rule, message },
    { mode: "enforce", result: reject === null ? "allowed" : "refused", rule, message },
  ];
}
