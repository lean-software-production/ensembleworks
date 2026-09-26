import { describe, expect, it } from "vitest";
import {
  AUDIT_JQ_COMMAND,
  PICKER_STATUSES,
  SERVER_PROFILES,
  SETTINGS_TABS,
  addTeamMachine,
  checkSettingsPatch,
  enforceRisks,
  lintConfig,
  profileRecommendation,
  readiness,
  redactDiagnostics,
  redactEmail,
  removeTeamMachine,
  settingsPatchSchema,
  validateSelectionOrigin,
  type AdminFacts,
  type LintIssue,
  type WritableSettings,
} from "./settings-admin.js";
import type { HostClassification } from "./hosts.js";
import { parseDirectory, type Person } from "./people.js";

const alex: Person = { person: "alex", github: "alexgh", displayName: "Alex Rivera", emails: ["alex@example.com"] };
const sam: Person = { person: "sam", github: "samgh", displayName: "Sam Chen", emails: ["sam@example.org", "sam.chen@example.net"] };
const SIGNING_KEY = "k3y-that-must-never-leak-aaaaaaaaaaaaaaaaaaaaaa";

const summary = (person: Person) => ({ person: person.person, displayName: person.displayName, github: person.github });
const teamBox: HostClassification = { kind: "team", hostId: "h1", hostName: "ew-lsp-001-main", conflict: null };
const alexBox: HostClassification = { kind: "person", hostId: "h2", hostName: "ew-lsp-001-alex", person: summary(alex), conflict: null };
const samBox: HostClassification = { kind: "person", hostId: "h3", hostName: "ew-lap-002-sam", person: summary(sam), conflict: null };
const scratch: HostClassification = { kind: "unclaimed", hostId: "h4", hostName: "ew-scratch-009", conflict: null };
/** Pinned to Alex, since renamed for Sam. */
const renamed: HostClassification = {
  kind: "person", hostId: "h5", hostName: "ew-lsp-003-sam", person: summary(alex),
  conflict: { pinnedName: "ew-lsp-003-alex", pinnedPerson: "alex", currentName: "ew-lsp-003-sam" },
};

function healthy(overrides: Partial<AdminFacts> = {}): AdminFacts {
  return {
    directoryError: null,
    people: [alex, sam],
    teamMachines: ["ew-lsp-001-main"],
    machines: [teamBox, alexBox, samBox],
    machinesUnavailable: null,
    enforcement: "audit",
    fallbackEmail: "",
    selfSelectedIdentity: false,
    selectionPublicOrigin: "",
    signingKey: "valid",
    pickerStatus: "off",
    selfTest: { ok: true, detail: "request context is live", cookie: { ok: true, detail: "named cookie reached request context" } },
    accessSeen: true,
    ...overrides,
  };
}

const ids = (issues: readonly LintIssue[]) => issues.map((issue) => issue.id);

describe("constants", () => {
  it("names the five tabs, the picker statuses and the three profiles", () => {
    expect(SETTINGS_TABS).toEqual(["people", "machines", "browser", "rules", "health"]);
    expect(PICKER_STATUSES).toEqual(["off", "origin-not-configured", "signing-key-unavailable", "cookie-bridge-unavailable", "ready"]);
    expect(SERVER_PROFILES).toEqual(["access", "direct", "solo"]);
  });

  it("ships the exact jq command for would-refuse lines", () => {
    expect(AUDIT_JQ_COMMAND).toBe(
      "bb plugin logs identity | sed -n 's/.*identity-audit //p' | jq -c 'select(.kind == \"dispatch\" and .verdict == \"reject\") | {at, mode, rule, person, host: .host.name, action}'",
    );
  });
});

