/**
 * The Zoom RTMS wire, checked against Zoom's own current documentation.
 *
 * Every number asserted here was read from developers.zoom.us on 2026-09-18 and
 * the pages are archived beside this branch's implementation report
 * (`factory/rtms-docs/`). This file exists so that a future change to the
 * adapter has to argue with the published contract rather than with a comment:
 *
 * - Event subscription request — RTMS_MESSAGE_TYPE.EVENT_SUBSCRIPTION = 5, and
 *   the documented frame carries `msg_type` and `events` only.
 *   https://developers.zoom.us/docs/rtms/event-reference/
 * - RTMS_EVENT_TYPE: ACTIVE_SPEAKER_CHANGE 2, PARTICIPANT_JOIN 3,
 *   PARTICIPANT_LEAVE 4, MEDIA_CONNECTION_INTERRUPTED 7, PARTICIPANT_VIDEO_ON
 *   8, PARTICIPANT_VIDEO_OFF 9. FIRST_PACKET_TIMESTAMP (1) and 7 are sent
 *   automatically and must NOT be subscribed to.
 *   https://developers.zoom.us/docs/rtms/data-types/
 * - Video media data is MEDIA_DATA_VIDEO = 15 with
 *   `content: { user_id, user_name, data, length, timestamp }`, where `length`
 *   is "the length of the original binary data before base64 encoding".
 *   https://developers.zoom.us/docs/rtms/meetings/media/
 * - Active-speaker video is MEDIA_DATA_OPTION.VIDEO_SINGLE_ACTIVE_STREAM = 3,
 *   on MEDIA_CONTENT_TYPE.RAW_VIDEO = 3, MEDIA_PAYLOAD_TYPE.JPG = 5,
 *   MEDIA_RESOLUTION.SD = 1, over MEDIA_DATA_TYPE.VIDEO = 2.
 *   https://developers.zoom.us/docs/rtms/media-parameter-definition/
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM_PRESENCE_CODES,
  ZOOM_VIDEO_DATA,
  ZOOM_VIDEO_MEDIA_PARAMS,
  decodeZoomPortraitFrame,
  decodeZoomPresenceEvents,
  eventSubscriptionFrame,
} from "../src/adapters/zoom-presence.js";
import { jpegBase64, jpegBytes } from "./helpers/jpeg.js";

const AT = 1_800_000_000_000;
const codes = DEFAULT_ZOOM_PRESENCE_CODES;

describe("the documented RTMS event contract", () => {
  it("uses the published event numbers", () => {
    expect(DEFAULT_ZOOM_PRESENCE_CODES).toEqual({
      speaker: 2,
      join: 3,
      leave: 4,
      cameraOn: 8,
      cameraOff: 9,
    });
  });

  it("subscribes with the documented frame, and to nothing Zoom sends unasked", () => {
    const frame = eventSubscriptionFrame(codes) as { msg_type: number; events: unknown[] };

    // The documented subscription message carries msg_type and events only.
    expect(Object.keys(frame).sort()).toEqual(["events", "msg_type"]);
    expect(frame).toEqual({
      msg_type: 5,
      events: [
        { event_type: 3, subscribe: true },
        { event_type: 4, subscribe: true },
        { event_type: 2, subscribe: true },
        { event_type: 8, subscribe: true },
        { event_type: 9, subscribe: true },
      ],
    });
    // "Some events are sent automatically and don't need to be subscribed to.
    //  To ensure your app works as expected, don't subscribe to these events.
    //  FIRST_PACKET_TIMESTAMP = 1, MEDIA_CONNECTION_INTERRUPTED = 7"
    const subscribed = frame.events.map((event) => (event as { event_type: number }).event_type);
    expect(subscribed).not.toContain(1);
    expect(subscribed).not.toContain(7);
  });

  it("decodes a camera-on event in the shape Zoom documents", () => {
    expect(decodeZoomPresenceEvents({
      msg_type: 6,
      event: {
        event_type: 8,
        timestamp: 1_727_384_349_123,
        participants: [{ user_id: 16778240 }, { user_id: 33556610 }],
      },
    }, codes, AT)).toEqual([
      { kind: "camera", participantId: "16778240", on: true, at: AT },
      { kind: "camera", participantId: "33556610", on: true, at: AT },
    ]);
  });

  it("decodes a camera-off event in the shape Zoom documents", () => {
    expect(decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: 9, timestamp: 1_727_384_349_123, participants: [{ user_id: 16778240 }] },
    }, codes, AT)).toEqual([{ kind: "camera", participantId: "16778240", on: false, at: AT }]);
  });

  it("decodes the named camera events without the code table", () => {
    const table = { speaker: 91, join: 92, leave: 93, cameraOn: 94, cameraOff: 95 };
    expect(decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: "PARTICIPANT_VIDEO_ON", participants: [{ user_id: 7 }] },
    }, table, AT)).toEqual([{ kind: "camera", participantId: "7", on: true, at: AT }]);
    expect(decodeZoomPresenceEvents({
      msg_type: 6,
      event: { event_type: "PARTICIPANT_VIDEO_OFF", participants: [{ user_id: 7 }] },
    }, table, AT)).toEqual([{ kind: "camera", participantId: "7", on: false, at: AT }]);
  });
});

describe("the documented RTMS video contract", () => {
  it("asks for the active speaker's stream, as JPG stills at the lowest rate", () => {
    expect(ZOOM_VIDEO_MEDIA_PARAMS).toEqual({
      // MEDIA_DATA_TYPE.VIDEO
      media_type: 2,
      media_params: {
        video: {
          // RAW_VIDEO, JPG, SD, 1fps, VIDEO_SINGLE_ACTIVE_STREAM
          content_type: 3,
          codec: 5,
          resolution: 1,
          fps: 1,
          data_opt: 3,
        },
      },
    });
  });

  it("only accepts a frame that says it is video data", () => {
    const content = { user_id: 7, timestamp: AT, data: jpegBase64(), length: jpegBytes().byteLength };
    expect(decodeZoomPortraitFrame({ msg_type: ZOOM_VIDEO_DATA, content })?.participantId).toBe("7");
    // Audio (14), screen share (16), transcript (17) and chat (18) all arrive
    // with a `content` block of the same shape. None of them is a portrait.
    for (const msgType of [14, 16, 17, 18, undefined]) {
      expect(decodeZoomPortraitFrame({ msg_type: msgType, content })).toBeNull();
    }
  });

  it("holds the frame to its own declared byte length", () => {
    const bytes = jpegBytes();
    expect(decodeZoomPortraitFrame({
      msg_type: ZOOM_VIDEO_DATA,
      content: { user_id: 7, timestamp: AT, data: jpegBase64(), length: bytes.byteLength },
    })?.bytes.byteLength).toBe(bytes.byteLength);

    // A frame whose payload does not match what it claims to be carrying is a
    // frame we misread or somebody else's bytes; either way it is not usable.
    expect(decodeZoomPortraitFrame({
      msg_type: ZOOM_VIDEO_DATA,
      content: { user_id: 7, timestamp: AT, data: jpegBase64(), length: 999 },
    })).toBeNull();
    expect(decodeZoomPortraitFrame({
      msg_type: ZOOM_VIDEO_DATA,
      content: { user_id: 7, timestamp: AT, data: jpegBase64(), length: -1 },
    })).toBeNull();
  });

  it("refuses anything that is not canonical base64", () => {
    for (const data of ["!!!!", "ZZZ", "ab==cd", "  ", "%%%%"]) {
      expect(decodeZoomPortraitFrame({
        msg_type: ZOOM_VIDEO_DATA,
        content: { user_id: 7, timestamp: AT, data },
      })).toBeNull();
    }
  });
});
