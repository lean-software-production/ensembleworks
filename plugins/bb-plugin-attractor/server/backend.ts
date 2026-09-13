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

type Completion = { kind: "idle"; text: string | null } | { kind: "failed"; error: string | null } | { kind: "deleted" };

function summarizePriorStages(context: Context): string {
  const response = context.get("response");
  if (!response || typeof response !== "object" || Array.isArray(response)) return "";
  const lines = Object.entries(response as Record<string, unknown>).map(([nodeId, text]) => `- ${nodeId}: ${String(text).slice(0, PROMPT_PREVIEW_LENGTH)}`);
  return lines.length ? `Prior stages:\n${lines.join("\n")}\n\n` : "";
}

function assemblePrompt(node: WorkflowNode, graph: WorkflowGraph, context: Context): string {
  const goal = graph.goal ? `Goal: ${graph.goal}\n\n` : "";
  const history = summarizePriorStages(context);
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
  const waiters = new Map<string, (completion: Completion) => void>();
  const reportedResults = new Map<string, unknown>();
  const workerNeedsResult = new Set<string>();
  const workerThreads = new Set<string>();

  bb.events.on("thread.idle", (payload) => {
    const resolve = waiters.get(payload.thread.id);
    if (resolve) {
      waiters.delete(payload.thread.id);
      resolve({ kind: "idle", text: payload.lastAssistantText });
    }
  });
  bb.events.on("thread.failed", (payload) => {
    const resolve = waiters.get(payload.thread.id);
    if (resolve) {
      waiters.delete(payload.thread.id);
      resolve({ kind: "failed", error: payload.error });
    }
  });
  bb.events.on("thread.deleted", (payload) => {
    const resolve = waiters.get(payload.thread.id);
    if (resolve) {
      waiters.delete(payload.thread.id);
      resolve({ kind: "deleted" });
    }
  });

  function waitForCompletion(threadId: string): Promise<Completion> {
    return new Promise((resolve) => waiters.set(threadId, resolve));
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
    const { node, graph, context, threadId, projectId, environmentId, emit } = input;
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
      // Reconcile immediately in case the worker already finished before the
      // listener above could matter (a fast local model, a replayed event).
      const immediate = await bb.sdk.threads.get({ threadId: workerThreadId });
      let completion: Completion;
      if (immediate.status === "idle") {
        completion = { kind: "idle", text: null };
      } else if (immediate.status === "error") {
        completion = { kind: "failed", error: null };
      } else {
        completion = await waitForCompletion(workerThreadId);
      }

      if (node.outputSchema === undefined) {
        return await resolveFreeText(workerThreadId, completion);
      }
      return await resolveStructured(workerThreadId, completion);
    } finally {
      waiters.delete(workerThreadId);
      workerThreads.delete(workerThreadId);
      workerNeedsResult.delete(workerThreadId);
      reportedResults.delete(workerThreadId);
    }
  }

  async function textOf(workerThreadId: string): Promise<string | null> {
    const { output } = await bb.sdk.threads.output({ threadId: workerThreadId });
    return output;
  }

  async function resolveFreeText(workerThreadId: string, completion: Completion): Promise<Outcome> {
    if (completion.kind === "failed") throw new Error(completion.error ?? `worker thread ${workerThreadId} failed`);
    if (completion.kind === "deleted") throw new Error(`worker thread ${workerThreadId} was deleted before completing`);
    const text = await textOf(workerThreadId);
    return { status: "succeeded", ...(text !== null ? { text } : {}) };
  }

  async function resolveStructured(workerThreadId: string, initial: Completion): Promise<Outcome> {
    let completion = initial;
    for (let attempt = 0; ; attempt++) {
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
      completion = await waitForCompletion(workerThreadId);
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
