/**
 * `ui/run-panel.tsx` — the run view shared by the `::attractor-run` message
 * directive and the thread-panel action (run-panel redesign, layout "A ·
 * What needs me").
 *
 * - **Directive** (chat): the attention card only (`ui/attention-card.tsx`,
 *   `surface="chat"`) — what the run needs, or that it needs nothing. No
 *   graph; its › opens the side panel.
 * - **Panel**: a header (title, status pill, Stop — or Resume for a failed
 *   or cancelled run), the attention card, a "Now" list of the stages in
 *   flight, then three accordions, collapsed by default and remembered:
 *   Graph (`ui/graph-section.tsx`), History (`ui/history.tsx`) and Event log
 *   (`ui/events.tsx`).
 *
 * Data: `getRun`/`getGraph`/`getEvents` on mount, refetched on any
 * `attractor-runs` realtime signal naming this run (coalesced).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server/contracts";
import type { GraphView, RunView, StageView } from "../server/contracts";
import { AttentionCard, type AttentionActions } from "./attention-card";
import { GraphSection } from "./graph-section";
import { History, historyCount, stageTone } from "./history";
import { EventLog } from "./events";
import { deriveAttention, formatClock, formatShortDuration, groupPasses, nodeById, nowView, progressOf, statusPill, type EventView } from "./run-model";
import { providerLabel } from "./stages";
import { Accordion, Btn, Dot, MUTED, Pill, ROW, SMALL, STORAGE_PREFIX, Section, TOKENS, TONE_TEXT_COLOR, useStoredState } from "./primitives";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** The realtime channel every run publishes one message per engine event on — shared by this panel and `ui/active-runs-banner.tsx`. */
export const REALTIME_CHANNEL = "attractor-runs";
export const ACTION_ID = "attractor-run";
export const REFRESH_COALESCE_MS = 150;

/**
 * Subscribes to `channel`, coalescing a burst of realtime messages into one
 * trailing `refresh()` call `coalesceMs` after the first of the burst — a
 * busy stage can emit several events within a few milliseconds, and without
 * this a subscriber would issue a refetch per event. `shouldRefresh` (when
 * given) filters which payloads even start the coalescing window; omit it to
 * refresh on every message on the channel.
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

export function isLive(run: RunView): boolean {
  return run.status === "running" || run.status === "blocked";
}

/** The attention card's actions, wired to this plugin's RPCs. Shared by the directive, the panel and the composer banner. */
export function attentionActions(rpc: Rpc, runId: string, threadId: string, onChanged: () => void, navigate: ReturnType<typeof useBbNavigate>, openPanel?: () => void): AttentionActions {
  return {
    answer: (answer) =>
      rpc.call("answerGate", { runId, threadId, answer }).then((r) => {
        onChanged();
        return r.answered ? null : (r.reason ?? "The answer was not accepted.");
      }),
    resume: () =>
      rpc.call("resumeRun", { runId, threadId }).then((r) => {
        onChanged();
        return r.resumed ? null : (r.reason ?? "The run could not be resumed.");
      }),
    openThread: (id) => navigate.toThread(id),
    openPanel,
  };
}

const NOW_WORD: Record<StageView["status"], string> = { running: "working", blocked: "waiting", succeeded: "done", failed: "failed", skipped: "skipped", cancelled: "stopped" };

