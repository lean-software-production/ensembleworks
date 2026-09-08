import { useEffect, useRef } from "react";
import type { Editor, InputEvent, ToolContext } from "@ensembleworks/canvas-editor";
import type { PresenceStore } from "@ensembleworks/canvas-sync";
import { canvasBus } from "../panel-bus.js";
import { canvasDebugEnabled } from "./shared.js";

export function useSessionDebug({
  editor,
  toolContext,
  presenceStore,
  handleInput,
}: {
  readonly editor: Editor;
  readonly toolContext: ToolContext;
  readonly presenceStore: PresenceStore;
  readonly handleInput: (event: InputEvent) => void;
}) {
  const handleInputRef = useRef(handleInput);
  handleInputRef.current = handleInput;
  useEffect(() => {
    if (!canvasDebugEnabled()) return;
    const globalWindow = window as unknown as {
      __canvas?: {
        editor: Editor;
        toolContext: ToolContext;
        presence: PresenceStore;
        input: (event: InputEvent) => void;
        bus: typeof canvasBus;
      };
    };
    globalWindow.__canvas = {
      editor,
      toolContext,
      presence: presenceStore,
      input: (event) => handleInputRef.current(event),
      bus: canvasBus,
    };
    return () => {
      delete globalWindow.__canvas;
    };
  }, [editor, toolContext, presenceStore]);
}