describe("validateSelectionOrigin", () => {
  it.each([
    ["https://bb.example.com", "https://bb.example.com"],
    ["https://bb.example.com:8443", "https://bb.example.com:8443"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("accepts %s", (value, expected) => {
    expect(validateSelectionOrigin(value)).toBe(expected);
  });

  it.each([
    "http://bb.example.com",
    "https://bb.example.com/",
    "https://bb.example.com/path",
    "https://bb.example.com?x=1",
    "HTTPS://bb.example.com",
    "not a url",
    "",
    "ftp://bb.example.com",
  ])("refuses %j", (value) => {
    expect(validateSelectionOrigin(value)).toBeNull();
  });
});

describe("settingsPatchSchema", () => {
  it("refuses keys it does not own, so nothing can write the directory or the signing key", () => {
    expect(settingsPatchSchema.safeParse({ directory: "[]" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ selectionSigningKey: "x" }).success).toBe(false);
  });

  it("bounds every string", () => {
    expect(settingsPatchSchema.safeParse({ teamMachines: "a".repeat(10_001) }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ sharedMachineUser: "a".repeat(65) }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ fallbackEmail: "a".repeat(321) }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ selectionPublicOrigin: "a".repeat(2049) }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ enforcement: "loud" }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ teamMachines: "a", enforcement: "audit" }).success).toBe(true);
  });
});

describe("checkSettingsPatch", () => {
  const off = { enforcement: "off" as const };

  it("refuses an empty patch, and one carrying only confirmations", () => {
    expect(checkSettingsPatch({}, off)).toEqual({ ok: false, reason: "empty-patch" });
    expect(checkSettingsPatch({ acknowledgeEnforce: true, confirmSoleUser: true }, off))
      .toEqual({ ok: false, reason: "empty-patch" });
  });

  it("needs an acknowledgement to move into enforce, and only into it", () => {
    expect(checkSettingsPatch({ enforcement: "enforce" }, off)).toEqual({ ok: false, reason: "enforce-needs-acknowledgement" });
    expect(checkSettingsPatch({ enforcement: "enforce", acknowledgeEnforce: false }, { enforcement: "audit" }))
      .toEqual({ ok: false, reason: "enforce-needs-acknowledgement" });
    expect(checkSettingsPatch({ enforcement: "enforce", acknowledgeEnforce: true }, off))
      .toEqual({ ok: true, values: { enforcement: "enforce" } });
    expect(checkSettingsPatch({ enforcement: "enforce" }, { enforcement: "enforce" }))
      .toEqual({ ok: true, values: { enforcement: "enforce" } });
    expect(checkSettingsPatch({ enforcement: "audit" }, { enforcement: "enforce" }))
      .toEqual({ ok: true, values: { enforcement: "audit" } });
  });

  it("needs the sole-user confirmation for a non-empty fallback email, and a real email", () => {
    expect(checkSettingsPatch({ fallbackEmail: "me@example.com" }, off)).toEqual({ ok: false, reason: "fallback-needs-sole-user" });
    expect(checkSettingsPatch({ fallbackEmail: "not-an-email", confirmSoleUser: true }, off))
      .toEqual({ ok: false, reason: "fallback-not-an-email" });
    expect(checkSettingsPatch({ fallbackEmail: " me@example.com ", confirmSoleUser: true }, off))
      .toEqual({ ok: true, values: { fallbackEmail: "me@example.com" } });
  });

  it("lets anyone clear the fallback email without a confirmation", () => {
    expect(checkSettingsPatch({ fallbackEmail: "  " }, off)).toEqual({ ok: true, values: { fallbackEmail: "" } });
  });

  it("checks the public origin with the one origin rule, and allows clearing it", () => {
    expect(checkSettingsPatch({ selectionPublicOrigin: "https://bb.example.com/" }, off))
      .toEqual({ ok: false, reason: "origin-invalid" });
    expect(checkSettingsPatch({ selectionPublicOrigin: " https://bb.example.com " }, off))
      .toEqual({ ok: true, values: { selectionPublicOrigin: "https://bb.example.com" } });
    expect(checkSettingsPatch({ selectionPublicOrigin: "" }, off)).toEqual({ ok: true, values: { selectionPublicOrigin: "" } });
  });

  it("refuses a shared machine user that is not an account name", () => {
    for (const bad of ["", "   ", "has space", "semi;colon", "-leading"]) {
      expect(checkSettingsPatch({ sharedMachineUser: bad }, off)).toEqual({ ok: false, reason: "shared-user-invalid" });
    }
    expect(checkSettingsPatch({ sharedMachineUser: " ensembleworks-agent " }, off))
      .toEqual({ ok: true, values: { sharedMachineUser: "ensembleworks-agent" } });
  });

  it("strips the confirmation flags and trims team machines", () => {
    expect(checkSettingsPatch({ teamMachines: " a\nb ", selfSelectedIdentity: true, confirmSoleUser: true }, off))
      .toEqual({ ok: true, values: { teamMachines: "a\nb", selfSelectedIdentity: true } });
  });
});

