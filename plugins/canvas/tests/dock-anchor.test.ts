// Run: npx vitest run tests/dock-anchor.test.ts
//
// WHERE THE STRIP LIVES. The dock is no longer a floating pill: it is bar
// furniture inside bb's own page-header row
// (`[data-testid="app-page-header-content-row"]`). Within that row it aims at
// one specific slot — the FIRST CHILD of the row's right-hand actions cluster,
// so it is leftmost of whatever buttons the page puts there — and only falls
// back to the trailing edge of the row on the routes whose header has no
// actions at all, and to a fixed corner on the routes (bb's home) that have no
// header row at all.
//
// So the placement is a THREE-LEVEL CHAIN and its level is dynamic: the same
// window walks up it navigating settings → thread and back down again on the
// way out. The row is React-rendered and is torn down and rebuilt on every
// route change, so "which level am I on, am I still where that level says, and
// if not where do I go" is a decision the dock has to make several times per
// navigation.
//
// It is a decision, so it is here and not in dock.ts. There is no jsdom in this
// project (and no network to add one), which is exactly why the last placement
// bug got in: it was written inline against `document` and could only be
// checked by looking at a browser. `decideAnchor` is generic over an opaque
// element handle, so these tests drive it with plain objects.
import { describe, expect, it } from "vitest";
import {
  ACTIONS_CLUSTER_MARKERS,
  createDockAnchor,
  decideAnchor,
  findActionsCluster,
  type AnchorHost,
} from "../canvas/dock/anchor.js";

/** Stand-ins for the header row element. Identity is all the decision reads. */
const rowA = { id: "row-a" };
const rowB = { id: "row-b" };
/** Stand-ins for the row's right-hand actions cluster, the element the strip
 * wants to be the first child of. */
const actionsA = { id: "actions-a" };
const actionsB = { id: "actions-b" };

describe("decideAnchor — level 1, the row's actions cluster", () => {
  it("moves into the actions cluster the first time one is seen", () => {
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: null,
        connected: false,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "before", host: actionsA });
  });

  it("stays put when it is already the first child of that same cluster", () => {
    // The hot path on a thread route: the observer fires for every unrelated
    // DOM change bb makes, and the answer is almost always "nothing to do".
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: false,
        first: true,
      }),
    ).toEqual({ action: "none" });
  });

  it("re-inserts when React has rendered a node into its first-child slot", () => {
    // The level-1 equivalent of "no longer trailing": inserting a foreign node
    // into a React-rendered container is only tolerable while we can restore
    // our position, and drifting out of it is the cue to do so.
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "before", host: actionsA });
  });

  it("re-inserts when the cluster was unmounted with our node inside it", () => {
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: false,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "before", host: actionsA });
  });

  it("follows a NEW cluster element that has replaced the old one", () => {
    // Our node may still be connected — inside a detached-but-not-collected old
    // header, or beside a cluster that is no longer the one on screen.
    // Identity, not connectedness, is the test.
    expect(
      decideAnchor({
        actions: actionsB,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: true,
        first: true,
      }),
    ).toEqual({ action: "before", host: actionsB });
  });

  it("outranks the row: a cluster promotes a strip sitting at the trailing edge", () => {
    // settings → thread. This is the whole point of the chain being dynamic.
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: { kind: "row", host: rowA },
        connected: true,
        last: true,
        first: false,
      }),
    ).toEqual({ action: "before", host: actionsA });
  });

  it("outranks fixed too, even on a route with no row of its own", () => {
    expect(
      decideAnchor({
        actions: actionsA,
        row: null,
        attached: { kind: "fixed" },
        connected: true,
        last: true,
        first: true,
      }),
    ).toEqual({ action: "before", host: actionsA });
  });
});

