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

export const chromeWrapperStyle: CSSProperties = {
  position: "absolute",
  bottom: CHROME_DOCK_EDGE_GAP_PX,
  left: CHROME_DOCK_EDGE_GAP_PX,
  right: CHROME_DOCK_EDGE_GAP_PX,
  zIndex: CHROME_DOCK_Z_INDEX,
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.wrapper,
  display: "flex",
  justifyContent: "center",
};

export const chromeTabRowStyle: CSSProperties = {
  flexShrink: 0,
  background: CHROME_PAPER,
  borderBottom: `1px solid ${CHROME_FAINT}`,
  minWidth: 0,
};

export const chromeCardColumnStyle: CSSProperties = {
  pointerEvents: CHROME_DOCK_POINTER_EVENTS.card,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  maxWidth: "100%",
  minWidth: 0,
};

export const chromeToolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: CHROME_DOCK_TOOLBAR_OVERFLOW,
  padding: "5px 6px",
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
