import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { MachineList, RosterAnswer, rpcContract, SettingsOverview, WhoAmI } from "../../server.js";
import type { SettingsTab } from "../../settings-admin.js";
import { BrowserTab } from "./BrowserTab.js";
import { IdentityBar } from "./IdentityBar.js";
import { MachinesTab } from "./MachinesTab.js";
import { PeopleTab } from "./PeopleTab.js";
import { ProfilePanel } from "./ProfilePanel.js";
import { ReadinessStrip } from "./ReadinessStrip.js";
import { SettingsTabs, TAB_LABELS } from "./SettingsTabs.js";

type ReadKey = "overview" | "roster" | "whoami" | "machines";

export type SettingsData = {
  overview: SettingsOverview | null; roster: RosterAnswer | null; whoami: WhoAmI | null; machines: MachineList | null;
  errors: Partial<Record<ReadKey, string>>;
  reload: () => void;
  /** Takes a fresher who-you-are answer (the picker's), so the bar follows a browser-name change. */
  adoptWhoami: (whoami: WhoAmI) => void;
  /** Counts reloads, so the picker (which keeps its own who-you-are) refreshes after every write. */
  revision: number;
};

/** One sentence per read, so a failure names what is missing instead of blanking the page. */
const READ_FAILURES: Record<ReadKey, string> = {
  overview: "Identity could not read its settings",
  roster: "Identity could not read the people list",
  whoami: "Identity could not tell who you are",
  machines: "Identity could not read the machine list",
};

/**
 * The four reads the page is built from, fetched in parallel. Each failure is isolated —
 * a failed overview still renders the people — and a reload discards any answer that
 * arrives after a newer reload started, or (for who-you-are) after the picker adopted one.
 */
export function useSettingsData(): SettingsData {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const generation = useRef(0);
  // Bumped when the picker hands over a fresher who-you-are, so an older read cannot undo it.
  const whoamiVersion = useRef(0);
  const [overview, setOverview] = useState<SettingsOverview | null>(null);
  const [roster, setRoster] = useState<RosterAnswer | null>(null);
  const [whoami, setWhoami] = useState<WhoAmI | null>(null);
  const [machines, setMachines] = useState<MachineList | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ReadKey, string>>>({});
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => {
    const mine = ++generation.current;
    setRevision(mine);
    const whoamiAtStart = whoamiVersion.current;
    const read = <T,>(key: ReadKey, call: () => Promise<T>, store: (value: T) => void) => {
      const stale = () => generation.current !== mine || (key === "whoami" && whoamiVersion.current !== whoamiAtStart);
      void call().then((value) => {
        if (stale()) return;
        store(value);
        setErrors((current) => { const { [key]: _gone, ...rest } = current; return rest; });
      }, (failure: unknown) => {
        if (stale()) return;
        setErrors((current) => ({ ...current, [key]: `${READ_FAILURES[key]}: ${String(failure)}` }));
      });
    };
    read("overview", () => rpcRef.current.call("identity_settings_overview"), setOverview);
    read("roster", () => rpcRef.current.call("identity_roster"), setRoster);
    read("whoami", () => rpcRef.current.call("identity_whoami"), setWhoami);
    read("machines", () => rpcRef.current.call("identity_machines"), setMachines);
  }, []);

  const adoptWhoami = useCallback((fresh: WhoAmI) => {
    whoamiVersion.current++;
    setWhoami(fresh);
    setErrors((current) => { const { whoami: _gone, ...rest } = current; return rest; });
  }, []);

  useEffect(reload, [reload]);
  return { overview, roster, whoami, machines, errors, reload, adoptWhoami, revision };
}

/** What each tab not built yet will show, under its real title. */
type PlaceholderTab = Exclude<SettingsTab, "people" | "machines" | "browser">;
const PLACEHOLDERS: Record<PlaceholderTab, string> = {
  rules: "What the guardrail does in each mode, a simulator over the real rules, and which actions it can see.",
  health: "The self-test, the picker chain, ledger fill, configuration checks and a redacted diagnostics bundle.",
};

function Placeholder({ tab }: { tab: PlaceholderTab }) {
  return (
    <div className="identity-settings-stack">
      <h3 className="identity-settings-heading">{TAB_LABELS[tab]}</h3>
      <p className="identity-settings-muted">{PLACEHOLDERS[tab]}</p>
    </div>
  );
}

/** The "People & machines" settings section: who you are, how ready Identity is, and the tabs. */
export function IdentitySettings() {
  const data = useSettingsData();
  const { overview, roster, whoami, errors } = data;
  const [tab, setTab] = useState<SettingsTab>("people");
  // null: the profile panel follows `firstRun`; "opened" from readiness; "dismissed" once applied.
  const [profile, setProfile] = useState<"opened" | "dismissed" | null>(null);
  // Apply and Close remove the focused button with the panel, so focus moves to the Profile item.
  const profileItem = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    if (!refocus) return;
    profileItem.current?.focus();
    setRefocus(false);
  }, [refocus]);
  const dismissProfile = () => { setProfile("dismissed"); setRefocus(true); };

  // As before: nothing until the first answer, so the page does not flash empty.
  const settled = overview !== null || roster !== null || errors.overview !== undefined || errors.roster !== undefined;
  if (!settled) return null;

  const showProfile = overview !== null
    && (profile === "opened" || (profile === null && overview.firstRun));
  const failures = (Object.keys(READ_FAILURES) as ReadKey[])
    .map((key) => errors[key])
    .filter((sentence): sentence is string => sentence !== undefined);

  return (
    <div className="identity-settings">
      <IdentityBar whoami={whoami} />
      {failures.map((sentence) => <p key={sentence} className="identity-settings-muted">{sentence}</p>)}
      {overview !== null && (
        <ReadinessStrip
          items={overview.readiness}
          onActivate={(target) => { if (target === "profile") setProfile("opened"); else setTab(target); }}
          profileRef={profileItem}
        />
      )}
      {showProfile && (
        <ProfilePanel
          overview={overview}
          whoami={whoami}
          closable={profile === "opened"}
          onApplied={() => { dismissProfile(); data.reload(); }}
          onClose={dismissProfile}
        />
      )}
      <SettingsTabs
        selected={tab}
        onSelect={setTab}
        panels={{
          people: <PeopleTab data={data} />,
          machines: <MachinesTab data={data} />,
          browser: <BrowserTab data={data} />,
          rules: <Placeholder tab="rules" />,
          health: <Placeholder tab="health" />,
        }}
      />
    </div>
  );
}
