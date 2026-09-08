// Run: npx vitest run tests/dock-repaint.test.ts
//
// WHEN THE DOCK REPAINTS — the other half of the glue tests/dock-speaking.test.ts
// covers, and the half that was missing.
//
// The dock is a permanent overlay with two very different clocks driving it:
//
//   * the BUS, which is event-driven and already deduplicated (panel-bus.ts
//     drops a set that did not change). Every notification it delivers is a
//     real change — a mute, a camera, a join phase, a roster — and every one of
//     them is visible in the pill, so every one of them must repaint.
//   * the SWEEP, four times a second for the whole session, which exists only
//     to notice that a speaking hold has run out. It must NOT repaint merely
//     because a timestamp moved.
//
// Conflating those two into one gate is what went wrong: the change guard the
// sweep needs was placed where the bus handler also passed through it, so a
// mute, a camera toggle or a remote video tile reached the DOM only when the
// speaking ring happened to change or the 5s roster poll came round. Both
// cadences are pinned here, against the REAL canvasBus singleton and the REAL
// module, with only the clock and render() faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDockRepaint, type DockRepaint } from "../canvas/dock/repaint.js";
import { SPEAKING_HOLD_MS } from "../canvas/dock/model.js";
import { canvasBus } from "../canvas/panel-bus.js";

/** A bus roster member — the canvas panel's shape, not the poll's. */
const member = (clientId: string, name: string) => ({
  clientId,
  name,
  color: "#123456",
  isSelf: false,
  hasCursor: true,
});

/** The dock's sweep interval (dock.ts SPEAKING_TICK_MS). */
const TICK_MS = 250;

/** canvasBus is a module singleton, so one test's state is the next test's
 * starting state unless it is put back. */
function resetBus(): void {
  canvasBus.setAv({
    status: "off",
    muted: false,
    cameraOn: false,
    speaking: [],
    video: [],
    self: null,
  });
  canvasBus.clearRoster();
}

let clock = 0;
let repaint: DockRepaint | null = null;

beforeEach(() => {
  clock = 0;
  resetBus();
});

afterEach(() => {
  repaint?.stop();
  repaint = null;
  resetBus();
});

function dockRepaint(render: () => void): DockRepaint {
  repaint = createDockRepaint({ render, now: () => clock });
  return repaint;
}

describe("createDockRepaint", () => {
  it("repaints when you mute your own microphone", () => {
    // av-room.setMuted publishes the new state on the bus and nothing else —
    // the dock's mic glyph, its aria-pressed and its data attribute are all
    // read out of that snapshot at render time. No repaint, no 🔇.
    const render = vi.fn();
    dockRepaint(render);

    canvasBus.setAv({ status: "live" });
    render.mockClear();

    canvasBus.setAv({ muted: true });

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("repaints when a camera goes on, local or remote", () => {
    // `video` is the list of identities publishing a camera. It is the only
    // thing that turns a bubble into a live tile, so a bubble cannot become a
    // tile without a repaint — for your own self-view or for a colleague's.
    const render = vi.fn();
    dockRepaint(render);

    canvasBus.setAv({ status: "live", self: "you" });
    render.mockClear();

    canvasBus.setAv({ cameraOn: true, video: ["you"] });
    expect(render).toHaveBeenCalledTimes(1);

    canvasBus.setAv({ video: ["alice", "you"] });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("repaints on every step of the join and the leave", () => {
    // The audio button is "Join audio" / "Joining…" (disabled) / "Leave", and
    // each of those is a bus phase. A button that stays on the previous label
    // is a button wired to the previous action.
    const render = vi.fn();
    dockRepaint(render);

    canvasBus.setAv({ status: "connecting" });
    expect(render).toHaveBeenCalledTimes(1);

    canvasBus.setAv({ status: "live", self: "you" });
    expect(render).toHaveBeenCalledTimes(2);

    canvasBus.setAv({ status: "off", self: null });
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("repaints when the roster changes", () => {
    // On the canvas page the bus roster is refreshed on the presence tick and
    // beats the dock's 5s poll — mergeRoster overlays it. It only beats the
    // poll if it is drawn.
    const render = vi.fn();
    dockRepaint(render);

    canvasBus.setRoster([member("c1", "alice")]);

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("draws the ring that arrived with the event that triggered it", () => {
    // A bus-borne speaking change repaints exactly once, and the ring the
    // render reads is already the new one — the hold is folded before render()
    // is called, not after it.
    const seen: (readonly string[])[] = [];
    const dock = dockRepaint(() => {
      seen.push(dock.current());
    });

    canvasBus.setAv({ speaking: ["alice"] });

    expect(seen).toEqual([["alice"]]);
  });

  it("does not repaint on the sweeps while someone keeps talking", () => {
    // The guard the sweep needs, pinned at this level too: refreshing a hold
    // 4x a second is free, repainting a permanent overlay 4x a second is not.
    const render = vi.fn();
    const dock = dockRepaint(render);

    canvasBus.setAv({ speaking: ["alice"] });
    render.mockClear();

    for (let step = 1; step <= 8; step += 1) {
      clock = step * TICK_MS;
      canvasBus.setAv({ speaking: ["alice"] });
      dock.tick();
    }

    expect(dock.current()).toEqual(["alice"]);
    expect(render).not.toHaveBeenCalled();
  });

  it("repaints on the sweep that puts the ring out", () => {
    const render = vi.fn();
    const dock = dockRepaint(render);

    canvasBus.setAv({ speaking: ["alice"] });
    canvasBus.setAv({ speaking: [] });
    render.mockClear();

    clock = SPEAKING_HOLD_MS + TICK_MS;
    dock.tick();

    expect(dock.current()).toEqual([]);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("costs nothing on the sweeps where nobody is talking", () => {
    const render = vi.fn();
    const dock = dockRepaint(render);

    for (let step = 1; step <= 4; step += 1) {
      clock = step * TICK_MS;
      dock.tick();
    }

    expect(render).not.toHaveBeenCalled();
  });

  it("stops repainting once the dock is disposed", () => {
    // The disposer runs on every plugin reload and every window close, while
    // the LiveKit session deliberately lives on — so the bus keeps talking to
    // a dock whose DOM has been removed unless this is airtight.
    const render = vi.fn();
    const dock = dockRepaint(render);
    dock.stop();

    canvasBus.setAv({ status: "live", muted: true, speaking: ["alice"] });
    canvasBus.setRoster([member("c1", "alice")]);

    expect(render).not.toHaveBeenCalled();
  });
});
