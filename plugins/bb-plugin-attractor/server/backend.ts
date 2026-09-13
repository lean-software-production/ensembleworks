/**
 * The BB-thread `CodergenBackend`, per
 * docs/plans/2026-09-13-attractor-runner-plan.md "BB plugin SDK notes"
 * ("Spawning a worker thread") and "Prompt assembly (`compact` fidelity
 * only in v1)".
 *
 * Spawns a hidden worker thread per `agent`/`prompt` stage, resolves its
 * model/provider/reasoning_effort tuple (stylesheet, then explicit node
 * attributes, then the origin thread's own provider/defaults — validated
 * against the live catalog, never silently substituted), waits for
 * `thread.idle`/`thread.failed`/`thread.deleted`, and — for an
 * `output_schema` node — validates the worker's `attractor_result` tool
 * report against the node's schema, re-prompting the same thread up to
 * twice on an invalid or missing report before giving up.
 *
 * `bb.events.on` has no unsubscribe, so this module registers its three
 * thread-lifecycle listeners exactly once per plugin load (here, once per
 * `createThreadAgentBackend` call) and dispatches by threadId through an
 * internal map, rather than registering a new listener per spawned thread.
 *
 * Lost-event race: `waitForCompletion` registers its waiter in the `waiters`
 * map *before* the "reconcile immediately after spawn" `threads.get` call is
 * awaited, so a `thread.idle`/`thread.failed` delivered while that call is in
 * flight resolves the same promise instead of being dropped — the reconcile
 * read only gets to act when the map entry is still present afterwards
 * (nothing raced it).
 *
 * Cancellation: every wait observes `input.signal`. On abort it calls
 * `bb.sdk.threads.stop` on the live worker thread and settles the pending
 * completion as `{ kind: "aborted" }`, which `run()` turns into a rejected
 * stage promise — this is what lets the engine's own abort check
 * (`server/service.ts`'s `stopRun` -> `AbortController.abort()`) actually
 * unwedge a run parked on an agent/prompt stage instead of hanging forever.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseStylesheet, resolveStyle } from "../dot/stylesheet";
import type { Context, Outcome, StageScopedEvent, WorkflowGraph, WorkflowNode } from "../engine/types";

export interface AgentRunInput {
  node: WorkflowNode;
  graph: WorkflowGraph;
  context: Context;
  runId: string;
  stageId: string;
  signal: AbortSignal;
  emit(event: StageScopedEvent): void;
  /** The origin thread this run was started from — source of provider/model defaults and the environment to reuse. */
  threadId: string;
  projectId: string;
  environmentId: string;
}

export interface AgentBackend {
  run(input: AgentRunInput): Promise<Outcome>;
  /** Called by the `attractor_result` tool's execute() when the worker reports a structured result. */
  reportResult(workerThreadId: string, value: unknown): void;
  /** Whether `threadId` is a live worker awaiting a structured result — drives `bb.agents.configure`'s tool gating. */
  isAwaitingResult(threadId: string): boolean;
  /** Whether `threadId` is a live worker this backend spawned at all (structured or not) — also drives tool gating. */
  isWorkerThread(threadId: string): boolean;
}

const MAX_CORRECTIVE_RETRIES = 2;
const PROMPT_PREVIEW_LENGTH = 200;

type Completion = { kind: "idle"; text: string | null } | { kind: "failed"; error: string | null } | { kind: "deleted" } | { kind: "aborted" };

