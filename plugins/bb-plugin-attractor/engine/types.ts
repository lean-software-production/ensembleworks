/**
 * Engine contracts, per docs/plans/2026-09-13-attractor-runner-plan.md
 * "Engine contracts (engine/types.ts — implement exactly)".
 *
 * Pure module: no BB imports, no I/O, no randomness.
 */

import type { HandlerKind, JsonValue, WorkflowGraph, WorkflowNode } from "../dot/graph";

export type { HandlerKind, JsonValue, WorkflowGraph, WorkflowNode };

export type OutcomeStatus = "succeeded" | "failed" | "partially_succeeded" | "skipped";

export interface Outcome {
  status: OutcomeStatus;
  preferredLabel?: string;
  suggestedNextIds?: string[];
  jumpToNode?: string;
  failureReason?: string;
  contextUpdates?: Record<string, JsonValue>;
  /** Agent/prompt/command output text. */
  text?: string;
}

export interface Context {
  /** Dot-path read (e.g. "response.plan"); only own-properties are traversed. */
  get(path: string): JsonValue | undefined;
  /** Dot-path write; creates intermediate objects as needed. */
  set(path: string, value: JsonValue): void;
  /** Shallow top-level merge of updates into the context. */
  merge(updates: Record<string, JsonValue> | undefined): void;
  /** A deep-cloned snapshot suitable for condition evaluation / persistence. */
  toObject(): Record<string, JsonValue>;
  /** A deep copy as an independent Context, for parallel branch isolation. */
  clone(): Context;
}

export interface HandlerInput {
  node: WorkflowNode;
  graph: WorkflowGraph;
  context: Context;
  visit: number;
  attempt: number;
  runId: string;
  stageId: string;
  signal: AbortSignal;
  emit(event: StageScopedEvent): void;
}

export interface Handler {
  run(input: HandlerInput): Promise<Outcome>;
}

export type HandlerRegistry = Record<HandlerKind, Handler>;

export interface Checkpoint {
  runId: string;
  /** The node the run should resume at; nothing before it is replayed. */
  nextNodeId: string;
  context: Record<string, JsonValue>;
  visitCounts: Record<string, number>;
  /** Last recorded outcome status per visited goal-gated node, for the exit-time gate check. */
  goalGateOutcomes: Record<string, OutcomeStatus>;
}

export interface EngineOptions {
  graph: WorkflowGraph;
  handlers: HandlerRegistry;
  runId: string;
  initialContext?: Record<string, JsonValue>;
  checkpoint?: { save(state: Checkpoint): Promise<void>; load?: Checkpoint };
  clock: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
  signal: AbortSignal;
  onEvent(event: RunEvent): void;
}

export interface RunResult {
  status: "succeeded" | "failed" | "cancelled";
  finalOutcome: Outcome | null;
  goalGateFailures: string[];
  context: Record<string, JsonValue>;
}

export type EdgeSelectedReason =
  | "jump"
  | "condition"
  | "preferred_label"
  | "suggested"
  | "unconditional"
  | "retry_target";

/** Events a handler may emit mid-stage, via HandlerInput.emit(); the engine stamps runId/ts/stageId/nodeId. */
export type StageScopedEvent =
  | { type: "log"; message: string }
  | { type: "agent.thread"; threadId: string; provider: string; model: string; reasoningLevel: string | null }
  | {
      type: "human.requested";
      options?: string[];
      /** The stage that routed into this gate (gate-context follow-up) — nodeId/label/text/threadId, or null when there is none to show. */
      context?: { nodeId: string; label: string | null; text: string | null; threadId: string | null } | null;
      /** The `review_target` node attribute's file, if set — path plus its (possibly-error) text. */
      reviewTarget?: { path: string; text: string | null } | null;
    }
  | { type: "human.answered"; answer?: string; actor?: "ui" | "cli" | "default" }
  // Dogfood-2 fix: a worker thread (an agent/prompt stage's spawned thread)
  // stopped on its own pending interaction (a permission/file-change/
  // command/plan/question prompt, or a plugin-rendered one) — server/
  // backend.ts emits this through the live stage's remembered `emit` (see
  // its header comment) so the run visibly shows "blocked", not "running
  // forever", while a human answers it. `agent.resumed` clears it once the
  // thread goes active/idle again.
  | { type: "agent.waiting"; threadId: string; interactionId: string; kind: string; title: string | null }
  | { type: "agent.resumed"; threadId: string };

export type RunEvent =
  | { type: "run.started"; runId: string; ts: number }
  | { type: "run.completed"; runId: string; ts: number; status: "succeeded" | "failed"; goalGateFailures: string[] }
  | { type: "run.failed"; runId: string; ts: number; error: string }
  | { type: "run.cancelled"; runId: string; ts: number }
  | {
      type: "stage.started";
      runId: string;
      ts: number;
      stageId: string;
      nodeId: string;
      visit: number;
      attempt: number;
      parallelGroupId?: string;
      branchIndex?: number;
    }
  | {
      type: "stage.completed";
      runId: string;
      ts: number;
      stageId: string;
      nodeId: string;
      visit: number;
      attempt: number;
      outcome: Outcome;
      wallTimeMs: number;
    }
  | {
      type: "stage.failed";
      runId: string;
      ts: number;
      stageId: string;
      nodeId: string;
      visit: number;
      attempt: number;
      error: string;
      willRetry: boolean;
    }
  | { type: "stage.skipped"; runId: string; ts: number; stageId: string; nodeId: string; reason: string }
  | {
      type: "edge.selected";
      runId: string;
      ts: number;
      from: string;
      to: string;
      edgeLabel?: string;
      reason: EdgeSelectedReason;
    }
  | { type: "agent.thread"; runId: string; ts: number; stageId: string; nodeId: string; threadId: string; provider: string; model: string; reasoningLevel: string | null }
  | { type: "agent.waiting"; runId: string; ts: number; stageId: string; nodeId: string; threadId: string; interactionId: string; kind: string; title: string | null }
  | { type: "agent.resumed"; runId: string; ts: number; stageId: string; nodeId: string; threadId: string }
  | {
      type: "human.requested";
      runId: string;
      ts: number;
      stageId: string;
      nodeId: string;
      options?: string[];
      context?: { nodeId: string; label: string | null; text: string | null; threadId: string | null } | null;
      reviewTarget?: { path: string; text: string | null } | null;
    }
  | { type: "human.answered"; runId: string; ts: number; stageId: string; nodeId: string; answer?: string; actor?: "ui" | "cli" | "default" }
  | { type: "checkpoint.saved"; runId: string; ts: number; stageId: string }
  | { type: "log"; runId: string; ts: number; stageId?: string; message: string };
