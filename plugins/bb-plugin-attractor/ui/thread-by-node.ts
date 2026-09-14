/**
 * `ui/thread-by-node.ts` — the nodeId -> worker-threadId derivation shared
 * by the message-directive card, the thread panel, and the composer banner
 * (all three render `DagView` and want its click-to-thread affordance;
 * before this file existed the derivation lived only in `ui/run-panel.tsx`,
 * so `ui/active-runs-banner.tsx` rendered `DagView` without it and none of
 * its nodes were ever clickable). Reads only `server/contracts.ts` — see
 * `ui/dag.tsx`'s header comment on why.
 */
import type { StageView } from "../server/contracts";

/** nodeId -> the worker threadId of its most recent visit, when known. */
export function latestThreadIdByNode(stages: readonly StageView[]): Record<string, string | null | undefined> {
  const byNode: Record<string, string | null | undefined> = {};
  for (const stage of stages) byNode[stage.nodeId] = stage.threadId ?? byNode[stage.nodeId];
  return byNode;
}
