// The room transcript: what was SAID in the room, as opposed to what was drawn
// on it.
//
// On the production VM a systemd service (LiveKit -> Whisper) POSTs each
// utterance to this plugin's `scribe` route; here it lands in an ordinary
// table in the plugin's own SQLite, and leaves again four ways: a realtime
// message (the live tab), an rpc query (the same tab's search), the
// `bb canvas transcript` CLI (a human or an agent in a shell), and the
// `@transcript` mention (an agent's context at send time).
//
// WHY A TABLE AND NOT A BB THREAD. A thread is a conversation with an agent:
// it has turns, a provider, a runtime. A room transcript is none of those — it
// is a firehose of short utterances from humans talking to each other, nobody
// replies to it, and every question anyone asks of it is a query ("what did we
// say about X", "the last ten minutes", "everything Alice said"). That is a
// table with an index on time, and modelling it as a thread would buy agent
// affordances we do not want and cost us every query we do.
//
// This module is BACKEND ONLY (it holds SQL). The formatting it shares with
// the panel lives in transcript-view.ts, which is dependency-free.
import type BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { formatClock, formatTranscriptLine } from "./transcript-view.js";
import type { TranscriptEntry } from "./wire.js";

/** Longest speaker label stored. A diarised name, not a sentence. */
export const MAX_SPEAKER_LENGTH = 120;

/** Longest single utterance stored. Whisper emits phrases, not documents. */
export const MAX_TEXT_LENGTH = 10_000;

/** Most utterances one POST may carry. A batch is a catch-up, not a bulk load. */
export const MAX_BATCH = 500;

/** Default and ceiling for a query's row count, per the rpc contract. */
export const DEFAULT_QUERY_LIMIT = 200;
export const MAX_QUERY_LIMIT = 1000;

/**
 * How much transcript a resolved `@transcript` mention may put in an agent's
 * context. Deliberately a character budget rather than a row count: a room can
 * produce 400 two-word utterances or 40 long ones in the same ten minutes, and
 * the thing that actually costs the agent is characters.
 */
export const MENTION_CONTEXT_CAP = 8_000;

/** Reserved out of the cap for the block's header line, so the assembled block
 * is under the cap by construction rather than by a second measuring pass. */
const HEADER_BUDGET = 200;

/** Rows a mention window will read before the character cap trims it. */
const MENTION_ROW_LIMIT = 600;

/**
 * One utterance, as it arrives.
 *
 * NOT `.strict()`, on purpose. The producer is a service on another machine
 * that this repo does not own; when it grows a `confidence` or `durationMs`
 * field, the right outcome is that the transcript keeps working, not that
 * every utterance in the room is rejected until both sides ship together. The
 * three fields we do read are validated strictly.
 */
const entrySchema = z.object({
  ts: z.number().optional(),
  speaker: z.string().trim().min(1).max(MAX_SPEAKER_LENGTH),
  text: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
});

const batchSchema = z.array(entrySchema).min(1).max(MAX_BATCH);

export type IngestResult =
  | { readonly ok: true; readonly entries: TranscriptEntry[] }
  | { readonly ok: false; readonly error: string };

/**
 * Turn a parsed JSON body into entries ready to insert, or one flat sentence
 * explaining why it is not one.
 *
 * `ts` defaults to `now` — an utterance whose producer did not time it is
 * timed by when it reached us, which is the only honest answer available and
 * is within a second of the truth for a live service.
 */
