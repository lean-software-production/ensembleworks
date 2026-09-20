import { canvasThemeStyle, canvasShapeThemeCss } from "../theme.js";
import { githubCache } from "../github-cache-client.js";
import { CHROME_DOCK_POINTER_EVENTS, CHROME_DOCK_Z_INDEX } from "../pages/chrome-dock.js";
import { useMemo, type ComponentProps, type ReactNode, type RefObject } from "react";
import type { EditorState } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import { Cursors, type ViewportSize } from "@ensembleworks/canvas-react";
import { CanvasSurface, Toolbar, TOOL_ORDER, ZoomControls, controlSizePx, prefersCoarsePointer, type CanvasSession } from "@ensembleworks/canvas-ui";

// bb-thread-frame task: 'bbthread' is a plugin-only tool — the web app's
// TOOL_ORDER (canvas-ui's Toolbar.tsx) deliberately omits it, so this is the
// one call site that appends it, for this host only.
const BB_TOOLBAR_TOOLS = [...TOOL_ORDER, { id: "bbthread", label: "Thread" }] as const;
import type { useGithubIssueDraft } from "./github-draft.js";
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
  readonly issueDraft: ReturnType<typeof useGithubIssueDraft>;
}

export function SessionView(props: SessionViewProps) {
  const pageSwitcher = props.pageSwitcher;
  const shapeThemeCss = useMemo(() => canvasShapeThemeCss(props.snapshot), [props.snapshot]);
  // data-no-sidebar-swipe: BB's mobile shell opens the left sidebar on a swipe
  // that starts anywhere its handler does not exclude (it checks
  // `closest('[data-no-sidebar-swipe]')` among others). A leftward pan of the
  // canvas is exactly that gesture, so the whole panel opts out.
  return (
    <div ref={props.panelRef} data-canvas-themed data-no-sidebar-swipe="" style={canvasThemeStyle} className="flex h-full min-h-0 w-full flex-row"
      onFocusCapture={() => githubCache.refreshOnFocus()} onPointerDownCapture={() => githubCache.refreshOnFocus()}>
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
  issueDraft,
}: SessionViewProps) {
  return (
    <div
      ref={viewportRef}
      onPointerDownCapture={issueDraft.place}
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
      {issueDraft.placing && <div role="status" style={{ position: "absolute", zIndex: CHROME_DOCK_Z_INDEX, top: 12, left: "50%", transform: "translateX(-50%)", padding: "7px 11px", borderRadius: 6, background: "#24292f", color: "white", fontSize: 12, pointerEvents: CHROME_DOCK_POINTER_EVENTS.wrapper }}>Click the canvas to place a GitHub issue card · Esc to cancel</div>}
    </div>
  );
}

export function CanvasChrome({ canvas, editorState, issueDraft }: SessionViewProps) {
  return (
    <div data-canvas-chrome-dock style={chromeWrapperStyle}>
      <div style={chromeCardColumnStyle}>
        <div style={chromeToolbarStyle}>
          <Toolbar
            orientation="vertical"
            activeToolId={canvas.activeToolId}
            onSelectTool={(id) => { issueDraft.cancel(); canvas.selectTool(id); }}
            nextShapeStyle={editorState.nextShapeStyle}
            onArmStyle={canvas.onArmStyle}
            tools={BB_TOOLBAR_TOOLS}
            afterTools={<button type="button" data-canvas-tool="github-issue" aria-label="GitHub issue" title="GitHub issue" aria-pressed={issueDraft.placing} onClick={issueDraft.arm}
              onKeyDown={(event) => { if (issueDraft.placing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); issueDraft.openAtCenter(); } }}
              style={{ width: controlSizePx(prefersCoarsePointer(), 32), height: controlSizePx(prefersCoarsePointer(), 32), display: "grid", placeItems: "center", padding: 0, border: 0, borderRadius: 6, background: issueDraft.placing ? "#24292f" : "transparent", color: issueDraft.placing ? "white" : "#34435b", cursor: "pointer" }}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.02 3.18 9.27 7.59 10.78.56.1.77-.24.77-.54 0-.27-.01-1.16-.02-2.11-3.09.67-3.74-1.31-3.74-1.31-.5-1.28-1.23-1.62-1.23-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15.99 1.7 2.6 1.21 3.24.93.1-.72.39-1.21.7-1.49-2.47-.28-5.06-1.24-5.06-5.5 0-1.21.43-2.2 1.14-2.98-.12-.28-.5-1.41.11-2.95 0 0 .93-.3 3.05 1.14A10.5 10.5 0 0 1 12 6.32c.95 0 1.91.13 2.81.38 2.12-1.44 3.05-1.14 3.05-1.14.6 1.54.23 2.67.11 2.95.71.78 1.14 1.77 1.14 2.98 0 4.27-2.59 5.22-5.07 5.5.4.34.75 1.02.75 2.06 0 1.49-.01 2.69-.01 3.05 0 .3.2.65.77.54A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z"/></svg>
            </button>}
            style={{ background: "transparent", border: "none", padding: 0 }}
          />
        </div>
      </div>
    </div>
  );
}
