// Run: npx vitest run tests/dock-sync-latch.test.ts
//
// THE LATCH THAT COULD NEVER BE UNLATCHED.
//
// The strip re-places itself from a MutationObserver that fires for every DOM
// change bb makes anywhere — every keystroke in the composer, every streamed
// token. So the observer's callback must not do work; it raises a flag and one
// coalesced pass per frame does the reading. That much is right.
//
// What was wrong is that the flag was raised OUTSIDE the frame and lowered only
// INSIDE it. `requestAnimationFrame` is not a promise: a surface that is hidden,
// throttled or discarded accepts the callback and never invokes it. One dropped
// frame therefore left `syncQueued === true` for the life of the generation, and
// every later mutation short-circuited on it — anchor re-sync was dead, and the
// only cure was a page reload. Observed on the running app: the strip's node was
// removed by hand with rAF neutered, 100 DOM mutations were forced over 5s, and
// it never came back; 80 more mutations after rAF was healthy again did not
// bring it back either, because the flag was already stuck.
//
// The fix is a BACKSTOP, not a longer timeout: the 2s roster tick the strip
// already runs drives a sync of its own and resets the latch, so the worst a
// dropped frame can cost is one poll interval.
//
// That is a decision — "given a mutation / a frame / a tick, do I ask for a
// frame, run now, or do nothing" — so it lives here, pure, and not as an inline
// `if` in dock.ts where this project (which has no jsdom, and never will) cannot
// reach it.
import { describe, expect, it } from "vitest";
import {
  IDLE_LATCH,
  createSyncScheduler,
  onFrame,
  onMutation,
  onPoll,
} from "../canvas/dock/sync-latch.js";

describe("onMutation — coalescing to one frame", () => {
  it("asks for a frame the first time, carrying the token that frame must quote", () => {
    const step = onMutation(IDLE_LATCH);
    expect(step.action).toBe("schedule");
    expect(step.state.queued).toBe(true);
    if (step.action !== "schedule") throw new Error("unreachable");
    expect(step.state.generation).toBe(step.generation);
  });

  it("asks for nothing while a frame is already outstanding", () => {
    // The hot path: bb streams a token, the observer fires, and the answer is
    // "a pass is already coming".
    const first = onMutation(IDLE_LATCH);
    const second = onMutation(first.state);
    expect(second.action).toBe("none");
    expect(second.state).toEqual(first.state);
  });
});

describe("onFrame — the pass that was asked for", () => {
  it("runs the sync and lowers the latch", () => {
    const queued = onMutation(IDLE_LATCH);
    if (queued.action !== "schedule") throw new Error("unreachable");
    const frame = onFrame(queued.state, queued.generation);
    expect(frame.action).toBe("run");
    expect(frame.state.queued).toBe(false);
  });

  it("lets the next mutation ask for a fresh frame", () => {
    const queued = onMutation(IDLE_LATCH);
    if (queued.action !== "schedule") throw new Error("unreachable");
    const frame = onFrame(queued.state, queued.generation);
    expect(onMutation(frame.state).action).toBe("schedule");
  });

  it("ignores a frame whose token has been superseded", () => {
    // A frame the browser deferred past a poll tick. The poll has already done
    // the work; running again would be a second pass for one mutation.
    const queued = onMutation(IDLE_LATCH);
    if (queued.action !== "schedule") throw new Error("unreachable");
    const polled = onPoll(queued.state);
    const late = onFrame(polled.state, queued.generation);
    expect(late.action).toBe("none");
    expect(late.state).toEqual(polled.state);
  });
});

