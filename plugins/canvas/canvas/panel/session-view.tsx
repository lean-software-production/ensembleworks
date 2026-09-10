import { useMemo, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { EditorState, InputEvent, Intent, ToolContext } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import {
  Cursors,
  Grid,
  Overlay,
  ShapeLayer,
  TextEditor,
  Viewport,
  WorldLayer,
  type ViewportSize,
} from "@ensembleworks/canvas-react";
import { AgentLayer } from "../agents-ui.js";
import type { ThreadOption } from "../thread-picker.js";
import type { CanvasAgentLink } from "../wire.js";
import { SpeakerRings } from "../roster-ui.js";
import { pageScopedDocument } from "./page-scope.js";
import { QuarantinedEdges } from "./quarantine-layer.js";
import { TreeGestureLayer } from "./tree-gesture-layer.js";
import type { ComposerDestination } from "../tree/discuss.js";
import type { ToolId, ToolStates } from "../tool-loop.js";
import {
  chromeCardColumnStyle,
  chromeTabRowStyle,
  chromeToolbarStyle,
  chromeToolStyle,
  chromeWrapperStyle,
  TOOL_BUTTONS,
  currentSnapResult,
} from "./shared.js";

type CursorPresence = ComponentProps<typeof Cursors>["presence"];
type SpeakerPresence = ComponentProps<typeof SpeakerRings>["presence"];

interface PageSwitcherView {
  readonly tabs: ReactNode;
  readonly overlays: ReactNode;
}

export interface SessionViewProps {
  readonly editorState: EditorState;
  readonly snapshot: CanvasDocument;
  readonly toolContext: ToolContext;
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly panelRef: RefObject<HTMLDivElement | null>;
  readonly viewportSize: ViewportSize;
  readonly remotePresence: CursorPresence;
  readonly presenceAll: SpeakerPresence;
  readonly identities: Readonly<Record<string, string>>;
  readonly av: ComponentProps<typeof SpeakerRings>["speaking"];
  readonly selfKey: string;
  readonly activeToolId: ToolId;
  readonly toolStates: ToolStates;
  readonly handleInput: (event: InputEvent) => void;
  readonly cancelAndReset: () => void;
  readonly dispatch: (intents: Intent[]) => void;
  readonly handleTextChange: (id: string, text: string) => void;
  readonly handleEndEdit: () => void;
  readonly selectTool: (id: ToolId) => void;
  readonly agentLinks: Readonly<Record<string, CanvasAgentLink>>;
  readonly pendingShapeId: string | null;
  readonly onRun: (shapeId: string) => void;
  readonly onOpen: (threadId: string) => void;
  readonly onUnlink: (shapeId: string) => void;
  readonly onAttach: (shapeId: string, threadId: string) => void;
  readonly loadThreadOptions: () => Promise<ThreadOption[]>;
  /** W4's two node gestures. Which gesture's write is in flight, and the two
   * calls that start one. */
  readonly treeGesturePending: "goal" | "blocker" | null;
  readonly onAddGoal: (treeId: string, title: string) => void;
  readonly onAddBlocker: (parentId: string, title: string) => void;
  /** W12: start a bb thread on this node, briefed with its context, its path
   * to root and what blocks it. */
  readonly onLaunchNode: (nodeId: string) => void;
  /** W8: where a node reference would land, and the call that puts one there. */
  readonly discussDestination: ComposerDestination;
  readonly onDiscuss: (treeId: string, nodeId: string) => void;
  readonly pageSwitcher: PageSwitcherView;
}

export function SessionView(props: SessionViewProps) {
  const pageSwitcher = props.pageSwitcher;
  return (
    <div ref={props.panelRef} className="flex h-full min-h-0 w-full flex-row">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div data-canvas-page-tab-row style={chromeTabRowStyle}>
          {pageSwitcher.tabs}
        </div>
        <CanvasSurface {...props} />
        <CanvasChrome {...props} />
        {pageSwitcher.overlays}
      </div>
    </div>
  );
}

function CanvasSurface({
  editorState,
  snapshot,
  toolContext,
  viewportRef,
  viewportSize,
  remotePresence,
  presenceAll,
  identities,
  av,
  selfKey,
  activeToolId,
  toolStates,
  handleInput,
  cancelAndReset,
  dispatch,
  handleTextChange,
  handleEndEdit,
  agentLinks,
  pendingShapeId,
  onRun,
  onOpen,
  onUnlink,
  onAttach,
  loadThreadOptions,
  treeGesturePending,
  onAddGoal,
  onAddBlocker,
  onLaunchNode,
  discussDestination,
  onDiscuss,
}: SessionViewProps) {
  const overlayDoc = useMemo(
    () => pageScopedDocument(snapshot, editorState.currentPageId),
    [snapshot, editorState.currentPageId],
  );
  return (
    <div
      ref={viewportRef}
      data-canvas-viewport
      className="relative min-h-0 flex-1"
      style={{ background: "var(--canvas-paper, #fafaf7)" }}
    >
      <Viewport
        onInput={handleInput}
        onViewportBlur={cancelAndReset}
        onPointerCancel={cancelAndReset}
        style={{ position: "absolute", inset: 0 }}
      >
        <Grid camera={editorState.camera} />
        <WorldLayer camera={editorState.camera}>
          <ShapeLayer
            toolContext={toolContext}
            camera={editorState.camera}
            viewportSize={viewportSize}
            dispatch={dispatch}
          />
          <TextEditor
            toolContext={toolContext}
            onTextChange={handleTextChange}
            onEndEdit={handleEndEdit}
          />
        </WorldLayer>
        {/* THE PAGE-SCOPED document, not the whole one (W16/B2). canvas-react's
            `Arrows` filters by viewport and not by page, so an arrow on another
            page is painted over this one whenever their world boxes overlap —
            which, since pages share one coordinate space, is routine. Its
            sibling <QuarantinedEdges> below has always taken `currentPageId`;
            this is the same posture, arrived at three months later. */}
        <Overlay
          editorState={editorState}
          snapshot={overlayDoc}
          camera={editorState.camera}
          viewportSize={viewportSize}
          index={toolContext.index()}
          snapResult={currentSnapResult(toolStates, activeToolId)}
        />
        {/* Later sibling than <Overlay>, so the marker paints ON TOP of the
            routed arrow that overlay already drew for the same shape. */}
        <QuarantinedEdges
          snapshot={snapshot}
          camera={editorState.camera}
          viewportSize={viewportSize}
          currentPageId={editorState.currentPageId}
        />
        <Cursors
          presence={remotePresence}
          selfKey={selfKey}
          camera={editorState.camera}
          viewportSize={viewportSize}
          currentPageId={editorState.currentPageId}
        />
      </Viewport>
      <AgentLayer
        doc={snapshot}
        camera={editorState.camera}
        viewportSize={viewportSize}
        selection={editorState.selection}
        links={agentLinks}
        currentPageId={editorState.currentPageId}
        pendingShapeId={pendingShapeId}
        onRun={onRun}
        onOpen={onOpen}
        onUnlink={onUnlink}
        onAttach={onAttach}
        loadThreadOptions={loadThreadOptions}
      />
      {/* Later than <AgentLayer>, and the same posture: pointer-events none on
          the layer, auto on the controls, anchored with screenBoxFor. */}
      <TreeGestureLayer
        doc={snapshot}
        camera={editorState.camera}
        viewportSize={viewportSize}
        selection={editorState.selection}
        currentPageId={editorState.currentPageId}
        pending={treeGesturePending}
        onAddGoal={onAddGoal}
        onAddBlocker={onAddBlocker}
        agentLinks={agentLinks}
        launchPendingShapeId={pendingShapeId}
        onLaunchNode={onLaunchNode}
        discussDestination={discussDestination}
        onDiscuss={onDiscuss}
      />
      <SpeakerRings
        presence={presenceAll}
        identities={identities}
        speaking={av}
        camera={editorState.camera}
        viewportSize={viewportSize}
        selfKey={selfKey}
        currentPageId={editorState.currentPageId}
      />
    </div>
  );
}

function CanvasChrome({
  activeToolId,
  selectTool,
}: SessionViewProps) {
  return (
    <div data-canvas-chrome-dock style={chromeWrapperStyle}>
      <div style={chromeCardColumnStyle}>
        <div style={chromeToolbarStyle}>
          {TOOL_BUTTONS.map((button) => (
            <button
              key={button.id}
              type="button"
              data-canvas-tool={button.id}
              aria-pressed={activeToolId === button.id}
              onClick={() => selectTool(button.id)}
              style={chromeToolStyle(activeToolId === button.id)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
