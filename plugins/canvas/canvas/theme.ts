import type { CSSProperties } from "react";
import type { CanvasDocument } from "@ensembleworks/canvas-model";

/** Resolve in CSS so changing BB appearance updates an already open canvas. */
export const canvasThemeStyle = {
  "--canvas-paper": "var(--background)",
  "--canvas-grid-dot": "color-mix(in srgb, var(--muted-foreground) 40%, transparent)",
  "--canvas-arrow": "var(--foreground)",
  "--canvas-handle": "var(--background)",
  "--canvas-handle-stroke": "var(--primary)",
  "--canvas-selection": "var(--primary)",
  "--canvas-selection-bounds": "var(--primary)",
  "--canvas-cursor-stroke": "var(--background)",
  color: "var(--foreground)",
  background: "var(--background)",
} as CSSProperties;

// Escape every code point: IDs are document data, never raw CSS selectors.
const cssId = (id: string) => Array.from(id, (c) => `\\${c.codePointAt(0)!.toString(16)} `).join("");
const neutral = (color: unknown) => color === undefined || color === "black";

/** Plugin-local presentation overrides; never rewrite shared document colours. */
export function canvasShapeThemeCss(doc: CanvasDocument): string {
  const scope = "[data-canvas-themed]";
  const rules = [
    `${scope} [data-shape-body="frame"]{background:var(--background)!important;border-color:var(--border)!important}`,
    `${scope} [data-shape-frame-header]{background:var(--card)!important;color:var(--foreground)!important;box-shadow:inset 0 0 0 1px var(--border)!important}`,
  ];
  for (const shape of doc.byId.values()) {
    const props = shape.props as Record<string, unknown>;
    const root = `${scope} [data-shape-id="${cssId(shape.id)}"]`;
    const editor = `${scope} [data-text-editor-input="${cssId(shape.id)}"]`;
    if (shape.kind === "line" && neutral(props.color)) {
      rules.push(`${root} svg [stroke]:not([stroke="none"]){stroke:var(--foreground)!important}`);
    }
    if (shape.kind === "draw" && neutral(props.color)) {
      rules.push(`${root} svg path{fill:var(--foreground)!important}`);
    }
    if (shape.kind === "text" && neutral(props.color)) {
      rules.push(`${root} [data-shape-body="text"],${editor}{color:var(--foreground)!important}`);
    }
    if (shape.kind === "geo") {
      if (neutral(props.color)) {
        rules.push(`${root} svg [stroke]:not([stroke="none"]){stroke:var(--foreground)!important}`);
        rules.push(`${root} svg [fill]:not([fill="none"]){fill:var(--muted)!important}`);
      }
      if (neutral(props.labelColor) && (neutral(props.color) || props.fill === "none" || props.fill === undefined)) {
        rules.push(`${root} [data-shape-geo-label],${editor}{color:var(--foreground)!important}`);
      }
    }
  }
  return rules.join("\n");
}
