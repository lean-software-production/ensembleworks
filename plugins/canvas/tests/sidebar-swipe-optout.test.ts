import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments, jsxAttributes } from "./lib/source.js";

// BB's mobile shell opens the left sidebar on a swipe unless the pointer
// started inside `[data-no-sidebar-swipe]` (checked with `closest`, so the
// panel root covers every descendant). A leftward canvas pan is that same
// gesture; losing the attribute would make every pan-left open the sidebar.
const SOURCE = stripComments(readFileSync(new URL("../canvas/panel/session-view.tsx", import.meta.url), "utf8"));

describe("session-view opts the canvas panel out of BB's sidebar swipe", () => {
  it("puts data-no-sidebar-swipe on the same root element as panelRef", () => {
    const attrs = jsxAttributes(SOURCE, "data-canvas-themed");
    expect(Object.keys(attrs)).toContain("data-no-sidebar-swipe");
    expect(Object.keys(attrs)).toContain("ref");
  });
});
