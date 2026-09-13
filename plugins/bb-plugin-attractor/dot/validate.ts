/**
 * Structural + semantic lint rules over a WorkflowGraph. Pure module: no BB
 * imports, no I/O.
 */

import type { WorkflowGraph, WorkflowNode } from "./graph";
import { tryParseCondition } from "./conditions";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
}

function error(code: string, message: string, extra?: Partial<Diagnostic>): Diagnostic {
  return { severity: "error", code, message, ...extra };
}

function warning(code: string, message: string, extra?: Partial<Diagnostic>): Diagnostic {
  return { severity: "warning", code, message, ...extra };
}

function requiresPrompt(node: WorkflowNode): boolean {
  return node.handlerKind === "agent" || node.handlerKind === "prompt";
}

function requiresScript(node: WorkflowNode): boolean {
  return node.handlerKind === "command";
}

function checkStartExit(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  const starts = [...graph.nodes.values()].filter((n) => n.handlerKind === "start");
  const exits = [...graph.nodes.values()].filter((n) => n.handlerKind === "exit");

  if (starts.length === 0) {
    diagnostics.push(error("no-start-node", "the graph has no start node (a node with shape=Mdiamond or type=start)"));
  } else if (starts.length > 1) {
    diagnostics.push(
      error(
        "multiple-start-nodes",
        `the graph has more than one start node: ${starts.map((n) => n.id).join(", ")}`,
      ),
    );
  }

  if (exits.length === 0) {
    diagnostics.push(error("no-exit-node", "the graph has no exit node (a node with shape=Msquare or type=exit)"));
  } else if (exits.length > 1) {
    diagnostics.push(
      error(
        "multiple-exit-nodes",
        `the graph has more than one exit node (two exits found): ${exits.map((n) => n.id).join(", ")}`,
      ),
    );
  }
}

function checkReachability(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  const starts = [...graph.nodes.values()].filter((n) => n.handlerKind === "start");
  if (starts.length === 0) return; // already reported by checkStartExit

  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const visited = new Set<string>();
  const queue = starts.map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }

  for (const id of graph.nodeOrder) {
    if (!visited.has(id)) {
      diagnostics.push(warning("unreachable-node", `node '${id}' is not reachable from any start node`, { nodeId: id }));
    }
  }
}

function checkEdgeTargets(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from)) {
      diagnostics.push(
        error("edge-missing-source", `edge references unknown source node '${edge.from}'`, {
          edge: { from: edge.from, to: edge.to },
        }),
      );
    }
    if (!graph.nodes.has(edge.to)) {
      diagnostics.push(
        error("edge-missing-target", `edge from '${edge.from}' targets unknown node '${edge.to}'`, {
          edge: { from: edge.from, to: edge.to },
        }),
      );
    }
  }
}

function checkConditions(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  for (const edge of graph.edges) {
    if (edge.condition === undefined) continue;
    const result = tryParseCondition(edge.condition);
    if (!result.ok) {
      diagnostics.push(
        error("bad-condition", `invalid condition '${edge.condition}' on edge ${edge.from}->${edge.to}: ${result.error}`, {
          edge: { from: edge.from, to: edge.to },
        }),
      );
    }
  }
}

function checkHandlerRequirements(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  for (const node of graph.nodes.values()) {
    if (requiresPrompt(node) && !node.prompt) {
      diagnostics.push(
        error("handler-missing-prompt", `node '${node.id}' (${node.handlerKind}) has no 'prompt' attribute`, {
          nodeId: node.id,
        }),
      );
    }
    if (requiresScript(node) && !node.script) {
      diagnostics.push(
        error("handler-missing-script", `node '${node.id}' (${node.handlerKind}) has no 'script' attribute`, {
          nodeId: node.id,
        }),
      );
    }
  }
}

function checkRetryTargets(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  const check = (target: string | undefined, source: string): void => {
    if (target !== undefined && !graph.nodes.has(target)) {
      diagnostics.push(
        error("retry-target-missing", `retry target '${target}' referenced by ${source} does not exist`),
      );
    }
  };

  check(graph.retryTarget, "the graph's retry_target");
  check(graph.fallbackRetryTarget, "the graph's fallback_retry_target");
  for (const node of graph.nodes.values()) {
    check(node.retryTarget, `node '${node.id}'s retry_target`);
    check(node.fallbackRetryTarget, `node '${node.id}'s fallback_retry_target`);
  }
}

