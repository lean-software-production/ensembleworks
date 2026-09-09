// W9's second half: GETTING THERE. What happens between a click on a `::node`
// card and the node sitting selected in the middle of somebody's canvas.
//
// THE CLICK IS NOT ON THE CANVAS. It is in a message, on bb's thread route,
// where there is no editor, no document and quite possibly no canvas panel
// mounted at all. So the click cannot select anything itself; it can only
// leave a REQUEST somewhere the panel will find it, and ask bb to go to the
// canvas. `revealBus` is that somewhere — the same module-singleton trick
// canvas/panel-bus.ts uses for `panTo` and canvas/dock/transcript-door.ts uses
// for the transcript door, and for the same reason: two mount points, one
// bundle, no common React ancestor to hang a provider on.
//
// THE JOURNEY HAS FOUR LEGS AND ONLY THE FIRST IS INSTANT.
//
//   request   the click, stamped with a time
//   route     the panel put on the node's page
//   arrival   the SHAPE present in this browser's copy of the document, which
//             lags the route by however long the room's delta takes
//   show      selected and centred, at the zoom the human already had
//
// ONE NAVIGATION AUTHORITY, DELIBERATELY. The page change is asked for through
// the URL — `toPluginPanel(CANVAS_PANEL_PATH, { subPath: pageId })` — and
// canvas/pages/page-route.ts's router adopts it into the editor, exactly as it
// does for a deep link or a Back press. This module never applies
// `SetCurrentPage`. A second page authority would be a second thing writing
// `currentPageId`, and that module's whole header is about how ping-pong
// between two such writers is invisible until it is a user complaint.
//
// WHY IT WAITS RATHER THAN ROUTING IMMEDIATELY AT A PAGE IT CANNOT SEE. A
// freshly mounted panel holds its own default page and nothing else until the
// room's first delta lands. `decidePageRoute`'s rule 3 turns a subPath naming
// a page that is not live into a REPLACE back to the current page — so routing
// early does not merely fail, it throws the destination away and rewrites the
// URL. So: wait for the page to exist, ask once, then wait for the shape.
//
// AND WHY IT GIVES UP OUT LOUD. A reveal that stayed armed would fire on the
// next page change the human made for their own reasons, minutes later,
// yanking their camera somewhere they did not ask to go. A deadline, one
// sentence, and disarm.
import { pageIdOf, worldBounds, type CanvasDocument } from "@ensembleworks/canvas-model";
import { cameraCenteredOn } from "../roster.js";
import { CANVAS_PANEL_PATH } from "../pages/page-route.js";
import type { RevealRequest } from "./node-reference.js";

/**
 * How long a pending reveal keeps waiting.
 *
 * Long enough for a cold panel: mount, connect, first sync frame, adopt the
 * page. Short enough that the give-up sentence arrives while the human still
 * remembers clicking — which is the whole point of saying it.
 */
export const REVEAL_TIMEOUT_MS = 15_000;

/** A click, stamped. The stamp is identity as well as deadline: clicking the
 * same card twice must be two requests (see `createRevealBus`). */
export interface RevealTarget extends RevealRequest {
  readonly requestedAt: number;
}

/** A point in world coordinates. */
export interface RevealPoint {
  readonly x: number;
  readonly y: number;
}

/** The shape, as this browser's document currently holds it. Null when the
 * document has no such shape — which is the normal state for the first few
 * frames after a route, not an error. */
export interface RevealSubject {
  /** The page the shape is on NOW. The document is newer than the message. */
  readonly pageId: string;
  /** The centre of its world-space box: where the camera is aimed. */
  readonly centre: RevealPoint;
}

export interface RevealInput {
  readonly target: RevealTarget;
  readonly subject: RevealSubject | null;
  /** `EditorState.currentPageId`. */
  readonly currentPageId: string;
  readonly livePageIds: readonly string[];
  /** The page already asked for, for THIS target; null before the first ask. */
  readonly routedTo: string | null;
  readonly now: number;
}

