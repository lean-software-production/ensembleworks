import { useMemo } from "react";
import { useDocSnapshot, useEditorState } from "@ensembleworks/canvas-react";
import { useCanvasSession, type CanvasHost } from "@ensembleworks/canvas-ui";
import { toast } from "sonner";
import { useSessionDebug } from "./session-debug.js";
import { useSessionPages } from "./session-pages.js";
import { useSessionPresence } from "./session-presence.js";
import type { CanvasSessionProps } from "./session-types.js";
import { useSessionViewport } from "./session-viewport.js";
import { SessionView } from "./session-view.js";
import { useThreadReturn } from "./session-thread-return.js";

export function CanvasSession({
  session,
  subPath,
  identities,
  selfName,
}: CanvasSessionProps) {
  const { editor, toolContext, tools, presenceStore, presencePublisher, selfKey } = session;
  const editorState = useEditorState(editor);
  const snapshot = useDocSnapshot(toolContext);
  const viewport = useSessionViewport();
  const presence = useSessionPresence({
    editor,
    presenceStore,
    presencePublisher,
    identities,
    selfKey,
    selfName,
    currentPageId: editorState.currentPageId,
    viewportSizeRef: viewport.viewportSizeRef,
  });
  const host = useMemo<CanvasHost>(
    () => ({
      clipboard: {
        read: () => navigator.clipboard.readText(),
        write: (text) => navigator.clipboard.writeText(text),
      },
      notify: (message) => toast.error(message),
      onCursorScreen: (point) => presencePublisher.setCursorFromScreen(point, editor.get().camera),
    }),
    [editor, presencePublisher],
  );
  const canvas = useCanvasSession({
    editor,
    toolContext,
    tools,
    host,
    keyboardScopeRef: viewport.panelRef,
    viewportContainerRef: viewport.viewportRef,
  });
  useSessionDebug({ editor, toolContext, presenceStore, handleInput: canvas.handleInput });
  const { navigate, pageSwitcher } = useSessionPages({
    editor,
    snapshot,
    editorState,
    subPath,
    columnWidth: viewport.columnWidth,
  });
  const openThread = useThreadReturn({ editor, subPath, navigate, cancelAndReset: canvas.cancelAndReset });

  return (
    <SessionView
      editorState={editorState}
      snapshot={snapshot}
      viewportRef={viewport.viewportRef}
      panelRef={viewport.panelRef}
      viewportSize={viewport.viewportSize}
      remotePresence={presence.remotePresence}
      presenceAll={presence.presenceAll}
      identities={identities}
      av={presence.av.speaking}
      selfKey={selfKey}
      canvas={canvas}
      onOpen={openThread}
      pageSwitcher={pageSwitcher}
    />
  );
}
