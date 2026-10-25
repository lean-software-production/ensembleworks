// The one seam between the panel BODY and the panel HEADER.
//
// WHY A MODULE-LEVEL STORE AND NOT REACT CONTEXT. BB renders a navPanel's
// `headerContent` into the SHARED app title bar, not inside the panel
// component's tree — the two are separate mount points with no common plugin
// ancestor, so no provider can span them. They are, however, the same plugin
// bundle in the same window, so a module singleton reaches both. That is the
// whole trick, and it is the reason the roster lives here rather than in
// CanvasPanel's state.
//
// Data flows in one direction each way:
//   body -> header   setRoster / setAv        (who is here, what audio is doing)
//   header -> body   panTo(clientId)          (jump the camera to that person)
//
// SPIKE-LEVEL LIMIT: one singleton means one canvas. Two Canvas panels in a
// split would both write the roster and the last render wins. Real
// multi-instance support wants a per-panel registry keyed by mount id; a spike
// with one nav panel does not.
import type { RosterMember } from "./roster.js";

/** What the Join-audio control is doing. */
export type AvStatus = "off" | "connecting" | "live";

export interface CanvasAvState {
  readonly status: AvStatus;
  /** Whether the local mic is muted. Meaningful only while `live`. */
  readonly muted: boolean;
  /** Whether the local camera is publishing. Meaningful only while `live`. */
  readonly cameraOn: boolean;
  /** Display names LiveKit currently reports as speaking, including our own. */
  readonly speaking: readonly string[];
  /**
   * LiveKit identities currently publishing a camera, our own included. The
   * dock turns each of these into a live tile; everyone else stays initials.
   * Sorted by av-room.ts so the equality check below is a cheap walk.
   */
  readonly video: readonly string[];
  /**
   * Our own LiveKit identity, once we are in a room. The dock has no canvas
   * panel to ask on most BB pages, so this is how it knows which bubble is
   * you. Null whenever we are not connected.
   */
  readonly self: string | null;
}

export interface CanvasBusState {
  readonly roster: readonly RosterMember[];
  readonly av: CanvasAvState;
}

const EMPTY_AV: CanvasAvState = {
  status: "off",
  muted: false,
  cameraOn: false,
  speaking: [],
  video: [],
  self: null,
};
const EMPTY: CanvasBusState = { roster: [], av: EMPTY_AV };

let state: CanvasBusState = EMPTY;
const listeners = new Set<() => void>();
let panHandler: ((clientId: string) => void) | null = null;

function emit(): void {
  // Copy: a listener that unsubscribes itself while we iterate (React does
  // exactly this when a subscribed component unmounts mid-notification) must
  // not mutate the set we are walking.
  for (const listener of [...listeners]) listener();
}

/** Roster equality, field by field. The body rebuilds this array on every
 * presence poll (every 150ms), so without it useSyncExternalStore would hand
 * the header a new snapshot four times a second forever and re-render an
 * avatar stack that did not change. */
function sameRoster(
  a: readonly RosterMember[],
  b: readonly RosterMember[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((member, index) => {
    const other = b[index]!;
    return (
      member.clientId === other.clientId &&
      member.name === other.name &&
      member.isSelf === other.isSelf &&
      member.hasCursor === other.hasCursor
    );
  });
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

export const canvasBus = {
  /** useSyncExternalStore's subscribe. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** useSyncExternalStore's getSnapshot — stable identity between changes,
   * which is what keeps it from looping. */
  snapshot(): CanvasBusState {
    return state;
  },

  setRoster(roster: readonly RosterMember[]): void {
    if (sameRoster(state.roster, roster)) return;
    state = { ...state, roster };
    emit();
  },

  setAv(next: Partial<CanvasAvState>): void {
    const merged: CanvasAvState = { ...state.av, ...next };
    if (
      merged.status === state.av.status &&
      merged.muted === state.av.muted &&
      merged.cameraOn === state.av.cameraOn &&
      merged.self === state.av.self &&
      sameNames(merged.speaking, state.av.speaking) &&
      sameNames(merged.video, state.av.video)
    ) {
      return;
    }
    state = { ...state, av: merged };
    emit();
  },

  /**
   * Register the body's "jump the camera to this client" handler. Returns an
   * unregister function, so the panel's effect cleanup is a one-liner and a
   * stale handler from an unmounted panel can never be called.
   */
  setPanHandler(handler: (clientId: string) => void): () => void {
    panHandler = handler;
    return () => {
      if (panHandler === handler) panHandler = null;
    };
  },

  /** Header -> body. A no-op when no panel is mounted, which is correct: there
   * is no camera to move. */
  panTo(clientId: string): void {
    panHandler?.(clientId);
  },

  /** Drop the roster when the panel unmounts, so the header does not keep
   * showing a stack of people from a canvas that is no longer open. Audio is
   * deliberately NOT reset: a live LiveKit connection outlives a panel
   * re-render, and av-room.ts owns its own teardown. */
  clearRoster(): void {
    if (state.roster.length === 0) return;
    state = { ...state, roster: [] };
    emit();
  },
};
