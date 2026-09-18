/**
 * The newest still we hold for a person in one sitting — and nothing else.
 *
 * Portraits are an OPTIONAL embellishment on presence. They exist only when a
 * deployment has configured video access for its own Zoom app; without it the
 * strip shows initials and nothing here is ever called. That asymmetry is
 * deliberate and enforced by the caller: video has its own byte limits and its
 * own failure budget, so a video feed that is missing, refused, or malformed can
 * never stop transcript capture.
 *
 * What this store is NOT:
 *
 * - not an archive. One image per participant per sitting, replaced in place,
 *   dropped when the sitting ends. Nothing reaches SQLite, the transcript, or
 *   the checkout, so a meeting leaves no pictures behind.
 * - not live video. What it holds is a still that WAS captured at a stated
 *   moment; the UI is required to say so rather than implying a camera feed.
 * - not trusting. Every frame is validated on the way in: real JPEG bytes,
 *   within the size limit, carrying its own participant id, with a timestamp
 *   that moves forward and sits inside a sane window, no faster than the
 *   throttle allows. Anything else is refused with a reason and no payload is
 *   ever logged.
 */

/** Refusals are named so the adapter can count them without inspecting bytes. */
export type PortraitRejection =
  | "empty"
  | "not-jpeg"
  | "too-large"
  | "unidentified"
  | "timestamp-out-of-window"
  | "not-newer"
  | "throttled"
  | "no-sitting";

export type PortraitResult =
  | { accepted: true; capturedAt: number; evicted: string[] }
  | { accepted: false; reason: PortraitRejection };

export interface PortraitFrame {
  /** The id the FRAME itself carries. The caller must not substitute its own. */
  readonly participantId: string;
  readonly capturedAt: number;
  readonly bytes: Uint8Array;
}

export interface PortraitImage {
  readonly capturedAt: number;
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg";
}

export interface PortraitStoreOptions {
  now(): number;
  /** One frame's ceiling. An SD still is tens of KB; this is generous. */
  maxBytes?: number;
  /** Minimum gap between accepted frames for one participant. */
  minIntervalMs?: number;
  /** How many participants may hold a still at once, per sitting. */
  maxParticipants?: number;
  /** How far a frame's own timestamp may sit from now, either way. */
  timestampWindowMs?: number;
  /** A still older than this is not served; the face falls back to initials. */
  maxAgeMs?: number;
  /** Rejections tolerated per sitting before the caller stops asking for video. */
  failureBudget?: number;
}

const JPEG_START = [0xff, 0xd8, 0xff];
const JPEG_END = [0xff, 0xd9];

interface Held {
  capturedAt: number;
  acceptedAt: number;
  bytes: Uint8Array;
}

export class PortraitStore {
  private readonly sittings = new Map<string, Map<string, Held>>();
  private readonly failures = new Map<string, number>();
  private readonly maxBytes: number;
  private readonly minIntervalMs: number;
  private readonly maxParticipants: number;
  private readonly timestampWindowMs: number;
  private readonly maxAgeMs: number;
  private readonly failureBudget: number;

  constructor(private readonly options: PortraitStoreOptions) {
    this.maxBytes = options.maxBytes ?? 256 * 1024;
    this.minIntervalMs = options.minIntervalMs ?? 1_000;
    this.maxParticipants = options.maxParticipants ?? 12;
    this.timestampWindowMs = options.timestampWindowMs ?? 120_000;
    this.maxAgeMs = options.maxAgeMs ?? 300_000;
    this.failureBudget = options.failureBudget ?? 32;
  }

  /** Open the store for a sitting. Any earlier stills for that key are dropped. */
  beginSitting(sittingKey: string): void {
    this.sittings.set(sittingKey, new Map());
    this.failures.delete(sittingKey);
  }

  /**
   * Take a frame, or say precisely why not.
   *
   * The identity used is the frame's own `participantId` — the caller cannot
   * pass a different one, because a still filed under the wrong person is the
   * one failure here that actively misinforms rather than merely missing.
   */
  accept(sittingKey: string, frame: PortraitFrame): PortraitResult {
    const held = this.sittings.get(sittingKey);
    if (!held) return this.refuse(sittingKey, "no-sitting");
    const participantId = frame.participantId.trim().slice(0, 200);
    if (!participantId) return this.refuse(sittingKey, "unidentified");
    if (frame.bytes.byteLength === 0) return this.refuse(sittingKey, "empty");
    if (frame.bytes.byteLength > this.maxBytes) return this.refuse(sittingKey, "too-large");
    if (!isJpeg(frame.bytes)) return this.refuse(sittingKey, "not-jpeg");
    const now = this.options.now();
    if (
      !Number.isSafeInteger(frame.capturedAt) ||
      Math.abs(now - frame.capturedAt) > this.timestampWindowMs
    ) {
      return this.refuse(sittingKey, "timestamp-out-of-window");
    }
    const existing = held.get(participantId);
    if (existing) {
      // Out-of-order delivery must not walk a face backwards in time, and a
      // repeat of a frame we already hold is not new information.
      if (frame.capturedAt <= existing.capturedAt) return this.refuse(sittingKey, "not-newer");
      if (now - existing.acceptedAt < this.minIntervalMs) return this.refuse(sittingKey, "throttled");
    }
    const evicted: string[] = [];
    held.set(participantId, { capturedAt: frame.capturedAt, acceptedAt: now, bytes: frame.bytes.slice() });
    while (held.size > this.maxParticipants) {
      // Oldest acceptance first: the faces on screen are the ones that just
      // spoke, so recency is the right thing to keep.
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of held) {
        if (value.acceptedAt < oldestAt) {
          oldestAt = value.acceptedAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) break;
      held.delete(oldestKey);
      evicted.push(oldestKey);
    }
    return { accepted: true, capturedAt: frame.capturedAt, evicted };
  }

  /** The still to serve, or null when there is none or it has gone stale. */
  get(sittingKey: string, participantId: string): PortraitImage | null {
    const image = this.sittings.get(sittingKey)?.get(participantId);
    if (!image) return null;
    if (this.options.now() - image.capturedAt > this.maxAgeMs) return null;
    return { capturedAt: image.capturedAt, bytes: image.bytes, mediaType: "image/jpeg" };
  }

  /** True once a sitting's video has failed often enough to stop asking. */
  exhausted(sittingKey: string): boolean {
    return (this.failures.get(sittingKey) ?? 0) >= this.failureBudget;
  }

  failureCount(sittingKey: string): number {
    return this.failures.get(sittingKey) ?? 0;
  }

  endSitting(sittingKey: string): void {
    this.sittings.delete(sittingKey);
    this.failures.delete(sittingKey);
  }

  clear(): void {
    this.sittings.clear();
    this.failures.clear();
  }

  private refuse(sittingKey: string, reason: PortraitRejection): PortraitResult {
    this.failures.set(sittingKey, (this.failures.get(sittingKey) ?? 0) + 1);
    return { accepted: false, reason };
  }
}

/** Real JPEG bytes, start to finish. A truncated frame is a malformed frame. */
export function isJpeg(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  for (let index = 0; index < JPEG_START.length; index += 1) {
    if (bytes[index] !== JPEG_START[index]) return false;
  }
  return (
    bytes[bytes.byteLength - 2] === JPEG_END[0] &&
    bytes[bytes.byteLength - 1] === JPEG_END[1]
  );
}
