# Identity plugin settings: three UX directions

*Design research, 25 Sep 2026. Nothing was implemented, and no code or settings were changed.*
Interactive mockup: [2026-09-26-identity-settings-mockup.html](2026-09-26-identity-settings-mockup.html). It has 12 screens across three directions, a compare page and 5 confirm dialogs, with desktop, narrow-sidebar and mobile views in light and dark.

## What shapes every direction

These are host facts, taken from the BB plugin SDK and `plugins/identity`:

- **Two surfaces, fixed order.** BB renders the generated, autosaving *Configuration* form (the 8 `bb.settings.define` fields) **above** the plugin's `app.slots.settingsSection`. It also renders the section's title itself. A plugin can't group, collapse, hide or reorder generated fields.
- **Writes need an RPC.** `useSettings` is read-only. A section can change settings only through its own RPC calling `settings.experimental_set`. That API is experimental, and under the high-trust model anyone on the server can reach it.
- **People are managed in infrastructure.** The directory is rendered by Ansible from `ew_bb_people`, so the UI must not pretend to edit it. Colours are Identity's own data and are editable.
- **Precedence:** Access header → valid browser selection → `fallbackEmail` → anonymous. A stale, expired or invalid selection becomes **anonymous** and never falls through to the fallback. Only the Access header can be refused by the guardrail. Fallback and browser names are labels.
- **Machine ownership:** `teamMachines` → pin → name suffix → unclaimed. There is no unpin API today, and conflicts are only reported when Identity loads.
- **Guardrail rules:**
  - A: starting a thread on another person's machine.
  - B: a follow-up by someone who didn't start the thread.
  - C: an automation off a team machine. Rule C is blind to `threads.send` into an existing thread, which arrives unstamped.
  - Identity-less dispatches are always allowed. `audit` and `enforce` compute the same `decideGuardrail` result; only the action differs. Audit output goes to `bb.log` only, per the owner's 18 Sep decision that there is no UI log.
- **Diagnostics that exist:**
  - request-context self-test legs: patch, email and cookie
  - picker readiness chain: off, origin not configured, signing key unavailable, cookie bridge unavailable, ready
  - the attribution ledger (2,000 threads) and the queue ledger (1,000)
  - routes: `/whoami`, `/host-pins`, `/thread-ownership`, `/thread-starter`

Every element in the mockup carries one of three labels: **Exists today**, **New Identity code**, or **Needs BB core API** (dashed purple). A header toggle hides them all.

## The three directions

### 1 · Setup path: "What do I set up next?"
- **IA:** an ordered rail of six steps: Server profile → People → Machines → Browser names → Guardrail → Check. Each step shows a live status (icon plus text) and names what it depends on. The rail doubles as a dashboard on return visits.
- **First run:** "How do people reach this BB server?" has three answers: Cloudflare Access (detected from the request), Direct, and Only me. Choosing one previews a *Now → Recommended* table, and nothing is written until you press Apply.
- **Browser names:** the picker's readiness chain sits beside the precedence ladder, with a "you are here" marker and the stale-choice exception.
- **Audit vs enforce:** Off, Audit and Enforce are shown as three stages of one decision. A pre-Enforce checklist names the people who would be refused (for example, Priya because of a pin conflict), not just a count.
- **Diagnostics:** the Check step shows the self-test legs, the picker chain, config lint and a copy of redacted diagnostics. The failing step turns red on the rail.
- **Responsive:** on desktop the rail is 220px beside the panel. On narrow and mobile it becomes a horizontal stepper.
- **Accessibility:** the rail is an `<ol>` with `aria-current="step"`.
- **Pros:** the best first run; dependencies are explicit; staged rollout is the natural home for audit.
- **Cons:** returning admins have to walk the steps to find one fact. It can feel "finished" when People are managed in infrastructure, and colours get squeezed.
- **Complexity and migration:** medium. The section id changes from `people` to `setup`.

