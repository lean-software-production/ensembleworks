// Standalone fixture: real registered header, prompt and settings section + Radix, with RPC fixtures.
import type { ComponentType } from "react";
import type { MachineList, RosterAnswer, SettingsOverview, ThreadOwnership, WhoAmI } from "../server.js";
import type { HostClassification } from "../hosts.js";
import { AUDIT_JQ_COMMAND, enforceRisks, lintConfig, readiness, type AdminFacts } from "../settings-admin.js";
export let Header: ComponentType<{ threadId: string }>;
export let IdentityPrompt: ComponentType<Record<string, never>>;
export let Settings: ComponentType<Record<string, never>>;
export const ownership: ThreadOwnership = {
  threadId: "fixture", starter: { person: "erin", displayName: "Erin Example", github: "erin" },
  via: "browser", inheritedFrom: null,
  host: { kind: "team", hostId: "h", hostName: "shared-machine-" + "long-name-".repeat(12), conflict: null },
};
export const machines: MachineList = {
  me: { person: "alex", displayName: "Alex", github: "alex" }, meViaFallback: false,
  machines: [], roster: ["erin", "alex", "sam"], colors: { erin: "#40e0d0", alex: "#b4322e", sam: "#2f6bb8" },
  sharedMachineUser: "ensembleworks-agent", enforcement: "audit", unavailable: null,
};
const presentPeople = [
  { person: "alex", displayName: "Alex", github: "alex", typing: false },
  { person: "sam", displayName: "Sam", github: "sam", typing: true },
];
// The settings section's server, as the real one would answer it: readiness, lint and the
// enforce risks come from the same functions. Long names and a pin conflict stress the layout.
const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const erin = { person: "erin", displayName: "Erin Example", github: "erin" };
const sam = { person: "sam", displayName: "Samantha Featherstonehaugh-Montgomery", github: "samantha-featherstonehaugh" };
const directory = [
  { ...alex, emails: ["alex@example.test", "a.rivera@example.test"] },
  { ...erin, emails: ["erin@example.test"] },
  { ...sam, emails: ["samantha.featherstonehaughmontgomery@aratherlongdomain.example.test"] },
];
const hosts: HostClassification[] = [
  { kind: "person", hostId: "h1", hostName: "ew-lab-002-alex", person: alex, conflict: null },
  { kind: "person", hostId: "h2", hostName: "renamed-box", person: alex,
    conflict: { pinnedName: "ew-lab-003-alex", pinnedPerson: "alex", currentName: "renamed-box" } },
  { kind: "team", hostId: "h3", hostName: "ew-main", conflict: null },
  { kind: "unclaimed", hostId: "h4", hostName: "sharedmachine" + "longname".repeat(6), conflict: null },
];
const facts: AdminFacts = {
  directoryError: null, people: directory, teamMachines: ["ew-main"], machines: hosts, machinesUnavailable: null,
  enforcement: "audit", fallbackEmail: "", selfSelectedIdentity: true, selectionPublicOrigin: "https://bb.example.test",
  signingKey: "valid", pickerStatus: "ready", selfTest: { ok: true, detail: "Header and cookie reached Identity.",
    cookie: { ok: true, detail: "The selection cookie round-tripped." } }, accessSeen: true,
};
const lint = lintConfig(facts);
const overview: SettingsOverview = {
  settings: { teamMachines: "ew-main", sharedMachineUser: "ensembleworks-agent", enforcement: facts.enforcement,
    fallbackEmail: facts.fallbackEmail, selfSelectedIdentity: facts.selfSelectedIdentity,
    selectionPublicOrigin: facts.selectionPublicOrigin, signingKey: facts.signingKey },
  directory: { ok: true, error: null, people: directory.length }, firstRun: false, accessSeen: facts.accessSeen,
  pickerStatus: facts.pickerStatus, selfTest: facts.selfTest,
  ledgers: { starters: { count: 1840, max: 2000 }, queued: { count: 3, max: 500 } },
  conflicts: hosts.filter((host) => host.conflict !== null).length, enforceRisks: enforceRisks(facts),
  readiness: readiness(facts, lint), lint, auditCommand: AUDIT_JQ_COMMAND,
};
const colors = ["#3f7d33", "#96379a", "#2f6bb8"];
const roster: RosterAnswer = {
  me: alex, meViaFallback: false, unavailable: null,
  seenCaveat: "Identity can only answer from the attribution records it retains.",
  people: directory.map((person, index) => ({ ...person, color: colors[index]!, dealt: colors[index]!, overridden: false,
    ink: "#ffffff", seen: index !== 1, seenAt: index !== 1 ? Date.now() - 3_600_000 : null, clashesWith: [],
    machines: hosts.flatMap((host) => host.kind === "person" && host.person.person === person.person ? [host.hostName] : []) })),
};
const settingsMachines: MachineList = { ...machines, me: alex, meProvenance: "self-selected", roster: ["alex", "erin", "sam"],
  colors: { alex: colors[0]!, erin: colors[1]!, sam: colors[2]! }, machines: hosts };
