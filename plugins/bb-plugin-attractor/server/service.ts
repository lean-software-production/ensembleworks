/**
 * Run lifecycle, realtime publishing, and resume, per
 * docs/plans/2026-09-13-attractor-runner-plan.md "Plugin layout"
 * (`server/service.ts`) and T4's acceptance criteria. `server.ts` wires this
 * to `bb`; kept separate so the orchestration is testable with a fake `bb`
 * host and a real in-memory RunStore, without touching CLI/tool/RPC glue.
 */

import { randomUUID } from "node:crypto";
import posixPath from "node:path/posix";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseWorkflowGraph, type WorkflowGraph } from "../dot/graph";
import { validate as validateGraph } from "../dot/validate";
import { createContext } from "../engine/context";
import { runEngine } from "../engine/engine";
import type { Checkpoint, HandlerRegistry, JsonValue, Outcome, RunEvent } from "../engine/types";
import { createAgentHandler, type AgentHandlerContext } from "../handlers/agent";
import { createPromptHandler } from "../handlers/prompt";
import { createCommandHandler, type CommandExecInput, type CommandExecResult } from "../handlers/command";
import { conditionalHandler } from "../handlers/conditional";
import { forkHandler, joinHandler } from "../handlers/parallel";
import { createHumanHandler, type HumanHandlerContext, type HumanInterviewer, type ReviewTargetSummary } from "../handlers/human";
import { startHandler, exitHandler } from "../handlers/start-exit";
import type { AgentBackend } from "./backend";
import { HUMAN_GATE_RENDERER_ID, humanGatePayloadSchema, humanGateValueSchema, type HumanGatePayload } from "./contracts";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type ExecOutput } from "../host-contract";
import { RunStore, type GateContextSummary, type Run, type Stage } from "./store";

const REALTIME_CHANNEL = "attractor-runs";

/** Decodes a `bb.sdk.files.read` result's content, honouring its `contentEncoding`. Shared by `resolveSource`/`server.ts` (a workflow's DOT source) and `readReviewTargetFile` below (a gate's `review_target` file). */
export function decodeFileContent(file: { content: string; contentEncoding: "utf8" | "base64" }): string {
  return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
}

// -----------------------------------------------------------------------
// Path resolution — "resolves `path` relative to the origin thread's
// environment path (reject traversal outside it)".
// -----------------------------------------------------------------------

export function resolveWorkflowPath(relativePath: string, environmentPath: string): string {
  if (posixPath.isAbsolute(relativePath)) {
    throw new Error(`workflow path must be relative to the environment root, got an absolute path: ${relativePath}`);
  }
  // A trailing slash survives posixPath.normalize() (e.g. "/repo/" stays
  // "/repo/"), which would otherwise make every relative path compare against
  // the wrong prefix ("/repo//...") below and get rejected as "escaping" a
  // root that never had one. Strip it (root "/" itself normalizes to "" here,
  // so it falls back to "/").
  const root = posixPath.normalize(environmentPath).replace(/\/+$/, "") || "/";
  const resolved = posixPath.normalize(posixPath.join(root, relativePath));
  // Root "/" is its own prefix ("//" is not); every other root needs the
  // trailing slash added back on to avoid a sibling directory with the same
  // prefix (e.g. root "/repo" must not admit a resolved "/repo-evil/...").
  const prefix = root === "/" ? root : `${root}/`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error(`workflow path escapes the environment root: ${relativePath}`);
  }
  return resolved;
}

// -----------------------------------------------------------------------
// review_target reading (gate-context follow-up) — handlers/human.ts's
// injected `HumanHandlerContext.readReviewTarget`, with hostId/
// environmentPath already baked in by `buildHandlers` below (the same way
// `buildHandlers`'s `command` handler closure already bakes in `envCtx.
// environmentPath` as `cwd`).
// -----------------------------------------------------------------------

const REVIEW_TARGET_CONTENT_LIMIT = 60_000;

function truncateReviewTarget(text: string): string {
  return text.length > REVIEW_TARGET_CONTENT_LIMIT ? `${text.slice(0, REVIEW_TARGET_CONTENT_LIMIT)} …[truncated]` : text;
}