describe("team machine list edits", () => {
  it("adds a name once, case-insensitively, keeping order", () => {
    expect(addTeamMachine("ew-a\new-b", "ew-c")).toBe("ew-a\new-b\new-c");
    expect(addTeamMachine("ew-a\new-b", "EW-A")).toBe("ew-a\new-b");
    expect(addTeamMachine("", "  ew-a  ")).toBe("ew-a");
    expect(addTeamMachine("ew-a", "  ")).toBe("ew-a");
  });

  it("normalises a JSON array or comma list to one name per line", () => {
    expect(addTeamMachine('["ew-a", "ew-b", "EW-B"]', "ew-c")).toBe("ew-a\new-b\new-c");
    expect(addTeamMachine("ew-a, ew-b", "ew-c")).toBe("ew-a\new-b\new-c");
  });

  it("removes a name case-insensitively, keeping the rest in order", () => {
    expect(removeTeamMachine("ew-a\new-b\new-c", "EW-B")).toBe("ew-a\new-c");
    expect(removeTeamMachine('["ew-a","ew-b"]', "ew-a")).toBe("ew-b");
    expect(removeTeamMachine("ew-a", "ew-z")).toBe("ew-a");
    expect(removeTeamMachine("ew-a", "ew-a")).toBe("");
  });
});

