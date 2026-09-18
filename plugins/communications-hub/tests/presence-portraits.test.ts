import { describe, expect, it } from "vitest";
import { PortraitStore, isJpeg } from "../src/presence/portraits.js";

const NOW = 1_800_000_000_000;

/** A byte-valid JPEG of the requested length: SOI … EOI. */
function jpeg(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes[length - 2] = 0xff;
  bytes[length - 1] = 0xd9;
  return bytes;
}

function store(overrides: Partial<ConstructorParameters<typeof PortraitStore>[0]> = {}) {
  let clock = NOW;
  const instance = new PortraitStore({
    now: () => clock,
    maxBytes: 1_024,
    minIntervalMs: 1_000,
    maxParticipants: 2,
    ...overrides,
  });
  return {
    store: instance,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      return clock;
    },
  };
}

describe("portrait store", () => {
  it("takes one still per participant and replaces it in place", () => {
    const { store: portraits, now, advance } = store();
    portraits.beginSitting("sitting-1");

    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() }))
      .toMatchObject({ accepted: true });
    advance(1_500);
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg(80) }))
      .toMatchObject({ accepted: true });

    const held = portraits.get("sitting-1", "1");
    expect(held?.bytes.byteLength).toBe(80);
    expect(held?.mediaType).toBe("image/jpeg");
  });

  it("refuses anything that is not a complete JPEG within the size limit", () => {
    const { store: portraits, now } = store();
    portraits.beginSitting("sitting-1");
    const truncated = jpeg();
    truncated[truncated.length - 1] = 0x00;

    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: new Uint8Array() }))
      .toEqual({ accepted: false, reason: "empty" });
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg(2_048) }))
      .toEqual({ accepted: false, reason: "too-large" });
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: truncated }))
      .toEqual({ accepted: false, reason: "not-jpeg" });
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: new Uint8Array([1, 2, 3, 4]) }))
      .toEqual({ accepted: false, reason: "not-jpeg" });
    expect(portraits.get("sitting-1", "1")).toBeNull();
  });

  it("refuses a frame that does not identify itself", () => {
    const { store: portraits, now } = store();
    portraits.beginSitting("sitting-1");
    expect(portraits.accept("sitting-1", { participantId: "   ", capturedAt: now(), bytes: jpeg() }))
      .toEqual({ accepted: false, reason: "unidentified" });
  });

  it("refuses timestamps outside a sane window, and stale replays", () => {
    const { store: portraits, now, advance } = store({ timestampWindowMs: 10_000 });
    portraits.beginSitting("sitting-1");
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now() - 60_000, bytes: jpeg() }))
      .toEqual({ accepted: false, reason: "timestamp-out-of-window" });
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now() + 60_000, bytes: jpeg() }))
      .toEqual({ accepted: false, reason: "timestamp-out-of-window" });

    const first = now();
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: first, bytes: jpeg() }))
      .toMatchObject({ accepted: true });
    advance(2_000);
    // An out-of-order frame must not walk a face backwards in time.
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: first - 1, bytes: jpeg(70) }))
      .toEqual({ accepted: false, reason: "not-newer" });
    expect(portraits.get("sitting-1", "1")?.capturedAt).toBe(first);
  });

  it("throttles a participant sending faster than the minimum interval", () => {
    const { store: portraits, now, advance } = store();
    portraits.beginSitting("sitting-1");
    portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() });
    advance(100);
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg(70) }))
      .toEqual({ accepted: false, reason: "throttled" });
    advance(1_000);
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg(70) }))
      .toMatchObject({ accepted: true });
  });

  it("evicts the least recently accepted face when the sitting is full", () => {
    const { store: portraits, now, advance } = store();
    portraits.beginSitting("sitting-1");
    portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() });
    advance(10);
    portraits.accept("sitting-1", { participantId: "2", capturedAt: now(), bytes: jpeg() });
    advance(10);
    const result = portraits.accept("sitting-1", { participantId: "3", capturedAt: now(), bytes: jpeg() });

    expect(result).toMatchObject({ accepted: true, evicted: ["1"] });
    expect(portraits.get("sitting-1", "1")).toBeNull();
    expect(portraits.get("sitting-1", "3")).not.toBeNull();
  });

  it("stops serving a still once it has gone stale", () => {
    const { store: portraits, now, advance } = store({ maxAgeMs: 5_000 });
    portraits.beginSitting("sitting-1");
    portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() });
    advance(5_001);
    expect(portraits.get("sitting-1", "1")).toBeNull();
  });

  it("holds nothing for a sitting that never began, or that has ended", () => {
    const { store: portraits, now } = store();
    expect(portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() }))
      .toEqual({ accepted: false, reason: "no-sitting" });

    portraits.beginSitting("sitting-1");
    portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() });
    portraits.endSitting("sitting-1");
    // The meeting is over: the pictures go with it, here and everywhere else.
    expect(portraits.get("sitting-1", "1")).toBeNull();
  });

  it("counts refusals against a budget so a broken video feed can be dropped", () => {
    const { store: portraits, now } = store({ failureBudget: 3 });
    portraits.beginSitting("sitting-1");
    for (let index = 0; index < 3; index += 1) {
      portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: new Uint8Array([0, 1]) });
    }
    expect(portraits.failureCount("sitting-1")).toBe(3);
    expect(portraits.exhausted("sitting-1")).toBe(true);
    // The budget is per sitting, and it is the VIDEO budget: nothing here can
    // reach transcript capture.
    expect(portraits.exhausted("sitting-2")).toBe(false);
  });

  it("copies the bytes it accepts, so a reused buffer cannot rewrite a stored face", () => {
    const { store: portraits, now } = store();
    portraits.beginSitting("sitting-1");
    const buffer = jpeg();
    portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: buffer });
    buffer[4] = 0x7f;
    expect(portraits.get("sitting-1", "1")?.bytes[4]).toBe(0);
  });

  it("clears every sitting on teardown", () => {
    const { store: portraits, now } = store();
    portraits.beginSitting("sitting-1");
    portraits.accept("sitting-1", { participantId: "1", capturedAt: now(), bytes: jpeg() });
    portraits.clear();
    expect(portraits.get("sitting-1", "1")).toBeNull();
  });
});

describe("jpeg detection", () => {
  it("accepts a complete image and rejects the rest", () => {
    expect(isJpeg(jpeg())).toBe(true);
    expect(isJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd9]))).toBe(false);
  });
});
