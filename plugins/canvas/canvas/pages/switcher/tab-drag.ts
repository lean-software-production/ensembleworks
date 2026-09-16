import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { Editor } from "@ensembleworks/canvas-editor";
import {
  IDLE_TAB_DRAG,
  TAB_DRAG_LONG_PRESS_MS,
  dropIndexAt,
  tabDragIsCoarse,
  nextTabDrag,
  tabDragIsActive,
  tabDragPaint,
  tabDragPresentation,
  tabDragTakesMeasurement,
  type TabBox,
  type TabDragEffect,
  type TabDragEvent,
  type TabDragState,
} from "../tab-drag.js";
import { dropPageIntents } from "../page-intents.js";
import type { PageMenuRow } from "../page-menu.js";

export interface TabDragController {
  readonly stripRef: RefObject<HTMLDivElement | null>;
  readonly dragRef: MutableRefObject<TabDragState>;
  readonly presentation: ReturnType<typeof tabDragPresentation>;
  readonly dispatchDrag: (event: TabDragEvent) => void;
  readonly beginTabDrag: (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string) => void;
}

export function useTabDrag(
  editor: Editor,
  rows: readonly PageMenuRow[],
  switchTo: (row: PageMenuRow) => void,
): TabDragController {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<TabDragState>(IDLE_TAB_DRAG);
  const [dragState, setDragState] = useState<TabDragState>(IDLE_TAB_DRAG);
  const boxesRef = useRef<readonly TabBox[]>([]);
  // THE LONG-PRESS TIMER (mobile-touch task) lives HERE, not in tab-drag.ts:
  // that module is asserted clock-free by tests/source-guard.test.ts, because a
  // rule armed by elapsed time inside it would be invisible to every
  // behavioural test and only fail on a tablet. So the component owns the
  // `setTimeout` and the machine owns what a `hold` MEANS.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoldTimer = useCallback((): void => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const measureTabs = useCallback((): readonly TabBox[] => {
    const strip = stripRef.current;
    if (strip === null) return [];
    return Array.from(strip.querySelectorAll("[data-canvas-page-tab]"), (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
  }, []);

  const runDragEffect = useCallback((effect: TabDragEffect): void => {
    if (effect.kind === "switch") {
      const row = rows.find((candidate) => candidate.id === effect.id);
      if (row !== undefined) switchTo(row);
      return;
    }
    if (effect.kind === "drop") {
      const intents = dropPageIntents(
        editor,
        effect.id,
        dropIndexAt(boxesRef.current, effect.pointerX, effect.index),
      );
      if (intents.length > 0) editor.applyAll(intents);
    }
  }, [editor, rows, switchTo]);

  const dispatchDrag = useCallback((event: TabDragEvent): void => {
    const step = nextTabDrag(dragRef.current, event);
    dragRef.current = step.state;
    setDragState(step.state);
    // A pending hold outlives only a press that is still a press. Anything
    // else — it armed, it was given to the scroller, it ended, it was
    // cancelled — means the timer has nothing left to arm, and a stale one
    // firing later is exactly the kind of thing that lifts a tab the user let
    // go of. (The machine ignores a stale `hold` anyway; clearing is the belt
    // to that braces.)
    if (step.state.phase !== "pressed") clearHoldTimer();
    runDragEffect(step.effect);
  }, [runDragEffect, clearHoldTimer]);

  const beginTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string): void => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const before = dragRef.current;
      clearHoldTimer();
      dispatchDrag({
        type: "down", index, id, pointerId: event.pointerId,
        button: event.button, x: event.clientX,
        pointerType: event.pointerType,
      });
      if (tabDragTakesMeasurement(before, dragRef.current)) {
        boxesRef.current = measureTabs();
      }
      // Only a FINGER that actually took the press waits for a hold. The
      // machine re-checks both conditions itself when the timer fires (a
      // pointer can be lost in 400ms), so this is an optimisation, not the
      // rule.
      if (tabDragIsCoarse(event.pointerType) && dragRef.current.phase === "pressed") {
        const pointerId = event.pointerId;
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          dispatchDrag({ type: "hold", pointerId });
        }, TAB_DRAG_LONG_PRESS_MS);
      }
    },
    [dispatchDrag, measureTabs, clearHoldTimer],
  );

  // A component that unmounts mid-press must not leave a timer pointing at a
  // dispatch that will touch a dead machine.
  useEffect(() => clearHoldTimer, [clearHoldTimer]);

  useEffect(() => {
    if (!tabDragIsActive(dragState)) return;
    function onDragKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      dispatchDrag({ type: "cancel" });
    }
    function onDragBlur(): void {
      dispatchDrag({ type: "cancel" });
    }
    window.addEventListener("keydown", onDragKeyDown);
    window.addEventListener("blur", onDragBlur);
    return () => {
      window.removeEventListener("keydown", onDragKeyDown);
      window.removeEventListener("blur", onDragBlur);
    };
  }, [dragState, dispatchDrag]);

  const presentation = tabDragPresentation(dragState, boxesRef.current);

  return {
    stripRef,
    dragRef,
    presentation,
    dispatchDrag,
    beginTabDrag,
  };
}
