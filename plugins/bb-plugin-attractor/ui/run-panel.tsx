/**
 * `ui/run-panel.tsx` — the run view shared by the `::attractor-run` message
 * directive (compact) and the thread-panel action (full), per
 * docs/plans/2026-09-13-attractor-runner-plan.md T5 and the vertical
 * Fabro-style restyle:
 *
 * "Message directive card: header (name, status, elapsed, n/N stages), the
 * DAG, expandable stage list, 'Open in right panel'. Panel: DAG large, stage
 * list with timing/visit/provider, event timeline (paged), Stop button. …
 * Live updates through `useRealtime("attractor-runs")` → refetch."
 *
 * The restyle wraps the header/status/summary/graph/legend in one dark BB
 * card (`RunCard` below), shared verbatim by both surfaces — the directive
 * caps its width (`max-w-md`) and gets the header's "Open in right panel"
 * chevron; the panel surface drops the width cap and the chevron (it is
 * already the right panel) and adds the Stop button, stage table and event
 * timeline below the card, as before.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
// Aliased to a PascalCase local name: JSX treats a lowercase-leading tag name
// (`<experimental_Icon />`) as a host/DOM element, not a component reference
// — `<ExperimentalIcon />` below is what actually invokes the SDK's export.
import { experimental_Icon as ExperimentalIcon, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/contracts";
import type { GraphView, RunView, StageView } from "../server/contracts";
import { DagView } from "./dag";
import { StageList, formatDuration } from "./stages";
import { EventTimeline, type EventView } from "./events";
import { latestThreadIdByNode } from "./thread-by-node";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** The realtime channel every run publishes one message per engine event on — shared by this panel and `ui/active-runs-banner.tsx`. */
export const REALTIME_CHANNEL = "attractor-runs";
const ACTION_ID = "attractor-run";
export const REFRESH_COALESCE_MS = 150;

/**
 * Subscribes to `channel`, coalescing a burst of realtime messages into one
 * trailing `refresh()` call `coalesceMs` after the first of the burst — a
 * busy stage can emit several events within a few milliseconds, and without
 * this a subscriber would issue a refetch per event. `shouldRefresh` (when
 * given) filters which payloads even start the coalescing window; omit it to
 * refresh on every message on the channel (the active-runs banner has no
 * single runId to filter by, so it refreshes on any event on this channel).
 * Shared by `useRunData` below and `ui/active-runs-banner.tsx`'s own refresh.
 */
