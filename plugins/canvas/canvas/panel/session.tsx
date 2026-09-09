import { useCallback } from "react";
import { useDocSnapshot, useEditorState } from "@ensembleworks/canvas-react";
import type { Intent } from "@ensembleworks/canvas-editor";
import { toast } from "sonner";
import { promptTextFor } from "../agents-view.js";
import type { ToolId } from "../tool-loop.js";
import { useSessionInput } from "./session-input.js";
import { useSessionPages } from "./session-pages.js";
import { useSessionPresence } from "./session-presence.js";
import { useSessionReveal } from "./session-reveal.js";
import type { CanvasSessionProps } from "./session-types.js";
import { useSessionViewport } from "./session-viewport.js";
import { SessionView } from "./session-view.js";

export function CanvasSession({
  session,
  subPath,
  identities,
  selfName,
  agentLinks,
  pendingShapeId,
  onRunNote,
  onUnlinkNote,
  onAttachThread,
  loadThreadOptions,
  treeGesturePending,
  onAddGoal,
  onAddBlocker,
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
  const input = useSessionInput({
    editor,
    tools,
    toolContext,
    presenceStore,
    presencePublisher,
    panelRef: viewport.panelRef,
    viewportRef: viewport.viewportRef,
  });
  // W9's return leg: a `::node` card clicked in a thread lands here, on this
  // canvas, with that node selected and centred. Mounted next to the page
  // router deliberately — the reveal asks for its page through the URL, which
  // is the router's one job, rather than becoming a second thing that writes
  // `currentPageId`.
  useSessionReveal({
    editor,
    snapshot,
    currentPageId: editorState.currentPageId,
    livePageIds: snapshot.pages.map((page) => page.id),
    viewportSizeRef: viewport.viewportSizeRef,
  });
  const { navigate, pageSwitcher } = useSessionPages({
    editor,
    snapshot,
    editorState,
    subPath,
    columnWidth: viewport.columnWidth,
  });

  const handleRunNote = useCallback(
    (shapeId: string) => {
      const text = promptTextFor(
        snapshot.byId.get(shapeId),
        editor.doc.getText(shapeId),
      );
      if (text.length === 0) {
        toast.error("This note is empty — type a prompt into it first.");
        return;
      }
      onRunNote(shapeId, text);
    },
    [editor, snapshot, onRunNote],
  );
  const dispatch = useCallback(
    (intents: Intent[]) => editor.applyAll(intents),
    [editor],
  );
  const handleTextChange = useCallback(
    (id: string, text: string) => editor.apply({ type: "SetText", id, text }),
    [editor],
  );
  const handleEndEdit = useCallback(() => editor.apply({ type: "EndEdit" }), [editor]);
  const selectTool = useCallback((id: ToolId) => input.selectTool(id), [input.selectTool]);

  return (
    <SessionView
      editorState={editorState}
      snapshot={snapshot}
      toolContext={toolContext}
      viewportRef={viewport.viewportRef}
      panelRef={viewport.panelRef}
      viewportSize={viewport.viewportSize}
      remotePresence={presence.remotePresence}
      presenceAll={presence.presenceAll}
      identities={identities}
      av={presence.av.speaking}
      selfKey={selfKey}
      activeToolId={input.activeToolId}
      toolStates={input.toolStates}
      handleInput={input.handleInput}
      cancelAndReset={input.cancelAndReset}
      dispatch={dispatch}
      handleTextChange={handleTextChange}
      handleEndEdit={handleEndEdit}
      selectTool={selectTool}
      agentLinks={agentLinks}
      pendingShapeId={pendingShapeId}
      onRun={handleRunNote}
      onOpen={(threadId) => navigate.toThread(threadId)}
      onUnlink={onUnlinkNote}
      onAttach={onAttachThread}
      loadThreadOptions={loadThreadOptions}
      treeGesturePending={treeGesturePending}
      onAddGoal={onAddGoal}
      onAddBlocker={onAddBlocker}
      pageSwitcher={pageSwitcher}
    />
  );
}
