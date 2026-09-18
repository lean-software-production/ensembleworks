import { createHmac } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { CaptureState, Registrant, Room, SegmentInput, TranscriptSink } from "../src/domain.js";
import { registerZoomWithDependencies, type ZoomAdapterDependencies } from "../src/adapters/zoom.js";
import type { RtmsSocket } from "../src/adapters/zoom-protocol.js";
import { DEFAULT_ZOOM_PRESENCE_CODES } from "../src/adapters/zoom-presence.js";
import { PresenceService, type SittingPresence } from "../src/presence/service.js";
import { buildPresenceView } from "../src/presence/view.js";
import { popoverModel, rowModel } from "../src/presence/ui/model.js";

const SECRET = "webhook-secret";
const NOW_MS = 1_800_000_000_000;
const MEETING_ID = "88800011122";

/** The smallest sink a capture needs, with one room already created by BB. */
class RoomSink implements TranscriptSink {
  readonly states: { conversationId: string; state: CaptureState }[] = [];
  readonly room: Room = {
    id: "room-1",
    name: "Team room",
    sourceId: "zoom",
    externalId: MEETING_ID,
    joinUrl: "https://zoom.us/j/88800011122",
    hostUser: "host@example.com",
    createdAt: NOW_MS,
    archivedAt: null,
    expiresAt: null,
    sourceDeletedAt: null,
  };

  ensureConversation(_sourceId: string, externalId: string): { id: string } {
    return { id: `conversation-${externalId}` };
  }

  appendSegments(_conversationId: string, _segments: SegmentInput[]): void {}
  setCapture(conversationId: string, state: CaptureState): void {
    this.states.push({ conversationId, state });
  }
  findRoom(sourceId: string, externalId: string): Room | null {
    return sourceId === "zoom" && externalId === this.room.externalId ? this.room : null;
  }
  getRoom(): Room {
    return this.room;
  }
  createRoom(): Room {
    return this.room;
  }
  setRoomExpiry(): Room {
    return this.room;
  }
  markRoomDeleted(): Room {
    return this.room;
  }
  createRegistrant(): Registrant {
    throw new Error("not used");
  }
  setConversationRoom(): void {}
  renameIfUnchanged(): void {}
}

class ControlledSocket implements RtmsSocket {
  readonly sent: string[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly handlers: {
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

  receive(value: unknown): void {
    this.handlers.message(JSON.stringify(value));
  }
}

function signed(body: string): RequestInit {
  const timestamp = String(NOW_MS / 1_000);
  const digest = createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex");
  return {
    headers: {
      "content-type": "application/json",
      "x-zm-request-timestamp": timestamp,
      "x-zm-signature": `v0=${digest}`,
    },
    body,
  };
}

const startedBody = (uuid = "occurrence-1", stream = "stream-1") => JSON.stringify({
  event: "meeting.rtms_started",
  event_ts: NOW_MS,
  payload: {
    meeting_uuid: uuid,
    meeting_id: MEETING_ID,
    is_original_host: true,
    rtms_stream_id: stream,
    server_urls: "wss://rtms.zoom.us/signal",
  },
});

const stoppedBody = (uuid = "occurrence-1", stream = "stream-1") => JSON.stringify({
  event: "meeting.rtms_stopped",
  event_ts: NOW_MS,
  payload: { meeting_uuid: uuid, rtms_stream_id: stream, stop_reason: 6 },
});

async function setup(settings: Record<string, string | boolean> = {}) {
  const sockets: ControlledSocket[] = [];
  const host = createFakePluginHost({
    settings: {
      zoomClientId: "client-id",
      zoomClientSecret: "client-secret",
      zoomWebhookSecret: SECRET,
      zoomEnabled: true,
      zoomPresenceEnabled: true,
      ...settings,
    },
  });
  const dependencies: ZoomAdapterDependencies = {
    fetch: () => Promise.reject(new Error("no HTTP in presence tests")),
    now: () => NOW_MS,
    socketFactory: (url, handlers) => {
      const socket = new ControlledSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
  };
  const sink = new RoomSink();
  const presence = new PresenceService({ now: () => NOW_MS });
  const controller = registerZoomWithDependencies(host.bb, sink, dependencies, presence);
  const start = async (uuid?: string, stream?: string) => {
    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signed(startedBody(uuid, stream)));
  };
  /** Take the capture to "capturing", which is when presence goes live. */
  const capture = (signalingIndex = 0, withVideo = false) => {
    const signaling = sockets[signalingIndex]!;
    signaling.handlers.open();
    signaling.receive({
      msg_type: 2,
      status_code: 0,
      media_server: {
        server_urls: {
          transcript: "wss://rtms.zoom.us/transcript",
          ...(withVideo ? { video: "wss://rtms.zoom.us/video" } : {}),
        },
      },
    });
    const media = sockets[signalingIndex + 1]!;
    media.handlers.open();
    media.receive({ msg_type: 4, status_code: 0 });
    return signaling;
  };
  return { host, sockets, sink, presence, controller, start, capture };
}

/** What the popover would actually print for the first person in the room. */
function personStatusInPopover(presence: SittingPresence, room: Room): string {
  const view = buildPresenceView({
    rooms: [room],
    selectedRoomId: room.id,
    presence,
    conversation: null,
    zoomConfigured: true,
    now: NOW_MS,
  });
  return popoverModel(view, { pluginId: "hub", now: NOW_MS }).people[0]!.status;
}

describe("a Zoom sitting's presence, from webhook to teardown", () => {
  it("attaches presence to the room the meeting belongs to, and goes live with capture", async () => {
    const context = await setup();
    await context.start();

    // Installed before the socket opens, so the first observation has somewhere
    // to land.
    expect(context.presence.roomPresence("room-1")?.availability).toBe("connecting");
    const signaling = context.capture();
    expect(context.presence.roomPresence("room-1")?.availability).toBe("live");

    signaling.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 16778240, user_name: "Ada" },
    });
    const live = context.presence.roomPresence("room-1")!;
    expect(live.participants.map((person) => person.label)).toEqual(["Ada"]);
    expect(live.completeness).toBe("partial");
    expect(live.sittingKey).toBe("conversation-occurrence-1");
  });

