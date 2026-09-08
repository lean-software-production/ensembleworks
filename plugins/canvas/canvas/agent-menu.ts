// THE AGENT AFFORDANCE'S OPEN/CLOSED STATE.
//
// One affordance, two arms (canvas/agent-arms.ts), and the attach arm opens a
// SECOND surface — the thread picker. So "is it open" is three states rather
// than a boolean, and every transition between them is a decision.
//
// WHY NOT `useState` IN agents-ui.tsx. This project has no jsdom and may not
// gain one, so branches written inline in a component are branches no test can
// drive — the same reason canvas/pages/page-menu.ts holds `nextPageMenuOpen`
// rather than PageSwitcher.tsx, stated there. This module is deliberately
// shaped like that one, down to the event names, because it is the same kind of
// decision about a different popover.
import type { AgentArmId } from "./agent-arms.js";

/** `arms` is the two-item menu; `picker` is the searchable thread list that
 * replaces it. Never both: the picker is the arms menu's second page, not a
 * surface hanging off it, so there is no state in which two lists are on
 * screen fighting for the same anchor. */
export type AgentMenuState = "closed" | "arms" | "picker";

export type AgentMenuEvent =
  /** The affordance's own button was clicked — the toggle. */
  | { readonly type: "button-click" }
  /** One of the two arms was chosen. Only ever fired from an ENABLED item;
   * enablement is `agentArmsFor`'s answer and the DOM's `disabled` attribute,
   * not this machine's. */
  | { readonly type: "arm"; readonly id: AgentArmId }
  /** Escape, anywhere in the window. */
  | { readonly type: "escape" }
  /** A pointerdown landed somewhere. `insideWidget` covers the button AND both
   * surfaces — see the "pointerdown" case. */
  | { readonly type: "pointerdown"; readonly insideWidget: boolean }
  /** An attach was submitted. */
  | { readonly type: "attached" }
  /** The selection moved to a different shape (or to none). */
  | { readonly type: "target-changed" };

/**
 * One transition. Returns the SAME state when nothing moved, so a render can be
 * skipped — Escape and pointerdowns arrive constantly for reasons that have
 * nothing to do with this menu.
 */
export function nextAgentMenu(
  state: AgentMenuState,
  event: AgentMenuEvent,
): AgentMenuState {
  switch (event.type) {
    case "button-click":
      // FROM THE PICKER THIS CLOSES OUTRIGHT rather than stepping back to the
      // arms. The button is the affordance's toggle; a second press of the
      // thing that opened this means shut, at whatever depth it is at.
      return state === "closed" ? "arms" : "closed";
    case "arm":
      // Launch ACTS — the rpc is already in flight — so its menu has nothing
      // left to say. Attach only ASKS, so it opens the surface that asks.
      if (state !== "arms") return state;
      return event.id === "attach" ? "picker" : "closed";
    case "escape":
      // ONE ESCAPE, NOT TWO. Stepping the picker back to the arms would make
      // dismissing the whole affordance a two-key gesture, which is not what
      // Escape means anywhere else in this plugin.
      return "closed";
    case "pointerdown":
      // THE LESSON canvas/dock/dock.ts's `insideWidget` RECORDS, carried over
      // rather than re-learned: neither surface is a descendant of the button
      // (the picker is portalled to <body>), so a containment check that knows
      // only about the button reads every press on a control INSIDE the picker
      // as "outside" and dismisses on the way down — before the click that
      // operates the control arrives. `insideWidget` is the caller's answer for
      // every root, which is why it is a boolean here and not a Node.
      return event.insideWidget ? state : "closed";
    case "attached":
      // Done. Leaving the list hanging over the shape it just bound is the one
      // outcome nobody wants — the same call `nextPageMenuOpen` makes for a
      // page switch.
      return "closed";
    case "target-changed":
      // THE ANCHOR WENT. Every surface here is positioned against the selected
      // shape's screen box, so a menu left open after the selection moves is a
      // menu whose buttons act on a shape the user is no longer looking at.
      return "closed";
  }
}
