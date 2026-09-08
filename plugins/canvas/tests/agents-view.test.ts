// Run: npx vitest run   (or `npm test`)
//
// The two decisions behind the agent overlay that are worth pinning down
// without a browser: where a badge lands, and what a note's prompt is.
import { describe, expect, it } from "vitest";
import { makeDocument, type Shape } from "@ensembleworks/canvas-model";
import {
  BADGE_RADIUS_PX,
  badgeAnchorVisible,
  promptTextFor,
  screenBoxFor,
} from "../canvas/agents-view.js";

const VIEWPORT = { width: 1000, height: 800 };

/** A 200x200 note at world (x, y) — canvas-model's own default note size, so
 * these boxes are the real ones the renderer draws. */
function noteAt(id: string, x: number, y: number, props: object = {}): Shape {
  return {
    id,
    kind: "note",
    parentId: "page:p",
    props,
    index: "a1",
    x,
    y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
  } as never;
}

function docWith(...shapes: Shape[]) {
  return makeDocument({
    pages: [
      { id: "page:p", name: "P" },
      { id: "page:q", name: "Q" },
    ] as never,
    shapes,
    bindings: [],
  });
}

/** The same note, parented to the OTHER page. */
function noteOnQ(id: string, x: number, y: number): Shape {
  return { ...(noteAt(id, x, y) as object), parentId: "page:q" } as never;
}

describe("screenBoxFor", () => {
  it("projects a shape's world box through the camera", () => {
    const doc = docWith(noteAt("shape:a", 100, 50));
    // input.ts's camera convention: screen = (world + camera.xy) * z
    expect(
      screenBoxFor(doc, { x: 0, y: 0, z: 1 }, VIEWPORT, "shape:a", "page:p"),
    ).toEqual({ left: 100, top: 50, right: 300, bottom: 250 });
    // Pan: the box moves with the camera, so a badge tracks its note.
    expect(
      screenBoxFor(doc, { x: -50, y: -25, z: 1 }, VIEWPORT, "shape:a", "page:p"),
    ).toEqual({ left: 50, top: 25, right: 250, bottom: 225 });
    // Zoom: it shrinks about the origin, so a badge stays on the corner.
    expect(
      screenBoxFor(doc, { x: 0, y: 0, z: 0.5 }, VIEWPORT, "shape:a", "page:p"),
    ).toEqual({ left: 50, top: 25, right: 150, bottom: 125 });
  });

  it("has nothing to place for a shape that is not in the document", () => {
    // A note deleted while its kv link survives: the link is stale, and the
    // overlay's answer is to draw nothing rather than to guess a position.
    expect(
      screenBoxFor(docWith(), { x: 0, y: 0, z: 1 }, VIEWPORT, "shape:gone", "page:p"),
    ).toBeNull();
  });

  it("culls a shape that is far off-viewport but keeps a near one", () => {
    const doc = docWith(
      noteAt("shape:far", 9_000, 0),
      noteAt("shape:near", 1_050, 0), // just past the right edge, inside the margin
    );
    const camera = { x: 0, y: 0, z: 1 };
    expect(screenBoxFor(doc, camera, VIEWPORT, "shape:far", "page:p")).toBeNull();
    expect(screenBoxFor(doc, camera, VIEWPORT, "shape:near", "page:p")).not.toBeNull();
  });
});

