import { describe, expect, it } from "vitest";
import { threadCardState, threadActivityCount, threadCardPosition, threadOverviewRows } from "../canvas/thread-overview.js";
import type { CanvasAgentLink } from "../canvas/wire.js";

const link = (status: CanvasAgentLink["status"]): CanvasAgentLink => ({
  shapeId: "shape-1",
  threadId: "thread-1",
  status,
});

describe("threadOverviewRows", () => {
  it("uses BB's title and pending interaction label", () => {
    const rows = threadOverviewRows(
      { "shape-1": link("running") },
      [{
        id: "thread-1",
        title: "Deploy worker",
        titleFallback: "fallback",
        projectId: "project",
        parentThreadId: null,
        sectionId: null,
        originKind: null,
        originPluginId: null,
        providerId: "provider",
        hasPendingInteraction: true,
        activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
        indicator: "waiting-for-input",
        indicatorLabel: "Thread needs user input",
        isUnread: false,
        isPinned: false,
        isArchived: false,
        environment: null,
        host: { id: "host-1", name: "Build machine" },
        createdAt: 1,
        updatedAt: 2,
        lastReadAt: 2,
        latestAttentionAt: 3,
      }],
      [{ id: "project", name: "Canvas project", isPersonal: false }],
    );
    expect(rows[0]).toMatchObject({ projectName: "Canvas project", machineName: "Build machine", state: "attention", title: "Deploy worker", statusLabel: "Thread needs user input", attentionLabel: "Thread needs user input", activityCount: 0 });
    const thread = rows[0].thread!;
    expect(threadCardState(link("idle"), { ...thread, hasPendingInteraction: false, indicator: "runtime" })).toBe("running");
    expect(threadCardState(link("idle"), { ...thread, hasPendingInteraction: false, indicator: "unread-error" })).toBe("failed");
  });

  it("keeps an unmatched link without fabricating a summary", () => {
    expect(threadOverviewRows({ "shape-1": link("failed") }, [])).toMatchObject([
      { title: "thread-1", statusLabel: "Failed", attentionLabel: null, thread: null, state: "failed", machineName: "Machine unavailable" },
    ]);
  });

  it("uses BB's fallback title and unread signal", () => {
    const row = threadOverviewRows(
      { "shape-1": link("idle") },
      [{
        id: "thread-1", title: null, titleFallback: "Untitled thread", projectId: "project",
        parentThreadId: null, sectionId: null, originKind: null, originPluginId: null, providerId: "provider",
        hasPendingInteraction: false, activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
        indicator: "none", indicatorLabel: null, isUnread: true, isPinned: false, isArchived: false,
        environment: null, host: null, createdAt: 1, updatedAt: 2, lastReadAt: 2, latestAttentionAt: 2,
      }],
    )[0];
    expect(row).toMatchObject({ title: "Untitled thread", statusLabel: "Idle", attentionLabel: "Unread", state: "idle" });
  });

  it("sums BB's live activity counters without inventing work for missing threads", () => {
    expect(threadActivityCount(null)).toBe(0);
    expect(threadActivityCount({ activity: { workflows: 1, backgroundAgents: 2, backgroundCommands: 3, planMode: 4, goals: 5 } } as never)).toBe(15);
  });

  it("scales the gap and visibility bounds with canvas zoom", () => {
    const viewport = { width: 800, height: 600 };
    const box = { left: 50, top: 50, right: 200, bottom: 150 };
    expect(threadCardPosition(box, viewport, 0.5)).toEqual({ left: 50, top: 154 });
    expect(threadCardPosition(box, viewport, 2)).toEqual({ left: 50, top: 166 });
    const leftOfView = { left: -300, top: 50, right: -100, bottom: 150 };
    expect(threadCardPosition(leftOfView, viewport, 1)).toBeNull();
    expect(threadCardPosition(leftOfView, viewport, 2)).toEqual({ left: -300, top: 166 });
  });

  it("keeps partially visible cards attached and culls only offscreen cards", () => {
    expect(threadCardPosition({ left: 50, top: 50, right: 200, bottom: 150 }, { width: 800, height: 600 })).toEqual({ left: 50, top: 158 });
    expect(threadCardPosition({ left: 0, top: -350, right: 200, bottom: -250 }, { width: 800, height: 600 })).toBeNull();
    expect(threadCardPosition({ left: 20, top: 20, right: 200, bottom: 80 }, { width: 100, height: 80 })).toBeNull();
    expect(threadCardPosition({ left: 700, top: 50, right: 800, bottom: 150 }, { width: 800, height: 600 })).toEqual({ left: 700, top: 158 });
    expect(threadCardPosition({ left: 800, top: 50, right: 900, bottom: 150 }, { width: 800, height: 600 })).toBeNull();
  });
});
