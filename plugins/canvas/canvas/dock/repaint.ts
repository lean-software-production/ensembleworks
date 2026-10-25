// When the dock repaints.
//
// Extracted from dock.ts so the wiring itself is testable: the dock's body is
// imperative DOM with no harness short of a browser, but "which events reach a
// repaint" is a decision, and it is the decision that has been wrong twice.
//
// TWO CLOCKS, TWO RULES. They look alike and they are opposites:
//
//   * The BUS is event-driven and ALREADY DEDUPLICATED — panel-bus.ts drops a
//     set that did not change (that is what stops the canvas's 150ms presence
//     tick re-rendering an unchanged avatar stack). So every notification it
//     delivers is a real change to something the pill draws: a mute, a camera,
//     a join phase, the roster. Every one of them repaints, unconditionally.
//     Guarding this cadence is guarding a gate that is already shut, and it
//     costs the user a mic button stuck on the wrong glyph.
//   * The SWEEP runs four times a second for the whole session, in every bb
//     window, and exists only to notice that a speaking hold has RUN OUT. Its
//     answer is usually "nothing moved", so it repaints only when the ring
//     actually changed — `tick()`'s return value, not the tick itself.
//
// The bug this module exists to prevent was those two collapsed into one gate:
// the sweep's change guard sat where the bus handler passed through it too, so
// a mute or a remote camera reached the DOM only when the ring happened to
// change or the 5s roster poll came round. tests/dock-repaint.test.ts pins both
// rules; tests/dock-speaking.test.ts pins the hold underneath them.
import { canvasBus } from "../panel-bus.js";
import { createDockSpeaking } from "./speaking.js";

export interface DockRepaint {
  /** Who is ringed, for the render this is driving. Exactly what the last fold
   * published, so a repaint caused by something else draws the same ring. */
  current(): readonly string[];
  /** The dock's sweep timer: expire run-out holds, repaint only if the ring
   * changed. */
  tick(): void;
  /** Drop every subscription. */
  stop(): void;
}

export interface DockRepaintOptions {
  /** The dock's render(). */
  readonly render: () => void;
  /** Injectable clock for the speaking hold, so expiry is testable without
   * waiting. */
  readonly now?: () => number;
}

export function createDockRepaint(options: DockRepaintOptions): DockRepaint {
  // Subscribed FIRST, and that ordering is load-bearing: canvasBus notifies its
  // listeners in subscription order, so on a bus-borne ActiveSpeakersChanged
  // the hold is folded before render() below reads `current()`. The ring drawn
  // is therefore the one that arrived with the event that triggered the paint,
  // never the previous one. No onChange is passed — this module's own bus
  // handler is already repainting for that same notification, and asking for
  // both would paint the pill twice for one event.
  const speaking = createDockSpeaking({ now: options.now });

  const unsubscribe = canvasBus.subscribe(() => {
    options.render();
  });

  return {
    current: () => speaking.current(),
    tick: () => {
      if (speaking.tick()) options.render();
    },
    stop: () => {
      unsubscribe();
      speaking.stop();
    },
  };
}
