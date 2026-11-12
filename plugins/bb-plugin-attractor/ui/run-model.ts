/**
 * `ui/run-model.ts` — the pure read model behind the run UI (run-panel
 * redesign): which stages form a pass, what is in flight now, what a run
 * needs from a human (the attention card's state), where a node's outcomes
 * route, and the story/raw readings of the event log.
 *
 * No React, no DOM, so it is unit-tested directly (tests/ui/run-model.test.ts)
 * and shared by every surface — the chat card, the side panel and the
 * composer banner all derive their state here, which is what keeps the three
 * from disagreeing. Reads only `server/contracts.ts`, `engine/types.ts` and
 * `dot/accelerator.ts` (see `ui/dag.tsx`'s header on the app-bundle boundary).
 *
 * Everything here has to work for any graph, not only the Gauntlet Loop: no
 * rule below relies on recognising a graph's shape.
 */

import type { GraphEdgeView, GraphNodeView, GraphView, RunView, StageView } from "../server/contracts";
import type { RunEvent } from "../engine/types";
import { parseAcceleratorLabel } from "../dot/accelerator";

export type EventView = RunEvent & { seq: number };

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "<1s" / "12s" / "2m 5s" / "1h 1m 1s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** A coarser duration for summaries: "<1s", "48s", "9m", "2h 14m". */
export function formatShortDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall-clock "HH:MM". */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local wall-clock "HH:MM:SS". */
export function formatClockSeconds(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

export function nodeById(graph: GraphView | null): Map<string, GraphNodeView> {
  return new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
}

export function nodeLabel(graph: GraphView | null, nodeId: string): string {
  return graph?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
}

/** Structural nodes: they route, they do no work of their own. */
export function isStructural(handlerKind: string | undefined): boolean {
  return handlerKind === "start" || handlerKind === "exit" || handlerKind === "conditional" || handlerKind === "parallel" || handlerKind === "parallel.fan_in";
}

/** Whether the graph has any cycle — decides the progress wording only ("n of N stages" makes no sense for a loop). Never used to group stages into passes. */
export function graphHasLoop(graph: GraphView | null): boolean {
  if (!graph) return false;
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      const s = state.get(next);
      if (s === 1) return true;
      if (s === undefined && visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return graph.nodes.some((n) => state.get(n.id) === undefined && visit(n.id));
}

export interface RouteLine {
  /** Plain-language condition: "if it succeeds", "on “Approve”", "when <condition>", "otherwise". */
  when: string;
  to: string;
  toLabel: string;
}

function describeCondition(condition: string): string {
  const c = condition.trim();
  const m = /^outcome\s*=\s*(\w+)$/.exec(c);
  if (m) {
    if (m[1] === "succeeded") return "if it succeeds";
    if (m[1] === "failed") return "if it fails";
    if (m[1] === "partially_succeeded") return "if it partly succeeds";
    return `if it is ${m[1]}`;
  }
  const label = /^preferred_label\s*=\s*(.+)$/.exec(c);
  if (label) return `on “${label[1]!.trim()}”`;
  return `when ${c}`;
}

function describeEdge(edge: GraphEdgeView, siblings: number): string {
  if (edge.label) return `on “${parseAcceleratorLabel(edge.label).text}”`;
  if (edge.condition) return describeCondition(edge.condition);
  return siblings > 1 ? "otherwise" : "next";
}

/** Where each of a node's outcomes routes — the "Goes to" lines. Read straight from the graph, so they hold for conditional routing too (there is no "up next"). */
export function routesFrom(graph: GraphView | null, nodeId: string): RouteLine[] {
  if (!graph) return [];
  const edges = graph.edges.filter((e) => e.from === nodeId);
  return edges.map((e) => ({ when: describeEdge(e, edges.length), to: e.to, toLabel: nodeLabel(graph, e.to) }));
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

export type GroupStatus = "running" | "blocked" | "succeeded" | "failed" | "cancelled";

export interface Pass {
  /** 1-based. */
  index: number;
  stages: StageView[];
  startedAt: number;
  /** Null while any stage in the pass is still in flight. */
  endedAt: number | null;
  status: GroupStatus;
}

function groupStatus(stages: readonly StageView[]): GroupStatus {
  if (stages.some((s) => s.status === "blocked")) return "blocked";
  if (stages.some((s) => s.status === "running")) return "running";
  if (stages.some((s) => s.status === "failed")) return "failed";
  if (stages.some((s) => s.status === "cancelled")) return "cancelled";
  return "succeeded";
}

/**
 * Groups stages into passes without any graph analysis: walk the stages
 * chronologically (the store's insertion order) and start a new group
 * whenever the run re-enters a node already in the current group. A graph
 * with no loop is therefore always exactly one pass. A skipped stage (a node
 * the run could not enter) never starts a pass; it joins the current one.
 */
export function groupPasses(stages: readonly StageView[]): Pass[] {
  const groups: StageView[][] = [];
  let current: StageView[] = [];
  let seen = new Set<string>();
  for (const stage of stages) {
    if (stage.status !== "skipped" && seen.has(stage.nodeId) && current.length > 0) {
      groups.push(current);
      current = [];
      seen = new Set();
    }
    current.push(stage);
    if (stage.status !== "skipped") seen.add(stage.nodeId);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, i) => {
    const inFlight = group.some((s) => s.status === "running" || s.status === "blocked");
    return {
      index: i + 1,
      stages: group,
      startedAt: Math.min(...group.map((s) => s.startedAt)),
      endedAt: inFlight ? null : Math.max(...group.map((s) => s.completedAt ?? s.startedAt)),
      status: groupStatus(group),
    };
  });
}

/** `${nodeId}@${visit}` -> its pass index, for placing events in passes. */
export function passIndexByStageKey(passes: readonly Pass[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const pass of passes) for (const s of pass.stages) map.set(`${s.nodeId}@${s.visit}`, pass.index);
  return map;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type SegmentStatus = "done" | "current" | "waiting" | "failed" | "pending";

export interface Progress {
  /** "3 of 8 stages" for a graph with no loop; "pass 9 · 2h 14m" otherwise. */
  text: string;
  /** One segment per graph node, for a graph with no loop only. */
  segments: SegmentStatus[] | null;
  looping: boolean;
}

function segmentFor(status: GraphNodeView["status"]): SegmentStatus {
  if (status === "running") return "current";
  if (status === "blocked") return "waiting";
  if (status === "failed") return "failed";
  if (status === "succeeded" || status === "skipped") return "done";
  return "pending";
}

export function progressOf(run: RunView, stages: readonly StageView[], graph: GraphView | null, now: number): Progress {
  const elapsed = formatShortDuration(Math.max(0, (run.finishedAt ?? now) - run.createdAt));
  if (graphHasLoop(graph)) {
    const passes = groupPasses(stages).length;
    return { text: passes > 1 ? `${elapsed} · pass ${passes}` : elapsed, segments: null, looping: true };
  }
  const total = graph?.nodes.length ?? 0;
  const visited = new Set(stages.map((s) => s.nodeId)).size;
  return { text: `${visited} of ${total} stages`, segments: graph ? graph.nodes.map((n) => segmentFor(n.status)) : null, looping: false };
}

// ---------------------------------------------------------------------------
// Now
// ---------------------------------------------------------------------------

export function inFlight(stages: readonly StageView[]): StageView[] {
  return stages.filter((s) => s.status === "running" || s.status === "blocked");
}

export interface NowFanOut {
  groupId: string;
  forkLabel: string;
  /** Every branch stage in the group so far, finished ones included. */
  stages: StageView[];
  /** The fan-in node the branches converge on, when the graph names one. */
  joinLabel: string | null;
}

export interface NowView {
  /** Stages in flight on the main walk. */
  stages: StageView[];
  /** Parallel groups with at least one stage in flight. */
  fanOuts: NowFanOut[];
}

/** "Now" is a list: a fan-out has several stages in flight at once. */
export function nowView(stages: readonly StageView[], graph: GraphView | null): NowView {
  const live = inFlight(stages);
  const groups = [...new Set(live.map((s) => s.parallelGroupId).filter((g): g is string => Boolean(g)))];
  const nodes = nodeById(graph);
  const fanOuts = groups.map((groupId) => {
    const members = stages.filter((s) => s.parallelGroupId === groupId);
    const forkNodeId = groupId.replace(/@\d+$/, "");
    const join = graph?.edges.find((e) => members.some((m) => m.nodeId === e.from) && nodes.get(e.to)?.handlerKind === "parallel.fan_in");
    return { groupId, forkLabel: nodeLabel(graph, forkNodeId), stages: members, joinLabel: join ? nodeLabel(graph, join.to) : null };
  });
  return { stages: live.filter((s) => !s.parallelGroupId), fanOuts };
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export interface GateChoice {
  raw: string;
  key: string | null;
  text: string;
  to: string;
  toLabel: string;
  /** The target was already visited: "back to Research". */
  back: boolean;
}

export type AttentionRequest =
  | {
      kind: "gate";
      stage: StageView;
      label: string;
      choices: GateChoice[];
      freeform: boolean;
      reviewTarget: { path: string; text: string | null } | null;
      /** The stage that routed into the gate. */
      after: { nodeId: string; label: string; threadId: string | null } | null;
      since: number;
    }
  | { kind: "worker-prompt"; stage: StageView; label: string; threadId: string | null; what: string; since: number }
  | { kind: "provider-pause"; stage: StageView; label: string; reason: string; retryAt: number; since: number; threadId: string | null };

export type Attention =
  | { kind: "requests"; requests: AttentionRequest[] }
  | { kind: "running"; stages: StageView[] }
  | {
      kind: "failed";
      cancelled: boolean;
      /** The stage the run stopped on, when known. */
      stage: StageView | null;
      label: string | null;
      handlerKind: string | null;
      reason: string | null;
      /** The tail of the stage's own output (a command's stdout), when the run context has it. */
      output: string | null;
      /** "Prepare reached its visit limit" when a max-visits skip ended the run. */
      endedBy: string | null;
      /** The node Resume re-enters (the run's checkpoint), when known. */
      resumeLabel: string | null;
    }
  | {
      kind: "finished";
      /** The last stage that did work, and its own output — for most graphs, the result. */
      label: string | null;
      output: string | null;
      threadId: string | null;
    };

/** The "Rate limited" in "Rate limited, retrying at …" — the pause reason without the time, which the card shows as data. */
function pauseReason(stage: StageView): string {
  const reason = stage.waitingReason ?? "Provider unavailable";
  const comma = reason.indexOf(", retrying at");
  return comma >= 0 ? reason.slice(0, comma) : reason;
}

/** A human gate's choices, from its labelled outgoing edges (the same rule handlers/human.ts uses), each with where it leads. */
export function gateChoices(graph: GraphView | null, nodeId: string, visitedNodeIds: ReadonlySet<string>): GateChoice[] {
  if (!graph) return [];
  return graph.edges
    .filter((e): e is GraphEdgeView & { label: string } => e.from === nodeId && e.label !== null)
    .map((e) => {
      const { key, text } = parseAcceleratorLabel(e.label);
      return { raw: e.label, key, text, to: e.to, toLabel: nodeLabel(graph, e.to), back: visitedNodeIds.has(e.to) };
    });
}

function contextString(run: RunView, path: string[]): string | null {
  let cursor: unknown = run.context;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

/** The last few lines of `text`, with a count of what was cut. */
export function tailLines(text: string, lines: number): { text: string; omitted: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  if (all.length <= lines) return { text: all.join("\n"), omitted: 0 };
  return { text: all.slice(-lines).join("\n"), omitted: all.length - lines };
}

function attentionRequests(run: RunView, stages: readonly StageView[], graph: GraphView | null): AttentionRequest[] {
  const nodes = nodeById(graph);
  const visited = new Set(stages.map((s) => s.nodeId));
  const gates: AttentionRequest[] = [];
  const prompts: AttentionRequest[] = [];
  const pauses: AttentionRequest[] = [];
  for (const stage of stages) {
    if (stage.status !== "blocked") continue;
    const node = nodes.get(stage.nodeId);
    const label = node?.label ?? stage.nodeId;
    if (node?.handlerKind === "human" || (!stage.waitingReason && stage.gateContext)) {
      const context = stage.gateContext?.context ?? null;
      gates.push({
        kind: "gate",
        stage,
        label,
        choices: gateChoices(graph, stage.nodeId, visited),
        freeform: Boolean(graph?.edges.some((e) => e.from === stage.nodeId && e.freeform)),
        reviewTarget: stage.gateContext?.reviewTarget ?? null,
        after: context ? { nodeId: context.nodeId, label: context.label ?? nodeLabel(graph, context.nodeId), threadId: context.threadId } : null,
        since: stage.startedAt,
      });
    } else if (stage.waitingUntil != null) {
      pauses.push({ kind: "provider-pause", stage, label, reason: pauseReason(stage), retryAt: stage.waitingUntil, since: stage.waitingSince ?? stage.startedAt, threadId: stage.threadId });
    } else {
      prompts.push({ kind: "worker-prompt", stage, label, threadId: stage.threadId, what: stage.waitingReason ?? "a prompt", since: stage.waitingSince ?? stage.startedAt });
    }
  }
  return [...gates, ...prompts, ...pauses];
}

/** A failure reason without trailing whitespace or a dangling ":" ("exit code 1: " with no stderr). */
function cleanReason(reason: string | undefined | null): string | null {
  const text = reason?.trim().replace(/:$/, "").trim();
  return text ? text : null;
}

/** The latest failure detail the event log has for a stage (a thrown error, or a failed outcome's reason). */
function failureReasonFor(events: readonly EventView[], stage: StageView | null): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "run.failed") return e.error;
    if (!stage) continue;
    if (e.type === "stage.failed" && e.nodeId === stage.nodeId && e.visit === stage.visit) return e.error;
    if (e.type === "stage.completed" && e.nodeId === stage.nodeId && e.visit === stage.visit && cleanReason(e.outcome.failureReason)) return cleanReason(e.outcome.failureReason);
  }
  return null;
}

/**
 * What a run needs, or that it needs nothing — the attention card's state.
 * `events` is optional: the composer banner has none (it only ever shows
 * in-flight runs, whose state comes entirely from the stage rows), and the
 * failed/finished detail falls back to the run row without them.
 */
export function deriveAttention(run: RunView, stages: readonly StageView[], graph: GraphView | null, events: readonly EventView[] = []): Attention {
  const nodes = nodeById(graph);
  if (run.status === "running" || run.status === "blocked") {
    const requests = attentionRequests(run, stages, graph);
    if (requests.length > 0) return { kind: "requests", requests };
    return { kind: "running", stages: inFlight(stages) };
  }
  if (run.status === "failed" || run.status === "cancelled") {
    const cancelled = run.status === "cancelled";
    const gateFailure = run.goalGateFailures[0];
    const working = (s: StageView) => !isStructural(nodes.get(s.nodeId)?.handlerKind);
    const stage =
      // A routing node (a `diamond`) only passes on its predecessor's
      // outcome: blame the working stage that actually failed.
      [...stages].reverse().find((s) => (cancelled ? s.status === "cancelled" : s.status === "failed") && working(s) && (!gateFailure || s.nodeId === gateFailure)) ??
      [...stages].reverse().find((s) => (cancelled ? s.status === "cancelled" : s.status === "failed") && (!gateFailure || s.nodeId === gateFailure)) ??
      [...stages].reverse().find((s) => s.status === "failed" || s.status === "cancelled") ??
      [...stages].reverse().find((s) => !isStructural(nodes.get(s.nodeId)?.handlerKind)) ??
      null;
    const node = stage ? nodes.get(stage.nodeId) : undefined;
    let reason = cancelled ? null : (failureReasonFor(events, stage) ?? run.error);
    if (!reason && gateFailure) reason = `goal gate ${nodeLabel(graph, gateFailure)} did not succeed`;
    const output = stage ? contextString(run, ["response", stage.nodeId]) : null;
    // A run that ends because a node was skipped for its visit limit says so —
    // a fact straight from the event log, not an analysis of the graph.
    const lastSkip = [...events].reverse().find((e) => e.type === "stage.skipped" || e.type === "stage.started");
    const endedBy = lastSkip?.type === "stage.skipped" && lastSkip.reason === "max_visits_exceeded" ? `${nodeLabel(graph, lastSkip.nodeId)} reached its visit limit` : null;
    return {
      kind: "failed",
      endedBy,
      cancelled,
      stage,
      label: stage ? (node?.label ?? stage.nodeId) : null,
      handlerKind: node?.handlerKind ?? null,
      reason,
      output: output && output.trim() ? output : null,
      resumeLabel: run.currentNodeId ? nodeLabel(graph, run.currentNodeId) : stage ? (node?.label ?? stage.nodeId) : null,
    };
  }
  // The result is the last agent's or command's own output; a closing human
  // gate's answer is a decision (listed as such), not the run's result.
  const doneWorking = (s: StageView) => !isStructural(nodes.get(s.nodeId)?.handlerKind) && s.status === "succeeded";
  const last =
    [...stages].reverse().find((s) => doneWorking(s) && nodes.get(s.nodeId)?.handlerKind !== "human") ?? [...stages].reverse().find(doneWorking) ?? null;
  const output = last ? contextString(run, ["response", last.nodeId]) : null;
  return { kind: "finished", label: last ? nodeLabel(graph, last.nodeId) : null, output: output && output.trim() ? output.trim() : null, threadId: last?.threadId ?? null };
}

export type PillTone = "run" | "warn" | "bad" | "ok" | "muted";

/** The status pill's word and tone — "Needs you" for a gate or a worker's prompt, "Paused" for a provider pause. */
export function statusPill(run: RunView, attention: Attention): { word: string; tone: PillTone } {
  switch (run.status) {
    case "succeeded":
      return { word: "Succeeded", tone: "ok" };
    case "failed":
      return { word: "Failed", tone: "bad" };
    case "cancelled":
      return { word: "Stopped", tone: "muted" };
    default:
      if (attention.kind === "requests") {
        const first = attention.requests[0]!;
        return first.kind === "provider-pause" ? { word: "Paused", tone: "warn" } : { word: "Needs you", tone: "run" };
      }
      return { word: "Running", tone: "run" };
  }
}

// ---------------------------------------------------------------------------
// Waits (from the event log): when each worker wait began and ended
// ---------------------------------------------------------------------------

export interface WaitSpan {
  start: number;
  end: number | null;
}

/** `${nodeId}@${visit}` -> its worker waits (agent.waiting … agent.resumed), so history can show working time apart from waiting time. */
export function waitSpansByStage(events: readonly EventView[]): Map<string, WaitSpan[]> {
  const spans = new Map<string, WaitSpan[]>();
  for (const e of events) {
    if (e.type !== "agent.waiting" && e.type !== "agent.resumed" && e.type !== "stage.completed" && e.type !== "stage.failed") continue;
    const key = e.type === "stage.completed" || e.type === "stage.failed" ? `${e.nodeId}@${e.visit}` : stageKey(e.stageId);
    const list = spans.get(key) ?? [];
    const open = list.at(-1);
    if (e.type === "agent.waiting") {
      if (!open || open.end !== null) list.push({ start: e.ts, end: null });
    } else if (open && open.end === null) {
      open.end = e.ts;
    }
    spans.set(key, list);
  }
  return spans;
}

/** "build@9#1" or "build@9" -> "build@9". */
export function stageKey(stageId: string): string {
  const hash = stageId.indexOf("#");
  return hash >= 0 ? stageId.slice(0, hash) : stageId;
}

// ---------------------------------------------------------------------------
// Event log: story and raw readings
// ---------------------------------------------------------------------------

export type StoryTone = "ok" | "run" | "warn" | "bad" | "muted";
export type StoryKind = "milestone" | "routing" | "checkpoint";

export interface StoryItem {
  seq: number;
  ts: number;
  pass: number;
  tone: StoryTone;
  kind: StoryKind;
  /** The stage's label, rendered bold ahead of `text` — null for run-level lines. */
  subject: string | null;
  text: string;
  /** Muted trailing detail ("9m 50s"). */
  detail: string | null;
  threadId: string | null;
}

function firstLine(text: string | undefined): string | null {
  if (!text) return null;
  const line = text.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line.trim();
}

/**
 * The event log rewritten as what happened: one line per milestone, each
 * placed in the pass it belongs to. Routing (`edge.selected`, structural
 * nodes) and checkpoint events are still returned, tagged, so the caller can
 * hide and count them. `agent.thread` is folded into the stage's "started"
 * line as its worker link rather than given a line of its own.
 */
export function storyItems(events: readonly EventView[], stages: readonly StageView[], graph: GraphView | null): StoryItem[] {
  const nodes = nodeById(graph);
  const passByKey = passIndexByStageKey(groupPasses(stages));
  const items: StoryItem[] = [];
  const startedItemByKey = new Map<string, StoryItem>();
  let pass = 1;
  const label = (nodeId: string) => nodes.get(nodeId)?.label ?? nodeId;
  const kindOf = (nodeId: string) => nodes.get(nodeId)?.handlerKind;
  const push = (event: EventView, item: Omit<StoryItem, "seq" | "ts" | "pass">) => {
    const created = { seq: event.seq, ts: event.ts, pass, ...item };
    items.push(created);
    return created;
  };
  for (const e of events) {
    if ("nodeId" in e && "visit" in e) pass = passByKey.get(`${e.nodeId}@${e.visit}`) ?? pass;
    else if ("stageId" in e && e.stageId && e.type !== "checkpoint.saved") pass = passByKey.get(stageKey(e.stageId)) ?? pass;
    switch (e.type) {
      case "run.started":
        push(e, { tone: "muted", kind: "milestone", subject: null, text: "Run started", detail: null, threadId: null });
        break;
      case "run.resumed":
        push(e, { tone: "run", kind: "milestone", subject: null, text: e.fromNodeId ? `Resumed from ${label(e.fromNodeId)}` : "Resumed", detail: null, threadId: null });
        break;
      case "run.completed":
        push(e, {
          tone: e.status === "succeeded" ? "ok" : "bad",
          kind: "milestone",
          subject: null,
          text: e.status === "succeeded" ? "Run succeeded" : `Run failed${e.goalGateFailures.length ? `: goal gate ${e.goalGateFailures.map(label).join(", ")} did not succeed` : ""}`,
          detail: null,
          threadId: null,
        });
        break;
      case "run.failed":
        push(e, { tone: "bad", kind: "milestone", subject: null, text: `Run failed: ${e.error}`, detail: null, threadId: null });
        break;
      case "run.cancelled":
        push(e, { tone: "muted", kind: "milestone", subject: null, text: "Run stopped", detail: null, threadId: null });
        break;
      case "stage.started": {
        const kind = kindOf(e.nodeId);
        if (isStructural(kind)) break;
        if (kind !== "agent" && kind !== "prompt") break; // a command's or gate's own line says enough
        const retry = e.attempt > 1 ? ` (attempt ${e.attempt})` : "";
        startedItemByKey.set(`${e.nodeId}@${e.visit}`, push(e, { tone: "run", kind: "milestone", subject: label(e.nodeId), text: `started${retry}`, detail: null, threadId: null }));
        break;
      }
      case "agent.thread": {
        const started = startedItemByKey.get(stageKey(e.stageId));
        if (started) started.threadId = e.threadId;
        break;
      }
      case "stage.completed": {
        const kind = kindOf(e.nodeId);
        const took = formatDuration(e.wallTimeMs);
        if (isStructural(kind)) {
          push(e, { tone: "muted", kind: "routing", subject: label(e.nodeId), text: e.outcome.status, detail: null, threadId: null });
          break;
        }
        if (e.outcome.status === "failed") {
          push(e, { tone: "bad", kind: "milestone", subject: label(e.nodeId), text: `failed${cleanReason(e.outcome.failureReason) ? `: ${cleanReason(e.outcome.failureReason)}` : ""}`, detail: took, threadId: null });
        } else if (kind === "command") {
          const out = firstLine(e.outcome.text);
          push(e, { tone: "ok", kind: "milestone", subject: label(e.nodeId), text: out ? `: ${out}` : "passed", detail: out ? null : took, threadId: null });
        } else if (kind === "human") {
          // The answer line (human.answered) already says what happened.
        } else {
          push(e, { tone: "ok", kind: "milestone", subject: label(e.nodeId), text: e.outcome.status === "partially_succeeded" ? "partly succeeded" : "finished", detail: took, threadId: null });
        }
        break;
      }
      case "stage.failed":
        push(e, { tone: e.willRetry ? "warn" : "bad", kind: "milestone", subject: label(e.nodeId), text: `failed: ${e.error}${e.willRetry ? " (will retry)" : ""}`, detail: null, threadId: null });
        break;
      case "stage.skipped":
        push(e, { tone: "muted", kind: "routing", subject: label(e.nodeId), text: `skipped: ${e.reason.replace(/_/g, " ")}`, detail: null, threadId: null });
        break;
      case "agent.waiting":
        if (e.retryAt !== undefined) {
          push(e, { tone: "warn", kind: "milestone", subject: label(e.nodeId), text: `paused: ${(e.title ?? "provider unavailable").toLowerCase()}, retry queued for ${formatClock(e.retryAt)}`, detail: null, threadId: e.threadId });
        } else {
          push(e, { tone: "warn", kind: "milestone", subject: label(e.nodeId), text: `is waiting on ${e.title ?? e.kind} in its worker`, detail: null, threadId: e.threadId });
        }
        break;
      case "agent.resumed":
        push(e, { tone: "run", kind: "milestone", subject: label(e.nodeId), text: "resumed", detail: null, threadId: null });
        break;
      case "human.requested":
        push(e, { tone: "warn", kind: "milestone", subject: label(e.nodeId), text: "is waiting for you", detail: null, threadId: null });
        break;
      case "human.answered":
        push(e, {
          tone: e.answer ? "ok" : "bad",
          kind: "milestone",
          subject: label(e.nodeId),
          text: e.answer ? (e.actor === "default" ? `timed out; took “${e.answer}”` : `answered “${e.answer}”`) : "was not answered",
          detail: null,
          threadId: null,
        });
        break;
      case "edge.selected":
        push(e, { tone: "muted", kind: "routing", subject: null, text: `${label(e.from)} → ${label(e.to)}${e.edgeLabel ? ` (${parseAcceleratorLabel(e.edgeLabel).text})` : ""}`, detail: e.reason.replace(/_/g, " "), threadId: null });
        break;
      case "checkpoint.saved":
        push(e, { tone: "muted", kind: "checkpoint", subject: null, text: `Checkpoint before ${label(e.stageId)}`, detail: null, threadId: null });
        break;
      case "log":
        push(e, { tone: "muted", kind: "milestone", subject: null, text: e.message, detail: null, threadId: null });
        break;
      default:
        break;
    }
  }
  return items;
}

/** One raw event as one line: "stage.started build@8#1", "agent.waiting build@9 Rate limited, …". */
export function rawEventText(e: EventView): string {
  switch (e.type) {
    case "run.started":
    case "run.cancelled":
      return e.type;
    case "run.resumed":
      return `${e.type} ${e.fromNodeId ?? "(start)"}`;
    case "run.completed":
      return `${e.type} ${e.status}${e.goalGateFailures.length ? ` goal_gate_failures=${e.goalGateFailures.join(",")}` : ""}`;
    case "run.failed":
      return `${e.type} ${e.error}`;
    case "stage.started":
      return `${e.type} ${e.stageId}${e.parallelGroupId ? ` group=${e.parallelGroupId} branch=${e.branchIndex}` : ""}`;
    case "stage.completed":
      return `${e.type} ${e.stageId} ${e.outcome.status} ${Math.round(e.wallTimeMs / 100) / 10}s${e.outcome.failureReason ? ` ${e.outcome.failureReason}` : ""}`;
    case "stage.failed":
      return `${e.type} ${e.stageId} ${e.error}${e.willRetry ? " (will retry)" : ""}`;
    case "stage.skipped":
      return `${e.type} ${e.stageId} ${e.reason}`;
    case "edge.selected":
      return `${e.type} ${e.from}→${e.to} ${e.reason}${e.edgeLabel ? ` ${e.edgeLabel}` : ""}`;
    case "agent.thread":
      return `${e.type} ${e.stageId} ${e.threadId} ${e.provider}/${e.model}${e.reasoningLevel ? ` ${e.reasoningLevel}` : ""}`;
    case "agent.waiting":
      return `${e.type} ${e.stageId} ${e.kind}${e.title && e.title !== e.kind ? ` (${e.title})` : ""}`;
    case "agent.resumed":
      return `${e.type} ${e.stageId} ${e.threadId}`;
    case "human.requested":
      return `${e.type} ${e.stageId}${e.options?.length ? ` options=${e.options.join("|")}` : ""}`;
    case "human.answered":
      return `${e.type} ${e.stageId}${e.answer ? ` ${e.answer}` : ""}${e.actor ? ` via ${e.actor}` : ""}`;
    case "checkpoint.saved":
      return `${e.type} next=${e.stageId}`;
    case "log":
      return `${e.type}${e.stageId ? ` ${e.stageId}` : ""} ${e.message}`;
    default:
      return (e as { type: string }).type;
  }
}

/** The full raw line, as copied: "#215 18:41:27 agent.waiting build@9 …". */
export function rawEventLine(e: EventView): string {
  return `#${e.seq} ${formatClockSeconds(e.ts)} ${rawEventText(e)}`;
}

/** Case-insensitive match against the raw line and the event's full JSON (type, node, text). */
export function eventMatches(e: EventView, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return rawEventLine(e).toLowerCase().includes(q) || JSON.stringify(e).toLowerCase().includes(q);
}

// ---------------------------------------------------------------------------
// History list
// ---------------------------------------------------------------------------

export type StageKindChip = "all" | "agents" | "commands" | "gates" | "failed";

export function stageMatchesChip(stage: StageView, node: GraphNodeView | undefined, chip: StageKindChip): boolean {
  switch (chip) {
    case "all":
      return true;
    case "agents":
      return node?.handlerKind === "agent" || node?.handlerKind === "prompt";
    case "commands":
      return node?.handlerKind === "command";
    case "gates":
      return node?.handlerKind === "human";
    case "failed":
      return stage.status === "failed";
  }
}
