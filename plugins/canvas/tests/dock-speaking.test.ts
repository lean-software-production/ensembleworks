// Run: npx vitest run tests/dock-speaking.test.ts
//
// The speaking ring's GLUE, which is where its one real bug lived.
//
// tests/dock.test.ts already pins `holdSpeaking`/`speakingAt` in isolation, and
// they were never wrong. The regression was one level up, in how the dock fed
// them, and it needed BOTH real halves to reproduce:
//
//   * panel-bus.ts deduplicates — `setAv({ speaking: ["alice"] })` twice in a
//     row notifies nobody the second time, by design (it stops a 150ms presence
//     poll re-rendering an unchanged avatar stack).
//   * so the sweep timer, not the bus, is the only thing that can keep a hold
//     alive while one person talks steadily — and it was sweeping with a
//     hard-coded empty active list, which can only ever expire entries.
//
// Net effect on a real call: talk for three seconds on your own and your ring
// went dark mid-sentence after ~900ms. Every test here therefore drives the
// REAL canvasBus singleton and the REAL module, with only the clock faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDockSpeaking } from "../canvas/dock/speaking.js";
import { SPEAKING_HOLD_MS } from "../canvas/dock/model.js";
import { canvasBus } from "../canvas/panel-bus.js";

/** The dock's sweep interval (dock.ts SPEAKING_TICK_MS), which is the cadence
 * every test here plays out. */
const TICK_MS = 250;

/** canvasBus is a module singleton, so one test's audio state is the next
 * test's starting state unless it is put back. */
function resetBus(): void {
  canvasBus.setAv({
    status: "off",
    muted: false,
    cameraOn: false,
    speaking: [],
    video: [],
    self: null,
  });
}

let clock = 0;
let stop: (() => void) | null = null;

beforeEach(() => {
  clock = 0;
  resetBus();
});

afterEach(() => {
  stop?.();
  stop = null;
  resetBus();
});

function dockSpeaking(onChange?: () => void) {
  const speaking = createDockSpeaking({ now: () => clock, onChange });
  stop = speaking.stop;
  return speaking;
}

describe("createDockSpeaking", () => {
  it("keeps the ring lit while one person talks without stopping", () => {
    // The single-speaker case, which is the one that broke: with two or more
    // speakers LiveKit's audio-level ordering reshuffles the array and the bus
    // dedupe is defeated by accident.
    const speaking = dockSpeaking();

    canvasBus.setAv({ speaking: ["alice"] });
    expect(speaking.current()).toEqual(["alice"]);

    // Three seconds of uninterrupted talking: the SFU keeps naming alice, and
    // the dock keeps sweeping.
    for (let step = 1; step <= 12; step += 1) {
      clock = step * TICK_MS;
      canvasBus.setAv({ speaking: ["alice"] });
      speaking.tick();
    }

    expect(clock).toBeGreaterThan(SPEAKING_HOLD_MS * 3);
    expect(speaking.current()).toEqual(["alice"]);
  });

  it("is fed by a bus that deliberately swallows a repeated speaker list", () => {
    // The mechanism behind the test above, pinned so nobody "simplifies" the
    // sweep back into reacting to bus events alone.
    const notified = vi.fn();
    dockSpeaking(notified);

    canvasBus.setAv({ speaking: ["alice"] });
    canvasBus.setAv({ speaking: ["alice"] });
    canvasBus.setAv({ speaking: ["alice"] });

    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("puts the ring out once the talking stops", () => {
    const speaking = dockSpeaking();

    canvasBus.setAv({ speaking: ["alice"] });
    canvasBus.setAv({ speaking: [] });

    // Still lit through the gap between words...
    clock = TICK_MS;
    speaking.tick();
    expect(speaking.current()).toEqual(["alice"]);

    // ...and out once the hold runs out, on the sweep rather than on some later
    // unrelated event.
    clock = SPEAKING_HOLD_MS + TICK_MS;
    expect(speaking.tick()).toBe(true);
    expect(speaking.current()).toEqual([]);
  });

  it("does not ask for a repaint on every sweep while someone keeps talking", () => {
    // The dock is a permanent overlay on every bb page. Refreshing the hold
    // four times a second is fine; repainting four times a second because the
    // hold's timestamps moved, while the visible ring is identical, is not.
    const notified = vi.fn();
    const speaking = dockSpeaking(notified);

    canvasBus.setAv({ speaking: ["alice"] });
    expect(notified).toHaveBeenCalledTimes(1);
    notified.mockClear();

    for (let step = 1; step <= 8; step += 1) {
      clock = step * TICK_MS;
      canvasBus.setAv({ speaking: ["alice"] });
      expect(speaking.tick()).toBe(false);
    }

    expect(speaking.current()).toEqual(["alice"]);
    expect(notified).not.toHaveBeenCalled();
  });

  it("reports a repaint exactly when the set of ringed people changes", () => {
    const notified = vi.fn();
    const speaking = dockSpeaking(notified);

    canvasBus.setAv({ speaking: ["alice"] });
    notified.mockClear();

    clock = TICK_MS;
    canvasBus.setAv({ speaking: ["alice", "bob"] });
    expect(speaking.current()).toEqual(["alice", "bob"]);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("costs nothing on the sweeps where nobody is talking at all", () => {
    // This interval runs for the whole session in every bb window, on pages
    // that have nothing to do with the canvas.
    const speaking = dockSpeaking();
    for (let step = 1; step <= 4; step += 1) {
      clock = step * TICK_MS;
      expect(speaking.tick()).toBe(false);
    }
    expect(speaking.current()).toEqual([]);
  });

  it("stops listening to the bus when the dock is disposed", () => {
    const notified = vi.fn();
    const speaking = dockSpeaking(notified);
    speaking.stop();

    canvasBus.setAv({ speaking: ["alice"] });

    expect(notified).not.toHaveBeenCalled();
    expect(speaking.current()).toEqual([]);
  });
});
