// Run: npx vitest run tests/dock-expand.test.ts
//
// MINIMISED IS THE DEFAULT AND MINIMISED IS THE AVATAR STRIP. The old dock had
// this the other way up: an expanded pill by default, and a "collapsed" state
// that hid even the faces and left a lone chevron. The strip in bb's bar
// inverts it — you always see who is in the room, and the controls are one
// click away in a popover hanging below.
//
// This is the fold/unfold state machine, split out of dock.ts for the same
// reason as anchor.ts: there is no jsdom here, so anything decided inline in
// the DOM file is decided where no test can reach it.
import { describe, expect, it } from "vitest";
import { EXPANDED_AT_LOAD, nextExpanded } from "../canvas/dock/expand.js";

describe("EXPANDED_AT_LOAD", () => {
  it("is folded, on every page load, with nothing persisted", () => {
    // Deliberately a constant and not a stored preference: the strip is bb's
    // furniture now, and furniture does not remember that you once opened it.
    expect(EXPANDED_AT_LOAD).toBe(false);
  });
});

describe("nextExpanded", () => {
  it("opens the popover when the strip is clicked", () => {
    expect(nextExpanded(false, { type: "strip-click" })).toBe(true);
  });

  it("folds again on a second click of the strip", () => {
    expect(nextExpanded(true, { type: "strip-click" })).toBe(false);
  });

  it("folds on Escape", () => {
    expect(nextExpanded(true, { type: "escape" })).toBe(false);
  });

  it("does nothing on Escape when it is already folded", () => {
    // So the dock can tell "no change" from "changed" and skip the repaint —
    // Escape is pressed constantly in bb for reasons that have nothing to do
    // with us.
    expect(nextExpanded(false, { type: "escape" })).toBe(false);
  });

  it("folds on a click outside", () => {
    expect(nextExpanded(true, { type: "outside-click" })).toBe(false);
  });

  it("stays open for a click inside the popover", () => {
    // Pressing mute must not close the thing you pressed it in.
    expect(nextExpanded(true, { type: "popover-click" })).toBe(true);
  });

  it("forces itself open to show a status message", () => {
    // "LiveKit not configured — …" is the answer on every fresh install, and it
    // is reported into the popover. A message delivered into a fold nobody can
    // see is a message that was not delivered.
    expect(nextExpanded(false, { type: "status", text: "LiveKit not configured — …" })).toBe(
      true,
    );
  });

  it("does not re-open itself when the status is merely cleared", () => {
    // Clearing is what every join/leave click does first; if that counted as a
    // status the popover could never be closed.
    expect(nextExpanded(false, { type: "status", text: "" })).toBe(false);
    expect(nextExpanded(true, { type: "status", text: "" })).toBe(true);
  });

  it("folds when the strip is re-anchored into a different header", () => {
    // A popover is positioned against the strip. Moving the strip — a route
    // change, or dropping to the fixed fallback — leaves the popover pointing
    // at where the strip used to be, so navigation folds it.
    expect(nextExpanded(true, { type: "reanchored" })).toBe(false);
  });

  it("folds after panning the camera to somebody", () => {
    // Clicking a face in the popover flies the canvas to that person; keeping
    // a popover open over the thing you just asked to look at is the one
    // outcome nobody wants.
    expect(nextExpanded(true, { type: "pan" })).toBe(false);
  });
});

describe("nextExpanded — the jump link", () => {
  it("folds when a jump link is taken", () => {
    // Same reasoning as "pan": you asked to be taken somewhere else, and
    // leaving a popover hanging over the page you were sent to is the one
    // outcome nobody wants. It is a separate event from "pan" because the two
    // gestures are separate affordances on the same face — one moves the
    // canvas camera, the other moves bb.
    expect(nextExpanded(true, { type: "jump" })).toBe(false);
  });

  it("changes nothing when the popover was already folded", () => {
    // A jump can be taken by keyboard from a folded strip in principle; the
    // transition must not open a popover in response to being navigated away.
    expect(nextExpanded(false, { type: "jump" })).toBe(false);
  });
});

describe("nextExpanded — the transcript button", () => {
  it("folds when the transcript panel opened", () => {
    // The button lives in the popover's controls row now, so the popover is
    // physically over the panel it just opened. Same reasoning as "pan" and
    // "jump" above: you asked to look at something, and the popover is in
    // front of it.
    expect(nextExpanded(true, { type: "transcript" })).toBe(false);
  });

  it("changes nothing when the popover was already folded", () => {
    // A folded strip cannot have produced this event today, but the
    // transition must never be the thing that OPENS a popover in response to
    // being sent somewhere.
    expect(nextExpanded(false, { type: "transcript" })).toBe(false);
  });

  it("still lets a refusal force the popover open", () => {
    // A decline is reported on the status line, which lives INSIDE the
    // popover. Only the opened branch folds; the refusal branch sets a status
    // and this is what keeps that readable.
    expect(
      nextExpanded(false, {
        type: "status",
        text: "BB declined to open the room transcript panel here.",
      }),
    ).toBe(true);
  });
});
