/**
 * Zoom's wire, translated into the hub's generic presence vocabulary.
 *
 * Everything Zoom-shaped about presence lives here: message numbers, event
 * codes, `user_id`, base64 media payloads. What leaves this file is a
 * `PresenceEvent` or a `PortraitFrame` and nothing else, so the hub never learns
 * what a stream id is.
 *
 * ── WHAT IS VERIFIED, AND WHAT IS NOT ────────────────────────────────────────
 *
 * The numbers below were read from Zoom's current published reference on
 * 2026-09-18 and are locked by `tests/zoom-rtms-contract.test.ts`, which cites
 * the page each one came from:
 *
 *   RTMS_EVENT_TYPE      ACTIVE_SPEAKER_CHANGE 2, PARTICIPANT_JOIN 3,
 *                        PARTICIPANT_LEAVE 4, PARTICIPANT_VIDEO_ON 8,
 *                        PARTICIPANT_VIDEO_OFF 9
 *   RTMS_MESSAGE_TYPE    EVENT_SUBSCRIPTION 5, EVENT_UPDATE 6,
 *                        MEDIA_DATA_VIDEO 15
 *   MEDIA_DATA_OPTION    VIDEO_SINGLE_INDIVIDUAL_STREAM 4
 *
 * What is still NOT verified is this deployment's own behaviour against a live
 * meeting: no credentials or meeting are available where this was built, so the
 * frames are proved against the documentation and controlled sockets only.
 * Two consequences remain deliberate:
 *
 * 1. NOTHING NEW IS SENT ON THE WIRE UNLESS AN OPERATOR OPTS IN. The
 *    subscription frame is built only when `zoomPresenceEnabled` is on, and the
 *    video socket only when `zoomVideoEnabled` is. Video additionally needs
 *    video access on the deployment's own Zoom app, which is not something this
 *    plugin can grant itself.
 * 2. THE EVENT TABLE STAYS OVERRIDABLE. `zoomPresenceEventCodes` is an escape
 *    hatch for a deployment that meets a different enum than the published one;
 *    it is no longer the reason the defaults exist. Events that arrive NAMED
 *    are decoded by name and ignore the table entirely.
 *
 * Neither path ever lets the hub claim a complete roster: see `roster.ts`.
 */

import type { PresenceEvent } from "../presence/roster.js";
import type { PortraitFrame } from "../presence/portraits.js";

/** RTMS_MESSAGE_TYPE.EVENT_UPDATE — an event from the signaling connection. */
export const ZOOM_EVENT_MESSAGE = 6;
/** RTMS_MESSAGE_TYPE.EVENT_SUBSCRIPTION — asking for in-session events. */
export const ZOOM_EVENT_SUBSCRIPTION = 5;
/** RTMS_MESSAGE_TYPE.MEDIA_DATA_VIDEO — video data from a media connection. */
export const ZOOM_VIDEO_DATA = 15;

/** Ceiling on one base64 media payload, before decoding. */
const MAX_PORTRAIT_BASE64 = 400_000;

/**
 * The video media connection this plugin asks for.
 *
 * `media_type: 2` is MEDIA_DATA_TYPE.VIDEO; inside it, RAW_VIDEO (3) as JPG (5)
 * at SD (1) and 1fps — the smallest, slowest still feed RTMS offers — with
 * individual stream selection (4). Subscribe to a participant for one still,
 * then unsubscribe so Zoom sends no video between portrait refreshes.
 * https://developers.zoom.us/docs/rtms/meetings/video-single-stream/
 */
export const ZOOM_VIDEO_MEDIA_PARAMS = {
  media_type: 2,
  media_params: { video: { content_type: 3, codec: 5, resolution: 1, fps: 1, data_opt: 4 } },
} as const;

export interface ZoomPresenceCodes {
  readonly speaker: number;
  readonly join: number;
  readonly leave: number;
  readonly cameraOn: number;
  readonly cameraOff: number;
}

/** RTMS_EVENT_TYPE, as published. See the header for the citation. */
export const DEFAULT_ZOOM_PRESENCE_CODES: ZoomPresenceCodes = {
  speaker: 2,
  join: 3,
  leave: 4,
  cameraOn: 8,
  cameraOff: 9,
};