const ON_FAILURE_VALUES = new Set(["route", "exit", "succeed"]);
const REASONING_EFFORT_VALUES = new Set(["low", "medium", "high"]);

function checkEnumsAndNumerics(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  const checkOnFailure = (value: string | undefined, source: string): void => {
    if (value !== undefined && !ON_FAILURE_VALUES.has(value)) {
      diagnostics.push(
        error(
          "invalid-enum-value",
          `${source} has on_failure='${value}', which is not one of route|exit|succeed`,
        ),
      );
    }
  };

  checkOnFailure(graph.onFailure, "the graph");

  for (const node of graph.nodes.values()) {
    checkOnFailure(node.onFailure, `node '${node.id}'`);

    if (node.reasoningEffort !== undefined && !REASONING_EFFORT_VALUES.has(node.reasoningEffort)) {
      diagnostics.push(
        error(
          "invalid-enum-value",
          `node '${node.id}' has reasoning_effort='${node.reasoningEffort}', which is not one of low|medium|high`,
          { nodeId: node.id },
        ),
      );
    }

    if (node.maxVisits !== undefined && Number.isNaN(node.maxVisits)) {
      diagnostics.push(
        error("invalid-numeric-value", `node '${node.id}' has a non-numeric max_visits`, { nodeId: node.id }),
      );
    }
  }
}

// The context-key contract for a `human` (hexagon) gate (handlers/human.ts's
// `gateContextUpdates`) writes both a fixed `human.gate.<selected|label|text>`
// key and a per-node `human.gate.<node id>.<answer|label>` key as flat
// dot-paths merged into the same object. If a gate node's id is literally
// "selected", "label" or "text", the two writes collide on the exact same
// path — one silently overwrites the other (e.g. `human.gate.selected`
// becomes an object instead of the chosen label string) — so it's flagged
// here rather than left to corrupt context silently (validation finding, T6
// round 2).
const RESERVED_HUMAN_GATE_IDS = new Set(["selected", "label", "text"]);

function checkHumanGates(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  for (const node of graph.nodes.values()) {
    if (node.handlerKind !== "human") continue;

    if (RESERVED_HUMAN_GATE_IDS.has(node.id)) {
      diagnostics.push(
        error(
          "human-gate-reserved-id",
          `human gate '${node.id}' has an id reserved by the human.gate.* context-key contract ` +
            `(selected|label|text) — its per-node "human.gate.${node.id}.answer" write would collide ` +
            `with the gate's shared "human.gate.${node.id}" key; rename the node`,
          { nodeId: node.id },
        ),
      );
    }

    const outgoing = graph.edges.filter((e) => e.from === node.id);
    const hasOption = outgoing.some((e) => e.label !== undefined);
    const hasFreeform = outgoing.some((e) => e.freeform);
    if (!hasOption && !hasFreeform) {
      diagnostics.push(
        error(
          "human-gate-no-options",
          `human gate '${node.id}' has no outgoing edge with a label and none marked freeform=true — ` +
            "it can never be answered (only cancelled)",
          { nodeId: node.id },
        ),
      );
    }
  }
}

function checkRandomSelectionConditions(graph: WorkflowGraph, diagnostics: Diagnostic[]): void {
  for (const edge of graph.edges) {
    const source = graph.nodes.get(edge.from);
    if (source && source.attrs.selection === "random" && edge.condition !== undefined) {
      diagnostics.push(
        error(
          "condition-on-random-selection",
          `edge ${edge.from}->${edge.to} has a condition, but '${edge.from}' uses selection=random ` +
            "(unsupported in v1: random selection makes conditional routing unreliable)",
          { edge: { from: edge.from, to: edge.to } },
        ),
      );
    }
  }
}

export function validate(graph: WorkflowGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  checkStartExit(graph, diagnostics);
  checkEdgeTargets(graph, diagnostics);
  checkReachability(graph, diagnostics);
  checkConditions(graph, diagnostics);
  checkHandlerRequirements(graph, diagnostics);
  checkRetryTargets(graph, diagnostics);
  checkHumanGates(graph, diagnostics);
  checkRandomSelectionConditions(graph, diagnostics);
  checkEnumsAndNumerics(graph, diagnostics);
  return diagnostics;
}
