import { initials } from "./presence-labels.js";
import { decideGuardrail } from "./guardrail.js";
import type { HostClassification } from "./hosts.js";
import type { StarterSummary, Via } from "./attribution.js";
import type { EnforcementMode } from "./audit.js";

/**
 * The wording of the ownership UI (option B in the design note): who started a thread,
 * and the machine it runs on ONLY when that machine differs from the starter's own.
 *
 * Pure strings, no React and no DOM, so the exact copy is testable. Two rules the tests
 * hold this to: an unknown starter must read honestly and neutrally — never alarming,
 * never blank-looking-broken — and a host that matches neither a person nor the
 * `teamMachines` setting is "unclaimed", visibly distinct from "team".
 */

export type OwnershipView = {
  starter: StarterSummary | null;
  provenance?: "self-selected" | "configured-fallback" | "unknown";
  via: Via;
  inheritedFrom: string | null;
  /** The machine the thread runs on, already classified; null when it is not known. */
  host: HostClassification | null;
};

/** "David", "an agent for David", "an automation", "someone not recorded". */
export function starterPhrase(view: OwnershipView): string {
  const name = view.starter?.displayName ?? null;
  if (name !== null && view.provenance === "self-selected") return `${name} (chosen in a browser; attribution only)`;
  if (name !== null && view.provenance === "configured-fallback") return `${name} (configured fallback)`;
  switch (view.via) {
    case "agent":
      return name === null ? "an agent" : `an agent for ${name}`;
    case "plugin":
      return name === null ? "an automation" : `an automation set up by ${name}`;
    case "browser":
      return name ?? "someone not recorded";
    default:
      return name ?? "someone not recorded";
  }
}

/** The Linux account a thread runs as. Display only — Identity never sets it. */
export function runsAs(host: HostClassification, sharedUser: string): string {
  return host.kind === "person" ? host.person.person : sharedUser;
}

/**
 * "team machine", "unclaimed machine", "Matt's machine" — how a machine is described.
 * Exported so the guardrail's refusal text and the UI cannot drift apart: a refusal that
 * named a machine differently from the chip beside it would be worse than no refusal.
 */
export function machineDescription(host: HostClassification): string {
  switch (host.kind) {
    case "team":
      return "team machine";
    case "unclaimed":
      return "unclaimed machine";
    default:
      return `${host.person.displayName}'s machine`;
  }
}

/**
 * Option B's rule: show the machine only when it is not the starter's own. A thread a
 * person started on their own machine says nothing about machines at all.
 */
function machineDiffers(view: OwnershipView): view is OwnershipView & { host: HostClassification } {
  if (view.host === null) return false;
  if (view.host.kind !== "person") return true;
  if (view.host.conflict !== null) return true;
  return view.starter === null || view.host.person.person !== view.starter.person;
}

export type OwnershipChip = { text: string; tone: "default" | "muted" };

/**
 * What enforcement WOULD have done, for the chip to say in `audit` mode.
 *
 * Audit exists so the team can evaluate the guardrail by USING bb, not by reading logs:
 * the chip names the rule that would have fired and, in the same breath, that it did not
 * fire. It is null in every other mode and whenever nothing would have been refused —
 * the honest answer to "what would have happened?" is usually "nothing".
 *
 * It ASKS THE GUARDRAIL — `decideGuardrail`, the same function the dispatch hook and the
 * audit log run — rather than re-deciding rules A and B from the chip's own facts. A dry
 * run whose UI disagrees with its own enforcement is worse than no dry run, and a second
 * copy of the rules is how that happens: the first version of this function did exactly
 * that and diverged on a `fallbackEmail` viewer, whom the guardrail ignores.
 *
 * Only the wording is the chip's own. The decision, and which rule made it, are the
 * guardrail's.
 */
export function wouldBeRefused(input: {
  enforcement: EnforcementMode;
  me: StarterSummary | null;
  /** True when `me` came from the fallbackEmail setting; the guardrail ignores such an identity. */
  meViaFallback?: boolean;
  starter: StarterSummary | null;
  host: HostClassification | null;
}): string | null {
  if (input.enforcement !== "audit") return null;
  // Mirror guardrail.ts: a fallback-derived identity is a display default, not a person
  // asking, so it can never be the subject of a refusal.
  const me = input.meViaFallback === true ? null : input.me;
  if (me === null) return null;
  // The chip speaks for a person reading bb, which is what an `app` dispatch is.
  const ask = (recorded: { starter: StarterSummary | null } | null) => decideGuardrail(true, {
    requester: me,
    recorded,
    host: input.host,
    origin: "app",
    originPluginId: null,
  }, { yourMachines: [], teamMachines: [] });

  // Question 1: would MY next message into this thread be refused? (rule B)
  const sending = ask(input.starter === null ? null : { starter: input.starter });
  if (sending.action === "reject" && sending.rule === "follow-up-by-non-starter" && input.starter !== null) {
    return `would be refused — ${input.starter.displayName}'s thread (audit mode, so it went through)`;
  }
  // Question 2: would a start on this machine be refused? (rule A, which only ever applies
  // to a thread with no record — hence the explicit `null`. Asking it of the recorded
  // thread would always answer "proceed", which is why the first version of this function
  // claimed a refusal the guardrail would never have made.)
  const starting = ask(null);
  if (starting.action === "reject" && starting.rule === "start-on-another-persons-machine" && input.host !== null) {
    return `this start would be refused — ${machineDescription(input.host)} (audit mode, so it went through)`;
  }
  return null;
}

