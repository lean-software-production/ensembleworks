import type { GuardrailRule } from "../guardrail.js";
import type { SettingsTab } from "../settings-admin.js";
import { SEEN_UNKNOWN_CAVEAT } from "../roster.js";

/**
 * Every explanation the Identity UI gives, written once. Pages say one short sentence and
 * wrap the term in <Explain>, which shows the entry here in a popover; `more` names the
 * settings tab that holds the controls the entry is about.
 */
export type GlossaryId =
  | "attribution-only" | "precedence" | "guardrail" | "blind-spots"
  | "rule-own-machine" | "rule-own-thread" | "rule-automation"
  | "composer-check" | "fallback-email" | "machine-owner" | "seen" | "logged-changes";

export type GlossaryEntry = { title: string; body: readonly string[]; more?: SettingsTab };

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = {
  "attribution-only": {
    title: "Attribution only",
    body: [
      "A name chosen in a browser, or the fallback email, labels who started a thread and who sent a message. That is all it does.",
      "The guardrail ignores it: it is never refused, and threads it starts are open to anyone. Only an Access email counts for the guardrail.",
    ],
    more: "browser",
  },
  precedence: {
    title: "Which name you are shown as",
    body: [
      "Identity takes the first that applies: your Access email, then a name chosen in this browser, then the fallback email. With none of them you are anonymous.",
      "A chosen name that is stale, expired or invalid makes you anonymous; it never falls through to the fallback email.",
    ],
    more: "browser",
  },
  guardrail: {
    title: "The guardrail",
    body: [
      "Identity's one check before a message runs. It catches mistakes, such as starting a thread on someone else's machine; it is not a lock.",
      "Only two kinds of request can be refused: one from a person identified by their Access email, and a new thread from an automation BB has stamped. Anything else goes through.",
    ],
    more: "rules",
  },
  "blind-spots": {
    title: "What the guardrail can't see",
    body: [
      "BB doesn't tell Identity which machine the new-thread composer has selected, so nothing is checked until you press Send.",
      "Send now skips the check; Identity records who sent it afterwards.",
      "Terminals, Stop, Archive and approvals are never refused. An automation sending into an existing thread isn't checked.",
    ],
    more: "rules",
  },
  "rule-own-machine": {
    title: "Own-machine rule",
    body: [
      "Someone identified by their Access email may not start a thread on another person's machine. Team and unclaimed machines are open to everyone.",
      "In the log: start-on-another-persons-machine.",
    ],
    more: "rules",
  },
  "rule-own-thread": {
    title: "Own-thread rule",
    body: [
      "Someone identified by their Access email may not send into a thread another person started that way. Threads started any other way are open to anyone.",
      "In the log: follow-up-by-non-starter.",
    ],
    more: "rules",
  },
  "rule-automation": {
    title: "Automation rule",
    body: [
      "An automation may start a thread only on a team machine, or without naming a machine. It is checked only when BB stamps it as the automations plugin.",
      "An automation sending into an existing thread is not stamped, so it is never checked.",
      "In the log: automation-off-team-machine.",
    ],
    more: "rules",
  },
  "composer-check": {
    title: "When the machine is checked",
    body: [
      "BB doesn't tell Identity which machine you pick here, so this banner can't check it.",
      "When you press Send, Identity checks the machine. In Enforce, a start on someone else's machine is refused with a message naming whose it is. In Audit it is logged and goes ahead. Off only records who started the thread.",
    ],
    more: "rules",
  },
  "fallback-email": {
    title: "Fallback email",
    body: [
      "For a server only one person uses. A request with no Access email and no browser name, such as an agent or the CLI, is attributed to this email.",
      "Attribution only: the guardrail never refuses on it. Leave it empty on a shared server.",
    ],
    more: "browser",
  },
  "machine-owner": {
    title: "Whose machine it is",
    body: [
      "A machine whose name ends in -<name>, where <name> is someone's id or GitHub handle, is theirs. Identity pins it on first sight, so a rename doesn't change the owner; a rename that disagrees shows as a conflict.",
      "Team-list machines are the team's, even with a person's name. Anything else is unclaimed: anyone may start threads there.",
    ],
    more: "machines",
  },
  seen: {
    title: "Seen",
    body: ["A thread attributed to them is on record.", SEEN_UNKNOWN_CAVEAT],
  },
  "logged-changes": {
    title: "Which changes are logged",
    body: [
      "Every change made in this section writes a line to BB's log naming who made it, and risky ones ask first.",
      "BB's generated Configuration form and `bb plugin config` change the same settings without asking and without a log line.",
    ],
  },
};

/** What the UI calls each guardrail rule. Log lines keep the rule id. */
export const RULE_NAMES: Record<GuardrailRule, string> = {
  "start-on-another-persons-machine": "own-machine rule",
  "follow-up-by-non-starter": "own-thread rule",
  "automation-off-team-machine": "automation rule",
};

export const RULE_TERMS: Record<GuardrailRule, GlossaryId> = {
  "start-on-another-persons-machine": "rule-own-machine",
  "follow-up-by-non-starter": "rule-own-thread",
  "automation-off-team-machine": "rule-automation",
};