// Per the plan's "Prompt assembly": "a bullet summary of prior stages (node
// id, label, status, first 200 chars of response / command tail)". Status
// comes from `stage_status.<nodeId>` (engine.ts's writeOutcomeToContext) and
// the label from the graph itself — the response map alone (keyed by node
// id, text only) can't tell a downstream agent whether a prior stage
// succeeded or failed.
function summarizePriorStages(context: Context, graph: WorkflowGraph): string {
  const response = context.get("response");
  if (!response || typeof response !== "object" || Array.isArray(response)) return "";
  const stageStatus = context.get("stage_status");
  const statusOf = (nodeId: string): string | undefined =>
    stageStatus && typeof stageStatus === "object" && !Array.isArray(stageStatus) ? (stageStatus as Record<string, unknown>)[nodeId] as string | undefined : undefined;
  const lines = Object.entries(response as Record<string, unknown>).map(([nodeId, text]) => {
    const label = graph.nodes.get(nodeId)?.label;
    const status = statusOf(nodeId);
    const heading = [nodeId, label, status].filter((part): part is string => Boolean(part)).join(" | ");
    return `- ${heading}: ${String(text).slice(0, PROMPT_PREVIEW_LENGTH)}`;
  });
  return lines.length ? `Prior stages:\n${lines.join("\n")}\n\n` : "";
}

function assemblePrompt(node: WorkflowNode, graph: WorkflowGraph, context: Context): string {
  const goal = graph.goal ? `Goal: ${graph.goal}\n\n` : "";
  const history = summarizePriorStages(context, graph);
  const body = node.prompt ?? "";
  const schemaInstruction = node.outputSchema
    ? `\n\nWhen you are done, call the attractor_result tool exactly once with your JSON result value.`
    : "";
  return `${goal}${history}${body}${schemaInstruction}`;
}

interface RoutingResult {
  outcome: "succeeded" | "failed" | "partially_succeeded";
  preferred_next_label?: string;
  suggested_next_ids?: string[];
  failure_reason?: string;
  context_updates?: Record<string, unknown>;
}

const ROUTING_OUTCOMES = new Set(["succeeded", "failed", "partially_succeeded"]);

function validateRoutingResult(value: unknown): { ok: true; value: RoutingResult } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "result must be a JSON object" };
  const record = value as Record<string, unknown>;
  if (typeof record.outcome !== "string" || !ROUTING_OUTCOMES.has(record.outcome)) {
    return { ok: false, error: 'result.outcome must be one of "succeeded", "failed", "partially_succeeded"' };
  }
  return { ok: true, value: record as unknown as RoutingResult };
}

function outcomeFromRouting(result: RoutingResult, text: string | null): Outcome {
  return {
    status: result.outcome,
    ...(result.preferred_next_label !== undefined ? { preferredLabel: result.preferred_next_label } : {}),
    ...(result.suggested_next_ids !== undefined ? { suggestedNextIds: result.suggested_next_ids } : {}),
    ...(result.failure_reason !== undefined ? { failureReason: result.failure_reason } : {}),
    ...(result.context_updates !== undefined ? { contextUpdates: result.context_updates as Outcome["contextUpdates"] } : {}),
    ...(text !== null ? { text } : {}),
  };
}