async function readReviewTargetFile(bb: BbPluginApi, envCtx: RunEnvironmentContext, path: string): Promise<ReviewTargetSummary> {
  let resolved: string;
  try {
    resolved = resolveWorkflowPath(path, envCtx.environmentPath);
  } catch (err) {
    // Rejected (e.g. path traversal): reported on the gate payload's own
    // `reviewTarget.error`, never thrown — a bad `review_target` must not
    // take down the whole gate (see handlers/human.ts's `buildReviewTarget`).
    return { path, content: null, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const file = await bb.sdk.files.read({ hostId: envCtx.hostId, path: resolved });
    if ("notModified" in file) return { path, content: null, error: "not found" };
    return { path, content: truncateReviewTarget(decodeFileContent(file)), error: null };
  } catch {
    // Any read failure (most commonly ENOENT) is reported the same way — see
    // README "Deviations from the plan" (gate context).
    return { path, content: null, error: "not found" };
  }
}

// -----------------------------------------------------------------------
// Graph view (RPC/CLI read model)
// -----------------------------------------------------------------------

export interface GraphNodeView {
  id: string;
  label: string | null;
  shape: string;
  handlerKind: string;
  goalGate: boolean;
  status: Stage["status"] | null;
  visit: number;
  /** The node's declared (DOT-attribute) model/provider — not the live-resolved
   * stylesheet/thread-default tuple, which server/backend.ts resolves per-run
   * and does not persist per-stage. See README "Deviations from the plan". */
  model: string | null;
  provider: string | null;
  /** The latest stage's waiting reason (kind), when this node is currently "blocked" — null otherwise (dogfood-2 fix's `agent.waiting`). */
  waitingReason: string | null;
}
export interface GraphEdgeView {
  from: string;
  to: string;
  label: string | null;
  condition: string | null;
}
export interface GraphView {
  rankdir: WorkflowGraph["rankdir"];
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
}

function toGraphView(graph: WorkflowGraph, stages: Stage[]): GraphView {
  const latestByNode = new Map<string, Stage>();
  for (const stage of stages) latestByNode.set(stage.nodeId, stage);
  const nodes = graph.nodeOrder.map((id) => {
    const node = graph.nodes.get(id)!;
    const stage = latestByNode.get(id);
    return {
      id,
      label: node.label ?? null,
      shape: node.shape,
      handlerKind: node.handlerKind,
      goalGate: node.goalGate,
      status: stage?.status ?? null,
      visit: stage?.visit ?? 0,
      model: node.model ?? null,
      provider: node.provider ?? null,
      waitingReason: stage?.waitingReason ?? null,
    };
  });
  const edges = graph.edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.label ?? null, condition: edge.condition ?? null }));
  return { rankdir: graph.rankdir, nodes, edges };
}

// -----------------------------------------------------------------------
// Stage/event persistence
// -----------------------------------------------------------------------

function parseVisitFromStageId(stageId: string, nodeId: string): number {
  const suffix = stageId.slice(nodeId.length + 1);
  const visit = Number.parseInt(suffix, 10);
  return Number.isFinite(visit) ? visit : 0;
}

// `attractor_run`'s tool schema (and `bb attractor run --input k=v`) can only
// produce a *flat* map of scalars — a recursive JSON schema isn't accepted by
// every model provider's tool list (see server.ts's `scalarValueSchema`
// comment) — so a caller wanting to set a nested context value like
// `human.default_choice` (per skills/attractor/SKILL.md and README's
// documented timeout fallback) can only ever send it as a literal dotted key:
// `inputs: { "human.default_choice": "..." }`. `Context`'s reads/writes are
// dot-path (`context.get("human.default_choice")`, `dot/conditions.ts`'s
// `context.<path>`), so a flat top-level key would be invisible to both.
// Expand every `inputs` key through the same dot-path merge an agent's
// `context_updates` already goes through, before it's ever persisted as the
// run's initial context.
function expandFlatInputsToContext(inputs: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  const context = createContext();
  context.merge(inputs);
  return context.toObject();
}

