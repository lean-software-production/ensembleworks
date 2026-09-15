// Run: npx vitest run tests/bbthread-model.test.ts
//
// The `bbthread` shape body's pure decisions (canvas/shapes/bbthread-model.ts)
// — see that file's own header and docs/plans/2026-09-15-bb-thread-frame.md.
import { describe, expect, it } from "vitest";
import type { Shape } from "@ensembleworks/canvas-model";
import {
  bbthreadPaneState,
  paneLayout,
  reduceInteractionMode,
  shouldSwallowEvents,
  spawnPromptFor,
  threadIdOf,
  toneFor,
  type SidebarThreadLike,
} from "../canvas/shapes/bbthread-model.js";

function bbthread(props: Record<string, unknown> = {}, size: { w?: number; h?: number } = {}): Shape {
  return {
    id: "shape:frame1",
    kind: "bbthread",
    parentId: "page:p",
    props: { w: size.w ?? 960, h: size.h ?? 600, ...props },
    index: "a1",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
  } as never;
}

function noteAt(id: string, x: number, y: number, props: Record<string, unknown> = {}): Shape {
  return {
    id,
    kind: "note",
    parentId: "shape:frame1",
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

const ZERO_ACTIVITY = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };

function thread(overrides: Partial<SidebarThreadLike> = {}): SidebarThreadLike {
  return {
    id: "thr_1",
    title: "Fix the retry loop",
    titleFallback: null,
    indicator: "none",
    indicatorLabel: null,
    isArchived: false,
    hasPendingInteraction: false,
    activity: ZERO_ACTIVITY,
    ...overrides,
  };
}

describe("threadIdOf", () => {
  it("is null when there is no threadId prop", () => {
    expect(threadIdOf(bbthread())).toBeNull();
  });

  it("treats an empty (or whitespace) threadId as unbound — the UpdateProps-can't-delete workaround", () => {
    expect(threadIdOf(bbthread({ threadId: "" }))).toBeNull();
    expect(threadIdOf(bbthread({ threadId: "   " }))).toBeNull();
  });

  it("is the trimmed threadId when set", () => {
    expect(threadIdOf(bbthread({ threadId: "thr_1" }))).toBe("thr_1");
  });
});

describe("bbthreadPaneState", () => {
  it("is unbound with no threadId", () => {
    expect(bbthreadPaneState(bbthread(), undefined, "ready")).toEqual({ kind: "unbound" });
  });

  it("is loading while the sidebar list is still loading, even with a threadId set", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), undefined, "loading")).toEqual({ kind: "loading" });
  });

  it("is loading (not gone) on a sidebar error — not resolved, not disproven", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), undefined, "error")).toEqual({ kind: "loading" });
  });

  it("is gone when ready but no row matches the bound threadId", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), undefined, "ready")).toEqual({ kind: "gone" });
  });

  it("is gone when the matching row is archived", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), thread({ isArchived: true }), "ready")).toEqual({ kind: "gone" });
  });

  it("is bound with a title/statusLabel/tone when ready and the row is live", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), thread(), "ready")).toEqual({
      kind: "bound",
      title: "Fix the retry loop",
      statusLabel: "Idle",
      tone: "idle",
      isArchived: false,
    });
  });

  it("falls back title through titleFallback, then the thread id", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), thread({ title: null, titleFallback: "Untitled draft" }), "ready")).toMatchObject({
      title: "Untitled draft",
    });
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), thread({ title: null, titleFallback: null }), "ready")).toMatchObject({
      title: "thr_1",
    });
  });

  it("prefers the host's own indicatorLabel over the generic tone label", () => {
    expect(bbthreadPaneState(bbthread({ threadId: "thr_1" }), thread({ indicatorLabel: "Waiting on a review" }), "ready")).toMatchObject({
      statusLabel: "Waiting on a review",
    });
  });
});

describe("toneFor", () => {
  it("is attention when the host flags a pending interaction", () => {
    expect(toneFor(thread({ hasPendingInteraction: true }))).toBe("attention");
  });

  it("is attention on a waiting-for-input indicator, even with no pending flag", () => {
    expect(toneFor(thread({ indicator: "waiting-for-input" }))).toBe("attention");
  });

  it("is failed on an unread-error indicator", () => {
    expect(toneFor(thread({ indicator: "unread-error" }))).toBe("failed");
  });

  it("is working when any activity counter is nonzero", () => {
    expect(toneFor(thread({ activity: { ...ZERO_ACTIVITY, backgroundAgents: 1 } }))).toBe("working");
  });

  it("is working on a running-work indicator even with zero activity counters", () => {
    expect(toneFor(thread({ indicator: "runtime" }))).toBe("working");
  });

  it("is idle otherwise", () => {
    expect(toneFor(thread())).toBe("idle");
  });
});

