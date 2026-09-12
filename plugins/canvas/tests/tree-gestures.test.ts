// Run: npx vitest run tests/tree-gestures.test.ts
//
// W4's DECISIONS, away from the DOM. Which node a tree gesture acts on, which
// arm is offered, whether a title may be sent, and which composer is open —
// none of it is written inline in the component, for the reason
// canvas/agent-arms.ts and canvas/agent-menu.ts already give in full: this
// project has no jsdom and may not gain one, so a rule written inside a React
// component is a rule no test can drive.
import { describe, expect, it } from "vitest";
import type { Page, Shape } from "@ensembleworks/canvas-model";
import { buildTreeEdge, buildTreeNode, markTreePage } from "../canvas/tree/encoding.js";
import {
  MAX_GESTURE_TITLE,
  blockerArmFor,
  goalArmFor,
  markStateOf,
  nextTreeComposer,
  treeGestureTargetFor,
  treeTitleSubmission,
  type TreeComposerState,
} from "../canvas/tree/gestures.js";

const TREE = "page:tree";

const node = (id: string, treeId = TREE): Shape =>
  buildTreeNode({ id, treeId, parentId: treeId, index: "a1", x: 0, y: 0 });

const edge = (id: string): Shape =>
  buildTreeEdge({
    id,
    treeId: TREE,
    parentId: TREE,
    index: "b1",
    blockerId: "shape:a",
    blockedId: "shape:b",
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
  }).shape;

const plainNote = (id: string): Shape =>
  ({ ...node(id), meta: {} }) as Shape;

const targetOf = (selection: string[], shapes: readonly Shape[]) =>
  treeGestureTargetFor({
    selection: new Set(selection),
    shapeOf: (id) => shapes.find((shape) => shape.id === id),
  });

// ---------------------------------------------------------------------------
// Which shape the gesture acts on
// ---------------------------------------------------------------------------