function outcomeStageStatus(outcome: Outcome): Stage["status"] {
  if (outcome.status === "skipped") return "skipped";
  if (outcome.status === "failed") return "failed";
  return "succeeded";
}

function applyEventToStore(store: RunStore, runId: string, event: RunEvent): void {
  switch (event.type) {
    case "stage.started":
      store.upsertStage(runId, { stageId: event.stageId, nodeId: event.nodeId, visit: event.visit, attempt: event.attempt, status: "running", outcomeStatus: null, threadId: null, startedAt: event.ts });
      return;
    case "stage.completed":
      store.upsertStage(runId, {
        stageId: event.stageId,
        nodeId: event.nodeId,
        visit: event.visit,
        attempt: event.attempt,
        status: outcomeStageStatus(event.outcome),
        outcomeStatus: event.outcome.status,
        threadId: null,
        startedAt: event.ts - event.wallTimeMs,
        completedAt: event.ts,
      });
      return;
    case "stage.failed":
      store.upsertStage(runId, { stageId: event.stageId, nodeId: event.nodeId, visit: event.visit, attempt: event.attempt, status: "failed", outcomeStatus: null, threadId: null, startedAt: event.ts, completedAt: event.ts });
      return;
    case "stage.skipped":
      store.upsertStage(runId, { stageId: event.stageId, nodeId: event.nodeId, visit: parseVisitFromStageId(event.stageId, event.nodeId), attempt: 1, status: "skipped", outcomeStatus: null, threadId: null, startedAt: event.ts, completedAt: event.ts });
      return;
    case "agent.thread": {
      const visit = parseVisitFromStageId(event.stageId, event.nodeId);
      store.setStageThreadId(runId, event.nodeId, visit, event.threadId);
      store.setStageProvider(runId, event.nodeId, visit, event.provider, event.model, event.reasoningLevel);
      return;
    }
    // T6: a human gate is waiting on its answer — surface that on both the
    // stage and the run ("run status blocked while waiting"), and clear it
    // back to "running" once the gate is answered. Neither status is ever
    // terminal: recordFinish (called once the whole run ends) always
    // overwrites the run's status with succeeded/failed/cancelled.
    case "human.requested": {
      const visit = parseVisitFromStageId(event.stageId, event.nodeId);
      store.setStageStatus(runId, event.nodeId, visit, "blocked");
      store.setStatus(runId, "blocked");
      // Gate-context follow-up: persist the "what is being reviewed" summary
      // on the stage row so `bb attractor stages` and the run panel can show
      // it without re-reading the event log — null when neither a
      // predecessor context nor a review_target was found.
      const gateContext: GateContextSummary | null = event.context || event.reviewTarget ? { context: event.context ?? null, reviewTarget: event.reviewTarget ?? null } : null;
      store.setStageGateContext(runId, event.nodeId, visit, gateContext);
      return;
    }
    case "human.answered": {
      const visit = parseVisitFromStageId(event.stageId, event.nodeId);
      store.setStageStatus(runId, event.nodeId, visit, "running");
      store.setStatus(runId, "running");
      if (event.actor) store.setStageActor(runId, event.nodeId, visit, event.actor);
      return;
    }
    // Dogfood-2 fix: a worker thread stopped on its own pending interaction —
    // mirrors human.requested/answered above (blocked stage + blocked run),
    // with the interaction's kind persisted as the stage's waiting reason so
    // both the stage table and the DAG can show *what* it's waiting on.
    case "agent.waiting": {
      const visit = parseVisitFromStageId(event.stageId, event.nodeId);
      store.setStageStatus(runId, event.nodeId, visit, "blocked");
      store.setStageWaitingReason(runId, event.nodeId, visit, event.kind);
      store.setStatus(runId, "blocked");
      return;
    }
    case "agent.resumed": {
      const visit = parseVisitFromStageId(event.stageId, event.nodeId);
      store.setStageStatus(runId, event.nodeId, visit, "running");
      store.setStageWaitingReason(runId, event.nodeId, visit, null);
      // Only clear the run's own "blocked" status if nothing else is still
      // waiting (another agent.waiting stage, or an unrelated human gate).
      const stillBlocked = store.listStages(runId).some((s) => s.status === "blocked");
      if (!stillBlocked) store.setStatus(runId, "running");
      return;
    }
    default:
      return;
  }
}

