import type { WhoAmI } from "../server.js";
import type { PickerStatus, ReadinessStatus } from "../settings-admin.js";

/**
 * The This browser tab's "Why am I shown as …?" ladder: the fixed precedence (Access
 * email → valid browser choice → fallback email → anonymous) walked for one who-you-are
 * answer. Pure, so the copy's promise — a stale, expired or invalid choice is anonymous
 * and never falls through to the fallback — is the rule tested here.
 */
export type RungId = "access" | "selection" | "fallback" | "anonymous";
export type RungState = "decided" | "skipped" | "not-reached";
export type Rung = { id: RungId; label: string; state: RungState; detail: string };

const LABELS: Record<RungId, string> = {
  access: "Access email",
  selection: "Name chosen in this browser",
  fallback: "Fallback email",
  anonymous: "Anonymous",
};
const ORDER: readonly RungId[] = ["access", "selection", "fallback", "anonymous"];
const BAD_CHOICES = new Set(["stale", "expired", "invalid"]);

export function precedenceLadder(whoami: WhoAmI, context: { fallbackConfigured: boolean }): Rung[] {
  const status = whoami.selection?.status ?? null;
  const badChoice = status !== null && BAD_CHOICES.has(status);
  const name = whoami.person?.displayName ?? null;
  // A bad choice is anonymous whatever else the answer says: it never reaches the fallback.
  const decided: RungId = whoami.provenance === "upstream-header" ? "access"
    : badChoice ? "anonymous"
    : whoami.provenance === "self-selected" ? "selection"
    : whoami.provenance === "configured-fallback" ? "fallback"
    : "anonymous";

  const details: Record<RungId, string> = {
    access: decided === "access"
      ? `Access sent ${whoami.email ?? "an email"}${name === null
        ? ", which is not in the directory. It counts for attribution only; the person rules need a directory match."
        : `, which the directory names ${name}. It counts for attribution and the guardrail.`}`
      : "No Access email on this request.",
    selection: status === "overridden" ? "Your Access email outranks this browser's choice."
      : badChoice ? `This browser's choice is ${status}; Identity treats you as anonymous rather than falling back.`
      : decided === "selection" ? `This browser chose ${name ?? "a name"}. It counts for attribution, never the person rules.`
      : "This browser has not chosen a name.",
    fallback: decided === "fallback"
      ? `The Fallback email setting names ${whoami.email ?? "someone"}${name === null ? "" : ` (${name})`}. It counts for attribution, never the person rules.`
      : badChoice && context.fallbackConfigured ? `Skipped: a ${status} choice never falls through to the fallback.`
      : context.fallbackConfigured ? "The fallback email did not apply to this request."
      : "No fallback email is set.",
    anonymous: decided === "anonymous"
      ? "Threads you start show no starter, and the own-machine and own-thread rules never refuse you."
      : "Not reached.",
  };

  const at = ORDER.indexOf(decided);
  return ORDER.map((id, index) => ({
    id,
    label: LABELS[id],
    // "overridden" is the one rung below the decision that was looked at: the choice exists but is outranked.
    state: index === at ? "decided"
      : index < at || (id === "selection" && status === "overridden") ? "skipped"
      : "not-reached",
    detail: index > at && !(id === "selection" && status === "overridden") ? "Not reached." : details[id],
  }));
}

/**
 * The picker's readiness chain, in the order the server checks it. Each step is named
 * for what must hold to get past the status of the same name; `ready` is the end.
 */
export const PICKER_CHAIN: ReadonlyArray<{ status: PickerStatus; label: string; fix: string }> = [
  { status: "off", label: "Browser names turned on",
    fix: "Turn on \"Let browsers choose a name\" in This browser." },
  { status: "origin-not-configured", label: "Public origin set",
    fix: "Enter the exact origin people open BB at, such as https://bb.example.com, and save it." },
  { status: "signing-key-unavailable", label: "Signing key available",
    fix: "Rotate the signing key in This browser." },
  { status: "cookie-bridge-unavailable", label: "Cookie bridge working",
    fix: "Re-run the self-test in Health; if it still fails, check that BB passes cookies through to plugins." },
  { status: "ready", label: "Ready", fix: "Nothing to do: browsers can choose a name." },
];

/** What stops browser names, as the end of a sentence ("Not ready: …", "unavailable: …"). */
export function pickerProblem(status: PickerStatus): string {
  switch (status) {
    case "off": return "browser names are turned off";
    case "origin-not-configured": return "no public origin is set";
    case "signing-key-unavailable": return "there is no signing key";
    case "cookie-bridge-unavailable": return "the cookie bridge is not working";
    case "ready": return "nothing";
  }
}

/** The picker chain as one line: open only when something needs fixing. */
export function pickerSummary(status: PickerStatus): { status: ReadinessStatus; text: string; open: boolean } {
  if (status === "ready") return { status: "ok", text: `Ready · ${PICKER_CHAIN.length - 1} checks passed`, open: false };
  if (status === "off") return { status: "off", text: "Off", open: false };
  return { status: "attention", text: `Not ready: ${pickerProblem(status)}`, open: true };
}
