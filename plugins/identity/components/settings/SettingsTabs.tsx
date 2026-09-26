import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { SETTINGS_TABS, type SettingsTab } from "../../settings-admin.js";

export const TAB_LABELS: Record<SettingsTab, string> = {
  people: "People",
  machines: "Machines",
  browser: "This browser",
  rules: "Rules",
  health: "Health",
};

/**
 * The WAI-ARIA tabs pattern with automatic activation: one tab stop (the selected tab),
 * ←/→ move and wrap, Home/End jump, and focus follows the selection. Every panel stays
 * mounted and the unselected ones are `hidden`, so `aria-controls` always names a panel
 * that exists.
 */
export function SettingsTabs({
  selected,
  onSelect,
  panels,
  badges,
}: {
  selected: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  panels: Record<SettingsTab, ReactNode>;
  badges?: Partial<Record<SettingsTab, ReactNode>>;
}) {
  const base = useId();
  const refs = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const tabId = (tab: SettingsTab) => `${base}-tab-${tab}`;
  const panelId = (tab: SettingsTab) => `${base}-panel-${tab}`;
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: SettingsTab) => {
    const index = SETTINGS_TABS.indexOf(from);
    const last = SETTINGS_TABS.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    const tab = SETTINGS_TABS[next]!;
    onSelect(tab);
    refs.current.get(tab)?.focus();
  };
  return (
    <div className="identity-settings-tabs">
      <div role="tablist" aria-label="Identity settings" className="identity-settings-tablist">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab}
            ref={(element) => { if (element) refs.current.set(tab, element); else refs.current.delete(tab); }}
            id={tabId(tab)}
            type="button"
            role="tab"
            className="identity-settings-tab"
            aria-selected={tab === selected}
            aria-controls={panelId(tab)}
            tabIndex={tab === selected ? 0 : -1}
            onClick={() => onSelect(tab)}
            onKeyDown={(event) => move(event, tab)}
          >
            {TAB_LABELS[tab]}{badges?.[tab]}
          </button>
        ))}
      </div>
      {SETTINGS_TABS.map((tab) => (
        <div
          key={tab}
          id={panelId(tab)}
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          tabIndex={0}
          hidden={tab !== selected}
          className="identity-settings-panel"
        >
          {panels[tab]}
        </div>
      ))}
    </div>
  );
}
