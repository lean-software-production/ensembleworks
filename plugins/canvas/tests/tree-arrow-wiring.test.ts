// Run: npx vitest run tests/tree-arrow-wiring.test.ts
//
// TWO CALL SITES, AND NEITHER IS REACHABLE BY A TEST IN THIS PROJECT. There is
// no jsdom, so nothing here can mount the panel and look at what it drew; the
// most a test can honestly say is that the decision made in a tested module is
// the decision the component asks for (source-guard.test.ts's header sets out
// why that is a source-text assertion, and why it must read CODE rather than
// prose).
//
// The two mutations these forbid are the ones that leave the whole node
// looking done:
//   - drop `registerTreeArrowShape()` from the boot path: every arrow silently
//     gets its BoxShape fallback back, and the tests in tree-edge-view.test.ts
//     still pass, because they call the registration themselves;
//   - drop `currentPageId` from the marker layer's props (or hand it something
//     else): quarantine markers are drawn for edges on pages nobody is looking
//     at, at world coordinates that mean nothing on the page on screen — the
//     exact bug the agent badges had (agents-view.ts's currentPageId note).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "./lib/source.js";

const BOOT = readFileSync(
  new URL("../canvas/panel/connection-boot.ts", import.meta.url),
  "utf8",
);
const VIEW = readFileSync(
  new URL("../canvas/panel/session-view.tsx", import.meta.url),
  "utf8",
);

describe("the arrow body is registered where the core bodies are", () => {
  it("boot calls registerTreeArrowShape, in code and not in a comment", () => {
    const code = stripComments(BOOT);
    expect(code).toContain("registerTreeArrowShape()");
    // Next to the call it belongs with: a registration that runs before the
    // session exists is a registration nothing renders against.
    expect(code).toContain("registerCoreShapes()");
  });
});

describe("the quarantine marker layer is mounted with the page it must filter by", () => {
  // WHY NOT jsxAttributes: four elements in this file take a `currentPageId`
  // (Cursors, AgentLayer, SpeakerRings and this one), and that helper is keyed
  // by attribute name, so it cannot pick this mount out. What is left is the
  // element's own text, read out of COMMENT-STRIPPED source — enough to fail
  // on a dropped or re-pointed prop, not enough to prove there is no second
  // rival mount elsewhere. Stated rather than implied.
  const code = stripComments(VIEW);
  const mount = code.slice(code.indexOf("<QuarantinedEdges"));

  it("paints later than canvas-react's Overlay, so the marker lands on top", () => {
    expect(code.indexOf("<QuarantinedEdges")).toBeGreaterThan(code.indexOf("<Overlay"));
    expect(code.indexOf("<QuarantinedEdges")).toBeGreaterThan(0);
  });

  it("is handed the live snapshot, camera, viewport and current page", () => {
    const element = mount.slice(0, mount.indexOf("/>"));
    expect(element).toContain("snapshot={snapshot}");
    expect(element).toContain("camera={editorState.camera}");
    expect(element).toContain("viewportSize={viewportSize}");
    expect(element).toContain("currentPageId={editorState.currentPageId}");
  });
});
