// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MachineList, RosterAnswer, SettingsOverview, WhoAmI } from "./server.js";
import type { HostClassification } from "./hosts.js";
import {
  addTeamMachine,
  AUDIT_JQ_COMMAND,
  lintConfig,
  readiness,
  removeTeamMachine,
  type AdminFacts,
} from "./settings-admin.js";

const app = await loadPluginApp(() => import("./app.js"));
const section = app.settingsSections.find((entry) => entry.id === "people")!;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const erin = { person: "erin", displayName: "Erin Example", github: "erin" };
const priya = { person: "priya", displayName: "Priya Shah", github: "priya" };
const people = [
  { ...alex, emails: ["alex@example.test"] },
  { ...erin, emails: ["erin@example.test"] },
  { ...priya, emails: ["priya@example.test"] },
];
const conflictHost: HostClassification = { kind: "person", hostId: "h1", hostName: "ew-lab-003-priya", person: erin,
  conflict: { pinnedName: "ew-lab-003-erin", pinnedPerson: "erin", currentName: "ew-lab-003-priya" } };
const hosts: HostClassification[] = [
  { kind: "person", hostId: "h2", hostName: "ew-lab-002-alex", person: alex, conflict: null },
  { kind: "team", hostId: "h3", hostName: "ew-main", conflict: null },
  { kind: "unclaimed", hostId: "h4", hostName: "scratch-7", conflict: null },
  conflictHost,
  { kind: "person", hostId: "h5", hostName: "renamed-box", person: alex, conflict: null },
];
const teamText = "ew-main\new-lab-009-ci";
const settings = {
  teamMachines: teamText, sharedMachineUser: "ensembleworks-agent", enforcement: "audit" as const,
  fallbackEmail: "", selfSelectedIdentity: true, selectionPublicOrigin: "https://bb.example.test",
};

function facts(over: Partial<AdminFacts> = {}): AdminFacts {
  return {
    directoryError: null, people, teamMachines: ["ew-main", "ew-lab-009-ci"], machines: hosts, machinesUnavailable: null,
    enforcement: settings.enforcement, fallbackEmail: settings.fallbackEmail,
    selfSelectedIdentity: settings.selfSelectedIdentity, selectionPublicOrigin: settings.selectionPublicOrigin,
    signingKey: "valid", pickerStatus: "ready", selfTest: { ok: true, detail: "ok", cookie: { ok: true, detail: "ok" } },
    accessSeen: false, ...over,
  };
}

