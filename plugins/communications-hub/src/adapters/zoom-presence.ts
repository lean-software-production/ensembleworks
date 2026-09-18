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
 * The transcript path in `zoom-protocol.ts` was verified against live meetings
 * (docs/zoom-setup.md, "Validated behaviour"). The PRESENCE path was not: this
 * environment cannot reach developers.zoom.us (egress to that host is denied, so
 * the current event reference could not be re-read on 2026-09-18), and no live
 * meeting is available here.
 *
 * Two deliberate consequences:
 *
 * 1. NOTHING IS SENT ON THE WIRE UNLESS AN OPERATOR OPTS IN. The signaling
 *    subscription frame is only built when the `zoomPresenceEnabled` setting is
 *    on. With it off — the default — capture is byte-for-byte what it is today,
 *    so an unverified guess cannot regress transcript capture, which is the
 *    feature people actually depend on.
 * 2. THE NUMERIC EVENT CODES ARE CONFIGURABLE, not asserted. Zoom identifies
 *    signaling events by number; the mapping below is this repo's best record of
 *    it, and the one code we can corroborate from our own source is 7 = media
 *    server change (`zoom-protocol.ts` has reopened the media socket on it since
 *    before this feature). An operator who reads Zoom's current event reference
 *    can correct the rest with `zoomPresenceEventCodes` without a code change —
 *    see docs/zoom-setup.md. Events that arrive NAMED are decoded by name and
 *    ignore the table entirely.
 *
 * Neither path ever lets the hub claim a complete roster: see `roster.ts`.
 */

import type { PresenceEvent } from "../presence/roster.js";
import type { PortraitFrame } from "../presence/portraits.js";

/** Signaling message carrying an event update (`zoom-protocol.ts` msg_type 6). */
export const ZOOM_EVENT_MESSAGE = 6;
/** Signaling message asking Zoom to deliver a set of events. */
export const ZOOM_EVENT_SUBSCRIPTION = 5;

/** Ceiling on one base64 media payload, before decoding. */
const MAX_PORTRAIT_BASE64 = 400_000;

export interface ZoomPresenceCodes {
  readonly speaker: number;
  readonly join: number;
  readonly leave: number;
}

/**
 * The mapping this plugin ships with.
 *
 * Recorded, not proved — see the header. It is consistent with the only event
 * code we have independent evidence for (7, media server change), and it is
 * overridable per deployment.
 */
export const DEFAULT_ZOOM_PRESENCE_CODES: ZoomPresenceCodes = { speaker: 2, join: 3, leave: 4 };

/**
 * Read an operator override such as `speaker=2,join=3,leave=4`.
 *
 * Anything malformed falls back to the shipped table rather than throwing: a
 * typo in a setting must not be able to stop a plugin from loading, and the
 * worst case of the fallback is the behaviour the operator already had.
 */
export function parsePresenceCodes(value: string | null | undefined): ZoomPresenceCodes {
  if (typeof value !== "string" || value.trim() === "") return DEFAULT_ZOOM_PRESENCE_CODES;
  const codes: Record<string, number> = {};
  for (const part of value.split(",")) {
    const [rawKey, rawValue] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    const parsed = Number(rawValue?.trim());
    if (!key || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000) continue;
    codes[key] = parsed;
  }
  const speaker = codes.speaker ?? codes.active_speaker;
  const join = codes.join ?? codes.participant_join;
  const leave = codes.leave ?? codes.participant_leave;
  if (speaker === undefined || join === undefined || leave === undefined) return DEFAULT_ZOOM_PRESENCE_CODES;
  if (speaker === join || join === leave || speaker === leave) return DEFAULT_ZOOM_PRESENCE_CODES;
  return { speaker, join, leave };
}

/** The frame that asks for participant and active-speaker events. */
export function eventSubscriptionFrame(streamId: string, codes: ZoomPresenceCodes): unknown {
  return {
    msg_type: ZOOM_EVENT_SUBSCRIPTION,
    rtms_stream_id: streamId,
    events: [
      { event_type: codes.join, subscribe: true },
      { event_type: codes.leave, subscribe: true },
      { event_type: codes.speaker, subscribe: true },
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

type NamedKind = "join" | "leave" | "speaker";

/** A self-describing event needs no lookup table; prefer it when Zoom sends one. */
function namedKind(event: Row): NamedKind | null {
  const raw = event.event_name ?? (typeof event.event_type === "string" ? event.event_type : null);
  if (typeof raw !== "string") return null;
  const name = raw.trim().toUpperCase();
  if (name.includes("ACTIVE_SPEAKER")) return "speaker";
  if (name.includes("PARTICIPANT_JOIN")) return "join";
  if (name.includes("PARTICIPANT_LEAVE")) return "leave";
  return null;
}

function codedKind(event: Row, codes: ZoomPresenceCodes): NamedKind | null {
  const code = event.event_type;
  if (typeof code !== "number" || !Number.isSafeInteger(code)) return null;
  if (code === codes.speaker) return "speaker";
  if (code === codes.join) return "join";
  if (code === codes.leave) return "leave";
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
    else events.push({ kind: "speaking", participantId: id, name: participantName(subject), at });
  }
  // An active-speaker event names one person. Several would mean we misread the
  // message, and lighting up a row of rings is worse than lighting up none.
  if (kind === "speaker" && events.length > 1) return [];
  return events;
}

/**
 * Decode one video media message into a still.
 *
 * The participant id comes from the FRAME, never from the caller: a picture
 * filed under the wrong person is the only failure in this feature that
 * misinforms rather than merely missing. Size is bounded before the base64 is
 * decoded, so an oversized frame costs a length check rather than a buffer.
 *
 * Returns null for anything that is not a complete, identified, timestamped
 * image; the caller counts those refusals against the video failure budget and
 * carries on with transcript capture regardless.
 */
export function decodeZoomPortraitFrame(message: unknown): PortraitFrame | null {
  const row = asRow(message);
  if (!row) return null;
  const content = asRow(row.content);
  if (!content) return null;
  const id = participantId(content);
  if (id === null) return null;
  const data = content.data;
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_PORTRAIT_BASE64) return null;
  const capturedAt = content.timestamp;
  if (typeof capturedAt !== "number" || !Number.isSafeInteger(capturedAt) || capturedAt <= 0) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  return { participantId: id, capturedAt, bytes: new Uint8Array(bytes) };
}
