/**
 * `ui/events.tsx` — the side panel's Event log accordion (run-panel
 * redesign). Two readings of the same events:
 *
 * - **Story** (default): milestones only — stages starting and finishing,
 *   gates, pauses, failures — grouped by pass, with clock times. Routing and
 *   checkpoint events are hidden and counted (chips bring them back). A
 *   command stage shows its first output line, which is where a graph's own
 *   bookkeeping speaks.
 * - **Raw**: every event, one line each, a filter box, one list (no pages),
 *   and Copy / JSON export for pasting into an issue or handing to an agent.
 *
 * Both follow the live run while the panel is scrolled to the bottom, and
 * stop following as soon as the user scrolls up ("Jump to latest" goes
 * back). The scrolling element is the panel root, passed in as
 * `scrollContainer`: per README "Scroll ownership" the flush panel root owns
 * all of the panel's scrolling, so the log never becomes a nested scroller.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { GraphView, StageView } from "../server/contracts";
import { eventMatches, formatClock, groupPasses, rawEventLine, storyItems, type EventView, type StoryItem } from "./run-model";
import { Btn, Dot, MUTED, ROW, SMALL, STORAGE_PREFIX, TOKENS, ViewSwitch, useStoredState } from "./primitives";

export type { EventView } from "./run-model";

/** Pixels from the bottom that still count as "at the bottom". */
const BOTTOM_SLACK_PX = 24;

/**
 * Follows the bottom of `scrollRef` as `dep` changes, but only while the user
 * is already there; scrolling up stops it. Starts not following, so merely
 * opening the log never yanks the panel.
 */
export function useFollowBottom(scrollRef: RefObject<HTMLElement | null> | undefined, dep: unknown) {
  const [atBottom, setAtBottom] = useState(false);
  const atBottomRef = useRef(false);
  useEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
      atBottomRef.current = bottom;
      setAtBottom(bottom);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [scrollRef, dep]);
  const jump = () => {
    const el = scrollRef?.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  };
  return { following: atBottom, jump };
}

export interface EventLogProps {
  runId: string;
  events: EventView[];
  stages: StageView[];
  graph: GraphView | null;
  /** The panel's scroll root, for following the live run. */
  scrollContainer?: RefObject<HTMLElement | null>;
}

function FollowFooter({ text, following, onJump }: { text: string; following: boolean; onJump(): void }) {
  return (
    <div style={{ ...ROW, ...SMALL, ...MUTED, marginTop: 6 }}>
      <span>{text}</span>
      <span style={{ flex: 1 }} />
      {following ? (
        <span data-testid="log-following">following live</span>
      ) : (
        <Btn variant="ghost" onClick={onJump}>
          Jump to latest
        </Btn>
      )}
    </div>
  );
}

function StoryLine({ item, onOpenThread }: { item: StoryItem; onOpenThread?: (threadId: string) => void }) {
  return (
    <div data-story-seq={item.seq} data-story-kind={item.kind} style={{ display: "grid", gridTemplateColumns: "40px 1fr", gap: "2px 8px", fontSize: 12, padding: "3px 0" }}>
      <span style={{ ...MUTED, fontSize: 11, textAlign: "right", paddingTop: 1 }}>{formatClock(item.ts)}</span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <Dot tone={item.tone} /> {item.subject ? <strong>{item.subject}</strong> : null}
        {item.subject && !item.text.startsWith(":") ? " " : ""}
        {item.text}
        {item.detail ? <span style={MUTED}> · {item.detail}</span> : null}
        {item.threadId && onOpenThread ? (
          <>
            <span style={MUTED}> · </span>
            <button type="button" onClick={() => onOpenThread(item.threadId!)} style={{ background: "none", border: "none", padding: 0, fontFamily: "inherit", color: "inherit", textDecoration: "underline", cursor: "pointer" }}>
              worker
            </button>
          </>
        ) : null}
      </span>
    </div>
  );
}

