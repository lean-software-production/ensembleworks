import { describe, expect, it } from "vitest";
import { jpegBase64 } from "./helpers/jpeg.js";
import {
  DEFAULT_ZOOM_PRESENCE_CODES,
  decodeZoomPortraitFrame,
  decodeZoomPresenceEvents,
  eventSubscriptionFrame,
  parsePresenceCodes,
} from "../src/adapters/zoom-presence.js";

const AT = 1_800_000_000_000;
const codes = DEFAULT_ZOOM_PRESENCE_CODES;

/** Video data as Zoom sends it: MEDIA_DATA_VIDEO, with a `content` block. */
function videoMessage(content: Record<string, unknown>): unknown {
  return { msg_type: 15, content };
}

describe("Zoom presence event decoding", () => {
  it("decodes a named event without consulting the code table at all", () => {
    const events = decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: "PARTICIPANT_JOIN", participants: [{ user_id: 16778240, user_name: "Ada" }] },
    }, { speaker: 99, join: 98, leave: 97, cameraOn: 96, cameraOff: 95 }, AT);

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
    // An override corrects the codes it names and leaves the published values
    // for the ones it does not.
    expect(parsePresenceCodes("speaker=1,join=2,leave=3"))
      .toEqual({ ...DEFAULT_ZOOM_PRESENCE_CODES, speaker: 1, join: 2, leave: 3 });
    expect(parsePresenceCodes(" active_speaker = 6 , participant_join = 7 , participant_leave = 5 "))
      .toEqual({ ...DEFAULT_ZOOM_PRESENCE_CODES, speaker: 6, join: 7, leave: 5 });
    expect(parsePresenceCodes("camera_on=18,camera_off=19"))
      .toEqual({ ...DEFAULT_ZOOM_PRESENCE_CODES, cameraOn: 18, cameraOff: 19 });
  });

  it("falls back to the shipped table rather than throwing on a typo", () => {
    expect(parsePresenceCodes(undefined)).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("nonsense")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("speaker=2,join=2,leave=4")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    // A correction that collides with a code it did not mention is a typo too.
    expect(parsePresenceCodes("speaker=8")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
    expect(parsePresenceCodes("speaker=x,join=3,leave=4")).toEqual(DEFAULT_ZOOM_PRESENCE_CODES);
  });

  it("asks only for the events presence needs", () => {
    expect(eventSubscriptionFrame(codes)).toEqual({
      msg_type: 5,
      events: [
        { event_type: codes.join, subscribe: true },
        { event_type: codes.leave, subscribe: true },
        { event_type: codes.speaker, subscribe: true },
        { event_type: codes.cameraOn, subscribe: true },
        { event_type: codes.cameraOff, subscribe: true },
      ],
    });
  });
});

describe("Zoom portrait frame decoding", () => {
  it("takes the participant id and the capture time from the frame itself", () => {
    const frame = decodeZoomPortraitFrame(videoMessage({
      user_id: 16778240,
      timestamp: AT,
      data: jpegBase64(),
    }));
    expect(frame?.participantId).toBe("16778240");
    expect(frame?.capturedAt).toBe(AT);
    expect(frame?.bytes.byteLength).toBe(128);
  });

  it("refuses a frame with no identity, no timestamp, or no payload", () => {
    expect(decodeZoomPortraitFrame(videoMessage({ timestamp: AT, data: jpegBase64() }))).toBeNull();
    expect(decodeZoomPortraitFrame(videoMessage({ user_id: 1, data: jpegBase64() }))).toBeNull();
    expect(decodeZoomPortraitFrame(videoMessage({ user_id: 1, timestamp: AT }))).toBeNull();
    expect(decodeZoomPortraitFrame(videoMessage({ user_id: 1, timestamp: AT, data: "" }))).toBeNull();
    expect(decodeZoomPortraitFrame(videoMessage({ user_id: 1, timestamp: -1, data: jpegBase64() }))).toBeNull();
    expect(decodeZoomPortraitFrame(null)).toBeNull();
  });

  it("rejects an oversized payload on its length, before decoding it", () => {
    const huge = "A".repeat(400_004);
    expect(decodeZoomPortraitFrame(videoMessage({ user_id: 1, timestamp: AT, data: huge }))).toBeNull();
  });

  it("leaves image validation to the store rather than trusting the envelope", () => {
    // Base64 that decodes cleanly to something which is not a JPEG still
    // decodes here; the portrait store is what refuses it, and counts it.
    const frame = decodeZoomPortraitFrame(videoMessage({
      user_id: 1,
      timestamp: AT,
      data: Buffer.from([1, 2, 3]).toString("base64"),
    }));
    expect(frame?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
