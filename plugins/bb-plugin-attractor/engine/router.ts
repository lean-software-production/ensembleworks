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
// comparing a preferred_label to an edge label.
function stripAccelerator(label: string): string {
  return label
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/^\S+\)\s*/, "")
    .replace(/^\S+\s-\s*/, "");
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

function attempt(node: WorkflowNode, graph: WorkflowGraph, outcome: Outcome, context: Record<string, JsonValue>, allowOnFailureRewrite: boolean): RouteDecision | null {
  // Step 1: jump_to_node bypasses edges entirely.
  if (outcome.jumpToNode !== undefined && graph.nodes.has(outcome.jumpToNode)) {
    return { nodeId: outcome.jumpToNode, reason: "jump" };
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
    return { nodeId: chosen.to, reason: "condition", edgeLabel: chosen.label };
  }

  // Step 3: preferred_label matched against unconditional edge labels.
  if (outcome.preferredLabel !== undefined) {
    const stripped = stripAccelerator(outcome.preferredLabel);
    const match = unconditionalEdges.find((e) => e.label !== undefined && stripAccelerator(e.label) === stripped);
    if (match) return { nodeId: match.to, reason: "preferred_label", edgeLabel: match.label };
  }

  // Step 4: suggested_next_ids, first that names an existing outgoing (unconditional) edge target.
  if (outcome.suggestedNextIds && outcome.suggestedNextIds.length > 0) {
    for (const id of outcome.suggestedNextIds) {
      const match = unconditionalEdges.find((e) => e.to === id);
      if (match) return { nodeId: match.to, reason: "suggested" };
    }
  }

  // Step 5: failed outcome, effective on_failure policy.
  if (outcome.status === "failed" && allowOnFailureRewrite) {
    const effective = node.onFailure ?? graph.onFailure;
    if (effective === "succeed") {
      return attempt(node, graph, { ...outcome, status: "succeeded" }, context, false);
    }
    if (effective === "exit") {
      return null;
    }
    // "route": keep failed and fall through to step 6 below.
  }

  // Step 6: unconditional edges.
  if (unconditionalEdges.length > 0) {
    const [chosen] = byWeightThenTarget(unconditionalEdges);
    return { nodeId: chosen.to, reason: "unconditional", edgeLabel: chosen.label };
  }

  return null;
}

/** Steps 1-6. Returns null when the caller should consult step 7 (retry target) next. */
export function selectRoute(input: RouteInput): RouteDecision | null {
  return attempt(input.node, input.graph, input.outcome, input.context, true);
}

/** Step 7: node then graph retry_target / fallback_retry_target, first candidate that names an existing node. */
export function selectRetryTarget(node: WorkflowNode, graph: WorkflowGraph): string | undefined {
  const candidates = [node.retryTarget, node.fallbackRetryTarget, graph.retryTarget, graph.fallbackRetryTarget];
  for (const candidate of candidates) {
    if (candidate !== undefined && graph.nodes.has(candidate)) return candidate;
  }
  return undefined;
}
