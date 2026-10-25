import { describe, expect, it, vi } from "vitest";
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
import { DEFAULT_ZOOM_PRESENCE_CODES, ZOOM_VIDEO_MEDIA_PARAMS } from "../src/adapters/zoom-presence.js";
import { jpegBytes } from "./helpers/jpeg.js";

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

  /** The far end hanging up, as the transport would report it. */
  remoteClose(code = 1006, reason = "gone"): void {
    this.closed = true;
    this.handlers.close(code, reason);
  }
}

/** A video-data message in the shape Zoom documents (MEDIA_DATA_VIDEO = 15). */
function videoFrame(userId: number, timestamp = 1_800_000_000_000): unknown {
  const bytes = jpegBytes();
  return {
    msg_type: 15,
    content: {
      user_id: userId,
      timestamp,
      length: bytes.byteLength,
      data: Buffer.from(bytes).toString("base64"),
    },
  };
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
    presence: options.presence ?? (options.video?.enabled ? {
      enabled: true, codes: DEFAULT_ZOOM_PRESENCE_CODES, onEvents: () => undefined,
    } : undefined),
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

  it("reports presence unavailable when the subscription cannot be sent", () => {
    const unavailable: string[] = [];
    const peer = session({
      presence: {
        enabled: true,
        codes: DEFAULT_ZOOM_PRESENCE_CODES,
        onEvents: () => undefined,
        onUnavailable: (detail) => unavailable.push(detail),
      },
    });
    peer.session.start();
    const signaling = peer.sockets[0]!;
    signaling.open();
    signaling.receive({
      msg_type: 2,
      status_code: 0,
      media_server: { server_urls: { transcript: "wss://rtms.zoom.us/transcript" } },
    });
    const send = signaling.send.bind(signaling);
    signaling.send = (data: string) => {
      if ((JSON.parse(data) as { msg_type: number }).msg_type === 5) throw new Error("socket closed");
      send(data);
    };
    peer.sockets[1]!.open();
    peer.sockets[1]!.receive({ msg_type: 4, status_code: 0 });

    // The transcript is capturing and nothing about it changed — but no
    // participant event can arrive on a subscription Zoom never received, so
    // presence has to say so rather than ride capture's state.
    expect(unavailable).toEqual(["Zoom did not accept the participant-event subscription"]);
    expect(peer.states.at(-1)).toEqual({ state: "capturing", detail: "Receiving Zoom transcript" });
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
    // The whole outgoing handshake, locked to Zoom's published contract.
    expect(JSON.parse(peer.sockets[2]!.sent[0]!)).toEqual({
      msg_type: 3,
      protocol_version: 1,
      sequence: expect.any(Number),
      meeting_uuid: "meeting-uuid",
      rtms_stream_id: "stream-id",
      signature: expect.any(String),
      ...ZOOM_VIDEO_MEDIA_PARAMS,
      payload_encryption: false,
    });

    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });
    // Unsolicited frames are ignored until an observed speaker is selected.
    peer.sockets[2]!.receive(videoFrame(7));
    expect(frames).toHaveLength(0);
    peer.sockets[0]!.receive({ msg_type: 6, event: { event_type: 2, user_id: 7 } });
    expect(JSON.parse(peer.sockets[0]!.sent.at(-1)!)).toMatchObject({ msg_type: 28, user_id: 7, subscribe: true });
    peer.sockets[2]!.receive(videoFrame(8));
    expect(frames).toHaveLength(0);
    peer.sockets[2]!.receive(videoFrame(7));
    expect(JSON.parse(peer.sockets[0]!.sent.at(-1)!)).toMatchObject({ msg_type: 28, user_id: 7, subscribe: false });
    peer.sockets[2]!.receive(videoFrame(7));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.participantId).toBe("7");
  });

  it("acknowledges readiness for the video media connection, as the wire requires", () => {
    const peer = session({
      video: { enabled: true, onFrame: () => undefined, onUnavailable: () => undefined },
    });
    peer.connect();
    const signaling = peer.sockets[0]!;
    // One ACK so far: the one for the transcript media connection.
    expect(sentTypes(signaling).filter((type) => type === 7)).toEqual([7]);

    peer.sockets[2]!.open();
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });

    // Zoom documents CLIENT_READY_ACK as the answer to a data handshake
    // response FROM A MEDIA CONNECTION — "it needs to send a client ready ack
    // to the signaling connection … ready to receive media data"
    // (developers.zoom.us/docs/rtms/event-reference/, Client ready ACK
    // message). The video socket is a second media connection, so its
    // handshake needs its own acknowledgement or Zoom sends no video data.
    expect(sentTypes(signaling).filter((type) => type === 7)).toEqual([7, 7]);
    expect(JSON.parse(signaling.sent.at(-1)!)).toEqual({ msg_type: 7, rtms_stream_id: "stream-id" });
  });

  it("acknowledges the video connection once, and never one Zoom refused", () => {
    const peer = session({
      video: { enabled: true, onFrame: () => undefined, onUnavailable: () => undefined },
    });
    peer.connect();
    const signaling = peer.sockets[0]!;
    peer.sockets[2]!.open();
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });
    // A repeated handshake response is not a second connection to be ready for.
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });
    expect(sentTypes(signaling).filter((type) => type === 7)).toEqual([7, 7]);

    const refused = session({
      video: { enabled: true, onFrame: () => undefined, onUnavailable: () => undefined },
    });
    refused.connect();
    refused.sockets[2]!.open();
    refused.sockets[2]!.receive({ msg_type: 4, status_code: 13 });
    expect(sentTypes(refused.sockets[0]!).filter((type) => type === 7)).toEqual([7]);
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
    peer.sockets[2]!.receive(videoFrame(7));

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

  it("tears the video socket down with the signaling generation that owns it", () => {
    vi.useFakeTimers();
    try {
      reconnectVideo();
    } finally {
      vi.useRealTimers();
    }
  });

  function reconnectVideo(): void {
    const frames: PortraitFrame[] = [];
    const peer = session({
      video: { enabled: true, onFrame: (frame) => frames.push(frame), onUnavailable: () => undefined },
    });
    peer.connect();
    const first = peer.sockets[2]!;
    first.open();
    first.receive({ msg_type: 4, status_code: 0 });

    // Zoom drops signaling. The video socket belongs to that generation: it has
    // to go with it, or the reconnect finds `this.video` still set and never
    // opens a replacement.
    peer.sockets[0]!.remoteClose();
    expect(first.closed).toBe(true);

    // A frame from the superseded socket is not evidence about the new session.
    first.receive(videoFrame(7));
    expect(frames).toHaveLength(0);

    // The scheduled reconnect opens a new signaling generation.
    vi.advanceTimersByTime(3_000);
    const signaling = peer.sockets.at(-1)!;
    signaling.open();
    signaling.receive({
      msg_type: 2,
      status_code: 0,
      media_server: {
        server_urls: { transcript: "wss://rtms.zoom.us/transcript", video: "wss://rtms.zoom.us/video" },
      },
    });
    const media = peer.sockets.at(-1)!;
    media.open();
    media.receive({ msg_type: 4, status_code: 0 });
    const second = peer.sockets.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.url).toBe("wss://rtms.zoom.us/video");

    second.open();
    second.receive({ msg_type: 4, status_code: 0 });
    signaling.receive({ msg_type: 6, event: { event_type: 2, user_id: 9 } });
    second.receive(videoFrame(9));
    expect(frames.map((frame) => frame.participantId)).toEqual(["9"]);
  }

  it("counts an unusable video frame against the video budget", () => {
    const frames: PortraitFrame[] = [];
    let unusable = 0;
    const peer = session({
      video: {
        enabled: true,
        onFrame: (frame) => frames.push(frame),
        onUnavailable: () => undefined,
        onUnusableFrame: () => { unusable += 1; },
      },
    });
    peer.connect();
    peer.sockets[2]!.open();
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });

    // Every shape of unusable media frame: no id, a broken payload, no
    // timestamp, and a payload that disagrees with its own declared length.
    peer.sockets[2]!.receive({ msg_type: 15, content: { timestamp: 1_800_000_000_000, data: "////" } });
    peer.sockets[2]!.receive({ msg_type: 15, content: { user_id: 7, timestamp: 1_800_000_000_000, data: "!!!!" } });
    peer.sockets[2]!.receive({ msg_type: 15, content: { user_id: 7, data: "////" } });
    peer.sockets[2]!.receive({
      msg_type: 15,
      content: { user_id: 7, timestamp: 1_800_000_000_000, data: "////", length: 999 },
    });

    expect(frames).toHaveLength(0);
    expect(unusable).toBe(4);
    // Transcript capture is untouched by any of it.
    expect(peer.states.at(-1)).toEqual({ state: "capturing", detail: "Receiving Zoom transcript" });
  });

  it("does not count the frames it is not supposed to be reading", () => {
    let unusable = 0;
    const peer = session({
      video: {
        enabled: true,
        onFrame: () => undefined,
        onUnavailable: () => undefined,
        onUnusableFrame: () => { unusable += 1; },
      },
    });
    peer.connect();
    peer.sockets[2]!.open();
    peer.sockets[2]!.receive({ msg_type: 4, status_code: 0 });
    // A keep-alive and a message type this socket never asked for are not
    // failures of the video feed, and must not spend its budget.
    peer.sockets[2]!.receive({ msg_type: 12, timestamp: 1 });
    peer.sockets[2]!.receive({ msg_type: 17, content: { data: "hello" } });
    expect(unusable).toBe(0);
  });
});
