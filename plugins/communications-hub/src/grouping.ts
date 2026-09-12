import type { TranscriptSegment } from "./domain.js";

/**
 * A speaker's run of transcript segments, presented as one passage.
 *
 * Grouping is a read-time view. Segments stay immutable and keep their own
 * passage ids, so every member sequence still cites individually.
 */
export interface SpeakerBlock {
  speaker: string | null;
  /** Member sequences in ingestion order. Need not be contiguous. */
  sequences: number[];
  text: string;
  startMs: number | null;
  endMs: number | null;
  firstSequence: number;
  lastSequence: number;
  receivedAt: number;
}

export interface GroupSegmentsOptions {
  /** Silence from a speaker that ends their run. */
  gapMs?: number;
  /** Cap on a block's combined characters, so one monologue cannot grow without bound. */
  maxChars?: number;
}

/** A speaker pauses for about this long between sentences; longer reads as a new turn. */
export const DEFAULT_GAP_MS = 3_000;
const DEFAULT_MAX_CHARS = 2_000;

/**
 * Group consecutive segments from the same speaker into readable passages.
 *
 * Runs continue across other speakers' interjections. Meetings are full of
 * backchannel ("Hmm", "Yeah") landing mid-sentence, and splitting on it leaves
 * a speaker's sentence scattered over several rows: on a real 308-segment
 * meeting, grouping only sequence-adjacent segments yielded 187 blocks against
 * 124 for interleaved grouping, and the difference was whole sentences.
 *
 * Segments without timing (plain-text imports) never merge, because there is no
 * evidence about the pause between them.
 */
export function groupSegments(
  segments: readonly TranscriptSegment[],
  options: GroupSegmentsOptions = {},
): SpeakerBlock[] {
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const blocks: SpeakerBlock[] = [];
  const openBySpeaker = new Map<string, SpeakerBlock>();

  for (const segment of [...segments].sort((left, right) => left.sequence - right.sequence)) {
    // Prefer the display name. Rooms register their participants, so the name is one BB chose
    // and Zoom applied. The participant id identifies a connection rather than a person: one
    // human joining from two browsers produced two ids within a single meeting, and keying on
    // them split their turns in half. The id remains the tiebreaker for unattributed speech.
    const key = segment.speaker
      ? `name:${segment.speaker}`
      : segment.speakerId !== null && segment.speakerId !== undefined
        ? `id:${segment.speakerId}`
        : "name:";
    const open = openBySpeaker.get(key);
    const timed = segment.startMs !== null && open?.endMs !== null && open?.endMs !== undefined;
    const withinGap = timed && segment.startMs! - open!.endMs! <= gapMs;
    const withinLength = open ? open.text.length + 1 + segment.text.length <= maxChars : false;

    if (open && withinGap && withinLength) {
      open.sequences.push(segment.sequence);
      open.text = `${open.text} ${segment.text}`;
      open.endMs = segment.endMs === null ? open.endMs : Math.max(open.endMs!, segment.endMs);
      open.lastSequence = segment.sequence;
      open.receivedAt = Math.max(open.receivedAt, segment.receivedAt);
      continue;
    }

    const block: SpeakerBlock = {
      speaker: segment.speaker,
      sequences: [segment.sequence],
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      firstSequence: segment.sequence,
      lastSequence: segment.sequence,
      receivedAt: segment.receivedAt,
    };
    blocks.push(block);
    openBySpeaker.set(key, block);
  }

  return blocks;
}
