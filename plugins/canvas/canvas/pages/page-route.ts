// WHICH PAGE THE URL NAMES, AND WHO MOVED. No DOM, no React, no router.
//
// Task C2a of docs/plans/2026-09-05-bb-canvas-multi-page-design.md (D-3).
// bb renders a nav panel for `/plugins/<pluginId>/<path>/*` and hands the
// panel the route remainder as its `subPath` prop; navigation within the panel
// is `useBbNavigate().toPluginPanel(path, { subPath })`, after which browser
// back/forward walks panel-internal history. Both of those are quoted from the
// SDK's bundled types (@get-bb/plugin-sdk, bb-plugin-sdk-app.d.ts:344-355 and
// :2086) — they are the SDK's documented promise, not something this plugin
// has exercised against a running bb host.
//
// THE HAZARD THIS MODULE EXISTS FOR. Two values now describe one fact: the
// URL's `subPath` and the editor's `currentPageId`. The URL drives the editor
// (a deep link, a Back press) and the editor drives the URL (a click on a page
// tab). Two arrows into one pair is a ping-pong unless something arbitrates,
// and the arbitration is not obvious — "they differ" is true in BOTH
// directions and says nothing about which one moved.
//
// WHAT SETTLES IT: `settled`, the subPath value this module last reconciled.
// If the observed subPath is not that value, the ROUTER moved and the editor
// should follow; otherwise the EDITOR moved and the URL should follow. That is
// the whole rule, and tests/page-route.test.ts drives it as sequences rather
// than as single calls, because every way of getting it wrong is a way of
// getting the NEXT step wrong.
//
// WHY `settled` RECORDS WHAT WAS OBSERVED, NEVER WHAT WAS INTENDED. If a
// navigation silently fails to land — and this plugin has been burned by
// somebody else's router before, which is why canvas/dock/navigate.ts verifies
// its own jump instead of assuming it took — the subPath simply never changes.
// Recording the intended value would then make the unchanged URL look like a
// Back press on the next pass, and the user's next page switch would yank them
// back to the page they left.
//
// Recording the OBSERVED value degrades differently, and the degradation is
// worth stating accurately rather than waving at: the address bar stops
// tracking the page, and rule 3 below re-orders the same navigation on every
// pass of the effect (which re-runs on each doc change), so the router is
// asked again and again for a jump it is not taking. That is noise, not
// divergence — `currentPageId` never moves, so the canvas the user is looking
// at stays put and nothing accumulates in history. NOT VERIFIED: whether
// `toPluginPanel` can silently no-op at all. This is a defensive shape chosen
// because canvas/dock/navigate.ts already found one host router that did.
//
// WHY THE URL CARRIES A RAW PAGE ID (`page:k3f9…`) AND NOT A NAME SLUG. The
// design doc's D-3 makes this call deliberately: a slug is not stable under
// rename and is not unique, so a prettier URL would be one that breaks when
// somebody renames a page — and a link that silently stops working is worse
// than a link that looks like a mint detail. Filtering in the page menu
// already refuses to match ids for the mirror-image reason
// (canvas/pages/page-menu.ts's `filterPageRows`).

/**
 * The panel path bb routes this plugin's canvas on — the SECOND segment of
 * `/plugins/canvas/canvas/…`, the first being bb's plugin id.
 *
 * It is a constant rather than a literal in two files because a navigation to
 * a path with no panel registered at it goes nowhere, silently: app.tsx's
 * `navPanel({ path })` and CanvasPanel's `toPluginPanel(path)` have to name
 * the same string, and nothing at runtime would report it if they drifted.
 */
import { parseThreadReturnRoute } from "../thread-return-route.js";

export const CANVAS_PANEL_PATH = "canvas";

/**
 * The page id a route remainder is asking for, or null for "no page was
 * asked for".
 *
 * UNTRUSTED INPUT, and treated as such — a human typed it, a bookmark
 * preserved it, or a chat client mangled it. It is only ever COMPARED against
 * live page ids (here, and in canvas/page.ts's `resolvePageId`); it is never
 * concatenated into a URL, because every navigation this module orders targets
 * `currentPageId`, which came from the doc. That is why there is no length cap
 * or character filter here: there is nothing downstream for a hostile string
 * to reach.
 *
 * Percent-decoding is DEFENSIVE, not a claim about bb: whether the host hands
 * the remainder decoded has not been verified against a running bb, a colon in
 * a path segment is legal but is encoded by some clients, and decoding an
 * already-decoded id is the identity. A malformed escape (which
 * decodeURIComponent throws on) keeps the raw string rather than taking the
 * mount down over a bad bookmark.
 */
