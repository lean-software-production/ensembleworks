/**
 * `ui/run-panel.tsx` — the run view shared by the `::attractor-run` message
 * directive (compact) and the thread-panel action (full), per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5:
 *
 * "Message directive card: header (name, status, elapsed, n/N stages), the
 * DAG, expandable stage list, 'Open in right panel'. Panel: DAG large, stage
 * list with timing/visit/provider, event timeline (paged), Stop button. …
 * Live updates through `useRealtime("attractor-runs")` → refetch."
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/contracts";
import type { GraphView, RunView, StageView } from "../server/contracts";
import { DagView } from "./dag";
import { StageList, formatDuration } from "./stages";
import { EventTimeline, type EventView } from "./events";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const REALTIME_CHANNEL = "attractor-runs";
const ACTION_ID = "attractor-run";
const REFRESH_COALESCE_MS = 150;

function useRunData(rpc: Rpc, runId: string, threadId: string) {
  const [run, setRun] = useState<RunView | null>(null);
  const [stages, setStages] = useState<StageView[]>([]);
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    Promise.all([rpc.call("getRun", { runId, threadId }), rpc.call("getGraph", { runId, threadId }), rpc.call("getEvents", { runId, threadId })]).then(
      ([runResult, graphResult, eventsResult]) => {
        setRun(runResult.run);
        setStages(runResult.stages);
        setGraph(graphResult);
        setEvents(eventsResult.events as EventView[]);
        setLoaded(true);
        setError(null);
      },
      (e: unknown) => {
        setLoaded(true);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  }, [rpc, runId, threadId]);

  useEffect(refresh, [refresh]);

  // The server publishes one realtime message per engine event, and a busy
  // stage can emit several within a few milliseconds. Coalesce them into one
  // trailing refetch so the panel never issues a burst of RPC triplets.
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pendingRefresh.current !== null) clearTimeout(pendingRefresh.current);
  }, []);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    const named = payload && typeof payload === "object" ? (payload as { runId?: string }).runId : undefined;
    if (named !== undefined && named !== runId) return;
    if (pendingRefresh.current !== null) return;
    pendingRefresh.current = setTimeout(() => {
      pendingRefresh.current = null;
      refresh();
    }, REFRESH_COALESCE_MS);
  });

  return { run, stages, graph, events, loaded, error, refresh };
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function latestThreadIdByNode(stages: StageView[]): Record<string, string | null | undefined> {
  const byNode: Record<string, string | null | undefined> = {};
  for (const stage of stages) byNode[stage.nodeId] = stage.threadId ?? byNode[stage.nodeId];
  return byNode;
}

function RunHeader({ run, graph, stages, now }: { run: RunView; graph: GraphView | null; stages: StageView[]; now: number }) {
  const total = graph?.nodes.length ?? 0;
  const visited = new Set(stages.map((s) => s.nodeId)).size;
  const elapsedMs = (run.finishedAt ?? now) - run.createdAt;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      <strong>{run.title ?? "Attractor run"}</strong>
      <span data-run-status={run.status}>{run.status}</span>
      <span>{formatDuration(Math.max(0, elapsedMs))}</span>
      <span>
        {visited}/{total} stages
      </span>
    </div>
  );
}

export interface RunPanelProps {
  runId: string;
  threadId: string;
  mode: "directive" | "panel";
}

/** The run view shared by the directive card (compact) and the thread panel (full). */
export function RunPanel({ runId, threadId, mode }: RunPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { run, stages, graph, events, loaded, error, refresh } = useRunData(rpc, runId, threadId);
  const [expanded, setExpanded] = useState(false);
  const now = useNow(run?.status === "running" || run?.status === "blocked");

  if (error) return <p role="alert">Could not load Attractor run: {error}</p>;
  if (!loaded) return <p role="status">Loading Attractor run…</p>;
  if (!run) return <p>Attractor run not found.</p>;

  const threadIdByNode = latestThreadIdByNode(stages);
  const onOpenThread = (openedThreadId: string) => navigate.toThread(openedThreadId);
  const dag = graph ? (
    <DagView graph={graph} events={events} currentNodeId={run.currentNodeId} threadIdByNode={threadIdByNode} onOpenThread={onOpenThread} />
  ) : (
    <p>Loading graph…</p>
  );

  if (mode === "directive") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <RunHeader run={run} graph={graph} stages={stages} now={now} />
        {dag}
        <div>
          <button type="button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide stages" : "Show stages"}
          </button>
          <button
            type="button"
            onClick={() => navigate.openThreadPanel({ actionId: ACTION_ID, params: { runId }, title: run.title ?? "Attractor run" })}
          >
            Open in right panel
          </button>
        </div>
        {expanded ? <StageList stages={stages} graph={graph} now={now} onOpenThread={onOpenThread} /> : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <RunHeader run={run} graph={graph} stages={stages} now={now} />
        {run.status === "running" || run.status === "blocked" ? (
          <button type="button" onClick={() => rpc.call("stopRun", { runId, threadId }).then(refresh)}>
            Stop
          </button>
        ) : null}
      </div>
      {dag}
      <StageList stages={stages} graph={graph} now={now} onOpenThread={onOpenThread} />
      <EventTimeline events={events} />
    </div>
  );
}
