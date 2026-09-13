/**
 * Typed event emitter: turns the narrow StageScopedEvent a handler may raise
 * mid-stage (via HandlerInput.emit) into a fully-stamped RunEvent (runId,
 * ts, stageId, nodeId) and forwards it to the engine's onEvent sink.
 *
 * Pure module: no BB imports, no I/O, no randomness (the clock is injected).
 */

import type { RunEvent, StageScopedEvent } from "./types";

export interface StageEmitterOptions {
  runId: string;
  stageId: string;
  nodeId: string;
  now(): number;
  onEvent(event: RunEvent): void;
}

export function createStageEmitter(opts: StageEmitterOptions): (event: StageScopedEvent) => void {
  const { runId, stageId, nodeId, now, onEvent } = opts;
  return (event: StageScopedEvent) => {
    const ts = now();
    switch (event.type) {
      case "log":
        onEvent({ type: "log", runId, ts, stageId, message: event.message });
        return;
      case "agent.thread":
        onEvent({ type: "agent.thread", runId, ts, stageId, nodeId, threadId: event.threadId, provider: event.provider, model: event.model, reasoningLevel: event.reasoningLevel });
        return;
      case "agent.waiting":
        onEvent({ type: "agent.waiting", runId, ts, stageId, nodeId, threadId: event.threadId, interactionId: event.interactionId, kind: event.kind, title: event.title });
        return;
      case "agent.resumed":
        onEvent({ type: "agent.resumed", runId, ts, stageId, nodeId, threadId: event.threadId });
        return;
      case "human.requested":
        onEvent({ type: "human.requested", runId, ts, stageId, nodeId, options: event.options });
        return;
      case "human.answered":
        onEvent({ type: "human.answered", runId, ts, stageId, nodeId, answer: event.answer, actor: event.actor });
        return;
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  };
}
