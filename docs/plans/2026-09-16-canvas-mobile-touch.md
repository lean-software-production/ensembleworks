# Canvas on a phone — multi-touch and finger-sized targets (2026-09-16)

Building on the bb thread frame work (PR #98,
`docs/plans/2026-09-15-bb-thread-frame.md`). Everything below is verified at
the unit/FSM-contract level only: **no browser exists in the environment this
was built in**, and nothing here has been seen running. The "unverified"
section at the end is the list to work through on a real phone.

## 1. Pinch to zoom, two-finger pan

The browser has no pinch event: it delivers two independent pointer streams and
leaves "are these one gesture?" to the application. With `touch-action: none` on
the viewport (required — without it every touch drag dies at its first move as a
`pointercancel`), a second finger was simply another `pointerdown`, so the
select tool saw one pointer teleporting and dragged whatever was under it.

**`canvas-editor/src/multi-touch.ts`** is the recognizer: pure, clock-free,
DOM-free. `reduceMultiTouch(state, pointerEvent)` returns the next state plus
three decisions — forward this event to the tool or not, cancel the in-flight
single-finger gesture or not, and the `PinchInputEvent` (if any) this event
produced. **`camera.ts`'s `applyPinch`** consumes that: zoom about the previous
midpoint (composed from `zoomAboutPoint`, never re-deriving the camera algebra)
plus the midpoint's own screen travel as a pan, at the post-zoom scale.

Decisions worth naming:

- **Touch only.** A mouse cannot produce two simultaneous pointers; a pen plus a
  finger is palm contact, not a pinch. An event with no `pointerType` is the
  single-pointer world every pre-existing test lives in and passes straight
  through, which is what makes the whole change additive.
