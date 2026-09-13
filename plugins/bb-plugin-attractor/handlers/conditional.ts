/**
 * `conditional` (diamond) handler. A conditional node has no `prompt`/
 * `script` of its own (per "Supported DOT dialect", it exists purely to
 * route on its outgoing edges' `condition="outcome=…"`). Its own outcome
 * therefore mirrors the previous stage's outcome, via the `last_outcome`
 * context key engine/engine.ts now writes after every stage (see
 * README "Deviations from the plan" — this key isn't in the plan's literal
 * "Context keys written by handlers" list, but is needed to make a
 * conditional node's own `outcome=…` edges meaningful; see the Appendix's
 * BranchLoop example's `check` node).
 */

import type { Handler, OutcomeStatus } from "../engine/types";

const KNOWN_STATUSES: readonly OutcomeStatus[] = ["succeeded", "failed", "partially_succeeded", "skipped"];

export const conditionalHandler: Handler = {
  async run(input) {
    const raw = input.context.get("last_outcome");
    const status = typeof raw === "string" && (KNOWN_STATUSES as readonly string[]).includes(raw) ? (raw as OutcomeStatus) : "succeeded";
    return { status };
  },
};