/**
 * The thread-header chip: "Started by David · runs as ensembleworks-agent on
 * ew-lsp-001-main (team machine)".
 */
export function headerChip(
  view: OwnershipView,
  options: {
    sharedUser: string;
    /** The mode in force; only `audit` adds a would-have clause. */
    enforcement?: EnforcementMode;
    /** Who is reading the chip, so rule B's "someone else's thread" can be answered. */
    me?: StarterSummary | null;
    /** True when `me` came from fallbackEmail; the guardrail ignores such an identity. */
    meViaFallback?: boolean;
    meProvenance?: "upstream-header" | "self-selected" | "configured-fallback" | "unknown";
  },
): OwnershipChip {
  const known = view.starter !== null || view.via === "plugin";
  const lead = known ? `Started by ${starterPhrase(view)}` : "Starter not recorded";
  const would = wouldBeRefused({
    enforcement: options.enforcement ?? "off",
    me: options.me ?? null,
    meViaFallback: options.meViaFallback === true,
    starter: view.provenance ? null : view.starter,
    host: view.host,
  });
  const audit = would === null ? "" : ` · ${would}`;
  if (!machineDiffers(view)) return { text: `${lead}${audit}`, tone: known ? "default" : "muted" };
  const host = view.host;
  // Only a person-owned host can carry a conflict, so the pinned owner is its person.
  const conflict = host.conflict === null ? "" : ` — renamed since it was pinned to ${host.person.displayName}`;
  return {
    text: `${lead} · runs as ${runsAs(host, options.sharedUser)} on ${host.hostName} `
      + `(${machineDescription(host)})${conflict}${audit}`,
    tone: known ? "default" : "muted",
  };
}

export type OwnershipRowStatus = {
  /** A BB (lucide) icon name for the sidebar row's status glyph. */
  icon: string;
  label: string;
  /** Always "default": ownership is information, never an alarm. */
  tone: "default";
  /** Two characters for the replacement-sidebar badge, which has no icon. */
  badge: string;
};

/** The sidebar row's ownership glyph. Presence wins over this while someone is typing. */
/** The colour of "nobody": a recorded starter Identity could not name, or no record at all. */
export const NO_PERSON_COLOR = "var(--muted-foreground, #6b7280)";

/**
 * A per-person hue, so a list of threads can be scanned for "whose is this" without
 * reading initials.
 *
 * Hues are DEALT BY POSITION in the roster, not hashed from the id. A hash cannot promise
 * that two people look different — the four people this was built for collided at 26 and
 * 21 degrees apart, which reads as the same colour. Dealing positions guarantees the
 * widest gap the roster allows. The roster is sorted first, so hand-editing the order of
 * the `directory` setting does not repaint anyone.
 *
 * The trade, stated: ADDING a person re-hues the people after them. That is a colour, not
 * data — nothing is stored, and the initials and label still say who.
 *
 * Someone the roster does not name (a starter since removed from the directory) falls
 * back to an FNV-1a hash of the id: stable across processes, just not separated.
 *
 * Saturation and lightness are fixed at `55% 38%`, which keeps every hue dark enough to
 * read a label against — but NOT, as this comment used to claim, dark enough for white
 * text on every hue: white on the yellow seat `hsl(60 55% 38%)` is 3.14:1, under WCAG AA
 * for the 9px badge (measured, 2026-09-19). The ink that goes ON a person's colour is
 * therefore chosen from the colour, by `readableInk` in person-colors.ts, for dealt and
 * chosen colours alike.
 */
