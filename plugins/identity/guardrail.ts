import type { AttributionFacts, DispatchOrigin, StarterRecord, StarterSummary } from "./attribution.js";
import type { HostRef } from "./host-ref.js";
import { machineDescription } from "./ownership-labels.js";
import type { HostClassification } from "./hosts.js";

/**
 * The guardrail (step 5): the ONE place Identity can refuse a dispatch.
 *
 * It is a guardrail, not an access control (Decisions, 2026-09-15). It exists to catch
 * the mistake of starting a thread on a teammate's machine, or of typing into someone
 * else's thread — not to stop a determined teammate, who can still reach bb through
 * Send-now, a terminal, or a raw API call.
 *
 * THE LOAD-BEARING RULE, decided after S9 (2026-09-18): **a dispatch with no identity
 * is always allowed**. S9 proved four legitimate paths arrive with no identity, no
 * origin and no lineage at all — an agent's own `bb thread tell`, `bb thread retry`, a
 * plugin's follow-up `threads.send` (a workflow's completion notice), and an automation
 * aimed at an existing thread. Anonymity is the normal shape of every agent path here,
 * so it is never itself a violation. Only a POSITIVELY IDENTIFIED requester can be
 * refused: a known person (rules A and B), or a dispatch bb itself stamped as the
 * automations plugin (rule C). `requireIdentity` — refusing the identity-less — is
 * deliberately NOT built; see the design note.
 */

/**
 * bb's built-in automations plugin. Rule C can only see an automation that bb stamped
 * with this id, which is the `threads.spawn` shape (a scheduled agent run creating a new
 * thread). An automation whose target is an EXISTING thread goes through
 * `threads.send`, which the plugin-SDK bridge does not stamp at all — it reaches the
 * hook with `origin: null` and `originPluginId: null`, indistinguishable from a stray
 * `curl`. Rule C is blind to that shape and allows it. This is stated, not worked
 * around: the fix is upstream (stamp `threads.send` too).
 */
export const AUTOMATIONS_PLUGIN_ID = "automations";

export type GuardrailRule =
  | "start-on-another-persons-machine"
  | "follow-up-by-non-starter"
  | "automation-off-team-machine";

export type GuardrailDecision =
  | { action: "proceed" }
  | { action: "reject"; rule: GuardrailRule; message: string };

export type GuardrailFacts = {
  /** The person the request's own identity resolved to. Null for every anonymous path. */
  requester: StarterSummary | null;
  /**
   * The thread's recorded attribution, or null when nothing is recorded — which is how
   * this module tells a START from a FOLLOW-UP. A thread whose first message went out
   * through Send-now has no record, so its next dispatch looks like a start; that is the
   * accepted cost of Send-now skipping the hook.
   */
  recorded: { starter: StarterSummary | null } | null;
  /** The machine this dispatch is headed for, classified. Null when bb named none. */
  host: HostClassification | null;
  origin: DispatchOrigin;
  originPluginId: string | null;
};

/** Machine names used only to make a refusal teach the fix. In-memory, never fetched. */
export type GuardrailMachines = {
  /** The requester's own machines, as far as Identity knows them. */
  yourMachines: readonly string[];
  teamMachines: readonly string[];
};

const SETTING_NOTE = "(Identity's restrictStarts setting refused this.)";

function list(names: readonly string[]): string {
  return names.join(", ");
}

/**
 * Decide one dispatch.
 *
 * Order: rule B before rule A, because the two are mutually exclusive by construction —
 * rule A only ever looks at a dispatch with no record (a start), rule B only at one with
 * a recorded starter (a follow-up). Rule C is independent of the other two: it judges a
 * dispatch bb identified as an automation, which never carries a person.
 */
export function decideGuardrail(
  enabled: boolean,
  facts: GuardrailFacts,
  machines: GuardrailMachines,
): GuardrailDecision {
  if (!enabled) return { action: "proceed" };

  const requester = facts.requester;
  if (requester !== null) {
    const startedBy = facts.recorded?.starter ?? null;
    // Rule B — other people's threads are read-only (answer 1).
    if (startedBy !== null && startedBy.person !== requester.person) {
      return {
        action: "reject",
        rule: "follow-up-by-non-starter",
        message:
          `This thread was started by ${startedBy.displayName}, and other people's threads are read-only. `
          + `Ask ${startedBy.displayName} to send it, or start a thread of your own. ${SETTING_NOTE}`,
      };
    }
    // Rule A — a start on another person's machine (answer 6: team and unclaimed are fine).
    if (facts.recorded === null && facts.host !== null && facts.host.kind === "person"
      && facts.host.person.person !== requester.person) {
      // The machine names come from memory (see `makeGuardrail`), so any of the three
      // shapes below is a normal state — and each has to read like a sentence.
      const team = machines.teamMachines.length > 0 ? list(machines.teamMachines) : null;
      const fix = machines.yourMachines.length > 0
        ? `Pick one of yours (${list(machines.yourMachines)})`
          + `${team === null ? "" : `, or the team machine (${team})`}, and start the thread there.`
        : team === null
          ? "Identity knows no machine of your own yet, and no team machine is configured."
          : `Identity knows no machine of your own yet; start the thread on the team machine (${team}) instead.`;
      return {
        action: "reject",
        rule: "start-on-another-persons-machine",
        message: `${facts.host.hostName} is ${machineDescription(facts.host)}. ${fix} ${SETTING_NOTE}`,
      };
    }
    return { action: "proceed" };
  }

  // Rule C — an automation must run on a team machine (answer 2). Only reachable for the
  // stamped `threads.spawn` shape; see AUTOMATIONS_PLUGIN_ID for what it cannot see.
  if (facts.origin === "plugin" && facts.originPluginId === AUTOMATIONS_PLUGIN_ID
    && facts.host !== null && facts.host.kind !== "team") {
    const team = machines.teamMachines.length > 0 ? ` (${list(machines.teamMachines)})` : "";
    return {
      action: "reject",
      rule: "automation-off-team-machine",
      message:
        `Automations run on a team machine only. This one is headed for ${facts.host.hostName} `
        + `(${machineDescription(facts.host)}). Move it to a team machine${team}, or add `
        + `${facts.host.hostName} to Identity's teamMachines setting. ${SETTING_NOTE}`,
    };
  }
  return { action: "proceed" };
}

/**
 * The guard the dispatch hook calls: classify the machine, then decide.
 *
 * `classify` is the same pinned classification the ownership UI uses (`hosts.ts`), not a
 * second derivation — a refusal and the chip it contradicts would be worse than no
 * guardrail at all. `machines` reads in-memory state only; a refusal must never wait on
 * the network to word itself.
 */
export function makeGuardrail(deps: {
  enabled: () => boolean;
  classify: (host: HostRef) => Promise<HostClassification>;
  machines: (requester: StarterSummary | null) => GuardrailMachines;
}): (input: { facts: AttributionFacts; existing: StarterRecord | null }) => Promise<GuardrailDecision> {
  return async ({ facts, existing }) => {
    if (!deps.enabled()) return { action: "proceed" };
    const host = facts.host === null ? null : await deps.classify(facts.host);
    // A `fallbackEmail` identity is a display default, not a person asking: on a server
    // configured with one, every header-less caller — all four of S9's agent paths —
    // would otherwise arrive here positively identified and become refusable.
    const requester = facts.viaFallback ? null : facts.person;
    return decideGuardrail(true, {
      requester,
      recorded: existing === null ? null : { starter: existing.starter },
      host,
      origin: facts.origin,
      originPluginId: facts.originPluginId,
    }, deps.machines(requester));
  };
}
