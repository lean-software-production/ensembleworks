// Run: npx vitest run tests/tab-drag.test.ts
//
// CLICK-AND-HOLD TO DRAG A TAB INTO A NEW ORDER — every decision in it.
//
// Owner request, 2026-09-05: "click and hold can drag there order". The tab
// strip draws the page name and nothing else, which left it READ-ONLY for
// order: reordering was popover-only (the ◂ / ▸ micro-buttons) until this.
//
// FOUR GESTURES NOW SHARE ONE TAB and telling them apart is the whole risk:
//   * click        -> switch page   (press and release, travel under the arm distance)
//   * drag         -> reorder       (travel exceeds it before the release)
//   * dbl-click    -> rename        (pre-existing; the drag had to coexist with it)
//   * right-click / long-press -> a context menu (NOT built here; Task 2)
// That discrimination is a DECISION — a threshold, a button rule, and a rule
// about what a release means — so it lives in canvas/pages/tab-drag.ts where a
// test can reach it, not inline in PageSwitcher.tsx. This project has no jsdom,
// so a branch written in the .tsx is a branch nothing can ever check.
//
// The second half of this file is the SOURCE GUARD on the .tsx: that the
// component only ever HANDS these decisions the numbers it measured, and never
// re-decides. Guards read the file with comments stripped (tests/lib/source.ts)
// and are bounded to one object literal or one call's argument list each, with
// negative assertions beside them — this codebase has shipped prefix-pinning
// guards three times and the most recent one passed with two roles SWAPPED.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bodyStatements,
  callArguments,
  callsTo,
  countInCode,
  effectStatements,
  initializerText,
  objectLiteralText,
  stripComments,
  topLevelEffectIn,
} from "./lib/source.js";
import {
  IDLE_TAB_DRAG,
  TAB_DRAGGED_OPACITY,
  TAB_DRAG_ARM_PX,
  TAB_DRAG_PRIMARY_BUTTON,
  TAB_DRAG_TOUCH_ACTION,
  TAB_DRAG_USER_SELECT,
  TAB_DROP_LINE_PAINT,
  TAB_DROP_LINE_WIDTH_PX,
  dropIndexAt,
  nextTabDrag,
  showsDropLineAt,
  tabDragBlocksContextMenu,
  tabDragIsActive,
  tabDragPaint,
  tabDragPresentation,
  tabDragTakesMeasurement,
  type TabBox,
  type TabDragEvent,
  type TabDragState,
} from "../canvas/pages/tab-drag.js";

/** Three 100px tabs, laid out edge to edge, in CLIENT pixels. Midpoints: 50,
 * 150, 250 — every absolute assertion below is against these numbers, not
 * against an expression in the module's own constants. */
const THREE_BOXES: readonly TabBox[] = [
  { left: 0, right: 100 },
  { left: 100, right: 200 },
  { left: 200, right: 300 },
];

/** Play a script of events from idle, returning every effect in order. */
function run(events: readonly TabDragEvent[]): {
  state: TabDragState;
  effects: ReturnType<typeof nextTabDrag>["effect"][];
} {
  let state: TabDragState = IDLE_TAB_DRAG;
  const effects: ReturnType<typeof nextTabDrag>["effect"][] = [];
  for (const event of events) {
    const step = nextTabDrag(state, event);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects };
}

const down = (
  index: number,
  id: string,
  x: number,
  pointerId = 1,
  button = 0,
): TabDragEvent => ({ type: "down", index, id, pointerId, button, x });
const move = (x: number, pointerId = 1): TabDragEvent => ({ type: "move", pointerId, x });
const up = (x: number, pointerId = 1): TabDragEvent => ({ type: "up", pointerId, x });
const click = (index: number, id: string): TabDragEvent => ({ type: "click", index, id });
const cancel: TabDragEvent = { type: "cancel" };
const contextMenu: TabDragEvent = { type: "context-menu" };

describe("the arm distance — what separates a click from a drag", () => {
  it("is 4 screen pixels, the same number canvas-editor's DRAG_THRESHOLD carries", () => {
    // Pinned as a VALUE, not as "some number": the whole discrimination is
    // this constant, and a guard that only checked it existed would survive it
    // being retuned to 400 (every drag becomes a click) or to 0 (every click
    // becomes a drag).
    expect(TAB_DRAG_ARM_PX).toBe(4);
  });

  it("calls 3 absolute pixels of travel a click and 40 a drag", () => {
    // THE ABSOLUTE STATEMENT. Every other assertion in this describe is
    // written relative to TAB_DRAG_ARM_PX, so retuning the constant would keep
    // them all green while the gesture became unusable. These two numbers are
    // literals on purpose: a 3px hand-wobble on a ~30px-tall chrome control
    // must stay a click, and a deliberate 40px sweep must be a drag, whatever
    // the constant is later tuned to.
    expect(run([down(0, "page:p", 100), move(103)]).state.phase).toBe("pressed");
    expect(run([down(0, "page:p", 100), move(140)]).state.phase).toBe("dragging");
  });

  it("measures HORIZONTAL travel only, so a vertical wobble stays a click", () => {
    // The strip is a horizontal row and the reorder axis is horizontal, so a
    // finger sliding down a tab is a shaky click, not a drag. There is no `y`
    // in the event type at all — this is that decision made structurally. The
    // cost, stated so it is a choice: a press that slides 200px straight DOWN
    // and releases is still a click, and switches the page.
    const script = run([down(0, "page:p", 100), move(102), up(102)]);
    expect(script.effects.at(-1)).toEqual({ kind: "none" });
    expect(run([down(0, "page:p", 100), move(102)]).state.phase).toBe("pressed");
  });

  it("arms only once travel EXCEEDS the distance, not at it", () => {
    expect(run([down(0, "page:p", 100), move(104)]).state.phase).toBe("pressed");
    expect(run([down(0, "page:p", 100), move(105)]).state.phase).toBe("dragging");
    // Symmetric leftwards.
    expect(run([down(0, "page:p", 100), move(96)]).state.phase).toBe("pressed");
    expect(run([down(0, "page:p", 100), move(95)]).state.phase).toBe("dragging");
  });

  it("never arms on a hold alone — no timer, no clock", () => {
    // AN EXPLICIT DECISION, AND THE ONE TASK 2 RESTS ON. A press-and-wait
    // arming would need an injected clock and would take the one gesture the
    // platform reserves for a CONTEXT MENU on touch. Movement is the only arm,
    // so a long press that never moves stays available to Task 2's menu.
    const held = run([
      down(0, "page:p", 100),
      ...Array.from({ length: 50 }, () => move(100)),
    ]);
    expect(held.state.phase).toBe("pressed");
    expect(held.effects.every((e) => e.kind === "none")).toBe(true);
  });

  it("ignores a move whose x is not a measurement", () => {
    // A failed read must never be the reason a drag starts — the same call
    // page-tabs-fit.ts and chrome-dock.ts make for a failed width.
    expect(run([down(0, "page:p", 100), move(Number.NaN)]).state.phase).toBe("pressed");
    expect(run([down(0, "page:p", 100), move(Number.POSITIVE_INFINITY)]).state.phase).toBe(
      "pressed",
    );
  });
});

