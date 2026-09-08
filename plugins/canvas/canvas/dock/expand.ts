// Folded or open — the strip's one piece of local state.
//
// THE POLARITY IS INVERTED FROM THE OLD DOCK, on purpose. That one defaulted to
// a fully expanded pill and offered a "collapse" that hid even the faces,
// leaving a lone chevron: the useful half was what folded away, and the state
// was persisted so a stray click followed you around bb forever.
//
// Here, MINIMISED IS THE PRODUCT: the avatar strip in bb's bar — bubbles,
// initials, speaking ring, "+N", and a dot when you are in a call. Expanding is
// the exception, it hangs below the strip, and it is never remembered. Nothing
// touches localStorage in this module, which is the point: every page load
// starts folded, so there is no stored key that can strand the popover open.
//
// Split out of dock.ts because this project has no jsdom (and no network to add
// one), so a state machine written inline in the DOM file is one no test can
// reach. tests/dock-expand.test.ts drives every transition here.

export type ExpandEvent =
  /** The strip itself was clicked — the toggle. */
  | { readonly type: "strip-click" }
  /** Escape anywhere in the window. */
  | { readonly type: "escape" }
  /** A pointerdown that landed outside the whole widget. */
  | { readonly type: "outside-click" }
  /** A click that landed inside the popover — a control, not a dismissal. */
  | { readonly type: "popover-click" }
  /** The strip moved to a different header row, or to the fixed fallback. */
  | { readonly type: "reanchored" }
  /** An avatar was clicked and the canvas was asked to fly to that person. */
  | { readonly type: "pan" }
  /** A jump link was taken — bb is navigating to where that person is. */
  | { readonly type: "jump" }
  /** The room transcript panel was actually opened. Only the ACCEPTED open
   * raises this: a refusal is reported on the status line, which lives inside
   * the popover. */
  | { readonly type: "transcript" }
  /** The status line changed. Empty text means "cleared". */
  | { readonly type: "status"; readonly text: string };

/**
 * The state at every page load.
 *
 * A constant rather than a read, and that is the whole design: the old
 * `canvas-av-dock:collapsed` localStorage key is gone, so there is nothing to
 * migrate, nothing to clear, and no way for the popover to come back open.
 */
export const EXPANDED_AT_LOAD = false;

/** One transition. Returns the SAME boolean when nothing moved, so the dock can
 * skip a repaint — Escape and clicks arrive constantly for reasons that have
 * nothing to do with us. */
export function nextExpanded(expanded: boolean, event: ExpandEvent): boolean {
  switch (event.type) {
    case "strip-click":
      return !expanded;
    case "escape":
    case "outside-click":
    case "reanchored":
    // Clicking a face flies the canvas camera to that person; taking their
    // jump link sends bb to the page they are on. Leaving a popover open over
    // the thing you just asked to look at is the one outcome nobody wants —
    // and these are two separate affordances on the same face, so they are two
    // events rather than one reused one.
    case "pan":
    case "jump":
    // And the third of the same kind, now that the 📜 button lives in the
    // popover's own controls row rather than in bb's header: the transcript
    // panel opens where the popover is hanging. The reasoning above is
    // unchanged, which is why this is a case label and not a paragraph.
    case "transcript":
      return false;
    case "popover-click":
      return expanded;
    case "status":
      // Forced open to report. "LiveKit not configured — …" is the answer on
      // every fresh install and it is rendered inside the popover; delivered
      // into a fold nobody can see, it is not delivered. Clearing (the first
      // thing every join/leave click does) must NOT count, or the popover
      // could never be closed.
      return event.text === "" ? expanded : true;
  }
}
