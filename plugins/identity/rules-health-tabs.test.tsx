// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MachineList, RosterAnswer, SettingsOverview, WhoAmI } from "./server.js";
import type { HostClassification } from "./hosts.js";
import {
  AUDIT_JQ_COMMAND,
  lintConfig,
  readiness,
  type AdminFacts,
  type LintIssue,
} from "./settings-admin.js";
import { COVERAGE_ROWS } from "./lib/coverage.js";

const app = await loadPluginApp(() => import("./app.js"));
const section = app.settingsSections.find((entry) => entry.id === "people")!;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const erin = { person: "erin", displayName: "Erin Example", github: "erin" };
const people = [{ ...alex, emails: ["alex@example.test"] }, { ...erin, emails: ["erin@example.test"] }];
const hosts: HostClassification[] = [
  { kind: "person", hostId: "h2", hostName: "ew-lab-002-alex", person: alex, conflict: null },
  { kind: "team", hostId: "h3", hostName: "ew-main", conflict: null },
];
const settings = {
  teamMachines: "ew-main", sharedMachineUser: "ensembleworks-agent", enforcement: "audit" as const,
  fallbackEmail: "", selfSelectedIdentity: true, selectionPublicOrigin: "https://bb.example.test",
};
const passing = { ok: true, detail: "request context is live", cookie: { ok: true, detail: "named cookie reached request context" } };

function facts(over: Partial<AdminFacts> = {}): AdminFacts {
  return {
    directoryError: null, people, teamMachines: ["ew-main"], machines: hosts, machinesUnavailable: null,
    enforcement: settings.enforcement, fallbackEmail: "", selfSelectedIdentity: true,
    selectionPublicOrigin: settings.selectionPublicOrigin, signingKey: "valid", pickerStatus: "ready",
    selfTest: passing, accessSeen: true, ...over,
  };
}

function overview(over: Partial<AdminFacts> = {}, extra: Partial<SettingsOverview> = {}): SettingsOverview {
  const input = facts(over);
  const lint = lintConfig(input);
  return {
    settings: { ...settings, enforcement: input.enforcement, signingKey: input.signingKey },
    directory: { ok: true, error: null, people: input.people.length },
    firstRun: false,
    accessSeen: input.accessSeen,
    pickerStatus: input.pickerStatus,
    selfTest: input.selfTest,
    ledgers: { starters: { count: 1842, max: 2000 }, queued: { count: null, max: 500 } },
    conflicts: 0,
    enforceRisks: [],
    readiness: readiness(input, lint),
    lint,
    auditCommand: AUDIT_JQ_COMMAND,
    ...extra,
  };
}

const roster: RosterAnswer = {
  me: null, meViaFallback: false, seenCaveat: "", unavailable: null,
  people: people.map((person) => ({ ...person, color: "#3f7d33", dealt: "#3f7d33", overridden: false, ink: "#ffffff",
    machines: [], seen: false, seenAt: null, clashesWith: [] })),
};
const machineList: MachineList = {
  me: null, meViaFallback: false, meProvenance: "unknown", roster: ["alex", "erin"], colors: {},
  machines: hosts, sharedMachineUser: "ensembleworks-agent", enforcement: "audit", unavailable: null,
};
const whoami: WhoAmI = { email: "alex@example.test", person: alex, provenance: "upstream-header", selection: null,
  picker: { enabled: true, status: "ready", people: [] } };

type Handlers = Record<string, (input: unknown) => unknown>;
function mount(over: Handlers = {}) {
  return renderSlot(section, {}, { rpc: {
    identity_settings_overview: () => overview(),
    identity_roster: () => roster,
    identity_whoami: () => whoami,
    identity_machines: () => machineList,
    identity_update_settings: () => ({ ok: true, changed: [] }),
    identity_rerun_self_test: () => ({ selfTest: passing, pickerStatus: "ready" }),
    identity_diagnostics: () => ({ text: "{\n  \"plugin\": \"identity\"\n}" }),
    identity_prepare_selection: () => ({ ok: false, reason: "not used" }),
    ...over,
  } });
}

