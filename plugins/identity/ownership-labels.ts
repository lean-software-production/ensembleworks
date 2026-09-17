import { initials } from "./presence-labels.js";
import type { HostClassification } from "./hosts.js";
import type { StarterSummary, Via } from "./attribution.js";

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
  via: Via;
  inheritedFrom: string | null;
  /** The machine the thread runs on, already classified; null when it is not known. */
  host: HostClassification | null;
};

/** "David", "an agent for David", "an automation", "someone not recorded". */
export function starterPhrase(view: OwnershipView): string {
  const name = view.starter?.displayName ?? null;
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

/** "team machine", "unclaimed machine", "Matt's machine" — how a machine is described. */
function machineDescription(host: HostClassification): string {
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
 * The thread-header chip: "Started by David · runs as ensembleworks-agent on
 * ew-lsp-001-main (team machine)".
 */
export function headerChip(view: OwnershipView, options: { sharedUser: string }): OwnershipChip {
  const known = view.starter !== null || view.via === "plugin";
  const lead = known ? `Started by ${starterPhrase(view)}` : "Starter not recorded";
  if (!machineDiffers(view)) return { text: lead, tone: known ? "default" : "muted" };
  const host = view.host;
  // Only a person-owned host can carry a conflict, so the pinned owner is its person.
  const conflict = host.conflict === null ? "" : ` — renamed since it was pinned to ${host.person.displayName}`;
  return {
    text: `${lead} · runs as ${runsAs(host, options.sharedUser)} on ${host.hostName} (${machineDescription(host)})${conflict}`,
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
  machines: readonly HostClassification[];
}): OwnershipBanner {
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
  if (mine.length === 0 && team.length === 0) {
    return {
      title,
      detail: "No machines of yours are known yet. BB does not tell a plugin which machine this composer has selected.",
    };
  }
  const lists = [
    mine.length > 0 ? `Your machines: ${mine.join(", ")}.` : "No machines of your own are known yet.",
    team.length > 0 ? `Team machine: ${team.join(", ")}.` : null,
  ].filter((part): part is string => part !== null).join(" ");
  return {
    title,
    detail: `${lists} BB does not tell a plugin which machine this composer has selected, so this banner cannot `
      + "check it for you — a start on someone else's machine is caught when the message is dispatched.",
  };
}