export function useCoalescedRealtimeRefresh(channel: string, refresh: () => void, coalesceMs: number, shouldRefresh?: (payload: unknown) => boolean) {
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (pendingRefresh.current !== null) clearTimeout(pendingRefresh.current);
  }, []);
  useRealtime(channel, (payload) => {
    if (shouldRefresh && !shouldRefresh(payload)) return;
    if (pendingRefresh.current !== null) return;
    pendingRefresh.current = setTimeout(() => {
      pendingRefresh.current = null;
      refresh();
    }, coalesceMs);
  });
}

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
  useCoalescedRealtimeRefresh(REALTIME_CHANNEL, refresh, REFRESH_COALESCE_MS, (payload) => {
    const named = payload && typeof payload === "object" ? (payload as { runId?: string }).runId : undefined;
    return named === undefined || named === runId;
  });

  return { run, stages, graph, events, loaded, error, refresh };
}

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// Status word colour, per the restyle's card chrome spec. Exported for
// `ui/active-runs-banner.tsx`'s per-run status word (same mapping).
export const STATUS_TEXT_CLASS: Record<RunView["status"], string> = {
  running: "text-amber-600",
  blocked: "text-amber-600",
  succeeded: "text-green-600",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

/** The label of the stage a blocked run is waiting on — human gate or agent-waiting alike (item 5) — for the card's "Waiting: <label>" summary suffix. Null when nothing is blocked, or the graph hasn't loaded. Exported for `ui/active-runs-banner.tsx`'s per-row summary. */
export function waitingNodeLabel(run: RunView, stages: StageView[], graph: GraphView | null): string | null {
  if (run.status !== "blocked") return null;
  const blockedStage = stages.find((s) => s.status === "blocked");
  if (!blockedStage) return null;
  const node = graph?.nodes.find((n) => n.id === blockedStage.nodeId);
  return node?.label ?? blockedStage.nodeId;
}

interface RunCardProps {
  run: RunView;
  graph: GraphView | null;
  stages: StageView[];
  now: number;
  dag: ReactNode;
  /** Present only for the directive surface — renders the header's chevron and opens the thread panel. Omitted in "panel" mode (already the right panel). */
  onOpenPanel?: () => void;
  /** "directive" caps the card's width (`max-w-md`); "panel" fills its container. */
  maxWidth: boolean;
  /** Optional footer row rendered inside the card, below the legend (the directive's "Show stages" toggle). */
  footer?: ReactNode;
}

/**
 * The dark BB card shared by both surfaces: header (workflow icon, title,
 * optional chevron), status row (coloured status word + short run id),
 * summary line (stage count, elapsed, and "Waiting: <label>" while blocked),
 * the DAG in a white rounded box, and a status-colour legend.
 */
function RunCard({ run, graph, stages, now, dag, onOpenPanel, maxWidth, footer }: RunCardProps) {
  const total = graph?.nodes.length ?? 0;
  const visited = new Set(stages.map((s) => s.nodeId)).size;
  const elapsedMs = (run.finishedAt ?? now) - run.createdAt;
  const waiting = waitingNodeLabel(run, stages, graph);
  return (
    <div className={`rounded-lg border border-border bg-card p-3 text-left shadow-sm${maxWidth ? " my-2 w-full max-w-md" : ""}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <ExperimentalIcon name="Workflow" style={{ width: 16, height: 16 }} />
        <strong style={{ flex: 1 }}>{run.title ?? "Attractor run"}</strong>
        {onOpenPanel ? (
          <button type="button" aria-label="Open in right panel" onClick={onOpenPanel} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            ›
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 4 }}>
        <span data-run-status={run.status} className={STATUS_TEXT_CLASS[run.status]}>
          {run.status}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
      </div>
      <p className="text-xs text-muted-foreground" style={{ margin: "2px 0 0" }}>
        Stages: {visited}/{total} · Elapsed: {formatDuration(Math.max(0, elapsedMs))}
        {waiting ? ` · Waiting: ${waiting}` : ""}
      </p>
      <div className="mt-2 overflow-hidden rounded-md border border-border bg-white p-2">{dag}</div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <LegendEntry color="#16a34a" label="Completed" />
        <LegendEntry color="#2563eb" label="Running" />
        <LegendEntry color="#dc2626" label="Failed" />
        <LegendEntry color="#d97706" label="Blocked" />
        <LegendEntry color="#94a3b8" label="Pending" hollow />
      </div>
      {footer ? <div data-card-footer className="mt-2 text-xs">{footer}</div> : null}
    </div>
  );
}

function LegendEntry({ color, label, hollow }: { color: string; label: string; hollow?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          display: "inline-block",
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: hollow ? "#fff" : color,
          border: `1.5px solid ${color}`,
        }}
      />
      {label}
    </span>
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
      <div>
        <RunCard
          run={run}
          graph={graph}
          stages={stages}
          now={now}
          dag={dag}
          maxWidth
          // Carries this card's (possibly cross-thread) `threadId` along in
          // params — app.tsx's `Panel` reads it back so the opened panel
          // keeps addressing the run's actual origin thread, not whatever
          // thread the panel happens to be opened into.
          onOpenPanel={() => navigate.openThreadPanel({ actionId: ACTION_ID, params: { runId, threadId }, title: run.title ?? "Attractor run" })}
          footer={
            <>
              <button type="button" onClick={() => setExpanded((v) => !v)} style={{ background: "none", border: "none", padding: 0, color: "inherit", textDecoration: "underline", cursor: "pointer" }}>
                {expanded ? "Hide stages" : "Show stages"}
              </button>
              {expanded ? <StageList stages={stages} graph={graph} now={now} onOpenThread={onOpenThread} /> : null}
            </>
          }
        />
      </div>
    );
  }

  // `app.tsx` registers this panel with `layout: "flush"`, which the SDK
  // documents as "the full tab area (no padding, definite height, no host
  // scrolling)" — the component owns padding *and* scrolling. A plain
  // auto-height column therefore overflowed the definite-height tab and was
  // simply clipped: the stage table and event log rendered below the fold
  // with nothing able to scroll to them. `h-full min-h-0 overflow-y-auto`
  // makes this root the pane's own scroll container (the same shape
  // plugins/bb-plugin-fabro's flush panel root uses). Keep the scrolling on
  // this root only — a nested bounded scroller here, or in either of the
  // chat/composer surfaces, swallows the host's wheel events (see
  // ui/human-gate.tsx's ReviewTargetBlock).
  return (
    <div data-testid="attractor-run-panel" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <RunCard run={run} graph={graph} stages={stages} now={now} dag={dag} maxWidth={false} />
        </div>
        {run.status === "running" || run.status === "blocked" ? (
          <button type="button" onClick={() => rpc.call("stopRun", { runId, threadId }).then(refresh)}>
            Stop
          </button>
        ) : null}
      </div>
      <StageList stages={stages} graph={graph} now={now} onOpenThread={onOpenThread} />
      <EventTimeline events={events} />
    </div>
  );
}