// ---------------------------------------------------------------------------
// THE BUTTON RULE, and the touch long-press it exists to protect.
describe("only the primary button begins a gesture", () => {
  it("names the primary button as 0 — PointerEvent.button, not the .buttons mask", () => {
    // ABSOLUTE, because the two are one keystroke apart and both are numbers:
    // `event.buttons` reports 1 for the primary button held, so a module that
    // compared the mask against 0 would arm on NOTHING being pressed and
    // refuse every real press.
    expect(TAB_DRAG_PRIMARY_BUTTON).toBe(0);
  });

  it("a right-click never starts a drag, and never presses the tab", () => {
    // THE TASK-2 GUARANTEE. `button: 2` is the secondary button, which is what
    // a context menu is opened with; if it pressed the tab, the menu's own
    // pointerup/click would be eaten or would switch the page.
    const script = run([down(0, "page:p", 100, 1, 2)]);
    expect(script.state).toEqual(IDLE_TAB_DRAG);
    expect(script.effects).toEqual([{ kind: "none" }]);
    // ...and moving after it still does nothing, so no reorder can follow.
    expect(run([down(0, "page:p", 100, 1, 2), move(280), up(280)]).state).toEqual(
      IDLE_TAB_DRAG,
    );
  });

  it("the middle button and a pen barrel button are refused too", () => {
    // Only 0 is accepted, rather than "anything but 2": a middle-click that
    // armed a reorder is a gesture nobody asked for, and a pen's barrel button
    // reports 5.
    expect(run([down(0, "page:p", 100, 1, 1)]).state).toEqual(IDLE_TAB_DRAG);
    expect(run([down(0, "page:p", 100, 1, 5)]).state).toEqual(IDLE_TAB_DRAG);
  });

  it("a secondary press mid-drag does not steer or drop the gesture", () => {
    // A MOUSE REPORTS ONE pointerId FOR EVERY BUTTON, so the "one pointer owns
    // the gesture" rule below cannot catch this on its own.
    const script = run([down(0, "page:p", 100), move(280), down(2, "page:r", 500, 1, 2)]);
    expect(script.state).toMatchObject({ phase: "dragging", index: 0, id: "page:p" });
  });
});

describe("the drag and the context menu do not fight for the long press", () => {
  it("leaves a long press that has not moved free for a menu to open on", () => {
    // ON TOUCH, LONG-PRESS IS BOTH "hold to drag" on some platforms AND the
    // platform's own context-menu gesture. This module resolves that by never
    // arming on time: after any amount of holding still, the gesture is only
    // `pressed`, nothing is lifted, and a `contextmenu` raised at 500ms is not
    // blocked. Task 2's menu can therefore own the stationary long press
    // outright, with no timer of its own to reconcile against one here.
    const held = run([down(0, "page:p", 100), move(100), move(100), move(100)]);
    expect(held.state.phase).toBe("pressed");
    expect(tabDragBlocksContextMenu(held.state)).toBe(false);
  });

  it("blocks a menu once the press has visibly become a drag", () => {
    // The other half: a finger that has already picked the tab up must not
    // ALSO get a menu at the 500ms mark, and no browser menu may appear over a
    // reorder in flight.
    const dragging = run([down(0, "page:p", 100), move(280)]).state;
    expect(tabDragBlocksContextMenu(dragging)).toBe(true);
  });

  it("a press CONSUMED by a menu parks in suppress, so its click cannot switch", () => {
    // THE OTHER HALF OF THE LONG-PRESS RESOLUTION, and the reason
    // `context-menu` is not spelled `cancel`. On touch the finger that raised
    // the menu is still down: its pointerup is still to come, and engines
    // differ on whether a `click` follows a long press that opened a context
    // menu. A cancelled press goes IDLE, so that click would switch the page
    // underneath the menu the same gesture just opened.
    const consumed = run([down(0, "page:p", 100), move(100), contextMenu]);
    expect(consumed.state).toEqual({ phase: "suppress" });
    expect(consumed.effects.every((effect) => effect.kind === "none")).toBe(true);
  });

  it("...and that suppression eats exactly one click, then gets out of the way", () => {
    const script = run([down(0, "page:p", 100), contextMenu, up(100), click(0, "page:p")]);
    expect(script.effects.every((effect) => effect.kind === "none")).toBe(true);
    expect(script.state).toEqual(IDLE_TAB_DRAG);
  });

  it("a right-click with no press behind it leaves the machine exactly where it was", () => {
    // The mouse path: `down` already refused the secondary button, so there is
    // no press to consume and nothing to suppress. A suppression here would
    // silently eat the user's next legitimate tap.
    expect(run([contextMenu]).state).toEqual(IDLE_TAB_DRAG);
    const afterDrop = run([down(0, "page:p", 100), move(280), up(280), contextMenu]);
    expect(afterDrop.state).toEqual({ phase: "suppress" });
  });

  it("never writes to the document, whatever it interrupts", () => {
    // The honest form of "opening the menu cancels an in-flight drag cleanly":
    // `drop` is the only effect that reaches the doc, and no script that ends
    // in a consumed press produces one.
    for (const script of [
      run([contextMenu]),
      run([down(0, "page:p", 100), contextMenu]),
      run([down(0, "page:p", 100), move(100), contextMenu, up(100)]),
      run([down(1, "page:q", 200), contextMenu, cancel, click(1, "page:q")]),
    ]) {
      expect(script.effects.filter((effect) => effect.kind === "drop")).toEqual([]);
    }
  });

  it("does not silently drop a reorder the user is still holding", () => {
    // Unreachable through the shipped caller — it asks
    // `tabDragBlocksContextMenu` first and refuses — so this pins the tolerant
    // answer rather than a path anybody relies on: the drag survives.
    const dragging = run([down(0, "page:p", 100), move(280), contextMenu]);
    expect(dragging.state).toMatchObject({ phase: "dragging", index: 0, id: "page:p" });
  });

  it("blocks nothing when no gesture is in flight", () => {
    // Idle and `suppress` alike: a menu opened from a plain right-click, or
    // after the drag has been released, is not this module's business.
    expect(tabDragBlocksContextMenu(IDLE_TAB_DRAG)).toBe(false);
    const afterDrop = run([down(0, "page:p", 100), move(280), up(280)]).state;
    expect(afterDrop.phase).toBe("suppress");
    expect(tabDragBlocksContextMenu(afterDrop)).toBe(false);
  });
});

describe("what a release means", () => {
  it("a sub-threshold press releases into a page switch", () => {
    // Routed through the CLICK, not through pointerup, so the keyboard path
    // survives: a focused tab activated with Enter or Space fires `click` with
    // no pointer gesture in front of it.
    const script = run([down(1, "page:q", 100), move(101), up(101), click(1, "page:q")]);
    expect(script.effects.at(-1)).toEqual({ kind: "switch", id: "page:q" });
    expect(script.state.phase).toBe("idle");
  });

  it("a keyboard activation with no pointer gesture in front of it switches", () => {
    expect(run([click(2, "page:r")]).effects).toEqual([{ kind: "switch", id: "page:r" }]);
  });

  it("a drag releases into a drop carrying the id, the index and the pointer", () => {
    const script = run([down(0, "page:p", 100), move(200), up(240)]);
    expect(script.effects.at(-1)).toEqual({
      kind: "drop",
      id: "page:p",
      index: 0,
      pointerX: 240,
    });
  });

  it("a drag that ends where it started SWITCHES NOTHING, and that is the call", () => {
    // THE DECISION, stated: once a gesture has visibly become a drag (the tab
    // lifted and followed the pointer), its release is a drop and never also a
    // click. Committing a page switch on the release of a gesture the user
    // used as a drag is a second, unasked-for effect. The drop itself is a
    // no-op (dropIndexAt returns null onto self), so the whole gesture writes
    // nothing and the page you were on is the page you stay on.
    const script = run([
      down(0, "page:p", 100),
      move(200),
      move(100),
      up(100),
      click(0, "page:p"),
    ]);
    expect(script.effects.at(-1)).toEqual({ kind: "none" });
    expect(dropIndexAt(THREE_BOXES, 100, 0)).toBeNull();
  });

  it("falls back to the last seen pointer when the release's x is not a measurement", () => {
    const script = run([down(0, "page:p", 100), move(240), up(Number.NaN)]);
    expect(script.effects.at(-1)).toEqual({
      kind: "drop",
      id: "page:p",
      index: 0,
      pointerX: 240,
    });
  });
});

