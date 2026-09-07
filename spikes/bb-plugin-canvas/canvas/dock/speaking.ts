// The speaking ring's clock.
//
// WHY THIS IS A MODULE AND NOT FOUR LINES IN dock.ts. Two things drive the ring
// and they have to agree about one question — "who is LiveKit naming right
// now?":
//
//   * the bus, carrying `ActiveSpeakersChanged`. Irregular, and DEDUPLICATED:
//     panel-bus.ts drops a repeated identical speaker list on purpose, so a
//     steady talker produces exactly ONE notification and then silence.
//   * the sweep timer. Regular, and therefore the only thing that can notice
//     either that a hold has run out or that the same person is still going.
//
// Written inline those were two call sites folding two different answers into
// one hold map, and the timer's answer was a hard-coded empty list — so a lone
// speaker's ring went dark mid-sentence, ~900ms in, and stayed dark until the
// active-speaker SET changed. The fix is structural rather than a corrected
// argument: `tick()` takes no active list, this module is the single reader of
// the bus, and there is no longer a second answer for a caller to pass.
import { canvasBus } from "../panel-bus.js";
import { holdSpeaking, speakingAt, type SpeakingHold } from "./model.js";

export interface DockSpeaking {
  /** Who is ringed, sorted. Exactly what the last fold settled on, so a repaint
   * triggered by anything else (a roster poll, a mute) draws the same ring
   * rather than a differently-rounded one. */
  current(): readonly string[];
  /**
   * The sweep the dock's timer calls: re-read the active speakers, refresh the
   * holds, expire what has run out. Returns whether the ring CHANGED, so the
   * dock repaints when a ring appears or goes out and not merely because a
   * timestamp moved — this runs four times a second for the whole session.
   */
  tick(): boolean;
  /** Drop the bus subscription. */
  stop(): void;
}

export interface DockSpeakingOptions {
  /**
   * Called whenever the ring's contents changed — including on the folds this
   * module's own bus subscription performs, which `tick()`'s return value
   * cannot report.
   *
   * canvas/dock/repaint.ts deliberately passes none: it repaints for every bus
   * notification anyway (a mute and a camera are not visible here), so a ring
   * change arriving on the bus is already being painted and a second callback
   * would only paint it twice. It is the sweep's `tick()` boolean that repaint
   * gates on. Left on the interface because it is the only way to observe a
   * bus-driven fold, which is what tests/dock-speaking.test.ts does.
   */
  readonly onChange?: () => void;
  /** Injectable clock, so the hold's expiry is testable without waiting. */
  readonly now?: () => number;
}

export function createDockSpeaking(
  options: DockSpeakingOptions = {},
): DockSpeaking {
  const now = options.now ?? ((): number => Date.now());
  const onChange = options.onChange ?? ((): void => {});

  let hold: SpeakingHold = {};
  let shown: readonly string[] = [];

  function fold(): boolean {
    const active = canvasBus.snapshot().av.speaking;
    // Silence with nothing outstanding: the state of every bb page that is not
    // in a call, which is most of them for most of the session.
    if (active.length === 0 && shown.length === 0) return false;

    const at = now();
    hold = holdSpeaking(hold, active, at);
    const next = speakingAt(hold, at);
    if (same(shown, next)) return false;
    shown = next;
    onChange();
    return true;
  }

  const unsubscribe = canvasBus.subscribe(() => {
    fold();
  });

  return {
    current: () => shown,
    tick: fold,
    stop: unsubscribe,
  };
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}
