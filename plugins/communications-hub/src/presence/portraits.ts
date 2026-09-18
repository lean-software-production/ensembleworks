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
  | "no-sitting"
  /** A video frame the adapter could not decode, so the store never saw it. */
  | "malformed-frame";

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

  /**
   * Count a failure for a frame that never reached `accept`.
   *
   * The adapter refuses malformed frames before they can become a
   * `PortraitFrame` at all — wrong message type, broken base64, a payload that
   * disagrees with its own declared length. Those are failures of the same feed
   * and spend the same budget; without this a stream of unreadable frames would
   * look exactly like a quiet meeting and the feed would never retire.
   */
  countFailure(sittingKey: string, reason: PortraitRejection): PortraitResult {
    return this.refuse(sittingKey, reason);
  }

  /**
   * Drop a sitting's images while the sitting itself continues.
   *
   * Used when video retires mid-meeting: presence carries on from the signaling
   * events, but the pictures must not outlive the feed that produced them.
   */
  dropImages(sittingKey: string): void {
    this.sittings.get(sittingKey)?.clear();
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

/**
 * The frame header (SOFn) a JPEG has to carry before its scan, read strictly.
 *
 * ITU-T T.81 §B.2.2: `Lf P Y X Nf` then `Nf` three-byte component
 * specifications, so the segment is exactly `8 + 3 × Nf` bytes long. A segment
 * whose declared length merely *fits in the buffer* proves nothing — `ff c0 00
 * 02` is a legal length and an impossible frame. Returns the component ids the
 * scan is allowed to name, or null when the header cannot describe an image.
 */
function frameComponents(bytes: Uint8Array, at: number, length: number): Set<number> | null {
  if (length < 8) return null;
  const precision = bytes[at + 2]!;
  const height = (bytes[at + 3]! << 8) | bytes[at + 4]!;
  const width = (bytes[at + 5]! << 8) | bytes[at + 6]!;
  const count = bytes[at + 7]!;
  // 8-bit is baseline; 12 and 16 appear in the extended and lossless modes.
  if (precision !== 8 && precision !== 12 && precision !== 16) return null;
  if (width === 0 || height === 0) return null;
  if (count < 1 || count > 4) return null;
  if (length !== 8 + 3 * count) return null;
  const components = new Set<number>();
  for (let index = 0; index < count; index += 1) components.add(bytes[at + 8 + index * 3]!);
  return components;
}

/**
 * The scan header (SOS), read against the frame it belongs to.
 *
 * ITU-T T.81 §B.2.3: `Ls Ns` then `Ns` two-byte component selectors and three
 * trailing bytes, so the segment is exactly `6 + 2 × Ns` long and every
 * selector has to name a component the frame declared. A scan that selects
 * nothing, or selects a component that does not exist, cannot be decoded.
 */
function scanIsCoherent(bytes: Uint8Array, at: number, length: number, components: Set<number>): boolean {
  if (length < 6) return false;
  const count = bytes[at + 2]!;
  if (count < 1 || count > 4) return false;
  if (length !== 6 + 2 * count) return false;
  for (let index = 0; index < count; index += 1) {
    if (!components.has(bytes[at + 3 + index * 2]!)) return false;
  }
  return true;
}

/**
 * A JPEG, judged by its structure rather than by its first and last few bytes.
 *
 * Boundary markers are trivially forgeable — `ff d8 ff e0 … ff d9` is six bytes
 * of nothing that used to pass — and this store's whole job is to be the thing
 * that will not serve a picture it cannot vouch for. So the marker segments are
 * walked from SOI, and each one has to be internally coherent, not merely
 * well-sized: the frame header has to declare a real size and between one and
 * four components in a segment of exactly the matching length, the scan has to
 * select components that frame declared, and entropy-coded data has to actually
 * follow the scan before the closing EOI. `ff d8 ff c0 00 02 ff da 00 02 ff d9`
 * — an empty frame and an empty scan, every length legal — is the payload that
 * made those checks necessary and is kept as a fixture.
 *
 * This is a validation, not a decode. It proves the bytes are laid out as a
 * JPEG, describe an image, and are not truncated; it does not prove the
 * entropy-coded data decodes to a picture, which would need a decoder this
 * plugin has no business carrying. What it rules out is everything the feed can
 * plausibly get wrong: garbage, a truncated frame, another format, or somebody
 * else's bytes in a JPEG-shaped wrapper.
 */
export function isJpeg(bytes: Uint8Array): boolean {
  const end = bytes.byteLength;
  if (end < 4) return false;
  if (bytes[0] !== JPEG_START[0] || bytes[1] !== JPEG_START[1]) return false;
  if (bytes[end - 2] !== JPEG_END[0] || bytes[end - 1] !== JPEG_END[1]) return false;
  let index = 2;
  let components: Set<number> | null = null;
  while (index + 1 < end) {
    if (bytes[index] !== 0xff) return false;
    let marker = bytes[index + 1]!;
    // 0xff may be repeated as fill before a marker.
    while (marker === 0xff && index + 2 < end) {
      index += 1;
      marker = bytes[index + 1]!;
    }
    index += 2;
    // Standalone markers: no length field follows.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8 || marker === 0xd9) return false;
    if (index + 1 >= end) return false;
    const length = (bytes[index]! << 8) | bytes[index + 1]!;
    if (length < 2 || index + length > end) return false;
    // SOFn — the frame header. 0xc4 (DHT), 0xc8 (JPG) and 0xcc (DAC) share the
    // range without being frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const declared = frameComponents(bytes, index, length);
      if (declared === null) return false;
      components = components ?? declared;
    }
    if (marker === 0xda) {
      if (components === null) return false;
      if (!scanIsCoherent(bytes, index, length, components)) return false;
      // Entropy-coded data runs from the end of the scan header to the EOI
      // already checked above. An image that stops there has no picture in it.
      return index + length < end - 2;
    }
    index += length;
  }
  return false;
}
