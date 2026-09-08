// The room transcript, live, beside whatever you are doing.
//
// PLACEMENT. This is deliberately NOT a tab on the canvas page. What was said
// in the room is ambient context for every thread in bb — you want it beside
// the agent you are briefing, not only on the page where the drawing is — so
// the same component is registered three ways in app.tsx: a thread panel
// action, a new-thread panel action, and a command-palette row that opens the
// first. One component, three doors.
//
// It is thread-LIKE without being a thread: rows, a live tail, a pinned
// bottom, a search box. It is not a bb thread and has no composer, because
// nobody replies to a transcript.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { colorForName } from "./identity.js";
import {
  appendEntry,
  formatClock,
  isPinnedToBottom,
  matchesSearch,
} from "./transcript-view.js";
import { TRANSCRIPT_CHANNEL, transcriptEntryFrom } from "./wire.js";
import type { TranscriptEntry } from "./wire.js";
import type { rpcContract } from "../server";

/** How many rows the tail holds. A room left open all day would otherwise grow
 * an unbounded list of DOM nodes; 500 is far more than anybody scrolls back. */
const MAX_ROWS = 500;

/** Rows the initial (and every re-)query asks for. */
const QUERY_LIMIT = 200;

/** Debounce on the search box: every keystroke is an rpc round trip otherwise,
 * and a transcript search is a question you finish typing before you mean it. */
const SEARCH_DEBOUNCE_MS = 250;

export function TranscriptView(): ReactNode {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pinned, setPinned] = useState(true);

  const scroller = useRef<HTMLDivElement | null>(null);
  // The live-append handler needs the CURRENT search text, but re-subscribing
  // to realtime on every keystroke would drop messages in the gap. A ref keeps
  // the callback stable and its reading of the filter fresh.
  const searchRef = useRef(search);
  searchRef.current = search;

  /** (Re)seed the tail from the server. Also the reconnect repair. */
  const load = useCallback(
    (query: string) => {
      setStatus("loading");
      rpc
        .call("canvas_transcript_query", {
          limit: QUERY_LIMIT,
          ...(query.trim().length > 0 ? { search: query.trim() } : {}),
        })
        .then(({ entries: rows }) => {
          setEntries(rows);
          setStatus("ready");
          // A fresh window always starts at the live edge, whatever the reader
          // had scrolled to in the previous one.
          setPinned(true);
        })
        .catch(() => setStatus("error"));
    },
    [rpc],
  );

  // Debounced: the empty-string case runs on mount as the initial load.
  useEffect(() => {
    const timer = setTimeout(() => load(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load, search]);

  useRealtime(
    TRANSCRIPT_CHANNEL,
    useCallback((payload: unknown) => {
      const entry = transcriptEntryFrom(payload);
      if (entry === null) return;
      // While a search is active the live tail keeps running, filtered by the
      // SAME predicate the server applied — so a row that appears live is a row
      // that would survive the next refetch, rather than one that blinks away.
      if (!matchesSearch(entry, searchRef.current)) return;
      setEntries((current) => appendEntry(current, entry, MAX_ROWS));
    }, []),
  );

  // Realtime signals are ephemeral and never replayed, so every utterance
  // during a socket gap is simply gone — re-read on the way back.
  const connectionState = useRealtimeConnectionState();
  const [previousState, setPreviousState] = useState(connectionState);
  useEffect(() => {
    if (connectionState === previousState) return;
    setPreviousState(connectionState);
    if (connectionState === "connected" && previousState === "reconnecting") {
      load(searchRef.current);
    }
  }, [connectionState, previousState, load]);

  // Follow the live edge — but only while the reader is watching it. Scrolling
  // up to read something is a deliberate act, and yanking the viewport back
  // down mid-sentence is the single worst thing a live log can do.
  useEffect(() => {
    if (!pinned) return;
    const element = scroller.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [entries, pinned, status]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element !== null) setPinned(isPinnedToBottom(element));
  }, []);

  const jumpToLive = useCallback(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
    setPinned(true);
  }, []);

  return (
    <div
      data-canvas-transcript
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          data-canvas-transcript-rows
          className="h-full overflow-y-auto px-3 py-2"
        >
          {entries.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              {status === "loading"
                ? "Loading the room transcript…"
                : status === "error"
                  ? "Could not read the room transcript."
                  : search.trim().length > 0
                    ? `Nothing in the transcript matches “${search.trim()}”.`
                    : "Nothing has been said in the room yet."}
            </p>
          ) : (
            <ol className="space-y-0.5">
              {entries.map((entry, index) => (
                <TranscriptRow
                  // ts+speaker is not unique (two people can be stamped the
                  // same millisecond) and the row has no id of its own on the
                  // wire, so the index joins them. Rows are append-only and
                  // never reordered, so an index key is stable here.
                  key={`${entry.ts}-${index}`}
                  entry={entry}
                />
              ))}
            </ol>
          )}
        </div>

        {pinned ? null : (
          <button
            type="button"
            data-canvas-transcript-jump
            onClick={jumpToLive}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
          >
            Jump to live ↓
          </button>
        )}
      </div>

      {/* The search box is at the BOTTOM, where a composer would be: this
          panel reads as a conversation, and the control that acts on it
          belongs under the thing it acts on, not above it. */}
      <div className="border-t border-border p-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search the room transcript…"
          aria-label="Search the room transcript"
          data-canvas-transcript-search
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    </div>
  );
}

function TranscriptRow({ entry }: { readonly entry: TranscriptEntry }): ReactNode {
  return (
    <li
      data-canvas-transcript-speaker={entry.speaker}
      className="flex gap-2 text-xs leading-relaxed"
    >
      <span className="shrink-0 pt-px font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatClock(entry.ts)}
      </span>
      <span className="min-w-0">
        {/* The same name -> hue hash the cursor labels and avatars use, so one
            person is one colour everywhere in this plugin. */}
        <span className="font-medium" style={{ color: colorForName(entry.speaker) }}>
          {entry.speaker}
        </span>
        <span className="text-muted-foreground">: </span>
        <span className="break-words text-foreground">{entry.text}</span>
      </span>
    </li>
  );
}