export type RevealDecision =
  /** Nothing to do yet, and nothing to say. */
  | { readonly kind: "wait" }
  | { readonly kind: "route"; readonly pageId: string }
  | {
      readonly kind: "show";
      readonly nodeId: string;
      readonly centre: RevealPoint;
    }
  | { readonly kind: "give-up"; readonly message: string };

/**
 * What to do about a pending reveal, right now.
 *
 * The order is load-bearing:
 *
 *  1. ARRIVAL BEATS THE DEADLINE. A reveal that resolves on the last frame
 *     before the timeout shows the node; timing out a request that has already
 *     succeeded would be a give-up message on a canvas that is looking at
 *     exactly what was asked for.
 *  2. THE DOCUMENT BEATS THE MESSAGE. If the shape is on a different page from
 *     the one the card read, the shape is right — it has been dragged since,
 *     and the message is a record of the past.
 *  3. A PAGE THAT IS NOT LIVE IS NOT ROUTED AT. See the header.
 *  4. ASK ONCE. A repeated navigation is noise on every doc change for as long
 *     as the reveal is pending; if the one ask silently fails, the deadline is
 *     what notices.
 */
export function decideReveal(input: RevealInput): RevealDecision {
  const wanted = input.subject?.pageId ?? input.target.pageId;
  if (input.subject !== null && input.currentPageId === wanted) {
    return { kind: "show", nodeId: input.target.nodeId, centre: input.subject.centre };
  }
  if (input.now - input.target.requestedAt > REVEAL_TIMEOUT_MS) {
    return { kind: "give-up", message: gaveUp(input, wanted) };
  }
  if (!input.livePageIds.includes(wanted)) return { kind: "wait" };
  if (input.currentPageId !== wanted && input.routedTo !== wanted) {
    return { kind: "route", pageId: wanted };
  }
  return { kind: "wait" };
}

/** Why it did not get there, in the terms the human can act on. */
function gaveUp(input: RevealInput, wanted: string): string {
  if (!input.livePageIds.includes(wanted)) {
    return `That node's page (${wanted}) is not on this canvas.`;
  }
  if (input.currentPageId !== wanted) {
    return `Could not get to ${wanted} to show ${input.target.nodeId}.`;
  }
  return `Could not find ${input.target.nodeId} on this canvas.`;
}

/** What acting on a decision needs. PORTS rather than the panel's own `if`s,
 * for the reason canvas/pages/page-route.ts's `PageRoutePorts` states: this
 * project has no jsdom, so a branch left in a .tsx is a branch no test can
 * reach — and the branch deleted from one is a mutation nothing catches. */
export interface RevealPorts {
  /** `editor.applyAll`, narrowed to the two view intents a reveal ever sends.
   * Both are VIEW intents: no doc write, no undo entry — landing on a node
   * must not appear on anybody's undo stack. */
  apply(
    intents: readonly (
      | { readonly type: "SetSelection"; readonly ids: readonly string[] }
      | { readonly type: "SetCamera"; readonly x: number; readonly y: number; readonly z: number }
    )[],
  ): void;
  /** bb's `useBbNavigate()`, structurally — only what this module calls. */
  readonly navigate: {
    toPluginPanel(path: string, options?: { subPath?: string; replace?: boolean }): void;
  };
  /** Say something to the human. A toast: the canvas is perfectly healthy, so
   * this is not a banner (the same rule canvas/panel/tree-gesture-sync.tsx
   * states for a refused write). */
  notify(message: string): void;
  /** Disarm the request. */
  clear(): void;
}

/**
 * Decide, then do it. Returns the page this reveal has now asked for — which
 * the caller must keep and pass back as `routedTo`, exactly like
 * `reconcilePageRoute`'s `settled`.
 */
