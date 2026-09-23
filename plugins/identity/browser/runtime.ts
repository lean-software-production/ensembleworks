// Standalone fixture: real registered header + Radix, with read-only RPC fixtures.
import type { ComponentType } from "react";
import type { MachineList, ThreadOwnership } from "../server.js";
export let Header: ComponentType<{ threadId: string }>;
export let IdentityPrompt: ComponentType<Record<string, never>>;
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
const rpc = { call: async (method: string) => {
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
  slots: { experimental_appOverlay: (slot: Slot) => void; settingsSection: typeof ignore; experimental_threadHeaderAction: (slot: Slot) => void };
}) => void) {
  setup({ contentScripts: { register: ignore }, composer: { customize: ignore }, slots: {
    experimental_appOverlay: (slot) => { if (slot.id === "identity-prompt") IdentityPrompt = slot.component; }, settingsSection: ignore,
    experimental_threadHeaderAction: (slot) => { if (slot.id === "thread-ownership") Header = slot.component; },
  } });
}
const variant = new URLSearchParams(window.location.search).get("variant");
export const showHeader = new URLSearchParams(window.location.search).get("screen") !== "elsewhere";
if (variant === "unknown") { ownership.starter = null; ownership.via = "unknown"; ownership.host = null; }
if (variant === "automation") { ownership.starter = null; ownership.via = "plugin"; }
if (variant === "agent") { ownership.via = "agent"; ownership.host = { kind: "unclaimed", hostId: "h", hostName: "unclaimed-box", conflict: null }; }
if (variant === "own") { ownership.host = { kind: "person", hostId: "h", hostName: "erins-box", person: ownership.starter!, conflict: null }; }
if (variant === "conflict") { ownership.host = { kind: "person", hostId: "h", hostName: "renamed-box", person: machines.me!, conflict: { pinnedName: "old-alex", pinnedPerson: "alex", currentName: "renamed-box" } }; }