describe("screenBoxFor is scoped to the page being looked at", () => {
  // OWNER REPORT, 2026-09-08: "if you switch tabs you can still see the dot
  // (even though you can't see the note it is attached to)". A link is keyed by
  // shape id alone and every page's shapes live in ONE document, so an overlay
  // that only asks "is this shape in the doc?" keeps drawing a badge for a note
  // on a page nobody is looking at — at that note's world coordinates, which
  // are unrelated to anything on screen.
  //
  // The rule is canvas-react's `isOnOtherPage` one arrived at again: the shape
  // layer already filters by `pageIdOf`, so the chrome anchored to it must ask
  // the same question of the same document.
  it("places a shape on the current page", () => {
    const doc = docWith(noteAt("shape:a", 100, 50));
    expect(screenBoxFor(doc, { x: 0, y: 0, z: 1 }, VIEWPORT, "shape:a", "page:p")).toEqual({
      left: 100,
      top: 50,
      right: 300,
      bottom: 250,
    });
  });

  it("places nothing for the SAME shape once the current page moves on", () => {
    const doc = docWith(noteAt("shape:a", 100, 50));
    expect(
      screenBoxFor(doc, { x: 0, y: 0, z: 1 }, VIEWPORT, "shape:a", "page:q"),
    ).toBeNull();
  });

  it("places nothing for a shape that lives on another page", () => {
    const doc = docWith(noteOnQ("shape:b", 100, 50));
    expect(
      screenBoxFor(doc, { x: 0, y: 0, z: 1 }, VIEWPORT, "shape:b", "page:p"),
    ).toBeNull();
  });
});

describe("badgeAnchorVisible — the dot may not paint outside the canvas", () => {
  // OWNER REPORT, same message: "The thread attachment dot floats above the
  // canvas tabs." The badge is pinned to its note's top-right corner and
  // `translate(-50%, -50%)`d onto it, so it straddles that corner by its own
  // radius — and the `data-canvas-viewport` box it lives in has NO overflow
  // clip, so a corner near the top edge draws the dot over the page tab strip
  // that sits above it in the column. `CULL_MARGIN` cannot help: it is 200px of
  // deliberate slack in the other direction.
  //
  // WHY CULL AND NOT CLAMP. A clamped dot slides along the edge still claiming
  // to mark a corner that is no longer there, which is a worse lie than no dot.
  const box = (right: number, top: number) => ({ left: right - 200, top, right, bottom: top + 200 });

  it("draws a dot whose whole circle is inside the viewport", () => {
    expect(badgeAnchorVisible(box(500, 400), VIEWPORT)).toBe(true);
    // Exactly its own radius in from each edge is still wholly inside.
    expect(badgeAnchorVisible(box(BADGE_RADIUS_PX, BADGE_RADIUS_PX), VIEWPORT)).toBe(true);
    expect(
      badgeAnchorVisible(
        box(VIEWPORT.width - BADGE_RADIUS_PX, VIEWPORT.height - BADGE_RADIUS_PX),
        VIEWPORT,
      ),
    ).toBe(true);
  });

  it("drops the dot one pixel before it would cross the top edge", () => {
    // THE REPORTED BUG, at the boundary: above this line the circle overhangs
    // the viewport and lands on the tab strip.
    expect(badgeAnchorVisible(box(500, BADGE_RADIUS_PX - 1), VIEWPORT)).toBe(false);
    expect(badgeAnchorVisible(box(500, -180), VIEWPORT)).toBe(false);
  });

  it("drops it at the other three edges too", () => {
    // The bottom edge has the floating toolbar under it and the sides have
    // bb's own panel chrome; the tab strip is not a special case.
    expect(badgeAnchorVisible(box(500, VIEWPORT.height - BADGE_RADIUS_PX + 1), VIEWPORT)).toBe(false);
    expect(badgeAnchorVisible(box(BADGE_RADIUS_PX - 1, 400), VIEWPORT)).toBe(false);
    expect(badgeAnchorVisible(box(VIEWPORT.width - BADGE_RADIUS_PX + 1, 400), VIEWPORT)).toBe(false);
  });
});

describe("promptTextFor", () => {
  const shape = noteAt("shape:a", 0, 0, {
    richText: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "from richText" }] }],
    },
  });

  it("prefers the live document text — what the user actually typed", () => {
    expect(promptTextFor(shape, "  typed just now  ")).toBe("typed just now");
  });

  it("falls back to flattening richText when there is no live text", () => {
    expect(promptTextFor(shape, "   ")).toBe("from richText");
  });

  it("is empty when the note carries no text at all", () => {
    expect(promptTextFor(noteAt("shape:b", 0, 0), "")).toBe("");
    expect(promptTextFor(undefined, "")).toBe("");
  });
});
