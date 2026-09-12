import { describe, expect, it, vi } from "vitest";
import type { SegmentInput } from "../src/domain.js";
import {
  ZoomRtmsSession,
  assertSafeZoomWssUrl,
  createPublicOnlyLookup,
  type RtmsSocket,
  type RtmsSocketFactory,
} from "../src/adapters/zoom-protocol.js";

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

  drop(code = 1006): void {
    this.handlers.close(code, "test drop");
  }
}

function controlledFactory() {
  const sockets: ControlledSocket[] = [];
  const factory: RtmsSocketFactory = (url, handlers) => {
    const socket = new ControlledSocket(url, handlers);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

describe("Zoom RTMS protocol", () => {
  it("authenticates signaling and media, requests transcript only, acknowledges readiness, and answers keep-alives", () => {
    const peer = controlledFactory();
    const session = new ZoomRtmsSession({
      meetingUuid: "meeting-uuid",
      streamId: "stream-id",
      signalingUrl: "wss://rtms.zoom.us/signal",
      clientId: "client-id",
      clientSecret: "client-secret",
      anchorMs: 1_700_000_000_000,
      socketFactory: peer.factory,
      onSegments: () => undefined,
      onState: () => undefined,
    });

    session.start();
    peer.sockets[0]!.open();
    expect(JSON.parse(peer.sockets[0]!.sent[0]!)).toMatchObject({
      msg_type: 1,
      protocol_version: 1,
      meeting_uuid: "meeting-uuid",
      rtms_stream_id: "stream-id",
      signature: "38b373591bf5feb9e070f4970d8e2a0ed55761e601aebadcfea29774ff4a7516",
    });

    peer.sockets[0]!.receive({
      msg_type: 2,
      status_code: 0,
      media_server: { server_urls: { transcript: "wss://rtms.zoom.us/transcript" } },
    });
    peer.sockets[1]!.open();
    expect(JSON.parse(peer.sockets[1]!.sent[0]!)).toMatchObject({
      msg_type: 3,
      protocol_version: 1,
      meeting_uuid: "meeting-uuid",
      rtms_stream_id: "stream-id",
      media_type: 8,
      media_params: { transcript: { content_type: 5 } },
    });

    peer.sockets[1]!.receive({ msg_type: 4, status_code: 0 });
    expect(JSON.parse(peer.sockets[0]!.sent.at(-1)!)).toEqual({
      msg_type: 7,
      rtms_stream_id: "stream-id",
    });

    peer.sockets[0]!.receive({ msg_type: 12, timestamp: 123 });
    peer.sockets[1]!.receive({ msg_type: 12, timestamp: 456 });
    expect(JSON.parse(peer.sockets[0]!.sent.at(-1)!)).toEqual({ msg_type: 13, timestamp: 123 });
    expect(JSON.parse(peer.sockets[1]!.sent.at(-1)!)).toEqual({ msg_type: 13, timestamp: 456 });
  });

  it("converts absolute Zoom transcript times to one capture-relative anchor and splits bounded segments", () => {
    const peer = controlledFactory();
    const received: SegmentInput[][] = [];
    const session = new ZoomRtmsSession({
      meetingUuid: "meeting-uuid",
      streamId: "stream-id",
      signalingUrl: "wss://rtms.zoom.us/signal",
      clientId: "client-id",
      clientSecret: "client-secret",
      anchorMs: 10_000,
      socketFactory: peer.factory,
      onSegments: (segments) => received.push(segments),
      onState: () => undefined,
    });

    session.start();
    peer.sockets[0]!.open();
    peer.sockets[0]!.receive({
      msg_type: 2,
      status_code: 0,
      media_server: { server_urls: { transcript: "wss://rtms.zoom.us/transcript" } },
    });
    peer.sockets[1]!.open();
    peer.sockets[1]!.receive({ msg_type: 4, status_code: 0 });
    peer.sockets[1]!.receive({
      msg_type: 17,
      content: {
        user_id: 42,
        user_name: "Ada",
        start_time: 12_500,
        end_time: 13_250,
        timestamp: 13_300,
        language: 9,
        data: `${"a".repeat(1_999)} ${"b".repeat(17)}`,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(received[0]![0]).toMatchObject({ speaker: "Ada", startMs: 2_500, endMs: 3_250 });
    expect(received[0]![0]!.text).toHaveLength(2_000);
    expect(received[0]![0]!.text.endsWith(" ")).toBe(true);
    expect(received[0]![1]!.text).toBe("b".repeat(17));
    expect(received[0]![0]!.sourceKey).toMatch(/^zoom:[a-f0-9]{64}:0$/);
    expect(received[0]![1]!.sourceKey).toMatch(/^zoom:[a-f0-9]{64}:1$/);
    expect(received[0]![0]!.sourceKey.length).toBeLessThanOrEqual(256);
  });

  it("surfaces an interrupted capture and performs only bounded retries after a signaling drop", () => {
    vi.useFakeTimers();
    try {
      const peer = controlledFactory();
      const states: string[] = [];
      const session = new ZoomRtmsSession({
        meetingUuid: "meeting-uuid",
        streamId: "stream-id",
        signalingUrl: "wss://rtms.zoom.us/signal",
        clientId: "client-id",
        clientSecret: "client-secret",
        anchorMs: 10_000,
        socketFactory: peer.factory,
        onSegments: () => undefined,
        onState: (state) => states.push(state),
      });

      session.start();
      peer.sockets[0]!.drop();
      expect(states.at(-1)).toBe("interrupted");
      for (const delay of [3_000, 6_000, 12_000, 24_000]) {
        vi.advanceTimersByTime(delay);
        peer.sockets.at(-1)!.drop();
      }
      vi.advanceTimersByTime(60_000);

      expect(peer.sockets).toHaveLength(5);
      expect(states.at(-1)).toBe("interrupted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes both sockets and reports stopped when stopped locally", () => {
    const peer = controlledFactory();
    const states: string[] = [];
    const session = new ZoomRtmsSession({
      meetingUuid: "meeting-uuid",
      streamId: "stream-id",
      signalingUrl: "wss://rtms.zoom.us/signal",
      clientId: "client-id",
      clientSecret: "client-secret",
      anchorMs: 10_000,
      socketFactory: peer.factory,
      onSegments: () => undefined,
      onState: (state) => states.push(state),
    });
    session.start();
    peer.sockets[0]!.open();
    peer.sockets[0]!.receive({
      msg_type: 2,
      status_code: 0,
      media_server: { server_urls: { transcript: "wss://rtms.zoom.us/transcript" } },
    });

    session.stop();

    expect(JSON.parse(peer.sockets[0]!.sent.at(-1)!)).toEqual({
      msg_type: 21,
      rtms_stream_id: "stream-id",
    });
    expect(peer.sockets.every((socket) => socket.closed)).toBe(true);
    expect(states.at(-1)).toBe("stopped");
  });
});

describe("Zoom RTMS destination validation", () => {
  it.each([
    "ws://rtms.zoom.us/signal",
    "wss://localhost/signal",
    "wss://127.0.0.1/signal",
    "wss://10.0.0.1/signal",
    "wss://[::1]/signal",
    "wss://user:password@rtms.zoom.us/signal",
    "wss://rtms.zoom.us:8443/signal",
  ])("rejects unsafe destination %s", (url) => {
    expect(() => assertSafeZoomWssUrl(url)).toThrow();
  });

  it("accepts a public TLS WebSocket destination on port 443", () => {
    expect(assertSafeZoomWssUrl("wss://rtms.zoom.us/transcript").href).toBe(
      "wss://rtms.zoom.us/transcript",
    );
  });
});

describe("Zoom RTMS DNS guard", () => {
  const answers = [
    { address: "10.0.0.5", family: 4 },
    { address: "203.0.113.7", family: 4 },
    { address: "198.51.100.9", family: 4 },
  ];
  const resolver = (
    _hostname: string,
    _options: { all: true } & Record<string, unknown>,
    callback: (error: NodeJS.ErrnoException | null, addresses: typeof answers) => void,
  ) => callback(null, answers);

  it("answers an all: true lookup with every public address", () => {
    // net asks for all addresses whenever autoSelectFamily is on, and reads
    // .address off each entry; a single string here fails the connection with
    // "Invalid IP address: undefined".
    const lookup = createPublicOnlyLookup(resolver);
    const received = vi.fn();
    lookup("rtms.zoom.us", { all: true, family: 0 }, received);
    expect(received).toHaveBeenCalledWith(null, [
      { address: "203.0.113.7", family: 4 },
      { address: "198.51.100.9", family: 4 },
    ]);
  });

  it("answers a single-address lookup with the first public address", () => {
    const lookup = createPublicOnlyLookup(resolver);
    const received = vi.fn();
    lookup("rtms.zoom.us", { family: 0 }, received);
    expect(received).toHaveBeenCalledWith(null, "203.0.113.7", 4);
  });

  it("fails when every answer is private", () => {
    const lookup = createPublicOnlyLookup((_hostname, _options, callback) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]),
    );
    const received = vi.fn();
    lookup("rtms.zoom.us", { all: true }, received);
    expect(received.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