describe("cancellation — a drag that never gets its pointerup", () => {
  it("writes nothing, because nothing is written before the drop", () => {
    // The strongest form this property can take here: the ONLY effect that
    // reaches the doc is `drop`, and no script that ends in a cancel ever
    // produces one. The preview is component state; the order is untouched
    // until the release, so "restore the original order" is "forget the
    // preview" and there is no write to undo.
    const script = run([down(0, "page:p", 100), move(280), cancel]);
    expect(script.effects.some((e) => e.kind === "drop")).toBe(false);
    expect(tabDragPresentation(script.state, THREE_BOXES).draggedIndex).toBeNull();
  });

  it("eats the click that a still-held pointer will produce on release", () => {
    // Escape while the finger is STILL DOWN. If the cancel simply went idle,
    // the pointerup and click that follow would land on an idle machine and
    // switch the page — the cancelled gesture having a visible effect after
    // all. So a cancelled DRAG parks in `suppress` until that click arrives.
    const script = run([
      down(0, "page:p", 100),
      move(280),
      cancel,
      up(280),
      click(0, "page:p"),
    ]);
    expect(script.effects.at(-1)).toEqual({ kind: "none" });
    expect(script.state.phase).toBe("idle");
  });

  it("a cancel BEFORE the drag armed leaves the click alone", () => {
    // Nothing was lifted and nothing was previewed, so there is nothing to
    // suppress — and a suppression here would silently eat a legitimate tap.
    const script = run([down(0, "page:p", 100), cancel, click(0, "page:p")]);
    expect(script.effects.at(-1)).toEqual({ kind: "switch", id: "page:p" });
  });

  it("a fresh press clears a suppression no click ever came to consume", () => {
    // The stranding this forbids: a pointercancel (the browser stealing the
    // gesture) usually produces NO click at all, so the suppression would sit
    // there and eat the user's next real tap. A new primary pointerdown always
    // resets.
    const script = run([
      down(0, "page:p", 100),
      move(280),
      cancel,
      down(1, "page:q", 100),
      up(100),
      click(1, "page:q"),
    ]);
    expect(script.effects.at(-1)).toEqual({ kind: "switch", id: "page:q" });
  });

  it("a cancel on an idle machine changes nothing", () => {
    // `lostpointercapture` fires after a NORMAL pointerup too, so the panel
    // wires it to cancel as a backstop; that must be a no-op, not a state
    // change that eats the click still on its way.
    expect(run([cancel]).state).toEqual(IDLE_TAB_DRAG);
    const script = run([down(1, "page:q", 100), up(100), cancel, click(1, "page:q")]);
    expect(script.effects.at(-1)).toEqual({ kind: "switch", id: "page:q" });
  });

  it("a cancel while suppressing keeps the suppression, so the drop's click is still eaten", () => {
    // The real order of events after a drag's release: pointerup, then
    // lostpointercapture (which the panel wires to `cancel`), THEN click. A
    // cancel that reset `suppress` to idle here would let that click through
    // and switch the page on every completed reorder.
    const script = run([
      down(0, "page:p", 100),
      move(280),
      up(280),
      cancel,
      click(0, "page:p"),
    ]);
    expect(script.effects.at(-1)).toEqual({ kind: "none" });
  });
});

describe("one pointer at a time", () => {
  it("ignores a second finger's move and release", () => {
    // A second touch must not steer or drop the gesture the first one owns.
    const script = run([down(0, "page:p", 100), move(280, 2), up(280, 2)]);
    expect(script.state.phase).toBe("pressed");
    expect(script.effects.every((e) => e.kind === "none")).toBe(true);
  });

  it("ignores a second finger's press — the first pointer keeps the tab", () => {
    const script = run([down(0, "page:p", 100), move(280), down(2, "page:r", 500, 2)]);
    expect(script.state).toMatchObject({ phase: "dragging", index: 0, id: "page:p" });
  });
});

describe("tabDragIsActive — when the window-level cancels are listening", () => {
  it("is true exactly while a gesture is in flight", () => {
    expect(tabDragIsActive(IDLE_TAB_DRAG)).toBe(false);
    expect(tabDragIsActive(run([down(0, "page:p", 100)]).state)).toBe(true);
    expect(tabDragIsActive(run([down(0, "page:p", 100), move(280)]).state)).toBe(true);
    // `suppress` is waiting for a click, not holding a gesture: Escape there
    // must not re-enter a cancel, and the listeners can come down.
    expect(tabDragIsActive(run([down(0, "page:p", 100), move(280), up(280)]).state)).toBe(
      false,
    );
  });
});

describe("dropIndexAt — where the tab lands", () => {
  it("puts the boundary at a tab's MIDPOINT, in absolute client pixels", () => {
    // ABSOLUTE, not relative to any constant: with tab 0 spanning 0..100 its
    // midpoint is 50, so a pointer at 49 has not passed it and one at 51 has.
    // A rule written against a tab's leading EDGE instead would answer the
    // same for both of these and differ only at 0 and 100.
    expect(dropIndexAt(THREE_BOXES, 49, 2)).toBe(0);
    expect(dropIndexAt(THREE_BOXES, 51, 2)).toBe(1);
  });

  it("drops onto self, anywhere over its own tab, as NO index at all", () => {
    // `null`, never "the index it already has": the caller must be unable to
    // emit a same-value ReorderPage, which is a doc write, a sync frame to
    // every peer and an undo entry that undoes nothing anybody can see.
    expect(dropIndexAt(THREE_BOXES, 110, 1)).toBeNull();
    expect(dropIndexAt(THREE_BOXES, 150, 1)).toBeNull();
    expect(dropIndexAt(THREE_BOXES, 190, 1)).toBeNull();
    // ...and half a tab either side of it, because a swap needs the pointer to
    // pass a NEIGHBOUR's midpoint, not merely leave its own box.
    expect(dropIndexAt(THREE_BOXES, 60, 1)).toBeNull();
    expect(dropIndexAt(THREE_BOXES, 240, 1)).toBeNull();
  });

  it("moves before the first tab", () => {
    expect(dropIndexAt(THREE_BOXES, 40, 1)).toBe(0);
    expect(dropIndexAt(THREE_BOXES, 40, 2)).toBe(0);
  });

  it("moves after the last tab", () => {
    expect(dropIndexAt(THREE_BOXES, 260, 0)).toBe(2);
    expect(dropIndexAt(THREE_BOXES, 260, 1)).toBe(2);
  });

  it("moves between two tabs", () => {
    // Past tab 1's midpoint but not tab 2's: the dragged head-of-strip tab
    // lands in the middle.
    expect(dropIndexAt(THREE_BOXES, 160, 0)).toBe(1);
    expect(dropIndexAt(THREE_BOXES, 140, 2)).toBe(1);
  });

  it("clamps a pointer beyond either end rather than running off the array", () => {
    expect(dropIndexAt(THREE_BOXES, -9999, 2)).toBe(0);
    expect(dropIndexAt(THREE_BOXES, 9999, 0)).toBe(2);
  });

  it("has no answer for an empty or single-tab strip", () => {
    expect(dropIndexAt([], 100, 0)).toBeNull();
    expect(dropIndexAt([{ left: 0, right: 100 }], 9999, 0)).toBeNull();
    expect(dropIndexAt([{ left: 0, right: 100 }], -9999, 0)).toBeNull();
  });

  it("refuses an index that names no tab", () => {
    expect(dropIndexAt(THREE_BOXES, 260, 5)).toBeNull();
    expect(dropIndexAt(THREE_BOXES, 260, -1)).toBeNull();
    expect(dropIndexAt(THREE_BOXES, 260, 1.5)).toBeNull();
  });

  it("refuses a pointer or a box that was never measured", () => {
    // A getBoundingClientRect on a detached node reports zeroes and a failed
    // read gives NaN; neither may be allowed to reorder the document.
    expect(dropIndexAt(THREE_BOXES, Number.NaN, 0)).toBeNull();
    expect(dropIndexAt(THREE_BOXES, Number.POSITIVE_INFINITY, 0)).toBeNull();
    expect(
      dropIndexAt([{ left: 0, right: Number.NaN }, ...THREE_BOXES.slice(1)], 260, 0),
    ).toBeNull();
  });
});

