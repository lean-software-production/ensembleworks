// CLICK-AND-HOLD TO DRAG A TAB INTO A NEW ORDER — the whole decision, with no
// DOM anywhere near it.
//
// Owner request, 2026-09-05: "click and hold can drag there order". The tab
// strip draws the page name and nothing else, which made it READ-ONLY for
// order: reordering was popover-only (the ◂ / ▸ micro-buttons) until this.
// Those buttons STAY — a drag is not reachable from a keyboard, so the popover
// is what keeps reordering keyboard-reachable, and canvas/pages/
// PageSwitcher.tsx's own comment plus tests/page-switcher-tabs.test.ts pin that
// split.
//
// FOUR GESTURES NOW SHARE ONE TAB and telling them apart is the entire risk:
//   * click        -> switch page   (press and release, travel under the arm distance)
//   * drag         -> reorder       (travel exceeds it before the release)
//   * dbl-click    -> rename        (pre-existing; the drag had to coexist with it)
//   * right-click / long-press -> a context menu (canvas/pages/page-tab-menu.ts,
//     landed 2026-09-06; this module owns the SEAM with it — see
//     `tabDragBlocksContextMenu` and the `context-menu` event below)
//
// HOW THE LONG PRESS IS SHARED WITH THAT MENU, which is the question a tablet
// will answer badly if it is left implicit. On touch, a stationary long press
// is the platform's context-menu gesture, and it is also the obvious reading of
// the owner's words "click and hold". This module resolves the collision by
// ARMING ON MOVEMENT AND ONLY ON MOVEMENT: there is no timer here and no
// injected clock, so a press that does not move is, and stays, merely
// `pressed` — nothing is lifted, nothing is previewed, and
// `tabDragBlocksContextMenu` says the menu may open. A press that HAS moved
// past the arm distance owns the gesture and blocks the menu instead. The
// consequence, stated so it is a choice rather than a discovery: "hold still
// and the tab picks itself up" is NOT a thing this gesture does, on any input
// device. You hold and you MOVE. tests/tab-drag.test.ts asserts the absence of
// a clock directly from this file's source, because a timer-armed drag would
// pass every behavioural test in that file and only fail on a tablet.
//
// WHY A MODULE AND NOT HANDLERS IN THE .tsx — the same reason canvas/pages/
// page-tabs-fit.ts, canvas/pages/chrome-dock.ts and canvas/dock/squeeze.ts give
// in their own headers: this project has no jsdom and may not gain one, so a
// threshold, a state transition or a drop-position rule written inline in a
// component is a decision NO TEST CAN EVER READ, and a mutation can move it in
// either direction with the whole suite green. tests/tab-drag.test.ts holds
// every rule below, and separately pins that PageSwitcher.tsx only ever HANDS
// this module the numbers it measured.
//
// NOTHING HERE WAS SEEN IN A BROWSER. There is none in this spike. Every claim
// about what the user observes is an inference from this source plus the
// documented semantics of pointer events, and is marked as such where it is
// made.
//
// THE DOC IS NOT TOUCHED UNTIL THE DROP. That is what makes cancellation cheap
// rather than a rollback problem: while a drag is in flight the only thing that
// has changed is this state and the paint derived from it, so a cancelled drag
// "restores the original order" by forgetting a preview, and there is no write
// to undo. It is also why the effect type below has exactly one doc-bearing
// member (`drop`) — a test can assert that no cancelled script ever produces
// one, which is the honest form of "a cancelled drag writes nothing".

/**
 * How far the pointer must travel across a tab before the press becomes a drag
 * rather than a click.
 *
 * FOUR SCREEN PIXELS, and the same four canvas-editor's `DRAG_THRESHOLD`
 * (canvas-editor/src/input.ts) carries — which that file in turn read out of
 * tldraw's own `dragDistanceSquared: 16`. Declared here rather than imported,
 * the way PAGE_TABS_MIN_PX declines to import SQUEEZE_ROOMY_MIN_PX: that number
 * is about a drawing gesture on a canvas at some zoom, this one is about a
 * finger on a ~30px-tall chrome control, and two numbers that agree today are
 * not one number. Coupling them would mean a retune of the select tool silently
 * changed when a tab click stops being a click.
 *
 * HORIZONTAL TRAVEL ONLY, which is the real divergence from that sibling —
 * canvas-editor compares a squared EUCLIDEAN distance, and there is no `y` in
 * this module's event type at all. The strip is a horizontal row and the
 * reorder axis is horizontal, so a finger sliding down a tab is a shaky click,
 * not a drag, and treating it as one would arm a reorder nobody asked for. The
 * cost, stated so it is a choice rather than an oversight: a press that moves
 * 200px straight DOWN and releases is still a click, and switches the page.
 *
 * NOT TUNED FOR TOUCH. tldraw carries a larger `coarseDragDistanceSquared` for
 * coarse pointers and this does not distinguish them — the same gap
 * canvas-editor/src/input.ts records for itself.
 */
