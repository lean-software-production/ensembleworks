import { describe, expect, it } from "vitest";
import type { CaptureState } from "../src/domain.js";
import type { PresenceEvent } from "../src/presence/roster.js";
import type { PortraitFrame } from "../src/presence/portraits.js";
import {
  ZoomRtmsSession,
  type RtmsSocket,
  type RtmsSocketFactory,
  type ZoomPresenceOptions,
  type ZoomVideoOptions,
} from "../src/adapters/zoom-protocol.js";
import { DEFAULT_ZOOM_PRESENCE_CODES } from "../src/adapters/zoom-presence.js";

class ControlledSocket implements RtmsSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    private readonly handlers: {
      open(): void;
      message(data: string | Uint8Array): void;
      close(code: number, reason: string): void;
      error(error: Error): void;
    },
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.handlers.open();
  }

  receive(value: unknown): void {
    this.handlers.message(JSON.stringify(value));
  }
}

function jpegBase64(length = 64): string {
  const bytes = Buffer.alloc(length);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes[length - 2] = 0xff;
  bytes[length - 1] = 0xd9;
  return bytes.toString("base64");
}

function session(options: {
  presence?: ZoomPresenceOptions;
  video?: ZoomVideoOptions;
  videoUrl?: string | null;
} = {}) {
  const sockets: ControlledSocket[] = [];
  const states: { state: CaptureState; detail: string | null | undefined }[] = [];
  const factory: RtmsSocketFactory = (url, handlers) => {
    const socket = new ControlledSocket(url, handlers);
    sockets.push(socket);
    return socket;
  };
  const instance = new ZoomRtmsSession({
    meetingUuid: "meeting-uuid",
    streamId: "stream-id",
    signalingUrl: "wss://rtms.zoom.us/signal",
    clientId: "client-id",
    clientSecret: "client-secret",
    anchorMs: 1_000,
    socketFactory: factory,
    onSegments: () => undefined,
    onState: (state, detail) => states.push({ state, detail }),
    presence: options.presence,
    video: options.video,
  });

  /** Drive signaling + transcript up to "capturing". */
  const connect = (): void => {
    instance.start();
    sockets[0]!.open();
    const videoUrl = options.videoUrl === undefined ? "wss://rtms.zoom.us/video" : options.videoUrl;
    sockets[0]!.receive({
      msg_type: 2,
      status_code: 0,
      media_server: {
        server_urls: {
          transcript: "wss://rtms.zoom.us/transcript",
          ...(videoUrl === null ? {} : { video: videoUrl }),
        },
      },
    });
    sockets[1]!.open();
    sockets[1]!.receive({ msg_type: 4, status_code: 0 });
  };

  return { session: instance, sockets, states, connect };
}

const sentTypes = (socket: ControlledSocket): number[] =>
  socket.sent.map((raw) => (JSON.parse(raw) as { msg_type: number }).msg_type);

