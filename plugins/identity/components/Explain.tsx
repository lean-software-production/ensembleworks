import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { GLOSSARY, type GlossaryId } from "../lib/glossary.js";
import type { SettingsTab } from "../settings-admin.js";
import { TAB_LABELS } from "./settings/SettingsTabs.js";

/**
 * Set by the People & machines section, so "More" can select another of its tabs. Absent
 * everywhere else (composer banners, the header popover): BB has no link into a plugin's
 * settings tab, so there "More" names the place in words instead.
 */
export const SettingsNavContext = createContext<{ current: SettingsTab; go: (tab: SettingsTab) => void } | null>(null);

/** A term that explains itself: click (or Enter/Space) for its glossary entry. */
export function Explain({ term, children }: { term: GlossaryId; children: ReactNode }) {
  const entry = GLOSSARY[term];
  const nav = useContext(SettingsNavContext);
  const [open, setOpen] = useState(false);
  // "More" moves focus to a tab; Radix must not pull it back to the trigger on close.
  const navigating = useRef(false);
  const more = entry.more;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger type="button" className="identity-explain" data-term={term}>
        <span className="identity-explain-text">{children}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="identity-explain-content"
          aria-label={entry.title}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (!navigating.current) return;
            navigating.current = false;
            event.preventDefault();
          }}
        >
          <strong className="identity-explain-title">{entry.title}</strong>
          {entry.body.map((line) => <span key={line} className="identity-explain-line">{line}</span>)}
          {more !== undefined && nav !== null && more !== nav.current && (
            <button
              type="button"
              className="identity-explain-more"
              onClick={() => { navigating.current = true; setOpen(false); nav.go(more); }}
            >
              More in {TAB_LABELS[more]}
            </button>
          )}
          {more !== undefined && nav === null && (
            <span className="identity-explain-line identity-explain-where">
              More: Identity settings › People &amp; machines › {TAB_LABELS[more]}
            </span>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