export const TAB_DRAG_ARM_PX = 4;

/**
 * Which `PointerEvent.button` may begin a gesture on a tab.
 *
 * ZERO — the PRIMARY button (left mouse, a touch contact, a pen tip). Every
 * other value is refused outright, and the refusal is what leaves the SECONDARY
 * button (2) free for the tab's context menu: a right-click that pressed
 * the tab would either be eaten by this machine's click suppression or would
 * switch the page underneath the menu it just opened.
 *
 * `button`, NOT `buttons`. They differ by one character and are both numbers,
 * so nothing but a test catches the confusion: `buttons` is a BITMASK of what
 * is currently held, and reads 1 while the primary button is down — a machine
 * that compared the mask to this constant would refuse every real press and
 * arm on none being held at all.
 */
export const TAB_DRAG_PRIMARY_BUTTON = 0;

/**
 * What the tab tells the browser about touch gestures that start on it.
 *
 * `none` — the browser may not interpret a touch here as a scroll or a zoom, so
 * every move is delivered to us instead of being replaced by a `pointercancel`
 * partway through the drag.
 *
 * THE COST, AND IT IS REAL: the strip itself is `overflowX: auto`
 * (PageSwitcher.tsx — pages are unbounded, so the strip scrolls rather than
 * wrapping), and with `none` on every tab a touch user can no longer scroll
 * that strip by dragging a TAB; they must drag the strip's own background, or
 * use the Pages popover, which lists every page at any width and is reached
 * from bb's command palette ("Canvas: go to page…") now that its toolbar button
 * has gone. `pan-x` was the
 * alternative and is strictly worse for this gesture: it hands a horizontal
 * finger drag to the scroller, which is precisely the theft this exists to
 * prevent, and horizontal is the only direction this drag has.
 *
 * INFERENCE FROM THE `touch-action` SPEC, NOT AN OBSERVATION — no browser has
 * been pointed at this.
 */
export const TAB_DRAG_TOUCH_ACTION = "none" as const;

/**
 * Whether the tab's own label can be text-selected.
 *
 * `none`, because a pointer sweeping across a row of text labels is exactly the
 * gesture that selects text, and a drag that leaves three page names
 * highlighted behind it looks like a fault. This is about the GESTURE, not
 * about paint, which is why it is declared beside the threshold rather than
 * with the tab's colours.
 */
export const TAB_DRAG_USER_SELECT = "none" as const;

/** How solid the tab under the pointer is while it is being dragged. Below 1,
 * so the tab reads as lifted off the strip and the gap it came from stays
 * legible underneath it; not so low that its name becomes unreadable, since the
 * name is how the user knows which tab they have hold of. CHOSEN, NOT
 * MEASURED — there is no browser here. */
export const TAB_DRAGGED_OPACITY = 0.7;

/** How wide the insertion line between two tabs is drawn. Two pixels rather
 * than one: a hairline against a strip that already draws hairline tab borders
 * is not distinguishable at a glance, and this mark has to be read mid-gesture.
 * READ OFF THE STRIP'S EXISTING BORDERS, NOT MEASURED IN A BROWSER. */
export const TAB_DROP_LINE_WIDTH_PX = 2;

