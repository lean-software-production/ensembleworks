# Identity: prose into popovers — implementation plan

*26 Sep 2026. Implements the owner's answer to the Identity prose audit ("Popovers, in the
tabs, all together"): terms explain themselves in click popovers, "More" jumps between the
People & machines section's own tabs (never to the README or GitHub), and one branch
carries the copy rewrite, the glossary and its use outside settings.*

**Goal.** Cut the explanatory prose the Identity plugin puts in the UI to one short
sentence per place, and move every longer explanation into a single glossary shown in
click popovers. Along the way fix the copy that is wrong today: the `teamMachines`
description says it "restricts nothing"; README says the CLI is the only way to set
`directory`; the picker-chain fixes point "below"; rule letters (A/B/C) appear where
nobody has been told what they mean.

**Architecture.**
- *One glossary* (`lib/glossary.ts`): twelve entries, each a title, one to three short
  sentences and an optional settings tab to jump to. Every popover in the plugin reads it;
  no explanation is written twice.
- *One popover component* (`components/Explain.tsx`): a dotted-underlined inline button
  that opens a Radix Popover with the entry. Inside the settings section a React context
  (`SettingsNavContext`) turns "More" into a button that selects and focuses another tab.
  Outside settings (composer banners, the header popover, the picker) there is no deep
  link in BB, so "More" is plain text naming where to look.
- *Collapsed checklists* (`components/settings/ChecklistSummary.tsx`): the picker chain
  and the self-test collapse to one status line and open only when something is wrong.
- Rule letters become rule names everywhere a user reads them (`own-machine rule`,
  `own-thread rule`, `automation rule`); log lines keep the rule ids from `guardrail.ts`.

**Tech.** TypeScript (strict), React 19, `@radix-ui/react-popover` (already a dependency
of the plugin; the header popover uses it), vitest + jsdom + `@testing-library/react` +
`@get-bb/plugin-sdk/testing/app` (`loadPluginApp`, `renderSlot`), Playwright/Chromium
(`browser/smoke.mjs`).

## Global constraints

Every task obeys all of them.

1. **Work only in** `/home/ensembleworks-agent/ensembleworks/.worktrees/identity-settings`
   on branch `bb/identity-prose-popovers-thr_wmxh7wyasa`. Never touch the main checkout at
   `/home/ensembleworks-agent/ensembleworks` or any other worktree. The plugin lives in
   `plugins/identity/`; use absolute paths (the shell's working directory can reset).
2. **No push, no PR, no plugin install/reload/enable, no `bb plugin config … set`**, no
   change to live BB settings. Commit locally only. No `git stash`, no history rewrites.
3. **Stage explicit paths only** (`git add plugins/identity/<file> …`). The sandbox leaves
   zero-byte placeholder files that show as untracked (`.claude/launch.json`,
   `.claude/loop.md`, `.claude/output-styles`, `.claude/routines`, `.claude/workflows`,
   `.mcp.json`, `plugins/.mcp.json`, `plugins/identity/.claude/`,
   `plugins/identity/.mcp.json`) — never `git add -A`/`.`, never commit or delete them.
4. **Never read, print or copy credentials or tokens.** Touch no file outside the worktree
   except `$TMPDIR` and npm caches.
5. **The facts are fixed; only the words change.** Precedence is Access email → valid
   browser name → fallback email → anonymous, and a stale, expired or invalid browser name
   is anonymous (never the fallback). Only two kinds of request can be refused: one from a
   person identified by their Access email (own-machine and own-thread rules) and a new
   thread from an automation BB stamps (automation rule). No behaviour changes in this
   branch — no server logic, RPC shape, guardrail decision or setting semantics.
6. **Glossary is the only long explanation.** A sentence that explains a term lives in
   `GLOSSARY` and nowhere else; in-page copy is at most one short sentence per place.
   Every glossary body is ≤ 70 words; every generated-form description is ≤ 40 words.
7. **No positional words in fixes.** Chain fixes and setting descriptions never say
   "above" or "below" (the same text appears on two tabs and in BB's generated form).
8. **Accessibility.** Each `Explain` is a real `<button type="button">` named by its visible
   text, with `aria-expanded`/`aria-haspopup` (Radix supplies both); its popover is a
   `role="dialog"` named by the entry title; Escape closes it and returns focus to the
   trigger; "More in …" moves focus to the selected tab. Hit area ≥ 44px tall for every
   Explain trigger and the More button; `:focus-visible` outline
   `2px solid var(--ring, #2563eb)`. Status stays icon + text, never colour alone.
9. **No remote resources** (scripts, fonts, images). Styles go in `identity.css` using
   BB's CSS variables (`--border`, `--background`, `--foreground`, `--muted-foreground`,
   `--popover`, `--popover-foreground`, `--ring`).
10. **Responsive:** nothing overflows horizontally at 320px, 390px or 1280px, and a popover
    stays inside the viewport with an 8px margin at every width.
11. **Honesty tests stay.** The regexes in `ownership-labels.test.ts` that forbid claiming
    a refusal the mode does not perform stay, applied to the banner's detail plus its note.
12. **Tests.** Every existing test keeps passing. The only permitted edits to existing
    tests are the pinned-copy updates listed in each task's *Pinned tests* block: change
    the expected string to the new copy, keep the assertion's strength (never delete an
    assertion, never loosen an exact match to a partial one unless the task says so). If a
    copy change breaks an assertion not listed, update it to the new copy the same way and
    say so in the commit body.
13. **TDD:** write each new test first, run it, watch it fail for the right reason, then
    implement. Commit at the end of each task with the message given.
14. **jsdom and Radix Popper:** jsdom has no `ResizeObserver`. Any test that opens an
    `Explain` stubs it in `beforeEach`:
    `vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });`
    (the test files already call `vi.unstubAllGlobals()` in `afterEach`, so stub per test,
    not at module level).
15. New top-level `.ts` files in `plugins/identity/` must be added to `tsconfig.json`'s
    `include` list (`components/` and `lib/` are already included). This plan adds none.
16. `dealt` is a data field (`RosterAnswer` rows, `person-colors.ts`); only the **UI word**
    "dealt" changes to "auto". Never rename the field.

## Verification

- **Gate** (run from `plugins/identity/`, all must pass):
  `npm run typecheck && npm test && bb plugin build .`
- **Smoke:** `IDENTITY_SCREENSHOTS="$PWD/.local/identity-screens" npm run test:browser`
  (run from `plugins/identity/`; `.local/` is gitignored). If Chromium cannot launch in the
  worker's environment, record the exact error and treat the smoke as *blocked*, not
  passed.

---

## Task 1: Glossary, Explain popover, tab navigation and collapsed checklists

**Files**
- Create `plugins/identity/lib/glossary.ts`, `plugins/identity/lib/glossary.test.ts`
- Create `plugins/identity/components/Explain.tsx`, `plugins/identity/explain.test.tsx`
- Create `plugins/identity/components/settings/ChecklistSummary.tsx`
- Modify `plugins/identity/lib/precedence.ts`, `plugins/identity/lib/precedence.test.ts`
- Modify `plugins/identity/components/settings/IdentitySettings.tsx`,
  `components/settings/SettingsTabs.tsx`, `components/settings/IdentityBar.tsx`,
  `components/settings/HealthTab.tsx`, `components/settings/BrowserTab.tsx` (chain only)
- Modify `plugins/identity/identity.css`
- Modify `plugins/identity/browser/smoke.mjs`
- Tests touched: `settings-shell.test.tsx`, `rules-health-tabs.test.tsx`

**Consumes:** `GuardrailRule` (`guardrail.ts`), `SettingsTab`, `SETTINGS_TABS`,
`ReadinessStatus`, `PickerStatus` (`settings-admin.ts`), `SEEN_UNKNOWN_CAVEAT`
(`roster.ts`), `TAB_LABELS` (`components/settings/SettingsTabs.tsx`), `StatusBadge`,
`PICKER_CHAIN`.