async function openTab(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
  return screen.getByRole("tabpanel");
}

async function modes(panel: HTMLElement) {
  const group = await within(panel).findByRole("radiogroup", { name: "Enforcement" });
  const radio = (name: string) => within(group).getByRole("radio", { name }) as HTMLInputElement;
  return { group, off: () => radio("Off"), audit: () => radio("Audit"), enforce: () => radio("Enforce") };
}

describe("Rules tab — enforcement", () => {
  it("describes each mode in one sentence", async () => {
    mount();
    const panel = await openTab("Rules");
    const { off, audit, enforce } = await modes(panel);
    expect(audit().checked).toBe(true);
    const described = (radio: HTMLInputElement) =>
      document.getElementById(radio.getAttribute("aria-describedby")!)!.textContent;
    expect(described(off())).toBe("Record and label only; never refuse.");
    expect(described(audit())).toBe("Take the same decision Enforce would and write it to the log — let everything through.");
    expect(described(enforce())).toBe("Refuse a known person's start on someone else's machine, their message into "
      + "someone else's thread, and an automation off a team machine.");
  });

  it("saves Off and Audit immediately, without a dialog", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["enforcement"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("Rules");
    const { off } = await modes(panel);
    fireEvent.click(off());
    await waitFor(() => expect(update).toHaveBeenCalledWith({ enforcement: "off" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves Audit immediately when the guardrail is off", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["enforcement"] }));
    mount({ identity_settings_overview: () => overview({ enforcement: "off" }), identity_update_settings: update });
    const panel = await openTab("Rules");
    const { audit, off } = await modes(panel);
    expect(off().checked).toBe(true);
    fireEvent.click(audit());
    await waitFor(() => expect(update).toHaveBeenCalledWith({ enforcement: "audit" }));
  });

  it("shows a refused mode change as a sentence and keeps the saved mode", async () => {
    mount({ identity_update_settings: () => ({ ok: false, reason: "write-failed" }) });
    const panel = await openTab("Rules");
    const { off, audit } = await modes(panel);
    fireEvent.click(off());
    await waitFor(() => expect(within(panel).getByText(/nothing changed/i)).toBeTruthy());
    expect(audit().checked).toBe(true);
  });

  it("confirms Enforce naming who would be refused, gated on the acknowledgement", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["enforcement"] }));
    const risk = "Every automation would be refused: no team machine is configured (rule C).";
    mount({ identity_settings_overview: () => overview({}, { enforceRisks: [risk] }), identity_update_settings: update });
    const panel = await openTab("Rules");
    const { enforce } = await modes(panel);
    fireEvent.click(enforce());
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    const items = within(within(dialog).getByRole("list")).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([risk]);
    expect(dialog.textContent).toContain("Rule B (someone else's thread) cannot be predicted — check the audit log.");
    const confirm = within(dialog).getByRole("button", { name: /enforce/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have read the audit log and understand who would be refused" }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ enforcement: "enforce", acknowledgeEnforce: true }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("says when nobody can be predicted to be refused", async () => {
    mount();
    const panel = await openTab("Rules");
    const { enforce } = await modes(panel);
    fireEvent.click(enforce());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Identity cannot predict anyone being refused from machine state alone.");
    expect(dialog.textContent).toContain("Rule B (someone else's thread) cannot be predicted — check the audit log.");
  });

  it("Escape leaves the previous mode checked and focused, without writing", async () => {
    const update = vi.fn(() => ({ ok: true, changed: [] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("Rules");
    const { audit, enforce } = await modes(panel);
    enforce().focus();
    fireEvent.click(enforce());
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(audit().checked).toBe(true);
    expect(enforce().checked).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(audit()));
    expect(update).not.toHaveBeenCalled();
  });
});

describe("Rules tab — audit evidence", () => {
  it("shows the jq command and copies it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mount();
    const panel = await openTab("Rules");
    const code = await waitFor(() => {
      const found = [...panel.querySelectorAll("code")].find((node) => node.textContent === AUDIT_JQ_COMMAND);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(code.textContent).toBe(AUDIT_JQ_COMMAND);
    expect(panel.textContent).toContain("Identity keeps no log in the UI — by decision. To see what the guardrail "
      + "would refuse, run:");
    expect(panel.textContent).toContain("Needs BB core: a plugin log query");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(AUDIT_JQ_COMMAND));
    expect(await within(panel).findByText("Copied.")).toBeTruthy();
  });

  it("tells you to copy the command by hand when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    mount();
    const panel = await openTab("Rules");
    fireEvent.click(await within(panel).findByRole("button", { name: "Copy command" }));
    expect(await within(panel).findByText(/copy it from here/i)).toBeTruthy();
  });
});

describe("Rules tab — simulator and coverage", () => {
  it("runs the real guardrail in each mode and updates the live table when a choice changes", async () => {
    mount();
    const panel = await openTab("Rules");
    const table = await within(panel).findByRole("table", { name: "Outcome in each mode" });
    expect(table.getAttribute("aria-live")).toBe("polite");
    const cells = () => within(table).getAllByRole("cell").map((cell) => cell.textContent ?? "");
    const select = (name: string) => within(panel).getByRole("combobox", { name }) as HTMLSelectElement;
    fireEvent.change(select("Who"), { target: { value: "access-person" } });
    fireEvent.change(select("What"), { target: { value: "start" } });
    fireEvent.change(select("Machine"), { target: { value: "another-persons" } });
    let [off, audit, enforce] = cells();
    expect(off).toContain("Allowed");
    expect(audit).toContain("would refuse");
    expect(enforce).toContain("Refused");
    expect(enforce).toContain("Rule A");
    expect(enforce).toContain("(Refused by Identity's machine-ownership guardrail.)");
    expect(within(table).getAllByText(/Rule A/)[0]!.closest("details")).toBeTruthy();

    fireEvent.change(select("Machine"), { target: { value: "team" } });
    [off, audit, enforce] = cells();
    expect([off, audit, enforce].every((cell) => cell.includes("Allowed"))).toBe(true);
    expect(enforce).not.toContain("Refused");

    fireEvent.change(select("Who"), { target: { value: "browser-name" } });
    fireEvent.change(select("Machine"), { target: { value: "another-persons" } });
    expect(cells()[2]).not.toContain("Refused");
    expect(panel.textContent).toContain("Runs Identity's real guardrail decision in your browser. Browser names and "
      + "the fallback email are never refused.");
  });

  it("lists the seven coverage rows in a disclosure, each status as icon and text", async () => {
    mount();
    const panel = await openTab("Rules");
    const summary = await within(panel).findByText("Where the guardrail can and cannot see");
    const details = summary.closest("details")!;
    expect(details).toBeTruthy();
    const table = within(details).getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(COVERAGE_ROWS.map((row) => row.path));
    const blind = rows[3]!;
    expect(blind.textContent).toContain("Blind");
    expect(blind.querySelector("[data-status-icon]")?.textContent).toBe("∅");
    expect(rows[1]!.textContent).toContain("Seen after");
  });
});

describe("Health tab", () => {
  const legs = async (panel: HTMLElement) => {
    const list = await within(panel).findByRole("list", { name: "Self-test" });
    return within(list).getAllByRole("listitem").map((item) => item.textContent ?? "");
  };

  it("shows every self-test leg as not run yet before the first run", async () => {
    mount({ identity_settings_overview: () => overview({ selfTest: null }) });
    const panel = await openTab("Health");
    const shown = await legs(panel);
    expect(shown).toHaveLength(3);
    expect(shown[0]).toContain("Patch live");
    expect(shown[1]).toContain("Access email reaches Identity");
    expect(shown[2]).toContain("Cookie bridge");
    expect(shown.every((leg) => leg.includes("Not run yet"))).toBe(true);
  });

  it("fails the first two legs with the detail when the self-test failed", async () => {
    const failed = { ok: false, detail: "the live emit is not Identity's patch", cookie: { ok: false, detail: "patch unavailable" } };
    mount({ identity_settings_overview: () => overview({ selfTest: failed }) });
    const panel = await openTab("Health");
    const shown = await legs(panel);
    expect(shown[0]).toContain("Failed");
    expect(shown[0]).toContain("the live emit is not Identity's patch");
    expect(shown[1]).toContain("Failed");
    expect(shown[1]).toContain("the live emit is not Identity's patch");
    expect(shown[2]).toContain("Failed");
    expect(shown[2]).toContain("patch unavailable");
  });

  it("passes every leg for a passing self-test", async () => {
    mount({ identity_settings_overview: () => overview({ selfTest: passing }) });
    const panel = await openTab("Health");
    const shown = await legs(panel);
    expect(shown).toHaveLength(3);
    expect(shown.every((leg) => leg.includes("Passed"))).toBe(true);
    expect(shown.some((leg) => leg.includes("Failed") || leg.includes("Not run yet"))).toBe(false);
    expect(shown[2]).toContain("named cookie reached request context");
  });

  it("fails only the cookie leg when just the cookie bridge failed, from its own result", async () => {
    const cookieDown = { ...passing, cookie: { ok: false, detail: "cookie did not arrive" } };
    mount({ identity_settings_overview: () => overview({ selfTest: cookieDown }) });
    const panel = await openTab("Health");
    const shown = await legs(panel);
    expect(shown[0]).toContain("Passed");
    expect(shown[1]).toContain("Passed");
    expect(shown[2]).toContain("Failed");
    expect(shown[2]).toContain("cookie did not arrive");
  });

  it("re-runs the self-test, busy while it runs, then reloads", async () => {
    let finish: (value: unknown) => void = () => {};
    const rerun = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const read = vi.fn(() => overview());
    mount({ identity_rerun_self_test: rerun, identity_settings_overview: read });
    const panel = await openTab("Health");
    const button = await within(panel).findByRole("button", { name: /self-test again/i }) as HTMLButtonElement;
    const reads = read.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => expect(rerun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.getAttribute("aria-busy")).toBe("true");
    finish({ selfTest: passing, pickerStatus: "ready" });
    await waitFor(() => expect(button.disabled).toBe(false));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
  });

  it("marks the picker's current step in its chain", async () => {
    mount({ identity_settings_overview: () => overview({ pickerStatus: "cookie-bridge-unavailable" }) });
    const panel = await openTab("Health");
    const chain = await within(panel).findByRole("list", { name: "Picker readiness" });
    const steps = within(chain).getAllByRole("listitem");
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([null, null, null, "step", null]);
  });

  it("shows ledger fill with a meter, or unknown without one", async () => {
    mount();
    const panel = await openTab("Health");
    expect(await within(panel).findByText("Thread starters: 1842 of 2000")).toBeTruthy();
    expect(within(panel).getByText("Queued requesters: unknown of 500")).toBeTruthy();
    const meters = panel.querySelectorAll("meter");
    expect(meters).toHaveLength(1);
    expect(meters[0]!.getAttribute("value")).toBe("1842");
    expect(meters[0]!.getAttribute("max")).toBe("2000");
    expect(panel.textContent).toContain("Oldest entries are dropped beyond the limit.");
  });

  it("groups configuration problems error, then warning, then info", async () => {
    const lint: LintIssue[] = [
      { id: "unclaimed-machines", severity: "info", message: "One machine is unclaimed.", fix: "Claim it in Machines." },
      { id: "pin-conflicts", severity: "warning", message: "One pin conflict.", fix: "Resolve it in Machines." },
      { id: "self-test-failed", severity: "error", message: "The self-test failed.", fix: "Re-run it in Health." },
    ];
    mount({ identity_settings_overview: () => overview({}, { lint }) });
    const panel = await openTab("Health");
    const list = await within(panel).findByRole("list", { name: "Configuration checks" });
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("The self-test failed.");
    expect(items[0]).toContain("Re-run it in Health.");
    expect(items[1]).toContain("One pin conflict.");
    expect(items[2]).toContain("One machine is unclaimed.");
    expect(list.querySelectorAll("[data-status-icon]")).toHaveLength(3);
  });

  it("keeps one row per repeated check, each with its own key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lint: LintIssue[] = [
      { id: "team-machine-missing", severity: "warning", message: "Team machine ew-a is not in bb's host list.", fix: "Check it." },
      { id: "team-machine-missing", severity: "warning", message: "Team machine ew-b is not in bb's host list.", fix: "Check it." },
    ];
    mount({ identity_settings_overview: () => overview({}, { lint }) });
    const panel = await openTab("Health");
    const list = await within(panel).findByRole("list", { name: "Configuration checks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });

  it("says so when there are no configuration problems", async () => {
    mount({ identity_settings_overview: () => overview({}, { lint: [] }) });
    const panel = await openTab("Health");
    expect(await within(panel).findByText("No configuration problems found.")).toBeTruthy();
  });

  it("copies redacted diagnostics and says what is redacted", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const diagnostics = vi.fn(() => ({ text: "{\"plugin\":\"identity\"}" }));
    mount({ identity_diagnostics: diagnostics });
    const panel = await openTab("Health");
    expect(panel.textContent).toContain("Emails are shortened, people's names and the signing key are left out. "
      + "Host names are included.");
    expect(diagnostics).not.toHaveBeenCalled();
    fireEvent.click(await within(panel).findByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("{\"plugin\":\"identity\"}"));
  });

  it("drops an earlier Copied. when a later diagnostics request fails", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    const diagnostics = vi.fn()
      .mockReturnValueOnce({ text: "{\"plugin\":\"identity\"}" })
      .mockImplementationOnce(() => { throw new Error("offline"); });
    mount({ identity_diagnostics: diagnostics });
    const panel = await openTab("Health");
    const button = await within(panel).findByRole("button", { name: "Copy diagnostics" });
    fireEvent.click(button);
    expect(await within(panel).findByText("Copied.")).toBeTruthy();
    fireEvent.click(button);
    expect(await within(panel).findByText(/Identity could not build the diagnostics/)).toBeTruthy();
    expect(within(panel).queryByText("Copied.")).toBeNull();
  });

  it("ignores an older diagnostics request that settles after a newer one failed", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
    const diagnostics = vi.fn(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    mount({ identity_diagnostics: diagnostics });
    const panel = await openTab("Health");
    const button = await within(panel).findByRole("button", { name: "Copy diagnostics" });
    fireEvent.click(button);
    await waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(2));
    pending[1]!.reject(new Error("offline"));
    expect(await within(panel).findByText(/Identity could not build the diagnostics/)).toBeTruthy();
    pending[0]!.resolve({ text: "{\"plugin\":\"stale\"}" });
    await new Promise((settle) => setTimeout(settle, 20));
    expect(writeText).not.toHaveBeenCalled();
    expect(within(panel).queryByText("Copied.")).toBeNull();
    expect(within(panel).getByText(/Identity could not build the diagnostics/)).toBeTruthy();
  });

  it("copies only the newest diagnostics when an older request settles last", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = [];
    const diagnostics = vi.fn(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    mount({ identity_diagnostics: diagnostics });
    const panel = await openTab("Health");
    const button = await within(panel).findByRole("button", { name: "Copy diagnostics" });
    fireEvent.click(button);
    await waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(1));
    fireEvent.click(button);
    await waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(2));
    pending[1]!.resolve({ text: "{\"plugin\":\"newest\"}" });
    expect(await within(panel).findByText("Copied.")).toBeTruthy();
    pending[0]!.reject(new Error("offline"));
    await new Promise((settle) => setTimeout(settle, 20));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("{\"plugin\":\"newest\"}");
    expect(within(panel).getByText("Copied.")).toBeTruthy();
    expect(within(panel).queryByText(/Identity could not build the diagnostics/)).toBeNull();
  });

  it("shows the diagnostics to copy by hand when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    mount({ identity_diagnostics: () => ({ text: "{\"plugin\":\"identity\"}" }) });
    const panel = await openTab("Health");
    fireEvent.click(await within(panel).findByRole("button", { name: "Copy diagnostics" }));
    expect(await within(panel).findByText(/copy it from here/i)).toBeTruthy();
    expect(panel.querySelector("pre")?.textContent).toBe("{\"plugin\":\"identity\"}");
  });
});