describe("treeGestureTargetFor", () => {
  it("answers the one selected shape, carrying the tree it belongs to", () => {
    expect(targetOf(["shape:a"], [node("shape:a")])).toEqual({
      shapeId: "shape:a",
      treeId: TREE,
    });
  });

  it("answers null for a selection that is not exactly one shape", () => {
    // A gesture is anchored to a shape's screen box, and "the" box of a
    // two-shape selection is not a thing — agent-arms.ts's rule, and the same
    // reason.
    expect(targetOf([], [node("shape:a")])).toBeNull();
    expect(targetOf(["shape:a", "shape:b"], [node("shape:a"), node("shape:b")])).toBeNull();
  });

  it("answers null for an id the document does not hold", () => {
    // A create tool mid-drag has a selection too; a shape nobody can read is
    // not something to hang a menu on.
    expect(targetOf(["shape:ghost"], [])).toBeNull();
  });

  it("answers a target with NO tree for a note that is not a tree node", () => {
    // Not null: the affordance still appears, and says why it cannot act. The
    // "disabled, never hidden" call agent-arms.ts makes.
    expect(targetOf(["shape:loose"], [plainNote("shape:loose")])).toEqual({
      shapeId: "shape:loose",
      treeId: null,
    });
  });

  it("does not offer a tree gesture on an EDGE", () => {
    // An arrow is tree-marked too, and "add a blocker under this arrow" is not
    // a thing the write engine can do. Reading it through the encoding rather
    // than checking `kind` here keeps one reading of W0's contract.
    expect(targetOf(["shape:edge-0"], [edge("shape:edge-0")])).toEqual({
      shapeId: "shape:edge-0",
      treeId: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The arm
// ---------------------------------------------------------------------------

describe("blockerArmFor", () => {
  it("is enabled on a tree node, and says what it does", () => {
    const arm = blockerArmFor({ shapeId: "shape:a", treeId: TREE });
    expect(arm.enabled).toBe(true);
    expect(arm.label.toLowerCase()).toContain("blocker");
  });

  it("is disabled on a shape that is not a tree node, and says WHY", () => {
    const arm = blockerArmFor({ shapeId: "shape:loose", treeId: null });
    expect(arm.enabled).toBe(false);
    expect(arm.reason).not.toBe("");
    expect(arm.reason.toLowerCase()).toContain("tree");
  });
});

// ---------------------------------------------------------------------------
// The title a human types
// ---------------------------------------------------------------------------

describe("goalArmFor — the button that turns a page into a tree", () => {
  /**
   * W16/B2. This gesture shipped as an unconditional "Add a goal" button in the
   * corner of EVERY page of EVERY room the plugin serves (W14's
   * `03-otherpage-recheck.png` photographed it on OtherPage, which is not a
   * tree), and pressing it there did something the label never mentioned:
   * `addGoal` MARKS an unmarked page as a tree. A control that silently
   * converts the page you are on is the defect; the button existing is not.
   *
   * IT IS NOT GATED AWAY, because it is the only door to a FIRST tree — there
   * is no `canvas_tree_add_goal` agent tool and no CLI create verb, so hiding
   * it on unmarked pages would make a tree unreachable from a cold room. What
   * changes is that the label now STATES the consequence, which is C3's own
   * parenthetical ("or on an explicit 'start a tree here' intent that says
   * so").
   */
  it("offers a plain goal on a page that is already a tree", () => {
    const arm = goalArmFor({ status: "ok" });
    expect(arm.label).toBe("Add a goal");
    expect(arm.enabled).toBe(true);
    expect(arm.reason).toBe("");
  });

  it("says what it will DO on a page that is not a tree yet", () => {
    const arm = goalArmFor({ status: "absent" });
    expect(arm.enabled).toBe(true);
    // The word the old label never carried: this press converts the page.
    expect(arm.label).toContain("tree");
    expect(arm.label).not.toBe("Add a goal");
  });

  it("is greyed with the reason on a page whose tree mark is malformed", () => {
    // `addGoal` refuses this page with `broken-tree` rather than restamping the
    // mark, so an enabled button here is a button that can only ever fail.
    const arm = goalArmFor({ status: "invalid", error: "treeVersion is not a number" });
    expect(arm.enabled).toBe(false);
    expect(arm.reason).toContain("treeVersion is not a number");
  });

  it("never invents a label for a page it was given no mark for", () => {
    expect(goalArmFor({ status: "absent" }).reason).toBe("");
  });
});

describe("markStateOf", () => {
  it("reports an unmarked page absent", () => {
    expect(markStateOf({ id: "page:x", name: "X" })).toEqual({ status: "absent" });
  });

  it("reports a marked page ok", () => {
    expect(markStateOf(markTreePage({ id: "page:x", name: "X" }))).toEqual({ status: "ok" });
  });

  it("carries the reason a malformed mark could not be read", () => {
    const broken = { id: "page:x", name: "X", tree: { version: "not a number" } } as Page;
    const state = markStateOf(broken);
    expect(state.status).toBe("invalid");
    // NAMED, not a house phrase: a human repairing a page mark needs to know
    // which key is wrong.
    expect(state.error ?? "").not.toBe("");
  });
});

describe("treeTitleSubmission", () => {
  it("trims, and sends what was left", () => {
    expect(treeTitleSubmission("  Ship the loop  ")).toEqual({
      ok: true,
      title: "Ship the loop",
    });
  });

  it("refuses an empty or whitespace-only title rather than sending it", () => {
    // The write engine refuses it too (`empty-title`), and this is the half
    // that keeps a pointless round trip — and a toast — off the screen.
    expect(treeTitleSubmission("")).toEqual({ ok: false, why: expect.any(String) });
    expect(treeTitleSubmission("   \n ")).toEqual({ ok: false, why: expect.any(String) });
  });

  it("refuses a title over the cap the wire enforces, before the wire does", () => {
    const long = "x".repeat(MAX_GESTURE_TITLE + 1);
    const verdict = treeTitleSubmission(long);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain(String(MAX_GESTURE_TITLE));
  });

  it("accepts a title exactly at the cap", () => {
    expect(treeTitleSubmission("x".repeat(MAX_GESTURE_TITLE)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Which composer is open
// ---------------------------------------------------------------------------

describe("nextTreeComposer", () => {
  const from = (state: TreeComposerState, ...events: Parameters<typeof nextTreeComposer>[1][]) =>
    events.reduce(nextTreeComposer, state);

  it("opens the composer the gesture asks for", () => {
    expect(nextTreeComposer("closed", { type: "open", gesture: "add-goal" })).toBe("goal");
    expect(nextTreeComposer("closed", { type: "open", gesture: "add-blocker" })).toBe("blocker");
  });

  it("toggles shut when the same gesture is pressed again", () => {
    expect(from("closed", { type: "open", gesture: "add-goal" }, { type: "open", gesture: "add-goal" })).toBe(
      "closed",
    );
  });

  it("swaps straight to the other composer rather than stacking two", () => {
    // Two title fields on screen at once, both listening for Enter, is the one
    // state a human cannot read.
    expect(from("goal", { type: "open", gesture: "add-blocker" })).toBe("blocker");
  });

  it("closes on escape and after a submit", () => {
    expect(nextTreeComposer("blocker", { type: "escape" })).toBe("closed");
    expect(nextTreeComposer("goal", { type: "submitted" })).toBe("closed");
  });

  it("closes the BLOCKER composer when the selection moves, and leaves the GOAL one alone", () => {
    // The blocker composer is anchored to the selected node and acts on it, so
    // a selection change makes its Enter act on a shape the human is no longer
    // looking at. A goal has no anchor and no subject — closing it because a
    // click landed on a note would be losing typing for no reason.
    expect(nextTreeComposer("blocker", { type: "target-changed" })).toBe("closed");
    expect(nextTreeComposer("goal", { type: "target-changed" })).toBe("goal");
  });

  it("closes on a pointerdown OUTSIDE the widget, and stays on one inside", () => {
    // dock.ts's `insideWidget` lesson, carried over rather than re-learned: the
    // caller answers containment for every root, so a press on the field
    // itself does not dismiss the field on the way down.
    expect(nextTreeComposer("goal", { type: "pointerdown", insideWidget: false })).toBe("closed");
    expect(nextTreeComposer("goal", { type: "pointerdown", insideWidget: true })).toBe("goal");
  });

  it("ignores every event while closed except an open", () => {
    for (const event of [
      { type: "escape" } as const,
      { type: "submitted" } as const,
      { type: "target-changed" } as const,
      { type: "pointerdown", insideWidget: false } as const,
    ]) {
      expect(nextTreeComposer("closed", event)).toBe("closed");
    }
  });
});
