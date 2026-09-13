/**
 * Next-node selection cascade, per docs/plans/2026-09-13-attractor-runner-plan.md
 * "Routing cascade after a stage completes (Fabro semantics)", steps 1-6 (and
 * step 7 as a separate function since it needs to be consulted again by the
 * caller after any candidate turns out non-enterable due to max_visits).
 *
 * Pure module: no BB imports, no I/O, no randomness.
 */

import { evaluateCondition, tryParseCondition } from "../dot/conditions";
import type { JsonValue, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../dot/graph";
import type { EdgeSelectedReason, Outcome } from "./types";

export interface RouteInput {
  node: WorkflowNode;
  graph: WorkflowGraph;
  outcome: Outcome;
  context: Record<string, JsonValue>;
}

export interface RouteDecision {
  nodeId: string;
  reason: EdgeSelectedReason;
  edgeLabel?: string;
}

// Strip a single leading "[K] ", "K) " or "K - " accelerator prefix before
// comparing a preferred_label to an edge label. K is a single accelerator
// key character (not a run of non-space characters) so a legitimate label
// whose first word happens to contain ')' or " - " isn't mistaken for one,
// e.g. "run(x) thing" must not be reduced to "thing".
function stripAccelerator(label: string): string {
  return label
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/^\S\)\s*/, "")
    .replace(/^\S\s-\s*/, "");
}

function outgoingEdges(nodeId: string, graph: WorkflowGraph): WorkflowEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

// Highest weight first, then lexicographically smallest target id.
function byWeightThenTarget(edges: WorkflowEdge[]): WorkflowEdge[] {
  return [...edges].sort((a, b) => {
    if (a.weight !== b.weight) return b.weight - a.weight;
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });
}

interface AttemptResult {
  decision: RouteDecision | null;
  // Whether a null decision should fall through to step 7 (retry_target). Per
  // the plan, step 7 is reached only for a genuinely unresolved *failure*
  // (on_failure="route" or "exit" falling through steps 5/6) — never for a
  // non-failed outcome that simply dead-ends (that terminates via step 8
  // with its own outcome), and never for an on_failure="succeed" rewrite
  // ("succeed rewrites to succeeded and re-runs 2-6", explicitly excluding 7).
  retryEligible: boolean;
}

function attempt(node: WorkflowNode, graph: WorkflowGraph, outcome: Outcome, context: Record<string, JsonValue>, allowOnFailureRewrite: boolean): AttemptResult {
  // Step 1: jump_to_node bypasses edges entirely.
  if (outcome.jumpToNode !== undefined && graph.nodes.has(outcome.jumpToNode)) {
    return { decision: { nodeId: outcome.jumpToNode, reason: "jump" }, retryEligible: false };
  }

  const edges = outgoingEdges(node.id, graph);
  const conditionalEdges = edges.filter((e) => e.condition !== undefined);
  const unconditionalEdges = edges.filter((e) => e.condition === undefined);

  // Step 2: conditional edges whose condition is true.
  const trueConditional = conditionalEdges.filter((e) => {
    const parsed = tryParseCondition(e.condition!);
    if (!parsed.ok) return false;
    return evaluateCondition(parsed.node, { outcome: outcome.status, preferredLabel: outcome.preferredLabel, context });
  });
  if (trueConditional.length > 0) {
    const [chosen] = byWeightThenTarget(trueConditional);
    return { decision: { nodeId: chosen.to, reason: "condition", edgeLabel: chosen.label }, retryEligible: false };
  }

  // Step 3: preferred_label matched against edge labels (any edge, including
  // a conditional one whose condition evaluated false in step 2 — the agent
  // naming a label explicitly overrides the condition, per the plan's
  // unqualified "matched against edge labels").
  if (outcome.preferredLabel !== undefined) {
    const stripped = stripAccelerator(outcome.preferredLabel);
    const match = edges.find((e) => e.label !== undefined && stripAccelerator(e.label) === stripped);
    if (match) return { decision: { nodeId: match.to, reason: "preferred_label", edgeLabel: match.label }, retryEligible: false };
  }

  // Step 4: suggested_next_ids, first that names an existing outgoing edge
  // target (any edge, per the plan's unqualified "existing outgoing edge target").
  if (outcome.suggestedNextIds && outcome.suggestedNextIds.length > 0) {
    for (const id of outcome.suggestedNextIds) {
      const match = edges.find((e) => e.to === id);
      if (match) return { decision: { nodeId: match.to, reason: "suggested" }, retryEligible: false };
    }
  }

  // Step 5: failed outcome, effective on_failure policy.
  if (outcome.status === "failed" && allowOnFailureRewrite) {
    const effective = node.onFailure ?? graph.onFailure;
    if (effective === "succeed") {
      const rewritten = attempt(node, graph, { ...outcome, status: "succeeded" }, context, false);
      return { decision: rewritten.decision, retryEligible: false };
    }
    if (effective === "exit") {
      return { decision: null, retryEligible: true };
    }
    // "route": keep failed and fall through to step 6 below.
  }

  // Step 6: unconditional edges.
  if (unconditionalEdges.length > 0) {
    const [chosen] = byWeightThenTarget(unconditionalEdges);
    return { decision: { nodeId: chosen.to, reason: "unconditional", edgeLabel: chosen.label }, retryEligible: false };
  }

  // Dead end: only a genuinely unresolved failure (status still "failed" here,
  // whether original or fallen through via on_failure="route") is eligible
  // for step 7. A non-failed outcome (e.g. a leaf node that succeeded) must
  // terminate via step 8, not loop back into a retry target.
  return { decision: null, retryEligible: outcome.status === "failed" };
}

/** Steps 1-6. Returns null when the caller should consult step 7 (retry target) next. */
export function selectRoute(input: RouteInput): RouteDecision | null {
  return attempt(input.node, input.graph, input.outcome, input.context, true).decision;
}

/**
 * Whether a null `selectRoute` result should fall through to step 7
 * (retry_target / fallback_retry_target). False for a non-failed outcome
 * that simply has no matching/outgoing edge — that case terminates via step
 * 8 with the node's own outcome instead of consulting a retry target.
 */
export function isRetryEligible(input: RouteInput): boolean {
  return attempt(input.node, input.graph, input.outcome, input.context, true).retryEligible;
}

/**
 * Step 7, full cascade: node `retry_target`, node `fallback_retry_target`,
 * graph `retry_target`, graph `fallback_retry_target` — in that order,
 * restricted to candidates that name an existing node. The caller (the
 * engine) is responsible for walking this list and applying `max_visits`
 * to each candidate in turn, per "subject to max_visits of the target".
 */
export function selectRetryTargetCandidates(node: WorkflowNode, graph: WorkflowGraph): string[] {
  const candidates = [node.retryTarget, node.fallbackRetryTarget, graph.retryTarget, graph.fallbackRetryTarget];
  return candidates.filter((candidate): candidate is string => candidate !== undefined && graph.nodes.has(candidate));
}

/** Step 7, existence-only: first candidate that names an existing node (ignores max_visits). */
export function selectRetryTarget(node: WorkflowNode, graph: WorkflowGraph): string | undefined {
  return selectRetryTargetCandidates(node, graph)[0];
}