**Produces** (Tasks 2 and 3 rely on these exact names):
- `lib/glossary.ts`: `type GlossaryId`, `type GlossaryEntry`, `GLOSSARY`, `RULE_NAMES`,
  `RULE_TERMS`.
- `components/Explain.tsx`: `Explain({ term, children })`, `SettingsNavContext`.
- `components/settings/ChecklistSummary.tsx`: `ChecklistSummary({ status, summary, open, children })`.
- `lib/precedence.ts`: `pickerProblem(status: PickerStatus): string`,
  `pickerSummary(status: PickerStatus): { status: ReadinessStatus; text: string; open: boolean }`.
- `components/settings/HealthTab.tsx`: `selfTestSummary(selfTest)` (exported).
- CSS classes `.identity-explain`, `.identity-explain-text`, `.identity-explain-content`,
  `.identity-explain-title`, `.identity-explain-line`, `.identity-explain-where`,
  `.identity-explain-more`, `.identity-settings-checklist`.

### Steps

- [ ] **Write the glossary test** `plugins/identity/lib/glossary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SETTINGS_TABS } from "../settings-admin.js";
import type { GuardrailRule } from "../guardrail.js";
import { GLOSSARY, RULE_NAMES, RULE_TERMS, type GlossaryId } from "./glossary.js";

const RULES: GuardrailRule[] = ["start-on-another-persons-machine", "follow-up-by-non-starter", "automation-off-team-machine"];
const text = (id: GlossaryId) => GLOSSARY[id].body.join(" ");

describe("the glossary", () => {
  it("keeps every entry short, titled and pointed at a real tab", () => {
    for (const [id, entry] of Object.entries(GLOSSARY)) {
      expect(entry.title, id).not.toBe("");
      expect(entry.body.length, id).toBeGreaterThan(0);
      expect(entry.body.join(" ").split(/\s+/).filter(Boolean).length, id).toBeLessThanOrEqual(70);
      if (entry.more !== undefined) expect(SETTINGS_TABS, id).toContain(entry.more);
    }
  });

  it("names each rule the way the log does not, and says what the log calls it", () => {
    for (const rule of RULES) {
      expect(GLOSSARY[RULE_TERMS[rule]].title.toLowerCase()).toBe(RULE_NAMES[rule]);
      expect(text(RULE_TERMS[rule])).toContain(`In the log: ${rule}.`);
    }
  });

  it("states the facts the rest of the UI leans on", () => {
    expect(text("guardrail")).toContain("Only two kinds of request can be refused");
    expect(text("attribution-only")).toContain("never refused");
    expect(text("precedence")).toContain("never falls through to the fallback email");
    // Spike S3-lite: a new-thread composer customization never sees the selected machine.
    expect(text("composer-check")).toContain("doesn't tell Identity which machine");
    expect(text("composer-check")).toContain("In Audit it is logged and goes ahead");
  });
});
```

- [ ] Run `npx vitest run lib/glossary.test.ts` — expect FAIL (module not found).
- [ ] **Create `plugins/identity/lib/glossary.ts`:**

```ts
import type { GuardrailRule } from "../guardrail.js";
import type { SettingsTab } from "../settings-admin.js";
import { SEEN_UNKNOWN_CAVEAT } from "../roster.js";

/**
 * Every explanation the Identity UI gives, written once. Pages say one short sentence and
 * wrap the term in <Explain>, which shows the entry here in a popover; `more` names the
 * settings tab that holds the controls the entry is about.
 */
export type GlossaryId =
  | "attribution-only" | "precedence" | "guardrail" | "blind-spots"
  | "rule-own-machine" | "rule-own-thread" | "rule-automation"
  | "composer-check" | "fallback-email" | "machine-owner" | "seen" | "logged-changes";

export type GlossaryEntry = { title: string; body: readonly string[]; more?: SettingsTab };

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = {
  "attribution-only": {
    title: "Attribution only",
    body: [
      "A name chosen in a browser, or the fallback email, labels who started a thread and who sent a message. That is all it does.",
      "The guardrail ignores it: it is never refused, and threads it starts are open to anyone. Only an Access email counts for the guardrail.",
    ],
    more: "browser",
  },
  precedence: {
    title: "Which name you are shown as",
    body: [
      "Identity takes the first that applies: your Access email, then a name chosen in this browser, then the fallback email. With none of them you are anonymous.",
      "A chosen name that is stale, expired or invalid makes you anonymous; it never falls through to the fallback email.",
    ],
    more: "browser",
  },
  guardrail: {
    title: "The guardrail",
    body: [
      "Identity's one check before a message runs. It catches mistakes, such as starting a thread on someone else's machine; it is not a lock.",
      "Only two kinds of request can be refused: one from a person identified by their Access email, and a new thread from an automation BB has stamped. Anything else goes through.",
    ],
    more: "rules",
  },
  "blind-spots": {
    title: "What the guardrail can't see",
    body: [
      "BB doesn't tell Identity which machine the new-thread composer has selected, so nothing is checked until you press Send.",
      "Send now skips the check; Identity records who sent it afterwards.",
      "Terminals, Stop, Archive and approvals are never refused. An automation sending into an existing thread isn't checked.",
    ],
    more: "rules",
  },
  "rule-own-machine": {
    title: "Own-machine rule",
    body: [
      "Someone identified by their Access email may not start a thread on another person's machine. Team and unclaimed machines are open to everyone.",
      "In the log: start-on-another-persons-machine.",
    ],
    more: "rules",
  },
  "rule-own-thread": {
    title: "Own-thread rule",
    body: [
      "Someone identified by their Access email may not send into a thread another person started that way. Threads started any other way are open to anyone.",
      "In the log: follow-up-by-non-starter.",
    ],
    more: "rules",
  },
  "rule-automation": {
    title: "Automation rule",
    body: [
      "An automation may start a thread only on a team machine, or without naming a machine. It is checked only when BB stamps it as the automations plugin.",
      "An automation sending into an existing thread is not stamped, so it is never checked.",
      "In the log: automation-off-team-machine.",
    ],
    more: "rules",
  },
  "composer-check": {
    title: "When the machine is checked",
    body: [
      "BB doesn't tell Identity which machine you pick here, so this banner can't check it.",
      "When you press Send, Identity checks the machine. In Enforce, a start on someone else's machine is refused with a message naming whose it is. In Audit it is logged and goes ahead. Off only records who started the thread.",
    ],
    more: "rules",
  },
  "fallback-email": {
    title: "Fallback email",
    body: [
      "For a server only one person uses. A request with no Access email and no browser name, such as an agent or the CLI, is attributed to this email.",
      "Attribution only: the guardrail never refuses on it. Leave it empty on a shared server.",
    ],
    more: "browser",
  },
  "machine-owner": {
    title: "Whose machine it is",
    body: [
      "A machine whose name ends in -<name>, where <name> is someone's id or GitHub handle, is theirs. Identity pins it on first sight, so a rename doesn't change the owner; a rename that disagrees shows as a conflict.",
      "Team-list machines are the team's, even with a person's name. Anything else is unclaimed: anyone may start threads there.",
    ],
    more: "machines",
  },
  seen: {
    title: "Seen",
    body: ["A thread attributed to them is on record.", SEEN_UNKNOWN_CAVEAT],
  },
  "logged-changes": {
    title: "Which changes are logged",
    body: [
      "Every change made in this section writes a line to BB's log naming who made it, and risky ones ask first.",
      "BB's generated Configuration form and `bb plugin config` change the same settings without asking and without a log line.",
    ],
  },
};

/** What the UI calls each guardrail rule. Log lines keep the rule id. */
export const RULE_NAMES: Record<GuardrailRule, string> = {
  "start-on-another-persons-machine": "own-machine rule",
  "follow-up-by-non-starter": "own-thread rule",
  "automation-off-team-machine": "automation rule",
};

export const RULE_TERMS: Record<GuardrailRule, GlossaryId> = {
  "start-on-another-persons-machine": "rule-own-machine",
  "follow-up-by-non-starter": "rule-own-thread",
  "automation-off-team-machine": "rule-automation",
};
```

  If `GuardrailRule` has members beyond the three above, stop and report — the plan's
  rule naming assumes exactly three.
