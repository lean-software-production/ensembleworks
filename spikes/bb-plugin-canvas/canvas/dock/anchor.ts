// Where the presence strip lives, and when it has to move.
//
// The strip is not a floating pill any more: it is bar furniture inside bb's
// own page-header row, `[data-testid="app-page-header-content-row"]` — the flex
// row that already holds the page title on the left and the page's action
// buttons on the right. Sitting IN that row is the whole point of the redesign:
// the strip lines up with, and looks identical to, the avatar stack the canvas
// page's `headerContent` used to render there, and it stops being an overlay
// that covers the composer.
//
// WITHIN the row it aims at one specific slot, and falls back twice — a
// THREE-LEVEL CHAIN, in priority order:
//
//   1. the row's right-hand ACTIONS CLUSTER — the strip becomes that cluster's
//      FIRST CHILD, so presence reads as the leftmost item of the button group
//      and the page's own controls (a thread's workflow and pane buttons, the
//      canvas page's open-sidebar toggle) all stay to its right.
//   2. no cluster, but a header row — the trailing child of the row. Settings,
//      whose header has no actions at all, lives here.
//   3. no row at all (bb's home route renders none) — `position: fixed` in the
//      same 48px band, so the strip never simply disappears.
//
// LEVEL 1 IS EXPRESSED AS "FIRST CHILD OF THE CLUSTER" AND NOT "BEFORE ONE
// PARTICULAR ELEMENT", because the earlier reading — insert before
// `[data-thread-header-workflow-actions]` — only named the cluster by way of a
// thread's own buttons. It agreed with this one on a thread route (those
// buttons ARE the cluster's first child) and had nothing to say about the
// canvas plugin page, which carries no such element: there the strip fell to
// level 2 and landed to the RIGHT of the page's open-sidebar button, the
// opposite side from every other route.
//
// FINDING THE CLUSTER. It has no name of its own — only Tailwind classes,
// which are a restyle away from meaning something else and are not a contract.
// What bb does name are the things INSIDE it, so `findActionsCluster` takes the
// first of those markers the page carries and walks UP from it until it reaches
// the element whose parent is the header row. That element is the cluster,
// whichever marker the climb started from (all three sit inside the same one),
// and if the climb never reaches a child of the row the cluster counts as
// ABSENT — better level 2, which is a defined place, than attaching relative to
// whatever a stray portal happened to climb to.
//
// THE LEVEL IS DYNAMIC, and that is the interesting part. One window walks up
// the chain navigating settings → thread and back down leaving it, so the
// decision is not "where do I mount" once but "which level does the page
// support right now, and am I actually there" — asked again several times per
// navigation.
//
// WRITING INTO A REACT CONTAINER IS DELIBERATE AND IS SAFE HERE, with one
// condition this module enforces. React reconciles only the children it created
// itself, matched positionally against its own last render, and it never walks
// the container looking for strangers. What it DOES do is `insertBefore` and
// `removeChild` against its own nodes — which can shuffle a foreign node's
// position but not its existence. So the condition is that we notice when our
// position has drifted and restore it: `last`/`isTrailingChildOf` at level 2,
// `first`/`isFirstChildOf` at level 1. Those are not tidiness checks —
// they are what keeps the arrangement legal. Every restore is a MOVE of the one
// node we own (inserting a node already in the document relocates it), so no
// number of re-renders can ever produce a second strip.
//
// The other half is that the row is route-scoped. React tears the whole header
// down and builds a new one on navigation (and bb's home route renders no
// <header> at all), so "which level am I on, is that still the element, and is
// my node even in the document" gets asked several times per navigation — by a
// MutationObserver in dock.ts that knows nothing except when to ask.
//
// EVERY ANSWER IS HERE AND NOT IN dock.ts. There is no jsdom in this project
// and no network to add one, so anything decided inline against `document` is
// decided where no test can reach it — which is exactly how the last placement
// bug got in. `decideAnchor` is generic over an opaque element handle and
// `createDockAnchor` runs over an injected `AnchorHost`, so both are driven by
// plain objects in tests/dock-anchor.test.ts.

