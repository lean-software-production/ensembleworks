// Run: npx vitest run tests/av-session.test.ts
//
// ONE ROOM, TWO BUTTONS. The canvas page title bar has "Join audio"
// (canvas/roster-ui.tsx) and the floating dock (canvas/dock/dock.ts) has its
// own. They are two controls over ONE LiveKit session, and the thing that must
// never happen is two peer connections into the same room from one tab — the
// SFU would show the user twice, echo their own mic back, and neither button
// would be able to hang the other one up.
//
// Two levels are exercised here:
//   * createSharedAvSession — the pure state machine, driven with fakes.
//   * joinAudio/leaveAudio  — the real av-room.ts singleton over a fake
//     livekit-client, which is where the race actually lives.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedAvSession } from "../canvas/av-session.js";
import type { AvTokenResult } from "../canvas/av.js";

// ---------------------------------------------------------------------------
// A livekit-client stand-in. Counts constructions, and lets a test hold the
// connect() promise open so a second join lands squarely in the gap.
// ---------------------------------------------------------------------------

class FakeRoom {
  static created = 0;
  static instances: FakeRoom[] = [];
  /** While true, every connect() parks until `releaseAll()`. */
  static hold = false;
  /** One resolver per parked connect() — so a stray SECOND connection parks
   * too and is visible rather than deadlocking the test. */
  static pending: Array<() => void> = [];
  /** When set, connect() rejects with it. */
  static connectError: Error | null = null;

  static releaseAll(): void {
    for (const resolve of FakeRoom.pending.splice(0)) resolve();
  }

  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly localParticipant = {
    identity: "alice",
    setMicrophoneEnabled: vi.fn(async () => {}),
    setCameraEnabled: vi.fn(async () => {}),
  };
  connected = false;
  disconnectCalls = 0;

  constructor() {
    FakeRoom.created += 1;
    FakeRoom.instances.push(this);
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async connect(): Promise<void> {
    if (FakeRoom.hold) {
      await new Promise<void>((resolve) => {
        FakeRoom.pending.push(resolve);
      });
    }
    if (FakeRoom.connectError !== null) throw FakeRoom.connectError;
    this.connected = true;
  }

  async startAudio(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
    this.emit("disconnected");
  }
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    LocalTrackPublished: "localTrackPublished",
    LocalTrackUnpublished: "localTrackUnpublished",
    ParticipantDisconnected: "participantDisconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    Disconnected: "disconnected",
  },
  Track: {
    Kind: { Audio: "audio", Video: "video" },
    Source: { Camera: "camera", Microphone: "microphone" },
  },
}));

// Imported AFTER the mock is declared; vi.mock is hoisted, so av-room.ts sees
// FakeRoom rather than the real browser SDK.
const { joinAudio, leaveAudio } = await import("../canvas/av-room.js");
const { canvasBus } = await import("../canvas/panel-bus.js");

const TOKEN: AvTokenResult = {
  ok: true,
  url: "wss://livekit.example.test",
  token: "fake.jwt.token",
  room: "bb-spike",
  identity: "alice",
};

const fetchToken = async (): Promise<AvTokenResult> => TOKEN;

beforeEach(() => {
  FakeRoom.created = 0;
  FakeRoom.instances = [];
  FakeRoom.hold = false;
  FakeRoom.pending = [];
  FakeRoom.connectError = null;
});

