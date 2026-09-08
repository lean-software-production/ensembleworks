import type { CSSProperties } from "react";
import { PresenceStore, SyncClientPeer } from "@ensembleworks/canvas-sync";
import type {
  Editor,
  SelectAndTransformState,
  SelectState,
  ToolContext,
} from "@ensembleworks/canvas-editor";
import type { SnapResult } from "@ensembleworks/canvas-model";
import {
  CHROME_ACCENT,
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
import type { ToolId, ToolSet, ToolStates } from "../tool-loop.js";

export const READY_TIMEOUT_MS = 4_000;
export const PRESENCE_POLL_MS = 150;
export const KEEPALIVE_MS = 45_000;

export const TOOL_BUTTONS: ReadonlyArray<{ readonly id: ToolId; readonly label: string }> = [
  { id: "select", label: "Select" },
  { id: "hand", label: "Hand" },
  { id: "note", label: "Note" },
  { id: "frame", label: "Frame" },
  { id: "text", label: "Text" },
  { id: "geo", label: "Shape" },
];

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

export function chromeToolStyle(active: boolean): CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: "none",
    background: active ? CHROME_ACCENT : "transparent",
    color: active ? CHROME_PAPER : CHROME_INK,
    font: CHROME_FONT,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

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

export function isEditableTarget(node: Node | null): boolean {
  if (!node || typeof (node as { tagName?: unknown }).tagName !== "string") return false;
  const element = node as HTMLElement;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
}

export function currentSnapResult(
  states: ToolStates,
  active: ToolId,
): SnapResult | undefined {
  if (active !== "select") return undefined;
  const composite = states.select as SelectAndTransformState;
  if (composite.active !== "select") return undefined;
  const select = composite.select as SelectState;
  if (select.mode !== "dragging") return undefined;
  return select.snapResult ?? undefined;
}
