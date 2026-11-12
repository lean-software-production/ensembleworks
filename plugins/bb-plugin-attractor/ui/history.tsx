/**
 * `ui/history.tsx` — the side panel's History accordion (run-panel
 * redesign). Two readings of the same stage rows:
 *
 * - **By pass** (default): stages grouped into passes by `run-model.ts`'s
 *   `groupPasses` (a new pass whenever the run re-enters a node already in
 *   the current one — no graph analysis). Each pass has a small timeline on
 *   its own time axis, with a worker's waits drawn apart from its working
 *   time, and links to that pass's worker threads. Parallel branches indent
 *   under their fan-out and share its axis. A graph with no loop is a single
 *   pass, shown as a flat list with no pass headers. Older passes fold
 *   together; the latest two are open.
 * - **List**: every stage, newest first, narrowed by a text filter and kind
 *   chips (agents, commands, gates, failed).
 */

import { useState } from "react";
import type { GraphNodeView, GraphView, StageView } from "../server/contracts";
import {
  formatDuration,
  formatShortDuration,
  groupPasses,
  nodeById,
  stageMatchesChip,
  waitSpansByStage,
  type EventView,
  type Pass,
  type PillTone,
  type StageKindChip,
  type WaitSpan,
} from "./run-model";
import { Btn, Dot, MUTED, ROW, SMALL, STORAGE_PREFIX, TimelineBar, TONE_TEXT_COLOR, TOKENS, ViewSwitch, useStoredState, type BarSegment } from "./primitives";

export interface HistoryProps {
  stages: StageView[];
  graph: GraphView | null;
  events: EventView[];
  now: number;
  onOpenThread(threadId: string): void;
}

export function stageTone(status: StageView["status"]): PillTone {
  switch (status) {
    case "running":
      return "run";
    case "blocked":
      return "warn";
    case "succeeded":
      return "ok";
    case "failed":
      return "bad";
    default:
      return "muted";
  }
}

const PASS_WORD: Partial<Record<Pass["status"], string>> = { running: "in progress", blocked: "waiting", failed: "failed", cancelled: "stopped" };

/** Fan-out branch stages placed straight after their fork's own stage, ordered by branch — so they indent under it. */
function orderWithBranches(stages: readonly StageView[]): { stage: StageView; depth: number }[] {
  const byGroup = new Map<string, StageView[]>();
  for (const s of stages) if (s.parallelGroupId) byGroup.set(s.parallelGroupId, [...(byGroup.get(s.parallelGroupId) ?? []), s]);
  const placed = new Set<string>();
  const out: { stage: StageView; depth: number }[] = [];
  for (const s of stages) {
    if (placed.has(s.stageId)) continue;
    const key = `${s.nodeId}@${s.visit}`;
    if (s.parallelGroupId && byGroup.has(s.parallelGroupId) && stages.some((f) => `${f.nodeId}@${f.visit}` === s.parallelGroupId)) continue; // placed under its fork
    out.push({ stage: s, depth: 0 });
    placed.add(s.stageId);
    const members = byGroup.get(key);
    if (members) {
      for (const m of [...members].sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0) || a.startedAt - b.startedAt)) {
        out.push({ stage: m, depth: 1 });
        placed.add(m.stageId);
      }
    }
  }
  // A branch whose fork row is outside this pass (or missing) still shows, indented.
  for (const s of stages) if (!placed.has(s.stageId)) out.push({ stage: s, depth: 1 });
  return out;
}

function waitedMs(spans: readonly WaitSpan[], now: number): number {
  return spans.reduce((sum, w) => sum + ((w.end ?? now) - w.start), 0);
}

function StageTimelineRow({ stage, depth, node, axisStart, axisSpan, spans, now }: { stage: StageView; depth: number; node: GraphNodeView | undefined; axisStart: number; axisSpan: number; spans: WaitSpan[]; now: number }) {
  const end = stage.completedAt ?? now;
  const tone = stageTone(stage.status);
  const gateWaiting = node?.handlerKind === "human" && stage.status === "blocked";
  const segments: BarSegment[] = [{ left: (stage.startedAt - axisStart) / axisSpan, width: (end - stage.startedAt) / axisSpan, tone: gateWaiting ? "warn" : tone, faint: gateWaiting }];
  for (const w of spans) segments.push({ left: (w.start - axisStart) / axisSpan, width: ((w.end ?? now) - w.start) / axisSpan, tone: "warn", faint: true });
  const waited = waitedMs(spans, now);
  const total = end - stage.startedAt;
  const inFlight = stage.completedAt === null;
  const duration = waited > 0 && inFlight ? `${formatShortDuration(Math.max(0, total - waited))} + wait` : `${formatDuration(Math.max(0, total))}${inFlight ? "…" : ""}`;
  const label = node?.label ?? stage.nodeId;
  return (
    <div data-history-stage={stage.stageId} data-depth={depth} style={{ ...ROW, ...SMALL, paddingLeft: depth * 10 }}>
      <span title={label} style={{ width: 86 - depth * 10, flex: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: stage.status === "blocked" ? TOKENS.warningText : stage.status === "failed" ? TOKENS.destructiveText : undefined }}>
        {label}
      </span>
      <TimelineBar segments={segments} label={`${label}: ${stage.status}`} />
      <span style={{ ...MUTED, width: 64, flex: "none", textAlign: "right", whiteSpace: "nowrap" }}>{duration}</span>
    </div>
  );
}