const CODE_ALIASES: Record<keyof ZoomPresenceCodes, readonly string[]> = {
  speaker: ["speaker", "active_speaker"],
  join: ["join", "participant_join"],
  leave: ["leave", "participant_leave"],
  cameraOn: ["camera_on", "cameraon", "video_on", "participant_video_on"],
  cameraOff: ["camera_off", "cameraoff", "video_off", "participant_video_off"],
};

/**
 * Read an operator override such as `speaker=2,join=3,leave=4,camera_on=8`.
 *
 * Unmentioned events keep their published value, so an override can correct one
 * number without having to restate the rest. Anything malformed — or a table
 * that would give two events the same code — falls back to the published table
 * rather than throwing: a typo in a setting must not stop a plugin loading, and
 * the worst case of the fallback is the documented behaviour.
 */
export function parsePresenceCodes(value: string | null | undefined): ZoomPresenceCodes {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_ZOOM_PRESENCE_CODES;
  const given: Record<string, number> = {};
  for (const part of value.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    const parsed = Number(rawValue?.trim());
    if (!key || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000) continue;
    given[key] = parsed;
  }
  if (Object.keys(given).length === 0) return DEFAULT_ZOOM_PRESENCE_CODES;
  const codes = { ...DEFAULT_ZOOM_PRESENCE_CODES } as Record<keyof ZoomPresenceCodes, number>;
  for (const [field, aliases] of Object.entries(CODE_ALIASES) as [keyof ZoomPresenceCodes, string[]][]) {
    for (const alias of aliases) {
      const override = given[alias];
      if (override !== undefined) {
        codes[field] = override;
        break;
      }
    }
  }
  const values = Object.values(codes);
  if (new Set(values).size !== values.length) return DEFAULT_ZOOM_PRESENCE_CODES;
  return codes;
}

/**
 * The frame that asks for the participant, speaker and camera events.
 *
 * Shaped exactly as Zoom documents the subscription message: `msg_type` and
 * `events`, nothing else. FIRST_PACKET_TIMESTAMP (1) and
 * MEDIA_CONNECTION_INTERRUPTED (7) are deliberately absent — Zoom sends both
 * unasked and documents that subscribing to them breaks the app.
 */
