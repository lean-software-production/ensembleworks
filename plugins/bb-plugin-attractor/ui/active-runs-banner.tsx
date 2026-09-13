/**
 * `ui/active-runs-banner.tsx` — the composer's "active runs" banner: shows
 * every Attractor run still in flight for the thread the composer is
 * mounted in, right above the message box, so a human doesn't have to go
 * hunting for the workflow's directive card (which may have scrolled off,
 * or never been pasted into this thread at all) to see it's still going.
 *
 * Registered from `app.tsx` via `app.composer.customize({ id:
 * "attractor-status", scopes: ["thread"], banners: [{ id: "active-runs",
 * chrome: "bare", component: ActiveRunsBanner }] })` — the same shape BB's
 * built-in Workflows plugin uses for its own composer "active runs" strip.
 * `chrome: "bare"` means this component supplies its own card chrome rather
 * than the host wrapping it in one (matching the dark card style
 * `ui/run-panel.tsx`'s `RunCard` already established).
 *
 * The thread id is read via `useComposerView()`'s scope rather than
 * `useBbContext()`: the customization's `scopes: ["thread"]` guarantees the
 * mounted composer is always a `{ kind: "thread" }` scope, and
 * `plugins/presence/app.tsx`'s own composer customization (`TypingPulse`)
 * already establishes `scope.kind === "thread" ? scope.threadId : null` as
 * this repo's idiom for reading it defensively anyway.
 *
 * Reuses `ui/run-panel.tsx`'s shared pieces (status colour classes, the
 * "Waiting: <label>" helper, the live-clock hook, and the realtime
 * refresh-coalescing hook) and `ui/dag.tsx`/`ui/stages.tsx` wholesale for
 * the expanded view, rather than duplicating any of them — reads only
 * `server/contracts.ts` and `dot/accelerator.ts`, never `server/service.ts`/
 * `server/store.ts` (see `ui/dag.tsx`'s header comment on why: those pull in
 * `better-sqlite3`, a native module that must never end up in the app's
 * esbuild bundle).
 */