export function parseIngest(body: unknown, now: number): IngestResult {
  // Branch on the shape BEFORE validating, rather than validating a union.
  // A union reports its failure at the root ("Invalid input"), which tells the
  // operator wiring up the VM service nothing; branching first means the error
  // names the field and, in a batch, the index.
  const parsed = Array.isArray(body)
    ? batchSchema.safeParse(body)
    : entrySchema.safeParse(body);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}`;
    return {
      ok: false,
      error: `expected { ts?, speaker, text } or an array of them${where}: ${
        issue?.message ?? "invalid body"
      }`,
    };
  }
  const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return {
    ok: true,
    entries: list.map((entry) => ({
      // Truncated rather than rounded: a fractional millisecond is noise, and
      // an integer keeps the SQLite column an INTEGER for every row.
      ts: entry.ts === undefined ? now : Math.trunc(entry.ts),
      speaker: entry.speaker,
      text: entry.text,
    })),
  };
}

/** Everything a query can narrow by. Every field is optional; all of them
 * together is an AND. */
export interface TranscriptFilter {
  /** Epoch ms lower bound, inclusive. Absolute, not a duration — the CLI's
   * `--since 10m` is turned into one of these before it gets here. */
  readonly sinceMs?: number;
  /** Case-insensitive substring of the utterance TEXT. */
  readonly search?: string;
  /** Case-insensitive exact speaker. */
  readonly speaker?: string;
  readonly limit?: number;
}

export class TranscriptStore {
  readonly #db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.#db = db;
  }

  /** Insert a batch in one transaction: a POST either lands whole or not at
   * all, so a mid-batch failure cannot leave half a minute of conversation. */
  insert(entries: readonly TranscriptEntry[]): void {
    const statement = this.#db.prepare(
      `INSERT INTO canvas_transcript (ts, speaker, text) VALUES (?, ?, ?)`,
    );
    const write = this.#db.transaction((rows: readonly TranscriptEntry[]) => {
      for (const row of rows) statement.run(row.ts, row.speaker, row.text);
    });
    write(entries);
  }

  /**
   * The newest `limit` matching entries, returned OLDEST FIRST.
   *
   * The two halves of that sentence are both deliberate. A limit on a
   * transcript means "the tail" — a reader asking for 200 lines of a
   * ten-thousand-line day wants the last 200, not the first 200, which is why
   * the SQL orders descending. Reading order is the opposite, so the result is
   * reversed before it leaves: every consumer (panel, CLI, mention block)
   * renders top-to-bottom in time.
   */
  query(filter: TranscriptFilter = {}): TranscriptEntry[] {
    const { where, params } = buildWhere(filter);
    const limit = clampLimit(filter.limit);
    const rows = this.#db
      .prepare<unknown[], TranscriptEntry>(
        `SELECT ts, speaker, text FROM canvas_transcript
         ${where}
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(...params, limit);
    return rows.reverse();
  }

  /** How many entries match, ignoring `limit`. What the mention menu's
   * subtitles show, so a window that is empty says so before it is picked. */
  count(filter: TranscriptFilter = {}): number {
    const { where, params } = buildWhere(filter);
    const row = this.#db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM canvas_transcript ${where}`,
      )
      .get(...params);
    return row?.n ?? 0;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_QUERY_LIMIT);
}

