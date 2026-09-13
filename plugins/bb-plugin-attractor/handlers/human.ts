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

import type { WorkflowEdge } from "../dot/graph";
import type { Handler, JsonValue, Outcome, StageScopedEvent } from "../engine/types";

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
}

export type HumanAskResult =
  | { kind: "choice"; option: HumanGateOption }
  | { kind: "text"; text: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface HumanInterviewer {
  ask(input: HumanAskInput): Promise<HumanAskResult>;
}

export interface HumanHandlerContext {
  threadId: string;
}

// A single leading "[K] ", "K) " or "K - " accelerator prefix, K being one
// non-space character — matches engine/router.ts's own accelerator handling
// (kept as a separate, small copy here rather than a shared export: this one
// also needs the parsed key, not just the stripped text, and this handler
// must not take on a dependency on the engine's routing internals).
const ACCELERATOR_RE = /^(?:\[([^\]]*)\]|(\S)\)|(\S)\s-)\s*/;

export function parseAcceleratorLabel(label: string): { key: string | null; text: string } {
  const match = ACCELERATOR_RE.exec(label);
  if (!match) return { key: null, text: label };
  const key = match[1] ?? match[2] ?? match[3] ?? null;
  return { key, text: label.slice(match[0].length) };
}

function buildOptions(edges: WorkflowEdge[]): HumanGateOption[] {
  return edges
    .filter((e): e is WorkflowEdge & { label: string } => e.label !== undefined)
    .map((e) => {
      const { key, text } = parseAcceleratorLabel(e.label);
      return { raw: e.label, key, text, to: e.to };
    });
}

function gateContextUpdates(nodeId: string, fields: { selected: string; label?: string; text?: string }): Record<string, JsonValue> {
  const updates: Record<string, JsonValue> = { "human.gate.selected": fields.selected };
  if (fields.label !== undefined) updates["human.gate.label"] = fields.label;
  if (fields.text !== undefined) updates["human.gate.text"] = fields.text;
  updates[`human.gate.${nodeId}.answer`] = fields.selected;
  if (fields.label !== undefined) updates[`human.gate.${nodeId}.label`] = fields.label;
  return updates;
}

function respondWithChoice(nodeId: string, raw: string, emit: (e: StageScopedEvent) => void): Outcome {
  emit({ type: "human.answered", answer: raw });
  const { text } = parseAcceleratorLabel(raw);
  return { status: "succeeded", preferredLabel: raw, text, contextUpdates: gateContextUpdates(nodeId, { selected: raw, label: text }) };
}

export function createHumanHandler(interviewer: HumanInterviewer, ctx: HumanHandlerContext): Handler {
  return {
    async run(input) {
      const { node, graph, context, runId, stageId, signal, emit } = input;
      const outgoing = graph.edges.filter((e) => e.from === node.id);
      const options = buildOptions(outgoing);
      const freeform = outgoing.some((e) => e.freeform);

      emit({ type: "human.requested", options: options.map((o) => o.raw) });

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
      });

      if (result.kind === "cancelled") {
        return { status: "failed", failureReason: `human gate "${node.id}" was cancelled before answering` };
      }

      if (result.kind === "timeout") {
        const fallback = context.get("human.default_choice");
        if (typeof fallback !== "string") {
          return {
            status: "failed",
            failureReason: `human gate "${node.id}" timed out with no "human.default_choice" context value to fall back to`,
          };
        }
        return respondWithChoice(node.id, fallback, emit);
      }

      if (result.kind === "choice") {
        return respondWithChoice(node.id, result.option.raw, emit);
      }

      emit({ type: "human.answered", answer: result.text });
      return {
        status: "succeeded",
        text: result.text,
        contextUpdates: gateContextUpdates(node.id, { selected: result.text, text: result.text }),
      };
    },
  };
}