### 2 · People & machines directory: "Who or what is this, and why?"
- **IA:** an identity bar ("You: Sam Okafor · from the Access email, read as-is") above four tabs: People · Machines · This browser · Rules & health.
- **Provenance:** every fact carries *from* (Access email, picker, suffix rule, pin, teamMachines) and *counts for* (attribution, guardrail, machine owner).
- **People:** a master-detail view with a "Recognised by" table and a colour radiogroup; colour clashes warn but are never refused. People are read-only, with a "copy `ew_bb_people` entry" action and a static "managed in infrastructure" notice.
- **Machines:** a filterable table. Conflicts, stale pins, missing team machines and unclaimed hosts appear as rows with inline, confirmed actions: Keep, Re-pin, Unpin, Make or remove team machine.
- **This browser:** walks through the five selection states (valid, expired, stale, outranked, key rotated) against the ladder.
- **Directory error:** a parse error takes over the section and states its effect ("everyone is anonymous, nothing is refused") and both fixes.
- **Responsive:** master-detail stacks, and the machine table becomes labelled cards below a 720px container.
- **Pros:** answers real support questions directly; a natural evolution of today's roster; provenance sits where the fact lives.
- **Cons:** a weaker first run; rules and health are secondary; the most surface to build.
- **Complexity and migration:** medium–high. The section id stays `people`.

### 3 · Trust & operations console: "Can I trust what it does?"
- **IA:** a non-dismissible trust band ("A guardrail, not a lock") above four tabs: Guardrail · Explain & simulate · Coverage · Health.
- **Explain & simulate:**
  - "Why am I shown as…?" traces which rung of the precedence ladder decided.
  - A simulator (who × what × machine) runs a browser copy of `decideGuardrail` and shows Off / Audit / Enforce side by side, including the abridged refusal text.
- **Coverage:** every attribution path is marked Checked, Seen after, Logged only or Blind. This covers Send-now, terminals, raw API calls and the `threads.send` blind spot.
- **Health:** self-test, picker chain, directory and machine state, ledger fill, config lint, and fallback-email guidance.
- **Evidence panel (blocked):** the most valuable part is the would-refuse counts and the recent list. It needs a BB core log query **and** a reversal of the no-UI-log decision, so it is drawn dashed.
- **Responsive:** tiles go from 3 columns to 1, and the coverage table becomes cards.
- **Accessibility:** simulator output is an `aria-live` table.
- **Pros:** the hardest of the three to overstate security with, and great for support.
- **Cons:** its headline value is blocked. It is intimidating for a laptop setup, and People and colours are demoted.
- **Complexity and migration:** high with the evidence panel, medium without it. People would need a second section.

## Comparison matrix

| Criterion | 1 · Setup path | 2 · Directory | 3 · Trust console |
|---|---|---|---|
| Question it answers first | "What do I set up next?" | "Who or what is this, and why?" | "Can I trust what it does?" |
| First run | **Profile question → recommendations** | Empty states with pointers | Health lint lists what's missing |
| Returning admin | Rail works as a dashboard; facts buried in steps | **One click to the person or machine** | Good for incidents, poor for "who owns X?" |
| Precedence and the anonymous rule | Ladder beside the picker | **Per-browser trace, 5 states** | "Why am I shown as…?" trace |
| Stale mappings and conflicts | Checklist before Enforce | **Inline rows with safe actions** | Counted in Health |
| Honesty about audit vs enforce | Stages of one decision | Rules tab (secondary) | **Trust band, blind spots, simulator** |
| Diagnostics | Check step | Via Rules & health | **Full Health screen** |
| Narrow sidebar and mobile | **Stepper scrolls; panel works well** | Tables → cards, master-detail stacks | Stacks well; simulator is dense |
| Blocked on BB core or decisions | **Low** | Low–medium (provenance, host owner) | High (log query + owner decision) |
| Build complexity | **Medium** | Medium–high | Medium without evidence, high with it |
| Migration from today | Section re-purposed | **Today's roster becomes the People tab** | Needs a second section for People |

**Bold** marks the strongest cell in each row.

## Recommendation

Use **Direction 2 as the backbone**: People · Machines · This browser · Health, with the section id kept as `people`. It grows out of today's roster and matches the questions admins actually bring back.

**Take from Direction 1:**
- A compact **readiness strip** above the tabs (Profile · People · Machines · Browser names · Guardrail · Check). Each item has a live status and links to its tab.
- The **server-profile question**, shown only on first run.
- The **precedence ladder** in This browser.

**Take from Direction 3:**
- The **Health tab**: self-test legs, picker chain, ledgers, config lint and redacted diagnostics.
- The **coverage map**, as a disclosure under Rules.
- The **guardrail simulator**, which reuses the pure `decideGuardrail`.
- The trust-band sentence, carried by the identity bar.

