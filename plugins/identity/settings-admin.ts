import { z } from "zod";
import { ENFORCEMENT_MODES, type EnforcementMode } from "./audit.js";
import { parseTeamMachines, personFromHostName, type HostClassification } from "./hosts.js";
import type { Person } from "./people.js";
import type { SelfTestResult } from "./request-context.js";

/**
 * The pure side of the Identity settings section: patch rules, config lint, the
 * readiness strip, enforce risks, diagnostics redaction and profile recommendations.
 * Browser-safe — the server and the settings UI both import it, so they agree.
 */

export const SETTINGS_TABS = ["people", "machines", "browser", "rules", "health"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const PICKER_STATUSES = ["off", "origin-not-configured", "signing-key-unavailable",
  "cookie-bridge-unavailable", "ready"] as const;
export type PickerStatus = (typeof PICKER_STATUSES)[number];
export type SigningKeyStatus = "valid" | "invalid" | "missing";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The one origin rule: https on any host, or http only on localhost / 127.0.0.1 / [::1];
 * the value must equal its own URL.origin exactly (no path, no trailing slash).
 */
export function validateSelectionOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname);
    return url.origin === value && (url.protocol === "https:" || localHttp) ? url.origin : null;
  } catch {
    return null;
  }
}

export const settingsPatchSchema = z.object({
  teamMachines: z.string().max(10_000).optional(),
  sharedMachineUser: z.string().max(64).optional(),
  enforcement: z.enum(ENFORCEMENT_MODES).optional(),
  fallbackEmail: z.string().max(320).optional(),
  selfSelectedIdentity: z.boolean().optional(),
  selectionPublicOrigin: z.string().max(2048).optional(),
  /** Required true to move INTO "enforce". */
  acknowledgeEnforce: z.boolean().optional(),
  /** Required true to set a NON-EMPTY fallbackEmail. */
  confirmSoleUser: z.boolean().optional(),
}).strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type WritableSettings = Required<Omit<SettingsPatch, "acknowledgeEnforce" | "confirmSoleUser">>;
export type PatchVerdict =
  | { ok: true; values: Partial<WritableSettings> }
  | { ok: false; reason: "empty-patch" | "enforce-needs-acknowledgement" | "fallback-needs-sole-user"
      | "fallback-not-an-email" | "origin-invalid" | "shared-user-invalid" };

/** A POSIX-ish account name: what `sharedMachineUser` is compared against. */
const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const emailSchema = z.email();

/**
 * Business rules for a settings write. Strips the two confirmation flags from `values`
 * and trims string values; clearing the origin (`""`) is allowed.
 */
export function checkSettingsPatch(patch: SettingsPatch, current: { enforcement: EnforcementMode }): PatchVerdict {
  const { acknowledgeEnforce, confirmSoleUser, ...rest } = patch;
  const values: Partial<WritableSettings> = {};
  for (const [key, value] of Object.entries(rest) as Array<[keyof WritableSettings, string | boolean | undefined]>) {
    if (value === undefined) continue;
    (values as Record<string, string | boolean>)[key] = typeof value === "string" ? value.trim() : value;
  }
  if (Object.keys(values).length === 0) return { ok: false, reason: "empty-patch" };

  if (values.enforcement === "enforce" && current.enforcement !== "enforce" && acknowledgeEnforce !== true) {
    return { ok: false, reason: "enforce-needs-acknowledgement" };
  }
  if (values.fallbackEmail !== undefined && values.fallbackEmail.length > 0) {
    if (!emailSchema.safeParse(values.fallbackEmail).success) return { ok: false, reason: "fallback-not-an-email" };
    if (confirmSoleUser !== true) return { ok: false, reason: "fallback-needs-sole-user" };
  }
  if (values.selectionPublicOrigin !== undefined && values.selectionPublicOrigin.length > 0
    && validateSelectionOrigin(values.selectionPublicOrigin) === null) {
    return { ok: false, reason: "origin-invalid" };
  }
  if (values.sharedMachineUser !== undefined && !ACCOUNT_NAME.test(values.sharedMachineUser)) {
    return { ok: false, reason: "shared-user-invalid" };
  }
  return { ok: true, values };
}

