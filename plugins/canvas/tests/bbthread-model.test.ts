// Run: npx vitest run tests/bbthread-model.test.ts
//
// The `bbthread` shape body's pure decisions (canvas/shapes/bbthread-model.ts)
// — see that file's own header and docs/plans/2026-09-15-bb-thread-frame.md.
import { describe, expect, it } from "vitest";
import type { Shape } from "@ensembleworks/canvas-model";
import { BBTHREAD_DIVIDER_MARGIN } from "@ensembleworks/canvas-model";
import {
  bbthreadPaneState,
  isScrollable,
  paneInteraction,
  paneLayout,
  pickScrollTargets,
  spawnPromptFor,
  threadIdOf,
  toneFor,
  type ScrollCandidate,
  type PaneState,
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

describe("paneInteraction", () => {
  const shape = bbthread();
  const notEditing = { editingId: null, editingRegion: null };

  it("is not interactive when nothing is being edited", () => {
    expect(paneInteraction(shape, { kind: "unbound" }, notEditing)).toEqual({
      interactive: false,
      hint: "Double-click to choose a thread",
    });
  });

  it("is not interactive when a DIFFERENT shape is being edited", () => {
    const editorState = { editingId: "shape:someone-else", editingRegion: "body" as const };
    expect(paneInteraction(shape, { kind: "unbound" }, editorState)).toEqual({
      interactive: false,
      hint: "Double-click to choose a thread",
    });
  });

  it("is not interactive when THIS shape is being edited at the 'name' region", () => {
    const editorState = { editingId: shape.id, editingRegion: "name" as const };
    expect(paneInteraction(shape, { kind: "bound", title: "t", statusLabel: "Idle", tone: "idle", isArchived: false }, editorState)).toEqual({
      interactive: false,
      hint: "Double-click to read or reply · Esc to leave",
    });
  });

  it("is interactive when THIS shape is being edited at the 'body' region", () => {
    const editorState = { editingId: shape.id, editingRegion: "body" as const };
    expect(paneInteraction(shape, { kind: "bound", title: "t", statusLabel: "Idle", tone: "idle", isArchived: false }, editorState)).toEqual({
      interactive: true,
      hint: null,
    });
  });

  it("hints 'choose a thread' when unbound", () => {
    const pane: PaneState = { kind: "unbound" };
    expect(paneInteraction(shape, pane, notEditing).hint).toBe("Double-click to choose a thread");
  });

  it("hints nothing while loading", () => {
    const pane: PaneState = { kind: "loading" };
    expect(paneInteraction(shape, pane, notEditing).hint).toBeNull();
  });

  it("hints 'read or reply · Esc to leave' when bound", () => {
    const pane: PaneState = { kind: "bound", title: "t", statusLabel: "Idle", tone: "idle", isArchived: false };
    expect(paneInteraction(shape, pane, notEditing).hint).toBe("Double-click to read or reply · Esc to leave");
  });

  it("hints 'unbind' when gone", () => {
    const pane: PaneState = { kind: "gone" };
    expect(paneInteraction(shape, pane, notEditing).hint).toBe("Double-click to unbind");
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
    // workspace: left two-thirds, spanning the shape's full local height —
    // the header band sits above this, at negative y, not inside [0,h].
    expectBoundsClose(layout.workspace, { minX: 0, minY: 0, maxX: 640, maxY: 600 });
    // pane: right third, spanning the same full [0,600] height.
    expectBoundsClose(layout.pane, { minX: 640, minY: 0, maxX: 960, maxY: 600 });
    // the pane's own title row and footer, at their fixed heights.
    expectBoundsClose(layout.paneHeaderRow, { minX: 640, minY: 0, maxX: 960, maxY: 32 });
    expectBoundsClose(layout.paneFooter, { minX: 640, minY: 564, maxX: 960, maxY: 600 });
    // the body fills what's left between them.
    expectBoundsClose(layout.paneBody, { minX: 640, minY: 32, maxX: 960, maxY: 564 });
  });

  it("never inverts the pane body for a pane too short for its own header+footer rows", () => {
    const layout = paneLayout(bbthread({}, { h: 50 }));
    expect(layout.paneBody.maxY).toBeGreaterThanOrEqual(layout.paneBody.minY);
  });

  it("centers the divider on the pane's left edge, spanning its y-range", () => {
    const layout = paneLayout(bbthread());
    // pane.minX is 640 on a default-size (960x600) bbthread (see above); the
    // divider is a `2 * BBTHREAD_DIVIDER_MARGIN`-wide strip centred on it.
    expectBoundsClose(layout.divider, {
      minX: layout.pane.minX - BBTHREAD_DIVIDER_MARGIN,
      maxX: layout.pane.minX + BBTHREAD_DIVIDER_MARGIN,
      minY: layout.pane.minY,
      maxY: layout.pane.maxY,
    });
  });

  it("follows a non-default paneFraction — 0.5 starts the pane at w/2", () => {
    const layout = paneLayout(bbthread({ paneFraction: 0.5 }));
    expectBoundsClose(layout.pane, { minX: 480, minY: 0, maxX: 960, maxY: 600 });
    expectBoundsClose(layout.workspace, { minX: 0, minY: 0, maxX: 480, maxY: 600 });
    expectBoundsClose(layout.divider, {
      minX: 480 - BBTHREAD_DIVIDER_MARGIN,
      maxX: 480 + BBTHREAD_DIVIDER_MARGIN,
      minY: 0,
      maxY: 600,
    });
  });
});

describe("isScrollable", () => {
  it("accepts overflow-y: auto with content taller than the box", () => {
    expect(isScrollable({ overflowY: "auto", scrollHeight: 500, clientHeight: 200 })).toBe(true);
  });

  it("accepts overflow-y: scroll with content taller than the box", () => {
    expect(isScrollable({ overflowY: "scroll", scrollHeight: 500, clientHeight: 200 })).toBe(true);
  });

  it("rejects overflow-y: visible even when content overflows", () => {
    expect(isScrollable({ overflowY: "visible", scrollHeight: 500, clientHeight: 200 })).toBe(false);
  });

  it("rejects overflow-y: hidden even when content overflows", () => {
    expect(isScrollable({ overflowY: "hidden", scrollHeight: 500, clientHeight: 200 })).toBe(false);
  });

  it("rejects overflow-y: auto with nothing overflowing yet (scrollHeight === clientHeight)", () => {
    expect(isScrollable({ overflowY: "auto", scrollHeight: 200, clientHeight: 200 })).toBe(false);
  });

  it("rejects overflow-y: auto when scrollHeight is somehow smaller than clientHeight", () => {
    expect(isScrollable({ overflowY: "auto", scrollHeight: 100, clientHeight: 200 })).toBe(false);
  });
});

describe("pickScrollTargets", () => {
  function candidate(id: string, overrides: Partial<ScrollCandidate<string>> = {}): ScrollCandidate<string> {
    return { element: id, overflowY: "auto", scrollHeight: 500, clientHeight: 200, ...overrides };
  }

  it("returns the elements of every scrollable candidate", () => {
    const candidates = [candidate("a"), candidate("b", { overflowY: "hidden" }), candidate("c")];
    expect(pickScrollTargets(candidates)).toEqual(["a", "c"]);
  });

  it("preserves candidate order rather than imposing one", () => {
    const candidates = [candidate("outer", { scrollHeight: 300, clientHeight: 200 }), candidate("inner", { scrollHeight: 900, clientHeight: 100 })];
    expect(pickScrollTargets(candidates)).toEqual(["outer", "inner"]);
  });

  it("returns an empty array when nothing is scrollable", () => {
    const candidates = [candidate("a", { overflowY: "visible" }), candidate("b", { scrollHeight: 200, clientHeight: 200 })];
    expect(pickScrollTargets(candidates)).toEqual([]);
  });

  it("returns an empty array for an empty candidate list", () => {
    expect(pickScrollTargets([])).toEqual([]);
  });
});
