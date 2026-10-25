// Run: npx vitest run tests/shape-text.test.ts
//
// Moved from tests/agents-view.test.ts (bb-thread-frame cleanup, 2026-09-15)
// along with `promptTextFor` itself — see canvas/shape-text.ts's header for
// why the function outlived the rest of that suite.
import { describe, expect, it } from "vitest";
import type { Shape } from "@ensembleworks/canvas-model";
import { promptTextFor } from "../canvas/shape-text.js";

/** A 200x200 note at world (x, y) — canvas-model's own default note size,
 * carried over from the original fixture even though this suite no longer
 * exercises geometry, so the props shape (`richText`) stays realistic. */
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