describe("decideAnchor — level 2, the trailing edge of the row", () => {
  it("moves into the header row the first time one is seen", () => {
    expect(
      decideAnchor({
        actions: null,
        row: rowA,
        attached: null,
        connected: false,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "row", host: rowA });
  });

  it("stays put when it is already the trailing child of that same row", () => {
    // The hot path: the observer fires for every unrelated DOM change bb makes,
    // and the answer is almost always "nothing to do".
    expect(
      decideAnchor({
        actions: null,
        row: rowA,
        attached: { kind: "row", host: rowA },
        connected: true,
        last: true,
        first: false,
      }),
    ).toEqual({ action: "none" });
  });

  it("re-appends itself when React has rendered a sibling after it", () => {
    // Appending a trailing child into a React container is only safe while we
    // stay trailing; a node that has drifted into the middle of the row is a
    // node React may reconcile around.
    expect(
      decideAnchor({
        actions: null,
        row: rowA,
        attached: { kind: "row", host: rowA },
        connected: true,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "row", host: rowA });
  });

  it("re-attaches when the row it was in was unmounted with our node inside", () => {
    // The route change case: React threw away the whole header, taking our
    // node out of the document with it.
    expect(
      decideAnchor({
        actions: null,
        row: rowA,
        attached: { kind: "row", host: rowA },
        connected: false,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "row", host: rowA });
  });

  it("follows the row when a NEW row element has replaced the old one", () => {
    // The nastier route change: our node is still connected — inside the
    // detached-but-not-collected old row, or inside a row that is no longer the
    // one the page is showing. Identity, not connectedness, is the test.
    expect(
      decideAnchor({
        actions: null,
        row: rowB,
        attached: { kind: "row", host: rowA },
        connected: true,
        last: true,
        first: false,
      }),
    ).toEqual({ action: "row", host: rowB });
  });

  it("demotes to the trailing edge when the actions cluster goes", () => {
    // thread → settings. The row survives the navigation; the cluster does not,
    // and a strip left pointing at a dead cluster is a strip in the wrong place.
    expect(
      decideAnchor({
        actions: null,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: true,
        first: true,
      }),
    ).toEqual({ action: "row", host: rowA });
  });

  it("leaves the fixed fallback the moment a row appears", () => {
    expect(
      decideAnchor({
        actions: null,
        row: rowA,
        attached: { kind: "fixed" },
        connected: true,
        last: true,
        first: false,
      }),
    ).toEqual({ action: "row", host: rowA });
  });
});

describe("decideAnchor — level 3, the fixed fallback", () => {
  it("falls back to fixed when the page has no header row", () => {
    // bb's home route renders zero <header> elements. The strip does not get to
    // disappear just because a route has no bar to sit in.
    expect(
      decideAnchor({
        actions: null,
        row: null,
        attached: null,
        connected: false,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "fixed" });
  });

  it("stays fixed while there is still no row", () => {
    expect(
      decideAnchor({
        actions: null,
        row: null,
        attached: { kind: "fixed" },
        connected: true,
        last: true,
        first: true,
      }),
    ).toEqual({ action: "none" });
  });

  it("re-mounts the fixed fallback if something removed our node", () => {
    expect(
      decideAnchor({
        actions: null,
        row: null,
        attached: { kind: "fixed" },
        connected: false,
        last: true,
        first: true,
      }),
    ).toEqual({ action: "fixed" });
  });

  it("drops out of a row that has gone, rather than riding it off-screen", () => {
    expect(
      decideAnchor({
        actions: null,
        row: null,
        attached: { kind: "row", host: rowA },
        connected: true,
        last: true,
        first: false,
      }),
    ).toEqual({ action: "fixed" });
  });

  it("drops all the way down when the whole header goes with the cluster", () => {
    expect(
      decideAnchor({
        actions: null,
        row: null,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: true,
        first: true,
      }),
    ).toEqual({ action: "fixed" });
  });
});

/** A scriptable AnchorHost that records every attach it is asked to perform.
 * `state.actions` stands for the cluster the marker climb resolves to: this
 * fake answers the first marker selector with it and hangs it directly off the
 * row, which is the thread-route shape. The climb itself is exercised against
 * real trees further down. */
function fakeHost(initial: {
  actions?: typeof actionsA | null;
  row?: typeof rowA | null;
  connected?: boolean;
  last?: boolean;
  first?: boolean;
}) {
  const attaches: Array<
    "fixed" | { host: { id: string } } | { before: { id: string } }
  > = [];
  const state = {
    actions: initial.actions ?? null,
    row: initial.row ?? null,
    connected: initial.connected ?? false,
    last: initial.last ?? false,
    first: initial.first ?? false,
  };
  const host: AnchorHost<{ id: string }> = {
    findMarker: (selector) =>
      selector === ACTIONS_CLUSTER_MARKERS[0] ? state.actions : null,
    parentOf: (node) => (node === state.actions ? state.row : null),
    findRow: () => state.row,
    isConnected: () => state.connected,
    isTrailingChildOf: () => state.last,
    isFirstChildOf: () => state.first,
    attachAsFirstChild: (target) => {
      attaches.push({ before: target });
      state.connected = true;
      state.first = true;
      // Sitting inside the actions cluster is, by construction, not sitting at
      // the trailing edge of the row.
      state.last = false;
    },
    attachToRow: (target) => {
      attaches.push({ host: target });
      state.connected = true;
      state.last = true;
      state.first = false;
    },
    attachFixed: () => {
      attaches.push("fixed");
      state.connected = true;
      state.last = true;
      state.first = false;
    },
  };
  return { host, state, attaches };
}

describe("createDockAnchor", () => {
  it("mounts into the actions cluster and then does nothing on every later sync", () => {
    const { host, attaches } = fakeHost({ actions: actionsA, row: rowA });
    const anchor = createDockAnchor(host);

    expect(anchor.sync()).toBe(true);
    expect(attaches).toEqual([{ before: actionsA }]);
    expect(anchor.mode()).toBe("before");

    // Idempotent: the MutationObserver behind this fires for every keystroke in
    // bb's composer, and a re-insert per keystroke would tear a <video> out of
    // the document several times a second.
    expect(anchor.sync()).toBe(false);
    expect(anchor.sync()).toBe(false);
    expect(attaches).toHaveLength(1);
  });

  it("mounts into the row and then does nothing on every later sync", () => {
    const { host, attaches } = fakeHost({ row: rowA });
    const anchor = createDockAnchor(host);

    expect(anchor.sync()).toBe(true);
    expect(attaches).toEqual([{ host: rowA }]);
    expect(anchor.mode()).toBe("row");

    expect(anchor.sync()).toBe(false);
    expect(anchor.sync()).toBe(false);
    expect(attaches).toHaveLength(1);
  });

  it("re-attaches exactly once when the row is replaced", () => {
    const fake = fakeHost({ row: rowA });
    const anchor = createDockAnchor(fake.host);
    anchor.sync();

    fake.state.row = rowB;
    expect(anchor.sync()).toBe(true);
    expect(anchor.sync()).toBe(false);
    expect(fake.attaches).toEqual([{ host: rowA }, { host: rowB }]);
  });

  it("re-inserts exactly once when the cluster element is replaced", () => {
    const fake = fakeHost({ actions: actionsA, row: rowA });
    const anchor = createDockAnchor(fake.host);
    anchor.sync();

    fake.state.actions = actionsB;
    expect(anchor.sync()).toBe(true);
    expect(anchor.sync()).toBe(false);
    expect(fake.attaches).toEqual([{ before: actionsA }, { before: actionsB }]);
  });

  it("promotes settings → thread and demotes thread → settings", () => {
    // The whole navigation, both ways, through one anchor: level 2, up to
    // level 1, back down to level 2. Each transition costs exactly one move.
    const fake = fakeHost({ row: rowA });
    const anchor = createDockAnchor(fake.host);

    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");

    // Navigate to a thread: React rebuilds the header, and this one has a
    // workflow-actions cluster in it.
    fake.state.row = rowB;
    fake.state.actions = actionsA;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(anchor.sync()).toBe(false);

    // Back to settings: same row element survives, cluster does not.
    fake.state.actions = null;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");
    expect(anchor.sync()).toBe(false);

    expect(fake.attaches).toEqual([
      { host: rowA },
      { before: actionsA },
      { host: rowB },
    ]);
  });

  it("swaps to fixed when the header goes and back when it returns", () => {
    const fake = fakeHost({ row: rowA });
    const anchor = createDockAnchor(fake.host);
    anchor.sync();

    fake.state.row = null;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("fixed");
    expect(anchor.sync()).toBe(false);

    fake.state.row = rowA;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");
    expect(fake.attaches).toEqual([{ host: rowA }, "fixed", { host: rowA }]);
  });

  it("climbs the whole chain: fixed → row → cluster, and falls back down it", () => {
    const fake = fakeHost({});
    const anchor = createDockAnchor(fake.host);

    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("fixed");

    fake.state.row = rowA;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");

    fake.state.actions = actionsA;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(anchor.sync()).toBe(false);

    // A route change that takes the whole header — cluster and row together —
    // must not leave the strip riding a detached cluster off-screen.
    fake.state.actions = null;
    fake.state.row = null;
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("fixed");

    expect(fake.attaches).toEqual([
      "fixed",
      { host: rowA },
      { before: actionsA },
      "fixed",
    ]);
  });

  it("never leaves a duplicate behind when the row re-renders under it", () => {
    // The one failure mode that would put TWO strips in bb's bar: a re-render
    // that leaves our node in place but no longer trailing must be a MOVE of
    // the same node, never a second mount.
    const fake = fakeHost({ row: rowA });
    const anchor = createDockAnchor(fake.host);
    anchor.sync();

    fake.state.last = false;
    expect(anchor.sync()).toBe(true);
    expect(fake.attaches).toEqual([{ host: rowA }, { host: rowA }]);
    expect(anchor.mode()).toBe("row");
  });

  it("never leaves a duplicate behind when the actions cluster re-renders under it", () => {
    // Same failure mode one level up: React rendering a sibling between us and
    // the cluster is a re-INSERT of the one node we own, not a second mount.
    const fake = fakeHost({ actions: actionsA, row: rowA });
    const anchor = createDockAnchor(fake.host);
    anchor.sync();

    fake.state.first = false;
    expect(anchor.sync()).toBe(true);
    expect(fake.attaches).toEqual([{ before: actionsA }, { before: actionsA }]);
    expect(anchor.mode()).toBe("before");
    expect(anchor.sync()).toBe(false);
  });

  it("starts with no opinion until it has been synced once", () => {
    const { host } = fakeHost({ row: rowA });
    expect(createDockAnchor(host).mode()).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// LEVEL 1 IS "FIRST CHILD OF THE ROW'S ACTIONS CLUSTER", not "before one
// particular thread element".
//
// The old level 1 aimed at `[data-thread-header-workflow-actions]` and inserted
// itself before it. On a thread route that IS the first child of the row's
// right-hand actions cluster, so the two readings agree — but on the canvas
// plugin page there is no workflow-actions element at all, level 1 did not
// apply, and the strip fell to the trailing edge of the row: to the RIGHT of
// the page's own open-sidebar button, the opposite side from everywhere else.
//
// So the target is named by what it IS — the cluster — and located by walking
// UP from whichever documented marker the page happens to carry. The markers
// are data-attributes bb puts on its own header content; the cluster itself has
// no name of its own, only Tailwind classes, which are not a contract.

/** A minimal tree with parent links, standing in for the piece of bb's header
 * the placement reads. There is no jsdom in this project and there is not going
 * to be, so the shapes below are hand-built from the real DOM the orchestrator
 * probed against a running bb: the row, its right-hand actions cluster, and the
 * marker elements bb tags inside that cluster. */
interface FakeEl {
  readonly tag: string;
  readonly markers: readonly string[];
  parent: FakeEl | null;
  children: FakeEl[];
}

function el(
  tag: string,
  markers: readonly string[] = [],
  children: FakeEl[] = [],
): FakeEl {
  const node: FakeEl = { tag, markers, parent: null, children };
  for (const child of children) child.parent = node;
  return node;
}

const ROW_MARKER = '[data-testid="app-page-header-content-row"]';
const WORKFLOW = "[data-thread-header-workflow-actions]";
const PANE = "[data-thread-header-pane-actions]";
const PORTAL = "[data-plugin-right-panel-toggle-portal]";

function find(root: FakeEl, selector: string): FakeEl | null {
  if (root.markers.includes(selector)) return root;
  for (const child of root.children) {
    const hit = find(child, selector);
    if (hit !== null) return hit;
  }
  return null;
}

function detach(node: FakeEl): void {
  const parent = node.parent;
  if (parent === null) return;
  parent.children = parent.children.filter((child) => child !== node);
  node.parent = null;
}

function insertAt(parent: FakeEl, node: FakeEl, index: number): void {
  detach(node);
  parent.children.splice(index, 0, node);
  node.parent = parent;
}

/** An AnchorHost over one of those trees, with the strip as a real node in it —
 * so "is the strip the cluster's first child" is answered by looking, not by a
 * flag the test set. */
function treeHost(body: FakeEl, strip: FakeEl) {
  const host: AnchorHost<FakeEl> = {
    findMarker: (selector) => find(body, selector),
    parentOf: (node) => node.parent,
    findRow: () => find(body, ROW_MARKER),
    isConnected: () => {
      let node: FakeEl | null = strip;
      while (node !== null) {
        if (node === body) return true;
        node = node.parent;
      }
      return false;
    },
    isTrailingChildOf: (target) => target.children.at(-1) === strip,
    isFirstChildOf: (target) => target.children[0] === strip,
    attachAsFirstChild: (target) => insertAt(target, strip, 0),
    attachToRow: (target) => insertAt(target, strip, target.children.length),
    attachFixed: () => insertAt(body, strip, body.children.length),
  };
  return host;
}

/** A thread route: the cluster's own children are the two thread markers. */
function threadBody(): { body: FakeEl; row: FakeEl; cluster: FakeEl } {
  const cluster = el("div", [], [el("div", [WORKFLOW]), el("div", [PANE])]);
  const row = el("div", [ROW_MARKER], [el("div", []), cluster]);
  const body = el("body", [], [el("header", [], [row])]);
  return { body, row, cluster };
}

/** The canvas plugin page: no thread markers at all — the only marker is the
 * right-panel toggle portal, and it is nested one wrapper deeper. */
function canvasBody(): { body: FakeEl; row: FakeEl; cluster: FakeEl } {
  const cluster = el("div", [], [el("div", [], [el("div", [PORTAL])])]);
  const row = el("div", [ROW_MARKER], [el("div", []), cluster]);
  const body = el("body", [], [el("header", [], [row])]);
  return { body, row, cluster };
}

describe("findActionsCluster — walking up from a marker to the row's child", () => {
  it("resolves the cluster, not the marker, on a thread route", () => {
    const { body, cluster } = threadBody();
    const host = treeHost(body, el("div"));
    expect(findActionsCluster(host, host.findRow())).toBe(cluster);
  });

  it("resolves the cluster on the canvas page, where the only marker is the panel-toggle portal", () => {
    const { body, cluster } = canvasBody();
    const host = treeHost(body, el("div"));
    expect(findActionsCluster(host, host.findRow())).toBe(cluster);
  });

  it("resolves the SAME cluster from each of the three markers alone", () => {
    // All three markers live inside one cluster, so which one a page happens to
    // carry — and therefore which one is found first — cannot change the answer.
    expect([...ACTIONS_CLUSTER_MARKERS]).toEqual([WORKFLOW, PANE, PORTAL]);
    for (const marker of ACTIONS_CLUSTER_MARKERS) {
      const cluster = el("div", [], [el("div", [], [el("div", [marker])])]);
      const row = el("div", [ROW_MARKER], [el("div", []), cluster]);
      const body = el("body", [], [el("header", [], [row])]);
      const host = treeHost(body, el("div"));
      expect(findActionsCluster(host, host.findRow())).toBe(cluster);
    }
  });

  it("resolves the marker itself when the marker IS the row's child", () => {
    const cluster = el("div", [WORKFLOW]);
    const row = el("div", [ROW_MARKER], [el("div", []), cluster]);
    const body = el("body", [], [row]);
    const host = treeHost(body, el("div"));
    expect(findActionsCluster(host, host.findRow())).toBe(cluster);
  });

  it("gives up when the climb never reaches a child of the row", () => {
    // A marker rendered into a portal outside the header — attaching relative to
    // whatever that climb happened to end on would put the strip somewhere
    // arbitrary, so level 1 is simply unavailable.
    const row = el("div", [ROW_MARKER], [el("div", [])]);
    const body = el(
      "body",
      [],
      [el("header", [], [row]), el("div", [], [el("div", [PORTAL])])],
    );
    const host = treeHost(body, el("div"));
    expect(findActionsCluster(host, host.findRow())).toBe(null);
  });

  it("is unavailable when the page carries no marker at all", () => {
    const row = el("div", [ROW_MARKER], [el("div", [])]);
    const body = el("body", [], [el("header", [], [row])]);
    const host = treeHost(body, el("div"));
    expect(findActionsCluster(host, host.findRow())).toBe(null);
  });

  it("is unavailable when there is no row to climb to", () => {
    const body = el("body", [], [el("div", [], [el("div", [PORTAL])])]);
    const host = treeHost(body, el("div"));
    expect(findActionsCluster(host, host.findRow())).toBe(null);
  });
});

describe("decideAnchor — level 1 is now 'am I the cluster's FIRST CHILD'", () => {
  it("stays put when it is already the first child of that same cluster", () => {
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: false,
        first: true,
      }),
    ).toEqual({ action: "none" });
  });

  it("re-inserts when React has rendered something into the first-child slot ahead of it", () => {
    expect(
      decideAnchor({
        actions: actionsA,
        row: rowA,
        attached: { kind: "before", host: actionsA },
        connected: true,
        last: false,
        first: false,
      }),
    ).toEqual({ action: "before", host: actionsA });
  });
});

describe("the strip in a fake header tree", () => {
  it("becomes the actions cluster's first child on a thread route", () => {
    const { body, cluster } = threadBody();
    const strip = el("div");
    const anchor = createDockAnchor(treeHost(body, strip));

    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(cluster.children[0]).toBe(strip);
    // The placement the user already approved: leftmost, with the thread's own
    // workflow and pane buttons still to its right, in that order.
    expect(cluster.children.map((child) => child.markers[0])).toEqual([
      undefined,
      WORKFLOW,
      PANE,
    ]);
    expect(anchor.sync()).toBe(false);
  });

  it("becomes the actions cluster's first child on the canvas page too", () => {
    // Same outcome, different marker: this is the bug. The strip used to land at
    // the trailing edge of the row here, to the RIGHT of the panel toggle.
    const { body, row, cluster } = canvasBody();
    const strip = el("div");
    const anchor = createDockAnchor(treeHost(body, strip));

    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(cluster.children[0]).toBe(strip);
    expect(row.children.at(-1)).not.toBe(strip);
    expect(anchor.sync()).toBe(false);
  });

  it("takes its first-child slot back when React renders into it, moving one node", () => {
    const { body, cluster } = canvasBody();
    const strip = el("div");
    const anchor = createDockAnchor(treeHost(body, strip));
    anchor.sync();

    insertAt(cluster, el("div", ["[data-late]"]), 0);
    expect(cluster.children[0]).not.toBe(strip);

    expect(anchor.sync()).toBe(true);
    expect(cluster.children[0]).toBe(strip);
    // A MOVE, never a second mount: exactly one strip, however many renders.
    expect(cluster.children.filter((child) => child === strip)).toHaveLength(1);
    expect(anchor.sync()).toBe(false);
  });

  it("falls to the row when the cluster is unmounted with the strip inside it", () => {
    const { body, row, cluster } = threadBody();
    const strip = el("div");
    const anchor = createDockAnchor(treeHost(body, strip));
    anchor.sync();

    detach(cluster);
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");
    expect(row.children.at(-1)).toBe(strip);

    // …and climbs back the moment a cluster reappears.
    insertAt(row, cluster, row.children.length);
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(cluster.children[0]).toBe(strip);
  });

  it("falls to the row when the only marker is outside the header", () => {
    const row = el("div", [ROW_MARKER], [el("div", [])]);
    const body = el(
      "body",
      [],
      [el("header", [], [row]), el("div", [], [el("div", [PORTAL])])],
    );
    const strip = el("div");
    const anchor = createDockAnchor(treeHost(body, strip));

    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");
    expect(row.children.at(-1)).toBe(strip);
  });

  it("walks settings → thread → canvas → home and back, one move per change", () => {
    // Four real page shapes through one strip. Settings has a row and no
    // cluster; thread and canvas both have one (different markers, same level);
    // home has no row at all.
    const settingsRow = el("div", [ROW_MARKER], [el("div", [])]);
    const body = el("body", [], [el("header", [], [settingsRow])]);
    const strip = el("div");
    const anchor = createDockAnchor(treeHost(body, strip));

    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("row");

    const thread = threadBody();
    body.children = [];
    insertAt(body, thread.body.children[0]!, 0);
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(thread.cluster.children[0]).toBe(strip);

    const canvas = canvasBody();
    body.children = body.children.filter((child) => child === strip);
    detach(strip);
    body.children = [];
    insertAt(body, canvas.body.children[0]!, 0);
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(canvas.cluster.children[0]).toBe(strip);

    // Home: no header row at all.
    body.children = [];
    detach(strip);
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("fixed");
    expect(body.children.at(-1)).toBe(strip);

    // …and straight back up to level 1 on the way in.
    const back = threadBody();
    insertAt(body, back.body.children[0]!, 0);
    expect(anchor.sync()).toBe(true);
    expect(anchor.mode()).toBe("before");
    expect(back.cluster.children[0]).toBe(strip);
    expect(anchor.sync()).toBe(false);
  });
});