describe("lintConfig", () => {
  it("finds nothing wrong with a healthy server", () => {
    expect(lintConfig(healthy())).toEqual([]);
  });

  it("gives every issue a message and a fix", () => {
    const issues = lintConfig(healthy({
      directoryError: "directory is not valid JSON", machines: [renamed, scratch], teamMachines: ["ew-gone"],
      fallbackEmail: "me@example.com", selfSelectedIdentity: true, pickerStatus: "cookie-bridge-unavailable",
      signingKey: "missing", selfTest: { ok: false, detail: "probe failed", cookie: { ok: false, detail: "x" } },
    }));
    expect(issues.length).toBeGreaterThan(5);
    for (const issue of issues) {
      expect(issue.message.length).toBeGreaterThan(0);
      expect(issue.fix).toMatch(/(tab|ew_bb_people)/);
    }
  });

  it("directory-invalid", () => {
    expect(lintConfig(healthy({ directoryError: "directory is not valid JSON", people: [] })))
      .toContainEqual(expect.objectContaining({ id: "directory-invalid", severity: "error" }));
    expect(ids(lintConfig(healthy()))).not.toContain("directory-invalid");
  });

  it("directory-duplicate-email names both people, once per shared email", () => {
    const twin: Person = { ...sam, person: "twin", displayName: "Twin", emails: ["ALEX@example.com"] };
    const issues = lintConfig(healthy({ people: [alex, sam, twin] })).filter((issue) => issue.id === "directory-duplicate-email");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain("Alex Rivera");
    expect(issues[0]!.message).toContain("Twin");
  });

  it("team-machine-missing, unless the list could not be read", () => {
    const missing = lintConfig(healthy({ teamMachines: ["ew-lsp-001-main", "ew-gone"] }));
    expect(missing).toContainEqual(expect.objectContaining({ id: "team-machine-missing", severity: "warning" }));
    expect(missing.find((issue) => issue.id === "team-machine-missing")!.message).toContain("ew-gone");
    expect(ids(lintConfig(healthy({ teamMachines: ["ew-gone"], machines: [], machinesUnavailable: "down" }))))
      .not.toContain("team-machine-missing");
  });

  it("team-machine-named-for-person", () => {
    const issues = lintConfig(healthy({ teamMachines: ["ew-lsp-001-main", "ew-lap-002-sam"] }));
    expect(issues).toContainEqual(expect.objectContaining({ id: "team-machine-named-for-person", severity: "warning" }));
    expect(ids(lintConfig(healthy()))).not.toContain("team-machine-named-for-person");
  });

  it("fallback-on-shared when Access has been seen or more than one person is registered", () => {
    expect(ids(lintConfig(healthy({ fallbackEmail: "me@example.com" })))).toContain("fallback-on-shared");
    expect(ids(lintConfig(healthy({ fallbackEmail: "me@example.com", accessSeen: false })))).toContain("fallback-on-shared");
    expect(ids(lintConfig(healthy({ fallbackEmail: "me@example.com", accessSeen: false, people: [alex] }))))
      .not.toContain("fallback-on-shared");
    expect(ids(lintConfig(healthy()))).not.toContain("fallback-on-shared");
  });

  it("picker-origin, only while the picker is on", () => {
    const on = { selfSelectedIdentity: true, pickerStatus: "origin-not-configured" as const };
    expect(lintConfig(healthy({ ...on, selectionPublicOrigin: "" })))
      .toContainEqual(expect.objectContaining({ id: "picker-origin", severity: "error" }));
    expect(ids(lintConfig(healthy({ ...on, selectionPublicOrigin: "https://bb.example.com/" })))).toContain("picker-origin");
    expect(ids(lintConfig(healthy({ ...on, selectionPublicOrigin: "https://bb.example.com" })))).not.toContain("picker-origin");
    expect(ids(lintConfig(healthy({ selectionPublicOrigin: "" })))).not.toContain("picker-origin");
  });

  it("picker-signing-key, only while the picker is on", () => {
    const on = { selfSelectedIdentity: true, selectionPublicOrigin: "https://bb.example.com" };
    expect(lintConfig(healthy({ ...on, signingKey: "invalid" })))
      .toContainEqual(expect.objectContaining({ id: "picker-signing-key", severity: "error" }));
    expect(ids(lintConfig(healthy({ ...on, signingKey: "missing" })))).toContain("picker-signing-key");
    expect(ids(lintConfig(healthy({ ...on, signingKey: "valid" })))).not.toContain("picker-signing-key");
    expect(ids(lintConfig(healthy({ signingKey: "missing" })))).not.toContain("picker-signing-key");
  });

  it("picker-cookie", () => {
    const on = { selfSelectedIdentity: true, selectionPublicOrigin: "https://bb.example.com" };
    expect(lintConfig(healthy({ ...on, pickerStatus: "cookie-bridge-unavailable" })))
      .toContainEqual(expect.objectContaining({ id: "picker-cookie", severity: "warning" }));
    expect(ids(lintConfig(healthy({ ...on, pickerStatus: "ready" })))).not.toContain("picker-cookie");
  });

  it("self-test-failed, but not when it has not run", () => {
    expect(lintConfig(healthy({ selfTest: { ok: false, detail: "probe failed", cookie: { ok: false, detail: "x" } } })))
      .toContainEqual(expect.objectContaining({ id: "self-test-failed", severity: "error" }));
    expect(ids(lintConfig(healthy({ selfTest: null })))).not.toContain("self-test-failed");
  });

  it("enforcement-no-team-machines", () => {
    const issue = lintConfig(healthy({ teamMachines: [] })).find((entry) => entry.id === "enforcement-no-team-machines");
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("every automation would be refused");
    expect(ids(lintConfig(healthy({ teamMachines: [], enforcement: "off" })))).not.toContain("enforcement-no-team-machines");
  });

  it("pin-conflicts", () => {
    expect(lintConfig(healthy({ machines: [teamBox, renamed] })))
      .toContainEqual(expect.objectContaining({ id: "pin-conflicts", severity: "warning" }));
    expect(ids(lintConfig(healthy()))).not.toContain("pin-conflicts");
  });

  it("machines-unavailable", () => {
    expect(lintConfig(healthy({ machines: [], machinesUnavailable: "bb answered 500" })))
      .toContainEqual(expect.objectContaining({ id: "machines-unavailable", severity: "warning" }));
    expect(ids(lintConfig(healthy()))).not.toContain("machines-unavailable");
  });

  it("unclaimed-machines", () => {
    expect(lintConfig(healthy({ machines: [teamBox, scratch] })))
      .toContainEqual(expect.objectContaining({ id: "unclaimed-machines", severity: "info" }));
    expect(ids(lintConfig(healthy()))).not.toContain("unclaimed-machines");
  });
});