/** The geometry the insertion mark is drawn with. Plain CSS values, the same
 * shape `tabDragPaint` below hands back, so this module stays free of React —
 * the component spreads it into a style.
 *
 * WHY THE WIDTH TRAVELS AS PART OF AN OBJECT rather than being read off
 * TAB_DROP_LINE_WIDTH_PX at the point of paint: this project has no jsdom, so a
 * `width:` written in the .tsx is a value no test can reach. On 2026-09-06 the
 * constant was pinned and its USE was not, and `width: 0` — a drag with no
 * visible drop indicator at all — shipped with the whole suite green. Bundled
 * here, the value a test asserts IS the value the strip draws.
 *
 * `flexShrink: 0` is part of the same fact and not a layout detail: the mark is
 * a real flex item in a row that can overflow, and a mark allowed to shrink is
 * squeezed to nothing exactly when the strip is fullest. `alignSelf: "stretch"`
 * makes it the full height of the row, so it reads as a seam between two tabs
 * rather than a dot beside them. INFERRED FROM THE FLEX LAYOUT, NOT OBSERVED —
 * there is no browser here. */
export interface TabDropLinePaint {
  readonly width: number;
  readonly flexShrink: number;
  readonly alignSelf: "stretch";
}

export const TAB_DROP_LINE_PAINT: TabDropLinePaint = {
  width: TAB_DROP_LINE_WIDTH_PX,
  flexShrink: 0,
  alignSelf: "stretch",
};

/** One tab's horizontal extent, in the same coordinate space as the pointer the
 * caller reports (client pixels, in the shipped wiring). Only the horizontal
 * edges, because only the horizontal axis takes part in the decision. */
export interface TabBox {
  readonly left: number;
  readonly right: number;
}

/**
 * The gesture's state.
 *
 * `suppress` is the one phase that is not obvious, and it exists because
 * SWITCHING IS ROUTED THROUGH THE `click` EVENT rather than through pointerup.
 * That routing is deliberate: a `<button>` activated from the keyboard (Enter or
 * Space on a focused tab) fires `click` with no pointer gesture in front of it,
 * so switching on pointerup would have made the tab strip mouse-only. The price
 * is that a drag's release ALSO produces a click, which would switch the page
 * the user was only trying to move — so a released or cancelled drag parks in
 * `suppress` until that one click arrives and is eaten.
 *
 * THE SUPPRESSION IS ALSO WHAT MAKES POINTER CAPTURE SAFE. With capture, a
 * release over a DIFFERENT tab retargets the pointerup, and engines disagree
 * about which element the following `click` lands on — or whether one is
 * dispatched at all. Both outcomes are handled: any tab's click is eaten while
 * suppressing, and a suppression nobody ever came to consume is cleared by the
 * next press. READ OFF THE POINTER-EVENTS SPEC AND THE KNOWN ENGINE
 * DISAGREEMENT, NOT OBSERVED.
 */
export type TabDragState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "pressed";
      readonly index: number;
      readonly id: string;
      readonly pointerId: number;
      readonly startX: number;
    }
  | {
      readonly phase: "dragging";
      readonly index: number;
      readonly id: string;
      readonly pointerId: number;
      readonly startX: number;
      readonly pointerX: number;
    }
  | { readonly phase: "suppress" };

export const IDLE_TAB_DRAG: TabDragState = { phase: "idle" };

export type TabDragEvent =
  /** A pointer went down on the tab at `index` (in the order drawn). `button`
   * is the raw `PointerEvent.button` — see TAB_DRAG_PRIMARY_BUTTON. */
  | {
      readonly type: "down";
      readonly index: number;
      readonly id: string;
      readonly pointerId: number;
      readonly button: number;
      readonly x: number;
    }
  | { readonly type: "move"; readonly pointerId: number; readonly x: number }
  | { readonly type: "up"; readonly pointerId: number; readonly x: number }
  /** Escape, `pointercancel`, `lostpointercapture`, or the window losing focus.
   * Deliberately ONE event for all four: they mean the same thing to this
   * machine, and four near-identical branches is how they drift apart. */
  | { readonly type: "cancel" }
  /**
   * A CONTEXT MENU HAS TAKEN THIS GESTURE — a right-click, a touch long press,
   * or the keyboard context-menu key, accepted by the caller after
   * `tabDragBlocksContextMenu` allowed it (Task 2, 2026-09-06).
   *
   * NOT the same event as `cancel`, and the difference is one line of the
   * transition below: a cancelled press goes to `idle` because it lifted
   * nothing and a suppression there would eat a legitimate tap, but a press
   * CONSUMED BY A MENU still owes a suppression. On touch the long press that
   * raised the menu is a live `pressed` gesture whose pointerup — and, on some
   * engines, whose following `click` — are still to come; letting that click
   * through would switch the page underneath the menu the same gesture just
   * opened.
   */
  | { readonly type: "context-menu" }
  /** The button was activated — by a mouse click, a tap, or the keyboard. */
  | { readonly type: "click"; readonly index: number; readonly id: string };

