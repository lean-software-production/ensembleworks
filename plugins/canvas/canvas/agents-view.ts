// The pure half of the agent overlay: where a badge goes, and what a note's
// prompt is. DOM-free and React-free on purpose — the same split
// `transport.ts` and `tool-loop.ts` already use, so the two decisions most
// worth getting right are testable without a browser and `agents-ui.tsx`
// stays a thin adapter.
import { worldToScreen, type Camera } from "@ensembleworks/canvas-editor";
import {
  pageIdOf,
  worldBounds,
  type CanvasDocument,
  type Shape,
} from "@ensembleworks/canvas-model";
import type { ViewportSize } from "@ensembleworks/canvas-react";
import { shapeText } from "./shape-text.js";

/** How far outside the viewport a shape may sit before its chrome is dropped
 * entirely. A little slack so a badge anchored just past the edge of a shape
 * that is itself barely on screen does not flicker at the boundary. */
export const CULL_MARGIN = 200;

/** A shape's world AABB projected into viewport-relative screen pixels. */
export interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The radius of the status dot, in screen pixels.
 *
 * TRANSCRIBED FROM THE COMPONENT, not chosen here: `agents-ui.tsx` draws the
 * badge with Tailwind's `size-5` (20px) and `translate(-50%, -50%)`s it onto
 * the anchor, so the circle straddles that point by half its width in every
 * direction. Two numbers that must agree and only one of them can be read by a
 * test — this is the readable one, and `badgeAnchorVisible` is the only thing
 * that depends on it.
 */
export const BADGE_RADIUS_PX = 10;

/**
 * Whether the badge pinned to this box's top-right corner lands wholly inside
 * the drawing surface.
 *
 * OWNER REPORT, 2026-09-08: "The thread attachment dot floats above the canvas
 * tabs." It does, and nothing was stopping it: the badge is an absolutely
 * positioned child of the `data-canvas-viewport` box, that box has no overflow
 * clip, and `CULL_MARGIN` below is 200px of slack in the OPPOSITE direction —
 * it deliberately keeps chrome alive for a shape already off-screen. A note
 * whose top-right corner sits within 10px of the top edge therefore paints its
 * dot over the page tab strip in the row above.
 *
 * CULL RATHER THAN CLAMP. A dot slid along the edge would still claim to mark
 * a corner that is no longer there, which is a worse lie than no dot at all.
 *
 * NOT OBSERVED IN A BROWSER — there is none in this spike. This is the CSS
 * semantics of `position: absolute` inside a box with the default
 * `overflow: visible`, applied to the structure `agents-ui.tsx` renders.
 */
export function badgeAnchorVisible(
  box: ScreenBox,
  viewportSize: ViewportSize,
): boolean {
  // The anchor is the corner itself: `left: box.right, top: box.top`.
  return (
    box.right >= BADGE_RADIUS_PX &&
    box.right <= viewportSize.width - BADGE_RADIUS_PX &&
    box.top >= BADGE_RADIUS_PX &&
    box.top <= viewportSize.height - BADGE_RADIUS_PX
  );
}

/**
 * Where a shape is on screen, or null when it is not in the document (a note
 * deleted while its link survives), is on a page nobody is looking at, or is
 * far enough off-viewport not to be worth a DOM node.
 *
 * This is the whole reason a badge tracks its note through pan, zoom, drag and
 * remote edits without subscribing to anything of its own: it is a pure
 * function of the same `snapshot` and `camera` the shapes themselves render
 * from, so it re-derives on exactly the renders they do.
 *
 * `currentPageId` IS REQUIRED, not optional. Every page's shapes live in ONE
 * document, so a link keyed by shape id alone survives a page switch and keeps
 * drawing its badge at world coordinates that mean nothing on the page now on
 * screen — the owner's 2026-09-08 report. Optional would have let a call site
 * silently opt out of the filter, which is exactly how the same bug reached
 * <Cursors> (see CanvasPanel.tsx's note on D-4's reading half): "no page" is
 * not the same as "not page-aware". `pageIdOf` is the same question
 * canvas-react's ShapeLayer asks of the same document to decide what to draw.
 */
export function screenBoxFor(
  doc: CanvasDocument,
  camera: Camera,
  viewportSize: ViewportSize,
  shapeId: string,
  currentPageId: string,
): ScreenBox | null {
  const shape = doc.byId.get(shapeId);
  if (shape === undefined) return null;
  if (pageIdOf(doc, shape) !== currentPageId) return null;
  const bounds = worldBounds(doc, shape);
  const topLeft = worldToScreen(camera, { x: bounds.minX, y: bounds.minY });
  const bottomRight = worldToScreen(camera, { x: bounds.maxX, y: bounds.maxY });
  const box: ScreenBox = {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
  };
  if (box.right < -CULL_MARGIN || box.left > viewportSize.width + CULL_MARGIN) {
    return null;
  }
  if (box.bottom < -CULL_MARGIN || box.top > viewportSize.height + CULL_MARGIN) {
    return null;
  }
  return box;
}

/**
 * The prompt a note carries: live document text first — what the plain-text
 * editor writes, and therefore what the user actually typed — falling back to
 * its `richText`, which is how imported and fixture shapes carry their text.
 *
 * BOTH THE RULE AND THE EXTRACTION ARE NOW BORROWED, not restated. This
 * function used to decide the precedence itself and carry its own five-line
 * richText flattener; W15 needed the same precedence for a tree node's title
 * and found that a SECOND copy of it is how the two drift (the tree read spine
 * read `richText` only, and reported `(untitled)` for text a human had typed —
 * W14's F1). `canvas/shape-text.ts` is the one rule, over canvas-model's own
 * `plainText`; all this adds is the trim a prompt wants.
 */
export function promptTextFor(shape: Shape | undefined, live: string): string {
  return shapeText(shape, live).trim();
}
