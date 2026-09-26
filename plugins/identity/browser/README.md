# Identity browser interaction checks

This fixture mounts the **registered header component from app.tsx**, with real
React and Radix Popover and a read-only SDK/RPC substitute. It never contacts a
BB server. It covers 320px, 390px and 1280px viewports, long machine names, exact
preservation of `headerChip` text (including audit mode and renamed-machine
warnings), People-coloured owner/viewer bubbles, live viewer names and typing,
unknown starters, automation, agents, and the starter's own machine.

The gesture is Tab → Enter → Escape → Space → close button → touch/click →
outside click. Invariants: a named, at-least-44px touch target no wider than
60px for the owner plus two viewer bubbles, visible keyboard focus, correct
expanded state, focus enters the popover and returns on Escape/close, outside
click keeps focus at its destination, complete ownership and viewer details,
and no horizontal overflow. Screenshots are saved to `/tmp/identity-header-screenshots` (override
with `IDENTITY_SCREENSHOTS`).

The picker check also mounts Identity's app-wide overlay on a fixture screen with no
thread header. It verifies the prompt at 320px and 390px, dismissal across a reload,
and the thread-details picker as a manual fallback.

The settings check mounts the People & machines settings section; see below.

## Settings section (`?screen=settings`)

`?screen=settings` mounts the **registered People & machines settings section** alone,
over fixture answers for its reads (`identity_settings_overview`, `identity_roster`,
`identity_whoami`, `identity_machines`) and its writes, which all succeed without
changing anything. The overview is built with the real `readiness`, `lintConfig` and
`enforceRisks`, and the fixture carries a pin conflict, an unclaimed host with a long
unbreakable name, a long display name and a long unbreakable email, so the layout is
tested against the text that breaks it.

At 320px and 390px (touch) and 1280px, plus 390px with a dark colour scheme, the smoke:

- opens each of the five tabs (with every disclosure opened) and requires the page to be
  exactly the viewport wide, no element inside `.identity-settings` to be wider than its
  box (except a `pre`/`code` that scrolls on purpose), and every button, input and select
  to be at least 40px tall (a checkbox or radio is measured by its label, which is the
  target);
- focuses the selected tab and checks ArrowRight, End and Home move both the selection
  and focus;
- selects **Enforce**: the dialog opens with Cancel focused and inside the viewport, and
  Escape closes it with **Audit** still checked and focused;
- opens **Rotate signing key**: the confirm button stays disabled until `rotate` is typed;
- requires no page errors.

Screenshots: `settings-<width>-<tab>.png` per width and tab (`people`, `machines`,
`browser`, `rules`, `health`), `settings-<width>-enforce-dialog.png`,
`settings-<width>-rotate-dialog.png`, and the same names prefixed `settings-dark-` for the
dark pass. To see the RED this catches, set `overflow-wrap: normal` in `identity.css`:
the 320px Machines tab then fails `page width` (the unclaimed host name overflows).

## Running it

From this checkout, with workspace dependencies and Chromium installed:

```sh
cd plugins/identity
npm ci
npm run typecheck
npm test
npm run test:browser
```

The isolated plugin declares Playwright and receives Vite through Vitest. To use
an existing Chromium installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable. Otherwise install the
version requested by the repository's Playwright (`bunx playwright install chromium`).

The SDK's jsdom harness tests the actual header registration, accessible trigger
labels, desktop hover text, and chosen/dealt colors with adaptive ink. Opening
Radix in that harness stalled in this environment; the interaction tests above
therefore run in Chromium, without mocking Radix or Floating UI.

## Contract scope

ux-contract: none — The canvas interaction-contract runners seed canvas scenes
and observe the canvas editor/room. They cannot mount BB plugin header slots or
supply Identity RPC context. These surfaces are covered by the standalone browser
interaction contract above; no shared Obs member is added.

## Red/green evidence (2026-09-19)

Base: `09edf75ad22ead7e33c912d975ae6210e669a0d1` (main, including PRs #110/#111).
Before implementing the fix, the focused header test failed all seven cases;
the first failure was:

```text
Unable to find role="button" and name "Started by Erin Example · team machine. Show ownership details"
```

After implementing the fix, the original `app.tsx` was restored temporarily and
the browser contract was run against it. Verbatim failure:

```text
ExpectError: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: 'Started by Erin Example · team machine. Show ownership details' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found
```

Restoring the fix passes all three viewport gestures and all five ownership
variants. A reviewer can independently reproduce from the feature commit:

```sh
# Run from the repository root, with a clean checkout.
git restore --source=09edf75ad22ead7e33c912d975ae6210e669a0d1 -- plugins/identity/app.tsx
(cd plugins/identity && npm run test:browser) # RED: missing ownership button
git restore -- plugins/identity/app.tsx
(cd plugins/identity && npm run test:browser) # GREEN
```

This verifies the standalone slots, not the surrounding production BB header, settings
page or multi-plugin layout. No installed plugin or production settings are changed.

## Combined ownership/presence RED (2026-09-19)

Before merging the two header actions, the focused contract failed eight cases.
The first failure was:

```text
expected [ 'thread-presence', …(1) ] to not include 'thread-presence'
```

The next failure showed the missing combined accessible trigger:

```text
Unable to find role="button" and name "Started by Erin Example · team machine. Alex and Sam are here; Sam is typing. Show thread details"
```

After the implementation, the focused contract and Chromium gestures at 320px,
390px and 1280px pass with a single registered header action. Reverting
`app.tsx` to the parent commit reproduces RED; restoring it returns GREEN.