export function runReveal(
  input: RevealInput & {
    readonly viewport: { readonly width: number; readonly height: number };
    /** `camera.z`. PRESERVED: the click means "show me that node", not "and
     * also change how far in I am" — the same call `panTo` makes. */
    readonly zoom: number;
  },
  ports: RevealPorts,
): string | null {
  const decision = decideReveal(input);
  switch (decision.kind) {
    case "wait":
      return input.routedTo;
    case "route":
      ports.navigate.toPluginPanel(CANVAS_PANEL_PATH, { subPath: decision.pageId });
      return decision.pageId;
    case "show":
      ports.apply([
        { type: "SetSelection", ids: [decision.nodeId] },
        { type: "SetCamera", ...cameraCenteredOn(decision.centre, input.viewport, input.zoom) },
      ]);
      ports.clear();
      return input.routedTo;
    case "give-up":
      ports.notify(decision.message);
      ports.clear();
      return input.routedTo;
  }
}

/**
 * The reveal subject, read out of THIS browser's document — or null when the
 * document has no such shape yet, which is the ordinary state for the first
 * frames after a route.
 *
 * An ORPHAN (a shape whose parent chain reaches no page, which `byId` can hold
 * mid-merge) is also null: it is on no page, so there is nowhere to route and
 * nothing to centre. The deadline then says so, rather than the camera flying
 * to a shape nobody can see.
 */
export function revealSubjectFor(doc: CanvasDocument, nodeId: string): RevealSubject | null {
  const shape = doc.byId.get(nodeId);
  if (shape === undefined) return null;
  const pageId = pageIdOf(doc, shape);
  if (pageId === undefined) return null;
  // The world-space AABB's middle, not the shape's x/y: a node is a note two
  // hundred points across, and its CORNER in the middle of the viewport is
  // visibly not "centred on that node".
  const box = worldBounds(doc, shape);
  return {
    pageId,
    centre: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 },
  };
}

/**
 * A click on a live `::node` card: leave the request where the canvas will
 * find it, then ask bb for the canvas.
 *
 * BOTH HALVES ARE NECESSARY, and this is the one place that is obvious. The
 * click happens in a thread, where there may be no canvas panel mounted at all
 * — so the request alone would be heard by nobody, and the navigation alone
 * would land on the canvas showing whatever page it was already on. The
 * request FIRST, so a panel that is already mounted cannot be told to go
 * somewhere before it has been told why.
 */
export function openNodeOnCanvas(
  target: RevealRequest,
  ports: {
    readonly bus: Pick<RevealBus, "request">;
    readonly navigate: RevealPorts["navigate"];
  },
): void {
  ports.bus.request(target);
  ports.navigate.toPluginPanel(CANVAS_PANEL_PATH, { subPath: target.pageId });
}

export interface RevealBus {
  subscribe(listener: () => void): () => void;
  /** useSyncExternalStore's getSnapshot — stable identity between requests,
   * which is what keeps a subscriber from looping. */
  snapshot(): RevealTarget | null;
  request(request: RevealRequest): void;
  clear(): void;
}

/**
 * The seam between a message and a canvas.
 *
 * `now` is injected so the deadline is testable and so the stamp comes from
 * one clock. EVERY request is a fresh object even when it names the same node:
 * a second click on the same card is a second request to go there — and an
 * identical object would be no change at all to a `useSyncExternalStore`
 * subscriber, so a card that worked once would look broken ever after.
 */
export function createRevealBus(now: () => number = Date.now): RevealBus {
  let target: RevealTarget | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    // Copy: a listener that unsubscribes itself while we iterate (React does
    // exactly this when a subscribed component unmounts mid-notification) must
    // not mutate the set we are walking.
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => target,
    request(request) {
      target = { ...request, requestedAt: now() };
      emit();
    },
    clear() {
      if (target === null) return;
      target = null;
      emit();
    },
  };
}

/**
 * The one bus, for the one canvas panel.
 *
 * SPIKE-LEVEL LIMIT, stated where canvas/panel-bus.ts states its own: one
 * singleton means one canvas. Two Canvas panels in a split would both answer a
 * reveal and both fly their camera. A per-panel registry is what real
 * multi-instance support wants; a spike with one nav panel does not.
 */
export const revealBus = createRevealBus();