/** Where the strip currently believes it is. `host` is the element the
 * placement is expressed RELATIVE to: the actions cluster we are the first
 * child of, or the row we sit at the end of. (The level-1 tag is still
 * `"before"` — it is the name of the level, and the `data-dock-anchor` value
 * the stylesheet switches on, both of which predate the slot being widened
 * from "before those buttons" to "first in that cluster".) */
export type AnchorAttachment<T> =
  | { readonly kind: "before"; readonly host: T }
  | { readonly kind: "row"; readonly host: T }
  | { readonly kind: "fixed" };

export interface AnchorInput<T> {
  /** The header row's right-hand actions cluster in the document right now (see
   * `findActionsCluster`), or null on every route that has none. */
  readonly actions: T | null;
  /** The header row in the document right now, or null on a route without one. */
  readonly row: T | null;
  /** Where we put ourselves last time. Null before the first sync. */
  readonly attached: AnchorAttachment<T> | null;
  /** Whether our node is still in the document. */
  readonly connected: boolean;
  /** Whether our node is still the LAST child of `attached.host`. Only read
   * while `attached.kind === "row"`. */
  readonly last: boolean;
  /** Whether our node is still the FIRST child of `attached.host`. Only read
   * while `attached.kind === "before"`. */
  readonly first: boolean;
}

export type AnchorDecision<T> =
  | { readonly action: "none" }
  | { readonly action: "before"; readonly host: T }
  | { readonly action: "row"; readonly host: T }
  | { readonly action: "fixed" };

/**
 * One placement decision: the highest level the page currently supports wins,
 * and "do nothing" is only allowed when we are already exactly there.
 *
 * Reads, at every level, as the same sentence: this level is available, so
 * unless we are attached AT this level, to THAT element (identity, not "some
 * element of the right shape"), still in the document, and still in the right
 * position relative to it — move.
 *
 * A higher level appearing therefore always beats a settled lower one, which is
 * what promotes the strip on settings → thread; a level disappearing drops us
 * to the next one down, which is what demotes it on the way back.
 */
export function decideAnchor<T>(input: AnchorInput<T>): AnchorDecision<T> {
  const { actions, row, attached, connected, last, first } = input;

  if (actions !== null) {
    const settled =
      attached !== null &&
      attached.kind === "before" &&
      attached.host === actions &&
      connected &&
      first;
    return settled ? { action: "none" } : { action: "before", host: actions };
  }

  if (row !== null) {
    const settled =
      attached !== null &&
      attached.kind === "row" &&
      attached.host === row &&
      connected &&
      last;
    return settled ? { action: "none" } : { action: "row", host: row };
  }

  const settled = attached !== null && attached.kind === "fixed" && connected;
  return settled ? { action: "none" } : { action: "fixed" };
}

/**
 * The elements bb names inside the header row's right-hand actions cluster, in
 * the order they are looked for. Every one of them resolves to the SAME cluster
 * on any page that has one, so the order is not a priority — it is only which
 * question gets asked first:
 *
 *   * `[data-thread-header-workflow-actions]` — a thread's Run/workflow buttons
 *   * `[data-thread-header-pane-actions]`     — a thread's side-pane buttons
 *   * `[data-plugin-right-panel-toggle-portal]` — the open-sidebar toggle a
 *     plugin page (the canvas page among them) renders there
 *
 * Data attributes and not the cluster's own classes: those are Tailwind, they
 * change with any restyle, and matching them would make a restyle a placement
 * bug. These are the nearest thing to a name bb has given this content.
 */
export const ACTIONS_CLUSTER_MARKERS: readonly string[] = [
  "[data-thread-header-workflow-actions]",
  "[data-thread-header-pane-actions]",
  "[data-plugin-right-panel-toggle-portal]",
];

