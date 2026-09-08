import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  applyWheel,
  type Editor,
  type InputEvent,
  type KeyInputEvent,
  type ToolContext,
} from "@ensembleworks/canvas-editor";
import type { PresenceStore } from "@ensembleworks/canvas-sync";
import {
  cancelActiveTool,
  createInitialToolStates,
  deleteSelectionIntents,
  dispatchToActiveTool,
  type ToolId,
  type ToolSet,
  type ToolStates,
} from "../tool-loop.js";
import { redoWithRepair, undoWithRepair } from "../pages/history-repair.js";
import type { PresencePublisher } from "../presence-publisher.js";
import { isEditableTarget } from "./shared.js";
import { useSessionDebug } from "./session-debug.js";

export function useSessionInput({
  editor,
  tools,
  toolContext,
  presenceStore,
  presencePublisher,
  panelRef,
  viewportRef,
}: {
  readonly editor: Editor;
  readonly tools: ToolSet;
  readonly toolContext: ToolContext;
  readonly presenceStore: PresenceStore;
  readonly presencePublisher: PresencePublisher;
  readonly panelRef: RefObject<HTMLDivElement | null>;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
}) {
  const [activeToolId, setActiveToolId] = useState<ToolId>("select");
  const activeToolIdRef = useRef(activeToolId);
  activeToolIdRef.current = activeToolId;
  const [toolStates, setToolStates] = useState<ToolStates>(() =>
    createInitialToolStates(tools),
  );
  const toolStatesRef = useRef(toolStates);
  toolStatesRef.current = toolStates;

  const cancelAndReset = useCallback(() => {
    const { states, intents } = cancelActiveTool(
      tools,
      toolStatesRef.current,
      activeToolIdRef.current,
      editor,
    );
    if (intents.length > 0) editor.applyAll(intents);
    toolStatesRef.current = states;
    setToolStates(states);
  }, [editor, tools]);

  const handleGlobalShortcut = useCallback(
    (event: KeyInputEvent, editingId: string | null): boolean => {
      if (editingId !== null) return false;
      if (event.key === "Escape") {
        cancelAndReset();
        return true;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        const intents = deleteSelectionIntents(editor);
        if (intents.length > 0) editor.applyAll(intents);
        return true;
      }
      const key = event.key.toLowerCase();
      const withModifier = event.modifiers.ctrl || event.modifiers.meta;
      if (withModifier && key === "z" && !event.modifiers.shift) {
        undoWithRepair(editor);
        return true;
      }
      if (
        (withModifier && key === "z" && event.modifiers.shift) ||
        (event.modifiers.ctrl && key === "y")
      ) {
        redoWithRepair(editor);
        return true;
      }
      return false;
    },
    [editor, cancelAndReset],
  );

  const handleInput = useCallback(
    (event: InputEvent) => {
      if (event.type === "pointermove") {
        presencePublisher.setCursorFromScreen(
          { x: event.x, y: event.y },
          editor.get().camera,
        );
      }
      if (event.type === "wheel") {
        const next = applyWheel(editor.get().camera, event);
        editor.apply({ type: "SetCamera", ...next });
        return;
      }
      if (
        event.type === "keydown" &&
        handleGlobalShortcut(event, editor.get().editingId)
      ) {
        return;
      }
      const next = dispatchToActiveTool(
        tools,
        toolStatesRef.current,
        activeToolIdRef.current,
        editor,
        event,
      );
      toolStatesRef.current = next;
      setToolStates(next);
    },
    [editor, tools, presencePublisher, handleGlobalShortcut],
  );
  const selectTool = useCallback(
    (id: ToolId) => {
      cancelAndReset();
      setActiveToolId(id);
    },
    [cancelAndReset],
  );

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent): void {
      const panel = panelRef.current;
      const viewport = viewportRef.current;
      if (!panel) return;
      const target = event.target as Node | null;
      if (!target || !panel.contains(target)) return;
      if (viewport && viewport.contains(target)) return;
      if (isEditableTarget(target)) return;
      handleGlobalShortcut(
        {
          type: "keydown",
          key: event.key,
          modifiers: {
            shift: event.shiftKey,
            alt: event.altKey,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
          },
          t: event.timeStamp,
        },
        editor.get().editingId,
      );
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [editor, handleGlobalShortcut, panelRef, viewportRef]);

  useSessionDebug({ editor, toolContext, presenceStore, handleInput });

  return { activeToolId, toolStates, cancelAndReset, handleInput, selectTool };
}