describe("readiness", () => {
  it("reads six items, in order, for a healthy server", () => {
    const facts = healthy();
    expect(readiness(facts, lintConfig(facts))).toEqual([
      { id: "profile", label: "Profile", status: "ok", text: "Cloudflare Access", tab: "profile" },
      { id: "people", label: "People", status: "ok", text: "2 people", tab: "people" },
      { id: "machines", label: "Machines", status: "ok", text: "3 machines", tab: "machines" },
      { id: "browser", label: "Browser names", status: "off", text: "Off", tab: "browser" },
      { id: "guardrail", label: "Guardrail", status: "ok", text: "Audit — logging only", tab: "rules" },
      { id: "check", label: "Check", status: "ok", text: "All checks pass", tab: "health" },
    ]);
  });

  it("reads six items, in order, for a broken server", () => {
    const facts = healthy({
      directoryError: "directory is not valid JSON", people: [], teamMachines: [], machines: [],
      machinesUnavailable: "bb answered 500", enforcement: "enforce", accessSeen: false,
      selfSelectedIdentity: true, pickerStatus: "origin-not-configured",
      selfTest: { ok: false, detail: "probe failed", cookie: { ok: false, detail: "x" } },
    });
    const lint = lintConfig(facts);
    const errors = lint.filter((issue) => issue.severity === "error").length;
    expect(readiness(facts, lint)).toEqual([
      { id: "profile", label: "Profile", status: "ok", text: "Direct (browser names)", tab: "profile" },
      { id: "people", label: "People", status: "problem", text: "Directory invalid", tab: "people" },
      { id: "machines", label: "Machines", status: "problem", text: "List unavailable", tab: "machines" },
      { id: "browser", label: "Browser names", status: "problem", text: "Origin not configured", tab: "browser" },
      { id: "guardrail", label: "Guardrail", status: "problem", text: "Enforcing without a working self-test", tab: "rules" },
      { id: "check", label: "Check", status: "problem", text: `${errors} problems`, tab: "health" },
    ]);
  });

  it("profile: fallback means only me, nothing means not chosen", () => {
    expect(readiness(healthy({ accessSeen: false, fallbackEmail: "me@example.com" }), [])[0])
      .toMatchObject({ status: "ok", text: "Only me" });
    expect(readiness(healthy({ accessSeen: false }), [])[0]).toMatchObject({ status: "attention", text: "Not chosen" });
  });

  it("people: nobody registered", () => {
    expect(readiness(healthy({ people: [] }), [])[1]).toMatchObject({ status: "attention", text: "Nobody registered" });
    expect(readiness(healthy({ people: [alex] }), [])[1]).toMatchObject({ status: "ok", text: "1 person" });
  });

  it("machines: conflicts, then no team machine", () => {
    expect(readiness(healthy({ machines: [teamBox, renamed] }), [])[2]).toMatchObject({ status: "attention", text: "1 conflict" });
    expect(readiness(healthy({ machines: [alexBox, samBox] }), [])[2]).toMatchObject({ status: "attention", text: "No team machine" });
  });

  it("browser: ready, and each problem by its human label", () => {
    const on = { selfSelectedIdentity: true };
    expect(readiness(healthy({ ...on, pickerStatus: "ready" }), [])[3]).toMatchObject({ status: "ok", text: "Ready" });
    expect(readiness(healthy({ ...on, pickerStatus: "signing-key-unavailable" }), [])[3])
      .toMatchObject({ status: "problem", text: "Signing key unavailable" });
    expect(readiness(healthy({ ...on, pickerStatus: "cookie-bridge-unavailable" }), [])[3])
      .toMatchObject({ status: "problem", text: "Cookie bridge unavailable" });
  });

  it("guardrail: off, and enforcing with a passing self-test", () => {
    expect(readiness(healthy({ enforcement: "off" }), [])[4]).toMatchObject({ status: "off", text: "Off" });
    expect(readiness(healthy({ enforcement: "enforce" }), [])[4]).toMatchObject({ status: "ok", text: "Enforcing" });
    expect(readiness(healthy({ enforcement: "enforce", selfTest: null }), [])[4])
      .toMatchObject({ status: "problem", text: "Enforcing without a working self-test" });
  });

  it("check: not run yet, then warnings", () => {
    expect(readiness(healthy({ selfTest: null }), [])[5]).toMatchObject({ status: "attention", text: "Not run yet" });
    const warning: LintIssue = { id: "pin-conflicts", severity: "warning", message: "m", fix: "f" };
    const info: LintIssue = { id: "unclaimed-machines", severity: "info", message: "m", fix: "f" };
    expect(readiness(healthy(), [warning, info])[5]).toMatchObject({ status: "attention", text: "1 warning" });
    expect(readiness(healthy(), [info])[5]).toMatchObject({ status: "ok", text: "All checks pass" });
  });
});