describe("spawnPromptFor", () => {
  it("is null when there are no children", () => {
    expect(spawnPromptFor([], () => "")).toBeNull();
  });

  it("is null when every child is blank", () => {
    expect(spawnPromptFor([noteAt("a", 0, 0), noteAt("b", 0, 40)], () => "   ")).toBeNull();
  });

  it("joins non-blank children top-to-bottom, then left-to-right", () => {
    const bottom = noteAt("bottom", 0, 200);
    const topRight = noteAt("top-right", 100, 0);
    const topLeft = noteAt("top-left", 0, 0);
    const prompt = spawnPromptFor([bottom, topRight, topLeft], (id) => `text:${id}`);
    expect(prompt).toBe("text:top-left\n\ntext:top-right\n\ntext:bottom");
  });

  it("drops blank children but keeps the rest in order", () => {
    const first = noteAt("first", 0, 0);
    const blank = noteAt("blank", 0, 10);
    const second = noteAt("second", 0, 20);
    const prompt = spawnPromptFor([first, blank, second], (id) => (id === "blank" ? "" : `text:${id}`));
    expect(prompt).toBe("text:first\n\ntext:second");
  });

  it("falls back to a child's richText when it has no live text", () => {
    const child = noteAt("rich", 0, 0, {
      richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "from richText" }] }] },
    });
    expect(spawnPromptFor([child], () => "")).toBe("from richText");
  });
});

describe("reduceInteractionMode / shouldSwallowEvents", () => {
  it("focuses on a focus-request from idle", () => {
    expect(reduceInteractionMode("idle", "focus-request")).toBe("focused");
  });

  it("stays focused on a focus-request while already focused", () => {
    expect(reduceInteractionMode("focused", "focus-request")).toBe("focused");
  });

  it("exits to idle on an exit-request from focused", () => {
    expect(reduceInteractionMode("focused", "exit-request")).toBe("idle");
  });

  it("stays idle on an exit-request while already idle", () => {
    expect(reduceInteractionMode("idle", "exit-request")).toBe("idle");
  });

  it("swallows events only in focused mode", () => {
    expect(shouldSwallowEvents("idle")).toBe(false);
    expect(shouldSwallowEvents("focused")).toBe(true);
  });
});

// 960 * (1 - 1/3) is 640, up to float rounding (`0.6666666666666667` is not
// exact) — every bound below assembled from BBTHREAD_PANE_FRACTION goes
// through `toBeCloseTo`, not `toEqual`, for exactly that reason.
function expectBoundsClose(actual: { minX: number; minY: number; maxX: number; maxY: number }, expected: { minX: number; minY: number; maxX: number; maxY: number }): void {
  expect(actual.minX).toBeCloseTo(expected.minX);
  expect(actual.minY).toBeCloseTo(expected.minY);
  expect(actual.maxX).toBeCloseTo(expected.maxX);
  expect(actual.maxY).toBeCloseTo(expected.maxY);
}

describe("paneLayout", () => {
  it("subdivides a default-size (960x600) bbthread's pane into header row / body / footer", () => {
    const layout = paneLayout(bbthread());
    // header band: canvas-model's own frameHeaderLocalBounds — 24px above the box.
    expect(layout.header).toEqual({ minX: 0, minY: -24, maxX: 960, maxY: 0 });
    // workspace: left two-thirds, below the header.
    expectBoundsClose(layout.workspace, { minX: 0, minY: 24, maxX: 640, maxY: 600 });
    // pane: right third, below the header.
    expectBoundsClose(layout.pane, { minX: 640, minY: 24, maxX: 960, maxY: 600 });
    // the pane's own title row and footer, at their fixed heights.
    expectBoundsClose(layout.paneHeaderRow, { minX: 640, minY: 24, maxX: 960, maxY: 56 });
    expectBoundsClose(layout.paneFooter, { minX: 640, minY: 564, maxX: 960, maxY: 600 });
    // the body fills what's left between them.
    expectBoundsClose(layout.paneBody, { minX: 640, minY: 56, maxX: 960, maxY: 564 });
  });

  it("never inverts the pane body for a pane too short for its own header+footer rows", () => {
    const layout = paneLayout(bbthread({}, { h: 50 }));
    expect(layout.paneBody.maxY).toBeGreaterThanOrEqual(layout.paneBody.minY);
  });
});