export type TabDragEffect =
  | { readonly kind: "none" }
  | { readonly kind: "switch"; readonly id: string }
  /** THE ONLY EFFECT THAT REACHES THE DOCUMENT. `pointerX` is where the pointer
   * was at the release; the caller turns it into a position with `dropIndexAt`
   * against the boxes it measured. */
  | {
      readonly kind: "drop";
      readonly id: string;
      readonly index: number;
      readonly pointerX: number;
    };

const NONE: TabDragEffect = { kind: "none" };

/** Is this number something that was actually measured? The same test and the
 * same wording as chrome-dock.ts, page-tabs-fit.ts and popover-place.ts — NaN
 * and Infinity are what a failed read gives back. Zero is a legitimate
 * client-x, so unlike the width modules this one does not exclude it. */
function isMeasurement(n: number): boolean {
  return Number.isFinite(n);
}

/**
 * One transition. Returns the next state and what the caller owes the document.
 *
 * The shape canvas/pages/page-menu.ts's `nextPageMenuOpen` and canvas/dock/
 * expand.ts's `nextExpanded` already use in this plugin, extended with an
 * effect because this machine has to say more than "am I open".
 *
 * ONE POINTER OWNS THE GESTURE. Moves, releases and further presses from any
 * other `pointerId` are ignored outright — a second finger landing on the strip
 * mid-drag must not steer or drop the tab the first one has hold of. That rule
 * is NOT sufficient on its own for a mouse, which reports the SAME pointerId
 * for every button, so the button check below carries the other half.
 */