describe("enforceRisks", () => {
  it("is empty when nothing is predictable", () => {
    expect(enforceRisks(healthy())).toEqual([]);
  });

  it("(a) every automation would be refused without a team machine", () => {
    expect(enforceRisks(healthy({ teamMachines: [] }))).toEqual([
      "Every automation would be refused: no team machine is configured (rule C).",
    ]);
  });

  it("(b) names who would be refused on a renamed machine", () => {
    expect(enforceRisks(healthy({ machines: [teamBox, renamed] }))).toEqual([
      "ew-lsp-003-sam is pinned to Alex Rivera, but its name now says Sam Chen: Sam Chen starting a thread there would be refused (rule A).",
    ]);
  });

  it("(b) drops the second clause when the new name says nobody", () => {
    const nobody: HostClassification = { ...renamed, hostName: "ew-lsp-003-x",
      conflict: { pinnedName: "ew-lsp-003-alex", pinnedPerson: "alex", currentName: "ew-lsp-003-x" } };
    expect(enforceRisks(healthy({ machines: [teamBox, nobody] }))).toEqual([
      "ew-lsp-003-x is pinned to Alex Rivera, but its name now says nobody.",
    ]);
  });

  it("(c) a team machine named for a person is no risk", () => {
    expect(enforceRisks(healthy({ teamMachines: ["ew-lsp-001-main", "ew-lap-002-sam"] }))).toEqual([]);
  });
});

describe("redactEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(redactEmail("alex@example.com")).toBe("a***@example.com");
    expect(redactEmail("no-at-sign")).toBe("***");
    expect(redactEmail("")).toBe("");
  });
});