function buildWhere(filter: TranscriptFilter): {
  where: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.sinceMs !== undefined && Number.isFinite(filter.sinceMs)) {
    clauses.push("ts >= ?");
    params.push(Math.trunc(filter.sinceMs));
  }
  const search = filter.search?.trim() ?? "";
  if (search.length > 0) {
    // The user's text is a substring to look for, not a LIKE pattern: a search
    // for "100%" must not match every line in the room.
    clauses.push(String.raw`text LIKE ? ESCAPE '\'`);
    params.push(`%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  const speaker = filter.speaker?.trim() ?? "";
  if (speaker.length > 0) {
    clauses.push("speaker = ? COLLATE NOCASE");
    params.push(speaker);
  }
  return {
    where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

/**
 * `10m`, `2h`, `1d`, `45s` -> milliseconds; anything else -> null.
 *
 * Strict about the unit rather than defaulting a bare number to minutes: the
 * CLI's error can then say exactly what it wanted, and `--since 10` never
 * silently means something the caller did not intend.
 */
export function parseDuration(token: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(token.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  if (value <= 0) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as "s" | "m" | "h" | "d"
  ];
  return value * unit;
}

/** Local midnight before `now` — the "today" mention window. Local, not UTC:
 * "what did we say today" is a question about the room's own working day. */
export function startOfToday(now: number): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

/**
 * Assemble the block a resolved mention (or a `--json`-less CLI run) hands
 * over, capped at `cap` characters by dropping the OLDEST lines.
 *
 * Oldest-first is the only defensible direction to trim: an agent asked to
 * catch up on a conversation needs the end of it, and a block that silently
 * stopped ten minutes short of now would be worse than useless. The header
 * says how many lines went, so the agent knows it is reading a tail rather
 * than believing it has the whole window.
 */
export function transcriptBlock(
  label: string,
  entries: readonly TranscriptEntry[],
  cap: number = MENTION_CONTEXT_CAP,
): string {
  if (entries.length === 0) return `Room transcript — ${label}: no entries.`;

  const lines = entries.map(formatTranscriptLine);
  const budget = Math.max(cap - HEADER_BUDGET, 1);

  // Walk backwards from the newest line, keeping what fits.
  let kept = 0;
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = size + lines[i]!.length + 1; // +1 for the newline
    if (next > budget) break;
    size = next;
    kept++;
  }

  let body: string[];
  if (kept === 0) {
    // One utterance longer than the whole budget. Better a truncated last line
    // than a header with nothing under it.
    body = [`${lines[lines.length - 1]!.slice(0, budget - 1)}…`];
    kept = 1;
  } else {
    body = lines.slice(lines.length - kept);
  }

  const dropped = lines.length - kept;
  const span = `${formatClock(entries[entries.length - kept]!.ts)}–${formatClock(
    entries[entries.length - 1]!.ts,
  )}`;
  const header =
    dropped === 0
      ? `Room transcript — ${label} (${lines.length} entries, ${span}):`
      : `Room transcript — ${label} (${kept} of ${lines.length} entries, ${span}; ${dropped} earlier entries dropped to fit the ${cap}-character cap):`;

  return `${header}\n\n${body.join("\n")}`;
}

/**
 * A mention item's id, decoded. The id is what round-trips through the
 * composer between `search` (as the user types) and `resolve` (at send time,
 * possibly minutes later), so it encodes the WINDOW rather than the resolved
 * rows — an agent asking for "the last 15 minutes" wants the 15 minutes before
 * it sends, not before it typed.
 */
export type MentionWindow =
  | { readonly kind: "duration"; readonly ms: number; readonly label: string }
  | { readonly kind: "today"; readonly label: string }
  | { readonly kind: "search"; readonly query: string; readonly label: string };

/** The three fixed windows, in menu order. */
const FIXED_WINDOWS: ReadonlyArray<{ id: string; window: MentionWindow }> = [
  {
    id: "15m",
    window: { kind: "duration", ms: 15 * 60_000, label: "the last 15 minutes" },
  },
  {
    id: "60m",
    window: { kind: "duration", ms: 60 * 60_000, label: "the last hour" },
  },
  { id: "today", window: { kind: "today", label: "today" } },
];

const SEARCH_PREFIX = "search:";

/** Menu titles, kept beside the windows so the item and the block agree. */
const FIXED_TITLES: Readonly<Record<string, string>> = {
  "15m": "Last 15 minutes",
  "60m": "Last hour",
  today: "Today",
};

/** Decode a mention item id, or null when it names no window we serve. */
export function mentionWindowFor(itemId: string): MentionWindow | null {
  if (itemId.startsWith(SEARCH_PREFIX)) {
    const query = itemId.slice(SEARCH_PREFIX.length).trim();
    if (query.length === 0) return null;
    return { kind: "search", query, label: `matches for “${query}”` };
  }
  return FIXED_WINDOWS.find((entry) => entry.id === itemId)?.window ?? null;
}

/** The filter a window resolves to at `now`. */
export function filterFor(window: MentionWindow, now: number): TranscriptFilter {
  switch (window.kind) {
    case "duration":
      return { sinceMs: now - window.ms, limit: MENTION_ROW_LIMIT };
    case "today":
      return { sinceMs: startOfToday(now), limit: MENTION_ROW_LIMIT };
    case "search":
      // No time bound: a search is a question about the whole room, and the
      // newest matches are what the tail-limit keeps.
      return { search: window.query, limit: MENTION_ROW_LIMIT };
  }
}

/** One row of the mention menu. Mirrors the SDK's `PluginMentionItem`. */
export interface TranscriptMentionItem {
  id: string;
  title: string;
  subtitle: string;
}

/**
 * The menu rows for a typed query: the three fixed windows always, plus a
 * "matches for …" row once there is something to match.
 *
 * Subtitles carry the live count so an empty window is visible BEFORE it is
 * picked — a mention that resolves to "no entries" has already cost the user a
 * send.
 */
export function mentionItems(
  query: string,
  now: number,
  count: (filter: TranscriptFilter) => number,
): TranscriptMentionItem[] {
  const items = FIXED_WINDOWS.map(({ id, window }) => ({
    id,
    title: FIXED_TITLES[id] ?? id,
    subtitle: describeCount(count(filterFor(window, now))),
  }));
  const trimmed = query.trim();
  if (trimmed.length > 0) {
    const window: MentionWindow = {
      kind: "search",
      query: trimmed,
      label: `matches for “${trimmed}”`,
    };
    items.push({
      id: `${SEARCH_PREFIX}${trimmed}`,
      title: `matches for ${trimmed}`,
      subtitle: describeCount(count(filterFor(window, now))),
    });
  }
  return items;
}

function describeCount(n: number): string {
  return n === 1 ? "1 entry" : `${n} entries`;
}

/**
 * Parse `bb canvas transcript`'s flags into a filter.
 *
 * Split out of the CLI's `run` so the argument grammar is testable without a
 * plugin host, and so an unknown or value-less flag is a NAMED error rather
 * than a silently ignored word: `--speaker` with nothing after it must not
 * quietly print the whole room.
 */
export function parseTranscriptArgs(
  argv: readonly string[],
  now: number,
):
  | { readonly ok: true; readonly filter: TranscriptFilter; readonly json: boolean }
  | { readonly ok: false; readonly error: string } {
  const filter: {
    sinceMs?: number;
    search?: string;
    speaker?: string;
    limit?: number;
  } = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${flag} needs a value` };
    }
    i++;
    switch (flag) {
      case "--since": {
        const ms = parseDuration(value);
        if (ms === null) {
          return {
            ok: false,
            error: `--since wants a duration like 10m, 2h or 1d, got "${value}"`,
          };
        }
        filter.sinceMs = now - ms;
        break;
      }
      case "--search":
        filter.search = value;
        break;
      case "--speaker":
        filter.speaker = value;
        break;
      case "--limit": {
        const limit = Number(value);
        if (!Number.isFinite(limit) || limit <= 0) {
          return { ok: false, error: `--limit wants a positive number, got "${value}"` };
        }
        filter.limit = limit;
        break;
      }
      default:
        return { ok: false, error: `unknown flag ${flag}` };
    }
  }
  return { ok: true, filter, json };
}
