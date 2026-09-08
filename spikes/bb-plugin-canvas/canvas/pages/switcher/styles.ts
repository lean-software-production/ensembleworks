import type { CSSProperties } from "react";
import {
  CHROME_ACCENT,
  CHROME_FAINT,
  CHROME_FIELD,
  CHROME_FONT,
  CHROME_HAIRLINE,
  CHROME_INK,
  CHROME_MUTED,
  CHROME_PAPER,
  CHROME_POPOVER_SHADOW,
  CHROME_RECESS,
} from "../chrome-dock.js";
import { POPOVER_Z_INDEX } from "../../dock/popover-place.js";
import { TAB_DROP_LINE_PAINT } from "../tab-drag.js";

export const buttonStyle: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 6,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: "transparent",
  color: CHROME_INK,
  font: CHROME_FONT,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const popoverStyle: CSSProperties = {
  position: "fixed",
  zIndex: POPOVER_Z_INDEX,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  width: "min(320px, 80vw)",
  maxHeight: "min(60vh, 420px)",
  overflowY: "auto",
  padding: 6,
  borderRadius: 8,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
  boxShadow: CHROME_POPOVER_SHADOW,
};

export const filterStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "4px 6px",
  borderRadius: 4,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_FIELD,
  color: CHROME_INK,
  font: CHROME_FONT,
};

export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
};
export const emptyStyle: CSSProperties = {
  padding: "6px 8px",
  color: CHROME_MUTED,
  font: CHROME_FONT,
};

export function nameButtonStyle(current: boolean): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    textAlign: "left",
    padding: "4px 8px",
    borderRadius: 4,
    border: "none",
    background: current ? CHROME_ACCENT : "transparent",
    color: current ? CHROME_PAPER : CHROME_INK,
    font: CHROME_FONT,
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  };
}

export function microButtonStyle(enabled: boolean): CSSProperties {
  return {
    padding: "4px 6px",
    border: "none",
    background: "transparent",
    color: enabled ? CHROME_INK : CHROME_MUTED,
    font: CHROME_FONT,
    lineHeight: 1,
    cursor: enabled ? "pointer" : "default",
  };
}

export const tabBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 2,
  padding: "0 4px",
  overflowX: "auto",
  flexShrink: 0,
  marginBottom: -1,
  position: "relative",
};

export function pageTabStyle(current: boolean): CSSProperties {
  return {
    padding: current ? "5px 12px 6px" : "6px 12px 5px",
    borderStyle: "solid",
    borderWidth: "1px 1px 0",
    borderColor: current ? CHROME_HAIRLINE : CHROME_FAINT,
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    background: current ? CHROME_PAPER : CHROME_RECESS,
    color: CHROME_INK,
    fontWeight: current ? 600 : 400,
    font: CHROME_FONT,
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

export const dropLineStyle: CSSProperties = {
  ...TAB_DROP_LINE_PAINT,
  borderRadius: 1,
  background: CHROME_ACCENT,
};

export const newTabStyle: CSSProperties = {
  padding: "4px 8px",
  border: "none",
  background: "transparent",
  color: CHROME_INK,
  font: CHROME_FONT,
  lineHeight: 1,
  cursor: "pointer",
  alignSelf: "center",
};

export const tabMenuStyle: CSSProperties = {
  position: "fixed",
  zIndex: POPOVER_Z_INDEX,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 140,
  padding: 4,
  borderRadius: 8,
  border: `1px solid ${CHROME_HAIRLINE}`,
  background: CHROME_PAPER,
  color: CHROME_INK,
  font: CHROME_FONT,
  boxShadow: CHROME_POPOVER_SHADOW,
};

export function tabMenuItemStyle(enabled: boolean): CSSProperties {
  return {
    textAlign: "left",
    padding: "5px 10px",
    borderRadius: 4,
    border: "none",
    background: "transparent",
    color: enabled ? CHROME_INK : CHROME_MUTED,
    font: CHROME_FONT,
    cursor: enabled ? "pointer" : "default",
    whiteSpace: "nowrap",
  };
};
