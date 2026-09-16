import type { CSSProperties } from "react";
import { PresenceStore, SyncClientPeer } from "@ensembleworks/canvas-sync";
import type { Editor, ToolContext, ToolSet } from "@ensembleworks/canvas-editor";
import {
  CHROME_DOCK_EDGE_GAP_PX,
  CHROME_DOCK_POINTER_EVENTS,
  CHROME_DOCK_TOOLBAR_OVERFLOW,
  CHROME_DOCK_Z_INDEX,
  CHROME_FAINT,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_PAPER,
  CHROME_SHADOW,
} from "../pages/chrome-dock.js";
import type { PresencePublisher } from "../presence-publisher.js";

export const READY_TIMEOUT_MS = 4_000;
export const PRESENCE_POLL_MS = 150;
export const KEEPALIVE_MS = 45_000;

// The stage is the canvas area below the page tab row. It is the size
// container canvas-ui's flyout caps its height to (`cqh`) and the box the rail
// centres in, so neither can reach up over the tabs in a short pane. A flex
// item with `flex-1`/`min-h-0` in the full-height column, so its height is
// definite and size containment cannot collapse it.
export const chromeStageStyle: CSSProperties = {
  containerType: "size",
};

// A left-edge rail, centred vertically in the stage; canvas-ui's flyout sits
// beside it, centred on it too.
export const chromeWrapperStyle: CSSProperties = {
  position: "absolute",
  left: CHROME_DOCK_EDGE_GAP_PX,
  top: "50%",
  transform: "translateY(-50%)",
  zIndex: CHROME_DOCK_Z_INDEX,
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.wrapper,
  display: "flex",
};

export const chromeTabRowStyle: CSSProperties = {
  flexShrink: 0,
  background: CHROME_PAPER,
  borderBottom: `1px solid ${CHROME_FAINT}`,
  minWidth: 0,
};

// The manual zoom controls dock to the OPPOSITE corner from the tool rail
// (chromeWrapperStyle, left-centred) — bottom-right, out of the rail's own
// vertical-centre band so neither chrome ever overlaps the other. Same
// edge-gap/z-index/pointer-events vocabulary as the rail for the same
// reasons (see chrome-dock.ts's CHROME_DOCK_* comments): clearance from the
// stage's own edge, painting above the canvas content but below the
// <body>-portalled popovers, and opting back in to pointer events since the
// stage/wrapper ancestors it sits over are not otherwise click-through here.
export const chromeZoomStyle: CSSProperties = {
  position: "absolute",
  right: CHROME_DOCK_EDGE_GAP_PX,
  bottom: CHROME_DOCK_EDGE_GAP_PX,
  zIndex: CHROME_DOCK_Z_INDEX,
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.card,
};

export const chromeCardColumnStyle: CSSProperties = {
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.card,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  maxWidth: "100%",
  minWidth: 0,
};

// Capped to the stage; the rail's own scroller takes any overflow, so a pane
// shorter than the rail never pushes tools off-edge.
export const chromeToolbarStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  boxSizing: "border-box",
  maxHeight: `calc(100cqh - ${2 * CHROME_DOCK_EDGE_GAP_PX}px)`,
  minHeight: 0,
  alignItems: "center",
  gap: 4,
  flexWrap: CHROME_DOCK_TOOLBAR_OVERFLOW,
  padding: "6px 5px",
  borderRadius: 10,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  boxShadow: CHROME_SHADOW,
  color: CHROME_INK,
  font: CHROME_FONT,
  minWidth: 0,
};

export interface Session {
  readonly peer: SyncClientPeer;
  readonly editor: Editor;
  readonly toolContext: ToolContext;
  readonly tools: ToolSet;
  readonly presenceStore: PresenceStore;
  readonly presencePublisher: PresencePublisher;
  readonly selfKey: string;
}

export function cryptoRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

export function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function joinInput(
  clientId: string,
  name: string | null,
): { clientId: string; name?: string } {
  return name === null ? { clientId } : { clientId, name };
}

export function canvasDebugEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("canvasDebug") === "1") return true;
  } catch {
    // fall through to the storage check
  }
  try {
    return window.localStorage.getItem("canvas.debug") === "1";
  } catch {
    return false;
  }
}
