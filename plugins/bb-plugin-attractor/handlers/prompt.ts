/**
 * `prompt` (tab) handler: a single LLM call intended to run with read-only
 * tools, per "Node shapes → handlers". BB's plugin SDK has no per-tool
 * read-only restriction a plugin can apply to a spawned thread (see README
 * "Deviations from the plan"), so this v1 handler is otherwise identical to
 * `agent` — it reuses the same BB-thread backend and orchestration.
 */

import { createAgentHandler, type AgentHandlerContext } from "./agent";
import type { Handler } from "../engine/types";
import type { AgentBackend } from "../server/backend";

export function createPromptHandler(backend: AgentBackend, runContext: AgentHandlerContext): Handler {
  return createAgentHandler(backend, runContext);
}
