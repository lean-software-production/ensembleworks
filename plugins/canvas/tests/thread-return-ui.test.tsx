// ux-contract: none — BB's host threadHeaderAction slot is outside the shared
// canvas FSM/browser contract runners; these component render assertions cover
// the slot's visibility decision directly.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasReturnControl } from "../canvas/thread-return-ui.js";
import type { ReturnBookmark } from "../canvas/thread-return.js";

const bookmark: ReturnBookmark = {
  token: "return-token",
  threadId: "thread:opened-from-canvas",
  pageId: "page:roadmap",
  pageName: "Roadmap",
  camera: { x: 10, y: 20, z: 1 },
  selection: ["shape:thread-frame"],
};

function render(connected: boolean, bookmarks: readonly ReturnBookmark[] = []): string {
  return renderToStaticMarkup(createElement(CanvasReturnControl, {
    threadId: "thread:opened-from-canvas",
    isCompactViewport: false,
    connected,
    bookmarks,
    toCanvas: () => {},
  }));
}

describe("CanvasReturnAction", () => {
  it("renders nothing when no canvas frame is connected to the thread", () => {
    expect(render(false)).toBe("");
    expect(render(false, [bookmark])).toBe("");
  });

  it("renders an exact return when the connected thread was opened from Canvas", () => {
    const html = render(true, [bookmark]);
    expect(html).toContain('data-canvas-return="thread:opened-from-canvas"');
    expect(html).toContain("Back to canvas");
  });

  it("renders a generic Canvas link for a connected thread opened elsewhere", () => {
    const html = render(true);
    expect(html).toContain('aria-label="Open canvas"');
    expect(html).toContain(">Canvas</button>");
  });
});
