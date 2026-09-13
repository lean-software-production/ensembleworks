/**
 * The walker: drives a WorkflowGraph from its start node to termination,
 * per docs/plans/2026-09-13-attractor-runner-plan.md "Engine contracts" and
 * "Routing cascade after a stage completes". Handlers, the clock and the
 * checkpoint sink are all injected; the engine itself does no BB imports,
 * no timers of its own, and no randomness.
 */

import { createContext } from "./context";
import { createStageEmitter } from "./events";
import { selectRetryTarget, selectRoute } from "./router";
import type { WorkflowEdge } from "../dot/graph";
import type {
  Checkpoint,
  Context,
  EngineOptions,
  JsonValue,
  Outcome,
  OutcomeStatus,
  RunEvent,
  RunResult,
  WorkflowGraph,
  WorkflowNode,
} from "./types";

const RETRY_DELAYS_MS = [1000, 2000, 4000];

function stageId(nodeId: string, visit: number): string {
  return `${nodeId}@${visit}`;
}

function effectiveMaxVisits(node: WorkflowNode, graph: WorkflowGraph): number {
  return node.maxVisits ?? graph.maxNodeVisits;
}

function findStartNode(graph: WorkflowGraph): WorkflowNode {
  for (const id of graph.nodeOrder) {
    const node = graph.nodes.get(id);
    if (node && node.handlerKind === "start") return node;
  }
  throw new Error("workflow graph has no start node");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ParallelBranchResult {
  id: string;
  index: number;
  status: OutcomeStatus;
  context_updates?: Record<string, JsonValue>;
}

export class Engine {
  private readonly graph: WorkflowGraph;
  private readonly handlers: EngineOptions["handlers"];
  private readonly runId: string;
  private readonly clock: EngineOptions["clock"];
  private readonly signal: AbortSignal;
  private readonly onEvent: (event: RunEvent) => void;
  private readonly checkpointSink?: EngineOptions["checkpoint"];

  private context: Context;
  private visitCounts: Record<string, number>;
  private goalGateOutcomes: Record<string, OutcomeStatus>;
  private readonly resuming: boolean;
  private readonly resumeNodeId?: string;

  constructor(options: EngineOptions) {
    this.graph = options.graph;
    this.handlers = options.handlers;
    this.runId = options.runId;
    this.clock = options.clock;
    this.signal = options.signal;
    this.onEvent = options.onEvent;
    this.checkpointSink = options.checkpoint;

    const loaded = options.checkpoint?.load;
    if (loaded) {
      this.context = createContext(loaded.context);
      this.visitCounts = { ...loaded.visitCounts };
      this.goalGateOutcomes = { ...loaded.goalGateOutcomes };
      this.resuming = true;
      this.resumeNodeId = loaded.nextNodeId;
    } else {
      this.context = createContext(options.initialContext);
      this.visitCounts = {};
      this.goalGateOutcomes = {};
      this.resuming = false;
    }
  }

  async run(): Promise<RunResult> {
    try {
      if (this.signal.aborted) return this.finishCancelled();

      // Deferred to inside the try: an unresolvable start node (e.g. a malformed
      // graph that slipped past validate()) should surface as run.failed, not an
      // unhandled rejection out of the constructor, and before any event fires.
      let currentNodeId: string | null = this.resumeNodeId ?? findStartNode(this.graph).id;

      if (!this.resuming) {
        this.emit({ type: "run.started", runId: this.runId, ts: this.clock.now() });
      }
      let finalOutcome: Outcome | null = null;

      while (currentNodeId) {
        if (this.signal.aborted) return this.finishCancelled();

        const node = this.graph.nodes.get(currentNodeId);
        if (!node) {
          finalOutcome = { status: "failed", failureReason: `unknown node "${currentNodeId}"` };
          break;
        }

        if (!this.isEnterable(node.id)) {
          this.emitSkipped(node.id, "max_visits_exceeded");
          const skippedOutcome: Outcome = { status: "failed", failureReason: `max_visits exceeded for "${node.id}"` };
          const retryTargetId = this.consultRetryTarget(node);
          if (retryTargetId) {
            currentNodeId = retryTargetId;
            continue;
          }
          finalOutcome = skippedOutcome;
          break;
        }

        this.markVisited(node.id);

        const outcome = await this.runStageWithRetries(node, this.visitCounts[node.id]);
        if (this.signal.aborted) return this.finishCancelled();

        this.applyOutcomeToContext(node, outcome);

        if (node.handlerKind === "exit") {
          finalOutcome = outcome;
          currentNodeId = null;
          break;
        }

        if (node.handlerKind === "parallel") {
          const joinNodeId = await this.runParallelFanOut(node);
          if (this.signal.aborted) return this.finishCancelled();
          if (joinNodeId === null) {
            finalOutcome = outcome;
            currentNodeId = null;
            break;
          }
          currentNodeId = joinNodeId;
          await this.saveCheckpoint(currentNodeId);
          continue;
        }

        const next = this.route(node, outcome);
        if (next === null) {
          finalOutcome = outcome;
          currentNodeId = null;
          break;
        }
        currentNodeId = next;
        await this.saveCheckpoint(currentNodeId);
      }

      return this.finish(finalOutcome);
    } catch (err) {
      if (this.signal.aborted) return this.finishCancelled();
      this.emit({ type: "run.failed", runId: this.runId, ts: this.clock.now(), error: errorMessage(err) });
      return { status: "failed", finalOutcome: null, goalGateFailures: [], context: this.context.toObject() };
    }
  }

  // -------------------------------------------------------------------------
  // Routing (single-target cascade steps 1-8; parallel fan-out handled separately)
  // -------------------------------------------------------------------------

  private route(node: WorkflowNode, outcome: Outcome): string | null {
    let decision = selectRoute({ node, graph: this.graph, outcome, context: this.context.toObject() });
    if (decision && !this.isEnterable(decision.nodeId)) {
      this.emitSkipped(decision.nodeId, "max_visits_exceeded");
      decision = null;
    }
    if (decision) {
      this.emit({
        type: "edge.selected",
        runId: this.runId,
        ts: this.clock.now(),
        from: node.id,
        to: decision.nodeId,
        edgeLabel: decision.edgeLabel,
        reason: decision.reason,
      });
      return decision.nodeId;
    }
    const retryTargetId = this.consultRetryTarget(node);
    if (retryTargetId) {
      this.emit({
        type: "edge.selected",
        runId: this.runId,
        ts: this.clock.now(),
        from: node.id,
        to: retryTargetId,
        reason: "retry_target",
      });
      return retryTargetId;
    }
    return null;
  }

  private consultRetryTarget(node: WorkflowNode): string | undefined {
    const candidate = selectRetryTarget(node, this.graph);
    if (candidate === undefined) return undefined;
    if (this.isEnterable(candidate)) return candidate;
    this.emitSkipped(candidate, "max_visits_exceeded");
    return undefined;
  }

  private isEnterable(nodeId: string): boolean {
    const node = this.graph.nodes.get(nodeId);
    if (!node) return false;
    const limit = effectiveMaxVisits(node, this.graph);
    if (limit === 0) return true;
    const nextVisit = (this.visitCounts[nodeId] ?? 0) + 1;
    return nextVisit <= limit;
  }

  private markVisited(nodeId: string): number {
    const visit = (this.visitCounts[nodeId] ?? 0) + 1;
    this.visitCounts[nodeId] = visit;
    return visit;
  }

  private emitSkipped(nodeId: string, reason: string): void {
    const wouldBeVisit = (this.visitCounts[nodeId] ?? 0) + 1;
    this.emit({
      type: "stage.skipped",
      runId: this.runId,
      ts: this.clock.now(),
      stageId: stageId(nodeId, wouldBeVisit),
      nodeId,
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // Stage execution (with retries)
  // -------------------------------------------------------------------------

  private async runStageWithRetries(node: WorkflowNode, visit: number): Promise<Outcome> {
    const maxRetries = node.maxRetries ?? this.graph.defaultMaxRetries ?? 0;
    let attempt = 1;
    for (;;) {
      const sId = stageId(node.id, visit);
      this.emit({ type: "stage.started", runId: this.runId, ts: this.clock.now(), stageId: sId, nodeId: node.id, visit, attempt });
      const outcome = await this.executeStage(node, this.context, visit, attempt, sId);
      if ("ok" in outcome && outcome.ok) {
        return outcome.value;
      }
      if (this.signal.aborted) throw outcome.error;
      const willRetry = attempt <= maxRetries;
      this.emit({
        type: "stage.failed",
        runId: this.runId,
        ts: this.clock.now(),
        stageId: sId,
        nodeId: node.id,
        visit,
        attempt,
        error: errorMessage(outcome.error),
        willRetry,
      });
      if (!willRetry) {
        return { status: "failed", failureReason: errorMessage(outcome.error) };
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      await this.clock.sleep(delay, this.signal);
      if (this.signal.aborted) throw new Error("cancelled");
      attempt += 1;
    }
  }

  private async executeStage(
    node: WorkflowNode,
    context: Context,
    visit: number,
    attempt: number,
    sId: string,
  ): Promise<{ ok: true; value: Outcome } | { ok: false; error: unknown }> {
    const handler = this.handlers[node.handlerKind];
    const startedAt = this.clock.now();
    const emit = createStageEmitter({ runId: this.runId, stageId: sId, nodeId: node.id, now: () => this.clock.now(), onEvent: this.onEvent });
    try {
      const outcome = await handler.run({
        node,
        graph: this.graph,
        context,
        visit,
        attempt,
        runId: this.runId,
        stageId: sId,
        signal: this.signal,
        emit,
      });
      const wallTimeMs = this.clock.now() - startedAt;
      this.emit({ type: "stage.completed", runId: this.runId, ts: this.clock.now(), stageId: sId, nodeId: node.id, visit, attempt, outcome, wallTimeMs });
      return { ok: true, value: outcome };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private applyOutcomeToContext(node: WorkflowNode, outcome: Outcome): void {
    this.context.set("last_stage", node.id);
    if (outcome.text !== undefined) {
      this.context.set("last_response", outcome.text.slice(0, 200));
      this.context.set(`response.${node.id}`, outcome.text);
    }
    this.context.merge(outcome.contextUpdates);
    if (node.goalGate) {
      this.goalGateOutcomes[node.id] = outcome.status;
    }
  }

  // -------------------------------------------------------------------------
  // Parallel fan-out / fan-in (join_policy="all" only, per v1 scope)
  // -------------------------------------------------------------------------

  private async runParallelFanOut(forkNode: WorkflowNode): Promise<string | null> {
    const branchEdges = this.graph.edges.filter((e) => e.from === forkNode.id);
    const groupId = stageId(forkNode.id, this.visitCounts[forkNode.id]);

    const runBranch = async (edge: WorkflowEdge, index: number): Promise<{ result: ParallelBranchResult; joinNodeId?: string }> => {
      const branchContext = this.context.clone();
      let nodeId: string | null = edge.to;
      let lastOutcome: Outcome = { status: "skipped" };
      let lastNodeId = forkNode.id;
      let joinNodeId: string | undefined;

      while (nodeId) {
        if (this.signal.aborted) break;
        const node: WorkflowNode | undefined = this.graph.nodes.get(nodeId);
        if (!node) break;
        if (node.handlerKind === "parallel.fan_in") {
          joinNodeId = node.id;
          break;
        }
        if (!this.isEnterable(node.id)) {
          this.emitSkipped(node.id, "max_visits_exceeded");
          break;
        }
        const visit = this.markVisited(node.id);
        const sId = stageId(node.id, visit);
        this.emit({
          type: "stage.started",
          runId: this.runId,
          ts: this.clock.now(),
          stageId: sId,
          nodeId: node.id,
          visit,
          attempt: 1,
          parallelGroupId: groupId,
          branchIndex: index,
        });
        const executed = await this.executeStage(node, branchContext, visit, 1, sId);
        if (!executed.ok) {
          const message = errorMessage(executed.error);
          this.emit({
            type: "stage.failed",
            runId: this.runId,
            ts: this.clock.now(),
            stageId: sId,
            nodeId: node.id,
            visit,
            attempt: 1,
            error: message,
            willRetry: false,
          });
          lastOutcome = { status: "failed", failureReason: message };
          lastNodeId = node.id;
          break;
        }
        const outcome = executed.value;
        branchContext.set("last_stage", node.id);
        if (outcome.text !== undefined) {
          branchContext.set("last_response", outcome.text.slice(0, 200));
          branchContext.set(`response.${node.id}`, outcome.text);
        }
        branchContext.merge(outcome.contextUpdates);
        lastOutcome = outcome;
        lastNodeId = node.id;

        const decision = selectRoute({ node, graph: this.graph, outcome, context: branchContext.toObject() });
        if (decision) {
          this.emit({
            type: "edge.selected",
            runId: this.runId,
            ts: this.clock.now(),
            from: node.id,
            to: decision.nodeId,
            edgeLabel: decision.edgeLabel,
            reason: decision.reason,
          });
        }
        nodeId = decision ? decision.nodeId : null;
      }

      return {
        result: { id: lastNodeId, index, status: lastOutcome.status, context_updates: lastOutcome.contextUpdates },
        joinNodeId,
      };
    };

    const branchOutcomes = await Promise.all(branchEdges.map((edge, index) => runBranch(edge, index)));
    if (this.signal.aborted) return null;

    const results = branchOutcomes.map((b) => b.result);
    this.context.set("parallel.results", results as unknown as JsonValue);
    this.context.set("parallel.branch_count", branchEdges.length);

    const joinIds = [...new Set(branchOutcomes.map((b) => b.joinNodeId).filter((id): id is string => id !== undefined))].sort();
    return joinIds.length > 0 ? joinIds[0] : null;
  }

  // -------------------------------------------------------------------------
  // Checkpoint + termination
  // -------------------------------------------------------------------------

  private async saveCheckpoint(nextNodeId: string): Promise<void> {
    if (!this.checkpointSink) return;
    const checkpoint: Checkpoint = {
      runId: this.runId,
      nextNodeId,
      context: this.context.toObject(),
      visitCounts: { ...this.visitCounts },
      goalGateOutcomes: { ...this.goalGateOutcomes },
    };
    await this.checkpointSink.save(checkpoint);
    this.emit({ type: "checkpoint.saved", runId: this.runId, ts: this.clock.now(), stageId: nextNodeId });
  }

  private finishCancelled(): RunResult {
    this.emit({ type: "run.cancelled", runId: this.runId, ts: this.clock.now() });
    return { status: "cancelled", finalOutcome: null, goalGateFailures: [], context: this.context.toObject() };
  }

  private finish(finalOutcome: Outcome | null): RunResult {
    const goalGateFailures = Object.entries(this.goalGateOutcomes)
      .filter(([, status]) => status !== "succeeded" && status !== "partially_succeeded")
      .map(([nodeId]) => nodeId)
      .sort();
    const outcomeSucceeded = finalOutcome !== null && (finalOutcome.status === "succeeded" || finalOutcome.status === "partially_succeeded");
    const status: "succeeded" | "failed" = outcomeSucceeded && goalGateFailures.length === 0 ? "succeeded" : "failed";
    this.emit({ type: "run.completed", runId: this.runId, ts: this.clock.now(), status, goalGateFailures });
    return { status, finalOutcome, goalGateFailures, context: this.context.toObject() };
  }

  private emit(event: RunEvent): void {
    this.onEvent(event);
  }
}

export async function runEngine(options: EngineOptions): Promise<RunResult> {
  return new Engine(options).run();
}
