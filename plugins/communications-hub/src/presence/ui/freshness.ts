/**
 * How old an answer is allowed to get before the strip stops believing it.
 *
 * The row is fed by a poll, and a poll can be late or stop returning
 * altogether — a dropped backend, a suspended laptop, a plugin being reloaded
 * underneath it. What the strip holds in that moment is not "the room", it is
 * "what the room looked like when somebody last told us", and the difference
 * matters as soon as the answer is more than a few seconds old.
 *
 * Two decays, both computed here so they are testable without a browser:
 *
 * 1. THE SPEAKING RING EXPIRES LOCALLY. The server sends how long the ring may
 *    stay lit (`speakingMsRemaining`) as well as whether it was lit when asked.
 *    A boolean alone is only true of the instant it was computed; carried
 *    forward across a failed poll it becomes a ring that glows for as long as
 *    the failure lasts. Subtracting elapsed time is what makes the ring honest
 *    between answers, and it needs no clock agreement with the server — only
 *    the client's own elapsed time.
 * 2. THE WHOLE ANSWER GOES STALE. Past PRESENCE_STALE_AFTER_MS the roster is
 *    dropped rather than held: we have no evidence any of those people are
 *    still there. The room, its name and its join link survive, because those
 *    are configuration rather than observation — the strip keeps offering the
 *    door while admitting it cannot see through it.
 */

import type { PresenceView } from "../view.js";

/**
 * Roughly five missed polls at the 2.5s poll interval.
 *
 * Long enough that one slow answer, a garbage-collection pause or a tab waking
 * up does not blank the row; short enough that nobody reads a minute-old
 * roster as the room.
 */
export const PRESENCE_STALE_AFTER_MS = 12_000;

export interface FreshenedPresence {
  readonly view: PresenceView;
  /** True once the answer is too old to be presented as what is happening. */
  readonly stale: boolean;
}

/** The sentence that replaces a roster we can no longer vouch for. */
export const STALE_STATUS = "Presence unavailable — BB is not getting updates";

export function freshen(view: PresenceView, ageMs: number): FreshenedPresence {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  const stale = age >= PRESENCE_STALE_AFTER_MS;
  const room = view.room;
  if (!room) return { view, stale };
  if (stale) {
    return {
      view: {
        ...view,
        room: {
          ...room,
          participants: [],
          knownCount: 0,
          // No feed means no stills to serve: the client drops its cache on
          // this flag, so a face cannot outlive the answer that described it.
          portraits: false,
          status: STALE_STATUS,
        },
      },
      stale,
    };
  }
  return {
    view: {
      ...view,
      room: {
        ...room,
        participants: room.participants.map((participant) => ({
          ...participant,
          // Only ever narrows: a ring that was not lit when the answer was made
          // is never lit later, whatever the clock says.
          speaking: participant.speaking && participant.speakingMsRemaining > age,
          speakingMsRemaining: Math.max(0, participant.speakingMsRemaining - age),
        })),
      },
    },
    stale,
  };
}