function NowRow({ stage, graph, now, pass, onOpenThread }: { stage: StageView; graph: GraphView | null; now: number; pass: number | null; onOpenThread(threadId: string): void }) {
  const node = nodeById(graph).get(stage.nodeId);
  const tone = stageTone(stage.status);
  const provider = providerLabel(stage, node);
  const word = stage.status === "blocked" ? (stage.waitingUntil != null ? "paused" : "waiting on you") : NOW_WORD[stage.status];
  return (
    <div data-now-stage={stage.stageId} style={{ ...ROW, padding: "4px 0", borderBottom: `1px solid ${TOKENS.border}`, fontSize: 12 }}>
      <Dot tone={tone} />
      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node?.label ?? stage.nodeId}</strong>
      {pass !== null ? <span style={{ ...MUTED, whiteSpace: "nowrap" }}>pass {pass}</span> : null}
      <span style={{ ...SMALL, color: TONE_TEXT_COLOR[tone], whiteSpace: "nowrap" }}>{word}</span>
      <span style={{ flex: 1 }} />
      {provider !== "—" ? <span style={{ ...SMALL, ...MUTED, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{provider}</span> : null}
      <span style={{ ...SMALL, ...MUTED, whiteSpace: "nowrap" }}>{formatShortDuration(Math.max(0, (stage.completedAt ?? now) - stage.startedAt))}</span>
      {stage.threadId ? (
        <Btn variant="ghost" onClick={() => onOpenThread(stage.threadId!)}>
          Open
        </Btn>
      ) : null}
    </div>
  );
}

function NowList({ stages, graph, now, onOpenThread }: { stages: StageView[]; graph: GraphView | null; now: number; onOpenThread(threadId: string): void }) {
  const nodes = nodeById(graph);
  const view = nowView(stages, graph);
  // A human gate is the attention card itself: there is no "Now" row for it.
  const main = view.stages.filter((s) => nodes.get(s.nodeId)?.handlerKind !== "human");
  if (main.length === 0 && view.fanOuts.length === 0) return null;
  const passes = groupPasses(stages);
  const passOf = passes.length > 1 ? new Map(passes.flatMap((p) => p.stages.map((s) => [s.stageId, p.index] as const))) : null;
  const count = view.fanOuts.length === 1 && main.length === 0 ? `${view.fanOuts[0]!.stages.length} branches of ${view.fanOuts[0]!.forkLabel}` : undefined;
  return (
    <Section title="Now" count={count} testId="attractor-now">
      {main.map((s) => (
        <NowRow key={s.stageId} stage={s} graph={graph} now={now} pass={passOf?.get(s.stageId) ?? null} onOpenThread={onOpenThread} />
      ))}
      {view.fanOuts.map((fan) => (
        <div key={fan.groupId} data-now-fanout={fan.groupId}>
          {count === undefined ? <div style={{ ...SMALL, ...MUTED, marginTop: 4 }}>{fan.stages.length} branches of {fan.forkLabel}</div> : null}
          {fan.stages.map((s) => (
            <NowRow key={s.stageId} stage={s} graph={graph} now={now} pass={null} onOpenThread={onOpenThread} />
          ))}
          {fan.joinLabel ? (
            <div style={{ ...SMALL, ...MUTED, marginTop: 6 }}>
              Continues to <strong>{fan.joinLabel}</strong> when all {fan.stages.length > 2 ? fan.stages.length : "of them"} finish.
            </div>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

interface SectionState {
  graph: boolean;
  history: boolean;
  events: boolean;
}

const CLOSED: SectionState = { graph: false, history: false, events: false };

export interface RunPanelProps {
  runId: string;
  threadId: string;
  mode: "directive" | "panel";
}

/** The run view shared by the directive card (attention card) and the thread panel (layout A). */
export function RunPanel({ runId, threadId, mode }: RunPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { run, stages, graph, events, loaded, error, refresh } = useRunData(rpc, runId, threadId);
  const now = useNow(run ? isLive(run) : false);
  const [sections, setSections] = useStoredState<SectionState>(`${STORAGE_PREFIX}sections`, CLOSED);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  if (error) return <p role="alert">Could not load Attractor run: {error}</p>;
  if (!loaded) return <p role="status">Loading Attractor run…</p>;
  if (!run) return <p>Attractor run not found.</p>;

  const onOpenThread = (openedThreadId: string) => navigate.toThread(openedThreadId);
  // Carries this card's (possibly cross-thread) `threadId` along in params —
  // app.tsx's `Panel` reads it back so the opened panel keeps addressing the
  // run's actual origin thread, not whatever thread it is opened into.
  const openPanel = () => navigate.openThreadPanel({ actionId: ACTION_ID, params: { runId, threadId }, title: run.title ?? "Attractor run" });

  if (mode === "directive") {
    return <AttentionCard surface="chat" run={run} stages={stages} graph={graph} events={events} now={now} actions={attentionActions(rpc, runId, threadId, refresh, navigate, openPanel)} />;
  }

  const attention = deriveAttention(run, stages, graph, events);
  const pill = statusPill(run, attention);
  const progress = progressOf(run, stages, graph, now);
  const passCount = groupPasses(stages).length;
  const toggle = (key: keyof SectionState) => setSections({ ...CLOSED, ...sections, [key]: !sections[key] });
  const stop = () => {
    setHeaderError(null);
    rpc.call("stopRun", { runId, threadId }).then(refresh, (e: unknown) => setHeaderError(e instanceof Error ? e.message : String(e)));
  };
  const resume = () => {
    setHeaderError(null);
    rpc.call("resumeRun", { runId, threadId }).then(
      (r) => {
        if (!r.resumed) setHeaderError(r.reason ?? "The run could not be resumed.");
        refresh();
      },
      (e: unknown) => setHeaderError(e instanceof Error ? e.message : String(e)),
    );
  };

  // `app.tsx` registers this panel with `layout: "flush"` — the full tab
  // area, definite height, no host scrolling — so this root owns padding and
  // scrolling (`h-full min-h-0 overflow-y-auto`). Keep the scrolling on this
  // root only: no section below adds a bounded scroller of its own (README
  // "Scroll ownership"); the event log follows the live run by scrolling
  // this root, via `scrollRef`.
  return (
    <div ref={scrollRef} data-testid="attractor-run-panel" className="flex h-full min-h-0 flex-col overflow-y-auto p-3" style={{ gap: 12, textAlign: "left" }}>
      <div>
        <div style={ROW}>
          <strong style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis" }}>{run.title ?? "Attractor run"}</strong>
          {isLive(run) ? (
            <Btn variant="danger" onClick={stop}>
              Stop
            </Btn>
          ) : run.status === "failed" || run.status === "cancelled" ? (
            <Btn variant="primary" onClick={resume}>
              Resume
            </Btn>
          ) : null}
        </div>
        <div style={{ ...ROW, ...SMALL, ...MUTED, marginTop: 3, flexWrap: "wrap", gap: 6 }}>
          <span data-run-status={run.status}>
            <Pill tone={pill.tone}>{pill.word}</Pill>
          </span>
          <span>
            {formatShortDuration(Math.max(0, (run.finishedAt ?? now) - run.createdAt))}
            {run.finishedAt ? ` · ended ${formatClock(run.finishedAt)}` : ""}
            {progress.looping ? (passCount > 1 ? ` · pass ${passCount}` : "") : ` · ${progress.text}`}
          </span>
          <span style={{ fontFamily: TOKENS.fontMono, fontSize: 11 }}>· {run.id.slice(0, 8)}</span>
        </div>
        {headerError ? (
          <p role="alert" style={{ ...SMALL, color: TOKENS.destructiveText, margin: "6px 0 0" }}>
            {headerError}
          </p>
        ) : null}
        <AttentionCard surface="panel" run={run} stages={stages} graph={graph} events={events} now={now} actions={attentionActions(rpc, runId, threadId, refresh, navigate)} />
      </div>
      {isLive(run) ? <NowList stages={stages} graph={graph} now={now} onOpenThread={onOpenThread} /> : null}
      <Accordion id="graph" title="Graph" open={sections.graph} onToggle={() => toggle("graph")}>
        {graph ? <GraphSection run={run} stages={stages} graph={graph} events={events} now={now} onOpenThread={onOpenThread} /> : <p style={{ ...SMALL, ...MUTED }}>Loading graph…</p>}
      </Accordion>
      <Accordion id="history" title="History" count={historyCount(stages)} open={sections.history} onToggle={() => toggle("history")}>
        <History stages={stages} graph={graph} events={events} now={now} onOpenThread={onOpenThread} />
      </Accordion>
      <Accordion id="events" title="Event log" count={events.length} open={sections.events} onToggle={() => toggle("events")}>
        <EventLog runId={runId} events={events} stages={stages} graph={graph} scrollContainer={scrollRef} onOpenThread={onOpenThread} />
      </Accordion>
    </div>
  );
}
