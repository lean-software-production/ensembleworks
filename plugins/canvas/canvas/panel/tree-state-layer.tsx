// W18's state marks, as chrome over the canvas: what each node's state is, and
// whether anyone has looked at it, readable WITHOUT selecting anything.
//
// SAME POSTURE AS `AgentLayer` AND `TreeGestureLayer`, and it is the same
// three sentences every time because the contract has not changed: an
// absolutely-positioned div over the drawing surface, `pointer-events: none`
// throughout (this layer has no controls at all — the inspector holds the
// edits), a later DOM sibling than <Viewport>, everything anchored by
// `screenBoxFor` so it tracks pan, zoom, drag and remote edits without
// subscribing to anything of its own.
//
// TOP-LEFT OF THE NODE, which is the last free corner: the agent badge sits
// top-right (agents-ui.tsx) and W4's gesture buttons hang off the bottom-left.
// A mark that covered either would hide something a human put there.
//
// THIN. Which nodes are marked, what each mark says and where it goes are all
// canvas/tree/node-view.ts, tested without a DOM.
import type { Camera } from "@ensembleworks/canvas-editor";
import type { CanvasDocument } from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { APPROACHED_LABEL, MARK_OFFSET_PX, nodeStateMarks } from "../tree/node-view.js";
import { CHROME_FAINT, CHROME_FONT, CHROME_INK, CHROME_PAPER } from "../pages/chrome-dock.js";

export interface TreeStateLayerProps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly viewportSize: ViewportSize;
  readonly currentPageId: string;
}

export function TreeStateLayer({ doc, camera, viewportSize, currentPageId }: TreeStateLayerProps) {
  const marks = nodeStateMarks(doc, camera, viewportSize, currentPageId);
  if (marks.length === 0) return null;
  return (
    <div
      data-canvas-layer="tree-state"
      className="absolute inset-0"
      // CLIPPED TO THE DRAWING SURFACE. A mark is placed from `screenBoxFor`,
      // whose cull keeps a node whose box merely INTERSECTS the viewport — so
      // a chip near the right edge can land beyond it, and this layer's box is
      // the viewport, not the panel. Without this the chip painted over the
      // inspector column (seen in the browser, 2026-09-10). `overflow: hidden`
      // is the honest fix: the chip belongs to the canvas, so it stops where
      // the canvas does.
      style={{ pointerEvents: "none", overflow: "hidden" }}
    >
      {marks.map((mark) => (
        <div
          key={mark.nodeId}
          data-tree-state={mark.nodeId}
          data-tree-state-label={mark.label}
          data-tree-approached={mark.approached ? "yes" : "no"}
          style={{
            position: "absolute",
            left: mark.left,
            // Sits ABOVE the node's top edge: a note's own text starts at its
            // top-left corner, and a chip over it would cover the title this
            // feature spent W15 making visible.
            top: mark.top - MARK_OFFSET_PX,
            transform: "translateY(-100%)",
            display: "flex",
            gap: 4,
            alignItems: "center",
            font: CHROME_FONT,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              padding: "1px 6px",
              borderRadius: 999,
              border: `1px solid ${mark.ink}`,
              background: CHROME_PAPER,
              color: mark.ink,
            }}
          >
            {mark.label}
          </span>
          {/* A second chip, not a tint on the first: `approached` is a
              separate axis (an approached node can still be todo), and a
              blended colour would say "a fourth state". */}
          {mark.approached ? (
            <span
              style={{
                padding: "1px 6px",
                borderRadius: 999,
                background: CHROME_FAINT,
                color: CHROME_INK,
              }}
            >
              {APPROACHED_LABEL}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
