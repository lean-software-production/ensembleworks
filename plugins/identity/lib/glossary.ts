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
      "A name chosen in a browser, or the fallback email, shows who you are. Either records who started a thread when it matches someone in the directory.",
      "The person rules never refuse it. A thread recorded as started by it is open to anyone; one begun with Send now has no record. Only an Access email in the directory counts for the person rules; the automation rule covers stamped automations.",
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
      "Only two kinds of request can be refused: one from a person in the directory, identified by their Access email, and a new thread from an automation BB has stamped. Anything else goes through.",
    ],
    more: "rules",
  },
  "blind-spots": {
    title: "What the guardrail can't see",
    body: [
      "BB doesn't tell Identity which machine the new-thread composer has selected. In Audit and Enforce, the check comes when you press Send; Off checks nothing.",
      "Send now skips the check. In Audit and Enforce, Identity logs it afterwards, naming the sender when it can.",
      "Terminals, Stop, Archive and approvals are never refused. An automation sending into an existing thread isn't checked.",
    ],
    more: "rules",
  },
  "rule-own-machine": {
    title: "Own-machine rule",
    body: [
      "In Enforce, someone whose Access email is in the directory can't start a thread on another person's machine; Audit logs it and lets it through. Team and unclaimed machines are open to every person; a BB-stamped automation meets the automation rule instead.",
      "In the log: start-on-another-persons-machine.",
    ],
    more: "rules",
  },
  "rule-own-thread": {
    title: "Own-thread rule",
    body: [
      "In Enforce, someone whose Access email is in the directory can't send into someone else's thread; Audit logs it and lets it through. A child thread with no named requester can inherit a recorded starter. One recorded from a browser name or the fallback email is open. A thread with no record, such as one begun with Send now, counts as a new start (own-machine rule).",
      "In the log: follow-up-by-non-starter.",
    ],
    more: "rules",
  },
  "rule-automation": {
    title: "Automation rule",
    body: [
      "In Enforce, an automation can start a thread only on a team machine, or without naming one; Audit logs it and lets it through. It is checked only when BB stamps it as the automations plugin.",
      "An automation sending into an existing thread is not stamped, so it is never checked.",
      "In the log: automation-off-team-machine.",
    ],
    more: "rules",
  },
  "composer-check": {
    title: "When the machine is checked",
    body: [
      "BB doesn't tell Identity which machine you pick here, so this banner can't check it.",
      "In Audit and Enforce, pressing Send checks the machine. If your Access email is in the directory, Enforce refuses a start on someone else's machine and names whose it is. In Audit it is logged and goes ahead. The person rules never refuse a browser name or the fallback email. Off only records the starter.",
    ],
    more: "rules",
  },
  "fallback-email": {
    title: "Fallback email",
    body: [
      "For a server only one person uses. A request with no Access email and no browser name, such as an agent or the CLI, is attributed to this email.",
      "Attribution only: the person rules never refuse it, though a stamped automation still meets the automation rule. Leave it empty on a shared server.",
    ],
    more: "browser",
  },
  "machine-owner": {
    title: "Whose machine it is",
    body: [
      "Team-list machines are the team's, whatever their name or pin. Otherwise a pinned machine stays its owner's, through renames and after they leave the directory; a disagreeing name is flagged. Otherwise a name ending in -<name> (someone's id or GitHub handle) makes it theirs, and pins it.",
      "Anything else is unclaimed: any person may start there. In Enforce a BB-stamped automation may not; Audit logs it and lets it through.",
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
      "Settings, colour and machine changes made here write a line to BB's log with the requester's identity, which may be unknown. Risky ones ask first.",
      "Choosing a browser name logs the name chosen; forgetting one logs no name. Neither says who did it.",
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
