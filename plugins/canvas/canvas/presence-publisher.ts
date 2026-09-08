// A small leading-edge-throttled presence publisher, WITH a trailing flush.
//
// canvas-sync's PresenceStore warns that every set() hits the wire uncoalesced,
// and in this plugin each publish costs an rpc round trip plus a broadcast to
// every connected bb client — so pointer-move-rate publishing must be bounded
// before it reaches the store. This is the client's half of that: one shared
// throttle channel, one full `Presence` object rewritten in place, flushed at
// most once per `intervalMs`.
//
// Deliberately smaller than the EnsembleWorks client's own publisher: no
// `presenting` slot (no embeds in this spike) and no editing-transition
// throttle bypass (there is no peer-editing indicator here either). The
// screen-point memory IS kept, because without it a wheel pan with a
// stationary mouse leaves peers seeing the cursor frozen at the pre-pan world
// point.
//
// The TRAILING flush is not an optimization, it is the difference between a
// peer's cursor settling where the pointer actually stopped and it settling
// wherever the last sample inside the throttle window happened to fall. A drag
// that ends mid-window publishes nothing further, so a purely leading-edge
// throttle leaves every remote cursor one window behind, permanently, until the
// pointer moves again.
//
// THE PAGE (design doc D-4) rides the same object, and is the one field with a
// throttle bypass — `setPage` below says why, and the two rules it obeys are
// canvas/pages/page-presence.ts's rather than written here, so they are
// reachable by a test.
import { screenToWorld, type Camera } from "@ensembleworks/canvas-editor";
import type { Presence, PresenceStore } from "@ensembleworks/canvas-sync";
import {
  isPageRepublishNeeded,
  presencePageFor,
} from "./pages/page-presence.js";

/** ~60ms leading edge: roughly one publish every 3-4 frames at 60fps. */
export const PRESENCE_THROTTLE_MS = 60;

export interface PresencePublisher {
  /** The pointermove path: remembers `screen` so a later camera-only change
   * can re-derive the world cursor from it. */
  setCursorFromScreen(
    screen: { readonly x: number; readonly y: number },
    camera: Camera,
  ): void;
  /** The camera-change path: republishes the viewport rect and re-derives the
   * world cursor from the last recorded screen point, in ONE store write. */
  setViewport(
    viewport: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly w: number;
      readonly h: number;
    },
    camera: Camera,
  ): void;
  /** Publish "no cursor" — the pointer left the viewport. Forgets the recorded
   * screen point so a later camera change cannot resurrect it. */
  clearCursor(): void;
  /** Publish which page this peer is looking at (design doc D-4). A no-op when
   * the page has not actually moved; otherwise immediate, throttle bypassed —
   * see the implementation for both halves of that argument. */
  setPage(currentPageId: string | null | undefined): void;
  /** Cancel any pending trailing flush. The mount calls this on teardown, so a
   * closed peer is never published through. */
  dispose(): void;
}

export function createPresencePublisher(
  store: PresenceStore,
  opts: { readonly intervalMs?: number; readonly now?: () => number } = {},
): PresencePublisher {
  const now = opts.now ?? (() => performance.now());
  const intervalMs = opts.intervalMs ?? PRESENCE_THROTTLE_MS;
  let disposed = false;
  let current: Presence = {
    cursor: null,
    viewport: null,
    stamp: null,
    presenting: [],
    editing: null,
    // Present and null from the first publish: UNKNOWN, which every reader
    // treats as "do not filter this peer out". A peer whose page has not been
    // set yet must be VISIBLE to everybody, not hidden by all of them.
    page: null,
  };
  let lastScreen: { readonly x: number; readonly y: number } | null = null;
  let lastFlushAt: number | null = null;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  const cancelTrailing = (): void => {
    if (trailing === null) return;
    clearTimeout(trailing);
    trailing = null;
  };

  const publishNow = (): void => {
    cancelTrailing();
    lastFlushAt = now();
    store.publish(current);
  };

  const flush = (): void => {
    if (disposed) return;
    const t = now();
    const elapsed = lastFlushAt === null ? Infinity : t - lastFlushAt;
    if (elapsed >= intervalMs) {
      publishNow();
      return;
    }
    // Throttled out. Schedule the tail rather than dropping: `current` already
    // carries the newest value, and one timer serves every publish suppressed
    // in this window (a later call inside the window just updates `current`,
    // which the pending timer will read).
    if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null;
        if (disposed) return;
        lastFlushAt = now();
        store.publish(current);
      }, intervalMs - elapsed);
    }
  };

  return {
    setCursorFromScreen(screen, camera) {
      lastScreen = screen;
      current = { ...current, cursor: screenToWorld(camera, screen) };
      flush();
    },
    setViewport(viewport, camera) {
      const cursor =
        lastScreen !== null ? screenToWorld(camera, lastScreen) : current.cursor;
      current = { ...current, viewport, cursor };
      flush();
    },
    clearCursor() {
      if (disposed) return;
      lastScreen = null;
      current = { ...current, cursor: null };
      // Bypass the throttle: "the pointer left" has no later event to
      // piggyback on, so a dropped clear would leave a ghost cursor for peers.
      // publishNow also cancels any pending tail, which would otherwise fire
      // just after and republish this same (already correct) state.
      publishNow();
    },
    setPage(currentPageId) {
      if (disposed) return;
      const next = presencePageFor(currentPageId);
      // NOTHING MOVED, NOTHING GOES OUT. The panel re-asserts the page from an
      // effect, so without this guard the immediate publish below would fire
      // at re-render rate with the throttle bypassed — which is the throttle
      // deleted, not relaxed. canvas/pages/page-presence.ts holds both this
      // rule and the unknown-page one, so they are testable.
      if (!isPageRepublishNeeded(current.page, next)) return;
      current = { ...current, page: next };
      // IMMEDIATE, like clearCursor and for the same reason: a page switch has
      // no later event guaranteed to carry it (a peer can switch page and then
      // sit perfectly still), and until it lands everybody on the page just
      // left keeps drawing this cursor as if it were still there. Bounded by
      // human click rate, not pointer-move rate, because of the guard above.
      //
      // publishNow sends `current`, which already holds the newest cursor and
      // viewport — so a switch mid-throttle-window carries the throttled-out
      // sample out with it, and cancelling the pending tail drops a publish
      // that would only have repeated this same state.
      publishNow();
    },
    dispose() {
      disposed = true;
      cancelTrailing();
    },
  };
}