  it("sends no subscription at all when presence is switched off", async () => {
    const context = await setup({ zoomPresenceEnabled: false });
    await context.start();
    const signaling = context.capture();

    expect(signaling.sent.map((raw) => (JSON.parse(raw) as { msg_type: number }).msg_type)).toEqual([1, 7]);
    signaling.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 1, user_name: "Ada" },
    });
    // No subscription, no sitting: an event Zoom volunteered anyway cannot make
    // a roster this capture never opened.
    expect(context.presence.roomPresence("room-1")).toBeNull();
  });

  it("shows the presence-off default as no stream, not as a live and empty room", async () => {
    const context = await setup({ zoomPresenceEnabled: false });
    await context.start();
    context.capture();

    // The transcript is capturing, which says nothing about presence: nothing
    // was subscribed to, so no participant event can ever arrive. A green dot
    // over "nobody seen here yet" would be capture's light worn by presence.
    expect(context.presence.roomPresence("room-1")).toBeNull();
    const view = buildPresenceView({
      rooms: [context.sink.room],
      selectedRoomId: context.sink.room.id,
      presence: context.presence.roomPresence("room-1"),
      conversation: null,
      zoomConfigured: true,
      now: NOW_MS,
    });
    expect(view.room).toMatchObject({
      availability: "unavailable",
      completeness: "unknown",
      participants: [],
      portraits: false,
      status: "No active stream — BB cannot tell who is here",
    });
    expect(rowModel(view, "full").dot).toBe("idle");
  });

  it("holds no roster for a sitting whose subscription Zoom never received", async () => {
    const context = await setup();
    await context.start();
    const signaling = context.sockets[0]!;
    signaling.handlers.open();
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
    const media = context.sockets[1]!;
    media.handlers.open();
    media.receive({ msg_type: 4, status_code: 0 });

    // Capture is fine; presence is not, and the strip is told the difference.
    expect(context.sink.states.at(-1)?.state).toBe("capturing");
    expect(context.presence.roomPresence("room-1")).toBeNull();
  });

  it("opens no portrait feed for a presence stream nobody subscribed to", async () => {
    const context = await setup({ zoomPresenceEnabled: false, zoomVideoEnabled: true });
    await context.start();
    // Zoom offers a video stream, and this meeting still must not open it.
    context.capture(0, true);

    // Stills are a presence feature: with no roster to file them against they
    // could only be pictures of people the strip never mentions.
    expect(context.sockets).toHaveLength(2);
  });

  it("honours an operator's corrected event codes", async () => {
    const context = await setup({ zoomPresenceEventCodes: "speaker=21,join=22,leave=23" });
    await context.start();
    const signaling = context.capture();

    const subscription = JSON.parse(signaling.sent.at(-1)!) as { events: { event_type: number }[] };
    // The corrected three, and the published camera codes the operator left alone.
    expect(subscription.events.map((entry) => entry.event_type)).toEqual([22, 23, 21, 8, 9]);
    signaling.receive({ msg_type: 6, event: { event_type: 22, user_id: 5, user_name: "Ada" } });
    expect(context.presence.roomPresence("room-1")?.participants).toHaveLength(1);
  });

  it("empties the room when the stream stops, rather than leaving ghosts", async () => {
    const context = await setup();
    await context.start();
    const signaling = context.capture();
    signaling.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 1, user_name: "Ada" },
    });

    await context.host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signed(stoppedBody()));
    // Not "an empty meeting": no presence at all, which is what makes the strip
    // say there is no active stream.
    expect(context.presence.roomPresence("room-1")).toBeNull();
  });

  it("starts the next sitting in the same room from nobody", async () => {
    const context = await setup();
    await context.start();
    const first = context.capture();
    first.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 1, user_name: "Ada" },
    });
    await context.host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signed(stoppedBody()));

    await context.start("occurrence-2", "stream-2");
    const second = context.capture(2);
    expect(context.presence.roomPresence("room-1")?.participants).toEqual([]);
    second.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 1, user_name: "Sam" },
    });
    // The same Zoom user id in a new sitting is a different person, and the hub
    // ids say so.
    const people = context.presence.roomPresence("room-1")!.participants;
    expect(people.map((person) => person.label)).toEqual(["Sam"]);
    expect(people[0]!.id).toBe("conversation-occurrence-2:1");
  });

  it("ignores a late message from a stream Zoom has already replaced", async () => {
    const context = await setup();
    await context.start("occurrence-1", "stream-1");
    const first = context.capture();
    // A second start for the same occurrence: the new stream supersedes the old.
    await context.start("occurrence-1", "stream-2");
    const second = context.capture(2);
    second.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 2, user_name: "Sam" },
    });

    first.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 9, user_name: "Ghost" },
    });
    expect(context.presence.roomPresence("room-1")?.participants.map((person) => person.label))
      .toEqual(["Sam"]);
  });

  it("hides the roster while the connection is interrupted", async () => {
    const context = await setup();
    await context.start();
    const signaling = context.capture();
    signaling.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.speaker, user_id: 1, user_name: "Ada" },
    });
    expect(context.presence.roomPresence("room-1")?.participants[0]!.speaking).toBe(true);

    signaling.receive({ msg_type: 8, state: 2 });
    const interrupted = context.presence.roomPresence("room-1")!;
    expect(interrupted.availability).toBe("interrupted");
    expect(interrupted.participants).toEqual([]);
    expect(interrupted.completeness).toBe("unknown");
  });

  it("carries a camera event from the signaling socket to what the popover says", async () => {
    const context = await setup();
    await context.start();
    const signaling = context.capture();
    signaling.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 1, user_name: "Ada" },
    });

    signaling.receive({
      msg_type: 6,
      event: { event_type: 8, timestamp: NOW_MS, participants: [{ user_id: 1 }] },
    });
    expect(context.presence.roomPresence("room-1")?.participants[0]!.camera).toBe("on");
    expect(personStatusInPopover(context.presence.roomPresence("room-1")!, context.sink.room)).toBe("Camera on");

    signaling.receive({
      msg_type: 6,
      event: { event_type: 9, timestamp: NOW_MS, participants: [{ user_id: 1 }] },
    });
    expect(context.presence.roomPresence("room-1")?.participants[0]!.camera).toBe("off");
    expect(personStatusInPopover(context.presence.roomPresence("room-1")!, context.sink.room)).toBe("Camera off");
  });

  it("takes a camera event as evidence of somebody it never saw join", async () => {
    const context = await setup();
    await context.start();
    const signaling = context.capture();
    signaling.receive({
      msg_type: 6,
      event: { event_type: 8, timestamp: NOW_MS, participants: [{ user_id: 42 }, { user_id: 43 }] },
    });

    const people = context.presence.roomPresence("room-1")!.participants;
    expect(people.map((person) => [person.sourceId, person.camera])).toEqual([["42", "on"], ["43", "on"]]);
    // Still never claimed to be the whole room.
    expect(context.presence.roomPresence("room-1")!.completeness).toBe("partial");
  });

  it("stops advertising portraits when this meeting turns out to have no video", async () => {
    const context = await setup({ zoomVideoEnabled: true });
    await context.start();
    // Installed with portraits, because the setting asked for them...
    expect(context.presence.roomPresence("room-1")?.portraits).toBe(true);

    // ...and the handshake offers no video stream, which is the normal answer
    // for an app without video access.
    const signaling = context.capture();
    expect(context.presence.roomPresence("room-1")?.portraits).toBe(false);

    // Presence itself is untouched, and so is transcript capture.
    signaling.receive({
      msg_type: 6,
      event: { event_type: DEFAULT_ZOOM_PRESENCE_CODES.join, user_id: 1, user_name: "Ada" },
    });
    expect(context.presence.roomPresence("room-1")?.participants).toHaveLength(1);
    expect(context.sink.states.at(-1)?.state).toBe("capturing");
  });

  it("drops presence when Zoom capture is switched off", async () => {
    const context = await setup();
    await context.start();
    context.capture();
    await context.host.harness.behavior.setSettings({ zoomEnabled: false });

    expect(context.presence.roomPresence("room-1")).toBeNull();
  });

  it("drops presence when the plugin is disposed", async () => {
    const context = await setup();
    await context.start();
    context.capture();

    await context.host.harness.lifecycle.dispose();
    expect(context.presence.roomPresence("room-1")).toBeNull();
  });
});
