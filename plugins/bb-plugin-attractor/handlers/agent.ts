/**
 * `agent` (box) handler: a full-tool BB worker thread, per
 * docs/plans/2026-09-13-attractor-runner-plan.md "Node shapes → handlers".
 * The BB-thread orchestration itself (spawn, wait, structured-result
 * validation/retry) lives in server/backend.ts; this handler only supplies
 * the per-run identity (threadId/projectId/environmentId) the backend needs
 * to reuse the origin thread's environment and provider defaults.
 */

import type { Handler } from "../engine/types";
import type { AgentBackend } from "../server/backend";

export interface AgentHandlerContext {
  /** The origin thread this run was started from. */
  threadId: string;
  projectId: string;
  environmentId: string;
}

export function createAgentHandler(backend: AgentBackend, runContext: AgentHandlerContext): Handler {
  return {
    run(input) {
      return backend.run({
        node: input.node,
        graph: input.graph,
        context: input.context,
        runId: input.runId,
        stageId: input.stageId,
        signal: input.signal,
        emit: input.emit,
        threadId: runContext.threadId,
        projectId: runContext.projectId,
        environmentId: runContext.environmentId,
      });
    },
  };
}