export function createThreadAgentBackend(bb: BbPluginApi): AgentBackend {
  // Each entry is a `finish` callback that is idempotent and self-removing
  // (see waitForCompletion): whichever of an event, an abort, or a manual
  // reconcile-driven settle happens first wins, and the other becomes a
  // harmless no-op because the entry is already gone from the map.
  const waiters = new Map<string, (completion: Completion) => void>();
  const reportedResults = new Map<string, unknown>();
  const workerNeedsResult = new Set<string>();
  const workerThreads = new Set<string>();

  bb.events.on("thread.idle", (payload) => {
    waiters.get(payload.thread.id)?.({ kind: "idle", text: payload.lastAssistantText });
  });
  bb.events.on("thread.failed", (payload) => {
    waiters.get(payload.thread.id)?.({ kind: "failed", error: payload.error });
  });
  bb.events.on("thread.deleted", (payload) => {
    waiters.get(payload.thread.id)?.({ kind: "deleted" });
  });

  async function stopQuietly(threadId: string): Promise<void> {
    try {
      await bb.sdk.threads.stop({ threadId });
    } catch (err) {
      bb.log.warn(`attractor: failed to stop worker thread ${threadId} after cancellation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Registers a waiter for `threadId`'s next lifecycle event *and* races it
  // against `signal`: on abort, stops the live worker thread and settles the
  // wait as `{ kind: "aborted" }` rather than leaving the stage promise
  // pending forever. The waiter is stored (and reachable via `waiters.get`)
  // before any `await` happens here, so a caller that also wants to consult
  // an async snapshot (e.g. the post-spawn reconcile `threads.get`) can
  // safely await that afterwards and check whether this entry is still
  // present to know if an event already won the race.
  function waitForCompletion(threadId: string, signal: AbortSignal): Promise<Completion> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (completion: Completion) => {
        if (settled) return;
        settled = true;
        waiters.delete(threadId);
        signal.removeEventListener("abort", onAbort);
        resolve(completion);
      };
      const onAbort = () => {
        // Fire-and-forget, and must never throw here (sync or async): this
        // runs either directly or from an `abort` event dispatch, and either
        // way an escaping error would either skip `finish` below or surface
        // as an unhandled exception rather than a rejected stage.
        void stopQuietly(threadId);
        finish({ kind: "aborted" });
      };
      waiters.set(threadId, finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Registers the waiter, then reconciles with a live snapshot in case the
  // worker already finished before the listeners above could matter (a fast
  // local model, a replayed event). The waiter is registered first (see
  // waitForCompletion) so a lifecycle event delivered *during* the `get()`
  // await is never lost — only when the entry is still pending afterwards
  // does the snapshot get to decide anything.
  async function reconcileOrWait(threadId: string, signal: AbortSignal): Promise<Completion> {
    const completionPromise = waitForCompletion(threadId, signal);
    const immediate = await bb.sdk.threads.get({ threadId });
    const stillPending = waiters.get(threadId);
    if (stillPending) {
      if (immediate.status === "idle") stillPending({ kind: "idle", text: null });
      else if (immediate.status === "error") stillPending({ kind: "failed", error: null });
    }
    return completionPromise;
  }

  async function resolveModelTuple(node: WorkflowNode, graph: WorkflowGraph, threadId: string, environmentId: string) {
    const rules = graph.modelStylesheet ? parseStylesheet(graph.modelStylesheet) : [];
    const style = resolveStyle(
      { id: node.id, shape: node.shape, classes: node.classes },
      rules,
      { model: node.model, provider: node.provider, reasoningEffort: node.reasoningEffort },
    );
    const [origin, defaults] = await Promise.all([bb.sdk.threads.get({ threadId }), bb.sdk.threads.defaultExecutionOptions({ threadId })]);
    const providerId = style.provider ?? origin.providerId;
    const model = style.model ?? defaults?.model;
    if (!model) throw new Error(`no model could be resolved for node "${node.id}" (no stylesheet/node model and no thread default execution options)`);
    const reasoningLevel = style.reasoningEffort ?? defaults?.reasoningLevel;
    const permissionMode = defaults?.permissionMode;

    const catalog = await bb.sdk.providers.models({ environmentId, providerId });
    const known = catalog.models.some((m) => m.model === model || m.id === model);
    if (!known) throw new Error(`unknown model "${model}" for provider "${providerId}" — refusing to silently substitute`);

    return { providerId, model, reasoningLevel, permissionMode };
  }

  async function run(input: AgentRunInput): Promise<Outcome> {
    const { node, graph, context, threadId, projectId, environmentId, emit, signal } = input;
    if (signal.aborted) throw new Error("run was cancelled before the stage started");
    const tuple = await resolveModelTuple(node, graph, threadId, environmentId);
    const prompt = assemblePrompt(node, graph, context);

    const spawned = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "reuse", environmentId },
      prompt,
      title: node.label ?? node.id,
      providerId: tuple.providerId,
      model: tuple.model,
      reasoningLevel: tuple.reasoningLevel,
      permissionMode: tuple.permissionMode,
      visibility: "hidden",
    });
    const workerThreadId = spawned.id;
    workerThreads.add(workerThreadId);
    if (node.outputSchema !== undefined) workerNeedsResult.add(workerThreadId);
    emit({ type: "agent.thread", threadId: workerThreadId });

    try {
      const completion = await reconcileOrWait(workerThreadId, signal);
      if (node.outputSchema === undefined) {
        return await resolveFreeText(workerThreadId, completion);
      }
      return await resolveStructured(workerThreadId, completion, signal);
    } finally {
      waiters.delete(workerThreadId);
      workerThreads.delete(workerThreadId);
      workerNeedsResult.delete(workerThreadId);
      reportedResults.delete(workerThreadId);
      // Best-effort, fire-and-forget: the worker thread has served its
      // purpose once the stage has settled (including on cancellation, where
      // it was already stopped above). archiveQuietly fully contains any
      // failure (sync throw or async rejection) itself — this must never
      // turn a settled stage outcome into a rejection via the `finally`.
      void archiveQuietly(workerThreadId);
    }
  }

  async function archiveQuietly(workerThreadId: string): Promise<void> {
    try {
      await bb.sdk.threads.archive({ threadId: workerThreadId });
    } catch (err) {
      bb.log.warn(`attractor: failed to archive worker thread ${workerThreadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function textOf(workerThreadId: string): Promise<string | null> {
    const { output } = await bb.sdk.threads.output({ threadId: workerThreadId });
    return output;
  }

  async function resolveFreeText(workerThreadId: string, completion: Completion): Promise<Outcome> {
    if (completion.kind === "aborted") throw new Error(`worker thread ${workerThreadId} stopped: run was cancelled`);
    if (completion.kind === "failed") throw new Error(completion.error ?? `worker thread ${workerThreadId} failed`);
    if (completion.kind === "deleted") throw new Error(`worker thread ${workerThreadId} was deleted before completing`);
    const text = await textOf(workerThreadId);
    return { status: "succeeded", ...(text !== null ? { text } : {}) };
  }

  async function resolveStructured(workerThreadId: string, initial: Completion, signal: AbortSignal): Promise<Outcome> {
    let completion = initial;
    for (let attempt = 0; ; attempt++) {
      if (completion.kind === "aborted") throw new Error(`worker thread ${workerThreadId} stopped: run was cancelled`);
      if (completion.kind === "failed") throw new Error(completion.error ?? `worker thread ${workerThreadId} failed`);
      if (completion.kind === "deleted") throw new Error(`worker thread ${workerThreadId} was deleted before completing`);

      const text = await textOf(workerThreadId);
      const reported = reportedResults.get(workerThreadId);
      const validated = reported !== undefined ? validateRoutingResult(reported) : { ok: false as const, error: "no attractor_result report was received" };
      if (validated.ok) return outcomeFromRouting(validated.value, text);

      if (attempt >= MAX_CORRECTIVE_RETRIES) {
        return { status: "failed", failureReason: `attractor_result validation failed after ${attempt} corrective retr${attempt === 1 ? "y" : "ies"}: ${validated.error}`, ...(text !== null ? { text } : {}) };
      }
      reportedResults.delete(workerThreadId);
      await bb.sdk.threads.send({
        threadId: workerThreadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: `That result was invalid (${validated.error}). Call attractor_result again with a corrected JSON value.`, mentions: [] }],
      });
      completion = await waitForCompletion(workerThreadId, signal);
    }
  }

  return {
    run,
    reportResult(workerThreadId, value) {
      reportedResults.set(workerThreadId, value);
    },
    isAwaitingResult: (threadId) => workerNeedsResult.has(threadId),
    isWorkerThread: (threadId) => workerThreads.has(threadId),
  };
}
