// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MachineList, RosterAnswer, SettingsOverview, WhoAmI } from "./server.js";
import type { HostClassification } from "./hosts.js";
import {
  AUDIT_JQ_COMMAND,
  lintConfig,
  profileRecommendation,
  readiness,
  type AdminFacts,
} from "./settings-admin.js";
import { ConfirmDialog } from "./components/settings/ConfirmDialog.js";

const app = await loadPluginApp(() => import("./app.js"));
const section = app.settingsSections.find((entry) => entry.id === "people")!;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const erin = { person: "erin", displayName: "Erin Example", github: "erin" };
const people = [
  { ...alex, emails: ["alex@example.test", "a.rivera@example.test"] },
  { ...erin, emails: ["erin@example.test"] },
];
const hosts: HostClassification[] = [
  { kind: "person", hostId: "h1", hostName: "ew-lab-002-alex", person: alex, conflict: null },
  { kind: "person", hostId: "h2", hostName: "renamed-box", person: alex, conflict: null },
  { kind: "team", hostId: "h3", hostName: "ew-main", conflict: null },
];
const settings = {
  teamMachines: "ew-main", sharedMachineUser: "ensembleworks-agent", enforcement: "audit" as const,
  fallbackEmail: "", selfSelectedIdentity: false, selectionPublicOrigin: "",
};

function facts(over: Partial<AdminFacts> = {}): AdminFacts {
  return {
    directoryError: null, people, teamMachines: ["ew-main"], machines: hosts, machinesUnavailable: null,
    enforcement: settings.enforcement, fallbackEmail: settings.fallbackEmail,
    selfSelectedIdentity: settings.selfSelectedIdentity, selectionPublicOrigin: settings.selectionPublicOrigin,
    signingKey: "valid", pickerStatus: "off", selfTest: { ok: true, detail: "ok", cookie: { ok: true, detail: "ok" } },
    accessSeen: true, ...over,
  };
}

/** The overview the server would send for these facts — readiness and lint are the real functions. */
function overview(over: Partial<AdminFacts> = {}, extra: Partial<SettingsOverview> = {}): SettingsOverview {
  const input = facts(over);
  const lint = lintConfig(input);
  return {
    settings: { ...settings, enforcement: input.enforcement, fallbackEmail: input.fallbackEmail,
      selfSelectedIdentity: input.selfSelectedIdentity, selectionPublicOrigin: input.selectionPublicOrigin,
      signingKey: input.signingKey },
    directory: { ok: input.directoryError === null, error: input.directoryError, people: input.people.length },
    firstRun: false,
    accessSeen: input.accessSeen,
    pickerStatus: input.pickerStatus,
    selfTest: input.selfTest,
    ledgers: { starters: { count: 3, max: 2000 }, queued: { count: 0, max: 500 } },
    conflicts: 0,
    enforceRisks: [],
    readiness: readiness(input, lint),
    lint,
    auditCommand: AUDIT_JQ_COMMAND,
    ...extra,
  };
}

function rosterRow(person: typeof people[number], color: string, machines: string[]): RosterAnswer["people"][number] {
  return { ...person, color, dealt: color, overridden: false, ink: "#ffffff", machines,
    seen: person.person === "alex", seenAt: person.person === "alex" ? 1 : null, clashesWith: [] };
}
const roster: RosterAnswer = {
  me: alex, meViaFallback: false, seenCaveat: "", unavailable: null,
  people: [rosterRow(people[0]!, "#3f7d33", ["ew-lab-002-alex", "renamed-box"]), rosterRow(people[1]!, "#96379a", [])],
};
const machineList: MachineList = {
  me: alex, meViaFallback: false, meProvenance: "upstream-header", roster: ["alex", "erin"], colors: {},
  machines: hosts, sharedMachineUser: "ensembleworks-agent", enforcement: "audit", unavailable: null,
};
const offPicker = { enabled: false, status: "off", people: [] };
const headerAlex: WhoAmI = { email: "alex@example.test", person: alex, provenance: "upstream-header",
  selection: null, picker: offPicker };

