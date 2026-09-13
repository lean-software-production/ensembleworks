/**
 * `human` (hexagon) handler, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T6: "Options from outgoing
 * edge labels (accelerator prefixes parsed), freeform edge, question_type
 * overrides, timeout -> human.default_choice, run status blocked while
 * waiting, context keys written, human.requested / human.answered events".
 *
 * Like handlers/agent.ts, the actual "ask a human" mechanics — `bb.ui.
 * requestInput` plus its `pendingInteraction` renderer, or the CLI's `bb
 * attractor answer` path resolving the same interaction — live behind an
 * injected `HumanInterviewer` (server/human.ts's real implementation). This
 * handler only builds the outgoing-edge option list from the graph, applies
 * the routing/context-key contract to whatever the interviewer returns, and
 * fails the stage clearly on a timeout with nothing to fall back to, or on a
 * user cancel — it never blocks forever.
 *
 * "timeout -> human.default_choice" is read literally as a *context key*
 * (`context.get("human.default_choice")`), not a new, undocumented node
 * attribute — see README "Deviations from the plan" (T6). A run's `inputs`
 * or an earlier stage's `context_updates` can set it to the label of the
 * edge a timed-out gate should take.
 */

import type { WorkflowEdge, WorkflowGraph } from "../dot/graph";
import { parseAcceleratorLabel } from "../dot/accelerator";
import type { Context, Handler, HandlerInput, JsonValue, Outcome, StageScopedEvent } from "../engine/types";

// Re-exported for backward compatibility: this handler's own tests (and any
// other caller) still import `parseAcceleratorLabel` from here — the
// accelerator-parsing logic itself now lives in `dot/accelerator.ts` so
// `ui/active-runs-banner.tsx` can share it without importing handler code.
export { parseAcceleratorLabel };

export interface HumanGateOption {
  /** Original edge label, as authored (e.g. "[A] Approve"). */
  raw: string;
  /** Accelerator key parsed from the label's prefix, if any (e.g. "A"). */
  key: string | null;
  /** Display text with the accelerator prefix stripped (e.g. "Approve"). */
  text: string;
  /** The edge's target node id. */
  to: string;
}

/**
 * The stage that routed into this gate (gate-context follow-up) — surfaced
 * on the gate payload (server/contracts.ts's `humanGatePayloadSchema`) so a
 * human answering "Approve plan?" can see what plan. `nodeId` is the
 * context key `last_stage` at the time the gate opens, falling back to the
 * gate's single predecessor in the graph when `last_stage` is absent (e.g.
 * the gate is the run's very first node); `text` is the full (capped)
 * `response.<nodeId>` context value; `threadId` is that stage's latest
 * worker thread id, via `HumanInterviewer.stageThreadId`.
 */
export interface HumanGateContext {
  nodeId: string;
  label: string | null;
  text: string | null;
  threadId: string | null;
}

/** The `review_target` node attribute's file, read at gate-open time (server/service.ts's `resolveWorkflowPath` + `bb.sdk.files.read`, via `HumanHandlerContext.readReviewTarget`). `error` is set (not thrown) for a missing file or a path that escapes the environment root. */
export interface ReviewTargetSummary {
  path: string;
  content: string | null;
  error: string | null;
}

export interface HumanAskInput {
  runId: string;
  stageId: string;
  nodeId: string;
  /** The origin thread this run was started from — where the gate's interaction is posted. */
  threadId: string;
  title: string;
  question: string;
  options: HumanGateOption[];
  /** Whether any outgoing edge declared `freeform=true` — free text is an acceptable answer. */
  freeform: boolean;
  questionType?: string;
  timeoutMs?: number;
  signal: AbortSignal;
  /** The stage that routed into this gate, or null when there is none to show. Optional so a caller building a `HumanAskInput` by hand (tests) doesn't have to supply it. */
  gateContext?: HumanGateContext | null;
  /** The node's `review_target` file, or null when the node has none. */
  reviewTarget?: ReviewTargetSummary | null;
}

