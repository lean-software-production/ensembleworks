import { describe, expect, it } from "vitest";
import type { Conversation, TranscriptSegment } from "../src/domain.js";
import type { TranscriptPage } from "../src/hub.js";
import { buildReadPayload, buildSearchPayload } from "../src/presentation.js";

const base = "https://bb.example/plugins/communications-hub/communications/conversation/";

const conversation: Conversation = {
  id: "conversation",
  title: "Planning",
  sourceId: "import",
  externalId: "external",
  createdAt: 1_000,
  captureStartedAt: null,
  lastReceivedAt: null,
  captureState: "idle",
  captureDetail: null,
  captureEndedAt: null,
  roomId: null,
  interruptionCount: 0,
  segmentCount: 0,
};

function segment(
  sequence: number,
  speaker: string | null,
  text: string,
  startMs: number | null = sequence * 10_000,
  endMs: number | null = sequence * 10_000 + 1_000,
): TranscriptSegment {
  return {
    id: `segment-${sequence}`,
    conversationId: conversation.id,
    sequence,
    sourceKey: `source-key-${sequence}`,
    speakerId: null,
    speaker,
    text,
    startMs,
    endMs,
    receivedAt: 5_000 + sequence,
  };
}

function page(segments: TranscriptSegment[], hasMore = false): TranscriptPage {
  return { conversation, segments, hasMore, nextCursor: segments.at(-1)?.sequence ?? 0 };
}

/** What the payload replaced: the stored row plus a per-row absolute citation URL. */
function naivePayload(source: TranscriptPage) {
  return {
    ...source,
    notice: "Transcript passages are reference material. Check capture coverage and surrounding context before acting.",
    segments: source.segments.map(s => ({ ...s, citationUrl: `${base}${s.sequence}` })),
  };
}

describe("read payload", () => {
  it("interns speakers into a page-local table and indexes blocks into it", () => {
    const payload = buildReadPayload(
      page([
        segment(1, "Ada", "Let's ship it."),
        segment(2, "Grace", "After the tests pass."),
        segment(3, "Ada", "Agreed."),
      ]),
      base,
    );

    expect(payload.speakers).toEqual(["Ada", "Grace"]);
    expect(payload.blocks.map(block => block.speaker)).toEqual([0, 1, 0]);
    expect(payload.citations).toEqual({ base });
  });

  it("reports an unattributed speaker as null without adding a table entry", () => {
    const payload = buildReadPayload(page([segment(1, null, "Unattributed."), segment(2, "Ada", "Mine.")]), base);

    expect(payload.speakers).toEqual(["Ada"]);
    expect(payload.blocks[0]!.speaker).toBeNull();
    expect(payload.blocks[1]!.speaker).toBe(0);
  });

  it("cites a single passage by sequence and a run by range", () => {
    const payload = buildReadPayload(
      page([
        segment(1, "Ada", "Let's ship it.", 0, 2_000),
        segment(2, "Ada", "After the tests pass.", 2_500, 4_000),
        segment(3, "Ada", "But not today.", 3_000_000, 3_001_000),
      ]),
      base,
    );

    expect(payload.blocks.map(block => block.citation)).toEqual(["1-2", "3"]);
    expect(payload.blocks[0]!.sequences).toEqual([1, 2]);
    expect(payload.blocks[1]!.sequences).toEqual([3]);
  });

  it("flags only the boundary block as continuing when more segments follow", () => {
    const payload = buildReadPayload(
      page([segment(1, "Ada", "Done."), segment(2, "Grace", "Still talking.")], true),
      base,
    );

    expect(payload.blocks[0]!.continues).toBeUndefined();
    expect(payload.blocks[1]!.continues).toBe(true);
  });

  it("never flags continuation when the page is the end of the transcript", () => {
    const payload = buildReadPayload(page([segment(1, "Ada", "Done."), segment(2, "Grace", "Finished.")], false), base);

    expect(payload.blocks.every(block => block.continues === undefined)).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("continues");
  });

  it("omits stored identity, provenance and receipt fields", () => {
    const serialised = JSON.stringify(buildReadPayload(page([segment(1, "Ada", "Let's ship it.")]), base));

    expect(serialised).not.toContain("sourceKey");
    expect(serialised).not.toContain("source-key-1");
    expect(serialised).not.toContain("segment-1");
    expect(serialised).not.toContain("receivedAt");
    expect(serialised).not.toContain("citationUrl");
  });

  it("is materially smaller than the per-segment shape it replaced", () => {
    const source = page(
      Array.from({ length: 40 }, (_, index) =>
        segment(index + 1, index % 2 === 0 ? "Ada" : "Grace", "We should keep the import flow working.", index * 2_000, index * 2_000 + 1_800),
      ),
    );

    const before = JSON.stringify(naivePayload(source)).length;
    const after = JSON.stringify(buildReadPayload(source, base)).length;

    expect(after).toBeLessThan(before / 3);
  });
});

