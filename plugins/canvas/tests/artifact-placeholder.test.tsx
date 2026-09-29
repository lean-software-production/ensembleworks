// ux-contract: none — placeholder only, no interaction surface
//
// Canvas artifact viewer, stage 1a. This release can READ an `artifact` shape
// (so it never repairs one away) but cannot show it yet, so the body is an
// inert placeholder. It must stay inert: no control, no link, nothing that
// turns a shape prop into something the browser would follow — the props
// select a file on disk, and only a later stage's viewer may act on them.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShapeBodyProps } from "@ensembleworks/canvas-react";
import * as placeholder from "../canvas/shapes/ArtifactPlaceholderShape.js";

const props = {
  w: 720,
  h: 540,
  schemaVersion: 1,
  source: "thread-storage",
  threadId: "thr_fixture01",
  path: "reports/deck/index.html",
  title: "Launch deck",
};

function render(): string {
  const Placeholder = (placeholder as Record<string, unknown>).ArtifactPlaceholderShape as
    | ((p: ShapeBodyProps) => unknown)
    | undefined;
  expect(Placeholder).toBeTypeOf("function");
  const body = {
    shape: {
      id: "shape:art",
      kind: "artifact",
      parentId: "page:p",
      props,
      index: "a1",
      x: 0,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
    },
    snapshot: { pages: [], shapes: [], bindings: [], assets: [] },
    editorState: {},
    getText: () => "",
  } as unknown as ShapeBodyProps;
  return renderToStaticMarkup(createElement(Placeholder as never, body));
}

describe("ArtifactPlaceholderShape", () => {
  it("says what it is and how to see it, and nothing else", () => {
    const html = render();
    expect(html).toContain('data-shape-body="artifact-placeholder"');
    expect(html).toContain(">Artifact · update the Canvas plugin to view</");
  });

  it("fills its box like the core fallback body", () => {
    const html = render();
    expect(html).toContain("width:100%");
    expect(html).toContain("height:100%");
  });

  it("has no interactive surface at all", () => {
    const html = render();
    for (const tag of ["<button", "<a ", "<a>", "<input", "<iframe", "<textarea", "<select", "<form"]) {
      expect(html).not.toContain(tag);
    }
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("data-canvas-interactive");
    expect(html).not.toContain("href");
    expect(html).not.toContain("src=");
  });

  it("never renders the artifact's props", () => {
    const html = render();
    for (const value of [props.threadId, props.path, props.title, "thread-storage"]) {
      expect(html).not.toContain(value);
    }
  });
});
