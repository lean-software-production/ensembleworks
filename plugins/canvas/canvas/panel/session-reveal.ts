// The panel's half of W9: finish a reveal that a message started.
//
// EVERY DECISION IS IN canvas/tree/reveal.ts, behind `runReveal`'s ports. What
// is left here is the three React facts a hook owns — subscribe to the bus,
// remember the page this reveal has already asked for, and keep the clock
// ticking so a reveal that never lands still reaches its deadline and says so.
//
// THE TICK IS NOT POLLING. Everything else that could complete a reveal
// (a doc delta, a page adoption) already re-renders this component; the timer
// exists ONLY so that a reveal which is going nowhere reaches `REVEAL_TIMEOUT_MS`
// and disarms, instead of sitting armed until the human's next page change
// yanks their camera somewhere they did not ask to go. It runs only while a
// target is pending, which is at most fifteen seconds after a click.
import { useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { Editor } from "@ensembleworks/canvas-editor";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { revealBus, revealSubjectFor, runReveal } from "../tree/reveal.js";

/** How often a pending reveal re-checks a world that did not change. */
const REVEAL_TICK_MS = 1_000;

export function useSessionReveal({
  editor,
  snapshot,
  currentPageId,
  livePageIds,
  viewportSizeRef,
}: {
  readonly editor: Editor;
  readonly snapshot: CanvasDocument;
  readonly currentPageId: string;
  readonly livePageIds: readonly string[];
  readonly viewportSizeRef: MutableRefObject<{ width: number; height: number }>;
}): void {
  const navigate = useBbNavigate();
  const target = useSyncExternalStore(
    revealBus.subscribe,
    revealBus.snapshot,
    revealBus.snapshot,
  );
  // The page this reveal has asked for, and WHICH reveal it was: a second
  // click on the same node is a new target (see `createRevealBus`) and must be
  // allowed to ask again.
  const routed = useRef<{ key: string; pageId: string | null }>({ key: "", pageId: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (target === null) return;
    const key = `${target.nodeId}@${target.requestedAt}`;
    const routedTo = routed.current.key === key ? routed.current.pageId : null;
    const pageId = runReveal(
      {
        target,
        subject: revealSubjectFor(snapshot, target.nodeId),
        currentPageId,
        livePageIds,
        routedTo,
        now: Date.now(),
        viewport: viewportSizeRef.current,
        zoom: editor.get().camera.z,
      },
      {
        apply: (intents) => editor.applyAll([...intents]),
        navigate,
        // A toast, not the connection banner: the canvas is perfectly healthy,
        // the reference is what could not be followed.
        notify: (message) => toast.message(message),
        clear: () => revealBus.clear(),
      },
    );
    routed.current = { key, pageId };
    const timer = setTimeout(() => setTick((value) => value + 1), REVEAL_TICK_MS);
    return () => clearTimeout(timer);
  }, [target, snapshot, currentPageId, livePageIds, editor, navigate, viewportSizeRef, tick]);
}