import { useCallback, useEffect, useState } from "react";
import { experimental_Icon as ExperimentalIcon, useBbNavigate, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/contracts";
import type { GraphView, RunView, StageView } from "../server/contracts";
import { parseAcceleratorLabel } from "../dot/accelerator";
import { DagView } from "./dag";
import { StageList, formatDuration } from "./stages";
import { STATUS_TEXT_CLASS, REALTIME_CHANNEL, REFRESH_COALESCE_MS, useCoalescedRealtimeRefresh, useNow, waitingNodeLabel } from "./run-panel";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const ACTION_ID = "attractor-run";
const FALLBACK_POLL_MS = 5_000;

interface ActiveRun {
  run: RunView;
  stages: StageView[];
  graph: GraphView;
}

function useActiveRuns(rpc: Rpc, threadId: string | null) {
  const [runs, setRuns] = useState<ActiveRun[]>([]);

  const refresh = useCallback(() => {
    if (threadId === null) {
      setRuns([]);
      return;
    }
    rpc.call("activeRuns", { threadId }).then(
      (result) => setRuns(result.runs),
      () => setRuns([]),
    );
  }, [rpc, threadId]);

  useEffect(refresh, [refresh]);
  useCoalescedRealtimeRefresh(REALTIME_CHANNEL, refresh, REFRESH_COALESCE_MS);

  // The realtime channel only ever fires for a run this plugin already
  // knows about; a fallback poll picks up anything it otherwise missed
  // (e.g. a dropped realtime connection) while at least one run is active —
  // once every run reaches a terminal status this stops polling on its own.
  useEffect(() => {
    if (runs.length === 0) return;
    const timer = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [runs.length, refresh]);

  return { runs, refresh };
}

interface GateOption {
  raw: string;
  key: string | null;
  text: string;
}

/** The gate options for a blocked human-gate stage, derived straight from the graph's outgoing edges — the same accelerator parsing `handlers/human.ts` uses server-side to build `HumanGateOption[]`, since this banner only ever sees a `GraphView`, not that richer shape. */
function gateOptionsFor(graph: GraphView, nodeId: string): GateOption[] {
  return graph.edges
    .filter((e): e is GraphView["edges"][number] & { label: string } => e.from === nodeId && e.label !== null)
    .map((e) => {
      const { key, text } = parseAcceleratorLabel(e.label);
      return { raw: e.label, key, text };
    });
}

interface ActiveRunRowProps {
  activeRun: ActiveRun;
  threadId: string;
  now: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenPanel: () => void;
  onOpenThread: (threadId: string) => void;
  rpc: Rpc;
  onAnswered: () => void;
}

function ActiveRunRow({ activeRun, threadId, now, expanded, onToggleExpand, onOpenPanel, onOpenThread, rpc, onAnswered }: ActiveRunRowProps) {
  const { run, stages, graph } = activeRun;
  const total = graph.nodes.length;
  const visited = new Set(stages.map((s) => s.nodeId)).size;
  const waiting = waitingNodeLabel(run, stages, graph);
  const blockedStage = run.status === "blocked" ? (stages.find((s) => s.status === "blocked") ?? null) : null;
  const blockedNode = blockedStage ? (graph.nodes.find((n) => n.id === blockedStage.nodeId) ?? null) : null;
  const isHumanGate = blockedStage !== null && blockedNode?.handlerKind === "human";
  const options = isHumanGate ? gateOptionsFor(graph, blockedStage.nodeId) : [];
  const reviewPath = blockedStage?.gateContext?.reviewTarget?.path ?? null;
  const gateThreadId = blockedStage?.gateContext?.context?.threadId ?? null;

  const answer = (raw: string) => {
    void rpc.call("answerGate", { runId: run.id, threadId, answer: raw }).then(onAnswered);
  };

  return (
    <div className="py-1.5">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ExperimentalIcon name="Workflow" style={{ width: 14, height: 14, flexShrink: 0 }} />
        <strong style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.title ?? "Attractor run"}</strong>
        <span data-run-status={run.status} className={STATUS_TEXT_CLASS[run.status]} style={{ fontSize: 12 }}>
          {run.status}
        </span>
        <span className="text-xs text-muted-foreground">
          {visited}/{total} stages
        </span>
        <span className="text-xs text-muted-foreground">{formatDuration(Math.max(0, now - run.createdAt))}</span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse run details" : "Expand run details"}
          onClick={onToggleExpand}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button type="button" aria-label="Open in right panel" onClick={onOpenPanel} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
          ›
        </button>
      </div>
      {waiting ? (
        <p className="text-xs text-muted-foreground" style={{ margin: "2px 0 0" }}>
          Waiting: {waiting}
        </p>
      ) : null}
      {isHumanGate ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          {reviewPath ? <p className="text-xs">Reviewing: {reviewPath}</p> : null}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {options.map((option) => (
              <button key={option.raw} type="button" data-option-raw={option.raw} onClick={() => answer(option.raw)}>
                {option.key ? `[${option.key}] ${option.text}` : option.text}
              </button>
            ))}
          </div>
          {gateThreadId ? (
            <div>
              <button type="button" onClick={() => onOpenThread(gateThreadId)}>
                Open thread
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="mt-2" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="overflow-hidden rounded-md border border-border bg-white p-2">
            <DagView graph={graph} events={[]} currentNodeId={run.currentNodeId} onOpenThread={onOpenThread} direction="TB" />
          </div>
          <StageList stages={stages} graph={graph} now={now} onOpenThread={onOpenThread} />
        </div>
      ) : null}
    </div>
  );
}

/** The composer's "active runs" banner — see the module doc. Renders nothing outside a thread composer and when the thread has no active runs. */
export function ActiveRunsBanner() {
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { runs, refresh } = useActiveRuns(rpc, threadId);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const now = useNow(runs.length > 0);

  if (threadId === null || runs.length === 0) return null;
  const currentThreadId = threadId;

  return (
    <div className="rounded-lg border border-border bg-surface-raised-solid p-2 text-left divide-y divide-border" data-testid="attractor-active-runs">
      {runs.map((activeRun) => (
        <ActiveRunRow
          key={activeRun.run.id}
          activeRun={activeRun}
          threadId={currentThreadId}
          now={now}
          expanded={Boolean(expanded[activeRun.run.id])}
          onToggleExpand={() => setExpanded((prev) => ({ ...prev, [activeRun.run.id]: !prev[activeRun.run.id] }))}
          onOpenPanel={() =>
            navigate.openThreadPanel({ actionId: ACTION_ID, params: { runId: activeRun.run.id, threadId: currentThreadId }, title: activeRun.run.title ?? "Attractor run" })
          }
          onOpenThread={(openedThreadId) => navigate.toThread(openedThreadId)}
          rpc={rpc}
          onAnswered={refresh}
        />
      ))}
    </div>
  );
}
