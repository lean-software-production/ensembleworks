import { fetchIdentity } from "../identity.js";
import type { DockRepaint } from "./repaint.js";
import { transcriptDoor } from "./transcript-door.js";
import type { DockRoute } from "./route.js";

const ROSTER_POLL_MS = 2_000;
const SPEAKING_TICK_MS = 250;

// Subscription setup is kept in its own controller because the order of these
// side effects is observable. Repaint subscribes to canvasBus first, the
// transcript door is next, then the two intervals and the route listeners are
// installed, and only then is identity fetched. This is the same order the
// composition root used before extraction.
//
// The two clocks retain different semantics. The roster timer may refresh the
// route only while the document is visible, but its placement poll always runs
// so a hidden window can recover a removed or moved strip. The speaking timer
// always ticks; repaint itself decides whether an expired speaking hold caused
// a visible change.
//
// Route changes from back/forward are immediate. Visibility changes refresh
// the roster and schedule the coalesced placement pass because animation frames
// are not dependable while a document is hidden. Identity completion paints
// the new self label before asking for the immediate named roster refresh.
//
// Teardown mirrors setup in the established order: the door subscription,
// repaint subscription, timers, visibility listener, and popstate listener are
// released only after placement has stopped accepting observer work. The
// LiveKit session is not touched here; it is a shared singleton that outlives
// the content-script generation.
export interface DockSubscriptionsOptions {
  readonly repaint: DockRepaint;
  readonly signal: AbortSignal;
  readonly route: DockRoute;
  readonly isDisposed: () => boolean;
  readonly render: () => void;
  readonly schedule: () => void;
  readonly poll: () => void;
  readonly setIdentity: (name: string) => void;
}

export interface DockSubscriptions {
  readonly repaint: DockRepaint;
  readonly stop: () => void;
}

interface DockTimers {
  readonly roster: ReturnType<typeof setInterval>;
  readonly speaking: ReturnType<typeof setInterval>;
}

export function createDockSubscriptions(options: DockSubscriptionsOptions): DockSubscriptions {
  const repaint = options.repaint;
  const unsubscribeDoor = transcriptDoor.subscribe(options.render);
  const timers: DockTimers = {
    roster: setInterval(() => {
      if (!document.hidden) {
        void options.route.refresh();
      }
      options.poll();
    }, ROSTER_POLL_MS),
    speaking: setInterval(() => {
      repaint.tick();
    }, SPEAKING_TICK_MS),
  };
  const onPopState = (): void => {
    options.route.check();
  };
  const onVisibility = (): void => {
    if (document.hidden) return;
    void options.route.refresh();
    options.schedule();
  };
  window.addEventListener("popstate", onPopState);
  document.addEventListener("visibilitychange", onVisibility);
  const fetchWithSignal: typeof fetch = (input, init) => {
    return fetch(input, {
      ...init,
      signal: options.signal,
    });
  };
  void fetchIdentity(fetchWithSignal).then((identity) => {
    if (options.isDisposed()) return;
    options.setIdentity(identity.name);
    options.render();
    void options.route.refresh();
  });

  return {
    repaint,
    stop: () => {
      unsubscribeDoor();
      repaint.stop();
      clearInterval(timers.roster);
      clearInterval(timers.speaking);
      document.removeEventListener(
        "visibilitychange",
        onVisibility,
      );
      window.removeEventListener(
        "popstate",
        onPopState,
      );
    },
  };
}