// -----------------------------------------------------------------------
// Clock (real, abortable sleep)
// -----------------------------------------------------------------------

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const REAL_CLOCK = { now: () => Date.now(), sleep: sleepAbortable };

// -----------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------

export interface ExecClient {
  call(method: "exec", input: CommandExecInput & { cwd: string }, options: { hostId: string; signal?: AbortSignal; timeoutMs?: number }): Promise<ExecOutput>;
}

/**
 * Grace added on top of a command node's own `timeout` for the host RPC
 * call's deadline: the host entry (`host.ts`) kills the script itself at
 * `timeoutMs` and still has to report `{ timedOut: true }` back, so the RPC
 * deadline must sit past the script's, never at it.
 */
export const HOST_CALL_GRACE_MS = 5_000;

/**
 * The host RPC call's own deadline for a command node's script. Without this
 * every `bb.hosts.experimental_client` call fails after the SDK's 30-second
 * default ("host plugin call … exceeded its deadline") no matter what the
 * node's `timeout` says — dogfood run 4's `bun install && typecheck && test`
 * baseline died at exactly 30 s that way. Capped at the host contract's
 * `MAX_TIMEOUT_MS` (30 minutes), which is also the SDK's own ceiling.
 */
export function hostCallTimeoutMs(scriptTimeoutMs: number): number {
  return Math.min(scriptTimeoutMs + HOST_CALL_GRACE_MS, MAX_TIMEOUT_MS);
}

export interface ServiceDeps {
  bb: BbPluginApi;
  store: RunStore;
  agentBackend: AgentBackend;
  execClient: ExecClient;
  /** Optional: falls back to an interviewer that fails any human gate clearly, for tests/callers that never reach one. */
  humanInterviewer?: HumanInterviewer;
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
  /**
   * Aborted once, when the plugin is disposed or about to be replaced by a reload —
   * wired from server.ts's `lifecycle` AbortController. This immediately aborts every
   * in-flight run's own controller (stopping its worker threads too, via
   * `AgentBackend.run`'s signal handling) so nothing keeps driving a run against what
   * may become a closed database. Unlike an explicit `stopRun`, it deliberately does
   * *not* record a terminal ("cancelled") status for any of them: each run is left
   * exactly as a fresh plugin instance's `resumeRunningRuns` (server.ts's background
   * service) needs to find it — still "running", at its last saved checkpoint — so
   * that instance drives it forward instead of two engines racing on the same row.
   */
  disposeSignal?: AbortSignal;
}

const UNCONFIGURED_HUMAN_INTERVIEWER: HumanInterviewer = {
  async ask() {
    throw new Error("no human interviewer is configured for this plugin instance");
  },
};

export interface CreateRunInput {
  source: string;
  threadId: string;
  projectId: string;
  environmentId: string;
  title?: string;
  inputs?: Record<string, JsonValue>;
}

interface RunEnvironmentContext {
  threadId: string;
  projectId: string;
  environmentId: string;
  environmentPath: string;
  hostId: string;
}