export function addTeamMachine(text: string, name: string): string {
  return parseTeamMachines([...parseTeamMachines(text), name].join("\n")).join("\n");
}

export function removeTeamMachine(text: string, name: string): string {
  const unwanted = name.trim().toLowerCase();
  return parseTeamMachines(text).filter((entry) => entry.toLowerCase() !== unwanted).join("\n");
}

export type LintSeverity = "error" | "warning" | "info";
export type LintIssue = { id: string; severity: LintSeverity; message: string; fix: string };
export type AdminFacts = {
  directoryError: string | null;
  people: readonly Person[];
  teamMachines: readonly string[];
  /** The classified host list. */
  machines: readonly HostClassification[];
  machinesUnavailable: string | null;
  enforcement: EnforcementMode;
  fallbackEmail: string;
  selfSelectedIdentity: boolean;
  /** The RAW stored value. */
  selectionPublicOrigin: string;
  signingKey: SigningKeyStatus;
  pickerStatus: PickerStatus;
  selfTest: SelfTestResult | null;
  accessSeen: boolean;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sharedEmails(people: readonly Person[]): Array<{ email: string; owners: Person[] }> {
  const owners = new Map<string, Person[]>();
  for (const person of people) {
    for (const email of new Set(person.emails.map((entry) => entry.toLowerCase()))) {
      owners.set(email, [...(owners.get(email) ?? []), person]);
    }
  }
  return [...owners].filter(([, list]) => list.length > 1).map(([email, list]) => ({ email, owners: list }));
}

export function lintConfig(facts: AdminFacts): LintIssue[] {
  const issues: LintIssue[] = [];
  const issue = (id: string, severity: LintSeverity, message: string, fix: string) =>
    issues.push({ id, severity, message, fix });

  if (facts.directoryError !== null) {
    issue("directory-invalid", "error", facts.directoryError, "Fix the directory in ew_bb_people and redeploy.");
  }
  for (const { email, owners } of sharedEmails(facts.people)) {
    issue("directory-duplicate-email", "warning",
      `${email} belongs to ${owners.map((owner) => owner.displayName).join(" and ")}.`,
      "Remove the duplicate email from ew_bb_people.");
  }
  if (facts.machinesUnavailable === null) {
    const known = new Set(facts.machines.map((machine) => machine.hostName.trim().toLowerCase()));
    for (const name of facts.teamMachines) {
      if (known.has(name.toLowerCase())) continue;
      issue("team-machine-missing", "warning", `Team machine ${name} is not in bb's host list.`,
        "Remove or correct it in the Machines tab.");
    }
  }
  for (const name of facts.teamMachines) {
    const named = personFromHostName(name, facts.people);
    if (named === null) continue;
    issue("team-machine-named-for-person", "warning",
      `Team machine ${name} is named for ${named.displayName}; it counts as team, not as theirs.`,
      "Check the team list in the Machines tab.");
  }
  if (facts.fallbackEmail.length > 0 && (facts.accessSeen || facts.people.length > 1)) {
    issue("fallback-on-shared", "warning",
      "A fallback email is set on a server that looks shared; requests with no Access email and no browser name "
        + "are attributed to it.",
      "Clear the fallback email in the This browser tab.");
  }
  if (facts.selfSelectedIdentity) {
    if (validateSelectionOrigin(facts.selectionPublicOrigin) === null) {
      issue("picker-origin", "error", "Browser names are on but the public origin is missing or invalid.",
        "Set the public origin in the This browser tab.");
    }
    if (facts.signingKey !== "valid") {
      issue("picker-signing-key", "error", `Browser names are on but the signing key is ${facts.signingKey}.`,
        "Rotate the signing key in the This browser tab.");
    }
    if (facts.pickerStatus === "cookie-bridge-unavailable") {
      issue("picker-cookie", "warning", "Browser names are on but the selection cookie does not reach the server.",
        "Re-run the self-test in the Health tab.");
    }
  }
  if (facts.selfTest?.ok === false) {
    issue("self-test-failed", "error", `The self-test failed: ${facts.selfTest.detail}`,
      "Re-run the self-test in the Health tab.");
  }
  if (facts.enforcement !== "off" && facts.teamMachines.length === 0) {
    issue("enforcement-no-team-machines", "warning",
      "No team machine is configured, so every automation would be refused.",
      "Add the team machine in the Machines tab.");
  }
  const conflicts = facts.machines.filter((machine) => machine.conflict !== null).length;
  if (conflicts > 0) {
    issue("pin-conflicts", "warning", `${plural(conflicts, "machine's name disagrees", "machines' names disagree")} with its pin.`,
      "Keep, re-pin or unpin them in the Machines tab.");
  }
  if (facts.machinesUnavailable !== null) {
    issue("machines-unavailable", "warning", `bb's host list is unavailable: ${facts.machinesUnavailable}`,
      "Check the bb server, then reload the Machines tab.");
  }
  const unclaimed = facts.machines.filter((machine) => machine.kind === "unclaimed").length;
  if (unclaimed > 0) {
    issue("unclaimed-machines", "info", `${plural(unclaimed, "machine belongs", "machines belong")} to nobody.`,
      "Name or add them to the team in the Machines tab.");
  }
  return issues;
}

export type ReadinessId = "profile" | "people" | "machines" | "browser" | "guardrail" | "check";
export type ReadinessStatus = "ok" | "attention" | "off" | "problem";
export type ReadinessItem = {
  id: ReadinessId;
  label: string;
  status: ReadinessStatus;
  text: string;
  tab: SettingsTab | "profile";
};

const PICKER_LABELS: Record<PickerStatus, string> = {
  "off": "Off",
  "origin-not-configured": "Origin not configured",
  "signing-key-unavailable": "Signing key unavailable",
  "cookie-bridge-unavailable": "Cookie bridge unavailable",
  "ready": "Ready",
};

export function readiness(facts: AdminFacts, lint: readonly LintIssue[]): ReadinessItem[] {
  const item = (id: ReadinessId, label: string, tab: ReadinessItem["tab"], [status, text]: [ReadinessStatus, string]) =>
    ({ id, label, status, text, tab });

  const profile: [ReadinessStatus, string] = facts.accessSeen ? ["ok", "Cloudflare Access"]
    : facts.fallbackEmail.length > 0 ? ["ok", "Only me"]
    : facts.selfSelectedIdentity ? ["ok", "Direct (browser names)"]
    : ["attention", "Not chosen"];

  const people: [ReadinessStatus, string] = facts.directoryError !== null ? ["problem", "Directory invalid"]
    : facts.people.length === 0 ? ["attention", "Nobody registered"]
    : ["ok", plural(facts.people.length, "person", "people")];

  const conflicts = facts.machines.filter((machine) => machine.conflict !== null).length;
  const machines: [ReadinessStatus, string] = facts.machinesUnavailable !== null ? ["problem", "List unavailable"]
    : conflicts > 0 ? ["attention", plural(conflicts, "conflict", "conflicts")]
    : !facts.machines.some((machine) => machine.kind === "team") ? ["attention", "No team machine"]
    : ["ok", plural(facts.machines.length, "machine", "machines")];

  const browser: [ReadinessStatus, string] = facts.pickerStatus === "off" ? ["off", "Off"]
    : facts.pickerStatus === "ready" ? ["ok", "Ready"]
    : ["problem", PICKER_LABELS[facts.pickerStatus]];

  const guardrail: [ReadinessStatus, string] = facts.enforcement === "off" ? ["off", "Off"]
    : facts.enforcement === "audit" ? ["ok", "Audit — logging only"]
    : facts.selfTest?.ok !== true ? ["problem", "Enforcing without a working self-test"]
    : ["ok", "Enforcing"];

  const errors = lint.filter((issue) => issue.severity === "error").length;
  const warnings = lint.filter((issue) => issue.severity === "warning").length;
  const check: [ReadinessStatus, string] = facts.selfTest === null ? ["attention", "Not run yet"]
    : errors > 0 ? ["problem", plural(errors, "problem", "problems")]
    : warnings > 0 ? ["attention", plural(warnings, "warning", "warnings")]
    : ["ok", "All checks pass"];

  return [
    item("profile", "Profile", "profile", profile),
    item("people", "People", "people", people),
    item("machines", "Machines", "machines", machines),
    item("browser", "Browser names", "browser", browser),
    item("guardrail", "Guardrail", "rules", guardrail),
    item("check", "Check", "health", check),
  ];
}

/** Sentences naming who/what Enforce would refuse, predictable from machine state alone. */
export function enforceRisks(facts: Pick<AdminFacts, "people" | "teamMachines" | "machines">): string[] {
  const risks: string[] = [];
  if (facts.teamMachines.length === 0) {
    risks.push("Every automation would be refused: no team machine is configured (rule C).");
  }
  // A team machine named for a person is no risk: teamMachines wins, so it is classified team.
  for (const machine of facts.machines) {
    if (machine.kind !== "person" || machine.conflict === null) continue;
    const derived = personFromHostName(machine.conflict.currentName, facts.people);
    const lead = `${machine.conflict.currentName} is pinned to ${machine.person.displayName}, but its name now says`;
    risks.push(derived === null
      ? `${lead} nobody.`
      : `${lead} ${derived.displayName}: ${derived.displayName} starting a thread there would be refused (rule A).`);
  }
  return risks;
}

export function redactEmail(email: string): string {
  if (email.length === 0) return "";
  const at = email.lastIndexOf("@");
  if (at < 0) return "***";
  return `${email.slice(0, Math.min(1, at))}***${email.slice(at)}`;
}

const EMBEDDED_EMAIL = /[^\s"'<>(),;:[\]]+@[^\s"'<>(),;:[\]]+/g;

/**
 * The directory error with every excerpt of the directory's own text removed. JSON.parse
 * and zod quote the offending source (`"Alex Rivera" is not valid JSON`, `Unrecognized
 * key: "…"`), so only the error's shape survives: its position, its path and the text of
 * the message before the first quote. The duplicate errors name schema-checked person ids
 * and an email, which is redacted.
 */
function diagnosticsDirectoryError(error: string): string {
  const syntax = /^directory is not valid JSON: /.exec(error);
  if (syntax !== null) {
    const at = /at position \d+(?: \(line \d+ column \d+\))?/.exec(error);
    return at === null ? "directory is not valid JSON" : `directory is not valid JSON ${at[0]}`;
  }
  const invalid = /^(directory is invalid(?: at \[[\w.]*\])?): (.*)$/s.exec(error);
  if (invalid !== null) {
    const message = invalid[2]!.split(/["'`]/)[0]!.replace(/[\s:,]+$/, "");
    return message.length === 0 ? invalid[1]! : `${invalid[1]}: ${message}`;
  }
  if (/^directory lists person "[a-z_][a-z0-9_-]*" twice$/.test(error)
    || /^directory email "[^"]*" belongs to both "[a-z_][a-z0-9_-]*" and "[a-z_][a-z0-9_-]*"$/.test(error)) {
    return error.replace(EMBEDDED_EMAIL, redactEmail);
  }
  return "directory is invalid";
}

export type LedgerFill = { starters: { count: number | null; max: number }; queued: { count: number | null; max: number } };
export type DiagnosticsInput = AdminFacts & {
  generatedAt: number;
  ledgers: LedgerFill;
  sharedMachineUser: string;
  lint: readonly LintIssue[];
};

/** A support bundle safe to paste anywhere: no clear email, no display name, no key. */
export function redactDiagnostics(input: DiagnosticsInput): string {
  const count = (kind: HostClassification["kind"]) => input.machines.filter((machine) => machine.kind === kind).length;
  return JSON.stringify({
    generatedAt: new Date(input.generatedAt).toISOString(),
    plugin: "identity",
    schema: 1,
    // A failed probe quotes the email it saw, so the free-text details are redacted too.
    selfTest: input.selfTest === null ? null : {
      ...input.selfTest,
      detail: input.selfTest.detail.replace(EMBEDDED_EMAIL, redactEmail),
      cookie: { ...input.selfTest.cookie, detail: input.selfTest.cookie.detail.replace(EMBEDDED_EMAIL, redactEmail) },
    },
    picker: {
      status: input.pickerStatus,
      enabled: input.selfSelectedIdentity,
      origin: input.selectionPublicOrigin,
      signingKey: input.signingKey,
    },
    enforcement: input.enforcement,
    sharedMachineUser: input.sharedMachineUser,
    fallbackEmail: redactEmail(input.fallbackEmail),
    accessSeen: input.accessSeen,
    directory: {
      ok: input.directoryError === null,
      error: input.directoryError === null ? null : diagnosticsDirectoryError(input.directoryError),
      people: input.people.length,
      emails: input.people.reduce((total, person) => total + person.emails.length, 0),
    },
    teamMachines: input.teamMachines,
    machines: {
      total: input.machines.length,
      person: count("person"),
      team: count("team"),
      unclaimed: count("unclaimed"),
      conflicts: input.machines.filter((machine) => machine.conflict !== null).length,
      unavailable: input.machinesUnavailable,
    },
    ledgers: input.ledgers,
    lint: input.lint.map(({ id, severity }) => ({ id, severity })),
  }, null, 2);
}

export const AUDIT_JQ_COMMAND =
  "bb plugin logs identity | sed -n 's/.*identity-audit //p' | jq -c 'select(.kind == \"dispatch\" and .verdict == \"reject\") | {at, mode, rule, person, host: .host.name, action}'";

export const SERVER_PROFILES = ["access", "direct", "solo"] as const;
export type ServerProfile = (typeof SERVER_PROFILES)[number];
export type ProfileChange = { setting: keyof WritableSettings; label: string; now: string; recommended: string };
export type ProfileRecommendation = { changes: ProfileChange[]; patch: SettingsPatch; notes: string[] };

const SETTING_LABELS: Record<keyof WritableSettings, string> = {
  teamMachines: "Team machines",
  sharedMachineUser: "Shared machine user",
  enforcement: "Guardrail",
  fallbackEmail: "Fallback email",
  selfSelectedIdentity: "Browser names",
  selectionPublicOrigin: "Public origin",
};

/**
 * Who a fallback email covers, in the fixed precedence: only requests with neither an
 * Access email nor a browser name. A stale, expired or invalid browser name is anonymous
 * and never falls through to the fallback.
 */
export function fallbackReach(target: string): string {
  return `Requests with no Access email and no browser name, agents included, will be attributed to ${target}. `
    + "While browser names are on, a browser presenting a stale, expired or invalid name stays anonymous — "
    + "the fallback never covers it.";
}

export function profileRecommendation(
  profile: ServerProfile,
  current: WritableSettings,
  context: { myEmail: string | null; browserOrigin: string | null },
): ProfileRecommendation {
  let patch: SettingsPatch;
  const notes: string[] = [];
  if (profile === "access") {
    patch = {
      selfSelectedIdentity: false,
      fallbackEmail: "",
      enforcement: current.enforcement === "off" ? "audit" : current.enforcement,
    };
    notes.push("Access supplies identities; start in audit and read the log before enforcing.");
  } else if (profile === "direct") {
    patch = { selfSelectedIdentity: true, fallbackEmail: "", enforcement: "off" };
    if (validateSelectionOrigin(current.selectionPublicOrigin) === null) {
      const origin = context.browserOrigin === null ? null : validateSelectionOrigin(context.browserOrigin);
      if (origin !== null) patch.selectionPublicOrigin = origin;
      else notes.push("Set the public origin in This browser");
    }
    notes.push("Without Access nobody can be refused — browser names are labels only.");
  } else {
    patch = { fallbackEmail: context.myEmail ?? "", selfSelectedIdentity: false, enforcement: "off", confirmSoleUser: true };
    notes.push(fallbackReach("this email"));
  }
  const changes: ProfileChange[] = [];
  for (const [setting, value] of Object.entries(patch) as Array<[string, string | boolean]>) {
    if (!(setting in SETTING_LABELS)) continue;
    const key = setting as keyof WritableSettings;
    if (current[key] === value) continue;
    changes.push({ setting: key, label: SETTING_LABELS[key], now: String(current[key]), recommended: String(value) });
  }
  return { changes, patch, notes };
}