export function eventSubscriptionFrame(codes: ZoomPresenceCodes): unknown {
  return {
    msg_type: ZOOM_EVENT_SUBSCRIPTION,
    events: [
      { event_type: codes.join, subscribe: true },
      { event_type: codes.leave, subscribe: true },
      { event_type: codes.speaker, subscribe: true },
      { event_type: codes.cameraOn, subscribe: true },
      { event_type: codes.cameraOff, subscribe: true },
    ],
  };
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

/**
 * Zoom's participant identity for one occurrence, as a string.
 *
 * `user_id` is a per-session counter: it separates simultaneous speakers inside
 * one sitting and means nothing across sittings (docs/zoom-setup.md,
 * 2026-09-12). The roster scopes it to its sitting for exactly that reason, and
 * the name is never used as identity.
 */
function participantId(row: Row): string | null {
  const raw = row.user_id ?? row.participant_id ?? row.userId;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim().slice(0, 200);
  return null;
}

function participantName(row: Row): string | null {
  const raw = row.user_name ?? row.display_name ?? row.userName;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim().slice(0, 120) : null;
}

/** The people an event is about, whatever shape Zoom wrapped them in. */
function subjects(event: Row): Row[] {
  const list = event.participants ?? event.users;
  if (Array.isArray(list)) return list.map(asRow).filter((row): row is Row => row !== null).slice(0, 100);
  const single = asRow(event.participant ?? event.user);
  if (single) return [single];
  return participantId(event) === null ? [] : [event];
}

type NamedKind = "join" | "leave" | "speaker" | "camera-on" | "camera-off";

/** A self-describing event needs no lookup table; prefer it when Zoom sends one. */
function namedKind(event: Row): NamedKind | null {
  const raw = event.event_name ?? (typeof event.event_type === "string" ? event.event_type : null);
  if (typeof raw !== "string") return null;
  const name = raw.trim().toUpperCase();
  if (name.includes("ACTIVE_SPEAKER")) return "speaker";
  if (name.includes("PARTICIPANT_JOIN")) return "join";
  if (name.includes("PARTICIPANT_LEAVE")) return "leave";
  if (name.includes("VIDEO_ON")) return "camera-on";
  if (name.includes("VIDEO_OFF")) return "camera-off";
  return null;
}

function codedKind(event: Row, codes: ZoomPresenceCodes): NamedKind | null {
  const code = event.event_type;
  if (typeof code !== "number" || !Number.isSafeInteger(code)) return null;
  if (code === codes.speaker) return "speaker";
  if (code === codes.join) return "join";
  if (code === codes.leave) return "leave";
  if (code === codes.cameraOn) return "camera-on";
  if (code === codes.cameraOff) return "camera-off";
  return null;
}

/**
 * Decode one signaling message into presence observations.
 *
 * `at` is the receipt time and is what the roster's decay is measured against.
 * Zoom's own event timestamps are deliberately NOT used for that: the transcript
 * path already shows Zoom mixing absolute and stream-relative times, and a decay
 * window driven by a timestamp we cannot interpret would either freeze a ring on
 * or blink it off. Receipt time is a smaller claim and an accurate one.
 *
 * An unrecognized message decodes to nothing at all — never to a guess.
 */
export function decodeZoomPresenceEvents(
  message: unknown,
  codes: ZoomPresenceCodes,
  at: number,
): PresenceEvent[] {
  const row = asRow(message);
  if (!row || row.msg_type !== ZOOM_EVENT_MESSAGE) return [];
  const event = asRow(row.event);
  if (!event) return [];
  const kind = namedKind(event) ?? codedKind(event, codes);
  if (kind === null) return [];
  const events: PresenceEvent[] = [];
  for (const subject of subjects(event)) {
    const id = participantId(subject);
    if (id === null) continue;
    if (kind === "join") events.push({ kind: "joined", participantId: id, name: participantName(subject), at });
    else if (kind === "leave") events.push({ kind: "left", participantId: id, at });
    else if (kind === "camera-on") events.push({ kind: "camera", participantId: id, on: true, at });
    else if (kind === "camera-off") events.push({ kind: "camera", participantId: id, on: false, at });
    else events.push({ kind: "speaking", participantId: id, name: participantName(subject), at });
  }
  // An active-speaker event names one person. Several would mean we misread the
  // message, and lighting up a row of rings is worse than lighting up none.
  // Camera events legitimately carry a list, so this applies to speaker only.
  if (kind === "speaker" && events.length > 1) return [];
  return events;
}

/** Canonical base64 — the only encoding Zoom documents for media payloads. */
function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    return null;
  }
  // Node's decoder is forgiving: it skips characters it cannot use rather than
  // failing. Re-encoding is what actually proves the payload was intact.
  return bytes.toString("base64") === value ? bytes : null;
}

/**
 * Decode one video media message into a still.
 *
 * The participant id comes from the FRAME, never from the caller: a picture
 * filed under the wrong person is the only failure in this feature that
 * misinforms rather than merely missing. Size is bounded before the base64 is
 * decoded, so an oversized frame costs a length check rather than a buffer.
 *
 * Three refusals are worth naming, because each one is a frame that LOOKS
 * usable:
 *
 * - a message that is not MEDIA_DATA_VIDEO. Audio, screen share, transcript and
 *   chat all arrive with a `content` block of the same shape, and a transcript
 *   is not a portrait.
 * - a payload that disagrees with the frame's own `length`, which Zoom
 *   documents as the size of the binary before base64. A frame carrying six
 *   bytes and claiming 999 is one we misread or somebody else's.
 * - non-canonical base64. Node's decoder silently drops what it cannot use, so
 *   garbage decodes to a short buffer instead of failing.
 *
 * Returns null for all of them; the caller counts every refusal against the
 * video failure budget and carries on with transcript capture regardless.
 */
export function decodeZoomPortraitFrame(message: unknown): PortraitFrame | null {
  const row = asRow(message);
  if (!row || row.msg_type !== ZOOM_VIDEO_DATA) return null;
  const content = asRow(row.content);
  if (!content) return null;
  const id = participantId(content);
  if (id === null) return null;
  const data = content.data;
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_PORTRAIT_BASE64) return null;
  const capturedAt = content.timestamp;
  if (typeof capturedAt !== "number" || !Number.isSafeInteger(capturedAt) || capturedAt <= 0) return null;
  const bytes = decodeBase64(data);
  if (bytes === null || bytes.byteLength === 0) return null;
  const declared = content.length;
  if (declared !== undefined) {
    if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared !== bytes.byteLength) {
      return null;
    }
  }
  return { participantId: id, capturedAt, bytes: new Uint8Array(bytes) };
}