describe("onPoll — the backstop", () => {
  it("runs a sync even when a frame is outstanding", () => {
    // THE BUG, stated as a rule: the frame may never come, so the tick does not
    // wait for it.
    const queued = onMutation(IDLE_LATCH);
    expect(onPoll(queued.state).action).toBe("run");
  });

  it("lowers a latch a dropped frame left raised", () => {
    // The wedge, exactly: a frame is asked for and never fires. Before the
    // backstop existed every later mutation short-circuited on the raised flag
    // and the strip could not re-place itself again, ever.
    const queued = onMutation(IDLE_LATCH);
    const polled = onPoll(queued.state);
    expect(polled.state.queued).toBe(false);
    expect(onMutation(polled.state).action).toBe("schedule");
  });

  it("runs a sync when nothing at all is pending", () => {
    // A node removed by something that made no further mutations still has to
    // come back, so the tick is unconditional rather than a latch repair.
    expect(onPoll(IDLE_LATCH).action).toBe("run");
  });

  it("supersedes the outstanding frame's token so a late frame is a no-op", () => {
    const queued = onMutation(IDLE_LATCH);
    if (queued.action !== "schedule") throw new Error("unreachable");
    expect(onPoll(queued.state).state.generation).not.toBe(queued.generation);
  });
});

/** A scheduler over a fake frame queue, so a frame can be delivered, delayed or
 * dropped exactly as a real surface delivers, delays or drops one. */
function harness(options: { dropFrames?: boolean } = {}) {
  const frames: Array<() => void> = [];
  let runs = 0;
  const scheduler = createSyncScheduler({
    requestFrame: (callback) => {
      if (options.dropFrames === true) return;
      frames.push(callback);
    },
    run: () => {
      runs += 1;
    },
  });
  return {
    scheduler,
    frames,
    runs: () => runs,
    flush: () => {
      const pending = frames.splice(0, frames.length);
      for (const frame of pending) frame();
    },
  };
}

describe("createSyncScheduler — with frames arriving normally", () => {
  it("coalesces a burst of mutations into one frame and one sync", () => {
    const h = harness();
    for (let i = 0; i < 20; i += 1) h.scheduler.mutation();
    expect(h.frames.length).toBe(1);
    h.flush();
    expect(h.runs()).toBe(1);
  });

  it("does not double-run when a poll lands between the mutation and its frame", () => {
    // The backstop must not turn a working surface into two passes per change.
    const h = harness();
    h.scheduler.mutation();
    h.scheduler.poll();
    expect(h.runs()).toBe(1);
    h.flush();
    expect(h.runs()).toBe(1);
  });

  it("keeps taking mutations after a poll", () => {
    const h = harness();
    h.scheduler.mutation();
    h.scheduler.poll();
    h.flush();
    h.scheduler.mutation();
    expect(h.frames.length).toBe(1);
    h.flush();
    expect(h.runs()).toBe(2);
  });
});

describe("createSyncScheduler — with every frame dropped", () => {
  it("still syncs, once per tick", () => {
    // The neutered-rAF case reproduced on the running app.
    const h = harness({ dropFrames: true });
    h.scheduler.mutation();
    expect(h.runs()).toBe(0);
    h.scheduler.poll();
    expect(h.runs()).toBe(1);
    h.scheduler.poll();
    expect(h.runs()).toBe(2);
  });

  it("is never wedged by the mutations that arrive in between", () => {
    // 100 mutations with no frame ever delivered: before the backstop this was
    // the state in which the strip stayed missing forever.
    const h = harness({ dropFrames: true });
    for (let i = 0; i < 100; i += 1) h.scheduler.mutation();
    h.scheduler.poll();
    for (let i = 0; i < 100; i += 1) h.scheduler.mutation();
    h.scheduler.poll();
    expect(h.runs()).toBe(2);
  });
});

describe("createSyncScheduler — after disposal", () => {
  it("stops asking for frames and stops running", () => {
    const h = harness();
    h.scheduler.stop();
    h.scheduler.mutation();
    h.scheduler.poll();
    expect(h.frames.length).toBe(0);
    expect(h.runs()).toBe(0);
  });

  it("swallows a frame that was already in flight when it stopped", () => {
    const h = harness();
    h.scheduler.mutation();
    h.scheduler.stop();
    h.flush();
    expect(h.runs()).toBe(0);
  });
});
