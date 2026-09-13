/**
 * `ui/stages.tsx` — the stage list, per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5: "Panel: … stage list
 * with timing/visit/provider". Reads `RunView`/`StageView`/`GraphView` from
 * `server/contracts.ts` only (never `server/service.ts`/`server/store.ts` —
 * see ui/dag.tsx's header comment on why).
 */

import type { GraphView, StageView } from "../server/contracts";

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

/**
 * Prefers the stage's actually-resolved provider/model tuple
 * (`server/backend.ts`'s `resolveModelTuple`, persisted via the
 * `agent.thread` event) over the node's merely-declared DOT attributes —
 * three real worker threads all resolving to the thread/stylesheet default
 * used to show as an all-dashes column even though a real provider ran them.
 * Falls back to the declared tuple, then a dash. The resolved reasoning
 * level (there is no declared-DOT equivalent) is appended in parentheses
 * when known, so the actual tuple shown is genuinely complete, not just
 * provider/model.
 */
function providerLabel(stage: StageView, node: GraphView["nodes"][number] | undefined): string {
  const providerId = stage.providerId ?? node?.provider ?? null;
  const model = stage.model ?? node?.model ?? null;
  const reasoningLevel = stage.reasoningLevel ? ` (${stage.reasoningLevel})` : "";
  if (!providerId && !model) return "—";
  if (providerId && model) return `${providerId} / ${model}${reasoningLevel}`;
  return `${providerId ?? model ?? "—"}${reasoningLevel}`;
}

export interface StageListProps {
  stages: StageView[];
  /** Null while the graph hasn't loaded yet — stages still render, labelled by node id. */
  graph: GraphView | null;
  /** Caller-supplied clock reading, so a running stage's live elapsed time is deterministic in tests. */
  now: number;
  onOpenThread?: (threadId: string) => void;
}

export function StageList({ stages, graph, now, onOpenThread }: StageListProps) {
  const nodeById = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  return (
    <table data-testid="attractor-stage-list" style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left" }}>Node</th>
          <th style={{ textAlign: "left" }}>Status</th>
          <th style={{ textAlign: "left" }}>Visit</th>
          <th style={{ textAlign: "left" }}>Duration</th>
          <th style={{ textAlign: "left" }}>Provider</th>
          <th style={{ textAlign: "left" }}>Thread</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((stage) => {
          const node = nodeById.get(stage.nodeId);
          const elapsedMs = (stage.completedAt ?? now) - stage.startedAt;
          return (
            <tr key={stage.stageId} data-stage-id={stage.stageId} data-status={stage.status}>
              <td>{node?.label ?? stage.nodeId}</td>
              <td>
                {stage.status}
                {stage.actor ? ` (answered via ${stage.actor})` : ""}
                {stage.status === "blocked" && stage.waitingReason ? ` (waiting: ${stage.waitingReason})` : ""}
                {stage.status === "blocked" && stage.gateContext?.reviewTarget ? ` (reviewing ${stage.gateContext.reviewTarget.path})` : ""}
              </td>
              <td>{stage.visit}</td>
              <td>{formatDuration(Math.max(0, elapsedMs))}</td>
              <td>{providerLabel(stage, node)}</td>
              <td>
                {stage.threadId && onOpenThread ? (
                  <button type="button" onClick={() => onOpenThread(stage.threadId!)}>
                    Open thread
                  </button>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
