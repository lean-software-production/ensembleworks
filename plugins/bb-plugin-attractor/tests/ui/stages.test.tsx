/**
 * `ui/stages.tsx`'s remaining per-stage helpers. The four-column stage table
 * that used to live there was replaced by the side panel's History section
 * (run-panel redesign; see tests/ui/history.test.tsx), so what is left to
 * test is the duration formatting and the provider/model label shared by
 * the history rows and the graph's node detail.
 */
import { describe, expect, it } from "vitest";
import { formatDuration, providerLabel } from "../../ui/stages";
import type { GraphView, StageView } from "../../server/contracts";

describe("formatDuration", () => {
  it("formats sub-second durations in whole seconds", () => {
    expect(formatDuration(400)).toBe("<1s");
  });
  it("formats seconds", () => {
    expect(formatDuration(12_000)).toBe("12s");
  });
  it("formats minutes and seconds", () => {
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
  it("formats hours, minutes and seconds", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });
});

const NODE: GraphView["nodes"][number] = {
  id: "plan", label: "Plan", shape: "box", handlerKind: "agent", goalGate: false, status: null, visit: 0,
  model: "claude-sonnet-5", provider: "anthropic", waitingReason: null,
};

function stage(overrides: Partial<StageView> = {}): StageView {
  return {
    runId: "r1", stageId: "plan@1", nodeId: "plan", visit: 1, attempt: 1, status: "succeeded", outcomeStatus: "succeeded",
    threadId: "thread-9", providerId: null, model: null, reasoningLevel: null, actor: null, waitingReason: null, startedAt: 1000, completedAt: 1500,
    ...overrides,
  };
}

describe("providerLabel", () => {
  it("prefers the stage's actually-resolved provider/model tuple over the node's merely-declared one", () => {
    expect(providerLabel(stage({ providerId: "openai", model: "gpt-5", reasoningLevel: "high" }), NODE)).toBe("openai / gpt-5 (high)");
  });

  it("omits the reasoning level suffix when the resolved stage has none", () => {
    expect(providerLabel(stage({ providerId: "openai", model: "gpt-5" }), NODE)).toBe("openai / gpt-5");
  });

  it("falls back to the node's declared provider/model when the stage has no resolved tuple yet", () => {
    expect(providerLabel(stage(), NODE)).toBe("anthropic / claude-sonnet-5");
  });

  it("shows whichever half is known, and a dash when neither is", () => {
    expect(providerLabel(stage({ model: "gpt-5" }), undefined)).toBe("gpt-5");
    expect(providerLabel(stage(), undefined)).toBe("—");
  });
});
