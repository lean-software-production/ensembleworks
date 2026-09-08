// When the strip re-decides where it lives — and what happens when the frame it
// asked for never comes.
//
// THE OBSERVER CANNOT DO THE WORK. Placement is re-decided from a
// MutationObserver on `document.body`, which fires for every DOM change bb
// makes anywhere: every keystroke in the composer, every streamed token. So its
// callback raises a flag and one coalesced pass per animation frame does the
// single `querySelector` and the three node reads.
//
// THE FLAG WAS THE BUG. It was raised outside the frame and lowered only inside
// it, and `requestAnimationFrame` is not a promise — a hidden, throttled or
// discarded surface accepts a callback and never invokes it. One dropped frame
// left the flag raised for the life of the content-script generation, every
// later mutation short-circuited on it, and anchor re-sync was dead until the
// page was reloaded. Reproduced on the running app by neutering
// `requestAnimationFrame`, removing the strip's node and forcing 100 mutations
// over 5s: it never came back, and 80 more mutations after rAF was healthy
// again did not bring it back either, because the flag was already stuck.
//
// THE FIX IS A SECOND DRIVER, NOT A LONGER FUSE. The strip already runs a 2s
// roster tick; that tick drives a sync of its own and, in doing so, lowers the
// latch. A dropped frame therefore costs at most one poll interval, and a
// surface where frames work is unaffected — because the tick also SUPERSEDES
// the outstanding frame's token, so the late frame arrives, finds itself stale
// and does nothing. One pass per change, never two.
//
// It is all decision and no DOM, so it is here rather than inline in dock.ts:
// this project has no jsdom and never will, and anything decided against
// `document` is decided where no test can reach it.

/** The latch, as a value. `generation` is the token the outstanding frame must
 * quote to be believed — bumping it is how a poll disowns a frame it has
 * already done the work for. */
export interface LatchState {
  readonly queued: boolean;
  readonly generation: number;
}

/** Nothing outstanding. */
export const IDLE_LATCH: LatchState = { queued: false, generation: 0 };

/**
 * What the caller should do, and the latch it should carry forward.
 *
 * `schedule` carries the token to hand back to `onFrame`; the same number is on
 * `state.generation`, and it is repeated here so the caller closes over a value
 * rather than reading a state it is about to replace.
 */
export type LatchStep =
  | { readonly state: LatchState; readonly action: "none" }
  | {
      readonly state: LatchState;
      readonly action: "schedule";
      readonly generation: number;
    }
  | { readonly state: LatchState; readonly action: "run" };

/** A DOM mutation happened. Ask for a frame, unless one is already coming. */
export function onMutation(state: LatchState): LatchStep {
  if (state.queued) return { state, action: "none" };
  const next: LatchState = { queued: true, generation: state.generation + 1 };
  return { state: next, action: "schedule", generation: next.generation };
}

/**
 * The frame we asked for arrived, quoting the token it was asked with.
 *
 * A token that no longer matches means a poll ran the pass in this frame's
 * place — the work is done, and doing it again would be two passes for one
 * change. That is the only reason this takes a token at all.
 */
export function onFrame(state: LatchState, generation: number): LatchStep {
  if (!state.queued || state.generation !== generation) {
    return { state, action: "none" };
  }
  return { state: { ...state, queued: false }, action: "run" };
}

/**
 * The 2s tick. ALWAYS runs a pass, and always leaves the latch down.
 *
 * Unconditional, not "repair the latch if it looks stuck": a node removed by
 * something that makes no further mutations has to come back too, and the pass
 * itself is a `querySelector` plus three node reads whose usual answer is
 * `{ action: "none" }`. Bumping the generation is what keeps the outstanding
 * frame from running a redundant second pass when it eventually lands.
 */
export function onPoll(state: LatchState): LatchStep {
  return {
    state: { queued: false, generation: state.generation + 1 },
    action: "run",
  };
}

/** The two hands the scheduler needs, injected so it is driven by plain
 * functions in tests — including a `requestFrame` that never calls back, which
 * is the whole failure being defended against. */
export interface SchedulerHost {
  /** Ask for one coalesced pass. Free to never call back. */
  requestFrame(callback: () => void): void;
  /** Do the pass: re-check the route, re-place the strip. */
  run(): void;
}

export interface SyncScheduler {
  /** The MutationObserver's entire job. */
  mutation(): void;
  /** The roster tick's backstop. Runs a pass and clears the latch. */
  poll(): void;
  /** Disposal: no further passes, and any frame still in flight is swallowed. */
  stop(): void;
}

export function createSyncScheduler(host: SchedulerHost): SyncScheduler {
  let state = IDLE_LATCH;
  let stopped = false;

  function step(next: LatchStep): void {
    state = next.state;
    if (next.action === "run") {
      host.run();
      return;
    }
    if (next.action === "schedule") {
      const token = next.generation;
      host.requestFrame(() => {
        if (stopped) return;
        step(onFrame(state, token));
      });
    }
  }

  return {
    mutation(): void {
      if (stopped) return;
      step(onMutation(state));
    },
    poll(): void {
      if (stopped) return;
      step(onPoll(state));
    },
    stop(): void {
      stopped = true;
    },
  };
}
