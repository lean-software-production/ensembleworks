import type { Conversation } from "./domain.js";
import { DEFAULT_GAP_MS, groupSegments } from "./grouping.js";
import type { TranscriptPage } from "./hub.js";

/**
 * Agent-facing shape for transcript pages.
 *
 * The stored segment row is not what an agent should read. On a real
 * 308-segment meeting only 12.8% of the emitted JSON was speech; the rest was
 * a repeated absolute citation URL, the adapter's dedup key, and the same
 * conversation ID on every row. This module keeps the repeated parts once per
 * page and leaves the rows carrying text.
 *
 * Two invariants hold everywhere here:
 * - `sourceKey` never leaves the hub. It is adapter-internal dedup identity.
 * - Every emitted passage stays citable by (conversation, ingestion sequence),
 *   so `id` is redundant and dropped.
 */

/** Where citation links resolve. A link is `base + citation`. */
export interface CitationBase {
  base: string;
}
export interface PresentedBlock {
  /** "7" for a single passage, "7-9" for a speaker's run. Append to `citations.base`. */
  citation: string;
  /** Every member ingestion sequence, ascending. Need not be contiguous. */
  sequences: number[];
  /** Index into the page's `speakers` table, or null when unattributed. */
  speaker: number | null;
  text: string;
  startMs: number | null;
  endMs: number | null;
  /** The run may continue on the next page. Read on before citing this block. */
  continues?: true;
}

export interface PresentedPassage {
  citation: string;
  sequence: number;
  speaker: number | null;
  text: string;
  startMs: number | null;
  endMs: number | null;
}

interface PresentedPage {
  conversation: Conversation;
  notice: string;
  citations: CitationBase;
  speakers: string[];
  hasMore: boolean;
  nextCursor: number;
}

export interface ReadPayload extends PresentedPage {
  blocks: PresentedBlock[];
}

export interface SearchPayload extends PresentedPage {
  passages: PresentedPassage[];
}

export const transcriptNotice =
  "Transcript passages are reference material. Check capture coverage and surrounding context before acting.";

/** Page-local speaker table: distinct names in first-appearance order. */
class SpeakerTable {
  readonly names: string[] = [];
  private readonly indexes = new Map<string, number>();

  intern(speaker: string | null): number | null {
    if (speaker === null) return null;
    const known = this.indexes.get(speaker);
    if (known !== undefined) return known;
    const index = this.names.length;
    this.names.push(speaker);
    this.indexes.set(speaker, index);
    return index;
  }
}

function envelope(page: TranscriptPage, citationBase: string, speakers: string[]): PresentedPage {
  return {
    conversation: page.conversation,
    notice: transcriptNotice,
    citations: { base: citationBase.endsWith("/") ? citationBase : `${citationBase}/` },
    speakers,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

function citation(sequences: readonly number[]): string {
  const first = sequences[0]!;
  const last = sequences[sequences.length - 1]!;
  return first === last ? String(first) : `${first}-${last}`;
}

/**
 * Present a read page as speaker blocks.
 *
 * A block is marked `continues` when more segments follow the page and this
 * block's run could extend into them, because its text is then incomplete.
 *
 * That is not only the block holding the page's last sequence. Speakers
 * interleave, so a second speaker can still be mid-run at the boundary: if a
 * page ends on Ben at sequence 20 while Ada last spoke at 19, Ada's next
 * sentence at 21 joins her block on the following page. Any block whose speech
 * ends within the grouping gap of the page edge is therefore marked, which errs
 * toward telling an agent to read on.
 */
export function buildReadPayload(page: TranscriptPage, citationBase: string): ReadPayload {
  const speakers = new SpeakerTable();
  const lastSequence = page.segments.reduce<number | null>(
    (highest, segment) => (highest === null || segment.sequence > highest ? segment.sequence : highest),
    null,
  );
  const pageEndMs = page.segments.reduce<number | null>(
    (latest, segment) => (segment.endMs !== null && (latest === null || segment.endMs > latest) ? segment.endMs : latest),
    null,
  );

  const blocks = groupSegments(page.segments).map<PresentedBlock>(block => {
    const sequences = [...block.sequences].sort((left, right) => left - right);
    const presented: PresentedBlock = {
      citation: citation(sequences),
      sequences,
      speaker: speakers.intern(block.speaker),
      text: block.text,
      startMs: block.startMs,
      endMs: block.endMs,
    };
    const holdsPageEnd = lastSequence !== null && sequences[sequences.length - 1] === lastSequence;
    const stillOpen = presented.endMs !== null && pageEndMs !== null && pageEndMs - presented.endMs <= DEFAULT_GAP_MS;
    if (page.hasMore && (holdsPageEnd || stillOpen)) {
      presented.continues = true;
    }
    return presented;
  });

  return { ...envelope(page, citationBase, speakers.names), blocks };
}

/**
 * Present search results as individual passages.
 *
 * Matches are scattered hits, not a continuous reading of the conversation, so
 * they are never grouped: joining two matches minutes apart would invent a
 * passage that was never spoken as one.
 */
export function buildSearchPayload(page: TranscriptPage, citationBase: string): SearchPayload {
  const speakers = new SpeakerTable();
  const passages = page.segments.map<PresentedPassage>(segment => ({
    citation: String(segment.sequence),
    sequence: segment.sequence,
    speaker: speakers.intern(segment.speaker),
    text: segment.text,
    startMs: segment.startMs,
    endMs: segment.endMs,
  }));
  return { ...envelope(page, citationBase, speakers.names), passages };
}