afterEach(async () => {
  // av-room.ts is a module singleton, so a room left connected by one test is
  // still connected in the next one.
  FakeRoom.hold = false;
  FakeRoom.releaseAll();
  await leaveAudio();
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe("createSharedAvSession", () => {
  it("runs connect once when two controls join at the same moment", async () => {
    const phases: string[] = [];
    const session = createSharedAvSession({
      onPhase: (phase) => phases.push(phase),
    });
    let connects = 0;
    let release: (() => void) | null = null;
    const connect = async () => {
      connects += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true as const };
    };

    const first = session.join(connect);
    const second = session.join(connect);
    expect(session.phase()).toBe("connecting");
    release!();

    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(connects).toBe(1);
    expect(session.phase()).toBe("live");
    expect(phases).toEqual(["connecting", "live"]);
  });

  it("does not reconnect when a control joins a session that is already live", async () => {
    const session = createSharedAvSession({});
    let connects = 0;
    await session.join(async () => {
      connects += 1;
      return { ok: true as const };
    });

    expect(await session.join(async () => {
      connects += 1;
      return { ok: true as const };
    })).toEqual({ ok: true });
    expect(connects).toBe(1);
  });

  it("returns to off after a failed connect so the next click can retry", async () => {
    const session = createSharedAvSession({});
    const failure = {
      ok: false as const,
      reason: "failed" as const,
      detail: "boom",
    };

    expect(await session.join(async () => failure)).toEqual(failure);
    expect(session.phase()).toBe("off");

    let retried = false;
    await session.join(async () => {
      retried = true;
      return { ok: true as const };
    });
    expect(retried).toBe(true);
    expect(session.phase()).toBe("live");
  });

  it("turns a thrown connect into a failed outcome rather than an unhandled rejection", async () => {
    const session = createSharedAvSession({});
    const outcome = await session.join(async () => {
      throw new Error("no route to host");
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "failed",
      detail: "no route to host",
    });
    expect(session.phase()).toBe("off");
  });

  it("lets a leave that lands mid-connect win over the join it interrupted", async () => {
    // The user clicks Join, changes their mind, clicks Leave. The connect is
    // still in flight; when it lands it must NOT flip the session to live and
    // strand a connection nothing is holding.
    const session = createSharedAvSession({});
    let release: (() => void) | null = null;
    const joining = session.join(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true as const };
    });

    let disconnects = 0;
    await session.leave(async () => {
      disconnects += 1;
    });
    expect(session.phase()).toBe("off");

    release!();
    await joining;
    expect(session.phase()).toBe("off");
    // The abandoned connection is torn down by whoever owns it — the machine's
    // job is only to refuse to call it live.
    expect(disconnects).toBe(1);
  });

  it("does not call disconnect when nothing is connected", async () => {
    const session = createSharedAvSession({});
    let disconnects = 0;
    await session.leave(async () => {
      disconnects += 1;
    });
    expect(disconnects).toBe(0);
  });

  it("drops to off when the server hangs up", async () => {
    const session = createSharedAvSession({});
    await session.join(async () => ({ ok: true as const }));
    session.reset();
    expect(session.phase()).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// The real singleton
// ---------------------------------------------------------------------------

describe("joinAudio", () => {
  it("opens ONE LiveKit connection when the header and the dock both join", async () => {
    // The exact two-button race: both controls call joinAudio while the token
    // fetch of the first is still in flight.
    FakeRoom.hold = true;
    const both = Promise.all([joinAudio(fetchToken), joinAudio(fetchToken)]);
    await vi.waitFor(() => expect(FakeRoom.pending.length).toBeGreaterThan(0));
    // Give a second (wrong) connect every chance to arrive before releasing,
    // so the assertion below fails loudly rather than hanging.
    await new Promise((resolve) => setTimeout(resolve, 20));
    FakeRoom.releaseAll();

    const [first, second] = await both;
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(FakeRoom.created).toBe(1);
    expect(canvasBus.snapshot().av.status).toBe("live");
  });

  it("is a no-op once live, so a second Join button cannot reconnect", async () => {
    await joinAudio(fetchToken);
    expect(await joinAudio(fetchToken)).toEqual({ ok: true });
    expect(FakeRoom.created).toBe(1);
  });

  it("reconnects after a leave", async () => {
    await joinAudio(fetchToken);
    await leaveAudio();
    expect(canvasBus.snapshot().av.status).toBe("off");
    await joinAudio(fetchToken);
    expect(FakeRoom.created).toBe(2);
  });

  it("throws away a connection that lands after the user already left", async () => {
    // Join, change your mind, leave — and only THEN does the handshake finish.
    // The half-open room belongs to nobody at that point: if it is allowed to
    // become the session, the user is in a call they cancelled, and the only
    // reference to it is a module-local variable no button is watching.
    FakeRoom.hold = true;
    const joining = joinAudio(fetchToken);
    await vi.waitFor(() => expect(FakeRoom.pending.length).toBe(1));

    await leaveAudio();
    FakeRoom.releaseAll();

    expect((await joining).ok).toBe(false);
    expect(canvasBus.snapshot().av.status).toBe("off");
    expect(FakeRoom.instances[0]!.disconnectCalls).toBeGreaterThan(0);
  });

  it("reports the unconfigured case without opening a connection", async () => {
    const outcome = await joinAudio(async () => ({
      ok: false as const,
      error: "not_configured" as const,
      detail: "set livekitUrl…",
    }));
    expect(outcome).toEqual({
      ok: false,
      reason: "not_configured",
      detail: "set livekitUrl…",
    });
    expect(FakeRoom.created).toBe(0);
    expect(canvasBus.snapshot().av.status).toBe("off");
  });
});
