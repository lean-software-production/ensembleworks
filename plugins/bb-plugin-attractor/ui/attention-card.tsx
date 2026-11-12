/**
 * `ui/attention-card.tsx` — the attention card (run-panel redesign): one
 * component that says what a run needs, or that it needs nothing. It is the
 * chat card (`surface="chat"`), the top of the side panel
 * (`surface="panel"`), and each row of the composer banner
 * (`surface="banner"`). All three take their state from `run-model.ts`'s
 * `deriveAttention`, so they cannot disagree; the surfaces differ only in
 * density (the panel shows the review preview, the output tail and the
 * finished summary; the chat card and banner stay to a line or two).
 *
 * The chat card shows no graph. Its › opens the side panel, where the graph,
 * history and event log live.
 */

import { useState, type ReactNode } from "react";
import { experimental_Icon as ExperimentalIcon } from "@get-bb/plugin-sdk/app";
import type { GraphView, RunView, StageView } from "../server/contracts";
import {
  deriveAttention,
  formatClock,
  formatDuration,
  formatShortDuration,
  isStructural,
  nodeById,
  nodeLabel,
  progressOf,
  statusPill,
  tailLines,
  type Attention,
  type AttentionRequest,
  type EventView,
  type SegmentStatus,
} from "./run-model";
import { Btn, Dot, MUTED, Pill, ROW, SMALL, TOKENS } from "./primitives";

export type AttentionSurface = "chat" | "panel" | "banner";

export interface AttentionActions {
  /** Answers the run's open human gate with an option's raw label, or free text. Resolves with a refusal reason, or null on success. */
  answer(answer: string): Promise<string | null>;
  /** Resumes a failed or cancelled run. Resolves with a refusal reason, or null on success. */
  resume(): Promise<string | null>;
  openThread(threadId: string): void;
  /** Opens the run in the side panel (chat card and banner only). */
  openPanel?(): void;
}

export interface AttentionCardProps {
  surface: AttentionSurface;
  run: RunView;
  stages: StageView[];
  graph: GraphView | null;
  /** Optional: the banner has none; the failed/finished detail falls back to the run row. */
  events?: EventView[];
  now: number;
  actions: AttentionActions;
}

/** "in 1h 01m", or "any moment now" once due. */
function countdown(retryAt: number, now: number): string {
  const ms = retryAt - now;
  if (ms <= 0) return "any moment now";
  return `in ${formatShortDuration(ms)}`;
}

function borderFor(attention: Attention, request: AttentionRequest | null): string {
  if (request) return request.kind === "provider-pause" ? TOKENS.warning : TOKENS.brand;
  if (attention.kind === "failed") return attention.cancelled ? TOKENS.border : TOKENS.destructive;
  if (attention.kind === "finished") return TOKENS.success;
  return TOKENS.border;
}

function Box({ border, children, testId }: { border: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} style={{ border: `1px solid ${border}`, borderRadius: `calc(${TOKENS.radius} - 2px)`, padding: "9px 11px", marginTop: 8, minWidth: 0 }}>
      {children}
    </div>
  );
}