export function nextTabDrag(
  state: TabDragState,
  event: TabDragEvent,
): { readonly state: TabDragState; readonly effect: TabDragEffect } {
  switch (event.type) {
    case "down": {
      // ONLY THE PRIMARY BUTTON. Checked FIRST, so a secondary press is inert
      // in every phase: it cannot begin a gesture from idle, and it cannot
      // clear a pending suppression either — the click that suppression is
      // owed to has not arrived yet, and a right-click does not produce one.
      if (event.button !== TAB_DRAG_PRIMARY_BUTTON) return { state, effect: NONE };
      // FIRST POINTER WINS. From `suppress` this is also the escape hatch for a
      // suppression nothing ever came to consume: a `pointercancel` usually
      // produces NO click at all, so without this reset the suppression would
      // sit there and eat the user's next real tap.
      if (state.phase === "pressed" || state.phase === "dragging") {
        return { state, effect: NONE };
      }
      if (!isMeasurement(event.x)) return { state: IDLE_TAB_DRAG, effect: NONE };
      return {
        state: {
          phase: "pressed",
          index: event.index,
          id: event.id,
          pointerId: event.pointerId,
          startX: event.x,
        },
        effect: NONE,
      };
    }

    case "move": {
      if (state.phase !== "pressed" && state.phase !== "dragging") {
        return { state, effect: NONE };
      }
      if (event.pointerId !== state.pointerId) return { state, effect: NONE };
      // A failed read must never be the reason a drag arms or the preview
      // jumps — the same call nextPageTabsVisible and nextChromeDockFit make
      // for a width that is not a measurement.
      if (!isMeasurement(event.x)) return { state, effect: NONE };
      if (state.phase === "dragging") {
        return { state: { ...state, pointerX: event.x }, effect: NONE };
      }
      if (Math.abs(event.x - state.startX) <= TAB_DRAG_ARM_PX) {
        return { state, effect: NONE };
      }
      return {
        state: {
          phase: "dragging",
          index: state.index,
          id: state.id,
          pointerId: state.pointerId,
          startX: state.startX,
          pointerX: event.x,
        },
        effect: NONE,
      };
    }

    case "up": {
      if (state.phase === "pressed") {
        if (event.pointerId !== state.pointerId) return { state, effect: NONE };
        // NO EFFECT HERE. The `click` that follows is what switches — see the
        // note on `suppress` in TabDragState.
        return { state: IDLE_TAB_DRAG, effect: NONE };
      }
      if (state.phase !== "dragging") return { state, effect: NONE };
      if (event.pointerId !== state.pointerId) return { state, effect: NONE };
      return {
        state: { phase: "suppress" },
        effect: {
          kind: "drop",
          id: state.id,
          index: state.index,
          // An unmeasurable release x falls back to the last place the pointer
          // was actually seen, which is where the user last saw the preview —
          // dropping the whole gesture instead would silently discard a drag
          // the user watched land.
          pointerX: isMeasurement(event.x) ? event.x : state.pointerX,
        },
      };
    }

    case "cancel": {
      // A CANCELLED DRAG STILL OWES A SUPPRESSION. Escape arrives while the
      // finger is still down; the pointerup and click that follow would land on
      // an idle machine and switch the page — the cancelled gesture having a
      // visible effect after all.
      if (state.phase === "dragging") return { state: { phase: "suppress" }, effect: NONE };
      // A press that never armed lifted nothing and previewed nothing, so there
      // is nothing to take back, and a suppression here would silently eat a
      // legitimate tap.
      if (state.phase === "pressed") return { state: IDLE_TAB_DRAG, effect: NONE };
      // Idle stays idle, and — load-bearing — `suppress` STAYS SUPPRESSING.
      // `lostpointercapture` fires between the drop's pointerup and its click,
      // so clearing the suppression here would let that click through and
      // switch the page on every completed reorder.
      return { state, effect: NONE };
    }

    case "context-menu": {
      // A PRESS CONSUMED BY A MENU OWES A SUPPRESSION, which is the whole
      // reason this is not spelled `cancel`. The finger is still down: its
      // pointerup is still to come, and engines differ on whether a `click`
      // follows a long press that raised a context menu. Parking in `suppress`
      // eats that click if it arrives, and — because `suppress` holds no
      // pointer and is cleared by the next `down` (see the "down" case) — costs
      // nothing at all if it does not.
      if (state.phase === "pressed") return { state: { phase: "suppress" }, effect: NONE };
      // `dragging` never reaches here: the caller asks
      // `tabDragBlocksContextMenu` first and does not open a menu over a
      // reorder in flight. Leaving the state alone rather than cancelling is
      // the tolerant answer if it ever does — a drag the user is still holding
      // must not be silently dropped by an event that was refused upstream.
      // `idle` and `suppress` are already where this would put them.
      return { state, effect: NONE };
    }

    case "click": {
      if (state.phase === "suppress") return { state: IDLE_TAB_DRAG, effect: NONE };
      // A click arriving mid-gesture is not a thing the browser does (it comes
      // after the release); ignoring it is the tolerant answer rather than a
      // branch anybody relies on.
      if (state.phase !== "idle") return { state, effect: NONE };
      return { state: IDLE_TAB_DRAG, effect: { kind: "switch", id: event.id } };
    }
  }
}

/**
 * Is a gesture in flight — i.e. is there anything for Escape or a lost window to
 * cancel?
 *
 * `suppress` is NOT active: it is waiting for a click to eat, not holding a
 * pointer, so the window-level listeners can come down and an Escape there must
 * not re-enter a cancel. Exported so that predicate is a tested rule rather than
 * a `state.phase !== "idle"` written in the component's effect, where nothing
 * could read it.
 */
export function tabDragIsActive(state: TabDragState): boolean {
  return state.phase === "pressed" || state.phase === "dragging";
}

