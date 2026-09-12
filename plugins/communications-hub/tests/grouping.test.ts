import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../src/domain.js";
import { groupSegments } from "../src/grouping.js";

let nextSequence = 0;

function segment(
  speaker: string | null,
  text: string,
  startMs: number | null,
  endMs: number | null,
  sequence = ++nextSequence,
): TranscriptSegment {
  return {
    id: `segment-${sequence}`,
    conversationId: "conversation",
    sequence,
    sourceKey: `key-${sequence}`,
    speakerId: null,
    speaker,
    text,
    startMs,
    endMs,
    receivedAt: 1_000 + sequence,
  };
}

describe("speaker grouping", () => {
  it("joins a speaker's segments across a short pause", () => {
    const blocks = groupSegments([
      segment("Ada", "Let's ship it.", 0, 2_000),
      segment("Ada", "After the tests pass.", 2_500, 4_000),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe("Let's ship it. After the tests pass.");
    expect(blocks[0]!.startMs).toBe(0);
    expect(blocks[0]!.endMs).toBe(4_000);
  });

  it("starts a new block after a long silence", () => {
    const blocks = groupSegments([
      segment("Ada", "Let's ship it.", 0, 2_000),
      segment("Ada", "Anyway, lunch?", 30_000, 31_000),
    ]);
    expect(blocks.map((block) => block.text)).toEqual(["Let's ship it.", "Anyway, lunch?"]);
  });

  it("continues a run across another speaker's interjection", () => {
    // Backchannel lands mid-sentence constantly in real meetings; splitting on
    // it leaves one speaker's sentence scattered over several rows.
    const blocks = groupSegments([
      segment("Ada", "The webhook needs", 0, 2_000),
      segment("Grace", "Mmhm.", 1_500, 2_200),
      segment("Ada", "a public endpoint.", 2_400, 4_000),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.speaker).toBe("Ada");
    expect(blocks[0]!.text).toBe("The webhook needs a public endpoint.");
    expect(blocks[0]!.sequences).toHaveLength(2);
    expect(blocks[1]!.text).toBe("Mmhm.");
  });

  it("keeps every member sequence so passages still cite individually", () => {
    const first = segment("Ada", "One.", 0, 1_000);
    const second = segment("Ada", "Two.", 1_200, 2_000);
    const blocks = groupSegments([first, second]);
    expect(blocks[0]!.sequences).toEqual([first.sequence, second.sequence]);
    expect(blocks[0]!.firstSequence).toBe(first.sequence);
    expect(blocks[0]!.lastSequence).toBe(second.sequence);
  });

  it("caps a block's length instead of growing without bound", () => {
    const long = "x".repeat(60);
    const blocks = groupSegments(
      [
        segment("Ada", long, 0, 1_000),
        segment("Ada", long, 1_100, 2_000),
        segment("Ada", long, 2_100, 3_000),
      ],
      { maxChars: 130 },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text.length).toBeLessThanOrEqual(130);
  });

  it("never merges untimed segments, because the pause is unknown", () => {
    const blocks = groupSegments([
      segment("Ada", "Imported line one.", null, null),
      segment("Ada", "Imported line two.", null, null),
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("groups unattributed segments together rather than dropping them", () => {
    const blocks = groupSegments([
      segment(null, "Half a sentence", 0, 1_000),
      segment(null, "and the rest.", 1_200, 2_000),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.speaker).toBeNull();
  });

  it("joins one person's turns across their two connections", () => {
    // Measured: one human joining from two browsers produced two participant ids in a single
    // meeting. Keying on the id split their turns in half and rendered them as two speakers.
    const first = { ...segment("David Laing", "Starting on the migration,", 0, 2_000), speakerId: "16778240" };
    const second = { ...segment("David Laing", "and then the tests.", 2_200, 4_000), speakerId: "16791552" };
    const blocks = groupSegments([first, second]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe("Starting on the migration, and then the tests.");
  });

  it("merges two participants who share a display name", () => {
    // The accepted cost of trusting the name. Rooms register their participants, so the name
    // is one BB issued, but a stranger self-registering under an existing name would have
    // their words joined to that person's. Registration is a gate, not proof of identity.
    const first = { ...segment("Dave", "I'll take the migration.", 0, 2_000), speakerId: "111" };
    const second = { ...segment("Dave", "No, I'm doing that.", 2_200, 4_000), speakerId: "222" };
    const blocks = groupSegments([first, second]);
    expect(blocks).toHaveLength(1);
  });

  it("splits a run when the display name changes mid-meeting", () => {
    // The other cost. Zoom lets a participant rename themselves unless the host disables it,
    // and the name is now what identifies them, so a rename reads as a new speaker.
    const first = { ...segment("Dave", "Renaming myself,", 0, 2_000), speakerId: "111" };
    const second = { ...segment("David Laing", "there we go.", 2_200, 4_000), speakerId: "111" };
    const blocks = groupSegments([first, second]);
    expect(blocks).toHaveLength(2);
  });

  it("still separates unattributed speech by participant id", () => {
    // Without a name there is nothing else to go on, so the id keeps its old job.
    const first = { ...segment(null, "One voice.", 0, 2_000), speakerId: "111" };
    const second = { ...segment(null, "A different one.", 2_200, 4_000), speakerId: "222" };
    expect(groupSegments([first, second])).toHaveLength(2);
  });

  it("returns nothing for no segments", () => {
    expect(groupSegments([])).toEqual([]);
  });
});
