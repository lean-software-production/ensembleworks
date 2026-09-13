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
import { runEngine } from "../engine/engine";
import type { Checkpoint, HandlerRegistry, JsonValue, Outcome, RunEvent } from "../engine/types";
import { createAgentHandler, type AgentHandlerContext } from "../handlers/agent";
import { createPromptHandler } from "../handlers/prompt";
import { createCommandHandler, type CommandExecInput, type CommandExecResult } from "../handlers/command";
import { conditionalHandler } from "../handlers/conditional";
import { forkHandler, joinHandler } from "../handlers/parallel";
import { createHumanHandler, type HumanInterviewer } from "../handlers/human";
import { startHandler, exitHandler } from "../handlers/start-exit";
import type { AgentBackend } from "./backend";
import { HUMAN_GATE_RENDERER_ID, humanGatePayloadSchema, humanGateValueSchema, type HumanGatePayload } from "./contracts";
import { DEFAULT_TIMEOUT_MS, type ExecOutput } from "../host-contract";
import { RunStore, type Run, type Stage } from "./store";

const REALTIME_CHANNEL = "attractor-runs";

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
      const nodeId = event.stageId.split("@")[0];
      const visit = parseVisitFromStageId(event.stageId, nodeId);
      store.setStageThreadId(runId, nodeId, visit, event.threadId);
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
      return;
    }
    case "human.answered": {
      const visit = parseVisitFromStageId(event.stageId, event.nodeId);
      store.setStageStatus(runId, event.nodeId, visit, "running");
      store.setStatus(runId, "running");
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
  call(method: "exec", input: CommandExecInput & { cwd: string }, options: { hostId: string; signal?: AbortSignal }): Promise<ExecOutput>;
}

export interface ServiceDeps {
  bb: BbPluginApi;
  store: RunStore;
  agentBackend: AgentBackend;
  execClient: ExecClient;
  /** Optional: falls back to an interviewer that fails any human gate clearly, for tests/callers that never reach one. */
  humanInterviewer?: HumanInterviewer;
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
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

  function publish(run: Run): void {
    bb.realtime.publish(REALTIME_CHANNEL, { runId: run.id, threadId: run.threadId });
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
        exec: (input: CommandExecInput, options: { signal: AbortSignal }): Promise<CommandExecResult> =>
          execClient.call(
            "exec",
            { ...input, cwd: envCtx.environmentPath, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS },
            { hostId: envCtx.hostId, signal: options.signal },
          ),
      }),
      conditional: conditionalHandler,
      parallel: forkHandler,
      "parallel.fan_in": joinHandler,
      human: createHumanHandler(humanInterviewer, { threadId: envCtx.threadId }),
    };
  }

  async function executeRun(run: Run, checkpoint: Checkpoint | null, envCtx: RunEnvironmentContext): Promise<void> {
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
      const finished = store.recordFinish(run.id, {
        status: result.status,
        finalOutcome: result.finalOutcome,
        goalGateFailures: result.goalGateFailures,
        context: result.context,
      });
      publish(finished);
    } catch (err) {
      const finished = store.recordFinish(run.id, { status: "failed", finalOutcome: null, goalGateFailures: [], context: run.context, error: err instanceof Error ? err.message : String(err) });
      publish(finished);
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
      initialContext: input.inputs ?? {},
    });
    publish(run);
    // Fire-and-forget: the tool/CLI call returns as soon as the run is durably
    // persisted, per the plan's "persists a run, starts it in the background".
    void executeRun(run, null, envCtx);
    return { run, directive: `::attractor-run{run="${run.id}"}` };
  }

  function getRun(runId: string): { run: Run | null; stages: Stage[] } {
    const run = store.tryGetRun(runId);
    if (!run) return { run: null, stages: [] };
    return { run, stages: store.listStages(runId) };
  }

  function listRuns(options: { threadId: string; after?: string }) {
    return store.listRuns({ threadId: options.threadId, after: options.after });
  }

  function getGraph(runId: string): GraphView | null {
    const run = store.tryGetRun(runId);
    if (!run) return null;
    return toGraphView(parseWorkflowGraph(run.source), store.listStages(runId));
  }

  function getEvents(runId: string, sinceSeq?: number) {
    return store.listEvents(runId, sinceSeq);
  }

  function stopRun(runId: string): Run {
    controllers.get(runId)?.abort();
    return store.getRun(runId);
  }

  // Matches `answer` against an option's raw label, its accelerator-stripped
  // display text, or its accelerator key (all case-insensitively), so `bb
  // attractor answer <runId> approve` and `... A` both work as well as the
  // literal edge label. Falls back to free text only when the gate's
  // `freeform` edge allows it.
  function resolveHumanAnswerValue(payload: HumanGatePayload, answer: string) {
    const trimmed = answer.trim();
    const lower = trimmed.toLowerCase();
    const match = payload.options.find((o) => o.raw === trimmed || o.text.toLowerCase() === lower || (o.key !== null && o.key.toLowerCase() === lower));
    if (match) return humanGateValueSchema.parse({ kind: "choice", raw: match.raw });
    if (payload.freeform) return humanGateValueSchema.parse({ kind: "text", text: answer });
    return null;
  }

  // Resolves the `bb.ui.requestInput` interaction `server/human.ts` opened
  // for this run's human gate — an alternative to clicking a rendered
  // button, for `bb attractor answer <runId> <label|text>` (T6). Not
  // documented among the plan's "BB plugin SDK notes" (which only covers the
  // request side, `bb.ui.requestInput`); see README "Deviations from the
  // plan" for why `bb.sdk.threads.interactions.list`/`respond` is the right,
  // faithful way to resolve one from outside the app's own renderer.
  async function answerHumanGate(runId: string, answer: string): Promise<{ answered: boolean; reason?: string }> {
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
      const value = resolveHumanAnswerValue(parsedPayload.data, answer);
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
        store.recordFinish(runId, { status: "failed", finalOutcome: null, goalGateFailures: [], context: run.context, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { createAndStartRun, getRun, listRuns, getGraph, getEvents, stopRun, answerHumanGate, resumeRunningRuns };
}

export type Service = ReturnType<typeof createService>;