export function createService(deps: ServiceDeps) {
  const { bb, store, agentBackend, execClient } = deps;
  const humanInterviewer = deps.humanInterviewer ?? UNCONFIGURED_HUMAN_INTERVIEWER;
  const clock = deps.clock ?? REAL_CLOCK;
  const controllers = new Map<string, AbortController>();
  // Flips once `deps.disposeSignal` aborts and never resets — this plugin instance is
  // shutting down. `executeRun` consults it to skip `recordFinish` (see there for why).
  let disposing = deps.disposeSignal?.aborted ?? false;

  function abortAllRuns(): void {
    disposing = true;
    for (const controller of controllers.values()) controller.abort();
  }
  if (deps.disposeSignal) {
    if (deps.disposeSignal.aborted) disposing = true;
    else deps.disposeSignal.addEventListener("abort", abortAllRuns, { once: true });
  }

  function publish(run: Run): void {
    bb.realtime.publish(REALTIME_CHANNEL, { runId: run.id, threadId: run.threadId });
  }

  // Wraps every `store.recordFinish` call: skipped entirely once disposing (see
  // `disposeSignal` above — a dispose-triggered abort must never persist a terminal
  // status), and guarded against a closed database otherwise (e.g. a lifecycle event
  // arriving for a run that had already started unwinding right as storage tore down)
  // so it can never escape `executeRun` as an unhandled rejection through the
  // fire-and-forget `void executeRun(...)` call sites below.
  function safeRecordFinish(runId: string, patch: Parameters<typeof store.recordFinish>[1]): void {
    if (disposing) return;
    try {
      // The engine emits no stage event for the stage it was aborted in, so
      // settle whatever is still in flight before the run's own terminal
      // status lands (dogfood-2: cancelled runs left a `running` stage row).
      if (patch.status === "cancelled") store.settleInFlightStages(runId, clock.now());
      const finished = store.recordFinish(runId, patch);
      publish(finished);
    } catch (err) {
      bb.log.warn(`attractor: failed to record finish for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function resolveRunEnvironment(threadId: string, projectId: string, environmentId: string): Promise<RunEnvironmentContext> {
    const environment = await bb.sdk.environments.get({ environmentId });
    if (!environment.path || !environment.hostId) throw new Error(`environment "${environmentId}" is not ready (no path/hostId)`);
    return { threadId, projectId, environmentId, environmentPath: environment.path, hostId: environment.hostId };
  }

  function buildHandlers(envCtx: RunEnvironmentContext): HandlerRegistry {
    const agentCtx: AgentHandlerContext = { threadId: envCtx.threadId, projectId: envCtx.projectId, environmentId: envCtx.environmentId };
    return {
      start: startHandler,
      exit: exitHandler,
      agent: createAgentHandler(agentBackend, agentCtx),
      prompt: createPromptHandler(agentBackend, agentCtx),
      command: createCommandHandler({
        exec: (input: CommandExecInput, options: { signal: AbortSignal }): Promise<CommandExecResult> => {
          const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
          return execClient.call(
            "exec",
            { ...input, cwd: envCtx.environmentPath, timeoutMs },
            { hostId: envCtx.hostId, signal: options.signal, timeoutMs: hostCallTimeoutMs(timeoutMs) },
          );
        },
      }),
      conditional: conditionalHandler,
      parallel: forkHandler,
      "parallel.fan_in": joinHandler,
      human: createHumanHandler(
        {
          ...humanInterviewer,
          // Gate-context follow-up: backs `HumanInterviewer.stageThreadId`
          // with the store, since the interviewer itself (server/human.ts)
          // has no run/stage state of its own. Reports the *latest* stage
          // for that node id, matching the "attaches a worker threadId"
          // convention every other per-node stage lookup in this file uses.
          stageThreadId: (runId: string, nodeId: string): string | null =>
            store
              .listStages(runId)
              .filter((s) => s.nodeId === nodeId)
              .at(-1)?.threadId ?? null,
        },
        {
          threadId: envCtx.threadId,
          readReviewTarget: (path: string) => readReviewTargetFile(bb, envCtx, path),
        } satisfies HumanHandlerContext,
      ),
    };
  }

  async function executeRun(run: Run, checkpoint: Checkpoint | null, envCtx: RunEnvironmentContext): Promise<void> {
    // A run can reach here after disposal has begun (e.g. a `resumeRunningRuns()`
    // still in flight when `disposeSignal` fires). Do not start an engine at
    // all: the run stays "running" at its checkpoint for the next instance.
    if (disposing) return;
    const controller = new AbortController();
    controllers.set(run.id, controller);
    try {
      const graph = parseWorkflowGraph(run.source);
      const handlers = buildHandlers(envCtx);
      const result = await runEngine({
        graph,
        handlers,
        runId: run.id,
        initialContext: checkpoint ? undefined : (run.context as Record<string, JsonValue>),
        checkpoint: {
          load: checkpoint ?? undefined,
          save: async (cp) => {
            const updated = store.saveCheckpoint(run.id, cp);
            publish(updated);
          },
        },
        clock,
        signal: controller.signal,
        onEvent: (event) => {
          store.appendEvent(run.id, event);
          applyEventToStore(store, run.id, event);
          publish(run);
        },
      });
      safeRecordFinish(run.id, {
        status: result.status,
        finalOutcome: result.finalOutcome,
        goalGateFailures: result.goalGateFailures,
        context: result.context,
      });
    } catch (err) {
      safeRecordFinish(run.id, { status: "failed", finalOutcome: null, goalGateFailures: [], context: run.context, error: err instanceof Error ? err.message : String(err) });
    } finally {
      controllers.delete(run.id);
    }
  }

  async function createAndStartRun(input: CreateRunInput): Promise<{ run: Run; directive: string }> {
    const graph = parseWorkflowGraph(input.source);
    const errors = validateGraph(graph).filter((d) => d.severity === "error");
    if (errors.length > 0) {
      throw new Error(`workflow validation failed: ${errors.map((d) => d.message).join("; ")}`);
    }
    const envCtx = await resolveRunEnvironment(input.threadId, input.projectId, input.environmentId);
    const run = store.createRun({
      id: randomUUID(),
      threadId: input.threadId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      title: input.title ?? graph.name,
      source: input.source,
      graph: toGraphView(graph, []),
      initialContext: expandFlatInputsToContext(input.inputs),
    });
    publish(run);
    // Fire-and-forget: the tool/CLI call returns as soon as the run is durably
    // persisted, per the plan's "persists a run, starts it in the background".
    void executeRun(run, null, envCtx);
    // The `thread` attribute (cross-thread cards follow-up) lets this
    // directive be pasted into any thread and still resolve — app.tsx's
    // `Directive` reads it as the RunPanel's threadId instead of the
    // hosting message's own thread, while server.ts's ownership check
    // (`owned()`) still only ever accepts the run's *actual* origin thread.
    return { run, directive: `::attractor-run{run="${run.id}" thread="${run.threadId}"}` };
  }

  function getRun(runId: string): { run: Run | null; stages: Stage[] } {
    const run = store.tryGetRun(runId);
    if (!run) return { run: null, stages: [] };
    return { run, stages: store.listStages(runId) };
  }

  function listRuns(options: { threadId: string; after?: string }) {
    return store.listRuns({ threadId: options.threadId, after: options.after });
  }

  // Backs the active-runs composer banner (RPC `activeRuns`): every run
  // still in flight for this thread, each already paired with its stages
  // and parsed graph so the banner never has to make three RPC round trips
  // per row the way `ui/run-panel.tsx`'s `useRunData` does for a single run.
  const ACTIVE_RUNS_LIMIT = 10;
  function activeRuns(threadId: string): { run: Run; stages: Stage[]; graph: GraphView }[] {
    return store.listActiveRuns({ threadId, limit: ACTIVE_RUNS_LIMIT }).map((run) => {
      const stages = store.listStages(run.id);
      return { run, stages, graph: toGraphView(graphFor(run), stages) };
    });
  }

  // A run's source is immutable, so its parsed graph is cached per run id:
  // the UI refetches the graph on every realtime event and re-parsing the
  // DOT each time was pure waste. Bounded by evicting once it grows large.
  const parsedGraphs = new Map<string, WorkflowGraph>();
  const PARSED_GRAPH_CACHE_LIMIT = 256;
  function graphFor(run: Run): WorkflowGraph {
    const cached = parsedGraphs.get(run.id);
    if (cached) return cached;
    const graph = parseWorkflowGraph(run.source);
    if (parsedGraphs.size >= PARSED_GRAPH_CACHE_LIMIT) parsedGraphs.clear();
    parsedGraphs.set(run.id, graph);
    return graph;
  }

  function getGraph(runId: string): GraphView | null {
    const run = store.tryGetRun(runId);
    if (!run) return null;
    return toGraphView(graphFor(run), store.listStages(runId));
  }

  function getEvents(runId: string, sinceSeq?: number) {
    return store.listEvents(runId, sinceSeq);
  }

  // Aborts the run's engine and reflects the request immediately: the
  // engine's own "cancelled" finish lands asynchronously (after its worker
  // thread is stopped), and callers such as `bb attractor stop` read the
  // returned Run straight away. A run that is no longer in flight is
  // returned untouched.
  function stopRun(runId: string): Run {
    const controller = controllers.get(runId);
    if (!controller) return store.getRun(runId);
    controller.abort();
    const updated = store.setStatus(runId, "cancelled");
    publish(updated);
    return updated;
  }

  // Matches `answer` against an option's raw label, its accelerator-stripped
  // display text, or its accelerator key (all case-insensitively), so `bb
  // attractor answer <runId> approve` and `... A` both work as well as the
  // literal edge label. Falls back to free text only when the gate's
  // `freeform` edge allows it.
  function resolveHumanAnswerValue(payload: HumanGatePayload, answer: string, actor: "ui" | "cli") {
    const trimmed = answer.trim();
    const lower = trimmed.toLowerCase();
    const match = payload.options.find((o) => o.raw === trimmed || o.text.toLowerCase() === lower || (o.key !== null && o.key.toLowerCase() === lower));
    if (match) return humanGateValueSchema.parse({ kind: "choice", raw: match.raw, via: actor });
    if (payload.freeform) return humanGateValueSchema.parse({ kind: "text", text: answer, via: actor });
    return null;
  }

  // Resolves the `bb.ui.requestInput` interaction `server/human.ts` opened
  // for this run's human gate — an alternative to clicking a rendered
  // button, for `bb attractor answer <runId> <label|text>` (T6). Not
  // documented among the plan's "BB plugin SDK notes" (which only covers the
  // request side, `bb.ui.requestInput`); see README "Deviations from the
  // plan" for why `bb.sdk.threads.interactions.list`/`respond` is the right,
  // faithful way to resolve one from outside the app's own renderer.
  async function answerHumanGate(runId: string, answer: string, actor: "ui" | "cli" = "cli"): Promise<{ answered: boolean; reason?: string }> {
    const run = store.tryGetRun(runId);
    if (!run) return { answered: false, reason: "no such run" };
    const pending = await bb.sdk.threads.interactions.list({ threadId: run.threadId });
    for (const interaction of pending) {
      // `payload.kind === "plugin"` uniquely identifies a `PluginPendingInteraction`
      // per the SDK's own schema (only that variant sets it), but TypeScript
      // can't correlate a discriminant nested one field deep across a union
      // this wide — hence the cast rather than a narrowed `interaction.origin`.
      if (interaction.payload.kind !== "plugin") continue;
      const origin = interaction.origin as { kind: "plugin"; pluginId: string; rendererId: string } | undefined;
      if (!origin || origin.rendererId !== HUMAN_GATE_RENDERER_ID) continue;
      const parsedPayload = humanGatePayloadSchema.safeParse(interaction.payload.data);
      if (!parsedPayload.success || parsedPayload.data.runId !== runId) continue;
      const value = resolveHumanAnswerValue(parsedPayload.data, answer, actor);
      if (!value) return { answered: false, reason: `"${answer}" matches no option and this gate does not accept free text` };
      await bb.sdk.threads.interactions.respond({ interactionId: interaction.id, threadId: run.threadId, value });
      return { answered: true };
    }
    return { answered: false, reason: "no pending human gate for this run" };
  }

  async function resumeRunningRuns(): Promise<void> {
    for (const runId of store.listRunningRunIds()) {
      const run = store.getRun(runId);
      if (!run.environmentId) continue;
      try {
        const envCtx = await resolveRunEnvironment(run.threadId, run.projectId ?? "", run.environmentId);
        const checkpoint = store.loadCheckpoint(runId);
        void executeRun(run, checkpoint, envCtx);
      } catch (err) {
        // Same dispose guard as every other terminal write: a resume that
        // fails while this instance is shutting down must not stamp a
        // permanent "failed" on a run the next instance could still resume.
        safeRecordFinish(runId, { status: "failed", finalOutcome: null, goalGateFailures: [], context: run.context, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { createAndStartRun, getRun, listRuns, activeRuns, getGraph, getEvents, stopRun, answerHumanGate, resumeRunningRuns };
}

export type Service = ReturnType<typeof createService>;
