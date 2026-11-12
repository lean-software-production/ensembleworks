/**
 * `ui/stages.tsx` — per-stage display helpers. The four-column stage table
 * that used to live here was replaced by the side panel's History section
 * (`ui/history.tsx`, run-panel redesign); what remains is shared by the
 * "Now" list, history rows and the graph's node detail. Reads
 * `server/contracts.ts` only (see ui/dag.tsx's header comment on why).
 */

import type { GraphView, StageView } from "../server/contracts";

export { formatDuration } from "./run-model";

/**
 * Prefers the stage's actually-resolved provider/model tuple
 * (`server/backend.ts`'s `resolveModelTuple`, persisted via the
 * `agent.thread` event) over the node's merely-declared DOT attributes.
 * Falls back to the declared tuple, then a dash. The resolved reasoning
 * level (there is no declared-DOT equivalent) is appended in parentheses
 * when known.
 */
export function providerLabel(stage: StageView, node: GraphView["nodes"][number] | undefined): string {
  const providerId = stage.providerId ?? node?.provider ?? null;
  const model = stage.model ?? node?.model ?? null;
  const reasoningLevel = stage.reasoningLevel ? ` (${stage.reasoningLevel})` : "";
  if (!providerId && !model) return "—";
  if (providerId && model) return `${providerId} / ${model}${reasoningLevel}`;
  return `${providerId ?? model ?? "—"}${reasoningLevel}`;
}