/**
 * The header row's right-hand actions cluster, or null if this page has none.
 *
 * The cluster is defined structurally — "the row's child that contains the
 * page's action buttons" — so it is found structurally: take the first marker
 * the page carries and climb until the node whose PARENT is the row. That is
 * the cluster on a thread route (markers one level down), on the canvas page
 * (marker two levels down, inside a wrapper), and on anything else bb grows
 * later that reuses the same header content.
 *
 * The climb is guarded rather than trusted. A marker rendered somewhere else
 * entirely — a portal outside the header — climbs to the top without ever
 * passing the row, and the answer for that is "no cluster", which drops the
 * strip to level 2. The failure mode being avoided is attaching to whatever
 * element the climb happened to stop on, which is a placement nobody chose.
 */
export function findActionsCluster<T>(
  host: Pick<AnchorHost<T>, "findMarker" | "parentOf">,
  row: T | null,
): T | null {
  if (row === null) return null;
  for (const selector of ACTIONS_CLUSTER_MARKERS) {
    let node = host.findMarker(selector);
    while (node !== null) {
      const parent = host.parentOf(node);
      if (parent === row) return node;
      node = parent;
    }
  }
  return null;
}

/** The DOM operations the runner needs, injected so the runner is testable. */
export interface AnchorHost<T> {
  /** The first element in the document matching `selector`, or null. Called
   * only with the marker selectors in `ACTIONS_CLUSTER_MARKERS`. */
  findMarker(selector: string): T | null;
  /** The parent element of `node`, or null at the top of the tree. */
  parentOf(node: T): T | null;
  /** The header row currently in the document, or null. */
  findRow(): T | null;
  /** Is our root node still in the document? */
  isConnected(): boolean;
  /** Is our root node the last child of `host`? */
  isTrailingChildOf(host: T): boolean;
  /** Is our root node the FIRST child of `host`? */
  isFirstChildOf(host: T): boolean;
  /** Move (never copy) our root to the front of `host`'s children. */
  attachAsFirstChild(host: T): void;
  /** Move (never copy) our root to the end of `host`. */
  attachToRow(host: T): void;
  /** Move (never copy) our root into the fixed fallback position. */
  attachFixed(): void;
}

export interface DockAnchor {
  /** Re-decide and act. Returns whether the strip actually MOVED, which is the
   * dock's cue to fold an open popover — it is positioned against a strip that
   * is no longer where it was. */
  sync(): boolean;
  /** Which level of the chain the strip is on, for the `data-dock-anchor`
   * attribute the stylesheet switches on. Null until the first sync. */
  mode(): "before" | "row" | "fixed" | null;
}

export function createDockAnchor<T>(host: AnchorHost<T>): DockAnchor {
  let attached: AnchorAttachment<T> | null = null;

  return {
    sync(): boolean {
      // One read of the row, used twice: as level 2's own answer and as the
      // rung the level-1 climb has to reach.
      const row = host.findRow();
      const decision = decideAnchor({
        actions: findActionsCluster(host, row),
        row,
        attached,
        connected: host.isConnected(),
        // Each position check is asked only while we believe we are at the
        // level that gives it meaning. Asking otherwise would be a layout-free
        // but pointless DOM read on a path that runs every animation frame bb
        // touches the document in.
        last:
          attached !== null && attached.kind === "row"
            ? host.isTrailingChildOf(attached.host)
            : false,
        first:
          attached !== null && attached.kind === "before"
            ? host.isFirstChildOf(attached.host)
            : false,
      });

      if (decision.action === "none") return false;
      // Every branch below is a MOVE of the one node we own, not a second
      // mount: inserting a node that is already in the document relocates it,
      // so there is exactly one strip however many times this runs.
      if (decision.action === "before") {
        host.attachAsFirstChild(decision.host);
        attached = { kind: "before", host: decision.host };
        return true;
      }
      if (decision.action === "row") {
        host.attachToRow(decision.host);
        attached = { kind: "row", host: decision.host };
        return true;
      }
      host.attachFixed();
      attached = { kind: "fixed" };
      return true;
    },

    mode: () => attached?.kind ?? null,
  };
}
