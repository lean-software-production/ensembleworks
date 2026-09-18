import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM_PRESENCE_CODES,
  decodeZoomPortraitFrame,
  decodeZoomPresenceEvents,
  eventSubscriptionFrame,
  parsePresenceCodes,
} from "../src/adapters/zoom-presence.js";

const AT = 1_800_000_000_000;
const codes = DEFAULT_ZOOM_PRESENCE_CODES;

function jpegBase64(length = 64): string {
  const bytes = Buffer.alloc(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes[length - 2] = 0xff;
  bytes[length - 1] = 0xd9;
  return bytes.toString("base64");
}

describe("Zoom presence event decoding", () => {
  it("decodes a named event without consulting the code table at all", () => {
    const events = decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: "PARTICIPANT_JOIN", participants: [{ user_id: 16778240, user_name: "Ada" }] },
    }, { speaker: 99, join: 98, leave: 97 }, AT);

    expect(events).toEqual([{ kind: "joined", participantId: "16778240", name: "Ada", at: AT }]);
  });

  it("decodes the coded events, and ignores codes it was not given", () => {
    expect(decodeZoomPresenceEvents({ msg_type: 6, event: { event_type: codes.join, user_id: 1, user_name: "Ada" } }, codes, AT))
      .toEqual([{ kind: "joined", participantId: "1", name: "Ada", at: AT }]);
    expect(decodeZoomPresenceEvents({ msg_type: 6, event: { event_type: codes.leave, user_id: 1 } }, codes, AT))
      .toEqual([{ kind: "left", participantId: "1", at: AT }]);
    expect(decodeZoomPresenceEvents({ msg_type: 6, event: { event_type: codes.speaker, user_id: 1, user_name: "Ada" } }, codes, AT))
      .toEqual([{ kind: "speaking", participantId: "1", name: "Ada", at: AT }]);
    // 7 is the media-server change this adapter has always handled elsewhere;
    // presence decoding must not reinterpret it.
    expect(decodeZoomPresenceEvents({ msg_type: 6, event: { event_type: 7 } }, codes, AT)).toEqual([]);
  });

  it("guesses at nothing it does not recognise", () => {
    expect(decodeZoomPresenceEvents({ msg_type: 17, content: { data: "hello" } }, codes, AT)).toEqual([]);
    expect(decodeZoomPresenceEvents({ msg_type: 6 }, codes, AT)).toEqual([]);
    expect(decodeZoomPresenceEvents({ msg_type: 6, event: { event_type: 4_242, user_id: 1 } }, codes, AT)).toEqual([]);
    expect(decodeZoomPresenceEvents("not json at all", codes, AT)).toEqual([]);
    expect(decodeZoomPresenceEvents({ msg_type: 6, event: { event_type: codes.join } }, codes, AT)).toEqual([]);
  });

  it("refuses an active-speaker message that names more than one person", () => {
    // Several rings lit at once would mean we misread the message, and that is
    // worse than lighting none.
    expect(decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: codes.speaker, participants: [{ user_id: 1 }, { user_id: 2 }] },
    }, codes, AT)).toEqual([]);
  });

  it("uses receipt time rather than Zoom's own event timestamp", () => {
    expect(decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: codes.speaker, timestamp: 42, user_id: 1 },
    }, codes, AT)).toEqual([{ kind: "speaking", participantId: "1", name: null, at: AT }]);
  });

  it("never uses a display name as identity", () => {
    const events = decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: codes.join, user_name: "Ada" },
    }, codes, AT);
    expect(events).toEqual([]);
  });
});

describe("presence event codes", () => {
  it("ships a table and lets a deployment correct it", () => {
    expect(parsePresenceCodes("speaker=1,join=2,leave=3")).toEqual({ speaker: 1, join: 2, leave: 3 });
    expect(parsePresenceCodes(" active_speaker = 6 , participant_join = 7 , participant_leave = 8 "))
      .toEqual({ speaker: 6, join: 7, leave: 8 });
  });

  it("falls back to the shipped table rather than throwing on a typo", () => {
    expect(parsePresenceCodes(undefined)).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("nonsense")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("speaker=2,join=2,leave=4")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("speaker=x,join=3,leave=4")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
  });

  it("asks only for the three events presence needs", () => {
    expect(eventSubscriptionFrame("stream-1", codes)).toEqual({
      msg_type: 5,
      rtms_stream_id: "stream-1",
      events: [
        { event_type: codes.join, subscribe: true },
        { event_type: codes.leave, subscribe: true },
        { event_type: codes.speaker, subscribe: true },
      ],
    });
  });
});

describe("Zoom portrait frame decoding", () => {
  it("takes the participant id and the capture time from the frame itself", () => {
    const frame = decodeZoomPortraitFrame({
      msg_type: 17,
      content: { user_id: 16778240, timestamp: AT, data: jpegBase64() },
    });
    expect(frame?.participantId).toBe("16778240");
    expect(frame?.capturedAt).toBe(AT);
    expect(frame?.bytes.byteLength).toBe(64);
  });

  it("refuses a frame with no identity, no timestamp, or no payload", () => {
    expect(decodeZoomPortraitFrame({ content: { timestamp: AT, data: jpegBase64() } })).toBeNull();
    expect(decodeZoomPortraitFrame({ content: { user_id: 1, data: jpegBase64() } })).toBeNull();
    expect(decodeZoomPortraitFrame({ content: { user_id: 1, timestamp: AT } })).toBeNull();
    expect(decodeZoomPortraitFrame({ content: { user_id: 1, timestamp: AT, data: "" } })).toBeNull();
    expect(decodeZoomPortraitFrame({ content: { user_id: 1, timestamp: -1, data: jpegBase64() } })).toBeNull();
    expect(decodeZoomPortraitFrame(null)).toBeNull();
  });

  it("rejects an oversized payload on its length, before decoding it", () => {
    const huge = "A".repeat(400_001);
    expect(decodeZoomPortraitFrame({ content: { user_id: 1, timestamp: AT, data: huge } })).toBeNull();
  });

  it("leaves image validation to the store rather than trusting the envelope", () => {
    // Base64 that decodes to something which is not a JPEG still decodes here;
    // the portrait store is what refuses it, and it counts the refusal.
    const frame = decodeZoomPortraitFrame({
      content: { user_id: 1, timestamp: AT, data: Buffer.from([1, 2, 3]).toString("base64") },
    });
    expect(frame?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
