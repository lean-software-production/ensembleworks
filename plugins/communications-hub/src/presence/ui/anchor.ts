/**
 * Where the presence row lives in bb's sidebar, and when it has to move.
 *
 * The row is one line of furniture immediately ABOVE the sidebar footer — the
 * `[data-sidebar="footer"]` element bb renders under the thread list, beside
 * which other plugins already put their own footer buttons. Sitting there is the
 * whole of option B: it costs 36px once, it never joins the scrolling thread
 * list (so the list keeps its own scroll position and its own scrollbar), and it
 * survives every route change because a content script does.
 *
 * TWO LEVELS AND A RETREAT, in priority order:
 *
 *   1. FOOTER — the row becomes the footer's previous sibling. This is the
 *      designed position and the one every normal route offers.
 *   2. SIDEBAR END — a sidebar rendered without a footer still has a bottom, so
 *      the row becomes the last child of `[data-sidebar="sidebar"]`. Same place
 *      on screen, one fewer assumption about bb's chrome.
 *   3. NOWHERE — no sidebar in the document at all (a route that renders none,
 *      or a mobile drawer that is closed). The row is REMOVED rather than left
 *      floating: presence is sidebar furniture, and a pill hovering over
 *      somebody's work is a different product than the one that was approved.
 *
 * WHY THE DECISION IS A PURE FUNCTION. bb re-renders the sidebar on navigation,
 * and a decision made inline against `document` is a decision no test can reach.
 * `decideAnchor` is generic over an opaque element handle so the interesting
 * cases — the footer was replaced by an identical-looking one, our node drifted,
 * the mobile drawer opened over the desktop sidebar — are driven by plain
 * objects in tests/presence-anchor.test.ts.
 *
 * WRITING INTO A REACT-RENDERED CONTAINER IS SAFE, WITH ONE CONDITION. React
 * reconciles only the children it created, matched positionally against its own
 * last render, and never walks a container looking for strangers. It can shuffle
 * a foreign node's position; it cannot remove it. So the condition is that we
 * notice drift and undo it — which is why "am I still immediately before that
 * exact footer" is part of the decision and not a tidiness check. Every fix is a
 * MOVE of the single node we own (inserting a node already in the document
 * relocates it), so no number of re-renders can produce a second row.
 */

export type AnchorAttachment<T> =
  | { readonly kind: "footer"; readonly host: T }
  | { readonly kind: "sidebar"; readonly host: T };

export interface AnchorInput<T> {
  /** The footer of the sidebar we should be in, or null when it has none. */
  readonly footer: T | null;
  /** That sidebar's root element, or null when no sidebar is in the document. */
  readonly sidebar: T | null;
  /** Where we put ourselves last time. Null before the first sync. */
  readonly attached: AnchorAttachment<T> | null;
  /** Whether our node is still in the document. */
  readonly connected: boolean;
  /** Whether our node is still the footer's immediate previous sibling. */
  readonly beforeFooter: boolean;
  /** Whether our node is still the last child of the sidebar root. */
  readonly lastInSidebar: boolean;
}

export type AnchorDecision<T> =
  | { readonly action: "none" }
  | { readonly action: "footer"; readonly host: T }
  | { readonly action: "sidebar"; readonly host: T }
  | { readonly action: "detach" };

/**
 * One placement decision: the highest level this route supports wins, and
 * "do nothing" is only allowed when we are already exactly there.
 *
 * Reads the same way at both levels: this level exists, so unless we are
 * attached AT it, to THAT element (identity, not "an element of the right
 * shape"), still in the document, and still in the right position relative to
 * it — move.
 */
export function decideAnchor<T>(input: AnchorInput<T>): AnchorDecision<T> {
  if (input.footer !== null) {
    const settled = input.attached?.kind === "footer" &&
      input.attached.host === input.footer &&
      input.connected &&
      input.beforeFooter;
    return settled ? { action: "none" } : { action: "footer", host: input.footer };
  }
  if (input.sidebar !== null) {
    const settled = input.attached?.kind === "sidebar" &&
      input.attached.host === input.sidebar &&
      input.connected &&
      input.lastInSidebar;
    return settled ? { action: "none" } : { action: "sidebar", host: input.sidebar };
  }
  return input.attached !== null || input.connected ? { action: "detach" } : { action: "none" };
}

/** One candidate sidebar found in the document. */
export interface SidebarCandidate<T> {
  readonly root: T;
  readonly footer: T | null;
  /** True for bb's mobile drawer, which is rendered beside the desktop one. */
  readonly mobile: boolean;
  /** False when the element is present but not being shown (a closed drawer). */
  readonly visible: boolean;
}

/**
 * Pick the ONE sidebar to live in.
 *
 * bb renders a desktop sidebar and a mobile drawer from the same tree, so on a
 * narrow window there can be two `[data-sidebar="footer"]` elements in the
 * document at once. Choosing between them — rather than mounting into each — is
 * what keeps a single row on screen: the row is one node that moves, so an open
 * drawer takes it and closing the drawer hands it back.
 *
 * A visible drawer wins because it is the sidebar the user is actually looking
 * at; otherwise the first visible sidebar does. Nothing visible means nowhere to
 * be, and `decideAnchor` then removes the row.
 */
export function chooseSidebar<T>(candidates: readonly SidebarCandidate<T>[]): SidebarCandidate<T> | null {
  const visible = candidates.filter((candidate) => candidate.visible);
  return visible.find((candidate) => candidate.mobile) ?? visible[0] ?? null;
}
