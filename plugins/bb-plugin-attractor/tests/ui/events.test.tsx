// @vitest-environment jsdom
/**
 * `ui/events.tsx`'s event timeline, per T5 acceptance: "Panel: … event
 * timeline (paged)".
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { describeEvent, EventTimeline, PAGE_SIZE } from "../../ui/events";
import type { RunEvent } from "../../engine/types";

// `render()` (unlike this plugin's `renderSlot` test harness) appends to
// `document.body` and is not auto-cleaned between tests under this project's
// vitest config (no `test.globals`, so testing-library's own auto-cleanup
// hook never finds a global `afterEach` to attach to) — without this, a
// later test's `getByRole`/`getByText` (which query `document.body`, not
// just this render's own container) can match a previous test's leftover
// DOM. See tests/ui/stages.test.tsx and dag.render.test.tsx, which instead
// scope every query to `container.querySelector(...)` and so don't need it.
afterEach(cleanup);

function events(count: number): (RunEvent & { seq: number })[] {
  return Array.from({ length: count }, (_, i) => ({ type: "log", runId: "r1", ts: i, seq: i + 1, message: `entry ${i + 1}` }) as RunEvent & { seq: number });
}

describe("describeEvent", () => {
  it("summarizes a stage.started event", () => {
    expect(describeEvent({ type: "stage.started", runId: "r1", ts: 0, stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, seq: 1 })).toContain("plan");
  });
  it("summarizes an edge.selected event with its reason", () => {
    const text = describeEvent({ type: "edge.selected", runId: "r1", ts: 0, from: "a", to: "b", reason: "condition", seq: 1 });
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("condition");
  });
  it("summarizes a stage.failed event with willRetry", () => {
    const text = describeEvent({ type: "stage.failed", runId: "r1", ts: 0, stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, error: "boom", willRetry: true, seq: 1 });
    expect(text).toContain("boom");
    expect(text).toContain("retry");
  });
});

describe("EventTimeline", () => {
  it("shows only the most recent page of events by default, oldest of the page first", () => {
    // 55 events over pages of 50: the last (most recent) page holds only the
    // trailing 5 (seq 51..55).
    const all = events(PAGE_SIZE + 5);
    const { container } = render(<EventTimeline events={all} />);
    const rows = container.querySelectorAll("[data-event-seq]");
    expect(rows).toHaveLength(5);
    expect(rows[0].getAttribute("data-event-seq")).toBe(String(PAGE_SIZE + 1));
    expect(rows[rows.length - 1].getAttribute("data-event-seq")).toBe(String(PAGE_SIZE + 5));
  });

  it("pages backward through older events on request", () => {
    const all = events(PAGE_SIZE + 5);
    const { container, getByRole } = render(<EventTimeline events={all} />);
    fireEvent.click(getByRole("button", { name: /older/i }));
    const rows = container.querySelectorAll("[data-event-seq]");
    expect(rows[0].getAttribute("data-event-seq")).toBe("1");
    expect(rows[rows.length - 1].getAttribute("data-event-seq")).toBe(String(PAGE_SIZE));
  });

  it("disables paging controls at the boundaries", () => {
    const all = events(3);
    const { getByRole } = render(<EventTimeline events={all} />);
    expect((getByRole("button", { name: /older/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole("button", { name: /newer/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders an empty state with no events", () => {
    const { getByText } = render(<EventTimeline events={[]} />);
    expect(getByText(/no events yet/i)).toBeTruthy();
  });
});
