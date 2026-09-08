// Pure transcript presentation, shared by BOTH sides.
//
// The backend renders transcript lines in two places (the `bb canvas
// transcript` CLI and the @transcript mention block) and the panel renders the
// same lines in the live tab. One formatter, so a line an agent reads in its
// context block is character-for-character the line a human read on screen.
//
// Dependency-free at RUNTIME, like identity.ts and wire.ts: this module is
// bundled into the frontend, so it must not reach better-sqlite3, node:buffer,
// or anything that drags the room host along.
import type { TranscriptEntry } from "./wire.js";

/**
 * `HH:MM` in the reader's own local time.
 *
 * Deliberately not `toLocaleTimeString`: a transcript row is a fixed-width
 * gutter, and the locale formatter is free to answer "9:31 AM" (five to eight
 * characters, and a different width per row) which makes the speaker column
 * ragged. Seconds are dropped on purpose — this is a conversation, not a log.
 */
export function formatClock(ts: number): string {
  const at = new Date(ts);
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** One transcript line, the one way this plugin ever writes one. */
export function formatTranscriptLine(entry: TranscriptEntry): string {
  return `${formatClock(entry.ts)} ${entry.speaker}: ${entry.text}`;
}

/**
 * Does this entry match a free-text search box? Case-insensitive substring on
 * the TEXT only — the speaker has its own filter, and a search for "bob" should
 * find the sentence somebody said about Bob, not every line Bob spoke.
 *
 * Kept here rather than only in SQL because the live tab applies the same test
 * to arriving realtime entries, and two different notions of "matches" between
 * the seeded rows and the live ones would be visible as rows that appear and
 * then never appear again after a refetch.
 */
export function matchesSearch(entry: TranscriptEntry, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;
  return entry.text.toLowerCase().includes(needle);
}

/**
 * Append one entry to a rendered tail, bounded.
 *
 * Two jobs beyond the push. It DEDUPES on (ts, speaker, text): the panel seeds
 * itself over rpc and then follows realtime, and an entry ingested between
 * those two moments arrives down both paths. And it caps the tail, because a
 * room left open all day would otherwise grow an unbounded list of DOM rows.
 *
 * Returns the SAME array when nothing changed, so React can skip the re-render.
 */
export function appendEntry(
  entries: readonly TranscriptEntry[],
  entry: TranscriptEntry,
  cap: number,
): readonly TranscriptEntry[] {
  // Only the tail is checked: the duplicate window is "the few messages either
  // side of the seed", never an hour ago, and scanning the whole list on every
  // arriving utterance is work that buys nothing.
  const recent = entries.slice(-20);
  if (
    recent.some(
      (seen) =>
        seen.ts === entry.ts &&
        seen.speaker === entry.speaker &&
        seen.text === entry.text,
    )
  ) {
    return entries;
  }
  const next = [...entries, entry];
  return next.length <= cap ? next : next.slice(next.length - cap);
}

/** A scroll container's geometry — the three numbers a DOM element gives us. */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Is the reader watching the live edge?
 *
 * The slack matters: a list auto-scrolled to the bottom often reports a
 * scrollTop a fraction of a pixel short of the exact bottom (sub-pixel row
 * heights, zoom), and an exact comparison would unpin the reader from a list
 * they never touched — turning "Jump to live" into permanent furniture.
 */
export function isPinnedToBottom(
  geometry: ScrollGeometry,
  slack = 48,
): boolean {
  const distance =
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return distance <= slack;
}
