import { canvasThemeStyle, canvasShapeThemeCss } from "../theme.js";
import { useMemo, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { EditorState } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import { Cursors, type ViewportSize } from "@ensembleworks/canvas-react";
import { CanvasSurface, Toolbar, TOOL_ORDER, ZoomControls, type CanvasSession } from "@ensembleworks/canvas-ui";

// bb-thread-frame task: 'bbthread' is a plugin-only tool — the web app's
// TOOL_ORDER (canvas-ui's Toolbar.tsx) deliberately omits it, so this is the
// one call site that appends it, for this host only.
const BB_TOOLBAR_TOOLS = [...TOOL_ORDER, { id: "bbthread", label: "Thread" }] as const;
import { SpeakerRings } from "../roster-ui.js";
import {
  chromeCardColumnStyle,
  chromeStageStyle,
  chromeTabRowStyle,
  chromeToolbarStyle,
  chromeWrapperStyle,
  chromeZoomStyle,
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
  /** Opens a thread from the canvas, remembering how to get back to this
   * page/camera/selection (session-thread-return.ts's `useThreadReturn`).
   * Unused by anything in this file for now — the retired agent-badge overlay
   * was its only caller — but kept on the prop chain because the coming
   * `bbthread` shape body's "Open full →" footer button is exactly this call
   * (docs/plans/2026-09-15-bb-thread-frame.md). */
  readonly onOpen: (threadId: string) => void;
  readonly pageSwitcher: PageSwitcherView;
}

export function SessionView(props: SessionViewProps) {
  const pageSwitcher = props.pageSwitcher;
  const shapeThemeCss = useMemo(() => canvasShapeThemeCss(props.snapshot), [props.snapshot]);
  return (
    <div ref={props.panelRef} data-canvas-themed style={canvasThemeStyle} className="flex h-full min-h-0 w-full flex-row">
      <style>{shapeThemeCss}</style>
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <div data-canvas-page-tab-row style={chromeTabRowStyle}>
          {pageSwitcher.tabs}
        </div>
        <div data-canvas-stage className="relative flex min-h-0 flex-1 flex-col" style={chromeStageStyle}>
          <CanvasViewport {...props} />
          <CanvasChrome {...props} />
          <div data-canvas-zoom-controls style={chromeZoomStyle}>
            <ZoomControls
              camera={props.editorState.camera}
              viewportSize={props.viewportSize}
              onSetCamera={(c) => props.canvas.dispatch([{ type: "SetCamera", x: c.x, y: c.y, z: c.z }])}
            />
          </div>
        </div>
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
            tools={BB_TOOLBAR_TOOLS}
            style={{ background: "transparent", border: "none", padding: 0 }}
          />
        </div>
      </div>
    </div>
  );
}
