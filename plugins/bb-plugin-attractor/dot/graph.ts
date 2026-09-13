/**
 * AST -> typed WorkflowGraph: shape/type -> handler mapping, attribute
 * typing (booleans, integers, durations, enums), and node[]/edge[]/graph[]
 * default resolution (including subgraph-scoped node/edge defaults).
 *
 * Pure module: no BB imports, no I/O.
 */

import { parseDot, type DotAttr, type DotGraphAst, type DotStatement, type RawValue } from "./parser";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type HandlerKind =
  | "start"
  | "exit"
  | "agent"
  | "prompt"
  | "command"
  | "human"
  | "conditional"
  | "parallel"
  | "parallel.fan_in";

export type OnFailurePolicy = "route" | "exit" | "succeed";
export type ReasoningEffort = "low" | "medium" | "high";
export type JoinPolicy = "all" | "any" | "first";
export type Rankdir = "TB" | "LR" | "BT" | "RL";

export type DotValue = string | number | boolean;

export interface WorkflowNode {
  id: string;
  label?: string;
  shape: string;
  handlerKind: HandlerKind;
  classes: string[];
  prompt?: string;
  script?: string;
  timeoutMs?: number;
  maxVisits?: number;
  maxRetries?: number;
  onFailure?: OnFailurePolicy;
  retryTarget?: string;
  fallbackRetryTarget?: string;
  goalGate: boolean;
  allowPartial: boolean;
  outputSchema?: "routing" | JsonValue;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  maxParallel?: number;
  questionType?: string;
  joinPolicy?: JoinPolicy;
  stdinSource?: string;
  /** Every attribute as written on the node, after basic scalar coercion. Includes unknown/unsupported attributes (e.g. `selection`). */
  attrs: Record<string, DotValue>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  label?: string;
  condition?: string;
  weight: number;
  freeform: boolean;
  loopRestart?: string;
  attrs: Record<string, DotValue>;
}

export interface WorkflowGraph {
  name: string;
  goal?: string;
  rankdir: Rankdir;
  modelStylesheet?: string;
  defaultMaxRetries?: number;
  onFailure: OnFailurePolicy;
  retryTarget?: string;
  fallbackRetryTarget?: string;
  maxNodeVisits: number;
  nodes: Map<string, WorkflowNode>;
  edges: WorkflowEdge[];
  nodeOrder: string[];
}

export class DotGraphError extends Error {}

// ---------------------------------------------------------------------------
// Scalar coercion
// ---------------------------------------------------------------------------