function Recessed({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <div
      style={{
        background: TOKENS.recessed,
        borderRadius: `calc(${TOKENS.radius} - 2px)`,
        padding: "8px 10px",
        marginTop: 8,
        fontSize: mono ? 11 : 12,
        fontFamily: mono ? TOKENS.fontMono : undefined,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </div>
  );
}

/** Answers/resume calls report a refusal inline rather than failing silently. */
function useAction(): [string | null, boolean, (fn: () => Promise<string | null>) => void] {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    fn().then(
      (reason) => {
        setBusy(false);
        setError(reason);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return [error, busy, run];
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" style={{ ...SMALL, color: TOKENS.destructiveText, margin: "6px 0 0" }}>
      {error}
    </p>
  );
}

function ProgressSegments({ segments }: { segments: SegmentStatus[] }) {
  const color: Record<SegmentStatus, string> = { done: TOKENS.success, current: TOKENS.brand, waiting: TOKENS.warning, failed: TOKENS.destructive, pending: TOKENS.muted };
  return (
    <div data-testid="attractor-progress" style={{ display: "flex", gap: 3, marginTop: 7 }}>
      {segments.map((s, i) => (
        <i key={i} data-segment={s} style={{ flex: 1, height: 3, borderRadius: 2, background: color[s] }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function GateBody({ request, surface, now, actions }: { request: Extract<AttentionRequest, { kind: "gate" }>; surface: AttentionSurface; now: number; actions: AttentionActions }) {
  const [error, busy, act] = useAction();
  const [text, setText] = useState("");
  const waited = formatShortDuration(Math.max(0, now - request.since));
  return (
    <>
      <strong>{request.label}</strong>
      <div style={{ ...SMALL, ...MUTED, marginTop: 2 }}>
        {surface === "panel" ? (
          <>
            {request.after ? (
              <>
                Asked after <strong>{request.after.label}</strong> ·{" "}
              </>
            ) : null}
            waiting {waited}
          </>
        ) : (
          <>
            {request.reviewTarget ? (
              <>
                Reviewing <span style={{ fontFamily: TOKENS.fontMono, fontSize: 11 }}>{request.reviewTarget.path}</span> ·{" "}
              </>
            ) : null}
            waiting {waited}
          </>
        )}
      </div>
      {surface === "panel" && request.reviewTarget ? (
        <>
          {request.reviewTarget.text ? <Recessed>{request.reviewTarget.text}</Recessed> : null}
          <div style={{ ...SMALL, ...MUTED, marginTop: 4, fontFamily: TOKENS.fontMono, fontSize: 11 }}>{request.reviewTarget.path}</div>
        </>
      ) : null}
      <div style={{ ...ROW, flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {request.choices.map((choice, i) => (
          <Btn
            key={choice.raw}
            variant={i === 0 ? "primary" : "secondary"}
            disabled={busy}
            title={`${choice.raw} → ${choice.toLabel}`}
            data-testid={`gate-choice-${choice.raw}`}
            onClick={() => act(() => actions.answer(choice.raw))}
          >
            {choice.text}
          </Btn>
        ))}
        {request.after?.threadId ? (
          <Btn variant="ghost" onClick={() => actions.openThread(request.after!.threadId!)}>
            Open {request.after.label}’s thread
          </Btn>
        ) : null}
      </div>
      {request.freeform ? (
        <form
          style={{ ...ROW, marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) act(() => actions.answer(text));
          }}
        >
          <input
            aria-label={`Answer ${request.label} in your own words`}
            placeholder="Or answer in your own words…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 12, padding: "3px 8px", borderRadius: `calc(${TOKENS.radius} - 2px)`, border: `1px solid ${TOKENS.border}`, background: "transparent", color: "inherit" }}
          />
          <button type="submit" disabled={busy || !text.trim()} style={{ fontFamily: "inherit", fontSize: 12, padding: "3px 9px", borderRadius: `calc(${TOKENS.radius} - 2px)`, border: `1px solid ${TOKENS.border}`, background: "transparent", color: "inherit", cursor: "pointer" }}>
            Send
          </button>
        </form>
      ) : null}
      {request.choices.length > 0 ? (
        <div data-testid="gate-routes" style={{ ...SMALL, ...MUTED, marginTop: 7 }}>
          {request.choices.map((c, i) => (
            <span key={c.raw}>
              {i > 0 ? " · " : ""}
              {c.text} → {c.back ? "back to " : ""}
              <strong>{c.toLabel}</strong>
            </span>
          ))}
        </div>
      ) : null}
      <ErrorLine error={error} />
    </>
  );
}

function PromptBody({ request, surface, now, actions }: { request: Extract<AttentionRequest, { kind: "worker-prompt" }>; surface: AttentionSurface; now: number; actions: AttentionActions }) {
  return (
    <>
      <strong>
        {request.label}’s worker is waiting on {request.what}
      </strong>
      {surface === "panel" ? <div style={{ ...SMALL, ...MUTED, marginTop: 2 }}>Waiting {formatShortDuration(Math.max(0, now - request.since))}. Answer it in the worker thread and the run carries on.</div> : null}
      {request.threadId ? (
        <div style={{ ...ROW, marginTop: 8 }}>
          <Btn variant="primary" onClick={() => actions.openThread(request.threadId!)}>
            Open worker to answer
          </Btn>
        </div>
      ) : null}
    </>
  );
}

function PauseBody({ request, surface, now, actions }: { request: Extract<AttentionRequest, { kind: "provider-pause" }>; surface: AttentionSurface; now: number; actions: AttentionActions }) {
  const usageLimit = /rate limit/i.test(request.reason);
  const when = formatClock(request.retryAt);
  if (surface !== "panel") {
    return (
      <div style={{ ...ROW, ...SMALL }}>
        <span>
          <strong>{usageLimit ? "Usage limit reached." : `${request.reason}.`}</strong> Resumes by itself at <strong>{when}</strong>, {countdown(request.retryAt, now)}.
        </span>
      </div>
    );
  }
  const total = Math.max(1, request.retryAt - request.since);
  const done = Math.max(0, Math.min(1, (now - request.since) / total));
  return (
    <>
      <strong>{usageLimit ? "Waiting for your usage limit to reset" : `Waiting out: ${request.reason.toLowerCase()}`}</strong>
      <div style={{ ...SMALL, ...MUTED, marginTop: 2 }}>
        The {request.label} worker stopped at {formatClock(request.since)}. Attractor will retry the same worker automatically.
      </div>
      <div style={{ height: 5, borderRadius: 3, background: TOKENS.muted, overflow: "hidden", marginTop: 8 }}>
        <i data-testid="pause-progress" style={{ display: "block", height: "100%", width: `${done * 100}%`, background: TOKENS.warning }} />
      </div>
      <div style={{ ...ROW, ...SMALL, marginTop: 6 }}>
        <span>
          Resumes <strong>{when}</strong> · {countdown(request.retryAt, now)}
        </span>
        <span style={{ flex: 1 }} />
        {request.threadId ? (
          <Btn variant="ghost" onClick={() => actions.openThread(request.threadId!)}>
            Open worker
          </Btn>
        ) : null}
      </div>
    </>
  );
}

function RequestsBody({ requests, surface, now, actions }: { requests: AttentionRequest[]; surface: AttentionSurface; now: number; actions: AttentionActions }) {
  const [index, setIndex] = useState(0);
  const current = requests[Math.min(index, requests.length - 1)]!;
  const body =
    current.kind === "gate" ? (
      <GateBody key={current.stage.stageId} request={current} surface={surface} now={now} actions={actions} />
    ) : current.kind === "worker-prompt" ? (
      <PromptBody request={current} surface={surface} now={now} actions={actions} />
    ) : (
      <PauseBody request={current} surface={surface} now={now} actions={actions} />
    );
  return (
    <Box border={borderFor({ kind: "requests", requests }, current)} testId="attention-request">
      {requests.length > 1 ? (
        <div style={{ ...ROW, ...SMALL, ...MUTED, marginBottom: 4 }}>
          <span data-testid="attention-count">
            {Math.min(index, requests.length - 1) + 1} of {requests.length}
          </span>
          <span style={{ flex: 1 }} />
          <Btn variant="ghost" aria-label="Next request" onClick={() => setIndex((i) => (i + 1) % requests.length)}>
            Next ›
          </Btn>
        </div>
      ) : null}
      {body}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Running / failed / finished
// ---------------------------------------------------------------------------

function RunningBody({ run, stages, graph, attention, surface, now }: { run: RunView; stages: StageView[]; graph: GraphView | null; attention: Extract<Attention, { kind: "running" }>; surface: AttentionSurface; now: number }) {
  const progress = progressOf(run, stages, graph, now);
  const primary = attention.stages[0] ?? null;
  const total = formatShortDuration(Math.max(0, now - run.createdAt));
  const label = primary ? nodeLabel(graph, primary.nodeId) : run.currentNodeId ? nodeLabel(graph, run.currentNodeId) : null;
  const more = attention.stages.length - 1;
  return (
    <div data-testid="attention-running" style={{ marginTop: surface === "panel" ? 8 : 6 }}>
      <div style={{ ...ROW, ...SMALL }}>
        <Dot tone="run" />
        {label ? <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</strong> : <span style={MUTED}>Between stages</span>}
        {primary ? (
          <span style={{ ...MUTED, whiteSpace: "nowrap" }}>
            {primary.attempt > 1 ? `attempt ${primary.attempt} · ` : ""}
            {formatDuration(Math.max(0, now - primary.startedAt))}
          </span>
        ) : null}
        {more > 0 ? <span style={MUTED}>+{more} more</span> : null}
        <span style={{ flex: 1 }} />
        <span style={{ ...MUTED, whiteSpace: "nowrap" }}>{progress.looping ? progress.text : `${total} total`}</span>
      </div>
      {progress.segments ? <ProgressSegments segments={progress.segments} /> : null}
      {surface === "panel" ? <div style={{ ...SMALL, ...MUTED, marginTop: 6 }}>Nothing needs you right now.</div> : null}
    </div>
  );
}

const KIND_WORD: Record<string, string> = { command: "Command stage", agent: "Agent stage", prompt: "Agent stage", human: "Human gate" };

function FailedBody({ attention, surface, actions }: { attention: Extract<Attention, { kind: "failed" }>; surface: AttentionSurface; actions: AttentionActions }) {
  const [error, busy, act] = useAction();
  const title = attention.cancelled
    ? attention.label
      ? `You stopped this run at ${attention.label}`
      : "You stopped this run"
    : attention.label
      ? `${attention.label} failed`
      : "The run failed";
  const tail = attention.output ? tailLines(attention.output, surface === "panel" ? 6 : 2) : null;
  return (
    <Box border={attention.cancelled ? TOKENS.border : TOKENS.destructive} testId="attention-failed">
      <strong>{title}</strong>
      {surface === "panel" && attention.handlerKind && KIND_WORD[attention.handlerKind] ? <div style={{ ...SMALL, ...MUTED, marginTop: 2 }}>{KIND_WORD[attention.handlerKind]}</div> : null}
      {attention.reason ? <div style={{ fontFamily: TOKENS.fontMono, fontSize: 11, ...MUTED, marginTop: 3, overflowWrap: "anywhere" }}>{attention.reason}</div> : null}
      {attention.endedBy ? <div style={{ ...SMALL, ...MUTED, marginTop: 3 }}>The run ended when {attention.endedBy}.</div> : null}
      {surface === "panel" && tail ? (
        <Recessed mono>
          {tail.omitted > 0 ? <span style={MUTED}>… {tail.omitted} earlier lines{"\n"}</span> : null}
          {tail.text}
        </Recessed>
      ) : null}
      <div style={{ ...ROW, flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        <Btn variant="primary" disabled={busy} onClick={() => act(actions.resume)}>
          {attention.resumeLabel ? `Resume from ${attention.resumeLabel}` : "Resume"}
        </Btn>
        {surface !== "panel" && actions.openPanel ? (
          <Btn variant="ghost" onClick={actions.openPanel}>
            See details ›
          </Btn>
        ) : null}
        {surface === "panel" && attention.stage?.threadId ? (
          <Btn variant="ghost" onClick={() => actions.openThread(attention.stage!.threadId!)}>
            Open worker
          </Btn>
        ) : null}
      </div>
      {surface === "panel" ? (
        <div style={{ ...SMALL, ...MUTED, marginTop: 8 }}>
          {attention.cancelled
            ? "Resume carries on from the stage it was stopped in, with the run's context as it stood."
            : "Resume runs the stage again with the run's context as it stood. Fix the cause first: nothing has changed since it failed."}
        </div>
      ) : null}
      <ErrorLine error={error} />
    </Box>
  );
}

function decisions(events: readonly EventView[], graph: GraphView | null): string[] {
  return events.flatMap((e) => (e.type === "human.answered" && e.answer ? [`${nodeLabel(graph, e.nodeId)}: ${e.answer.replace(/^\[\w\]\s*/, "")}${e.actor === "default" ? " (timed out)" : ""}`] : []));
}

function timeSplit(stages: readonly StageView[], graph: GraphView | null): string | null {
  const nodes = nodeById(graph);
  let agents = 0;
  let commands = 0;
  let human = 0;
  for (const s of stages) {
    if (s.completedAt === null) continue;
    const ms = s.completedAt - s.startedAt;
    const kind = nodes.get(s.nodeId)?.handlerKind;
    if (kind === "agent" || kind === "prompt") agents += ms;
    else if (kind === "command") commands += ms;
    else if (kind === "human") human += ms;
  }
  const parts = [agents && `agents ${formatShortDuration(agents)}`, commands && `commands ${formatShortDuration(commands)}`, human && `waiting on you ${formatShortDuration(human)}`].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function FinishedBody({ run, stages, graph, events, attention, surface, actions }: { run: RunView; stages: StageView[]; graph: GraphView | null; events: EventView[]; attention: Extract<Attention, { kind: "finished" }>; surface: AttentionSurface; actions: AttentionActions }) {
  const [showAll, setShowAll] = useState(false);
  const duration = formatShortDuration(Math.max(0, (run.finishedAt ?? run.updatedAt) - run.createdAt));
  const worked = stages.filter((s) => !isStructural(nodeById(graph).get(s.nodeId)?.handlerKind)).length;
  const firstLine = attention.output?.split("\n").find((l) => l.trim()) ?? null;
  if (surface !== "panel") {
    return (
      <div data-testid="attention-finished" style={{ ...SMALL, ...MUTED, marginTop: 5, overflowWrap: "anywhere" }}>
        {duration} · {worked} {worked === 1 ? "stage" : "stages"}
        {attention.label ? ` · ended at ${attention.label}` : ""}
        {firstLine ? `: “${firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine}”` : ""}
      </div>
    );
  }
  const goalGates = (graph?.nodes ?? []).filter((n) => n.goalGate && n.status !== null);
  const decided = decisions(events, graph);
  const time = timeSplit(stages, graph);
  const output = attention.output ? (showAll ? { text: attention.output, omitted: 0 } : headLines(attention.output, 8)) : null;
  return (
    <Box border={TOKENS.success} testId="attention-finished">
      <strong>{attention.label ? `Finished at ${attention.label}` : "Finished"}</strong>
      {output ? (
        <>
          <Recessed>{output.text}</Recessed>
          {output.omitted > 0 ? (
            <Btn variant="ghost" onClick={() => setShowAll(true)}>
              Show all ({output.omitted} more lines)
            </Btn>
          ) : null}
        </>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: "3px 8px", fontSize: 12, marginTop: 9 }}>
        {goalGates.length > 0 ? (
          <>
            <span style={MUTED}>Goal gates</span>
            <span>
              {goalGates.map((n, i) => (
                <span key={n.id}>
                  {i > 0 ? " · " : ""}
                  <span style={{ color: n.status === "succeeded" ? TOKENS.success : TOKENS.destructiveText }}>{n.status === "succeeded" ? "✓" : "✗"}</span> {n.label ?? n.id}
                </span>
              ))}
            </span>
          </>
        ) : null}
        {decided.length > 0 ? (
          <>
            <span style={MUTED}>You decided</span>
            <span>{decided.join(" · ")}</span>
          </>
        ) : null}
        <span style={MUTED}>Time</span>
        <span>
          {duration}
          {time ? ` · ${time}` : ""}
        </span>
      </div>
      {attention.threadId ? (
        <div style={{ ...ROW, marginTop: 10 }}>
          <Btn onClick={() => actions.openThread(attention.threadId!)}>Open {attention.label}’s thread</Btn>
        </div>
      ) : null}
    </Box>
  );
}

function headLines(text: string, lines: number): { text: string; omitted: number } {
  const all = text.split("\n");
  if (all.length <= lines) return { text, omitted: 0 };
  return { text: all.slice(0, lines).join("\n"), omitted: all.length - lines };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function AttentionBody({ surface, run, stages, graph, events = [], now, actions, attention }: AttentionCardProps & { attention: Attention }) {
  switch (attention.kind) {
    case "requests":
      return <RequestsBody requests={attention.requests} surface={surface} now={now} actions={actions} />;
    case "running":
      return <RunningBody run={run} stages={stages} graph={graph} attention={attention} surface={surface} now={now} />;
    case "failed":
      return <FailedBody attention={attention} surface={surface} actions={actions} />;
    case "finished":
      return <FinishedBody run={run} stages={stages} graph={graph} events={events} attention={attention} surface={surface} actions={actions} />;
  }
}

/**
 * The attention card. `chat` and `banner` render their own header (title,
 * status pill, › to open the side panel); `panel` renders the body only —
 * the panel header above it already carries the title and pill.
 */
export function AttentionCard(props: AttentionCardProps) {
  const { surface, run, stages, graph, events, now, actions } = props;
  const attention = deriveAttention(run, stages, graph, events);
  const pill = statusPill(run, attention);
  if (surface === "panel") {
    return (
      <div data-testid="attention-card" data-surface={surface} data-attention={attention.kind}>
        <AttentionBody {...props} attention={attention} />
      </div>
    );
  }
  return (
    <div
      data-testid="attention-card"
      data-surface={surface}
      data-attention={attention.kind}
      className={surface === "chat" ? "rounded-lg border border-border bg-card shadow-sm" : undefined}
      style={surface === "chat" ? { padding: "11px 13px", margin: "8px 0", width: "100%", maxWidth: "28rem", textAlign: "left" } : { padding: "6px 2px", textAlign: "left" }}
    >
      <div style={ROW}>
        <ExperimentalIcon name="Workflow" style={{ width: 14, height: 14, flexShrink: 0 }} />
        <strong style={{ flex: 1, minWidth: 0, fontSize: surface === "chat" ? 14 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.title ?? "Attractor run"}</strong>
        <span data-run-status={run.status}>
          <Pill tone={pill.tone}>{pill.word}</Pill>
        </span>
        {surface === "banner" ? <span style={{ ...SMALL, ...MUTED, whiteSpace: "nowrap" }}>{formatShortDuration(Math.max(0, now - run.createdAt))}</span> : null}
        {actions.openPanel ? (
          <button
            type="button"
            aria-label="Open in right panel"
            title="Open in the side panel"
            onClick={actions.openPanel}
            style={{ background: "none", border: "none", cursor: "pointer", padding: "0 2px", fontSize: 16, lineHeight: 1, color: TOKENS.mutedFg }}
          >
            ›
          </button>
        ) : null}
      </div>
      <AttentionBody {...props} attention={attention} />
    </div>
  );
}