export function pageIdFromSubPath(subPath: string | null | undefined): string | null {
  if (typeof subPath !== "string") return null;
  const pagePath = parseThreadReturnRoute(subPath)?.pagePath ?? subPath;
  const trimmed = pagePath.trim().replace(/^\/+/, "").replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return null;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** What the panel should do about the disagreement, if any. */
export type PageRouteAction =
  /** Nothing to do — URL and editor agree. */
  | { readonly kind: "idle" }
  /** The router moved: put the editor on this page (a `SetCurrentPage`). */
  | { readonly kind: "adopt"; readonly pageId: string }
  /**
   * The editor moved: put this page in the URL.
   *
   * `replace` swaps the current history entry instead of pushing — the SDK's
   * own wording for the option is "use it for redirects so back does not
   * bounce", which is exactly the case it is set for here.
   */
  | { readonly kind: "navigate"; readonly subPath: string; readonly replace: boolean };

export interface PageRouteDecision {
  readonly action: PageRouteAction;
  /**
   * The value the caller must store and pass back as `settled` next time.
   *
   * Returned rather than left to the caller because getting it wrong is
   * invisible — a caller that stored the value it navigated TO, or that
   * skipped the store on an `idle`, would turn the next genuine page switch
   * into a spurious adopt. It is always the OBSERVED subPath; see the header.
   */
  readonly settled: string | null;
}

/**
 * Reconcile the URL and the editor.
 *
 * The order of the three rules is load-bearing:
 *
 *  1. AGREEMENT FIRST. When the URL already names the page the editor is on
 *     there is nothing to do, whatever `settled` says — this is what makes a
 *     same-value navigation (Back onto the page you are already on, a
 *     duplicated history entry) a no-op in both directions rather than a
 *     redundant `SetCurrentPage` that re-renders every subscriber and a
 *     redundant history entry.
 *  2. THE ROUTER MOVED. A subPath that is not the one last reconciled, and
 *     that names a LIVE page, is a Back/Forward press or a fresh deep link:
 *     the editor follows. Liveness is not optional — adopting a deleted page
 *     would leave the render filter (canvas-react's ShapeLayer/EmbedLayer)
 *     painting nothing, the same stranding canvas/pages/history-repair.ts
 *     exists to clean up after.
 *  3. OTHERWISE THE EDITOR MOVED. Write `currentPageId` into the URL.
 *     `replace` is true exactly when the URL being corrected does not name a
 *     live page — a bare route, a stale bookmark, a page just deleted. There
 *     is nothing at such a URL to go back TO, and pushing would let Back land
 *     on it and be immediately navigated forward again: a Back button that
 *     does nothing.
 */
export function decidePageRoute(input: {
  /** The panel's `subPath` prop, verbatim. */
  readonly subPath: string | null | undefined;
  /** `EditorState.currentPageId` — editor-local, never persisted. */
  readonly currentPageId: string;
  /** Every page the doc currently has. */
  readonly livePageIds: readonly string[];
  /** The previous decision's `settled`; null before the first one. */
  readonly settled: string | null;
}): PageRouteDecision {
  const requested = pageIdFromSubPath(input.subPath);

  if (requested === input.currentPageId) {
    return { action: { kind: "idle" }, settled: requested };
  }

  const requestedIsLive =
    requested !== null && input.livePageIds.includes(requested);

  if (requested !== input.settled && requestedIsLive) {
    return { action: { kind: "adopt", pageId: requested }, settled: requested };
  }

  return {
    action: {
      kind: "navigate",
      subPath: input.currentPageId,
      replace: !requestedIsLive,
    },
    settled: requested,
  };
}

/**
 * What the panel hands this module so the decision can actually happen.
 *
 * The two arms exist as PORTS rather than as `if`s in CanvasPanel.tsx because
 * of the finding this module's tests now record: a guard that only checked the
 * panel mentioned `decidePageRoute` stayed green after the whole `adopt` arm
 * was deleted from the .tsx, which would have left Back/Forward changing the
 * URL and not the canvas. There is no jsdom here to catch that; a fake port
 * is.
 */
export interface PageRoutePorts {
  /**
   * `editor.apply`. Narrowed to the one intent this module ever sends, so a
   * panel that wired the wrong thing in fails the typecheck rather than at
   * runtime. `SetCurrentPage` is a VIEW intent — no doc write and no undo
   * inverse (canvas-editor/src/editor.ts:927) — which is what keeps browser
   * history off the undo stack.
   */
  readonly apply: (intent: {
    readonly type: "SetCurrentPage";
    readonly pageId: string;
  }) => void;
  /**
   * bb's `useBbNavigate()` result, structurally. Only `toPluginPanel` is named
   * so a test can supply a two-line fake instead of the whole SDK surface.
   */
  readonly navigate: {
    toPluginPanel(
      path: string,
      options?: { subPath?: string; replace?: boolean },
    ): void;
  };
}

/**
 * Decide, then do it. Returns the value the caller must store and pass back as
 * `settled` next time (see `PageRouteDecision.settled`).
 *
 * The panel calls exactly this and stores the result; it holds no branch of
 * its own about pages, which is the only arrangement this jsdom-free project
 * can actually test.
 */
export function reconcilePageRoute(
  input: {
    readonly subPath: string | null | undefined;
    readonly currentPageId: string;
    readonly livePageIds: readonly string[];
    readonly settled: string | null;
  },
  ports: PageRoutePorts,
): string | null {
  const decision = decidePageRoute(input);
  const action = decision.action;
  if (action.kind === "adopt") {
    ports.apply({ type: "SetCurrentPage", pageId: action.pageId });
  } else if (action.kind === "navigate") {
    ports.navigate.toPluginPanel(CANVAS_PANEL_PATH, {
      subPath: action.subPath,
      replace: action.replace,
    });
  }
  return decision.settled;
}

/**
 * A panel's route arbitration with `settled` already inside it.
 *
 * WHY THE STATE MOVED IN HERE. `reconcilePageRoute` above hands `settled` back
 * for the caller to keep, and its own doc comment says getting that round-trip
 * wrong is INVISIBLE. It was: mutation on 2026-09-05 showed CanvasPanel.tsx
 * passing `settled: null` instead of the stored value, and separately dropping
 * the store entirely, each leaving `npx tsc --noEmit` at exit 0 and the whole
 * spike suite at 39 files / 843 tests passed. The round-trip lived in a .tsx,
 * in a project with no jsdom — there was nowhere to write a test for it.
 *
 * WHAT EACH MUTATION DOES AT RUNTIME, which is why "invisible" is not
 * acceptable here: with `settled` permanently null, every pass where the URL
 * and the editor differ takes rule 2 (the router moved) as long as the URL
 * names a live page — so clicking a page tab is immediately undone by the
 * effect, and the canvas snaps back to the page the address bar still shows.
 * Never storing it is the same failure by a different route.
 *
 * The caller now has no `settled` to get wrong: it makes one of these and
 * calls `reconcile`. tests/page-route.test.ts drives the sequences through it,
 * so the memory between calls is exercised rather than described.
 *
 * ONE PER PANEL, and it must live as long as the panel does — a router rebuilt
 * on a re-render would forget what it reconciled and behave exactly like the
 * `settled: null` mutation above. That is a React fact rather than this
 * module's, and CanvasPanel.tsx states it where it holds the router.
 */
export interface PageRouter {
  reconcile(
    input: {
      readonly subPath: string | null | undefined;
      readonly currentPageId: string;
      readonly livePageIds: readonly string[];
    },
    ports: PageRoutePorts,
  ): void;
}

/** A fresh router, having reconciled nothing yet (`settled` starts null — see
 * `decidePageRoute`'s rule 2 for what that means on the first pass). */
export function createPageRouter(): PageRouter {
  let settled: string | null = null;
  return {
    reconcile(input, ports) {
      settled = reconcilePageRoute({ ...input, settled }, ports);
    },
  };
}
