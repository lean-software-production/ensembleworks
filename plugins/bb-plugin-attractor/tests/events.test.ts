import { describe, expect, it } from "vitest";
import { createStageEmitter } from "../engine/events";
import type { RunEvent } from "../engine/types";

describe("engine/events: stage-scoped event emitter", () => {
  it("stamps runId/ts/stageId/nodeId onto a log event", () => {
    const events: RunEvent[] = [];
    const emit = createStageEmitter({
      runId: "run-1",
      stageId: "plan@1",
      nodeId: "plan",
      now: () => 42,
      onEvent: (e) => events.push(e),
    });
    emit({ type: "log", message: "hello" });
    expect(events).toEqual([{ type: "log", runId: "run-1", ts: 42, stageId: "plan@1", message: "hello" }]);
  });

  it("stamps an agent.thread event with the thread id", () => {
    const events: RunEvent[] = [];
    const emit = createStageEmitter({
      runId: "run-1",
      stageId: "plan@1",
      nodeId: "plan",
      now: () => 7,
      onEvent: (e) => events.push(e),
    });
    emit({ type: "agent.thread", threadId: "thread-abc" });
    expect(events).toEqual([{ type: "agent.thread", runId: "run-1", ts: 7, stageId: "plan@1", threadId: "thread-abc" }]);
  });

  it("stamps human.requested and human.answered with the stage's node id", () => {
    const events: RunEvent[] = [];
    const emit = createStageEmitter({
      runId: "run-1",
      stageId: "approve@1",
      nodeId: "approve",
      now: () => 1,
      onEvent: (e) => events.push(e),
    });
    emit({ type: "human.requested", options: ["Approve", "Revise"] });
    emit({ type: "human.answered", answer: "Approve" });
    expect(events).toEqual([
      { type: "human.requested", runId: "run-1", ts: 1, stageId: "approve@1", nodeId: "approve", options: ["Approve", "Revise"] },
      { type: "human.answered", runId: "run-1", ts: 1, stageId: "approve@1", nodeId: "approve", answer: "Approve" },
    ]);
  });

  it("calls now() fresh for each emitted event", () => {
    const events: RunEvent[] = [];
    let t = 0;
    const emit = createStageEmitter({
      runId: "run-1",
      stageId: "s@1",
      nodeId: "s",
      now: () => ++t,
      onEvent: (e) => events.push(e),
    });
    emit({ type: "log", message: "a" });
    emit({ type: "log", message: "b" });
    expect(events.map((e) => (e as { ts: number }).ts)).toEqual([1, 2]);
  });
});