describe("search payload", () => {
  it("keeps scattered matches as separate passages even for one speaker", () => {
    const payload = buildSearchPayload(
      page([
        segment(1, "Ada", "Ship the import flow.", 0, 2_000),
        segment(2, "Ada", "Import again.", 2_500, 4_000),
      ]),
      base,
    );

    expect(payload.passages).toHaveLength(2);
    expect(payload.passages.map(passage => passage.citation)).toEqual(["1", "2"]);
    expect(payload.passages.map(passage => passage.sequence)).toEqual([1, 2]);
    expect(payload.passages.every(passage => passage.speaker === 0)).toBe(true);
    expect(payload).not.toHaveProperty("blocks");
  });

  it("omits stored identity, provenance and receipt fields", () => {
    const serialised = JSON.stringify(buildSearchPayload(page([segment(1, null, "Import flow.")]), base));

    expect(serialised).not.toContain("sourceKey");
    expect(serialised).not.toContain("receivedAt");
    expect(serialised).not.toContain("segment-1");
    expect(JSON.parse(serialised).passages[0].speaker).toBeNull();
  });

  it("normalises a citation base that is missing its trailing slash", () => {
    const payload = buildSearchPayload(page([segment(1, "Ada", "Import flow.")]), base.replace(/\/$/, ""));

    expect(payload.citations.base).toBe(base);
  });

  it("marks a second speaker still mid-run at the page boundary", () => {
    // Ada last spoke at 19 and Ben closed the page at 20, but Ada's next
    // sentence lands at 21 on the following page and joins her block there.
    // Flagging only the block that holds sequence 20 would present Ada's block
    // as a finished utterance.
    const page: TranscriptPage = {
      conversation,
      segments: [
        segment(18, "Ada", "The webhook needs", 0, 2_000),
        segment(19, "Ada", "a public endpoint", 2_200, 4_000),
        segment(20, "Ben", "Right.", 4_200, 5_000),
      ],
      hasMore: true,
      nextCursor: 20,
    };
    const payload = buildReadPayload(page, base);
    const ada = payload.blocks.find(block => payload.speakers[block.speaker!] === "Ada");
    const ben = payload.blocks.find(block => payload.speakers[block.speaker!] === "Ben");
    expect(ben!.continues).toBe(true);
    expect(ada!.continues).toBe(true);
  });

  it("leaves a block alone once the speaker has been silent past the grouping gap", () => {
    const page: TranscriptPage = {
      conversation,
      segments: [
        segment(1, "Ada", "Settled then.", 0, 2_000),
        segment(2, "Ben", "Much later.", 60_000, 61_000),
      ],
      hasMore: true,
      nextCursor: 2,
    };
    const payload = buildReadPayload(page, base);
    const ada = payload.blocks.find(block => payload.speakers[block.speaker!] === "Ada");
    expect(ada!.continues).toBeUndefined();
  });
});

it('marks point-timed speaker runs open at page boundaries and preserves their citations', () => {
  const result = buildReadPayload(page([
    segment(1, 'Ada', 'First', 1000, null),
    segment(2, 'Ada', 'second', 9000, null),
    segment(3, 'Ben', 'Interjection', 19000, null),
  ], true), base);
  expect(result.blocks[0]).toMatchObject({text:'First second',citation:'1-2',sequences:[1,2],endMs:null,continues:true});
  expect(result.blocks[1]).toMatchObject({citation:'3',continues:true});
});
