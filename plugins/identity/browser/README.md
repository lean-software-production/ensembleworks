# Ownership and presence header interaction check

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
supply Identity RPC context. This surface is covered by the standalone browser
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

This verifies the standalone slot, not the surrounding production BB header or
multi-plugin layout. No installed plugin or production settings are changed.

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