function Story({ events, stages, graph, scrollContainer, onOpenThread }: EventLogProps & { onOpenThread?: (threadId: string) => void }) {
  const [routing, setRouting] = useState(false);
  const [checkpoints, setCheckpoints] = useState(false);
  const items = storyItems(events, stages, graph);
  const visible = items.filter((i) => i.kind === "milestone" || (i.kind === "routing" && routing) || (i.kind === "checkpoint" && checkpoints));
  const hiddenRouting = routing ? 0 : items.filter((i) => i.kind === "routing").length;
  const hiddenCheckpoints = checkpoints ? 0 : items.filter((i) => i.kind === "checkpoint").length;
  const grouped = groupPasses(stages).length > 1;
  const { following, jump } = useFollowBottom(scrollContainer, events.length);
  const hidden = [hiddenRouting ? `${hiddenRouting} routing` : null, hiddenCheckpoints ? `${hiddenCheckpoints} checkpoint` : null].filter(Boolean).join(", ");
  return (
    <div data-testid="event-story">
      <div role="group" aria-label="Event kinds" style={{ ...ROW, flexWrap: "wrap", gap: 5, marginBottom: 4 }}>
        <Btn variant="ghost" pressed disabled>
          Milestones
        </Btn>
        <Btn variant="ghost" pressed={routing} onClick={() => setRouting(!routing)}>
          + Routing
        </Btn>
        <Btn variant="ghost" pressed={checkpoints} onClick={() => setCheckpoints(!checkpoints)}>
          + Checkpoints
        </Btn>
      </div>
      {visible.length === 0 ? <p style={{ ...SMALL, ...MUTED, margin: "4px 0" }}>No events yet.</p> : null}
      {visible.map((item, i) => (
        <div key={item.seq}>
          {grouped && (i === 0 || visible[i - 1]!.pass !== item.pass) ? (
            <div data-story-pass={item.pass} style={{ ...ROW, ...MUTED, fontSize: 11, margin: "8px 0 2px", gap: 6 }}>
              Pass {item.pass}
              <span style={{ flex: 1, height: 1, background: TOKENS.border }} />
            </div>
          ) : null}
          <StoryLine item={item} onOpenThread={onOpenThread} />
        </div>
      ))}
      <FollowFooter text={hidden ? `Hidden: ${hidden} events` : `${events.length} events`} following={following} onJump={jump} />
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark style={{ background: "var(--accent, rgba(250, 204, 21, 0.35))", color: "inherit" }}>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Raw({ runId, events, scrollContainer }: EventLogProps) {
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const matching = events.filter((e) => eventMatches(e, filter));
  const { following, jump } = useFollowBottom(scrollContainer, events.length);
  const copy = () => {
    const text = matching.map(rawEventLine).join("\n");
    const done = (word: string) => {
      setCopied(word);
      setTimeout(() => setCopied(null), 1500);
    };
    navigator.clipboard?.writeText(text).then(
      () => done("Copied"),
      () => done("Copy failed"),
    ) ?? done("Copy failed");
  };
  return (
    <div data-testid="event-raw">
      <div style={{ ...ROW, marginBottom: 6 }}>
        <input
          aria-label="Filter events"
          placeholder="Filter: type, node, text…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 12, padding: "4px 8px", borderRadius: `calc(${TOKENS.radius} - 2px)`, border: `1px solid ${TOKENS.border}`, background: "transparent", color: "inherit" }}
        />
        <Btn variant="ghost" onClick={copy} title="Copy the matching lines">
          {copied ?? "Copy"}
        </Btn>
        <Btn variant="ghost" title="Download the matching events as JSON" onClick={() => download(`attractor-${runId.slice(0, 8)}-events.json`, JSON.stringify(matching, null, 2))}>
          JSON
        </Btn>
      </div>
      <div style={{ background: TOKENS.recessed, borderRadius: `calc(${TOKENS.radius} - 2px)`, padding: "8px 10px", fontFamily: TOKENS.fontMono, fontSize: 11, lineHeight: 1.55, overflow: "hidden" }}>
        {matching.length === 0 ? <div style={MUTED}>{events.length === 0 ? "No events yet." : "No events match."}</div> : null}
        {matching.map((e) => {
          const line = rawEventLine(e);
          const space = line.indexOf(" ", line.indexOf(" ") + 1);
          return (
            <div key={e.seq} data-event-seq={e.seq} data-event-type={e.type} title={line} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={MUTED}>{line.slice(0, space)}</span>
              <Highlighted text={line.slice(space)} query={filter} />
            </div>
          );
        })}
      </div>
      <FollowFooter text={filter.trim() ? `${matching.length} of ${events.length} match` : `${events.length} events`} following={following} onJump={jump} />
    </div>
  );
}

export type EventLogView = "story" | "raw";

export function EventLog(props: EventLogProps & { onOpenThread?: (threadId: string) => void }) {
  const [view, setView] = useStoredState<EventLogView>(`${STORAGE_PREFIX}event-log-view`, "story");
  return (
    <div data-testid="attractor-event-log">
      <div style={{ marginBottom: 8 }}>
        <ViewSwitch
          label="Event log view"
          value={view}
          onChange={setView}
          options={[
            { value: "story", label: "Story" },
            { value: "raw", label: "Raw" },
          ]}
        />
      </div>
      {view === "story" ? <Story {...props} /> : <Raw {...props} />}
    </div>
  );
}