describe("redactDiagnostics", () => {
  const facts = healthy({
    fallbackEmail: "alex@example.com",
    machines: [teamBox, alexBox, samBox, scratch, renamed],
    selfSelectedIdentity: true,
    selectionPublicOrigin: "https://bb.example.com",
    pickerStatus: "ready",
  });
  const text = redactDiagnostics({
    ...facts,
    generatedAt: Date.UTC(2026, 8, 26, 12, 0, 0),
    ledgers: { starters: { count: 12, max: 2000 }, queued: { count: null, max: 1000 } },
    sharedMachineUser: "ensembleworks-agent",
    lint: lintConfig(facts),
  });

  it("is pretty JSON with its keys in the documented order", () => {
    expect(text).toContain('\n  "plugin": "identity"');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "generatedAt", "plugin", "schema", "selfTest", "picker", "enforcement", "sharedMachineUser",
      "fallbackEmail", "accessSeen", "directory", "teamMachines", "machines", "ledgers", "lint",
    ]);
    expect(parsed).toMatchObject({
      generatedAt: "2026-09-26T12:00:00.000Z",
      plugin: "identity",
      schema: 1,
      picker: { status: "ready", enabled: true, origin: "https://bb.example.com", signingKey: "valid" },
      enforcement: "audit",
      fallbackEmail: "a***@example.com",
      accessSeen: true,
      directory: { ok: true, error: null, people: 2, emails: 3 },
      teamMachines: ["ew-lsp-001-main"],
      machines: { total: 5, person: 3, team: 1, unclaimed: 1, conflicts: 1, unavailable: null },
      ledgers: { starters: { count: 12, max: 2000 }, queued: { count: null, max: 1000 } },
    });
    for (const issue of (parsed.lint as Array<Record<string, unknown>>)) {
      expect(Object.keys(issue)).toEqual(["id", "severity"]);
    }
  });

  it("leaks no email, no display name and no signing key", () => {
    for (const person of [alex, sam]) {
      for (const email of person.emails) expect(text).not.toContain(email);
      expect(text).not.toContain(person.displayName);
    }
    expect(text).not.toContain(SIGNING_KEY);
    expect(text).not.toContain("alex@example.com");
  });

  it("redacts emails quoted inside the directory error", () => {
    const broken = healthy({ directoryError: 'directory email "sam@example.org" belongs to both "sam" and "twin"', people: [] });
    const out = redactDiagnostics({
      ...broken, generatedAt: 0, sharedMachineUser: "u", lint: lintConfig(broken),
      ledgers: { starters: { count: 0, max: 2000 }, queued: { count: 0, max: 1000 } },
    });
    expect(out).not.toContain("sam@example.org");
    expect(JSON.parse(out).directory).toEqual({
      ok: false, error: 'directory email "s***@example.org" belongs to both "sam" and "twin"', people: 0, emails: 0,
    });
  });

  it("keeps no parser excerpt of a malformed directory", () => {
    const leaks = ["Alex Rivera", "Rivera", "arivera", "alex@example.com", "Secret Key"];
    const cases: Array<[string, string]> = [
      ["Alex Rivera", "directory is not valid JSON"],
      ['[{"displayName":"Alex Rivera" alex@example.com}]', "directory is not valid JSON at position 30 (line 1 column 31)"],
      ['[{"displayName":"Alex Rivera"', "directory is not valid JSON at position 29 (line 1 column 30)"],
      [JSON.stringify([{ person: "alex", github: "arivera", displayName: "Alex Rivera", emails: ["alex@example.com"], "Secret Key": 1 }]),
        "directory is invalid at [0]: Unrecognized key"],
      [JSON.stringify([{ person: "Alex Rivera", github: "arivera", displayName: "Alex Rivera", emails: ["alex@example.com"] }]),
        "directory is invalid at [0.person]: person must match ^[a-z_][a-z0-9_-]*$"],
    ];
    for (const [directory, expected] of cases) {
      const parsed = parseDirectory(directory);
      if (parsed.ok) throw new Error(`expected ${directory} to be rejected`);
      const broken = healthy({ directoryError: parsed.error, people: [] });
      const out = redactDiagnostics({
        ...broken, generatedAt: 0, sharedMachineUser: "u", lint: lintConfig(broken),
        ledgers: { starters: { count: 0, max: 2000 }, queued: { count: 0, max: 1000 } },
      });
      for (const leak of leaks) expect(out).not.toContain(leak);
      expect(JSON.parse(out).directory.error).toBe(expected);
    }
  });

  it("emits only a validated picker origin, never a raw invalid value", () => {
    const origins: Array<[string, string]> = [
      ["https://alex@example.com", "invalid"],
      ["https://Alex Rivera@bb.example.com", "invalid"],
      ["https://bb.example.com/Alex%20Rivera?alex@example.com", "invalid"],
      ["", ""],
    ];
    for (const [origin, expected] of origins) {
      const stored = healthy({ selfSelectedIdentity: true, selectionPublicOrigin: origin });
      const out = redactDiagnostics({
        ...stored, generatedAt: 0, sharedMachineUser: "u", lint: lintConfig(stored),
        ledgers: { starters: { count: 0, max: 2000 }, queued: { count: 0, max: 1000 } },
      });
      for (const leak of ["alex@example.com", "Alex Rivera", "Alex%20Rivera"]) expect(out).not.toContain(leak);
      expect(JSON.parse(out).picker.origin).toBe(expected);
    }
  });

  it("redacts an email the self-test probe saw unexpectedly", () => {
    const failed = healthy({ selfTest: {
      ok: false, detail: `the probe's request context had email ${JSON.stringify("alex@example.com")}`,
      cookie: { ok: false, detail: "cookie probe failed: alex@example.com" },
    } });
    const out = redactDiagnostics({
      ...failed, generatedAt: 0, sharedMachineUser: "u", lint: lintConfig(failed),
      ledgers: { starters: { count: 0, max: 2000 }, queued: { count: 0, max: 1000 } },
    });
    expect(out).not.toContain("alex@example.com");
    expect(JSON.parse(out).selfTest).toEqual({
      ok: false, detail: 'the probe\'s request context had email "a***@example.com"',
      cookie: { ok: false, detail: "cookie probe failed: a***@example.com" },
    });
  });
});