function PassBody({ pass, graph, waits, now, onOpenThread }: { pass: Pass; graph: GraphView | null; waits: Map<string, WaitSpan[]>; now: number; onOpenThread(threadId: string): void }) {
  const nodes = nodeById(graph);
  const axisStart = pass.startedAt;
  const axisSpan = Math.max(1, (pass.endedAt ?? now) - axisStart);
  const workers = pass.stages.filter((s) => s.threadId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {orderWithBranches(pass.stages).map(({ stage, depth }) => (
        <StageTimelineRow key={stage.stageId} stage={stage} depth={depth} node={nodes.get(stage.nodeId)} axisStart={axisStart} axisSpan={axisSpan} spans={waits.get(`${stage.nodeId}@${stage.visit}`) ?? []} now={now} />
      ))}
      {workers.length > 0 ? (
        <div style={{ ...ROW, flexWrap: "wrap", gap: 4, marginTop: 3 }}>
          {workers.map((s) => (
            <Btn key={s.stageId} variant="ghost" onClick={() => onOpenThread(s.threadId!)}>
              Open {nodes.get(s.nodeId)?.label ?? s.nodeId}
            </Btn>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FoldRow({ open, onToggle, tone, title, word, duration, bold }: { open: boolean; onToggle(): void; tone: PillTone; title: string; word?: string; duration: string; bold?: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      style={{ ...ROW, ...SMALL, width: "100%", background: "none", border: "none", padding: "3px 0", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, color: "inherit", textAlign: "left" }}
    >
      <span aria-hidden style={{ ...MUTED, width: 12, fontSize: 14, lineHeight: 1 }}>
        {open ? "▾" : "▸"}
      </span>
      <Dot tone={tone} />
      {bold ? <strong>{title}</strong> : <span>{title}</span>}
      {word ? <span style={{ color: TONE_TEXT_COLOR[tone] }}>· {word}</span> : null}
      <span style={{ flex: 1 }} />
      <span style={MUTED}>{duration}</span>
    </button>
  );
}

function passTone(pass: Pass): PillTone {
  return pass.status === "running" ? "run" : pass.status === "blocked" ? "warn" : pass.status === "failed" ? "bad" : pass.status === "cancelled" ? "muted" : "ok";
}

function ByPass({ stages, graph, events, now, onOpenThread }: HistoryProps) {
  const passes = groupPasses(stages);
  const waits = waitSpansByStage(events);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (passes.length === 0) return <p style={{ ...SMALL, ...MUTED, margin: 0 }}>No stages yet.</p>;
  if (passes.length === 1) return <PassBody pass={passes[0]!} graph={graph} waits={waits} now={now} onOpenThread={onOpenThread} />;
  const recent = passes.slice(-2);
  const older = passes.slice(0, -2);
  const isOpen = (key: string, fallback: boolean) => open[key] ?? fallback;
  const toggle = (key: string, fallback: boolean) => setOpen((o) => ({ ...o, [key]: !(o[key] ?? fallback) }));
  const durationOf = (ps: Pass[]) => formatShortDuration(Math.max(0, (ps.at(-1)!.endedAt ?? now) - ps[0]!.startedAt));
  const passRow = (pass: Pass, fallbackOpen: boolean, bold: boolean) => (
    <div key={pass.index} data-pass={pass.index}>
      <FoldRow open={isOpen(`p${pass.index}`, fallbackOpen)} onToggle={() => toggle(`p${pass.index}`, fallbackOpen)} tone={passTone(pass)} title={`Pass ${pass.index}`} word={PASS_WORD[pass.status]} duration={durationOf([pass])} bold={bold} />
      {isOpen(`p${pass.index}`, fallbackOpen) ? (
        <div style={{ padding: "2px 0 6px 20px" }}>
          <PassBody pass={pass} graph={graph} waits={waits} now={now} onOpenThread={onOpenThread} />
        </div>
      ) : null}
    </div>
  );
  return (
    <div data-testid="history-passes">
      {older.length > 0 ? (
        <div data-pass-fold>
          <FoldRow
            open={isOpen("older", false)}
            onToggle={() => toggle("older", false)}
            tone={older.some((p) => p.status === "failed") ? "bad" : "ok"}
            title={older.length === 1 ? "Pass 1" : `Passes 1–${older.length}`}
            duration={durationOf(older)}
          />
          {isOpen("older", false) ? <div style={{ paddingLeft: 14 }}>{older.map((p) => passRow(p, false, false))}</div> : null}
        </div>
      ) : null}
      {recent.map((p) => passRow(p, true, true))}
    </div>
  );
}

const CHIPS: { value: StageKindChip; label: string }[] = [
  { value: "all", label: "All" },
  { value: "agents", label: "Agents" },
  { value: "commands", label: "Commands" },
  { value: "gates", label: "Gates" },
  { value: "failed", label: "Failed" },
];

const LIST_PAGE = 50;

function FilteredList({ stages, graph, now, onOpenThread }: HistoryProps) {
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<StageKindChip>("all");
  const [limit, setLimit] = useState(LIST_PAGE);
  const nodes = nodeById(graph);
  const passes = groupPasses(stages);
  const passOf = new Map(passes.flatMap((p) => p.stages.map((s) => [s.stageId, p.index] as const)));
  const q = query.trim().toLowerCase();
  const textMatch = (s: StageView) => !q || (nodes.get(s.nodeId)?.label ?? "").toLowerCase().includes(q) || s.nodeId.toLowerCase().includes(q) || s.status.includes(q);
  const newestFirst = [...stages].reverse();
  const matching = newestFirst.filter((s) => textMatch(s) && stageMatchesChip(s, nodes.get(s.nodeId), chip));
  const shown = matching.slice(0, limit);
  return (
    <div data-testid="history-list">
      <input
        aria-label="Filter stages"
        placeholder="Filter stages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 12, padding: "4px 8px", borderRadius: `calc(${TOKENS.radius} - 2px)`, border: `1px solid ${TOKENS.border}`, background: "transparent", color: "inherit", marginBottom: 8 }}
      />
      <div role="group" aria-label="Stage kinds" style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
        {CHIPS.map((c) => {
          const count = newestFirst.filter((s) => textMatch(s) && stageMatchesChip(s, nodes.get(s.nodeId), c.value)).length;
          return (
            <Btn key={c.value} variant="ghost" pressed={chip === c.value} onClick={() => setChip(c.value)}>
              {c.label} {count}
            </Btn>
          );
        })}
      </div>
      {shown.map((s) => {
        const node = nodes.get(s.nodeId);
        const tone = stageTone(s.status);
        const live = s.status === "running" || s.status === "blocked";
        return (
          <div key={s.stageId} data-history-row={s.stageId} style={{ ...ROW, padding: "4px 0", borderBottom: `1px solid ${TOKENS.border}`, fontSize: 12 }}>
            <Dot tone={tone} />
            {live ? <strong>{node?.label ?? s.nodeId}</strong> : <span>{node?.label ?? s.nodeId}</span>}
            {passes.length > 1 ? <span style={MUTED}>pass {passOf.get(s.stageId)}</span> : null}
            <span style={{ flex: 1 }} />
            {s.status !== "succeeded" ? <span style={{ ...SMALL, color: TONE_TEXT_COLOR[tone] }}>{s.status === "blocked" ? "waiting" : s.status}</span> : null}
            <span style={{ ...MUTED, width: 56, textAlign: "right", flex: "none" }}>{formatShortDuration(Math.max(0, (s.completedAt ?? now) - s.startedAt))}</span>
            {s.threadId ? (
              <Btn variant="ghost" onClick={() => onOpenThread(s.threadId!)}>
                Open
              </Btn>
            ) : null}
          </div>
        );
      })}
      <div style={{ ...ROW, ...SMALL, ...MUTED, marginTop: 6 }}>
        <span>
          {matching.length === 0 ? "No matching stages" : `Newest first${matching.length > shown.length ? ` · ${matching.length - shown.length} more` : ""}`}
        </span>
        <span style={{ flex: 1 }} />
        {matching.length > shown.length ? (
          <Btn variant="ghost" onClick={() => setLimit((l) => l + LIST_PAGE)}>
            Show more
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

export type HistoryView = "passes" | "list";

export function History(props: HistoryProps) {
  const [view, setView] = useStoredState<HistoryView>(`${STORAGE_PREFIX}history-view`, "passes");
  return (
    <div data-testid="history-section">
      <div style={{ marginBottom: 8 }}>
        <ViewSwitch
          label="History view"
          value={view}
          onChange={setView}
          options={[
            { value: "passes", label: "By pass" },
            { value: "list", label: "List" },
          ]}
        />
      </div>
      {view === "passes" ? <ByPass {...props} /> : <FilteredList {...props} />}
    </div>
  );
}

/** The accordion header's count: "52 stages · 9 passes" ("· n passes" only when the run has looped). */
export function historyCount(stages: readonly StageView[]): string {
  const passes = groupPasses(stages).length;
  return `${stages.length} ${stages.length === 1 ? "stage" : "stages"}${passes > 1 ? ` · ${passes} passes` : ""}`;
}