export type HumanAskResult =
  | { kind: "choice"; option: HumanGateOption; actor?: "ui" | "cli" }
  | { kind: "text"; text: string; actor?: "ui" | "cli" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface HumanInterviewer {
  ask(input: HumanAskInput): Promise<HumanAskResult>;
  /**
   * The worker thread id a prior stage ran under, for the gate-context
   * "Open thread" affordance — server/service.ts backs this with
   * `RunStore.listStages`. Optional: a caller with no store access (most
   * tests) can omit it, and the gate context simply reports `threadId: null`.
   */
  stageThreadId?(runId: string, nodeId: string): string | null;
}

export interface HumanHandlerContext {
  threadId: string;
  /**
   * Reads the `review_target` node attribute's file, with hostId/
   * environmentPath already baked in by server/service.ts's `buildHandlers`
   * (the same way the `command` handler's injected `exec` already has its
   * `cwd` baked in) — see README "Deviations from the plan" (gate context).
   * Optional: undefined when no environment is wired (e.g. most tests),
   * in which case a set `review_target` is reported as unreadable.
   */
  readReviewTarget?(path: string): Promise<ReviewTargetSummary>;
}

function buildOptions(edges: WorkflowEdge[]): HumanGateOption[] {
  return edges
    .filter((e): e is WorkflowEdge & { label: string } => e.label !== undefined)
    .map((e) => {
      const { key, text } = parseAcceleratorLabel(e.label);
      return { raw: e.label, key, text, to: e.to };
    });
}

function gateContextUpdates(nodeId: string, fields: { selected: string; label?: string; text?: string; actor?: "ui" | "cli" | "default" }): Record<string, JsonValue> {
  const updates: Record<string, JsonValue> = { "human.gate.selected": fields.selected };
  if (fields.label !== undefined) updates["human.gate.label"] = fields.label;
  if (fields.text !== undefined) updates["human.gate.text"] = fields.text;
  if (fields.actor !== undefined) updates["human.gate.actor"] = fields.actor;
  updates[`human.gate.${nodeId}.answer`] = fields.selected;
  if (fields.label !== undefined) updates[`human.gate.${nodeId}.label`] = fields.label;
  return updates;
}

function respondWithChoice(nodeId: string, raw: string, emit: (e: StageScopedEvent) => void, actor?: "ui" | "cli" | "default"): Outcome {
  emit({ type: "human.answered", answer: raw, actor });
  const { text } = parseAcceleratorLabel(raw);
  return { status: "succeeded", preferredLabel: raw, text, contextUpdates: gateContextUpdates(nodeId, { selected: raw, label: text, actor }) };
}

// Full gate-context text is capped generously (it's shown in a collapsible
// block, not a fixed-size widget); the `human.requested` event's own summary
// caps much harder (`EVENT_SUMMARY_LIMIT`) since it's persisted forever.
const GATE_CONTEXT_TEXT_LIMIT = 20_000;
const EVENT_SUMMARY_LIMIT = 200;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)} …[truncated]` : text;
}

function findPredecessor(graph: WorkflowGraph, nodeId: string): string | null {
  return graph.edges.find((e) => e.to === nodeId)?.from ?? null;
}

function buildGateContext(
  graph: WorkflowGraph,
  context: Context,
  gateNodeId: string,
  runId: string,
  interviewer: HumanInterviewer,
): HumanGateContext | null {
  const lastStage = context.get("last_stage");
  const sourceNodeId = typeof lastStage === "string" ? lastStage : findPredecessor(graph, gateNodeId);
  if (sourceNodeId === null) return null;
  const label = graph.nodes.get(sourceNodeId)?.label ?? null;
  const rawText = context.get(`response.${sourceNodeId}`);
  const text = typeof rawText === "string" ? truncate(rawText, GATE_CONTEXT_TEXT_LIMIT) : null;
  const threadId = interviewer.stageThreadId?.(runId, sourceNodeId) ?? null;
  return { nodeId: sourceNodeId, label, text, threadId };
}

async function buildReviewTarget(node: { reviewTarget?: string }, ctx: HumanHandlerContext): Promise<ReviewTargetSummary | null> {
  if (node.reviewTarget === undefined) return null;
  if (!ctx.readReviewTarget) {
    return { path: node.reviewTarget, content: null, error: "review_target could not be read: no file reader is configured for this run" };
  }
  return ctx.readReviewTarget(node.reviewTarget);
}

export function createHumanHandler(interviewer: HumanInterviewer, ctx: HumanHandlerContext): Handler {
  return {
    async run(input: HandlerInput) {
      const { node, graph, context, runId, stageId, signal, emit } = input;
      const outgoing = graph.edges.filter((e) => e.from === node.id);
      const options = buildOptions(outgoing);
      const freeformEdge = outgoing.find((e) => e.freeform);
      const freeform = freeformEdge !== undefined;

      const gateContext = buildGateContext(graph, context, node.id, runId, interviewer);
      const reviewTarget = await buildReviewTarget(node, ctx);

      emit({
        type: "human.requested",
        options: options.map((o) => o.raw),
        context: gateContext
          ? { nodeId: gateContext.nodeId, label: gateContext.label, threadId: gateContext.threadId, text: gateContext.text !== null ? truncate(gateContext.text, EVENT_SUMMARY_LIMIT) : null }
          : null,
        reviewTarget: reviewTarget
          ? { path: reviewTarget.path, text: reviewTarget.content !== null ? truncate(reviewTarget.content, EVENT_SUMMARY_LIMIT) : reviewTarget.error }
          : null,
      });

      const result = await interviewer.ask({
        runId,
        stageId,
        nodeId: node.id,
        threadId: ctx.threadId,
        title: node.label ?? node.id,
        question: node.prompt ?? node.label ?? node.id,
        options,
        freeform,
        questionType: node.questionType,
        timeoutMs: node.timeoutMs,
        signal,
        gateContext,
        reviewTarget,
      });

      if (result.kind === "cancelled") {
        // No answer arrived, but the gate is done waiting: emit human.answered
        // (with no `answer`) so applyEventToStore clears the run/stage's
        // transient "blocked" status the same way an actual answer would —
        // otherwise the run keeps reporting "blocked" while the routing
        // cascade carries it on through this failed stage's outgoing edges.
        emit({ type: "human.answered" });
        return { status: "failed", failureReason: `human gate "${node.id}" was cancelled before answering` };
      }

      if (result.kind === "timeout") {
        const fallback = context.get("human.default_choice");
        if (typeof fallback !== "string") {
          emit({ type: "human.answered" });
          return {
            status: "failed",
            failureReason: `human gate "${node.id}" timed out with no "human.default_choice" context value to fall back to`,
          };
        }
        // The fallback must actually name one of the gate's outgoing edges
        // (by raw label or its accelerator-stripped text) — otherwise a
        // typo'd default_choice would still return a "succeeded" outcome
        // whose bogus preferredLabel matches nothing in the routing
        // cascade's step 3, silently falling through to step 6 and taking
        // an arbitrary unconditional edge (validation finding, T6 round 2).
        const matched = options.find((o) => o.raw === fallback || o.text === fallback);
        if (!matched) {
          emit({ type: "human.answered" });
          return {
            status: "failed",
            failureReason: `human gate "${node.id}" timed out and "human.default_choice" ("${fallback}") does not match any outgoing edge label`,
          };
        }
        // A synthetic answer from the timeout fallback, not a submitted
        // value — always attributed to "default" (never the unknown ui/cli
        // actor that never actually answered).
        return respondWithChoice(node.id, matched.raw, emit, "default");
      }

      if (result.kind === "choice") {
        return respondWithChoice(node.id, result.option.raw, emit, result.actor);
      }

      emit({ type: "human.answered", answer: result.text, actor: result.actor });
      return {
        status: "succeeded",
        // Route explicitly to the freeform edge's target: a free-text answer
        // carries no edge label, so without a jumpToNode the routing
        // cascade's preferred_label/suggested_next_ids steps would never
        // fire and step 6 (unconditional edges) would silently pick one of
        // the gate's *button* edges instead (validation finding, T6 round 2).
        jumpToNode: freeformEdge?.to,
        text: result.text,
        contextUpdates: gateContextUpdates(node.id, { selected: result.text, text: result.text, actor: result.actor }),
      };
    },
  };
}
