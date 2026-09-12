// The quarantine marker layer: a red dashed overstroke and a word, on every
// edge that has been taken OUT of a tree but is still drawn on the canvas.
//
// THIN ON PURPOSE. Every decision — which edges, where their ink is, what the
// marker says — is `canvas/tree/edge-view.ts`, which is DOM-free and therefore
// testable in a project with no jsdom (the split `agents-view.ts`/
// `agents-ui.tsx` already make, for the same reason). This file only turns
// that answer into SVG.
//
// WHERE IT SITS. A later sibling of canvas-react's `<Overlay>` inside the same
// `<Viewport>`, so it paints ON TOP of the routed arrow the Overlay drew (no
// z-index — Viewport's documented stacking contract, the same one
// `agents-ui.tsx` relies on) and under the collaborator cursors. Like every
// other paint layer here it is `pointer-events: none`: it marks the canvas, it
// never takes a gesture away from it.
//
// THE LABEL HAS NO CHIP. A rounded background rect would need a measured text
// width, and there is no DOM here to measure with — an estimate from the
// string length is the kind of number that reads fine in one theme and clips
// in another. `paint-order: stroke` draws the paper-coloured stroke UNDER the
// glyphs instead, which is a halo of exactly the right size by construction.
import type { Camera } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import {
  QUARANTINE_STROKE,
  QUARANTINE_STROKE_DASHARRAY,
  QUARANTINE_STROKE_WIDTH,
  quarantinedEdgeViews,
} from "../tree/edge-view.js";

export interface QuarantinedEdgesProps {
  readonly snapshot: CanvasDocument;
  readonly camera: Camera;
  readonly viewportSize: ViewportSize;
  readonly currentPageId: string;
}

const LABEL_FONT_PX = 11;
/** The halo behind the label. Not "the page background" — this plugin is not
 * allowed to know bb's theme (dock/styles.ts's note) — but the canvas paper
 * variable the panel itself sets, with the same literal fallback. */
const LABEL_HALO = "var(--canvas-paper, #fafaf7)";
/** Enough to lift the word off the line it annotates. */
const LABEL_OFFSET_PX = 6;

export function QuarantinedEdges({ snapshot, camera, viewportSize, currentPageId }: QuarantinedEdgesProps) {
  const views = quarantinedEdgeViews(snapshot, camera, viewportSize, currentPageId);
  if (views.length === 0) return null;
  return (
    <svg
      data-canvas-layer="tree-quarantine"
      width={viewportSize.width}
      height={viewportSize.height}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
    >
      {views.map((view) => (
        <g key={view.edgeId} data-quarantined-edge={view.edgeId}>
          <path
            d={view.path}
            fill="none"
            stroke={QUARANTINE_STROKE}
            strokeWidth={QUARANTINE_STROKE_WIDTH}
            strokeDasharray={QUARANTINE_STROKE_DASHARRAY}
          />
          <text
            x={view.labelAt.x}
            y={view.labelAt.y - LABEL_OFFSET_PX}
            textAnchor="middle"
            fontSize={LABEL_FONT_PX}
            fill={QUARANTINE_STROKE}
            stroke={LABEL_HALO}
            strokeWidth={3}
            paintOrder="stroke"
          >
            {view.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