- **It lives in canvas-editor, not in the Viewport.** canvas-react's boundary
  rule is that the renderer decides nothing; a threshold or a state transition
  written in a component is a rule no house test can read. `Viewport.tsx` is
  UNCHANGED by this work — `dom-events.ts` now forwards `pointerId`/
  `pointerType` (its own header had predicted this: "widening the event union
  for multi-pointer is a Phase 4 concern that starts in canvas-editor's
  input.ts, not here") and canvas-ui's `useCanvasSession` drives the reducer,
  in the same position in the funnel where it already consumes `wheel`.
- **The FSM contract runner drives the same reducer**, so a pinch contract
  exercises the shipped recognizer rather than a re-implementation.
- **Suppression outlives the pinch.** When one finger lifts, the other is still
  down and no `pointerdown` will arrive for it again; forwarding its moves would
  hand the tool a drag that began nowhere. Suppression ends when the LAST finger
  lifts. Cost, stated as a choice: you cannot slide from a pinch into a
  one-finger drag; lift both and start again.
- **A pinch ABANDONS the gesture it interrupted, it does not revert it** — the
  same policy `cancelActiveTool` already applies to blur/pointercancel/tool
  switch. `pinch-does-not-drag-shapes` asserts the exact pre-pinch displacement
  to pin this in both directions.
- **No zoom-rate clamp**, unlike `applyWheel`'s `ZOOM_DELTA_CLAMP`. A wheel tick
  is a discrete notch of unknown size, so it needs normalizing; a pinch's factor
  IS the physical ratio between the fingers, and clamping it would make the
  canvas lag the hand. Poison guards (non-finite, non-positive factor) are the
  same as `applyWheel`'s.

## 2. Long press to reorder a page tab

`plugins/canvas/canvas/pages/tab-drag.ts` armed a reorder on MOVEMENT. The strip
is `overflowX: auto` (pages are unbounded), so on touch that was the same
gesture as scrolling it — and reordering won every time, which is why every tab
carried `touch-action: none` and a touch user could not scroll the strip by
dragging a tab at all (the module's own note recorded that cost honestly).

Inverted for coarse pointers only: a finger arms on a **400ms** long press and a
finger that **moves first** is handed to the scroller (past a 10px slop — a
resting finger jitters, so the mouse's 4px would hand away an ordinary
tap-and-hold). A mouse is unchanged. `touch-action` is `pan-x` at rest and
`none` once a drag is in flight.

`tab-drag.ts` stays **clock-free** — a source guard asserts that directly,
because a timer-armed rule inside it would pass every behavioural test in the
suite and fail only on a tablet. The long press arrives as a `hold` EVENT; the
`setTimeout` lives in the component, where new source guards pin that it is set
only for a finger that took the press, takes its duration from the module's
constant, and is cleared on a fresh press, on any transition out of `pressed`,
and on unmount.

**The cost is the touch context menu**: a stationary long press was the
platform's menu gesture and this takes it (400ms deliberately beats the
platform's ~500ms). On a phone the per-tab menu is now reachable by the keyboard
context-menu key, a right-click on a device that has one, or the Pages popover.
That is a trade the owner may want to revisit.

## 3. Finger-sized hit targets

Two different signals, deliberately:

- **Canvas hit tests read the EVENT's `pointerType`** (`transform.ts`'s
  `hitTolerancePx`, `select.ts`'s `bbthreadDividerMargin`). A device-level
  `(pointer: coarse)` query is wrong for half the events a touchscreen laptop
  delivers.
- **Rendered chrome reads the DEVICE** (`canvas-ui/src/pointer-metrics.ts`). A
  box has to have one size, chosen before any pointer arrives; there is no event
  to read. Its known failure — a mouse user on a touchscreen laptop getting
  finger-sized buttons — is the harmless direction of the error.

What changed: the bbthread divider band is now zoom-AND-pointer derived (which
also fixes it being a 1.5-screen-pixel target at 25% zoom **for a mouse**);
transform handles widen to a 44px target for a touch pointer; the tool rail's
32px buttons and the zoom pill's 28px buttons reach 44px on a coarse-primary
device.

Known gap, declared rather than smuggled: **the rendered handle glyph stays 8px**
while its hit target grows. The glyph is drawn per SELECTION (no pointer event in
hand) and the tolerance is chosen per EVENT, so there is no single correct glyph
size to mirror. Growing an invisible target past its visible mark is standard
touch practice, but a coarse-pointer user sees an 8px square and grabs a 44px
one. A coarse-device glyph size is a follow-up.

## Contracts

Four new, all `level: 'fsm'`, all run RED first (verbatim failures in the PR
body): `pinch-zooms-about-the-midpoint`, `pinch-does-not-drag-shapes`,
`bbthread-divider-is-finger-sized`, `selection-handles-are-finger-sized`.

`GestureOp`'s three pointer ops gain optional `pointer` (identity) and
`pointerType`. The browser runner (`e2e/lib/contracts.ts`) **throws** on either
rather than degrading: Playwright's `mouse` API has one pointer and no
pointerType, so running a two-finger declaration as a one-finger mouse gesture
would report a PASS for a contract never exercised. Wiring it for real needs
CDP's `Input.dispatchTouchEvent` or a `hasTouch` context — a separate unit.

## Unverified — the list for a real phone

1. **Does the pinch feel right?** Rate, direction, and whether the
   zoom-plus-pan composition tracks the hand. Only a hand can answer.
2. **Does the page-tab `touch-action` re-latch?** It is evaluated when the touch
   BEGINS, so a tab that starts `pan-x` and becomes `none` 400ms later may or may
   not keep receiving moves. If an engine refuses, the armed drag is taken as a
   `pointercancel` — the tab goes back, nothing is written, the strip scrolls.
   Safe, but touch reordering would silently not work. **Check this first.**
3. **Does the browser hand us both touches at all**, or does it claim the second
   for its own page zoom? `touch-action: none` on the viewport says it should
   not, but the BB panel's own chrome sits above it.
4. **Is 400ms right**, and does it actually beat the platform menu on iOS Safari
   (which is less predictable here than Chrome).
5. **The 44px chrome on a 360px-wide panel** — the tool rail is 10 tools tall and
   already scrolls; whether that reads as usable or as a scrolling wall is a
   visual judgement.