const pickerPeople = [alex, erin, sam];
const settingsWhoami: WhoAmI = { email: null, person: alex, provenance: "self-selected", selection: { status: "valid" },
  picker: { enabled: true, status: "ready", people: pickerPeople } };
const settingsRpc: Record<string, (input: any) => unknown> = {
  identity_settings_overview: () => overview,
  identity_roster: () => roster,
  identity_whoami: () => settingsWhoami,
  identity_machines: () => settingsMachines,
  identity_update_settings: (input: Record<string, unknown>) => ({ ok: true, changed: Object.keys(input) }),
  identity_rotate_signing_key: () => ({ ok: true }),
  identity_resolve_pin: ({ hostId }: { hostId: string }) => ({ ok: true, machine: hosts.find((host) => host.hostId === hostId) ?? null }),
  identity_rerun_self_test: () => ({ selfTest: facts.selfTest, pickerStatus: facts.pickerStatus }),
  identity_diagnostics: () => ({ text: "identity diagnostics (redacted)\npeople: 3\nmachines: 4" }),
  identity_set_person_color: ({ person, color }: { person: string; color: string }) => ({ ok: true, person, from: null, to: color }),
  identity_clear_person_color: ({ person }: { person: string }) => ({ ok: true, person, from: null, to: null }),
  identity_prepare_selection: () => ({ ok: false, reason: "the fixture never selects" }),
};
const rpc = { call: async (method: string, input?: unknown) => {
  if (screen === "settings") {
    const answer = settingsRpc[method];
    if (answer === undefined) throw new Error(`Unexpected fixture RPC: ${method}`);
    return answer(input ?? {});
  }
  if (method === "identity_thread_ownership") return { threads: [ownership] };
  if (method === "identity_machines") return machines;
  if (method === "identity_whoami") return variant === "picker"
    ? { email: null, person: null, provenance: "unknown", selection: null,
      picker: { enabled: true, status: "ready", people: [
        { person: "alex", displayName: "Alex", github: "alex" },
        { person: "erin", displayName: "Erin Example", github: "erin" },
      ] } }
    : { email: "alex@example.com", person: machines.me, provenance: "upstream-header", selection: null,
      picker: { enabled: false, status: "off", people: [] } };
  if (method === "presence_thread") return { viewers: presentPeople.length, typing: 1, people: presentPeople };
  throw new Error(`Unexpected fixture RPC: ${method}`);
} };
export const useRpc = () => rpc;
const unused = () => { throw new Error("Unexpected hook in header fixture"); };
export const experimental_useSidebarThreads = unused;
export const useBbContext = unused;
export const useComposerView = unused;
export const useRealtime = () => undefined;
export const useRealtimeConnectionState = unused;
type Slot = { id: string; component: ComponentType<any> };
const ignore = () => undefined;
export function definePluginApp(setup: (app: {
  contentScripts: { register: typeof ignore };
  composer: { customize: typeof ignore };
  slots: { experimental_appOverlay: (slot: Slot) => void; settingsSection: (slot: Slot) => void; experimental_threadHeaderAction: (slot: Slot) => void };
}) => void) {
  setup({ contentScripts: { register: ignore }, composer: { customize: ignore }, slots: {
    experimental_appOverlay: (slot) => { if (slot.id === "identity-prompt") IdentityPrompt = slot.component; }, 
    settingsSection: (slot) => { if (slot.id === "people") Settings = slot.component; },
    experimental_threadHeaderAction: (slot) => { if (slot.id === "thread-ownership") Header = slot.component; },
  } });
}
const variant = new URLSearchParams(window.location.search).get("variant");
export const screen = new URLSearchParams(window.location.search).get("screen");
export const showHeader = screen !== "elsewhere";
if (variant === "unknown") { ownership.starter = null; ownership.via = "unknown"; ownership.host = null; }
if (variant === "automation") { ownership.starter = null; ownership.via = "plugin"; }
if (variant === "agent") { ownership.via = "agent"; ownership.host = { kind: "unclaimed", hostId: "h", hostName: "unclaimed-box", conflict: null }; }
if (variant === "own") { ownership.host = { kind: "person", hostId: "h", hostName: "erins-box", person: ownership.starter!, conflict: null }; }
if (variant === "conflict") { ownership.host = { kind: "person", hostId: "h", hostName: "renamed-box", person: machines.me!, conflict: { pinnedName: "old-alex", pinnedPerson: "alex", currentName: "renamed-box" } }; }