describe("the feedback rule while dragging", () => {
  it("lifts nothing and draws no line until the drag arms", () => {
    // The whole reason a click still feels like a click: a press alone must
    // not move the tab under the finger.
    const pressed = run([down(0, "page:p", 100), move(102)]).state;
    const p = tabDragPresentation(pressed, THREE_BOXES);
    expect(p).toEqual({ draggedIndex: null, translateX: 0, dropSlot: null });
    expect(showsDropLineAt(p, 0)).toBe(false);
    expect(tabDragPaint(p, 0).transform).toBe("none");
  });

  it("translates the dragged tab by exactly how far the pointer has travelled", () => {
    const dragging = run([down(0, "page:p", 100), move(240)]).state;
    const p = tabDragPresentation(dragging, THREE_BOXES);
    expect(p.draggedIndex).toBe(0);
    expect(p.translateX).toBe(140);
    expect(tabDragPaint(p, 0)).toMatchObject({
      transform: "translateX(140px)",
      opacity: TAB_DRAGGED_OPACITY,
    });
    // Every OTHER tab is left exactly where it was.
    expect(tabDragPaint(p, 1)).toMatchObject({ transform: "none", opacity: 1 });
    expect(tabDragPaint(p, 2)).toMatchObject({ transform: "none", opacity: 1 });
  });

  it("puts the insertion line in the gap the tab would land in", () => {
    // dropSlot is a slot in the strip AS DRAWN (0 = before the first tab,
    // rows.length = after the last), which is NOT the same number as the drop
    // index in the reordered list. Dragging tab 0 to the end is drop index 2
    // and slot 3; conflating them draws the line one gap short.
    const toEnd = tabDragPresentation(
      run([down(0, "page:p", 100), move(260)]).state,
      THREE_BOXES,
    );
    expect(toEnd.dropSlot).toBe(3);
    expect(showsDropLineAt(toEnd, 3)).toBe(true);
    expect(showsDropLineAt(toEnd, 2)).toBe(false);

    const toStart = tabDragPresentation(
      run([down(2, "page:r", 250), move(40)]).state,
      THREE_BOXES,
    );
    expect(toStart.dropSlot).toBe(0);
    expect(showsDropLineAt(toStart, 0)).toBe(true);

    const toMiddle = tabDragPresentation(
      run([down(0, "page:p", 50), move(160)]).state,
      THREE_BOXES,
    );
    expect(toMiddle.dropSlot).toBe(2);
    expect(showsDropLineAt(toMiddle, 2)).toBe(true);
  });

  it("draws no line while the drop would be a no-op", () => {
    const onSelf = tabDragPresentation(
      run([down(1, "page:q", 150), move(190)]).state,
      THREE_BOXES,
    );
    expect(onSelf.dropSlot).toBeNull();
    expect(showsDropLineAt(onSelf, 1)).toBe(false);
    expect(showsDropLineAt(onSelf, 2)).toBe(false);
    // ...but the tab is still lifted and still following the pointer, so the
    // user can see the gesture is live and that this drop would change nothing.
    expect(onSelf.draggedIndex).toBe(1);
    expect(onSelf.translateX).toBe(40);
  });

  it("declares the browser-stealing defences as values, on every tab", () => {
    // `touch-action: none` is what stops the browser deciding this horizontal
    // finger drag was a scroll of the strip (which is `overflowX: auto`) and
    // sending a pointercancel instead of the moves. `user-select: none` stops
    // the tab's own label being selected as the pointer sweeps across it.
    expect(TAB_DRAG_TOUCH_ACTION).toBe("none");
    expect(TAB_DRAG_USER_SELECT).toBe("none");
    const p = tabDragPresentation(IDLE_TAB_DRAG, THREE_BOXES);
    for (const index of [0, 1, 2]) {
      expect(tabDragPaint(p, index).touchAction).toBe(TAB_DRAG_TOUCH_ACTION);
      expect(tabDragPaint(p, index).userSelect).toBe(TAB_DRAG_USER_SELECT);
    }
  });

  it("gives the drop line a width that is visible but not a bar", () => {
    // ABSOLUTE: a 1px hairline against a strip that already draws hairline tab
    // borders is not distinguishable mid-gesture, and anything past a few
    // pixels reads as a tab rather than as a gap marker.
    expect(TAB_DROP_LINE_WIDTH_PX).toBe(2);
  });

  it("lifts the tab enough to read as lifted, without hiding its name", () => {
    // ABSOLUTE bounds on the one number that says "you have hold of this":
    // at 1 nothing looks picked up, and below about a half the page name — the
    // only thing telling you WHICH tab you have — stops being readable.
    expect(TAB_DRAGGED_OPACITY).toBeLessThan(1);
    expect(TAB_DRAGGED_OPACITY).toBeGreaterThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// WHEN THE STRIP MAY BE MEASURED — the rule that keeps "measured once, at the
// press" true.

const PRESSED_ON_0: TabDragState = {
  phase: "pressed",
  index: 0,
  id: "a",
  pointerId: 1,
  startX: 90,
};
const DRAGGING_0: TabDragState = {
  phase: "dragging",
  index: 0,
  id: "a",
  pointerId: 1,
  startX: 90,
  pointerX: 250,
};
const SUPPRESSING: TabDragState = { phase: "suppress" };

describe("whether a press earns a fresh measurement", () => {
  it("measures when a press is ACCEPTED from a gesture-free machine", () => {
    expect(tabDragTakesMeasurement(IDLE_TAB_DRAG, PRESSED_ON_0)).toBe(true);
    // `suppress` holds no pointer — it is only owed a click. A press from
    // there is a genuinely new gesture and needs its own boxes.
    expect(tabDragTakesMeasurement(SUPPRESSING, PRESSED_ON_0)).toBe(true);
  });

  it("REFUSES to re-measure while a gesture is already in flight", () => {
    // THE BUG THIS EXISTS FOR. A second finger, or the right mouse button,
    // landing on a tab mid-gesture produces a `down` the machine refuses — it
    // returns the SAME state. Measuring anyway would read the mid-drag layout:
    // the dragged tab carries a translateX that getBoundingClientRect includes,
    // and the drop line is a real flex item that has already pushed its
    // neighbours right.
    expect(tabDragTakesMeasurement(PRESSED_ON_0, PRESSED_ON_0)).toBe(false);
    expect(tabDragTakesMeasurement(DRAGGING_0, DRAGGING_0)).toBe(false);
    // A right-click from idle is refused too, and leaves idle behind it.
    expect(tabDragTakesMeasurement(IDLE_TAB_DRAG, IDLE_TAB_DRAG)).toBe(false);
    expect(tabDragTakesMeasurement(SUPPRESSING, SUPPRESSING)).toBe(false);
  });

  it("measures on the PRESS and on no later phase of the same gesture", () => {
    // Arming, releasing and cancelling all move the machine somewhere that is
    // not `pressed`, so none of them can re-open the measurement.
    expect(tabDragTakesMeasurement(PRESSED_ON_0, DRAGGING_0)).toBe(false);
    expect(tabDragTakesMeasurement(DRAGGING_0, SUPPRESSING)).toBe(false);
    expect(tabDragTakesMeasurement(PRESSED_ON_0, IDLE_TAB_DRAG)).toBe(false);
    expect(tabDragTakesMeasurement(DRAGGING_0, IDLE_TAB_DRAG)).toBe(false);
  });

  it("says no to every `down` the machine actually refuses, driven through it", () => {
    // Not hand-built states: the same transitions the component performs.
    const press = nextTabDrag(IDLE_TAB_DRAG, {
      type: "down",
      index: 0,
      id: "a",
      pointerId: 1,
      button: TAB_DRAG_PRIMARY_BUTTON,
      x: 90,
    });
    expect(tabDragTakesMeasurement(IDLE_TAB_DRAG, press.state)).toBe(true);

    const armed = nextTabDrag(press.state, { type: "move", pointerId: 1, x: 250 });
    expect(armed.state.phase).toBe("dragging");

    // A SECOND FINGER on another tab, mid-drag.
    const second = nextTabDrag(armed.state, {
      type: "down",
      index: 2,
      id: "c",
      pointerId: 2,
      button: TAB_DRAG_PRIMARY_BUTTON,
      x: 260,
    });
    expect(tabDragTakesMeasurement(armed.state, second.state)).toBe(false);

    // A RIGHT-CLICK, same pointerId, mid-drag — the mouse case.
    const rightClick = nextTabDrag(armed.state, {
      type: "down",
      index: 2,
      id: "c",
      pointerId: 1,
      button: TAB_DRAG_PRIMARY_BUTTON + 2,
      x: 260,
    });
    expect(tabDragTakesMeasurement(armed.state, rightClick.state)).toBe(false);
  });

  it("keeps the press-time boxes usable for the drop the user aimed at", () => {
    // THE PROVEN SCENARIO, end to end. Three 100px tabs; grab tab 0 at x=90;
    // drag right to x=250; a second pointer lands; drag back to x=160 and
    // release over the gap between tabs 0 and 1.
    //
    // Against the PRESS-TIME boxes the release at 160 is drop index 1 — the
    // move the user watched. Against a MID-DRAG re-measure (tab 0 carried
    // +160px to 160..260, the drop line having pushed the rest right) the same
    // release is `null`: no ReorderPage at all, and no drop line either,
    // because tabDragPresentation reads the same boxes. The gesture appears to
    // die mid-drag.
    const midDrag: readonly TabBox[] = [
      { left: 160, right: 260 },
      { left: 104, right: 204 },
      { left: 204, right: 304 },
    ];
    expect(dropIndexAt(THREE_BOXES, 160, 0)).toBe(1);
    expect(dropIndexAt(midDrag, 160, 0)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// THE DROP LINE'S GEOMETRY — a decision, so it may not live in the .tsx.

describe("the drop line's paint", () => {
  it("is exactly the module's width, and that width is legible", () => {
    expect(TAB_DROP_LINE_PAINT.width).toBe(TAB_DROP_LINE_WIDTH_PX);
    // ABSOLUTE, not relative to the constant: a guard written only as
    // `toBe(TAB_DROP_LINE_WIDTH_PX)` says nothing about whether the constant
    // itself is sane, and `width: 0` renders no indicator at all.
    expect(TAB_DROP_LINE_PAINT.width).toBe(2);
    expect(TAB_DROP_LINE_PAINT.width).toBeGreaterThanOrEqual(2);
    // ...and it is not the OTHER number in this module. `width:
    // TAB_DRAGGED_OPACITY` is 0.7px — a sub-pixel hairline, which is exactly
    // what TAB_DROP_LINE_WIDTH_PX's own reasoning rejects — and it typechecks.
    expect(TAB_DROP_LINE_PAINT.width).not.toBe(TAB_DRAGGED_OPACITY);
  });

  it("carries the layout facts that make it a mark BETWEEN tabs", () => {
    // A flex item that shrank would be squeezed to nothing in a full strip —
    // the same invisible-indicator failure as `width: 0`, arrived at sideways.
    expect(TAB_DROP_LINE_PAINT.flexShrink).toBe(0);
    // Full height of the row, so it reads as a seam rather than a dot.
    expect(TAB_DROP_LINE_PAINT.alignSelf).toBe("stretch");
  });
});

// ---------------------------------------------------------------------------
// THE MODULE HAS NO CLOCK — the structural half of the long-press resolution.

const TAB_DRAG_SOURCE = stripComments(
  readFileSync(new URL("../canvas/pages/tab-drag.ts", import.meta.url), "utf8"),
);

describe("the drag cannot grow a hold timer without this failing", () => {
  it("reads no clock and sets no timer", () => {
    // WHAT THIS PROTECTS, and it is not tidiness: the stationary long press is
    // the platform's CONTEXT-MENU gesture on touch, and Task 2 is going to
    // claim it. The moment this module arms on elapsed time the two gestures
    // are in direct conflict on every tablet, and the conflict would be
    // invisible to every other test in this file — a timer-armed drag passes
    // all of them. So the absence is asserted, not merely intended.
    expect(TAB_DRAG_SOURCE).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(TAB_DRAG_SOURCE).not.toMatch(/Date\.now|performance\.now/);
    // ...and it takes no injected clock either, which is how this codebase
    // normally smuggles time into a pure module (canvas-editor's tools take a
    // `now`), so the absence of the globals above is not the whole story.
    expect(TAB_DRAG_SOURCE).not.toMatch(/\bnow\s*[:(]/);
  });
});

// ---------------------------------------------------------------------------
// THE .tsx IS HANDS. Every assertion below reads the component's CODE with
// comments stripped, bounded to one region, and every positive is paired with
// a negative so the two roles in a call cannot simply swap.

const SWITCHER = stripComments(
  readFileSync(new URL("../canvas/pages/PageSwitcher.tsx", import.meta.url), "utf8"),
);

/** One tab button's own props: from its marker to the "+" that ends the map. */
function tabButtonRegion(): string {
  const from = SWITCHER.indexOf("data-canvas-page-tab={row.id}");
  const to = SWITCHER.indexOf("data-canvas-new-page-tab");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

/** The whole strip, including the drop-line markers that sit between tabs. */
function stripRegion(): string {
  const from = SWITCHER.indexOf("data-canvas-page-tabs");
  const to = SWITCHER.indexOf("return { tabs, overlays }");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return SWITCHER.slice(from, to);
}

describe("the component hands the gesture over rather than deciding it", () => {
  it("routes every pointer phase into the machine, with the pointer's own x", () => {
    const tab = tabButtonRegion();
    // Bounded to each event object, so a swap of `pointerId` and `x` — or a
    // silent switch to clientY — fails here rather than in a browser nobody
    // has.
    expect(tab).toMatch(
      /\{\s*type:\s*"move",\s*pointerId:\s*event\.pointerId,\s*x:\s*event\.clientX,?\s*\}/,
    );
    expect(tab).toMatch(
      /\{\s*type:\s*"up",\s*pointerId:\s*event\.pointerId,\s*x:\s*event\.clientX,?\s*\}/,
    );
    expect(tab).not.toMatch(/x:\s*event\.clientY/);
    expect(tab).not.toMatch(/pointerId:\s*event\.clientX/);
  });

  it("starts the gesture with the row's own index and id", () => {
    const tab = tabButtonRegion();
    expect(tab).toMatch(
      /onPointerDown=\{\(event\)\s*=>\s*beginTabDrag\(event,\s*index,\s*row\.id\)\}/,
    );
    // The index and the id are two different roles; passed the other way round
    // the machine would drop the wrong page.
    expect(tab).not.toMatch(/beginTabDrag\(event,\s*row\.id/);
  });

  it("hands the machine the BUTTON, from `button` and not from the `buttons` mask", () => {
    // `event.buttons` is a bitmask that reads 1 for the primary button held,
    // so a component that passed it would make TAB_DRAG_PRIMARY_BUTTON's 0
    // mean "no button pressed" and the strip would be dead to every click.
    const downArgs = callArguments(SWITCHER, "dispatchDrag");
    expect(SWITCHER).toMatch(
      /\{\s*type:\s*"down",\s*index,\s*id,\s*pointerId:\s*event\.pointerId,\s*button:\s*event\.button,\s*x:\s*event\.clientX,?\s*\}/,
    );
    expect(downArgs).not.toMatch(/button:\s*event\.buttons/);
    expect(SWITCHER).not.toMatch(/button:\s*event\.buttons/);
    expect(SWITCHER).not.toMatch(/button:\s*event\.pointerId/);
    expect(SWITCHER).not.toMatch(/x:\s*event\.button\b/);
  });

  it("captures the pointer, so a drag that leaves the tab is still delivered", () => {
    // WITHOUT THIS the pointermoves stop the instant the finger crosses onto a
    // sibling or off the strip, and a pointerup outside never arrives at all —
    // the gesture strands mid-drag with the tab lifted. The capture is also
    // what makes `lostpointercapture` a meaningful cancel signal.
    //
    // PARSED, NOT TEXT-MATCHED, and that is the whole strength of this guard.
    // The text form it replaced (`toMatch(/setPointerCapture\(event\.pointerId\)/)`)
    // was satisfied on 2026-09-06 by DELETING the call and writing
    // `const capture = "setPointerCapture(event.pointerId)";` in its place —
    // `stripComments` blanks comments but not string literals, so the suite
    // stayed green with all four cancellation paths' precondition gone.
    // `callsTo` asks the TypeScript parser, and a string is not a call.
    const captures = callsTo(SWITCHER, "event.currentTarget.setPointerCapture");
    expect(captures.map((call) => call.text)).toEqual([
      "event.currentTarget.setPointerCapture(event.pointerId)",
    ]);
    // ...taken inside the press handler, on the tab the press landed on.
    // Capturing anywhere else would keep the letter of the call and lose what
    // it is for.
    const from = SWITCHER.indexOf("const beginTabDrag");
    // SWITCHER is comment-stripped, so the bound has to be a piece of CODE:
    // beginTabDrag's own dependency array is the last thing in it.
    const to = SWITCHER.indexOf("[dispatchDrag, measureTabs]");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(captures[0]!.pos).toBeGreaterThan(from);
    expect(captures[0]!.pos).toBeLessThan(to);
    // The pointerId is the argument; the button is a different number that
    // typechecks just as well.
    expect(callsTo(SWITCHER, "event.currentTarget.setPointerCapture")).toHaveLength(1);
    expect(SWITCHER).not.toMatch(/setPointerCapture\(event\.button/);
  });

  it("switches through the machine's click, never around it", () => {
    // If the tab called switchTo directly from onClick, the click after a drag
    // could not be suppressed and every reorder would also switch the page.
    const tab = tabButtonRegion();
    expect(tab).toMatch(/\{\s*type:\s*"click",\s*index,\s*id:\s*row\.id,?\s*\}/);
    expect(tab).not.toMatch(/onClick=\{\(\)\s*=>\s*switchTo/);
    expect(tab).not.toMatch(/onPointerUp=\{\(\)\s*=>\s*switchTo/);
  });

  it("wires both of the ways a gesture dies without a pointerup", () => {
    const tab = tabButtonRegion();
    expect(tab).toMatch(
      /onPointerCancel=\{\(\)\s*=>\s*dispatchDrag\(\{\s*type:\s*"cancel",?\s*\}\)\}/,
    );
    expect(tab).toMatch(
      /onLostPointerCapture=\{\(\)\s*=>\s*dispatchDrag\(\{\s*type:\s*"cancel",?\s*\}\)\}/,
    );
  });

  it("swallows the browser's menu unconditionally, and asks the rule about OURS", () => {
    // TWO STATEMENTS, AND THEY MOVED APART ON 2026-09-06 when the tab grew its
    // own context menu (canvas/pages/page-tab-menu.ts). The browser's menu is
    // always suppressed, because ours replaces it and two menus over one tab
    // is nobody's request. WHETHER OURS OPENS is still this module's call, and
    // it is now asked inside `openTabMenu` rather than on the tab — so the
    // guard reads both places, bounded to each.
    const tab = tabButtonRegion();
    expect(tab).toMatch(/onContextMenu=\{\(event\)\s*=>\s*\{/);
    expect(tab).toMatch(/event\.preventDefault\(\);/);
    expect(tab).toMatch(/openTabMenu\(row\.id\)/);
    // The gate did not simply vanish with the move: it is in the one handler
    // both ways in go through, read from the REF (pointer events outrun React
    // renders, so `dragState` would be stale mid-gesture).
    const open = SWITCHER.slice(
      SWITCHER.indexOf("const openTabMenu = useCallback("),
      SWITCHER.indexOf("[dispatchDrag, dispatchTabMenu]"),
    );
    expect(open).toMatch(/tabDragBlocksContextMenu\(dragRef\.current\)/);
    expect(open).not.toMatch(/tabDragBlocksContextMenu\(dragState\)/);
    // ...and the drag is told the menu took the gesture, which is NOT `cancel`
    // (a cancelled press goes idle and its click switches the page; a consumed
    // one parks in `suppress` and that click is eaten).
    expect(open).toMatch(/dispatchDrag\(\{\s*type:\s*"context-menu",?\s*\}\)/);
    expect(open).not.toMatch(/dispatchDrag\(\{\s*type:\s*"cancel",?\s*\}\)/);
  });

  it("keeps double-click-to-rename, the affordance the drag had to coexist with", () => {
    expect(tabButtonRegion()).toMatch(/onDoubleClick=\{\(\)\s*=>\s*rename\(row\)\}/);
  });

  it("takes its per-tab paint from the rule, declaring none of it itself", () => {
    const tab = tabButtonRegion();
    expect(tab).toMatch(/\.\.\.tabDragPaint\(presentation,\s*index\)/);
    // The three properties the rule owns may not ALSO be written here, in
    // either role — a literal beside the spread would win or lose by source
    // order and no test could see which.
    expect(tab).not.toMatch(/touchAction:\s*"/);
    expect(tab).not.toMatch(/userSelect:\s*"/);
    expect(tab).not.toMatch(/transform:\s*"/);
  });

  it("asks the rule where the drop line goes, at both ends of the strip", () => {
    const strip = stripRegion();
    expect(strip).toMatch(/showsDropLineAt\(presentation,\s*index\)/);
    expect(strip).toMatch(/showsDropLineAt\(presentation,\s*rows\.length\)/);
    expect(strip).toContain("data-canvas-page-drop-line");
    // No inline slot arithmetic: the mapping from drop index to gap is the
    // module's, and it is off-by-one in exactly the way an inline `===` invites.
    expect(strip).not.toMatch(/dropSlot\s*===/);
  });
});

describe("the component measures, and only measures", () => {
  it("reads each tab's own left and right edge, in that role and nothing more", () => {
    // CLOSED AT BOTH ENDS. Without the trailing `\s*\}` this pinned a PREFIX,
    // and on 2026-09-06 `right: rect.right * 0` shipped past it with 999/999
    // green — every tab box becoming {left: L, right: 0}, every midpoint
    // collapsing to L/2, and every drop landing in the wrong slot. A guard
    // that cannot see a suffix cannot see an arithmetic mutation.
    expect(SWITCHER).toMatch(/\{\s*left:\s*rect\.left,\s*right:\s*rect\.right\s*\}/);
    expect(SWITCHER).not.toMatch(/left:\s*rect\.right/);
    expect(SWITCHER).not.toMatch(/right:\s*rect\.left/);
    // And the rect is read once per tab, from the tab's own node — a second
    // arithmetic site could not hide in a `const` above the literal.
    expect(countInCode(SWITCHER, "node.getBoundingClientRect()")).toBe(1);
    expect(countInCode(SWITCHER, "rect.left")).toBe(1);
    expect(countInCode(SWITCHER, "rect.right")).toBe(1);
  });

  it("measures the tabs it actually drew, from the strip it drew them in", () => {
    expect(SWITCHER).toMatch(/ref=\{stripRef\}/);
    expect(SWITCHER).toMatch(/querySelectorAll\("\[data-canvas-page-tab\]"\)/);
  });

  it("measures ONCE PER GESTURE — gated on the machine having accepted the press", () => {
    // THE STRIP SCROLLS (`overflowX: auto`) AND THIS DRAG DOES NOT SCROLL IT.
    // Measuring once, before anything is lifted, is what makes that safe: the
    // boxes cannot move under the pointer mid-gesture, so the drop the user
    // sees is the drop that is computed. A re-measure during the drag would
    // read the transformed, drop-line-shifted layout instead.
    //
    // "ONCE PER GESTURE" IS NOT "ONCE IN THE SOURCE", and the difference was
    // demonstrated on 2026-09-06: the measure ran on EVERY pointerdown on ANY
    // tab, before the machine's button/first-pointer-wins refusal, so a second
    // finger or a right-click mid-drag re-measured the MID-DRAG layout and the
    // gesture silently died. Only the gate makes the claim true, so the gate is
    // what is pinned here — and the count is on `measureTabs()` itself, since
    // pinning the assignment's exact text was evaded by writing the second call
    // as `boxesRef.current = [...measureTabs()]`.
    expect(countInCode(SWITCHER, "measureTabs()")).toBe(1);
    expect(countInCode(SWITCHER, "boxesRef.current =")).toBe(1);
    expect(SWITCHER).toMatch(
      /if \(tabDragTakesMeasurement\(before, dragRef\.current\)\)\s*\{\s*boxesRef\.current = measureTabs\(\);\s*\}/,
    );
    // `before` is the state as it was BEFORE the press was dispatched — read
    // the other way round the predicate compares a state with itself and is
    // always false, and the boxes would never be measured at all.
    expect(SWITCHER).toMatch(/const before = dragRef\.current;/);
    const beginAt = SWITCHER.indexOf("const beginTabDrag");
    const readAt = SWITCHER.indexOf("const before = dragRef.current;");
    const dispatchAt = SWITCHER.indexOf('type: "down"');
    const gateAt = SWITCHER.indexOf("if (tabDragTakesMeasurement(");
    expect(beginAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(beginAt);
    expect(dispatchAt).toBeGreaterThan(readAt);
    expect(gateAt).toBeGreaterThan(dispatchAt);
  });

  it("never scrolls the strip itself, at either edge", () => {
    // THE CHOICE, STATED: no edge auto-scroll. It would need a timer and a
    // re-measure (see above), and a drop site scrolled off the end is still
    // reachable — the popover's ◂ / ▸ buttons move a page a slot at a time and
    // are the keyboard path besides.
    expect(SWITCHER).not.toMatch(/scrollBy|scrollIntoView|scrollLeft\s*[+-]?=/);
  });

  it("hands the measurement and the pointer to the two deciders, in their roles", () => {
    // The argument-role guard that matters most in this change: dropIndexAt
    // takes (boxes, pointerX, draggedIndex) and dropPageIntents takes
    // (editor, id, target). Swapping pointerX and index typechecks — both are
    // numbers — and would silently reorder against the wrong tab.
    expect(SWITCHER).toMatch(
      /dropPageIntents\(\s*editor,\s*effect\.id,\s*dropIndexAt\(\s*boxesRef\.current,\s*effect\.pointerX,\s*effect\.index,?\s*\),?\s*\)/,
    );
    expect(SWITCHER).not.toMatch(/dropIndexAt\(\s*boxesRef\.current,\s*effect\.index/);
    expect(countInCode(SWITCHER, "dropPageIntents(")).toBe(1);
  });

  it("applies a drop the same way every other mutation in this file does", () => {
    // helper -> `if (intents.length > 0)` -> applyAll. The guard is the count:
    // a drop that called applyAll unconditionally would write a same-value
    // ReorderPage on every no-op release.
    expect(countInCode(SWITCHER, "if (intents.length > 0) editor.applyAll(intents);")).toBe(5);
  });
});

describe("the window-level cancels", () => {
  it("listen only while a gesture is in flight, and only then", () => {
    const from = SWITCHER.indexOf("tabDragIsActive(");
    expect(from).toBeGreaterThan(-1);
    const region = SWITCHER.slice(from, from + 900);
    expect(region).toMatch(/addEventListener\("keydown"/);
    expect(region).toMatch(/addEventListener\("blur"/);
    expect(region).toMatch(/removeEventListener\("keydown"/);
    expect(region).toMatch(/removeEventListener\("blur"/);
  });

  it("cancels on Escape and on nothing else", () => {
    const from = SWITCHER.indexOf("function onDragKeyDown");
    expect(from).toBeGreaterThan(-1);
    const body = callArguments(SWITCHER.slice(from), "onDragKeyDown");
    expect(body).toContain("event: KeyboardEvent");
    const region = SWITCHER.slice(from, from + 300);
    expect(region).toMatch(/event\.key\s*!==\s*"Escape"/);
  });
});

describe("the drop line is painted at the rule's width, not the panel's", () => {
  it("spreads the rule and declares none of its geometry itself", () => {
    // WHY A GUARD AND NOT JUST THE CONSTANT'S OWN TEST: on 2026-09-06 the
    // constant was pinned (`expect(TAB_DROP_LINE_WIDTH_PX).toBe(2)`) but its
    // USE was not, and `width: 0` in this style shipped with 999/999 green —
    // a drag with no visible drop indicator at all, the user aiming blind.
    const style = objectLiteralText(SWITCHER, "dropLineStyle");
    expect(style).toMatch(/^\{\s*\.\.\.TAB_DROP_LINE_PAINT\s*,/);
    // Nothing may re-declare what the spread brought in: a literal AFTER the
    // spread wins silently, and one before it loses silently.
    expect(style).not.toMatch(/width\s*:/);
    expect(style).not.toMatch(/flexShrink\s*:/);
    expect(style).not.toMatch(/alignSelf\s*:/);
    // The width is not written in this file in any form — not as the
    // constant, not as a number.
    expect(countInCode(SWITCHER, "TAB_DROP_LINE_WIDTH_PX")).toBe(0);
    // What IS this file's is the mark's colour and corner, which are the
    // canvas's palette rather than the gesture's rule.
    expect(style).toMatch(/background:\s*CHROME_ACCENT/);
  });

  it("uses that one style for both of the gaps the strip can draw", () => {
    // Two call sites — between tabs, and after the last one. A second style
    // object for the end gap is how the two drift apart.
    expect(countInCode(stripRegion(), "style={dropLineStyle}")).toBe(2);
    expect(countInCode(stripRegion(), "data-canvas-page-drop-line")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING SEAMS. Everything above asks "does this text appear in the .tsx?".
// On 2026-09-06 a validator walked six mutations of this gesture's hands past a
// green 43-file / 1067-test suite and a clean `tsc --noEmit`, every one of them
// invisible to that question — the decision modules are all still called, all
// still perfect, and the feature is dead:
//
//   * `runDragEffect(step.effect);` DELETED from `dispatchDrag` — clicking a tab
//     no longer switches pages and a drop emits no ReorderPage at all;
//   * `dragRef.current = step.state;` DELETED — every move is transitioned from
//     `idle`, so the drag never arms and the context-menu gate is dead;
//   * `tabDragPresentation(dragState, …)` re-aimed at `IDLE_TAB_DRAG` — no lift,
//     no drop line, the user dragging blind;
//   * the Escape body of `onDragKeyDown` DELETED and `onDragBlur` emptied — an
//     aborted drag COMMITS on the following pointerup, and alt-tabbing away
//     leaves a tab lifted forever;
//   * `if (row !== undefined) switchTo(row);` replaced by `void row;` — the
//     computed row thrown away, clicking a tab stops switching pages.
//
// The question that fails on all of them is about SHAPE — which statements a
// function actually RUNS, in order, and what a variable is actually initialised
// to. `bodyStatements` and `initializerText` ask the parser exactly that
// (tests/lib/source.ts), which is why a decoy closure, a comment or a string
// literal carrying the same text cannot answer it.
//
// AND THE DECOY CLIMBS ONE LEVEL. Pinning the two cancel handlers' BODIES is
// not the same claim as pinning that they are ATTACHED: on 2026-09-06 a second
// pass moved `window.addEventListener("keydown", onDragKeyDown)` and its blur
// sibling into `const arm = (): void => { … }; void arm;` inside the surviving
// effect, left both bodies untouched, and the whole suite stayed green at 43
// files / 1077 tests with `tsc --noEmit` at 0 — Escape mid-drag dead and a tab
// left lifted forever by an alt-tab, exactly the consequence the body guard was
// written for. `topLevelEffectIn` and `effectStatements` close that level.
describe("the wiring seams — the component RUNS these decisions, not merely names them", () => {
  it("transitions, records and RUNS, in that order and with nothing missing", () => {
    // ORDER IS PART OF THE CLAIM, not decoration. The ref is what the NEXT
    // event transitions from (pointer events outrun React renders), the state
    // is what repaints, and the effect is the only thing that ever reaches the
    // document. Any one of the four gone is a different broken feature, and an
    // exact list is the only assertion that notices all four.
    expect(bodyStatements(SWITCHER, "dispatchDrag")).toEqual([
      "const step = nextTabDrag(dragRef.current, event);",
      "dragRef.current = step.state;",
      "setDragState(step.state);",
      "runDragEffect(step.effect);",
    ]);
  });

  it("paints from the LIVE drag state, never from a constant that paints nothing", () => {
    // `tabDragPresentation(IDLE_TAB_DRAG, boxesRef.current)` typechecks, keeps
    // the call, keeps the module, and returns the not-dragging presentation for
    // every frame: no lifted tab and no drop line, for the whole gesture.
    expect(initializerText(SWITCHER, "presentation")).toBe(
      "tabDragPresentation(dragState, boxesRef.current)",
    );
  });

  it("cancels for real on Escape, and on a lost window", () => {
    // Emptying these two leaves the listeners registered, the module's
    // `tabDragIsActive` gate intact and the whole region-based guard above
    // green — while Escape does nothing and the pointerup that follows COMMITS
    // the reorder the user just tried to abort.
    expect(bodyStatements(SWITCHER, "onDragKeyDown")).toEqual([
      'if (event.key !== "Escape") return;',
      'dispatchDrag({ type: "cancel" });',
    ]);
    expect(bodyStatements(SWITCHER, "onDragBlur")).toEqual(['dispatchDrag({ type: "cancel" });']);

    // ...AND THEY ARE ACTUALLY ATTACHED. Both bodies above can be perfect while
    // neither handler is ever bound: moving the two registrations into
    // `const arm = (): void => { … }; void arm;` inside this same effect left
    // the whole suite green on 2026-09-06, with Escape mid-drag dead and a tab
    // left lifted forever by an alt-tab. `callsTo` cannot see it — it returns
    // every call the parser finds, called or not — so the assertion has to be
    // about the effect's OWN top-level statements, taken from the component's
    // own statement list so a whole effect parked in a dead closure fails too.
    const cancellation = topLevelEffectIn(
      SWITCHER,
      "usePageSwitcher",
      "tabDragIsActive(dragState)",
    );
    const statements = effectStatements(cancellation).map((statement) =>
      statement.replace(/\s+/g, " ").trim(),
    );
    // The gate first: these listeners are window-wide, and leaving them up
    // while no gesture is in flight makes every Escape in the app a cancel.
    expect(statements[0]).toBe("if (!tabDragIsActive(dragState)) return;");
    expect(statements).toContain('window.addEventListener("keydown", onDragKeyDown);');
    expect(statements).toContain('window.addEventListener("blur", onDragBlur);');
    // ...and the effect's own return takes both back down when the drag ends.
    expect(statements[statements.length - 1]).toBe(
      'return () => { window.removeEventListener("keydown", onDragKeyDown); ' +
        'window.removeEventListener("blur", onDragBlur); };',
    );
  });

  it("interprets the machine's verdict — and does not throw the answer away", () => {
    // `const row = rows.find(…); void row;` keeps the lookup, keeps `switchTo`
    // in the dependency array, typechecks, and makes every tab click a no-op.
    // Whitespace is collapsed because the .tsx carries a comment inside the
    // first branch, which `stripComments` turns into a run of spaces.
    const branches = bodyStatements(SWITCHER, "runDragEffect").map((statement) =>
      statement.replace(/\s+/g, " ").trim(),
    );
    expect(branches).toEqual([
      'if (effect.kind === "switch") { const row = rows.find((candidate) => candidate.id === effect.id); if (row !== undefined) switchTo(row); return; }',
      'if (effect.kind === "drop") { const intents = dropPageIntents( editor, effect.id, dropIndexAt(boxesRef.current, effect.pointerX, effect.index), ); if (intents.length > 0) editor.applyAll(intents); }',
    ]);
  });
});
