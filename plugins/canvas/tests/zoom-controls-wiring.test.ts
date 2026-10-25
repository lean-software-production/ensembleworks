// Run: npx vitest run tests/zoom-controls-wiring.test.ts
//
// SOURCE-GUARD for the manual zoom controls' wiring into the plugin's stage.
// `session-view.tsx` is a .tsx and there is no jsdom here (see
// tests/page-presence.test.ts's header for the project-wide reason), so no
// behavioural test can mount it and watch a click. What CAN be pinned is that
// the panel calls the shared `ZoomControls` component with the props it needs
// to actually work, and wires its callback to a real `SetCamera` dispatch —
// the two ways this wiring could go silently inert while every other test in
// the suite stays green: dropping a prop (the controls render but do nothing,
// or zoom about the wrong point) or wiring `onSetCamera` to something that
// isn't a `SetCamera` intent (clicks render fine but never move the camera).
//
// Reads COMMENT-STRIPPED code for the reason tests/source-guard.test.ts
// documents: a guard satisfied by a file's own prose can stay green after the
// call it is meant to pin is deleted.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callArguments, countInCode, stripComments } from "./lib/source.js";

const SOURCE = readFileSync(
  new URL("../canvas/panel/session-view.tsx", import.meta.url),
  "utf8",
);
const CODE = stripComments(SOURCE);

/** The text of the single `<Tag ... />` self-closing element in `code`. */
function jsxElement(code: string, tag: string): string {
  const at = code.indexOf(`<${tag}`);
  expect(at, `no <${tag} element in session-view.tsx`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("/>", at);
  expect(end, `<${tag} is not self-closing`).toBeGreaterThan(at);
  return code.slice(at, end + 2);
}

describe("the plugin's stage mounts the shared manual zoom controls", () => {
  it("imports ZoomControls from the shared canvas-ui package", () => {
    expect(CODE).toContain("@ensembleworks/canvas-ui");
    const importLine = CODE.slice(0, CODE.indexOf("@ensembleworks/canvas-ui"));
    expect(importLine.slice(importLine.lastIndexOf("import"))).toContain("ZoomControls");
  });

  it("mounts exactly one <ZoomControls>, inside the stage", () => {
    // Two mounts (or none) both mean the same visible bug either way: the
    // reader sees zero or a doubled control on the running canvas.
    expect(countInCode(SOURCE, "<ZoomControls")).toBe(1);
    const stage = CODE.slice(CODE.indexOf("data-canvas-stage"));
    expect(stage.indexOf("<ZoomControls")).toBeGreaterThan(-1);
  });

  it("is docked bottom-right, after the tool rail in the stage's DOM order", () => {
    // The wrapping div carries the plugin's own placement style — without it
    // ZoomControls renders in-flow at the top of the stage instead of docked
    // to a corner, and it must come AFTER <CanvasChrome so it does not sit
    // beneath the rail in the same corner.
    expect(countInCode(SOURCE, "data-canvas-zoom-controls")).toBe(1);
    const stage = CODE.slice(CODE.indexOf("data-canvas-stage"));
    const chromeAt = stage.indexOf("<CanvasChrome");
    const zoomWrapperAt = stage.indexOf("data-canvas-zoom-controls");
    expect(chromeAt).toBeGreaterThan(-1);
    expect(zoomWrapperAt).toBeGreaterThan(chromeAt);
    // The wrapper's OPENING tag: back up to the nearest preceding `<div`
    // (the attribute lives inside that tag, not after it) and forward to
    // that tag's closing `>`.
    const divAt = stage.lastIndexOf("<div", zoomWrapperAt);
    expect(divAt).toBeGreaterThan(-1);
    const tagEnd = stage.indexOf(">", divAt);
    const wrapper = stage.slice(divAt, tagEnd + 1);
    expect(wrapper).toContain("style={chromeZoomStyle}");
  });

  it("passes the live camera and viewport size, not a stale snapshot", () => {
    // Without these, the controls render with a frozen camera/viewport and
    // either zoom about the wrong point or never reflect the real zoom level.
    const element = jsxElement(CODE, "ZoomControls");
    expect(element).toContain("camera={props.editorState.camera}");
    expect(element).toContain("viewportSize={props.viewportSize}");
  });

  it("wires onSetCamera to dispatch a real SetCamera intent", () => {
    // The failure this forbids: onSetCamera silently doing nothing, or
    // dispatching the wrong intent type — clicks would render fine (the
    // buttons work, the disabled state updates from the stale prop) while
    // never actually moving the camera, which every other guard here is
    // blind to.
    const element = jsxElement(CODE, "ZoomControls");
    expect(element).toContain("onSetCamera={(c) =>");
    expect(element).toContain("props.canvas.dispatch(");
    const args = callArguments(element, "props.canvas.dispatch");
    expect(args).toContain('type: "SetCamera"');
    expect(args).toContain("x: c.x");
    expect(args).toContain("y: c.y");
    expect(args).toContain("z: c.z");
  });
});