/**
 * Has this press earned a FRESH MEASUREMENT of the strip?
 *
 * Answered from the states either side of a `down`: `true` only when the press
 * was ACCEPTED — i.e. it moved a machine that held no pointer into `pressed`.
 *
 * WHY THIS IS A RULE AND NOT AN `if` IN THE COMPONENT. The panel's boxes are
 * measured once per gesture, and every other guarantee here rests on that: the
 * strip scrolls, the dragged tab carries a `transform` that
 * `getBoundingClientRect` includes, and the drop line is a real flex item that
 * has already pushed its neighbours right. A measurement taken mid-gesture
 * reads that moved layout.
 *
 * "ONCE PER GESTURE" IS NOT THE SAME AS "ONE MEASURE CALL IN THE FILE", and the
 * difference was a real bug found on 2026-09-06: the component measured on
 * EVERY pointerdown on ANY tab, ahead of this machine's button and
 * first-pointer-wins refusals. A second finger, or a right-click, landing
 * mid-drag re-measured the mid-drag layout — after which the drop the user was
 * aiming at computed to `null`, no ReorderPage was emitted and the drop line
 * vanished. The gesture appeared to die.
 *
 * REFUSALS LOOK LIKE A NO-OP TRANSITION, which is what this reads: `nextTabDrag`
 * returns the state it was given for every press it declines. So the two
 * accepting cases are the only ones — from `idle`, and from `suppress` (which
 * holds no pointer; it is only owed a click), and both of those are genuinely
 * the start of a new gesture.
 */
export function tabDragTakesMeasurement(before: TabDragState, after: TabDragState): boolean {
  if (after.phase !== "pressed") return false;
  return before.phase === "idle" || before.phase === "suppress";
}

/**
 * May a `contextmenu` be allowed to open on this tab right now?
 *
 * THE SEAM WITH canvas/pages/page-tab-menu.ts, and the reason it lives here
 * rather than there: only this machine knows whether a finger that has been
 * down for 500ms has already picked a tab up. The rule is narrow on purpose —
 *
 *   * `dragging` -> BLOCK. A menu over a tab that is currently following the
 *     pointer is both a broken-looking overlay and a second, unasked-for effect
 *     from one gesture.
 *   * everything else -> ALLOW. A stationary long press is only ever `pressed`
 *     (this module has no timer, see the file header), so the touch
 *     context-menu gesture is uncontested; a plain right-click never presses at
 *     all (TAB_DRAG_PRIMARY_BUTTON); and `suppress` is already past the
 *     release.
 *
 * What a caller DOES with `true` is the caller's business; this only says
 * whether a reorder is in progress. What the SHIPPED caller does, stated so the
 * pair reads as one policy: PageSwitcher.tsx always `preventDefault()`s the
 * browser's own menu (ours replaces it), and consults this to decide whether
 * OURS opens. A `false` here is also the caller's cue to hand the machine the
 * `context-menu` event above, which is what stops the press the menu just
 * consumed from switching the page on its way out.
 */
export function tabDragBlocksContextMenu(state: TabDragState): boolean {
  return state.phase === "dragging";
}

/**
 * Where the dragged tab would land: an index into the list AS IT WILL BE after
 * the move, or `null` for "this drop changes nothing, emit no intent at all".
 *
 * THE RULE IS MIDPOINTS. The pointer has passed a tab when it is past that tab's
 * horizontal centre, so the insertion slot is simply how many midpoints lie to
 * the pointer's left. Converting that slot to a final index subtracts one when
 * the slot is to the right of the dragged tab, because removing the tab from its
 * old position shifts everything after it down by one.
 *
 * A CONSEQUENCE WORTH NAMING, because it is what makes the gesture feel right:
 * dropping anywhere over your OWN tab — and over the near half of each
 * neighbour — is `null`. A swap needs the pointer to cross a NEIGHBOUR's
 * midpoint, not merely to leave the tab's own box, so a small overshoot does not
 * reorder the document.
 *
 * `null` RATHER THAN THE CURRENT INDEX for the no-op case, deliberately: a
 * same-value ReorderPage is a doc write, a sync frame to every peer and an undo
 * entry that undoes nothing anybody can see — the same refusal
 * `switchPageIntents` makes for switching to the page you are already on.
 *
 * REFUSES ANYTHING IT WAS NOT HONESTLY GIVEN: an unmeasured pointer, a box whose
 * edges came back NaN (what `getBoundingClientRect` on a detached node reports),
 * an index naming no tab, and a strip with fewer than two tabs. A failed
 * measurement must never be the reason the document is reordered.
 *
 * THE BOXES ARE THE PRE-DRAG LAYOUT. PageSwitcher.tsx measures once, at the
 * press, and the strip is never scrolled by this gesture (that choice, and why,
 * is in the panel's own note) — so nothing this function is given moves under
 * the pointer mid-gesture.
 */