- [ ] Run `npx vitest run lib/glossary.test.ts` — expect PASS.

- [ ] **Write the Explain test** `plugins/identity/explain.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Explain, SettingsNavContext } from "./components/Explain.js";
import type { SettingsTab } from "./settings-admin.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function withNav(current: SettingsTab, go: (tab: SettingsTab) => void, node: React.ReactNode) {
  return <SettingsNavContext.Provider value={{ current, go }}>{node}</SettingsNavContext.Provider>;
}

describe("Explain", () => {
  it("is a button named by its text that opens a dialog named by the entry", async () => {
    render(<p>Counts for <Explain term="attribution-only">Attribution only</Explain></p>);
    const trigger = screen.getByRole("button", { name: "Attribution only" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dialog.textContent).toContain("That is all it does.");
    expect(dialog.textContent).toContain("Only an Access email counts for the guardrail.");
  });

  it("outside settings, says where to look instead of linking", async () => {
    render(<Explain term="guardrail">guardrail</Explain>);
    fireEvent.click(screen.getByRole("button", { name: "guardrail" }));
    const dialog = await screen.findByRole("dialog", { name: "The guardrail" });
    expect(dialog.textContent).toContain("More: Identity settings › People & machines › Rules");
    expect(within(dialog).queryByRole("button")).toBeNull();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("inside settings, jumps to the entry's tab and closes", async () => {
    const go = vi.fn();
    render(withNav("people", go, <Explain term="attribution-only">Attribution only</Explain>));
    fireEvent.click(screen.getByRole("button", { name: "Attribution only" }));
    const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
    fireEvent.click(within(dialog).getByRole("button", { name: "More in This browser" }));
    expect(go).toHaveBeenCalledWith("browser");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers no More when you are already on that tab", async () => {
    render(withNav("browser", vi.fn(), <Explain term="attribution-only">Attribution only</Explain>));
    fireEvent.click(screen.getByRole("button", { name: "Attribution only" }));
    const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
    expect(within(dialog).queryByRole("button")).toBeNull();
    expect(dialog.textContent).not.toContain("More");
  });

  it("closes on Escape and hands focus back to the term", async () => {
    render(<Explain term="seen">Seen</Explain>);
    const trigger = screen.getByRole("button", { name: "Seen" });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Seen" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
```

  (Add `import type React from "react";` if the `React.ReactNode` reference needs it under
  the project's JSX settings.)
- [ ] Run `npx vitest run explain.test.tsx` — expect FAIL (module not found).
- [ ] **Create `plugins/identity/components/Explain.tsx`:**

```tsx
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
```

- [ ] Run `npx vitest run explain.test.tsx` — expect PASS.

- [ ] **Explain CSS.** Append to `plugins/identity/identity.css` (top level, not under
  `.identity-settings`: the triggers also render in the composer and the header popover,
  and the content is portalled to `body`):

```css
/* A term that explains itself: inline text with a dotted underline and a 44px-tall hit area. */
.identity-explain {
  position: relative;
  display: inline;
  padding: 0;
  margin: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  line-height: inherit;
  text-align: inherit;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: pointer;
}
.identity-explain::after { content: "ⓘ" / ""; display: inline-block; margin-left: 2px; font-size: 0.9em; }
.identity-explain::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 44px;
  transform: translateY(-50%);
}
/* The term's own text sits above any neighbour's enlarged hit area. */
.identity-explain-text { position: relative; z-index: 1; }
.identity-explain:focus-visible { outline: 2px solid var(--ring, #2563eb); outline-offset: 2px; }
.identity-explain-content {
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  max-width: min(320px, calc(100vw - 16px));
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--popover, var(--background));
  color: var(--popover-foreground, var(--foreground));
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.identity-explain-title { font-weight: 600; }
.identity-explain-where { color: var(--muted-foreground); font-size: 12px; }
.identity-explain-more {
  align-self: flex-start;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.identity-explain-more:focus-visible { outline: 2px solid var(--ring, #2563eb); outline-offset: 2px; }
.identity-settings-checklist { display: flex; flex-direction: column; gap: 8px; }
```

  (`z-index: 90` sits above the header popover (50) and the confirm dialogs (79/80).
  `.identity-settings-checklist` reuses the existing `.identity-settings details summary`
  rules — flex row, min-height 40px, ▸/▾ marker — so it needs no summary styles of its own.)

- [ ] **Settings navigation — failing test first.** Add to `settings-shell.test.tsx` (use the
  file's existing mount helper and the self-selected who-you-are fixture its bar test uses;
  stub `ResizeObserver` in this test's `beforeEach` or at the start of the test):

```tsx
it("jumps from a popover's More to that tab and focuses it", async () => {
  // mount with the self-selected who-you-are, as the bar test does
  const bar = await screen.findByRole("region", { name: "Who you are here" });
  fireEvent.click(within(bar).getByRole("button", { name: "Attribution only" }));
  const dialog = await screen.findByRole("dialog", { name: "Attribution only" });
  fireEvent.click(within(dialog).getByRole("button", { name: "More in This browser" }));
  const tab = screen.getByRole("tab", { name: "This browser" });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() => expect(document.activeElement).toBe(tab));
  expect(screen.queryByRole("dialog")).toBeNull();
});
```

  Run it — expect FAIL (no Explain in the bar yet).
- [ ] **`SettingsTabs.tsx`:** add optional props `focusRequest?: SettingsTab | null` and
  `onFocusHandled?: () => void`, import `useEffect`, and inside the component:

```tsx
// A popover's "More" asks for a tab to be focused once it is selected.
useEffect(() => {
  if (focusRequest == null) return;
  refs.current.get(focusRequest)?.focus();
  onFocusHandled?.();
}, [focusRequest, onFocusHandled]);
```

- [ ] **`IdentitySettings.tsx`:** import `useCallback`, `useMemo`, `SettingsNavContext`. Before
  `if (!settled) return null` (hooks must not follow the early return):

```tsx
const [focusTab, setFocusTab] = useState<SettingsTab | null>(null);
const clearFocusTab = useCallback(() => setFocusTab(null), []);
const nav = useMemo(() => ({
  current: tab,
  go: (next: SettingsTab) => { setTab(next); setFocusTab(next); },
}), [tab]);
```

  Wrap the returned `<div className="identity-settings">…</div>` in
  `<SettingsNavContext.Provider value={nav}>`, and pass
  `focusRequest={focusTab} onFocusHandled={clearFocusTab}` to `<SettingsTabs>`.

- [ ] **`IdentityBar.tsx`:** replace `PROVENANCE` and the render with:

```tsx
import type { WhoAmI } from "../../server.js";
import type { GlossaryId } from "../../lib/glossary.js";
import { Explain } from "../Explain.js";

/** Where your identity came from and what it counts for; each phrase explains itself. */
const PROVENANCE: Record<WhoAmI["provenance"], { phrase: string; counts: string; term: GlossaryId }> = {
  "upstream-header": { phrase: "from your Access email", counts: "Attribution and the guardrail", term: "guardrail" },
  "self-selected": { phrase: "chosen in this browser", counts: "Attribution only", term: "attribution-only" },
  "configured-fallback": { phrase: "from the fallback email", counts: "Attribution only", term: "attribution-only" },
  "unknown": { phrase: "anonymous", counts: "Never refused", term: "guardrail" },
};

/** Static text, not a live region: it changes only when the page reloads its answers. */
export function IdentityBar({ whoami }: { whoami: WhoAmI | null }) {
  const provenance = whoami?.provenance ?? "unknown";
  const { phrase, counts, term } = PROVENANCE[provenance];
  const name = whoami?.person?.displayName ?? whoami?.email ?? "Anonymous";
  return (
    <section aria-label="Who you are here" className="identity-settings-bar">
      <p>
        You: <strong>{name}</strong> · <Explain term="precedence">{phrase}</Explain> · {provenance === "unknown" ? null : "counts for "}
        <span className="identity-settings-pill" data-trust={provenance === "upstream-header" ? "guardrail" : "attribution"}>
          <Explain term={term}>{counts}</Explain>
        </span>
      </p>
      <p className="identity-settings-muted">Changes here are <Explain term="logged-changes">logged</Explain>.</p>
    </section>
  );
}
```

  (The "guardrail against mistakes, not a lock" line moves to the Rules tab's lede in Task 2.)
  The `ⓘ` marker uses `content: "ⓘ" / ""`, so it adds nothing to `textContent` or the
  accessible name.
- [ ] Run the new settings-shell test — expect PASS.

- [ ] **Checklist summaries — failing tests first.** Add to `lib/precedence.test.ts`:

```ts
import { PICKER_CHAIN, pickerProblem, pickerSummary } from "./precedence.js";

describe("pickerSummary", () => {
  it("collapses a ready chain, and an off one, to one line", () => {
    expect(pickerSummary("ready")).toEqual({ status: "ok", text: "Ready · 4 checks passed", open: false });
    expect(pickerSummary("off")).toEqual({ status: "off", text: "Off", open: false });
  });
  it("opens on the first problem and names it", () => {
    expect(pickerSummary("signing-key-unavailable"))
      .toEqual({ status: "attention", text: "Not ready: there is no signing key", open: true });
    expect(pickerProblem("origin-not-configured")).toBe("no public origin is set");
  });
  it("never points above or below: the chain shows on two tabs", () => {
    for (const step of PICKER_CHAIN) expect(step.fix).not.toMatch(/\b(above|below)\b/);
  });
});
```

  And to `rules-health-tabs.test.tsx` (import `selfTestSummary` from
  `./components/settings/HealthTab.js`):

```ts
describe("selfTestSummary", () => {
  it("is one line: not run, passed, or the first failing check", () => {
    expect(selfTestSummary(null)).toEqual({ status: "off", text: "Not run yet", open: false });
    expect(selfTestSummary({ ok: true, detail: "", cookie: { ok: true, detail: "" } }))
      .toEqual({ status: "ok", text: "Passed · 3 checks", open: false });
    expect(selfTestSummary({ ok: true, detail: "", cookie: { ok: false, detail: "no cookie" } }))
      .toEqual({ status: "problem", text: "Failed: Cookie bridge", open: true });
    expect(selfTestSummary({ ok: false, detail: "no header", cookie: { ok: true, detail: "" } }))
      .toEqual({ status: "problem", text: "Failed: Patch live", open: true });
  });
});
```

  (Match the literal object shape to `SettingsOverview["selfTest"]` in `server.ts`; if it
  carries more fields, add them.) Run both — expect FAIL.
- [ ] **`lib/precedence.ts`:** add (import `ReadinessStatus` as a type from `settings-admin.ts`):

```ts
/** What stops browser names, as the end of a sentence ("Not ready: …", "unavailable: …"). */
export function pickerProblem(status: PickerStatus): string {
  switch (status) {
    case "off": return "browser names are turned off";
    case "origin-not-configured": return "no public origin is set";
    case "signing-key-unavailable": return "there is no signing key";
    case "cookie-bridge-unavailable": return "the cookie bridge is not working";
    case "ready": return "nothing";
  }
}

/** The picker chain as one line: open only when something needs fixing. */
export function pickerSummary(status: PickerStatus): { status: ReadinessStatus; text: string; open: boolean } {
  if (status === "ready") return { status: "ok", text: `Ready · ${PICKER_CHAIN.length - 1} checks passed`, open: false };
  if (status === "off") return { status: "off", text: "Off", open: false };
  return { status: "attention", text: `Not ready: ${pickerProblem(status)}`, open: true };
}
```

  Change two `PICKER_CHAIN` fixes: `off` → `Turn on "Let browsers choose a name" in This browser.`;
  `signing-key-unavailable` → `Rotate the signing key in This browser.` Change the
  `anonymous` rung detail to
  `"Threads you start show no starter, and the own-machine and own-thread rules never refuse you."`
- [ ] **Create `components/settings/ChecklistSummary.tsx`:**

```tsx
import type { ReactNode } from "react";
import type { ReadinessStatus } from "../../settings-admin.js";
import { StatusBadge } from "./StatusBadge.js";

/** A checklist folded to its one-line verdict; it starts open when something needs fixing. */
export function ChecklistSummary({ status, summary, open, children }: {
  status: ReadinessStatus; summary: string; open: boolean; children: ReactNode;
}) {
  return (
    <details className="identity-settings-checklist" open={open}>
      <summary><StatusBadge status={status} text={summary} /></summary>
      {children}
    </details>
  );
}
```

  (`open` is the initial state only in practice: React re-applies it when the prop
  changes, which is what a reload after a fix should do.)
- [ ] **`HealthTab.tsx`:** export `selfTestSummary`:

```ts
/** The self-test as one line: not run, passed, or the first check that failed. */
export function selfTestSummary(selfTest: SettingsOverview["selfTest"]): { status: ReadinessStatus; text: string; open: boolean } {
  if (selfTest === null) return { status: "off", text: "Not run yet", open: false };
  const legs = selfTestLegs(selfTest);
  const failed = legs.find((leg) => leg.status !== "ok");
  return failed === undefined
    ? { status: "ok", text: `Passed · ${legs.length} checks`, open: false }
    : { status: "problem", text: `Failed: ${failed.label}`, open: true };
}
```

  In `SelfTest`, wrap the `<ul aria-label="Self-test">` in
  `<ChecklistSummary {...summaryProps}>` built from `selfTestSummary(data.overview?.selfTest ?? null)`
  (`status`, `summary={text}`, `open`); the re-run button and error stay outside it. In the
  Health tab's *Browser names* section wrap `<PickerChain>` the same way with
  `pickerSummary(overview.pickerStatus)`.
- [ ] **`BrowserTab.tsx`:** wrap its `<PickerChain>` in `<ChecklistSummary>` with
  `pickerSummary(overview.pickerStatus)`. Keep `ol aria-label="Picker readiness"` and
  `ul aria-label="Self-test"` exactly (tests and the smoke find them by name).
- [ ] Run `npx vitest run` — the new tests pass; fix only the pinned tests below.

**Pinned tests (Task 1)**
- `settings-shell.test.tsx` bar texts (≈ lines 113–129, 151–157, 184, 215) become:
  - `"You: Alex Rivera · from your Access email · counts for Attribution and the guardrail"`
  - `"You: Alex Rivera · chosen in this browser · counts for Attribution only"`
  - `"You: Alex Rivera · from the fallback email · counts for Attribution only"`
  - `"You: Anonymous · anonymous · Never refused"`
  - `"You: stranger@example.test · from your Access email · counts for Attribution and the guardrail"`
  - the second bar paragraph (≈ line 129): `"Changes here are logged."`
  - the `named` constants at ≈ 184 and 215: `"You: Alex Rivera · chosen in this browser · counts for Attribution only"`
- `lib/precedence.test.ts` ≈ line 55: `"Threads you start show no starter, and the own-machine and own-thread rules never refuse you."`
- Any test that reads the picker chain or self-test list keeps working (the lists stay in
  the DOM inside `<details>`); if one clicked or read a now-collapsed item, leave the
  assertion and add the click on the summary first.

- [ ] **Smoke: hit areas and popover navigation.** In `browser/smoke.mjs`:
  1. In the per-tab small-target check, exclude Explain triggers from the existing `small`
     filter (`:not(.identity-explain)`) — their height is the text's; their hit area is the
     `::before`.
  2. Add, in the same per-tab loop, an evaluate that returns a list of failures and assert
     it is empty:

```js
const hits = await page.evaluate(() => {
  const failures = [];
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  for (const el of document.querySelectorAll(".identity-explain")) {
    if (!visible(el)) continue;
    el.scrollIntoView({ block: "center" });
    if (getComputedStyle(el, "::before").height !== "44px") failures.push(`hit area: ${el.textContent}`);
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top?.closest(".identity-explain") !== el) failures.push(`covered: ${el.textContent}`);
  }
  for (const el of document.querySelectorAll("button:not(.identity-explain), input, select, summary, a")) {
    if (!visible(el)) continue;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const explain = top?.closest(".identity-explain");
    if (explain && !el.contains(explain)) failures.push(`control under a term: ${el.textContent || el.tagName}`);
  }
  return failures;
});
expect(hits).toEqual([]);
```

     (Use the file's existing assertion helper if it does not use `expect`.)
  3. After the tab-keyboard block, on the settings screen at each width the smoke already
     covers: click (tap, where the context has touch) the bar's **Attribution only** button
     (self-selected fixture; if the settings fixture's who-you-are is the Access email,
     use the bar's **Attribution and the guardrail** button and dialog **The guardrail**
     with **More in Rules** instead) → the dialog is visible and its bounding box lies
     within `[8, width − 8]` horizontally → `shot("explain")` → press Escape → no dialog,
     and the trigger is `document.activeElement` → press Enter → the dialog opens again →
     the **More in …** button is ≥ 44px tall → click it → no dialog, and the target tab
     has `aria-selected="true"` and is `document.activeElement`.
- [ ] Run the gate and the smoke (see Verification). Look at the `explain` screenshots.
- [ ] Commit:
  `git add plugins/identity/lib/glossary.ts plugins/identity/lib/glossary.test.ts plugins/identity/components/Explain.tsx plugins/identity/explain.test.tsx plugins/identity/components/settings/ChecklistSummary.tsx plugins/identity/lib/precedence.ts plugins/identity/lib/precedence.test.ts plugins/identity/components/settings/IdentitySettings.tsx plugins/identity/components/settings/SettingsTabs.tsx plugins/identity/components/settings/IdentityBar.tsx plugins/identity/components/settings/HealthTab.tsx plugins/identity/components/settings/BrowserTab.tsx plugins/identity/identity.css plugins/identity/browser/smoke.mjs plugins/identity/settings-shell.test.tsx plugins/identity/rules-health-tabs.test.tsx`
  — message `feat(identity): explain terms in popovers`.

**Deliverable:** the glossary, the popover, More-to-tab navigation with focus, and
collapsed checklists, visible in the bar, Health and This browser; gate green; smoke
green or recorded as blocked.

---

## Task 2: Settings copy — short sentences, rule names, generated-form descriptions, README

**Files**
- Modify `plugins/identity/components/settings/PeopleTab.tsx`, `RosterPersonRow.tsx`,
  `MachinesTab.tsx`, `BrowserTab.tsx`, `RulesTab.tsx`
- Modify `plugins/identity/lib/recognised-by.ts`, `plugins/identity/lib/coverage.ts`
- Modify `plugins/identity/settings-admin.ts`, `plugins/identity/server.ts` (the
  `bb.settings.define` descriptions only), `plugins/identity/components/IdentityPicker.tsx`
  (the `heading` prop only)
- Modify `plugins/identity/identity.css` (delete `.identity-settings-core` rules)
- Modify `plugins/identity/README.md`
- Tests touched: `settings-shell.test.tsx`, `browser-machines-tabs.test.tsx`,
  `rules-health-tabs.test.tsx`, `settings-admin.test.ts`, `settings-rpc.test.ts`,
  `lib/recognised-by.test.ts`, `lib/coverage.test.ts`

**Consumes:** `Explain`, `GLOSSARY`, `RULE_NAMES`, `RULE_TERMS`, `GlossaryId` (Task 1).

**Produces:** `RecognisedByRow` gains `term?: GlossaryId`; `IdentityPicker` gains
`heading?: boolean` (default `true`) — Task 3 edits the picker's other copy.

### Steps

- [ ] **Failing tests first.** Update the pinned tests listed at the end of this task to
  the new copy, and add these checks:
  - `settings-rpc.test.ts`, in the generated-form `describe`:

```ts
it("keeps every generated-form description short and true", async () => {
  const describe = await descriptions();
  for (const key of ["directory", "teamMachines", "sharedMachineUser", "enforcement", "fallbackEmail",
    "selfSelectedIdentity", "selectionPublicOrigin", "selectionSigningKey"]) {
    expect(describe(key).split(/\s+/).filter(Boolean).length, key).toBeLessThanOrEqual(40);
    expect(describe(key), key).not.toMatch(/\b(above|below)\b/);
  }
  expect(describe("teamMachines")).not.toMatch(/restricts nothing/);
  expect(describe("teamMachines")).toMatch(/automations may start threads only on them/);
});
```

  - `settings-shell.test.tsx`, People tab: the "Seen" explanation now lives in a popover:

```tsx
fireEvent.click(screen.getAllByRole("button", { name: "Seen — a thread is attributed to them" })[0]!);
const seen = await screen.findByRole("dialog", { name: "Seen" });
expect(seen.textContent).toContain("the 2000 most recent threads");
```

    (stub `ResizeObserver` for this test).
  - `rules-health-tabs.test.tsx`, simulator (replacing the `Rule A` / `details` checks at
    ≈ 234–248): with the default selection (a person from their Access email starting on
    another person's machine), the Enforce cell's text contains `"Own-machine rule"` and
    has a button named `"Own-machine rule"`; the panel contains
    `"The message they would see:"` and `"(Refused by Identity's machine-ownership guardrail.)"`;
    the panel contains the new note `"Runs Identity's real guardrail in your browser. Alex is asking; Sam is someone else."`;
    there is no `details` element in the simulator's table.

  Run them — expect FAIL.

- [ ] **People tab (`PeopleTab.tsx`).**
  - Lede → `People come from infrastructure (<code>ew_bb_people</code>). Anyone can change a colour.`
  - Delete the `<p>{SEEN_UNKNOWN_CAVEAT}</p>` paragraph (and the now-unused import).
  - In the people list, wrap the seen phrase: `<Explain term="seen">{seenPhrase(row.seen)}</Explain>`.
    It sits inside the person `<button>`: a button inside a button is invalid, so leave the
    list's phrase as plain text and put the Explain in `RosterPersonRow` only (next step).
  - Empty state → `Nobody is registered yet. People come from the directory setting, which infrastructure manages.`
  - Recognised-by table, *Counts for* cell: `{signal.term ? <Explain term={signal.term}>{signal.countsFor}</Explain> : signal.countsFor}`.
- [ ] **`RosterPersonRow.tsx`:** drop the `title={SEEN_UNKNOWN_CAVEAT}` and its comment, and
  render `<Explain term="seen">{seenPhrase(row.seen)}</Explain>` inside that span. The
  colour state word `dealt` → `auto`; the button `Reset to dealt` → `Reset to auto`. Keep
  the `dealt` field and the `colorInputValue` comment's reasoning (reword "A dealt colour"
  to "An auto colour" only if you touch that comment).
- [ ] **`lib/recognised-by.ts`:** `RecognisedByRow = { signal: string; from: string; countsFor: string; term?: GlossaryId }`
  (`import type { GlossaryId } from "./glossary.js"`). Access email rows:
  `countsFor: "attribution and the guardrail", term: "guardrail"`; browser name row:
  `countsFor: "attribution only", term: "attribution-only"`; machine rows:
  `countsFor: "machine owner", term: "machine-owner"`.
- [ ] **Machines tab (`MachinesTab.tsx`).**
  - Lede → `Every machine BB knows and <Explain term="machine-owner">whose it is</Explain>. Problems come first.`
  - `repin` consequence second sentence → `` `${pinned} starting a thread on ${host} would be refused by the own-machine rule once enforcing.` ``
  - `team-remove` consequence first sentence → `` `An automation starting a thread on ${host} would be refused by the automation rule once enforcing. ` ``
    (the second sentence stays).
- [ ] **This browser tab (`BrowserTab.tsx`).**
  - Render the picker as `<IdentityPicker heading={false} … />` (the tab already has the
    heading "This browser"). In `IdentityPicker.tsx` add `heading = true` to the props and
    render `<strong style={{ display: "block" }}>This browser</strong>` only when `heading`.
  - Checkbox label text → `Let browsers choose a name`; right after the `</label>` (outside
    it, so a click on the term does not toggle the checkbox) add
    `<Explain term="attribution-only">Attribution only</Explain>`. Put the label and the
    Explain in one `<div className="identity-settings-actions">` if the layout needs a row.
  - Fallback paragraph → `For a server only one person uses. <Explain term="fallback-email">How it works</Explain>`
  - Signing-key paragraph → `Only the key's status is shown; it never leaves the server.`
- [ ] **Rules tab (`RulesTab.tsx`).**
  - Lede → `Identity is a <Explain term="guardrail">guardrail against mistakes</Explain>, <Explain term="blind-spots">not a lock</Explain>.`
  - `MODES` sentences: off `Label threads; check nothing.`; audit
    `Log what Enforce would refuse; let everything through.`; enforce
    `Refuse it, with a message saying why.`
  - After the radiogroup:
    `<p className="identity-settings-muted">The rules: <Explain term="rule-own-machine">own machine</Explain> · <Explain term="rule-own-thread">own thread</Explain> · <Explain term="rule-automation">automations</Explain></p>`
  - Enforce dialog's last paragraph → `Refusals under the own-thread rule can't be predicted — check the audit log.`
  - `AuditEvidence`: remove the `Needs BB core` span and the `identity-settings-core-zone`
    class; the paragraph → `Identity shows no log here. To see what the guardrail would refuse, run:`
  - `Simulator`: delete the `RULES` map. Each result cell renders the `StatusBadge` and,
    when `outcome.rule !== null`,
    `<Explain term={RULE_TERMS[outcome.rule]}>{capitalise(RULE_NAMES[outcome.rule])}</Explain>`
    where `capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)` (so
    "Own-machine rule"). No `<details>`. Below the table, when any outcome has a message:
    `<p className="identity-settings-muted">The message they would see: “{message}”</p>`
    using the first outcome whose `message !== null`.
  - Simulator notes: the automation note (condition unchanged) →
    `An automation sending into an existing thread isn't stamped, so the guardrail can't tell it is one.`;
    replace the last two notes with one:
    `Runs Identity's real guardrail in your browser. Alex is asking; Sam is someone else.`
  - Import `GuardrailRule` only if still used.
- [ ] **`identity.css`:** delete the `.identity-settings-core` and
  `.identity-settings-core::before` rules (≈ lines 298–310) and any
  `.identity-settings-core-zone` rule.
- [ ] **Rule names in server-side copy.** `settings-admin.ts`: `(rule C)` / `(rule A)` in the
  lint and enforce-risk sentences → `by the automation rule` / `by the own-machine rule`,
  keeping each sentence grammatical, e.g.
  `"No team machine is configured, so an automation starting a thread on a named machine would be refused by the automation rule. "`,
  `"An automation starting a thread on a named machine would be refused by the automation rule: no team machine is configured. "`,
  `` `… ${derived.displayName} starting a thread there would be refused by the own-machine rule.` ``
  Use literal strings (do not import the glossary into `settings-admin.ts`: it is shared
  with the server). `lib/coverage.ts`: `Rule C applies to …` → `The automation rule applies to …`;
  `Arrives unstamped, so rule C cannot see it. …` → `Arrives unstamped, so the automation rule cannot see it. Needs BB core to stamp threads.send.`
- [ ] **Generated-form descriptions (`server.ts`, the `bb.settings.define` block).** Replace
  each `description` with (labels and everything else unchanged):

| Setting | Description |
|---|---|
| `directory` | `Managed in infrastructure. JSON array of { "person", "github", "displayName", "emails": [...] }; emails match the Access email case-insensitively.` |
| `teamMachines` | `Shared machines, one per line or comma separated. Anyone may start threads on them, and automations may start threads only on them.` |
| `sharedMachineUser` | `The Linux account agents run as on team and unclaimed machines. Shown in the thread header; Identity never sets or checks it.` |
| `enforcement` | `Off (record only), Audit (log what would be refused) or Enforce (refuse it). Change it in People & machines, where the change is confirmed and logged; a change made here is not.` |
| `fallbackEmail` | `Only for a server one person uses. Requests with no Access email and no valid browser name are attributed to it; a stale, expired or invalid browser name stays anonymous. Never refused. Leave empty on a shared server.` |
| `selfSelectedIdentity` | `Let browsers choose a name from the directory. Attribution only.` |
| `selectionPublicOrigin` | `The exact origin browsers use, such as https://bb.example.com. Needed for browser names.` |
| `selectionSigningKey` | `32-byte base64url key that signs browser names. Setting a new one expires every browser's name.` |

  Before replacing `sharedMachineUser`'s, read how the header uses it (`ownership-labels.ts`)
  and keep the new sentence true; if it is not shown in the header, say where it is shown.
- [ ] **README (`plugins/identity/README.md`).**
  - *Ownership UI* opening (≈ lines 164–165) →
    `Identity **shows** who owns what. The ownership UI only labels: nothing in it can reject, delay or alter a dispatch. What refuses is the guardrail, below.`
  - End of the paragraph that starts "The rules `audit` reports and `enforce` acts on"
    (the one ending "so rule C allows both.") → append:
    `The settings section calls them the own-machine (A), own-thread (B) and automation (C) rules; log lines carry the rule id from \`guardrail.ts\`.`
  - *What still needs BB core* lede (≈ line 387) →
    `The coverage map in the Rules tab names the one that matters day to day (stamping \`threads.send\`); none is attempted here:`
  - *Setting them* (≈ lines 439–442) →
    `Prefer the People & machines section above: it confirms the risky changes and writes an audit line for each. The CLI and the generated Configuration form still work (they are the only ways to set \`directory\`), but they skip those confirmations and write no \`settings.change\` line:`
- [ ] Run `npx vitest run` — all pass.

**Pinned tests (Task 2)**
- `settings-shell.test.tsx`: recognised-by rows ≈ 307–308 → `"machine owner"`; lede ≈ 311–312 →
  `getByText(/People come from infrastructure/)` with textContent
  `"People come from infrastructure (ew_bb_people). Anyone can change a colour."`; the
  `/the 2000 most recent threads/` check ≈ 313 becomes the popover check above; empty
  state ≈ 373 → `"Nobody is registered yet. People come from the directory setting, which infrastructure manages."`
  (≈ 367's `/Nobody is registered yet/` stays).
- `lib/recognised-by.test.ts` ≈ 33, 41, 42, 51: each expected row gains its `term`
  (`"guardrail"`, `"attribution-only"`, `"machine-owner"`), and `"machine owner (rule A)"` → `"machine owner"`.
- `browser-machines-tabs.test.tsx` ≈ 351 → `"Erin Example starting a thread on ew-lab-003-priya would be refused by the own-machine rule once enforcing."`;
  ≈ 407 → `` `An automation starting a thread on ${name} would be refused by the automation rule once enforcing. ` ``
- `rules-health-tabs.test.tsx`: MODES ≈ 108–110 → the three new sentences; ≈ 145 → the new
  enforce-risk sentence; ≈ 154 and 171 → `"Refusals under the own-thread rule can't be predicted — check the audit log."`;
  ≈ 204 → `"Identity shows no log here. To see what the guardrail would refuse, run:"`;
  ≈ 206 becomes `expect(panel.textContent).not.toContain("Needs BB core")`; simulator
  ≈ 234–248 as above.
- `settings-admin.test.ts` ≈ 302, 405, 412 → the new sentences.
- `lib/coverage.test.ts` ≈ 20, 31–32 → the new notes.
- `settings-rpc.test.ts` ≈ 435–449: fallback keeps `not.toMatch(/Every header-less caller|every caller without/i)`
  and `toMatch(/stale, expired or invalid browser name stays anonymous/)`; its
  `/no Cloudflare Access header and no valid browser name/` → `/no Access email and no valid browser name/`.
  Enforcement keeps `not.toMatch(/off logs nothing/)`; its two positive checks become
  `toMatch(/People & machines/)` and `toMatch(/made here is not/)`.

- [ ] Run the gate and the smoke; look at every tab's screenshot at 320, 390 and 1280.
- [ ] Commit (explicit paths: every file listed under **Files** plus the tests touched) —
  message `feat(identity): shorten settings copy and name the rules`.

**Deliverable:** every settings tab reads in one short sentence per place, rule letters
are gone from the UI, BB's generated form describes each setting truthfully in ≤ 40
words, and the README matches.

---

## Task 3: Outside settings — composer banners, header popover footer, picker

**Files**
- Modify `plugins/identity/ownership-labels.ts`, `plugins/identity/ownership-labels.test.ts`
- Modify `plugins/identity/app.tsx` (`BannerBody`, `StartingAsBanner`,
  `ReadOnlyThreadBanner`, `identityFooter`)
- Modify `plugins/identity/components/IdentityPicker.tsx`
- Create `plugins/identity/composer-banner.test.tsx`
- Modify `plugins/identity/browser/runtime.ts`, `browser/main.tsx`, `browser/smoke.mjs`
- Tests touched: `settings-shell.test.tsx` (picker status ≈ 217/220), any test pinning the
  old banner/footer/picker strings.

**Consumes:** `Explain`, `GlossaryId` (Task 1); `pickerProblem` (Task 1);
`IdentityPicker`'s `heading` prop (Task 2).

**Produces:** `OwnershipBanner = { title: string; detail: string; note?: { text: string; term: GlossaryId } }`.

### Steps

- [ ] **Failing tests first — banners.** In `ownership-labels.test.ts`:
  - Add a helper `const said = (b: OwnershipBanner | null) => \`${b?.detail ?? ""} ${b?.note?.text ?? ""}\`;`
    and run every honesty regex (the `(is|are|will be|gets?) … (caught|refused|…)` and
    `(was|were|has been|have been) …` checks) against `said(banner)` instead of
    `banner.detail`. Audit keeps `toMatch(/audit mode/i)`; enforce keeps
    `toMatch(/starting on someone else's machine is refused/i)` — both against `said(…)`.
  - The enforce test's `toContain("does not tell a plugin which machine …")` moves to the
    glossary: delete it here (Task 1's glossary test asserts
    `composer-check` contains "doesn't tell Identity which machine"), and instead assert
    `banner.note?.term === "composer-check"` for every mode with a person.
  - Exact expectations:

```ts
expect(composerBanner({ me: david, machines: [davidsMachine, mattsMachine, teamMachine, unclaimed], enforcement: "off" }))
  .toEqual({
    title: "Starting as David",
    detail: "Yours: ew-lsp-001-mrdavidlaing · Team: ew-lsp-001-main",
    note: { text: "Starting on someone else's machine is recorded, not refused.", term: "composer-check" },
  });
expect(composerBanner({ me: david, enforcement: "off", machines: [] }))
  .toEqual({
    title: "Starting as David",
    detail: "No machines of yours known yet",
    note: { text: "Starting on someone else's machine is recorded, not refused.", term: "composer-check" },
  });
expect(composerBanner({ me: david, enforcement: "audit", machines: [] }).note?.text)
  .toBe("In audit mode, starting on someone else's machine is logged, then goes ahead.");
expect(composerBanner({ me: david, enforcement: "enforce", machines: [] }).note?.text)
  .toBe("Starting on someone else's machine is refused at Send.");
expect(composerBanner({ me: null, enforcement: "off", machines: [teamMachine] })).toEqual({
  title: "Starting as an unrecognised sign-in",
  detail: "Threads you start show no starter until your email is in Identity's directory.",
});
expect(composerBanner({ me: david, provenance: "self-selected", enforcement: "enforce", machines: [] })).toEqual({
  title: "Starting as David", detail: "Chosen in this browser.",
  note: { text: "Attribution only.", term: "attribution-only" },
});
expect(composerBanner({ me: david, provenance: "configured-fallback", enforcement: "enforce", machines: [] })).toEqual({
  title: "Starting as David", detail: "From the fallback email.",
  note: { text: "Attribution only.", term: "attribution-only" },
});
expect(readOnlyBanner({ me: david, starter: matt, enforcement: "enforce" })).toEqual({
  title: "Read-only: Matt's thread",
  detail: "Only Matt can send to it. Ask Matt, or start a thread of your own.",
  note: { text: "Own-thread rule", term: "rule-own-thread" },
});
expect(readOnlyBanner({ me: david, starter: matt, enforcement: "off" })).toEqual({
  title: "Matt's thread",
  detail: "Meant for Matt to drive; enforcement is off, so nothing stops you.",
  note: { text: "Own-thread rule", term: "rule-own-thread" },
});
expect(readOnlyBanner({ me: david, starter: matt, enforcement: "audit" })).toEqual({
  title: "Matt's thread",
  detail: "Meant for Matt to drive. In audit mode a message from you here is logged as a would-refuse, then goes through.",
  note: { text: "Own-thread rule", term: "rule-own-thread" },
});
```

  (Use the fixtures' real names — `david`, `matt`, `davidsMachine`, … — as the file
  defines them; the machine names above are the ones the existing test uses.)
- [ ] **Failing test first — composer.** Create `plugins/identity/composer-banner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MachineList } from "./server.js";

const alex = { person: "alex", displayName: "Alex Rivera", github: "alexr" };
const list: MachineList = {
  me: alex, meViaFallback: false, meProvenance: "upstream-header",
  roster: ["alex"], colors: {}, sharedMachineUser: "ensembleworks-agent", enforcement: "enforce", unavailable: null,
  machines: [
    { kind: "person", hostId: "h1", hostName: "ew-lab-002-alex", person: alex, conflict: null },
    { kind: "team", hostId: "h2", hostName: "ew-main", conflict: null },
  ],
};
const app = await loadPluginApp(() => import("./app.js"));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("says who you start as, and explains on click when the machine is checked", async () => {
  const banner = app.composerCustomizations.find((entry) => entry.id === "ownership-banner")!.banners![0]!;
  renderSlot(banner, {}, {
    rpc: { identity_machines: () => list },
    composer: { scope: { kind: "new-thread", projectId: "project-1" } },
  });
  expect(await screen.findByText("Starting as Alex Rivera")).toBeTruthy();
  expect(screen.getByText(/Yours: ew-lab-002-alex · Team: ew-main/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /refused at Send/ }));
  const dialog = await screen.findByRole("dialog", { name: "When the machine is checked" });
  expect(dialog.textContent).toContain("More: Identity settings › People & machines › Rules");
  expect(within(dialog).queryByRole("button")).toBeNull();
});
```

  (If `MachineList` requires fields not shown, copy them from `header-ownership.test.tsx`'s
  fixture. If `renderSlot`'s options type differs, adapt to the SDK's
  `RenderSlotOptions` — `composer: { scope, text?, attachmentCount? }`.)
  Run both files — expect FAIL.
- [ ] **`ownership-labels.ts`:**
  `export type OwnershipBanner = { title: string; detail: string; note?: { text: string; term: GlossaryId } };`
  (`import type { GlossaryId } from "./lib/glossary.js";`). Rewrite `composerBanner`:

```ts
export function composerBanner(input: { … unchanged … }): OwnershipBanner {
  const attributionOnly = { text: "Attribution only.", term: "attribution-only" } as const;
  if (input.me !== null && input.provenance === "self-selected") {
    return { title: `Starting as ${input.me.displayName}`, detail: "Chosen in this browser.", note: attributionOnly };
  }
  if (input.me !== null && input.provenance === "configured-fallback") {
    return { title: `Starting as ${input.me.displayName}`, detail: "From the fallback email.", note: attributionOnly };
  }
  if (input.me === null) {
    return {
      title: "Starting as an unrecognised sign-in",
      detail: "Threads you start show no starter until your email is in Identity's directory.",
    };
  }
  const mine = input.machines
    .filter((host) => host.kind === "person" && host.person.person === input.me?.person)
    .map((host) => host.hostName);
  const team = input.machines.filter((host) => host.kind === "team").map((host) => host.hostName);
  const detail = [
    mine.length > 0 ? `Yours: ${mine.join(", ")}` : "No machines of yours known yet",
    team.length > 0 ? `Team: ${team.join(", ")}` : null,
  ].filter((part): part is string => part !== null).join(" · ");
  // What happens at Send is the only part the mode changes, and the one thing this banner
  // can always answer truthfully; the popover says why it cannot check the machine itself.
  const text = input.enforcement === "enforce"
    ? "Starting on someone else's machine is refused at Send."
    : input.enforcement === "audit"
      ? "In audit mode, starting on someone else's machine is logged, then goes ahead."
      : "Starting on someone else's machine is recorded, not refused.";
  return { title: `Starting as ${input.me.displayName}`, detail, note: { text, term: "composer-check" } };
}
```

  Keep the function's doc comment (it explains S3-lite); trim it to match. Rewrite
  `readOnlyBanner`'s three returns: every one gains
  `note: { text: "Own-thread rule", term: "rule-own-thread" }`; off detail
  `` `Meant for ${name} to drive; enforcement is off, so nothing stops you.` ``; audit detail
  `` `Meant for ${name} to drive. In audit mode a message from you here is logged as a would-refuse, then goes through.` ``;
  enforce title and detail unchanged. Replace "rule B" in the doc comments with "the
  own-thread rule".
- [ ] **`app.tsx`:**
  - `BannerBody` takes `{ title, detail, note }: OwnershipBanner & { suffix?: string }` and renders:

```tsx
<div style={{ display: "flex", flexDirection: "column", fontSize: 12, gap: 2, lineHeight: 1.4 }}>
  <span style={{ fontWeight: 600 }}>{title}</span>
  <span style={{ color: "var(--muted-foreground)" }}>
    {detail}
    {note === undefined ? null : <> <Explain term={note.term}>{note.text}</Explain></>}
    {suffix}
  </span>
</div>
```

  - `StartingAsBanner`: `<BannerBody {...banner} suffix={list.unavailable === null ? undefined : ` ${list.unavailable}.`} />`.
  - `ReadOnlyThreadBanner`: `<BannerBody {...banner} />`. Replace "Rule B" in its doc
    comment with "the own-thread rule".
  - `identityFooter(me: WhoAmI | null): ReactNode`:

```tsx
function identityFooter(me: WhoAmI | null): ReactNode {
  if (me?.provenance === "self-selected" && me.person) {
    return <>You are shown as {me.person.displayName}, chosen in this browser — <Explain term="attribution-only">attribution only</Explain>.</>;
  }
  if (me?.provenance === "configured-fallback" && me.person) {
    return <>You are shown as {me.person.displayName} from the fallback email — <Explain term="attribution-only">attribution only</Explain>.</>;
  }
  if (me?.person) return `You are ${me.person.displayName}, from your Access email.`;
  if (me?.email) return `Your Access email, ${me.email}, is not in Identity's directory.`;
  return "You are anonymous here.";
}
```

    It stays inside the existing footer `<div>` (not a `<p>`). Import `ReactNode` as a type
    and `Explain` from `./components/Explain.js`.
- [ ] **`components/IdentityPicker.tsx`:**
  - Chosen status → `<>Shown as {me.person!.displayName} (chosen here; <Explain term="attribution-only">attribution only</Explain>).</>`
  - Unavailable → `` `Browser names are unavailable: ${pickerProblem(me.picker.status)}.` ``
  - Errors: add

```ts
/** A refusal reason from the server, as the end of a sentence. */
function prepareProblem(reason: string): string {
  if (reason === "upstream-identity") return "your Access email already names you";
  if (reason === "not-in-directory") return "that name is no longer in the directory";
  if ((PICKER_STATUSES as readonly string[]).includes(reason)) return pickerProblem(reason as PickerStatus);
  return reason;
}
```

    (import `PICKER_STATUSES` and the `PickerStatus` type from `../settings-admin.js`; check
    the server's `identity_prepare_selection` refusal reasons and cover each one it can
    return), and use it:
    `` throw new Error(`Identity could not ${action === "select" ? "use" : "forget"} this name: ${prepareProblem(prepared.reason)}.`) ``.
    Leave the HTTP-failure and cookie messages as they are.
- [ ] Run `npx vitest run` — fix only the pinned tests.

**Pinned tests (Task 3)**
- `ownership-labels.test.ts` ≈ 143–226: as above.
- `settings-shell.test.tsx` ≈ 217/220 (the picker's "Shown as …" text is now split by a
  button): match the paragraph with a function matcher, keeping it exact —
  `screen.getAllByText((_, el) => el?.tagName === "P" && el.textContent === "Shown as Alex Rivera (chosen here; attribution only).")`
  with `toHaveLength(1)` (or the count the old assertion expected).
- `identity-picker.test.tsx` ≈ 35: `/attribution only/` still finds the text (now also a
  button name) — leave it unless it fails; if it fails, make the query target the
  paragraph as above.
- Grep the tests and `browser/smoke.mjs` for `could not prepare this choice`,
  `Browser identity is unavailable`, `Upstream header`, `by the configured fallback` and
  `Your machines:` and update any hit to the new copy (at plan time only
  `ownership-labels.test.ts` pins one of them).

- [ ] **Composer screen in the browser harness.**
  - `browser/runtime.ts`: `export let ComposerBanner: ComponentType<Record<string, never>>;`.
    Change the shim's `composer.customize` to capture the new-thread banner:

```ts
composer: {
  customize: (entry: { id: string; banners?: ReadonlyArray<{ component: ComponentType<any> }>; [key: string]: unknown }) => {
    if (entry.id === "ownership-banner") ComposerBanner = entry.banners![0]!.component;
  },
},
```

    (update the `definePluginApp` parameter type to match). After `hosts` is declared add
    `const composerMachines: MachineList = { ...machines, me: alex, meProvenance: "upstream-header", machines: hosts, enforcement: "enforce" };`
    and at the top of `rpc.call`, before the settings branch:
    `if (screen === "composer" && method === "identity_machines") return composerMachines;`
  - `browser/main.tsx`: import `ComposerBanner`; when `screen === "composer"` render
    `<main style={{ padding: 16 }}><div style={{ border: "1px solid var(--border, #ccc)", borderRadius: 8, padding: 12 }}><ComposerBanner /></div></main>`.
  - `browser/smoke.mjs`: for `[[320, "light"], [390, "light"], [390, "dark"]]` with
    `hasTouch: true` (match how the file sets width and colour scheme): open
    `?screen=composer`; `Starting as Alex Rivera` is visible; `document.documentElement.scrollWidth === width`;
    screenshot `composer-{dark-}{w}.png`; tap the button named `/refused at Send/`; the
    dialog **When the machine is checked** is visible, contains
    `More: Identity settings › People & machines › Rules`, and its box lies within
    `[8, width − 8]`; screenshot `composer-{dark-}{w}-explain.png`; press Escape → no
    dialog and the trigger is focused; no page errors; log a PASS line like the others.
- [ ] Run the gate and the smoke; look at the composer screenshots.
- [ ] Commit (explicit paths: every file listed under **Files** plus the tests touched) —
  message `feat(identity): explain terms in banners, header and picker`.

**Deliverable:** the composer banners, the header popover's footer and the picker say one
short thing and explain the rest on click, with "More" naming the settings tab in words;
gate green; smoke green or recorded as blocked.

---

## Out of scope

- A deep link from outside settings into a settings tab (BB has no such API).
- Hiding or grouping BB's generated Configuration form.
- Any change to what the guardrail decides, what is logged, or any RPC shape.
- Renaming data fields (`dealt`, rule ids) or log line formats.