type Handlers = Record<string, (input: unknown) => unknown>;
function mount(over: Handlers = {}) {
  return renderSlot(section, {}, { rpc: {
    identity_settings_overview: () => overview(),
    identity_roster: () => roster,
    identity_whoami: () => headerAlex,
    identity_machines: () => machineList,
    identity_update_settings: () => ({ ok: true, changed: [] }),
    identity_set_person_color: (input) => ({ ok: true, person: (input as { person: string }).person, from: null, to: "#b4322e" }),
    identity_clear_person_color: (input) => ({ ok: true, person: (input as { person: string }).person, from: null, to: null }),
    identity_prepare_selection: () => ({ ok: false, reason: "not used" }),
    ...over,
  } });
}

const readinessList = () => screen.findByRole("list", { name: "Identity readiness" });
const tab = (name: string) => screen.getByRole("tab", { name });

describe("People & machines settings section", () => {
  it("keeps the section id and carries the new title and description", () => {
    expect(section.title).toBe("People & machines");
    expect(section.description).toBe("Who and what Identity recognises, why, and what it does about it.");
  });

  // "Counts for" is a sentence-case pill (as in the mockup), so the bar never repeats the
  // picker's own lowercase "attribution only" disclaimer word for word.
  it.each([
    [headerAlex, "You: Alex Rivera · from your Access email, read as-is · counts for Attribution and the guardrail"],
    [{ ...headerAlex, email: null, provenance: "self-selected" } as WhoAmI,
      "You: Alex Rivera · from the name this browser chose · counts for Attribution only — never the guardrail"],
    [{ ...headerAlex, provenance: "configured-fallback" } as WhoAmI,
      "You: Alex Rivera · from the Fallback email setting · counts for Attribution only — never the guardrail"],
    [{ ...headerAlex, email: null, person: null, provenance: "unknown" } as WhoAmI,
      "You: Anonymous · anonymous · Nothing is refused for anonymous requests"],
    [{ ...headerAlex, email: "stranger@example.test", person: null } as WhoAmI,
      "You: stranger@example.test · from your Access email, read as-is · counts for Attribution and the guardrail"],
  ])("says who you are and what that counts for (%#)", async (whoami, text) => {
    mount({ identity_whoami: () => whoami });
    const bar = await screen.findByRole("region", { name: "Who you are here" });
    const [you, trust] = bar.querySelectorAll("p");
    expect(you!.textContent).toBe(text);
    expect(trust!.textContent).toBe("Identity is a guardrail against mistakes, not a lock.");
    expect(bar.getAttribute("role")).toBeNull();
    expect(bar.querySelector("[role=status]")).toBeNull();
  });

  it("updates the bar when this browser selects or forgets a name", async () => {
    const readyPicker = { enabled: true, status: "ready", people: [alex] };
    const anonymous: WhoAmI = { email: null, person: null, provenance: "unknown", selection: null, picker: readyPicker };
    const chosen: WhoAmI = { email: null, person: alex, provenance: "self-selected", selection: { status: "valid" },
      picker: readyPicker };
    let current = anonymous;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mount({
      identity_whoami: () => current,
      identity_prepare_selection: (input) => {
        current = (input as { action: string }).action === "select" ? chosen : anonymous;
        return { ok: true, url: "/commit-selection" };
      },
    });
    const bar = await screen.findByRole("region", { name: "Who you are here" });
    const you = () => bar.querySelector("p")!.textContent;
    await waitFor(() => expect(you()).toBe("You: Anonymous · anonymous · Nothing is refused for anonymous requests"));
    fireEvent.change(await screen.findByRole("combobox", { name: "Your name" }), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this name" }));
    await waitFor(() => expect(you()).toBe(
      "You: Alex Rivera · from the name this browser chose · counts for Attribution only — never the guardrail"));
    fireEvent.click(await screen.findByRole("button", { name: "Forget" }));
    await waitFor(() => expect(you()).toBe("You: Anonymous · anonymous · Nothing is refused for anonymous requests"));
  });

  // An identity_whoami read started before the picker changed the name must not win when it lands later.
  it.each([
    ["answer", (settle: { resolve: (whoami: WhoAmI) => void }, stale: WhoAmI) => settle.resolve(stale)],
    ["rejection", (settle: { reject: (failure: Error) => void }) => settle.reject(new Error("offline"))],
  ] as const)("keeps the picker's name when an older who-you-are %s lands late", async (_kind, land) => {
    const readyPicker = { enabled: true, status: "ready", people: [alex] };
    const anonymous: WhoAmI = { email: null, person: null, provenance: "unknown", selection: null, picker: readyPicker };
    const chosen: WhoAmI = { email: null, person: alex, provenance: "self-selected", selection: { status: "valid" },
      picker: readyPicker };
    let current = anonymous;
    let settle = { resolve: (_whoami: WhoAmI) => {}, reject: (_failure: Error) => {} };
    const late = new Promise<WhoAmI>((resolve, reject) => { settle = { resolve, reject }; });
    late.catch(() => {});
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mount({
      identity_whoami: () => (calls++ === 0 ? late : current),
      identity_prepare_selection: () => { current = chosen; return { ok: true, url: "/commit-selection" }; },
    });
    const bar = await screen.findByRole("region", { name: "Who you are here" });
    const you = () => bar.querySelector("p")!.textContent;
    fireEvent.change(await screen.findByRole("combobox", { name: "Your name" }), { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this name" }));
    const named = "You: Alex Rivera · from the name this browser chose · counts for Attribution only — never the guardrail";
    await waitFor(() => expect(you()).toBe(named));
    await act(async () => { land(settle as never, anonymous); await late.catch(() => {}); });
    expect(you()).toBe(named);
    expect(screen.queryByText(/Identity could not tell who you are/)).toBeNull();
  });

  // A picker refresh (the poll or a visibility change) started before Use this name must not win when it lands later.
  it("keeps the picker's name when an older picker refresh lands after Use this name", async () => {
    const readyPicker = { enabled: true, status: "ready", people: [alex] };
    const anonymous: WhoAmI = { email: null, person: null, provenance: "unknown", selection: null, picker: readyPicker };
    const chosen: WhoAmI = { email: null, person: alex, provenance: "self-selected", selection: { status: "valid" },
      picker: readyPicker };
    let current = anonymous;
    let hold = false;
    let release: (whoami: WhoAmI) => void = () => {};
    const late = new Promise<WhoAmI>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mount({
      identity_whoami: () => (hold ? late : current),
      identity_prepare_selection: () => { current = chosen; return { ok: true, url: "/commit-selection" }; },
    });
    const bar = await screen.findByRole("region", { name: "Who you are here" });
    const you = () => bar.querySelector("p")!.textContent;
    const combo = await screen.findByRole("combobox", { name: "Your name" });
    hold = true;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    hold = false;
    fireEvent.change(combo, { target: { value: "alex" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this name" }));
    const named = "You: Alex Rivera · from the name this browser chose · counts for Attribution only — never the guardrail";
    await waitFor(() => expect(you()).toBe(named));
    expect(screen.getByText("Shown as Alex Rivera (chosen here; attribution only).")).toBeTruthy();
    await act(async () => { release(anonymous); await late; });
    expect(you()).toBe(named);
    expect(screen.getByText("Shown as Alex Rivera (chosen here; attribution only).")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Your name" })).toBeNull();
  });

  it("shows six readiness items in order, each an icon and text", async () => {
    mount();
    const items = within(await readinessList()).getAllByRole("button");
    const text = (item: HTMLElement) =>
      item.textContent!.replace(item.querySelector("[data-status-icon]")?.textContent ?? "", "").trim();
    expect(items.map(text)).toEqual([
      "Profile: Cloudflare Access", "People: 2 people", "Machines: 3 machines",
      "Browser names: Off", "Guardrail: Audit — logging only", "Check: All checks pass",
    ]);
    for (const item of items) {
      const icon = item.querySelector("[data-status-icon]");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(icon?.textContent?.trim().length).toBeGreaterThan(0);
    }
    expect(items[0]!.getAttribute("aria-label")).toBeNull();
    expect(items.map((item) => item.getAttribute("data-status"))).toEqual(["ok", "ok", "ok", "off", "ok", "ok"]);
  });

  it("selects a readiness item's tab when it is activated", async () => {
    mount();
    fireEvent.click(within(await readinessList()).getByRole("button", { name: /^Machines:/ }));
    expect(tab("Machines").getAttribute("aria-selected")).toBe("true");
    expect(tab("People").getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Machines").id);
    expect(within(panel).getByRole("heading", { name: "Machines" })).toBeTruthy();
  });

  it("follows the WAI-ARIA tabs pattern", async () => {
    mount();
    const list = await screen.findByRole("tablist", { name: "Identity settings" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((entry) => entry.textContent)).toEqual(["People", "Machines", "This browser", "Rules", "Health"]);
    const selected = () => tabs.filter((entry) => entry.getAttribute("aria-selected") === "true").map((entry) => entry.textContent);
    const focusable = () => tabs.filter((entry) => entry.tabIndex === 0).map((entry) => entry.textContent);
    expect(selected()).toEqual(["People"]);
    expect(focusable()).toEqual(["People"]);
    for (const entry of tabs) {
      expect(document.getElementById(entry.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("tabpanel");
    }
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(selected()).toEqual(["Machines"]);
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: "ArrowLeft" });
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(selected()).toEqual(["Health"]);
    expect(document.activeElement).toBe(tabs[4]);
    fireEvent.keyDown(tabs[4]!, { key: "ArrowRight" });
    expect(selected()).toEqual(["People"]);
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(selected()).toEqual(["Health"]);
    expect(focusable()).toEqual(["Health"]);
    fireEvent.keyDown(tabs[4]!, { key: "Home" });
    expect(selected()).toEqual(["People"]);
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("gives every tab not built yet its real title and what it will show", async () => {
    mount();
    await screen.findByRole("tablist", { name: "Identity settings" });
    for (const name of ["Machines", "This browser", "Rules", "Health"]) {
      fireEvent.click(tab(name));
      const panel = screen.getByRole("tabpanel");
      expect(within(panel).getByRole("heading", { name })).toBeTruthy();
      expect(panel.textContent).not.toMatch(/coming/i);
      expect(panel.textContent!.length).toBeGreaterThan(name.length + 20);
    }
  });

  it("shows people as a master-detail list with how Identity recognises the selected one", async () => {
    mount();
    const list = await screen.findByRole("list", { name: "People" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((entry) => entry.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(buttons[0]!.textContent).toContain("Alex Rivera");
    expect(buttons[0]!.textContent).toContain("Seen — a thread is attributed to them");
    const table = screen.getByRole("table", { name: "How Identity recognises Alex Rivera" });
    const rows = within(table).getAllByRole("row").slice(1).map((row) =>
      within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["alex@example.test", "Access email", "attribution and the guardrail"],
      ["a.rivera@example.test", "Access email", "attribution and the guardrail"],
      ["ew-lab-002-alex", "name suffix", "machine owner (rule A)"],
      ["renamed-box", "pin", "machine owner (rule A)"],
    ]);
    expect(screen.getByText(/Machines: ew-lab-002-alex, renamed-box/)).toBeTruthy();
    expect(screen.getByText(/People are managed in infrastructure/).textContent).toBe(
      "People are managed in infrastructure (ew_bb_people). Colours are Identity's own and anyone can change them; every change is logged.");
    expect(screen.getByText(/the 2000 most recent threads/)).toBeTruthy();

    fireEvent.click(buttons[1]!);
    expect(buttons.map((entry) => entry.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(screen.getByRole("table", { name: "How Identity recognises Erin Example" })).toBeTruthy();
  });

  it("lists the browser name as a signal only when the picker is on", async () => {
    mount({ identity_settings_overview: () => overview({ selfSelectedIdentity: true, pickerStatus: "ready",
      selectionPublicOrigin: "https://bb.example.test" }) });
    const table = await screen.findByRole("table", { name: "How Identity recognises Alex Rivera" });
    expect(within(table).getByText("Browser name")).toBeTruthy();
    expect(within(table).getByText("attribution only")).toBeTruthy();
  });

  it("copies the selected person's directory entry", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Copy directory entry" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ person: "alex", github: "alexr",
      displayName: "Alex Rivera", emails: ["alex@example.test", "a.rivera@example.test"] }, null, 2));
  });

  it("shows the directory entry to copy by hand when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Copy directory entry" }));
    expect(await screen.findByText("Copy it from here")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toContain("\"person\": \"alex\"");
  });

  it("still changes a colour through identity_set_person_color", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Give Alex Rivera the colour #b4322e" }));
    await waitFor(() => expect(view.rpcCalls).toContainEqual({ method: "identity_set_person_color",
      input: { person: "alex", color: "#b4322e" } }));
  });

  it("takes over the People tab when the directory setting is invalid", async () => {
    const error = "directory is not valid JSON: Expected ',' at position 12";
    mount({
      identity_settings_overview: () => overview({ directoryError: error, people: [], machines: [] }),
      identity_roster: () => ({ ...roster, people: [] }),
      identity_whoami: () => ({ ...headerAlex, person: null }),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`The People directory setting is invalid: ${error}. Everyone is anonymous and nothing is refused until it is fixed.`);
    expect(alert.textContent).toContain("Fix ew_bb_people in infrastructure and redeploy");
    expect(within(alert).getByText("bb plugin config identity set directory '<json>'").tagName).toBe("CODE");
    const people = within(await readinessList()).getByRole("button", { name: /^People:/ });
    expect(people.getAttribute("data-status")).toBe("problem");
    expect(people.textContent).toContain("Directory invalid");
    expect(screen.queryByText(/Nobody is registered yet/)).toBeNull();
  });

  it("says so when the directory is empty", async () => {
    mount({ identity_roster: () => ({ ...roster, people: [] }) });
    expect(await screen.findByText(
      "Nobody is registered yet. Identity reads its people from the directory setting above, which infrastructure manages.")).toBeTruthy();
  });

  it("still lists people when the overview cannot be read", async () => {
    mount({ identity_settings_overview: () => { throw new Error("overview exploded"); } });
    expect(await screen.findByRole("list", { name: "People" })).toBeTruthy();
    expect(screen.getByText(/Identity could not read its settings/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Identity readiness" })).toBeNull();
  });

  it("shows one sentence per failed read, never a blank section", async () => {
    const fail = () => { throw new Error("down"); };
    mount({ identity_settings_overview: fail, identity_roster: fail, identity_whoami: fail, identity_machines: fail });
    expect(await screen.findByText(/Identity could not read its settings/)).toBeTruthy();
    expect(screen.getByText(/Identity could not read the people list/)).toBeTruthy();
    expect(screen.getByText(/Identity could not tell who you are/)).toBeTruthy();
    expect(screen.getByText(/Identity could not read the machine list/)).toBeTruthy();
  });
});

describe("first-run server profile", () => {
  const question = "How do people reach this BB server?";
  const fresh = () => overview({ people: [], machines: [], teamMachines: [], enforcement: "off", accessSeen: false },
    { firstRun: true, settings: { ...settings, teamMachines: "", enforcement: "off", signingKey: "missing" } });
  const current = { ...settings, teamMachines: "", enforcement: "off" as const };
  const confirmApply = async (title: string) => {
    const dialog = await screen.findByRole("dialog", { name: title });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply profile" }));
  };

  it("is not asked once the server is set up", async () => {
    mount();
    await readinessList();
    expect(screen.queryByRole("radiogroup", { name: question })).toBeNull();
  });

  it("asks on first run, marking Access as detected when it was seen", async () => {
    mount({ identity_settings_overview: () => ({ ...fresh(), accessSeen: true }) });
    const group = await screen.findByRole("radiogroup", { name: question });
    expect(within(group).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Cloudflare Access — detected", "Direct, without Access", "Only me",
    ]);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("writes nothing until Apply, and Apply sends exactly the recommended patch", async () => {
    let answer = fresh();
    const update = vi.fn(() => { answer = { ...answer, firstRun: false }; return { ok: true, changed: ["enforcement"] }; });
    const view = mount({ identity_settings_overview: () => answer, identity_update_settings: update });
    await screen.findByRole("radiogroup", { name: question });
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Direct, without Access" }));
    const recommended = profileRecommendation("direct", current,
      { myEmail: headerAlex.email, browserOrigin: window.location.origin });
    const table = screen.getByRole("table", { name: "Now → Recommended" });
    expect(within(table).getAllByRole("row").length).toBe(recommended.changes.length + 1);
    for (const note of recommended.notes) expect(screen.getByText(note)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await confirmApply("Apply the Direct, without Access profile?");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(view.rpcCalls.find((call) => call.method === "identity_update_settings")?.input).toEqual(recommended.patch);
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: question })).toBeNull());
    expect(view.rpcCalls.filter((call) => call.method === "identity_settings_overview").length).toBeGreaterThan(1);
  });

  it("needs the sole-user checkbox before Only me can be applied", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["fallbackEmail"] }));
    const view = mount({ identity_settings_overview: fresh, identity_update_settings: update });
    fireEvent.click(await screen.findByRole("radio", { name: "Only me" }));
    const email = screen.getByRole("textbox", { name: "Your email" }) as HTMLInputElement;
    expect(email.value).toBe("alex@example.test");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Only one person uses this server" }));
    expect(apply.hasAttribute("disabled")).toBe(false);
    fireEvent.click(apply);
    await confirmApply("Apply the Only me profile?");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(view.rpcCalls.find((call) => call.method === "identity_update_settings")?.input).toEqual(
      profileRecommendation("solo", current, { myEmail: "alex@example.test", browserOrigin: window.location.origin }).patch);
  });

  // Apply and Close remove the button that was focused, so focus moves to the Profile readiness item.
  it.each([
    ["a successful Apply", async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Direct, without Access" }));
      const apply = screen.getByRole("button", { name: "Apply" });
      apply.focus();
      fireEvent.click(apply);
      const dialog = await screen.findByRole("dialog", { name: "Apply the Direct, without Access profile?" });
      const confirm = within(dialog).getByRole("button", { name: "Apply profile" });
      confirm.focus();
      fireEvent.click(confirm);
    }],
    ["Close", async () => {
      const close = screen.getByRole("button", { name: "Close" });
      close.focus();
      fireEvent.click(close);
    }],
  ] as const)("moves focus to the Profile readiness item after %s", async (_kind, dismiss) => {
    let answer = { ...fresh(), firstRun: false };
    mount({ identity_settings_overview: () => answer,
      identity_update_settings: () => { answer = { ...answer, firstRun: false }; return { ok: true, changed: ["enforcement"] }; } });
    const profileItem = within(await readinessList()).getByRole("button", { name: /^Profile:/ });
    fireEvent.click(profileItem);
    await screen.findByRole("radiogroup", { name: question });
    await dismiss();
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: question })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(
      within(screen.getByRole("list", { name: "Identity readiness" })).getByRole("button", { name: /^Profile:/ })));
  });

  // The picker keeps its own who-you-are, so an Apply that flips browser names must refresh it too.
  it.each([
    ["turns browser names on", "Direct, without Access", false, true],
    ["turns browser names off", /^Cloudflare Access/, true, false],
  ] as const)("updates the browser picker when an applied profile %s", async (_kind, profileName, before, after) => {
    const readyPicker = { enabled: true, status: "ready", people: [alex] };
    const whoamiFor = (on: boolean): WhoAmI => ({ email: null, person: null, provenance: "unknown", selection: null,
      picker: on ? readyPicker : offPicker });
    let answer = overview({ selfSelectedIdentity: before }, { firstRun: true });
    let written = false;
    let arrive: (whoami: WhoAmI) => void = () => {};
    const late = new Promise<WhoAmI>((resolve) => { arrive = resolve; });
    mount({
      identity_settings_overview: () => answer,
      identity_whoami: () => (written ? late : whoamiFor(before)),
      identity_update_settings: () => {
        written = true;
        answer = overview({ selfSelectedIdentity: after }, { firstRun: false });
        return { ok: true, changed: ["selfSelectedIdentity"] };
      },
    });
    fireEvent.click(await screen.findByRole("radio", { name: profileName }));
    const picker = () => screen.queryByRole("combobox", { name: "Your name" });
    await waitFor(() => expect(picker() !== null).toBe(before));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await confirmApply(typeof profileName === "string"
      ? `Apply the ${profileName} profile?` : "Apply the Cloudflare Access profile?");
    await waitFor(() => expect(screen.queryByRole("radiogroup", { name: question })).toBeNull());
    expect(picker() !== null).toBe(before);
    await act(async () => { arrive(whoamiFor(after)); await late; });
    await waitFor(() => expect(picker() !== null).toBe(after));
  });

  it("explains a refused write in a sentence and stays open", async () => {
    mount({ identity_settings_overview: fresh,
      identity_update_settings: () => ({ ok: false, reason: "write-failed" }) });
    fireEvent.click(await screen.findByRole("radio", { name: /^Cloudflare Access/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await confirmApply("Apply the Cloudflare Access profile?");
    expect(await screen.findByText(/BB did not save the settings/)).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: question })).toBeTruthy();
  });

  it("confirms before writing, naming what changes; Cancel writes nothing and returns focus to Apply", async () => {
    const update = vi.fn(() => ({ ok: true, changed: ["fallbackEmail"] }));
    mount({ identity_settings_overview: fresh, identity_update_settings: update });
    fireEvent.click(await screen.findByRole("radio", { name: "Only me" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Only one person uses this server" }));
    const apply = screen.getByRole("button", { name: "Apply" });
    apply.focus();
    fireEvent.click(apply);
    const dialog = await screen.findByRole("dialog", { name: "Apply the Only me profile?" });
    expect(within(dialog).getByText(/Fallback email: \(empty\) → alex@example\.test/)).toBeTruthy();
    expect(within(dialog).getByText(/agents included, will be attributed to alex@example\.test/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(apply));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole("radiogroup", { name: question })).toBeTruthy();
  });

  it("names that turning the guardrail off stops request verdicts but keeps change logging", async () => {
    mount({ identity_settings_overview: () => overview({}, { firstRun: true }) });
    fireEvent.click(await screen.findByRole("radio", { name: "Direct, without Access" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply the Direct, without Access profile?" });
    expect(within(dialog).getByText("The guardrail turns off: no request will be refused, and request verdicts "
      + "stop being audited. Settings and pin changes are still logged.")).toBeTruthy();
  });

  it("prefills the Only me email when who-you-are arrives after the settings", async () => {
    let arrive: (whoami: WhoAmI) => void = () => {};
    const late = new Promise<WhoAmI>((resolve) => { arrive = resolve; });
    mount({ identity_settings_overview: fresh, identity_whoami: () => late });
    fireEvent.click(await screen.findByRole("radio", { name: "Only me" }));
    const email = screen.getByRole("textbox", { name: "Your email" }) as HTMLInputElement;
    expect(email.value).toBe("");
    await act(async () => { arrive(headerAlex); await late; });
    await waitFor(() => expect(email.value).toBe("alex@example.test"));
  });

  // Precedence: a stale, expired or invalid browser name is anonymous and never falls through to the fallback.
  it("never promises the Only me fallback to a browser presenting a stale name", async () => {
    mount({ identity_settings_overview: fresh });
    fireEvent.click(await screen.findByRole("radio", { name: "Only me" }));
    const limit = /no Access email and no browser name.*stale, expired or invalid name stays anonymous/;
    expect(screen.getByText(limit)).toBeTruthy();
    expect(screen.queryByText(/Every header-less caller|Every request without/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Only one person uses this server" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply the Only me profile?" });
    expect(within(dialog).getByText(limit)).toBeTruthy();
    expect(within(dialog).queryByText(/Every header-less caller|Every request without/)).toBeNull();
  });

  it("opens from the Profile readiness item with a Close button", async () => {
    mount();
    fireEvent.click(within(await readinessList()).getByRole("button", { name: /^Profile:/ }));
    expect(screen.getByRole("radiogroup", { name: question })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("radiogroup", { name: question })).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  function Harness(props: { gate?: Parameters<typeof ConfirmDialog>[0]["gate"]; onConfirm?: () => void }) {
    const [open, setOpen] = useState(false);
    return <>
      <button type="button" onClick={() => setOpen(true)}>Open it</button>
      <ConfirmDialog open={open} title="Rotate the signing key?" consequence="Every browser name is forgotten."
        confirmLabel="Rotate" destructive gate={props.gate}
        onConfirm={() => { props.onConfirm?.(); setOpen(false); }} onCancel={() => setOpen(false)} />
    </>;
  }

  it("focuses Cancel, names the consequence and returns focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open it" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Rotate the signing key?" });
    expect(within(dialog).getByText("Every browser name is forgotten.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("treats Escape as cancel", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps confirm disabled until a typed word matches", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} gate={{ kind: "typed", word: "rotate", label: "Type rotate to confirm" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    const confirm = await screen.findByRole("button", { name: "Rotate" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Type rotate to confirm" }), { target: { value: "rotat" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Type rotate to confirm" }), { target: { value: "rotate" } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await act(async () => { fireEvent.click(confirm); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps confirm disabled until an acknowledgement is ticked, and forgets it when reopened", async () => {
    render(<Harness gate={{ kind: "checkbox", label: "I understand" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    const confirm = await screen.findByRole("button", { name: "Rotate" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand" }));
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    expect((await screen.findByRole("button", { name: "Rotate" })).hasAttribute("disabled")).toBe(true);
  });
});