function coerceScalar(raw: RawValue): DotValue {
  const { text } = raw;
  // A quoted value is always a string, however numeric- or boolean-looking its
  // text is (e.g. prompt="0", label="404"): only bare (unquoted) tokens like
  // `true` or `3` are eligible for coercion.
  if (raw.kind === "string") return text;
  if (/^(true|false)$/.test(text)) return text === "true";
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

// Boolean-typed attributes (goal_gate, allow_partial, freeform) must accept
// both a bare `true`/`false` (already coerced to a JS boolean by
// coerceScalar) and a *quoted* "true"/"false" (still a string, per Graphviz's
// "every value is a string" convention: `goal_gate="false"` is idiomatic and
// must mean false, not `Boolean("false") === true`).
function coerceBoolean(value: DotValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value.trim().toLowerCase() === "true";
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const DURATION_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuration(raw: RawValue): number | undefined {
  const text = raw.text;
  const match = DURATION_RE.exec(text);
  if (match) {
    return Number.parseFloat(match[1]) * DURATION_MS[match[2]];
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number.parseFloat(text);
  }
  return undefined;
}

function attrsToMap(attrs: DotAttr[]): Map<string, DotAttr> {
  const map = new Map<string, DotAttr>();
  for (const attr of attrs) map.set(attr.key, attr);
  return map;
}

function rawAttrsBag(attrs: DotAttr[], existing?: Record<string, DotValue>): Record<string, DotValue> {
  const bag: Record<string, DotValue> = { ...existing };
  for (const attr of attrs) bag[attr.key] = coerceScalar(attr.value);
  return bag;
}

// ---------------------------------------------------------------------------
// Shape / type -> handler
// ---------------------------------------------------------------------------

const SHAPE_TO_HANDLER: Record<string, HandlerKind> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "agent",
  tab: "prompt",
  parallelogram: "command",
  hexagon: "human",
  diamond: "conditional",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
};

const TYPE_TO_HANDLER: Record<string, HandlerKind> = {
  start: "start",
  exit: "exit",
  agent: "agent",
  prompt: "prompt",
  command: "command",
  human: "human",
  conditional: "conditional",
  parallel: "parallel",
  "parallel.fan_in": "parallel.fan_in",
  parallel_fan_in: "parallel.fan_in",
  fan_in: "parallel.fan_in",
};

const RESERVED_START_IDS = new Set(["start", "Start"]);
const RESERVED_EXIT_IDS = new Set(["exit", "Exit", "end", "End"]);

function resolveHandlerKind(id: string, shape: string | undefined, type: string | undefined): HandlerKind {
  if (type !== undefined) {
    const mapped = TYPE_TO_HANDLER[type];
    if (mapped) return mapped;
  }
  if (shape !== undefined) {
    const mapped = SHAPE_TO_HANDLER[shape];
    if (mapped) return mapped;
  }
  if (shape === undefined && type === undefined) {
    if (RESERVED_START_IDS.has(id)) return "start";
    if (RESERVED_EXIT_IDS.has(id)) return "exit";
  }
  return "agent";
}

// ---------------------------------------------------------------------------
// Node/edge construction
// ---------------------------------------------------------------------------

interface MutableNode extends WorkflowNode {
  _shapeExplicit: boolean;
  _typeExplicit: boolean;
  _typeValue?: string;
}

function createOrUpdateNode(
  nodes: Map<string, MutableNode>,
  nodeOrder: string[],
  id: string,
  explicitAttrs: DotAttr[],
): MutableNode {
  let node = nodes.get(id);
  if (!node) {
    node = {
      id,
      shape: "box",
      handlerKind: "agent",
      classes: [],
      goalGate: false,
      allowPartial: false,
      attrs: {},
      _shapeExplicit: false,
      _typeExplicit: false,
    };
    nodes.set(id, node);
    nodeOrder.push(id);
  }

  const explicit = attrsToMap(explicitAttrs);
  node.attrs = rawAttrsBag(explicitAttrs, node.attrs);

  const shapeAttr = explicit.get("shape");
  const typeAttr = explicit.get("type");
  if (shapeAttr) {
    node.shape = shapeAttr.value.text;
    node._shapeExplicit = true;
  }
  if (typeAttr) {
    node._typeValue = typeAttr.value.text;
    node._typeExplicit = true;
  }

  node.handlerKind = resolveHandlerKind(
    id,
    node._shapeExplicit ? node.shape : undefined,
    node._typeExplicit ? node._typeValue : undefined,
  );

  if (explicit.has("label")) node.label = coerceScalar(explicit.get("label")!.value) as string;
  if (explicit.has("prompt")) node.prompt = coerceScalar(explicit.get("prompt")!.value) as string;
  if (explicit.has("script")) node.script = coerceScalar(explicit.get("script")!.value) as string;
  if (explicit.has("timeout")) node.timeoutMs = parseDuration(explicit.get("timeout")!.value);
  if (explicit.has("max_visits")) node.maxVisits = Number(coerceScalar(explicit.get("max_visits")!.value));
  if (explicit.has("max_retries")) node.maxRetries = Number(coerceScalar(explicit.get("max_retries")!.value));
  if (explicit.has("on_failure")) node.onFailure = coerceScalar(explicit.get("on_failure")!.value) as OnFailurePolicy;
  if (explicit.has("retry_target")) node.retryTarget = coerceScalar(explicit.get("retry_target")!.value) as string;
  if (explicit.has("fallback_retry_target")) {
    node.fallbackRetryTarget = coerceScalar(explicit.get("fallback_retry_target")!.value) as string;
  }
  if (explicit.has("goal_gate")) node.goalGate = coerceBoolean(coerceScalar(explicit.get("goal_gate")!.value));
  if (explicit.has("allow_partial")) node.allowPartial = coerceBoolean(coerceScalar(explicit.get("allow_partial")!.value));
  if (explicit.has("model")) node.model = coerceScalar(explicit.get("model")!.value) as string;
  if (explicit.has("provider")) node.provider = coerceScalar(explicit.get("provider")!.value) as string;
  if (explicit.has("reasoning_effort")) {
    node.reasoningEffort = coerceScalar(explicit.get("reasoning_effort")!.value) as ReasoningEffort;
  }
  if (explicit.has("max_parallel")) node.maxParallel = Number(coerceScalar(explicit.get("max_parallel")!.value));
  if (explicit.has("question_type")) node.questionType = coerceScalar(explicit.get("question_type")!.value) as string;
  if (explicit.has("join_policy")) node.joinPolicy = coerceScalar(explicit.get("join_policy")!.value) as JoinPolicy;
  if (explicit.has("stdin_source")) node.stdinSource = coerceScalar(explicit.get("stdin_source")!.value) as string;
  if (explicit.has("class")) {
    const raw = coerceScalar(explicit.get("class")!.value);
    node.classes = String(raw).split(/\s+/).filter((s) => s.length > 0);
  }
  if (explicit.has("output_schema")) {
    const raw = explicit.get("output_schema")!.value.text;
    if (raw === "routing") {
      node.outputSchema = "routing";
    } else {
      try {
        node.outputSchema = JSON.parse(raw) as JsonValue;
      } catch {
        node.outputSchema = raw;
      }
    }
  }

  return node;
}

function createEdge(from: string, to: string, explicitAttrs: DotAttr[]): WorkflowEdge {
  const explicit = attrsToMap(explicitAttrs);
  const edge: WorkflowEdge = {
    from,
    to,
    weight: 0,
    freeform: false,
    attrs: rawAttrsBag(explicitAttrs),
  };
  if (explicit.has("label")) edge.label = coerceScalar(explicit.get("label")!.value) as string;
  if (explicit.has("condition")) edge.condition = coerceScalar(explicit.get("condition")!.value) as string;
  if (explicit.has("weight")) edge.weight = Number(coerceScalar(explicit.get("weight")!.value));
  if (explicit.has("freeform")) edge.freeform = coerceBoolean(coerceScalar(explicit.get("freeform")!.value));
  if (explicit.has("loop_restart")) edge.loopRestart = coerceScalar(explicit.get("loop_restart")!.value) as string;
  return edge;
}

// ---------------------------------------------------------------------------
// Statement walk
// ---------------------------------------------------------------------------

interface BuildState {
  nodes: Map<string, MutableNode>;
  edges: WorkflowEdge[];
  nodeOrder: string[];
  graph: {
    goal?: string;
    rankdir: Rankdir;
    modelStylesheet?: string;
    defaultMaxRetries?: number;
    onFailure: OnFailurePolicy;
    retryTarget?: string;
    fallbackRetryTarget?: string;
    maxNodeVisits: number;
  };
}

function applyGraphAttrs(state: BuildState, attrs: DotAttr[]): void {
  const explicit = attrsToMap(attrs);
  if (explicit.has("goal")) state.graph.goal = coerceScalar(explicit.get("goal")!.value) as string;
  if (explicit.has("rankdir")) state.graph.rankdir = coerceScalar(explicit.get("rankdir")!.value) as Rankdir;
  if (explicit.has("model_stylesheet")) {
    state.graph.modelStylesheet = coerceScalar(explicit.get("model_stylesheet")!.value) as string;
  }
  if (explicit.has("default_max_retries")) {
    state.graph.defaultMaxRetries = Number(coerceScalar(explicit.get("default_max_retries")!.value));
  }
  if (explicit.has("on_failure")) {
    state.graph.onFailure = coerceScalar(explicit.get("on_failure")!.value) as OnFailurePolicy;
  }
  if (explicit.has("retry_target")) state.graph.retryTarget = coerceScalar(explicit.get("retry_target")!.value) as string;
  if (explicit.has("fallback_retry_target")) {
    state.graph.fallbackRetryTarget = coerceScalar(explicit.get("fallback_retry_target")!.value) as string;
  }
  if (explicit.has("max_node_visits")) {
    state.graph.maxNodeVisits = Number(coerceScalar(explicit.get("max_node_visits")!.value));
  }
}

function walkStatements(
  statements: DotStatement[],
  state: BuildState,
  nodeDefaults: DotAttr[],
  edgeDefaults: DotAttr[],
): void {
  // Scoped defaults: subgraphs inherit the parent's defaults at entry time,
  // and mutations inside the subgraph do not leak back out.
  let localNodeDefaults = [...nodeDefaults];
  let localEdgeDefaults = [...edgeDefaults];

  const mergeDefaults = (defaults: DotAttr[], attrs: DotAttr[]): DotAttr[] => {
    const merged = new Map<string, DotAttr>();
    for (const a of defaults) merged.set(a.key, a);
    for (const a of attrs) merged.set(a.key, a);
    return [...merged.values()];
  };

  for (const stmt of statements) {
    if (stmt.kind === "attrDefault") {
      if (stmt.target === "graph") {
        applyGraphAttrs(state, stmt.attrs);
      } else if (stmt.target === "node") {
        localNodeDefaults = mergeDefaults(localNodeDefaults, stmt.attrs);
      } else {
        localEdgeDefaults = mergeDefaults(localEdgeDefaults, stmt.attrs);
      }
      continue;
    }

    if (stmt.kind === "node") {
      const merged = mergeDefaults(localNodeDefaults, stmt.attrs);
      createOrUpdateNode(state.nodes, state.nodeOrder, stmt.id, merged);
      continue;
    }

    if (stmt.kind === "edge") {
      for (const id of stmt.chain) {
        if (!state.nodes.has(id)) {
          createOrUpdateNode(state.nodes, state.nodeOrder, id, localNodeDefaults);
        }
      }
      const mergedEdgeAttrs = mergeDefaults(localEdgeDefaults, stmt.attrs);
      for (let i = 0; i < stmt.chain.length - 1; i++) {
        state.edges.push(createEdge(stmt.chain[i], stmt.chain[i + 1], mergedEdgeAttrs));
      }
      continue;
    }

    if (stmt.kind === "subgraph") {
      walkStatements(stmt.statements, state, localNodeDefaults, localEdgeDefaults);
      continue;
    }
  }
}

export function buildWorkflowGraph(ast: DotGraphAst): WorkflowGraph {
  const state: BuildState = {
    nodes: new Map(),
    edges: [],
    nodeOrder: [],
    graph: { rankdir: "TB", onFailure: "route", maxNodeVisits: 0 },
  };

  walkStatements(ast.statements, state, [], []);

  return {
    name: ast.name,
    goal: state.graph.goal,
    rankdir: state.graph.rankdir,
    modelStylesheet: state.graph.modelStylesheet,
    defaultMaxRetries: state.graph.defaultMaxRetries,
    onFailure: state.graph.onFailure,
    retryTarget: state.graph.retryTarget,
    fallbackRetryTarget: state.graph.fallbackRetryTarget,
    maxNodeVisits: state.graph.maxNodeVisits,
    nodes: state.nodes,
    edges: state.edges,
    nodeOrder: state.nodeOrder,
  };
}

export function parseWorkflowGraph(source: string): WorkflowGraph {
  return buildWorkflowGraph(parseDot(source));
}