export function dropIndexAt(
  boxes: readonly TabBox[],
  pointerX: number,
  draggedIndex: number,
): number | null {
  if (boxes.length < 2) return null;
  if (!Number.isInteger(draggedIndex)) return null;
  if (draggedIndex < 0 || draggedIndex >= boxes.length) return null;
  if (!isMeasurement(pointerX)) return null;

  let slot = 0;
  for (const box of boxes) {
    if (!isMeasurement(box.left) || !isMeasurement(box.right)) return null;
    if (pointerX > (box.left + box.right) / 2) slot += 1;
  }

  const target = slot > draggedIndex ? slot - 1 : slot;
  return target === draggedIndex ? null : target;
}

/** What the strip draws while a drag is in flight. `dropSlot` is a gap in the
 * strip AS DRAWN (0 before the first tab, `tabCount` after the last) and is NOT
 * the drop index — dragging the first tab to the end is drop index `n-1` and
 * slot `n`, and conflating the two draws the line one gap short. */
export interface TabDragPresentation {
  /** Which tab is lifted, or null when nothing is being dragged. */
  readonly draggedIndex: number | null;
  /** How far that tab has been carried from where it started, in pixels. */
  readonly translateX: number;
  readonly dropSlot: number | null;
}

const NOT_DRAGGING: TabDragPresentation = {
  draggedIndex: null,
  translateX: 0,
  dropSlot: null,
};

/**
 * The feedback rule: what the strip should look like, given the gesture and the
 * boxes the component measured.
 *
 * NOTHING IS LIFTED WHILE THE GESTURE IS ONLY `pressed`. That is the whole
 * reason a click still feels like a click, AND the visible half of the
 * long-press resolution: a finger resting on a tab waiting for a context menu
 * must not see the tab start to move.
 *
 * A DRAG WITH NO VALID DROP STILL LIFTS ITS TAB. `dropSlot` goes null (no line
 * is drawn, because there is no gap to draw it in), but the tab keeps following
 * the pointer — the user needs to see that the gesture is live and that
 * releasing here would change nothing, rather than see it apparently die.
 */
export function tabDragPresentation(
  state: TabDragState,
  boxes: readonly TabBox[],
): TabDragPresentation {
  if (state.phase !== "dragging") return NOT_DRAGGING;
  const target = dropIndexAt(boxes, state.pointerX, state.index);
  return {
    draggedIndex: state.index,
    translateX: state.pointerX - state.startX,
    dropSlot: target === null ? null : target >= state.index ? target + 1 : target,
  };
}

/** Does the insertion line go in the gap before tab `slot`? (`slot ===
 * tabCount` is the gap after the last tab.) A one-line rule, exported rather
 * than written as `presentation.dropSlot === index` in the .tsx, because that
 * `===` is the off-by-one this module's slot/index distinction exists to
 * prevent and it must be somewhere a test can invert it. */
export function showsDropLineAt(presentation: TabDragPresentation, slot: number): boolean {
  return presentation.dropSlot === slot;
}

/** The style facts one tab wears. Plain CSS values rather than React's
 * `CSSProperties`, so this module stays free of React entirely — the component
 * spreads it. */
export interface TabDragPaint {
  readonly transform: string;
  readonly opacity: number;
  readonly touchAction: typeof TAB_DRAG_TOUCH_ACTION;
  readonly userSelect: typeof TAB_DRAG_USER_SELECT;
}

/**
 * How tab `index` is painted right now.
 *
 * A FUNCTION OF THE PRESENTATION, NOT A BRANCH IN THE COMPONENT — the same
 * shape `pageTabStyle(row.current)` already has in PageSwitcher.tsx. The two
 * gesture defences ride on EVERY tab at all times, not only the dragged one:
 * `touch-action` has to be in force BEFORE the finger lands, since by the time
 * we know it is a drag the browser has already decided whether to keep the
 * gesture.
 */
export function tabDragPaint(
  presentation: TabDragPresentation,
  index: number,
): TabDragPaint {
  const dragged = presentation.draggedIndex === index;
  return {
    transform: dragged ? `translateX(${presentation.translateX}px)` : "none",
    opacity: dragged ? TAB_DRAGGED_OPACITY : 1,
    touchAction: TAB_DRAG_TOUCH_ACTION,
    userSelect: TAB_DRAG_USER_SELECT,
  };
}
