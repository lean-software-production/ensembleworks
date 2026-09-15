import { canvasThemeStyle, canvasShapeThemeCss } from "../theme.js";
import { useMemo, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { EditorState } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import { Cursors, type ViewportSize } from "@ensembleworks/canvas-react";
import { CanvasSurface, Toolbar, type CanvasSession } from "@ensembleworks/canvas-ui";
import { AgentLayer } from "../agents-ui.js";
import type { ThreadOption } from "../thread-picker.js";
import type { CanvasAgentLink } from "../wire.js";
import { SpeakerRings } from "../roster-ui.js";
import {
  chromeCardColumnStyle,
  chromeColumnStyle,
  chromeTabRowStyle,
  chromeToolbarStyle,
  chromeWrapperStyle,
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
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly panelRef: RefObject<HTMLDivElement | null>;
  readonly viewportSize: ViewportSize;
  readonly remotePresence: CursorPresence;
  readonly presenceAll: SpeakerPresence;
  readonly identities: Readonly<Record<string, string>>;
  readonly av: ComponentProps<typeof SpeakerRings>["speaking"];
  readonly selfKey: string;
  readonly canvas: CanvasSession;
  readonly agentLinks: Readonly<Record<string, CanvasAgentLink>>;
  readonly pendingShapeId: string | null;
  readonly onRun: (shapeId: string) => void;
  readonly onOpen: (threadId: string) => void;
  readonly onUnlink: (shapeId: string) => void;
  readonly onAttach: (shapeId: string, threadId: string) => void;
  readonly loadThreadOptions: () => Promise<ThreadOption[]>;
  readonly pageSwitcher: PageSwitcherView;
}

export function SessionView(props: SessionViewProps) {
  const pageSwitcher = props.pageSwitcher;
  const shapeThemeCss = useMemo(() => canvasShapeThemeCss(props.snapshot), [props.snapshot]);
  return (
    <div ref={props.panelRef} data-canvas-themed style={canvasThemeStyle} className="flex h-full min-h-0 w-full flex-row">
      <style>{shapeThemeCss}</style>
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col" style={chromeColumnStyle}>
        <div data-canvas-page-tab-row style={chromeTabRowStyle}>
          {pageSwitcher.tabs}
        </div>
        <CanvasViewport {...props} />
        <CanvasChrome {...props} />
        {pageSwitcher.overlays}
      </div>
    </div>
  );
}

function CanvasViewport({
  editorState,
  snapshot,
  viewportRef,
  viewportSize,
  remotePresence,
  presenceAll,
  identities,
  av,
  selfKey,
  canvas,
  agentLinks,
  pendingShapeId,
  onRun,
  onOpen,
  onUnlink,
  onAttach,
  loadThreadOptions,
}: SessionViewProps) {
  return (
    <div
      ref={viewportRef}
      data-canvas-viewport
      className="relative min-h-0 flex-1"
      style={{ background: "var(--canvas-paper, #fafaf7)" }}
    >
      <CanvasSurface
        session={canvas}
        editorState={editorState}
        snapshot={snapshot}
        viewportSize={viewportSize}
        overlays={
          <Cursors
            presence={remotePresence}
            selfKey={selfKey}
            camera={editorState.camera}
            viewportSize={viewportSize}
            currentPageId={editorState.currentPageId}
          />
        }
      />
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

function CanvasChrome({ canvas, editorState }: SessionViewProps) {
  return (
    <div data-canvas-chrome-dock style={chromeWrapperStyle}>
      <div style={chromeCardColumnStyle}>
        <div style={chromeToolbarStyle}>
          <Toolbar
            orientation="vertical"
            activeToolId={canvas.activeToolId}
            onSelectTool={canvas.selectTool}
            nextShapeStyle={editorState.nextShapeStyle}
            onArmStyle={canvas.onArmStyle}
            style={{ background: "transparent", border: "none", padding: 0 }}
          />
        </div>
      </div>
    </div>
  );
}
