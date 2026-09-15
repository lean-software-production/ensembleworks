// Run: npx vitest run tests/thread-frames.test.ts
//
// The pure half of `bb canvas thread-frames` (canvas/thread-frames.ts):
// which `bbthread` shapes are in the document, and what their direct
// children say.
import { describe, expect, it } from "vitest";
import { makeDocument, type Shape } from "@ensembleworks/canvas-model";
import { formatThreadFrames, threadFrameRows } from "../canvas/thread-frames.js";

function shape(partial: Partial<Shape> & { id: string; kind: string; parentId: string }): Shape {
  return {
    props: {},
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    ...partial,
  } as never;
}

function docWith(...shapes: Shape[]) {
  return makeDocument({
    pages: [{ id: "page:p", name: "P" }] as never,
    shapes,
    bindings: [],
  });
}

describe("threadFrameRows", () => {
  it("lists every bbthread shape, with its name and threadId", () => {
    const doc = docWith(
      shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p", props: { name: "Onboarding", threadId: "thr_1" } }),
    );
    expect(threadFrameRows(doc, () => "")).toEqual([
      { id: "shape:frame1", name: "Onboarding", threadId: "thr_1", children: [] },
    ]);
  });

  it("reports an unbound frame's threadId and a nameless frame's name as null", () => {
    const doc = docWith(shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p" }));
    expect(threadFrameRows(doc, () => "")).toEqual([
      { id: "shape:frame1", name: null, threadId: null, children: [] },
    ]);
  });

  it("ignores every other shape kind, including a plain frame", () => {
    const doc = docWith(
      shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p" }),
      shape({ id: "shape:frame2", kind: "frame", parentId: "page:p", props: { name: "Not a thread frame" } }),
      shape({ id: "shape:note1", kind: "note", parentId: "page:p" }),
    );
    expect(threadFrameRows(doc, () => "").map((row) => row.id)).toEqual(["shape:frame1"]);
  });

  it("lists a frame's DIRECT children only, with their live text", () => {
    const doc = docWith(
      shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p" }),
      shape({ id: "shape:note1", kind: "note", parentId: "shape:frame1" }),
      shape({ id: "shape:grandchild", kind: "note", parentId: "shape:note1" }),
    );
    const getText = (id: string) => (id === "shape:note1" ? "seed the prompt" : "");
    const [row] = threadFrameRows(doc, getText);
    expect(row!.children).toEqual([{ id: "shape:note1", kind: "note", text: "seed the prompt" }]);
  });

  it("falls back to a child's richText when it has no live text, and to null when it has neither", () => {
    const doc = docWith(
      shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p" }),
      shape({
        id: "shape:note1",
        kind: "note",
        parentId: "shape:frame1",
        props: {
          richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "from richText" }] }] },
        },
      }),
      shape({ id: "shape:note2", kind: "note", parentId: "shape:frame1" }),
    );
    const [row] = threadFrameRows(doc, () => "");
    expect(row!.children).toEqual([
      { id: "shape:note1", kind: "note", text: "from richText" },
      { id: "shape:note2", kind: "note", text: null },
    ]);
  });

  it("orders frames by id, independent of document order", () => {
    const doc = docWith(
      shape({ id: "shape:zzz", kind: "bbthread", parentId: "page:p" }),
      shape({ id: "shape:aaa", kind: "bbthread", parentId: "page:p" }),
    );
    expect(threadFrameRows(doc, () => "").map((row) => row.id)).toEqual(["shape:aaa", "shape:zzz"]);
  });
});

describe("formatThreadFrames", () => {
  it("says so when there are none", () => {
    expect(formatThreadFrames([])).toBe("No thread frames.");
  });

  it("renders one line per frame with its children indented beneath", () => {
    const doc = docWith(
      shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p", props: { name: "Onboarding", threadId: "thr_1" } }),
      shape({ id: "shape:note1", kind: "note", parentId: "shape:frame1" }),
    );
    const text = formatThreadFrames(threadFrameRows(doc, (id) => (id === "shape:note1" ? "hello" : "")));
    expect(text).toContain("Onboarding  [shape:frame1]  ->  thr_1");
    expect(text).toContain("note  shape:note1  \"hello\"");
  });

  it("marks an unbound frame and a childless frame plainly", () => {
    const doc = docWith(shape({ id: "shape:frame1", kind: "bbthread", parentId: "page:p" }));
    const text = formatThreadFrames(threadFrameRows(doc, () => ""));
    expect(text).toContain("shape:frame1  [shape:frame1]  ->  unbound");
    expect(text).toContain("(no children)");
  });
});