describe("profileRecommendation", () => {
  const defaults: WritableSettings = {
    teamMachines: "", sharedMachineUser: "ensembleworks-agent", enforcement: "off", fallbackEmail: "",
    selfSelectedIdentity: false, selectionPublicOrigin: "",
  };

  it("access: audit first, no picker, no fallback", () => {
    const recommended = profileRecommendation("access", { ...defaults, selfSelectedIdentity: true }, { myEmail: null, browserOrigin: null });
    expect(recommended.patch).toEqual({ selfSelectedIdentity: false, fallbackEmail: "", enforcement: "audit" });
    expect(recommended.changes.map((change) => change.setting)).toEqual(["selfSelectedIdentity", "enforcement"]);
    expect(recommended.notes).toContain("Access supplies identities; start in audit and read the log before enforcing.");
  });

  it("access: keeps an enforcement mode already chosen", () => {
    expect(profileRecommendation("access", { ...defaults, enforcement: "enforce" }, { myEmail: null, browserOrigin: null }).patch)
      .toEqual({ selfSelectedIdentity: false, fallbackEmail: "", enforcement: "enforce" });
  });

  it("direct: turns the picker on and borrows this browser's origin when the stored one is invalid", () => {
    const recommended = profileRecommendation("direct", defaults, { myEmail: null, browserOrigin: "https://bb.example.com" });
    expect(recommended.patch).toEqual({ selfSelectedIdentity: true, fallbackEmail: "", enforcement: "off",
      selectionPublicOrigin: "https://bb.example.com" });
    expect(recommended.changes.map((change) => change.setting)).toEqual(["selfSelectedIdentity", "selectionPublicOrigin"]);
    expect(recommended.notes).toContain("Without Access nobody can be refused — browser names are labels only.");
    expect(recommended.notes).not.toContain("Set the public origin in This browser");
  });

  it("direct: asks for the origin when this browser's is unusable, and keeps a valid one", () => {
    const unusable = profileRecommendation("direct", defaults, { myEmail: null, browserOrigin: "http://bb.example.com" });
    expect(unusable.patch).not.toHaveProperty("selectionPublicOrigin");
    expect(unusable.notes).toContain("Set the public origin in This browser");
    const kept = profileRecommendation("direct", { ...defaults, selectionPublicOrigin: "https://kept.example.com" },
      { myEmail: null, browserOrigin: "https://bb.example.com" });
    expect(kept.patch).not.toHaveProperty("selectionPublicOrigin");
    expect(kept.notes).not.toContain("Set the public origin in This browser");
  });

  it("solo: my email as the fallback, confirmed as sole user", () => {
    const recommended = profileRecommendation("solo", { ...defaults, enforcement: "audit" }, { myEmail: "me@example.com", browserOrigin: null });
    expect(recommended.patch).toEqual({ fallbackEmail: "me@example.com", selfSelectedIdentity: false, enforcement: "off",
      confirmSoleUser: true });
    expect(recommended.changes).toEqual([
      expect.objectContaining({ setting: "fallbackEmail", now: "", recommended: "me@example.com" }),
      expect.objectContaining({ setting: "enforcement", now: "audit", recommended: "off" }),
    ]);
    expect(recommended.notes).toContain("Requests with no Access email and no browser name, agents included, will be "
      + "attributed to this email. While browser names are on, a browser presenting a stale, expired or invalid name "
      + "stays anonymous — the fallback never covers it.");
  });

  it("changes lists only differences", () => {
    const already: WritableSettings = { ...defaults, selfSelectedIdentity: false, fallbackEmail: "", enforcement: "audit" };
    expect(profileRecommendation("access", already, { myEmail: null, browserOrigin: null }).changes).toEqual([]);
  });
});