describe("Zoom RTMS presence wiring", () => {
  it("sends nothing new on the wire when presence is off", () => {
    const peer = session();
    peer.connect();

    // The default configuration is byte-for-byte the capture that shipped
    // before presence existed: handshake, then stream-ready. No subscription,
    // and no third socket.
    expect(sentTypes(peer.sockets[0]!)).toEqual([1, 7]);
    expect(peer.sockets).toHaveLength(2);
  });

  it("subscribes only after transcript capture is established", () => {
    const received: PresenceEvent[][] = [];
    const presence: ZoomPresenceOptions = {
      enabled: true,
      codes: DEFAULT_ZOOM_PRESENCE_CODES,
      onEvents: (events) => received.push(events),
    };
    const peer = session({ presence });
    peer.session.start();
    peer.sockets[0]!.open();
    peer.sockets[0]!.receive({
      msg_type: 2,
      status_code: 0,
      media_server: { server_urls: { transcript: "wss://rtms.zoom.us/transcript" } },
    });
    // Before the transcript handshake nothing has been asked for.
    expect(sentTypes(peer.sockets[0]!)).toEqual([1]);

    peer.sockets[1]!.open();
    peer.sockets[1]!.receive({ msg_type: 4, status_code: 0 });
    expect(sentTypes(peer.sockets[0]!)).toEqual([1, 7, 5]);

    peer.sockets[0]!.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 16778240, user_name: "Ada" },
    });
    expect(received).toEqual([[{ kind: "joined", participantId: "16778240", name: "Ada", at: expect.any(Number) }]]);
  });

  it("still reopens the media socket on a media-server change while presence is on", () => {
    const peer = session({
      presence: { enabled: true, codes: DEFAULT_ZOOM_PRESENCE_CODES, onEvents: () => undefined },
    });
    peer.connect();
    peer.sockets[0]!.receive({ msg_type: 6, event: { event_type: 7 } });

    // Presence decoding runs after the transcript path and cannot displace it:
    // the media socket is still closed and a retry still scheduled.
    expect(peer.sockets[1]!.closed).toBe(true);
    expect(peer.states.some((entry) => entry.detail === "Zoom transcript connection was interrupted")).toBe(true);
  });

  it("opens a video socket only when portraits are enabled, and decodes its frames", () => {
    const frames: PortraitFrame[] = [];
    const peer = session({
      video: {
        enabled: true,
        onFrame: (frame) => frames.push(frame),
        onUnavailable: () => undefined,
      },
    });
    peer.connect();

    expect(peer.sockets).toHaveLength(3);
    expect(peer.sockets[2]!.url).toBe("wss://rtms.zoom.us/video");
    peer.sockets[2]!.open();
    expect(JSON.parse(peer.sockets[2]!.sent[0]!)).toMatchObject({ msg_type: 3, media_type: 2 });

    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });
    peer.sockets[2]!.receive({ content: { user_id: 7, timestamp: 1_800_000_000_000, data: jpegBase64() } });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.participantId).toBe("7");
  });

  it("treats a refused video handshake as no portraits, not as a capture failure", () => {
    const reasons: string[] = [];
    const peer = session({
      video: { enabled: true, onFrame: () => undefined, onUnavailable: (detail) => reasons.push(detail) },
    });
    peer.connect();
    peer.sockets[2]!.open();
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 13 });

    expect(reasons).toEqual(["Zoom refused the video stream; portraits are unavailable"]);
    expect(peer.sockets[2]!.closed).toBe(true);
    // The capture's own state never learns about it: the last thing it was told
    // is that the transcript is flowing.
    expect(peer.states.at(-1)).toEqual({ state: "capturing", detail: "Receiving Zoom transcript" });
  });

  it("retires portraits when the meeting offers no video stream at all", () => {
    const reasons: string[] = [];
    const peer = session({
      videoUrl: null,
      video: { enabled: true, onFrame: () => undefined, onUnavailable: (detail) => reasons.push(detail) },
    });
    peer.connect();

    expect(peer.sockets).toHaveLength(2);
    expect(reasons).toEqual(["Zoom offered no video stream for this meeting"]);
    expect(peer.states.at(-1)).toEqual({ state: "capturing", detail: "Receiving Zoom transcript" });
  });

  it("refuses an unsafe video destination without touching the transcript", () => {
    const reasons: string[] = [];
    const peer = session({
      videoUrl: "ws://127.0.0.1:9/video",
      video: { enabled: true, onFrame: () => undefined, onUnavailable: (detail) => reasons.push(detail) },
    });
    peer.connect();

    expect(peer.sockets).toHaveLength(2);
    expect(reasons).toEqual(["Zoom supplied an unsafe video destination"]);
    expect(peer.states.at(-1)).toEqual({ state: "capturing", detail: "Receiving Zoom transcript" });
  });

  it("stops asking for video once the failure budget is spent", () => {
    const frames: PortraitFrame[] = [];
    const reasons: string[] = [];
    let allowed = true;
    const peer = session({
      video: {
        enabled: true,
        onFrame: (frame) => frames.push(frame),
        onUnavailable: (detail) => reasons.push(detail),
        shouldContinue: () => allowed,
      },
    });
    peer.connect();
    peer.sockets[2]!.open();
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });
    allowed = false;
    peer.sockets[2]!.receive({ content: { user_id: 7, timestamp: 1_800_000_000_000, data: jpegBase64() } });

    expect(frames).toHaveLength(0);
    expect(reasons).toEqual(["Too many unusable video frames; portraits are unavailable"]);
    expect(peer.states.at(-1)).toEqual({ state: "capturing", detail: "Receiving Zoom transcript" });
  });

  it("closes the video socket with the rest of the session", () => {
    const peer = session({
      video: { enabled: true, onFrame: () => undefined, onUnavailable: () => undefined },
    });
    peer.connect();
    peer.session.stop();
    expect(peer.sockets[2]!.closed).toBe(true);
  });
});