function overview(over: Partial<AdminFacts> = {}, extra: Partial<SettingsOverview> = {}): SettingsOverview {
  const input = facts(over);
  const lint = lintConfig(input);
  return {
    settings: { ...settings, enforcement: input.enforcement, fallbackEmail: input.fallbackEmail,
      selfSelectedIdentity: input.selfSelectedIdentity, selectionPublicOrigin: input.selectionPublicOrigin,
      signingKey: input.signingKey },
    directory: { ok: true, error: null, people: input.people.length },
    firstRun: false,
    accessSeen: input.accessSeen,
    pickerStatus: input.pickerStatus,
    selfTest: input.selfTest,
    ledgers: { starters: { count: 3, max: 2000 }, queued: { count: 0, max: 500 } },
    conflicts: 1,
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
const machineList = (machines: HostClassification[] = hosts, unavailable: string | null = null): MachineList => ({
  me: null, meViaFallback: false, meProvenance: "unknown", roster: ["alex", "erin", "priya"], colors: {},
  machines, sharedMachineUser: "ensembleworks-agent", enforcement: "audit", unavailable,
});
const readyPicker = { enabled: true, status: "ready", people: [alex, erin, priya].map(({ person, displayName }) =>
  ({ person, displayName })) };
const chosenAlex: WhoAmI = { email: null, person: alex, provenance: "self-selected", selection: { status: "valid" },
  picker: readyPicker };

type Handlers = Record<string, (input: unknown) => unknown>;
function mount(over: Handlers = {}) {
  return renderSlot(section, {}, { rpc: {
    identity_settings_overview: () => overview(),
    identity_roster: () => roster,
    identity_whoami: () => chosenAlex,
    identity_machines: () => machineList(),
    identity_update_settings: () => ({ ok: true, changed: [] }),
    identity_rotate_signing_key: () => ({ ok: true }),
    identity_resolve_pin: () => ({ ok: true, machine: null }),
    identity_set_person_color: () => ({ ok: true, person: "alex", from: null, to: "#b4322e" }),
    identity_clear_person_color: () => ({ ok: true, person: "alex", from: null, to: null }),
    identity_prepare_selection: () => ({ ok: false, reason: "not used" }),
    ...over,
  } });
}

async function openTab(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
  return screen.getByRole("tabpanel");
}

/** The dialog, after checking Cancel took focus as every confirmation must. */
async function dialogNamed(name: string | RegExp) {
  const dialog = await screen.findByRole("dialog", { name });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
  return dialog;
}

describe("This browser tab", () => {
  it("traces the precedence ladder and marks the rung that decided", async () => {
    mount();
    const panel = await openTab("This browser");
    expect(await within(panel).findByRole("heading", { name: "Why am I shown as Alex Rivera?" })).toBeTruthy();
    const ladder = within(panel).getByRole("list", { name: "Precedence ladder" });
    const rungs = within(ladder).getAllByRole("listitem");
    expect(rungs).toHaveLength(4);
    expect(rungs.map((rung) => rung.getAttribute("aria-current"))).toEqual([null, "step", null, null]);
    expect(rungs[1]!.textContent).toContain("Name chosen in this browser");
    expect(rungs[1]!.textContent).toContain("You are here");
    expect(rungs[0]!.textContent).toContain("Skipped");
    expect(rungs[2]!.textContent).toContain("Not reached");
    for (const rung of rungs) expect(rung.querySelector("[data-status-icon]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("says a stale choice is anonymous rather than the fallback", async () => {
    mount({
      identity_settings_overview: () => overview({ fallbackEmail: "solo@example.test" }),
      identity_whoami: () => ({ ...chosenAlex, person: null, provenance: "unknown", selection: { status: "stale" } }),
    });
    const panel = await openTab("This browser");
    const ladder = await within(panel).findByRole("list", { name: "Precedence ladder" });
    const rungs = within(ladder).getAllByRole("listitem");
    await waitFor(() => expect(rungs.map((rung) => rung.getAttribute("aria-current"))).toEqual([null, null, null, "step"]));
    expect(rungs[1]!.textContent)
      .toContain("This browser's choice is stale; Identity treats you as anonymous rather than falling back.");
  });

  it("moves the picker here, still labelled Your name, and off the People tab", async () => {
    mount({ identity_whoami: () => ({ ...chosenAlex, person: null, provenance: "unknown", selection: null }) });
    await screen.findByRole("tab", { name: "People" });
    const people = screen.getByRole("tabpanel");
    expect(within(people).queryByRole("combobox", { name: "Your name" })).toBeNull();
    const panel = await openTab("This browser");
    expect(await within(panel).findByRole("combobox", { name: "Your name" })).toBeTruthy();
  });

  it("disables Save and explains an invalid public origin", async () => {
    const update = vi.fn(() => ({ ok: true, changed: [] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("This browser");
    const origin = await within(panel).findByRole("textbox", { name: "Public origin" });
    fireEvent.change(origin, { target: { value: "https://bb.example.test/app/" } });
    const save = within(panel).getByRole("button", { name: "Save origin" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(within(panel).getByText(/must be an https origin/)).toBeTruthy();
    expect(origin.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(save);
    expect(update).not.toHaveBeenCalled();
  });

  it("saves a valid public origin as exactly that setting", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["selectionPublicOrigin"] }));
    mount({
      identity_settings_overview: () => overview({ selectionPublicOrigin: "", pickerStatus: "origin-not-configured" }),
      identity_update_settings: update,
    });
    const panel = await openTab("This browser");
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Public origin" }),
      { target: { value: "https://bb.example.test" } });
    expect(within(panel).queryByText(/must be an https origin/)).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Save origin" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ selectionPublicOrigin: "https://bb.example.test" }));
  });

  it("confirms before changing an origin browsers already chose names under", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["selectionPublicOrigin"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("This browser");
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Public origin" }),
      { target: { value: "https://new.example.test" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save origin" }));
    const dialog = await dialogNamed("Change the public origin?");
    expect(dialog.textContent).toContain("Every browser's chosen name");
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change origin" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ selectionPublicOrigin: "https://new.example.test" }));
  });

  it("marks the picker's current step in its readiness chain", async () => {
    mount({ identity_settings_overview: () => overview({ pickerStatus: "signing-key-unavailable", signingKey: "missing" }) });
    const panel = await openTab("This browser");
    const chain = await within(panel).findByRole("list", { name: "Picker readiness" });
    const steps = within(chain).getAllByRole("listitem");
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([null, null, "step", null, null]);
    expect(steps[2]!.textContent).toContain("Signing key available");
    expect(steps[2]!.textContent).toContain("Rotate the signing key");
  });

  it("confirms turning browser names on, then writes only that setting", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["selfSelectedIdentity"] }));
    mount({
      identity_settings_overview: () => overview({ selfSelectedIdentity: false, pickerStatus: "off" }),
      identity_update_settings: update,
    });
    const panel = await openTab("This browser");
    const toggle = await within(panel).findByRole("checkbox", { name: /Let browsers choose a name/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    const dialog = await dialogNamed("Let browsers choose a name?");
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ selfSelectedIdentity: true }));
  });

  it("confirms a fallback email behind the sole-user checkbox", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["fallbackEmail"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("This browser");
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Fallback email" }),
      { target: { value: "solo@example.test" } });
    const save = within(panel).getByRole("button", { name: "Save fallback email" });
    fireEvent.click(save);
    const dialog = await dialogNamed("Set a fallback email?");
    expect(dialog.textContent).toContain("s***@example.test");
    expect(dialog.textContent).not.toContain("solo@example.test");
    expect(dialog.textContent).toContain("The guardrail never refuses on it.");
    expect(dialog.textContent).not.toContain("This server looks shared.");
    const confirm = within(dialog).getByRole("button", { name: "Set fallback email" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Only one person uses this server" }));
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ fallbackEmail: "solo@example.test", confirmSoleUser: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(save);
  });

  it("warns that a server where Access was seen looks shared", async () => {
    mount({ identity_settings_overview: () => overview({ accessSeen: true }) });
    const panel = await openTab("This browser");
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Fallback email" }),
      { target: { value: "solo@example.test" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save fallback email" }));
    expect((await dialogNamed("Set a fallback email?")).textContent).toContain("This server looks shared.");
  });

  it("treats Escape as cancel and writes nothing", async () => {
    const update = vi.fn(() => ({ ok: true, changed: [] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("This browser");
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Fallback email" }),
      { target: { value: "solo@example.test" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save fallback email" }));
    const dialog = await dialogNamed("Set a fallback email?");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).not.toHaveBeenCalled();
  });

  it("clears the fallback email without a dialog", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["fallbackEmail"] }));
    mount({ identity_settings_overview: () => overview({ fallbackEmail: "solo@example.test" }), identity_update_settings: update });
    const panel = await openTab("This browser");
    const field = await within(panel).findByRole("textbox", { name: "Fallback email" });
    await waitFor(() => expect((field as HTMLInputElement).value).toBe("solo@example.test"));
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save fallback email" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ fallbackEmail: "" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rotates the signing key only after the typed word, and never shows a key", async () => {
    const rotate = vi.fn(() => ({ ok: true }));
    mount({ identity_rotate_signing_key: rotate });
    const panel = await openTab("This browser");
    expect(await within(panel).findByText("Signing key: valid")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Rotate signing key" }));
    const dialog = await dialogNamed("Rotate the signing key?");
    expect(dialog.textContent).toContain(
      "Every browser's chosen name expires at once. How many browsers that affects cannot be known.");
    const confirm = within(dialog).getByRole("button", { name: "Rotate key" });
    expect(confirm.getAttribute("data-variant")).toBe("destructive");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "rotate" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(rotate).toHaveBeenCalledWith({ confirm: "rotate" }));
    expect(document.body.textContent).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(document.body.textContent).not.toMatch(/selectionSigningKey/);
  });

  it("explains a refused write in a sentence", async () => {
    mount({ identity_update_settings: () => ({ ok: false, reason: "origin-invalid" }) });
    const panel = await openTab("This browser");
    fireEvent.change(await within(panel).findByRole("textbox", { name: "Public origin" }), { target: { value: "" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save origin" }));
    fireEvent.click(within(await dialogNamed("Change the public origin?")).getByRole("button", { name: "Change origin" }));
    expect(await within(panel).findByText(/The public origin must be an https origin \(or http on localhost\); nothing changed\./))
      .toBeTruthy();
  });
});

describe("Machines tab", () => {
  const rowsOf = (panel: HTMLElement) =>
    within(within(panel).getByRole("table")).getAllByRole("row").slice(1);
  const machineName = (row: HTMLElement) => within(row).getByRole("rowheader").textContent;

  it("puts problems first: conflicts, missing team machines, unclaimed, then the rest by name", async () => {
    mount();
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    expect(rowsOf(panel).map(machineName)).toEqual([
      "ew-lab-003-priya", "ew-lab-009-ci", "scratch-7", "ew-lab-002-alex", "ew-main", "renamed-box",
    ]);
  });

  it("says what each machine is, who owns it and why, as icon and text", async () => {
    mount();
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    const cells = rowsOf(panel).map((row) => within(row).getAllByRole("cell").slice(0, 3).map((cell) =>
      cell.textContent!.replace(cell.querySelector("[data-status-icon]")?.textContent ?? "", "").trim()));
    expect(cells).toEqual([
      ["Person", "Erin Example · pin", expect.stringContaining("Pinned to Erin Example as ew-lab-003-erin")],
      ["Team", "Team · teamMachines", "Listed in teamMachines but not seen"],
      ["Unclaimed", "— · unclaimed", "Unclaimed"],
      ["Person", "Alex Rivera · name suffix", "OK"],
      ["Team", "Team · teamMachines", "OK"],
      ["Person", "Alex Rivera · pin", "OK"],
    ]);
    expect(cells[0]![2]).toContain("its name now says Priya Shah");
    for (const row of rowsOf(panel)) {
      expect(row.querySelector("[data-status-icon]")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it.each([
    ["Keep pin", "Keep the pin on ew-lab-003-priya?", "Keep pin",
      "ew-lab-003-priya stays Erin Example's machine even though its name says Priya Shah.",
      { hostId: "h1", action: "keep" }],
    ["Re-pin to Priya Shah", "Re-pin ew-lab-003-priya to Priya Shah?", "Re-pin",
      "Erin Example starting a thread on ew-lab-003-priya would be refused (rule A) once enforcing.",
      { hostId: "h1", action: "repin", person: "priya" }],
    ["Unpin", "Unpin ew-lab-003-priya?", "Unpin",
      "Identity re-derives the owner from the name on next sight.",
      { hostId: "h1", action: "unpin" }],
  ])("resolves a conflict with %s only after confirmation", async (button, title, confirmLabel, consequence, input) => {
    const resolve = vi.fn(() => ({ ok: true, machine: null }));
    const machines = vi.fn(() => machineList());
    mount({ identity_resolve_pin: resolve, identity_machines: machines });
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    const opener = within(rowsOf(panel)[0]!).getByRole("button", { name: button });
    fireEvent.click(opener);
    const dialog = await dialogNamed(title);
    expect(dialog.textContent).toContain(consequence);
    expect(resolve).not.toHaveBeenCalled();
    const reads = machines.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: confirmLabel }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(input));
    await waitFor(() => expect(machines.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("writes nothing when a pin action is cancelled", async () => {
    const resolve = vi.fn(() => ({ ok: true, machine: null }));
    mount({ identity_resolve_pin: resolve });
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    fireEvent.click(within(rowsOf(panel)[0]!).getByRole("button", { name: "Unpin" }));
    fireEvent.click(within(await dialogNamed("Unpin ew-lab-003-priya?")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(resolve).not.toHaveBeenCalled();
  });

  it("makes an unclaimed machine a team machine with the recomputed list", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["teamMachines"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    const row = rowsOf(panel).find((entry) => machineName(entry) === "scratch-7")!;
    fireEvent.click(within(row).getByRole("button", { name: "Make team machine" }));
    const dialog = await dialogNamed("Make scratch-7 a team machine?");
    expect(dialog.textContent).toContain("Anyone may start threads here and automations may run here.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make team machine" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ teamMachines: addTeamMachine(teamText, "scratch-7") }));
  });

  it.each([["ew-main"], ["ew-lab-009-ci"]])("removes %s from the team with the recomputed list", async (name) => {
    const update = vi.fn(() => ({ ok: true, changed: ["teamMachines"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    const row = rowsOf(panel).find((entry) => machineName(entry) === name)!;
    fireEvent.click(within(row).getByRole("button", { name: "Remove from team" }));
    const dialog = await dialogNamed(`Remove ${name} from the team?`);
    expect(dialog.textContent).toContain(`Automations headed for ${name} would be refused (rule C) once enforcing.`);
    expect(within(dialog).getByRole("button", { name: "Remove from team" }).getAttribute("data-variant"))
      .toBe("destructive");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove from team" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ teamMachines: removeTeamMachine(teamText, name) }));
  });

  it("adds a team machine by name without a dialog", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["teamMachines"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("Machines");
    const field = await within(panel).findByRole("textbox", { name: "Add a team machine by name" });
    const add = within(panel).getByRole("button", { name: "Add" });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.change(field, { target: { value: " ew-ci " } });
    fireEvent.click(add);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ teamMachines: addTeamMachine(teamText, "ew-ci") }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  });

  it("saves the shared machine user", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["sharedMachineUser"] }));
    mount({ identity_update_settings: update });
    const panel = await openTab("Machines");
    const field = await within(panel).findByRole("textbox", { name: "Shared machine user" });
    await waitFor(() => expect((field as HTMLInputElement).value).toBe("ensembleworks-agent"));
    fireEvent.change(field, { target: { value: "bb-agent" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save shared machine user" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ sharedMachineUser: "bb-agent" }));
  });

  it("narrows the rows with the filter", async () => {
    mount();
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    fireEvent.change(within(panel).getByRole("searchbox", { name: "Filter machines" }), { target: { value: "ALEX" } });
    expect(rowsOf(panel).map(machineName)).toEqual(["ew-lab-002-alex", "renamed-box"]);
    fireEvent.change(within(panel).getByRole("searchbox", { name: "Filter machines" }), { target: { value: "unclaimed" } });
    expect(rowsOf(panel).map(machineName)).toEqual(["scratch-7"]);
    fireEvent.change(within(panel).getByRole("searchbox", { name: "Filter machines" }), { target: { value: "zzz" } });
    expect(within(panel).getByText("No machine matches that filter.")).toBeTruthy();
  });

  it("explains a refused action next to its row", async () => {
    mount({ identity_resolve_pin: () => ({ ok: false, reason: "no-pin" }) });
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    fireEvent.click(within(rowsOf(panel)[0]!).getByRole("button", { name: "Keep pin" }));
    fireEvent.click(within(await dialogNamed("Keep the pin on ew-lab-003-priya?")).getByRole("button", { name: "Keep pin" }));
    await waitFor(() => expect(within(rowsOf(panel)[0]!)
      .getByText("ew-lab-003-priya has no pin to keep; nothing changed.")).toBeTruthy());
  });

  it("disables the row's buttons while its write is in flight", async () => {
    let finish: (answer: unknown) => void = () => {};
    const pending = new Promise((resolve) => { finish = resolve; });
    mount({ identity_resolve_pin: () => pending });
    const panel = await openTab("Machines");
    await within(panel).findByRole("table");
    fireEvent.click(within(rowsOf(panel)[0]!).getByRole("button", { name: "Unpin" }));
    fireEvent.click(within(await dialogNamed("Unpin ew-lab-003-priya?")).getByRole("button", { name: "Unpin" }));
    // The dialog stays open (and modal) until the answer, so the row sits behind it.
    const rowButtons = () => within(within(panel).getByRole("table", { hidden: true }))
      .getAllByRole("row", { hidden: true })[1]!.querySelectorAll("button");
    await waitFor(() => {
      expect(rowButtons().length).toBe(4);
      for (const button of rowButtons()) expect(button.hasAttribute("disabled")).toBe(true);
    });
    finish({ ok: true, machine: null });
    await waitFor(() => {
      for (const button of within(rowsOf(panel)[0]!).getAllByRole("button")) expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  it("says when Identity sees no machines, or why it cannot list them", async () => {
    mount({ identity_machines: () => machineList([]), identity_settings_overview: () => overview({ machines: [] }) });
    let panel = await openTab("Machines");
    expect(await within(panel).findByText("Identity sees no machines yet.")).toBeTruthy();
    cleanup();
    mount({ identity_machines: () => machineList([], "bb did not answer in time") });
    panel = await openTab("Machines");
    expect(await within(panel).findByText(/bb did not answer in time/)).toBeTruthy();
    expect(within(panel).queryByRole("table")).toBeNull();
  });
});