**Defer:** in-UI audit evidence (counts and the recent would-refuse list). Ship the copyable `jq` command over `bb plugin logs identity` until BB core has a log query and the owner revisits the 18 Sep decision.

Why not a single direction? Direction 1 is best on day one and worst on day thirty. Direction 3's best feature is the one that's blocked.

### Phased migration
1. **Existing data only.** Identity bar; People tab with "Recognised by"; a read-only Machines tab (`identity_machines`, `/host-pins`); This browser (`/whoami`, picker); Health (`/request-context-self-test`, `pickerStatus`); a static coverage map; the in-browser simulator.
2. **New Identity code.**
   - A settings-write RPC over `experimental_set` covering teamMachines, enforcement, the picker, origin and key rotation.
   - Pin resolution: keep, re-pin or unpin.
   - Re-running the self-test.
   - Ledger counts.
   - Redacted diagnostics.
   - The readiness strip and the first-run question.
3. **BB core, asked for upstream.** See the table below.

### BB core APIs these designs would need

| API | Unlocks |
|---|---|
| Group, collapse or hide generated fields | One coherent page instead of form + section |
| Setting provenance or lock | A data-driven "managed by Ansible" notice with edits blocked |
| Host owner field | Ends name-suffix guessing and pin conflicts |
| Plugin log query | Would-refuse counts and the recent list (also needs an owner decision) |
| Send-now dispatch hook | Moves Send-now from "Seen after" to "Checked" |
| Stamp `threads.send` | Closes rule C's blind spot |
| Settings deep link or route | "Open Identity settings" from chips and banners |
| Composer visibility of the selected host | A rule A warning before sending, not a refusal after |

## Safeguards used throughout

- **Dialogs.** Every destructive or trust-changing action opens a native `<dialog>` with Cancel focused. The dialog names its consequence, becomes a bottom sheet on compact viewports and returns focus to the element that opened it.
- **Enforce** requires an acknowledgement checkbox and names who would be refused right away. Cancelling reverts the mode to Audit.
- **Rotate signing key** requires typing `rotate` and says that the number of affected browsers is unknowable.
- **Set fallback email** requires "Only one person uses this server" and warns that the server looks shared.
- **Re-pin and remove-from-team** spell out the rule A or rule C consequence.
- **Status** is always shown as icon plus text, never colour alone. Tabs follow the ARIA tabs pattern with arrow keys, touch targets are at least 40–44px, and reduced motion is respected.

## Validation performed

- **Structure** (jsdom): 12 screens, 5 dialogs; every id is unique; all anchors, `aria-*` references, labels, `data-go` and dialog targets resolve; no remote resources; no script errors. Labels: 21 needs-core, 17 new-code, 10 exists-today.
- **Render** (headless Chromium): 12 screens × 3 viewports × 2 themes with **0 element overflows**, and no page-level horizontal overflow at 1280, 900, 700 or 390px.
- **Interaction:**
  - Dialogs gate their confirm button; Escape and Cancel revert Enforce to Audit with focus on the checked radio; Confirm shows the "Mockup only: nothing was changed" toast.
  - Option tabs move with the arrow keys.
  - `#opt-trust` and `#d-machines` deep links work.
  - With JavaScript off, all 12 screens are visible.

## Limitations

- **No live diagnostics.** The query that would have read Identity's live diagnostics (self-test result, `/host-pins`, `/whoami`, log summary) was denied by the permission classifier. The screens are based on the code and the redacted live config, not on live runtime state.
- **SDK version gap.** The plugin declares SDK 0.4.104 but 0.4.84 is installed. Whether `useSdk` and `updateSettings` exist was not confirmed, so all writes are drawn as a new Identity RPC over `experimental_set`.
- **Not tested inside BB.** The mockup was checked in headless Chromium, not inside BB's inline-vis iframe. That iframe has an opaque origin, so `history` and storage calls are guarded. The clipboard may be unavailable there, in which case Copy shows a fallback message.
- **Approximate host chrome.** BB's navigation and generated form are approximations of the host, not captures.
- **Illustrative data.** Counts, names, hosts and timestamps are samples, and only Alex's person detail is drawn.
