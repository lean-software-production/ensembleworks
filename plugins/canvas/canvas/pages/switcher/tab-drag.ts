import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { Editor } from "@ensembleworks/canvas-editor";
import {
  IDLE_TAB_DRAG,
  dropIndexAt,
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
    runDragEffect(step.effect);
  }, [runDragEffect]);

  const beginTabDrag = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string): void => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const before = dragRef.current;
      dispatchDrag({
        type: "down", index, id, pointerId: event.pointerId,
        button: event.button, x: event.clientX,
      });
      if (tabDragTakesMeasurement(before, dragRef.current)) {
        boxesRef.current = measureTabs();
      }
    },
    [dispatchDrag, measureTabs],
  );

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