export function personColor(person: string | null, roster: readonly string[] = []): string {
  if (person === null) return NO_PERSON_COLOR;
  const dealt = [...new Set(roster)].sort();
  const seat = dealt.indexOf(person);
  if (seat !== -1) return `hsl(${Math.round(seat * (360 / dealt.length))} 55% 38%)`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < person.length; index += 1) {
    hash ^= person.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hsl(${hash % 360} 55% 38%)`;
}

export function ownershipRowStatus(view: OwnershipView): OwnershipRowStatus {
  const known = view.starter !== null || view.via === "plugin";
  const icon = view.via === "agent" ? "Bot" : view.via === "plugin" ? "Clock" : known ? "User" : "CircleHelp";
  const lead = known ? `Started by ${starterPhrase(view)}` : "Starter not recorded";
  const label = machineDiffers(view) ? `${lead} · ${machineDescription(view.host)}` : lead;
  return {
    icon,
    label,
    tone: "default",
    badge: view.starter === null ? "?" : initials(view.starter.displayName),
  };
}

export type OwnershipBanner = { title: string; detail: string };

/**
 * The new-thread composer banner.
 *
 * Deliberately makes NO promise about the machine you picked: spike S3-lite found that a
 * `new-thread` composer customization sees only the project, the draft and submit state
 * (SDK `ComposerView`), never the selected machine — so the banner states who you are and
 * which machines are yours, and says plainly where a wrong machine is actually caught.
 */
export function composerBanner(input: {
  me: StarterSummary | null;
  provenance?: "upstream-header" | "self-selected" | "configured-fallback" | "unknown";
  machines: readonly HostClassification[];
  /** The mode in force, which changes what this banner may promise. */
  enforcement: EnforcementMode;
}): OwnershipBanner {
  if (input.me !== null && input.provenance === "self-selected") return {
    title: `Starting as ${input.me.displayName} (chosen in this browser)`,
    detail: "Attribution only. This choice does not change machine guardrails.",
  };
  if (input.me !== null && input.provenance === "configured-fallback") return {
    title: `Starting as ${input.me.displayName} (configured fallback)`,
    detail: "Attribution only. This default does not change machine guardrails.",
  };
  if (input.me === null) {
    return {
      title: "Starting as an unrecognised sign-in",
      detail: "Threads you start will show no starter. Add your email to Identity's directory setting to be named.",
    };
  }
  const mine = input.machines
    .filter((host) => host.kind === "person" && host.person.person === input.me?.person)
    .map((host) => host.hostName);
  const team = input.machines.filter((host) => host.kind === "team").map((host) => host.hostName);
  const title = `Starting as ${input.me.displayName}`;
  const lists = [
    mine.length > 0 ? `Your machines: ${mine.join(", ")}.` : "No machines of your own are known yet.",
    team.length > 0 ? `Team machine: ${team.join(", ")}.` : null,
  ].filter((part): part is string => part !== null).join(" ");
  // What happens after you press send is the only part of this that the setting changes.
  // With enforcement off nothing refuses anything; in audit the same decision is taken
  // and then not acted on. Saying otherwise would be a lie told in the user's own
  // composer (there is a test for exactly that, in both modes).
  const afterwards = input.enforcement === "enforce"
    ? "The dispatch itself is checked though: starting on someone else's machine is refused, with a message "
      + "naming whose it is."
    : input.enforcement === "audit"
      ? "The dispatch itself is judged though: in audit mode, starting on someone else's machine is written to "
        + "Identity's log as a would-refuse, and then goes ahead anyway."
      : "Nothing else checks it yet either: starting on someone else's machine is recorded, not refused.";
  if (mine.length === 0 && team.length === 0) {
    // Even with nothing to list, the mode sentence still ships: "what happens when I
    // press send" is the one thing this banner can always answer truthfully.
    return {
      title,
      detail: "No machines of yours are known yet. BB does not tell a plugin which machine this composer has "
        + `selected. ${afterwards}`,
    };
  }
  return {
    title,
    detail: `${lists} BB does not tell a plugin which machine this composer has selected, so this banner cannot `
      + `check it for you. ${afterwards}`,
  };
}

/**
 * The composer banner on a thread someone else started.
 *
 * Step 4 left this unbuilt on purpose: it is rule B — other people's threads are
 * read-only (answer 1) — that makes it true, so it ships with rule B. It says "read-only"
 * only when `restrictStarts` is actually on; with the setting off the thread is someone
 * else's but nothing stops you, and the banner says that instead of pretending.
 *
 * Null (no banner at all) on your own thread, on a thread with no recorded starter, and
 * for a sign-in Identity cannot name — in none of those can it say anything true.
 */
export function readOnlyBanner(input: {
  me: StarterSummary | null;
  /** True when `me` came from fallbackEmail; the guardrail ignores such an identity. */
  meViaFallback?: boolean;
  starter: StarterSummary | null;
  enforcement: EnforcementMode;
}): OwnershipBanner | null {
  const { starter } = input;
  // Mirror guardrail.ts: a fallback-derived identity is never the subject of a refusal, so
  // neither the audit wording nor the enforce wording can honestly be shown to one.
  const me = input.meViaFallback === true ? null : input.me;
  if (me === null || starter === null || me.person === starter.person) return null;
  const name = starter.displayName;
  if (input.enforcement === "off") {
    return {
      title: `${name}'s thread`,
      detail: `Other people's threads are meant to be ${name}'s to drive, but nothing enforces that here: `
        + "Identity's enforcement setting is off.",
    };
  }
  if (input.enforcement === "audit") {
    return {
      title: `${name}'s thread`,
      detail: `Other people's threads are meant to be ${name}'s to drive. In audit mode a message from you here `
        + "is written to Identity's log as a would-refuse, and then goes through anyway.",
    };
  }
  return {
    title: `Read-only: ${name}'s thread`,
    detail: `Only ${name} can send to it. Ask ${name}, or start a thread of your own.`,
  };
}
