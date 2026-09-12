import { createHmac } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { CaptureState, SegmentInput, TranscriptSink } from "../src/domain.js";
import { occurrenceTitle, registerZoomWithDependencies, type ZoomAdapterDependencies } from "../src/adapters/zoom.js";
import type { RtmsSocket } from "../src/adapters/zoom-protocol.js";

class RecordingSink implements TranscriptSink {
  readonly ensured: Array<{ sourceId: string; externalId: string; title: string }> = [];
  readonly segments: Array<{ conversationId: string; segments: SegmentInput[] }> = [];
  readonly states: Array<{ conversationId: string; state: CaptureState; detail: string | null | undefined }> = [];

  ensureConversation(sourceId: string, externalId: string, title: string): { id: string } {
    this.ensured.push({ sourceId, externalId, title });
    return { id: `conversation-${externalId}` };
  }

  appendSegments(conversationId: string, segments: SegmentInput[]): void {
    this.segments.push({ conversationId, segments });
  }

  setCapture(conversationId: string, state: CaptureState, detail?: string | null): void {
    this.states.push({ conversationId, state, detail });
  }
}

const SECRET = "webhook-secret";
const NOW_MS = 1_800_000_000_000;

function signedRequest(body: string, timestamp = String(NOW_MS / 1_000)): RequestInit {
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

function dependencies(opened: string[] = []): ZoomAdapterDependencies {
  return {
    now: () => NOW_MS,
    socketFactory(url, _handlers): RtmsSocket {
      opened.push(url);
      return { send: () => undefined, close: () => undefined };
    },
  };
}

describe("occurrence titles", () => {
  it("distinguishes two occupancy periods of one recurring meeting", () => {
    // A recurring meeting keeps its id and gets a new meeting_uuid each time the room
    // fills. Leaving and rejoining produced two conversations titled identically.
    const first = occurrenceTitle("88126499248", Date.UTC(2026, 8, 11, 22, 1));
    const second = occurrenceTitle("88126499248", Date.UTC(2026, 8, 11, 22, 5));
    expect(first).toBe("Zoom meeting 88126499248 · 2026-09-11 22:01Z");
    expect(second).not.toBe(first);
  });

  it("falls back to a bare name when Zoom sends no meeting id or a nonsense anchor", () => {
    expect(occurrenceTitle("", Date.UTC(2026, 8, 11))).toBe("Zoom meeting · 2026-09-11 00:00Z");
    expect(occurrenceTitle("123", Number.NaN)).toBe("Zoom meeting 123");
  });
});
describe("Zoom source adapter webhook", () => {
  it("declares server-only secrets and reports configured and enabled separately", async () => {
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: false,
      },
    });
    const controller = registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());

    expect(host.harness.inspection.registrations.settingsDescriptors).toMatchObject({
      zoomClientId: { type: "string" },
      zoomClientSecret: { type: "string", secret: true },
      zoomWebhookSecret: { type: "string", secret: true },
      zoomEnabled: { type: "boolean", default: false },
    });
    await expect(controller.status()).resolves.toEqual({ configured: true, enabled: false });
  });

  it("validates a signed endpoint challenge from the raw request body", async () => {
    const host = createFakePluginHost({ settings: { zoomWebhookSecret: SECRET } });
    registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());
    const body = JSON.stringify({
      event: "endpoint.url_validation",
      event_ts: NOW_MS,
      payload: { plainToken: "challenge-token" },
    });

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      plainToken: "challenge-token",
      encryptedToken: "7da852f23a0e8f48b0b651b06cc9ad0a11d4d1e5f0bd61014a08792cba8606e4",
    });
  });

  it("rejects invalid signatures, stale timestamps, and replayed deliveries", async () => {
    const host = createFakePluginHost({ settings: { zoomWebhookSecret: SECRET } });
    registerZoomWithDependencies(host.bb, new RecordingSink(), dependencies());
    const body = JSON.stringify({
      event: "endpoint.url_validation",
      event_ts: NOW_MS,
      payload: { plainToken: "challenge-token" },
    });

    const invalid = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", {
      ...signedRequest(body),
      headers: {
        "content-type": "application/json",
        "x-zm-request-timestamp": String(NOW_MS / 1_000),
        "x-zm-signature": "v0=invalid",
      },
    });
    const stale = await host.harness.behavior.fetchHttp(
      "POST",
      "/zoom/webhook",
      signedRequest(body, String(NOW_MS / 1_000 - 301)),
    );
    const accepted = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));
    const replay = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    expect(invalid.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(replay.status).toBe(409);
  });

  it("auto-starts only original-host events when enabled and fully configured", async () => {
    const opened: string[] = [];
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, dependencies(opened));
    const event = (originalHost: boolean, streamId: string) =>
      JSON.stringify({
        event: "meeting.rtms_started",
        event_ts: NOW_MS,
        payload: {
          meeting_uuid: "meeting-uuid",
          meeting_id: "123 456 789",
          operator_id: "operator-id",
          is_original_host: originalHost,
          rtms_stream_id: streamId,
          server_urls: "wss://rtms.zoom.us/signal",
        },
      });

    const nonHostBody = event(false, "stream-non-host");
    const hostBody = event(true, "stream-host");
    expect(
      (await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(nonHostBody))).status,
    ).toBe(204);
    expect(
      (await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(hostBody))).status,
    ).toBe(204);

    expect(sink.ensured).toEqual([
      { sourceId: "zoom", externalId: "meeting-uuid", title: "Zoom meeting 123 456 789 · 2027-01-15 08:00Z" },
    ]);
    expect(sink.states[0]).toMatchObject({
      conversationId: "conversation-meeting-uuid",
      state: "connecting",
    });
    expect(opened).toEqual(["wss://rtms.zoom.us/signal"]);
  });

  it("rejects signed start events whose RTMS destination could target the local network", async () => {
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, dependencies());
    const body = JSON.stringify({
      event: "meeting.rtms_started",
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-id",
        server_urls: "wss://127.0.0.1/internal",
      },
    });

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    expect(response.status).toBe(400);
    expect(sink.ensured).toHaveLength(0);
  });

  it("does not let a late stopped event terminate a newer stream for the same occurrence", async () => {
    const sockets: Array<{ closed: boolean }> = [];
    const deps = dependencies();
    deps.socketFactory = () => {
      const record = { closed: false };
      sockets.push(record);
      return { send: () => undefined, close: () => void (record.closed = true) };
    };
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, deps);
    const event = (name: string, streamId: string) => JSON.stringify({
      event: name,
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: streamId,
        server_urls: "wss://rtms.zoom.us/signal",
        stop_reason: 6,
      },
    });
    for (const streamId of ["old-stream", "new-stream"]) {
      const body = event("meeting.rtms_started", streamId);
      await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));
    }
    const stateCount = sink.states.length;
    const lateStop = event("meeting.rtms_stopped", "old-stream");

    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(lateStop));

    expect(response.status).toBe(204);
    expect(sockets.at(-1)!.closed).toBe(false);
    expect(sink.states).toHaveLength(stateCount);
  });

  it("records the stop reason even when the socket ended the session first", async () => {
    // Production ordering: Zoom's signaling socket reports the stream stopped, which ends
    // the session and clears it from the active maps, and only then does the webhook
    // arrive. The webhook carries stop_reason, the only thing separating a deliberate end
    // from a dropped connection, so losing that race must not lose the reason.
    const signalingHandlers: Array<{ message(data: string): void }> = [];
    const deps: ZoomAdapterDependencies = {
      now: () => NOW_MS,
      socketFactory(_url, handlers): RtmsSocket {
        signalingHandlers.push(handlers as { message(data: string): void });
        return { send: () => undefined, close: () => undefined };
      },
    };
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, deps);
    const event = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      event: name,
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-1",
        server_urls: "wss://rtms.zoom.us/signal",
        ...extra,
      },
    });

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(event("meeting.rtms_started")));
    // msg_type 8 with state 3 is Zoom reporting the stream stopped; the session ends here.
    signalingHandlers[0]!.message(JSON.stringify({ msg_type: 8, state: 3 }));
    expect(sink.states.at(-1)!.state).toBe("ended");
    expect(sink.states.at(-1)!.detail).toBe("Zoom RTMS stream ended");

    const stopped = event("meeting.rtms_stopped", { stop_reason: 6 });
    const response = await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(stopped));

    expect(response.status).toBe(204);
    expect(sink.states.at(-1)!.detail).toBe("Zoom meeting ended");
  });

  it("reports a connection-failure stop reason as interrupted, not a clean end", async () => {
    // A host crash and a deliberate leave both close the socket identically. Only
    // stop_reason tells them apart, so this is the case the race was hiding.
    const signalingHandlers: Array<{ message(data: string): void }> = [];
    const deps: ZoomAdapterDependencies = {
      now: () => NOW_MS,
      socketFactory(_url, handlers): RtmsSocket {
        signalingHandlers.push(handlers as { message(data: string): void });
        return { send: () => undefined, close: () => undefined };
      },
    };
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    const sink = new RecordingSink();
    registerZoomWithDependencies(host.bb, sink, deps);
    const event = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      event: name,
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-1",
        server_urls: "wss://rtms.zoom.us/signal",
        ...extra,
      },
    });

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(event("meeting.rtms_started")));
    signalingHandlers[0]!.message(JSON.stringify({ msg_type: 8, state: 3 }));
    const stopped = event("meeting.rtms_stopped", { stop_reason: 12 });

    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(stopped));

    expect(sink.states.at(-1)!.state).toBe("interrupted");
    expect(sink.states.at(-1)!.detail).toContain("connection failure (12)");
  });

  it("closes capture resources during BB disposal", async () => {
    let closeCount = 0;
    const deps = dependencies();
    deps.socketFactory = () => ({ send: () => undefined, close: () => void closeCount++ });
    const host = createFakePluginHost({
      settings: {
        zoomClientId: "client-id",
        zoomClientSecret: "client-secret",
        zoomWebhookSecret: SECRET,
        zoomEnabled: true,
      },
    });
    registerZoomWithDependencies(host.bb, new RecordingSink(), deps);
    const body = JSON.stringify({
      event: "meeting.rtms_started",
      event_ts: NOW_MS,
      payload: {
        meeting_uuid: "meeting-uuid",
        meeting_id: "123",
        is_original_host: true,
        rtms_stream_id: "stream-id",
        server_urls: "wss://rtms.zoom.us/signal",
      },
    });
    await host.harness.behavior.fetchHttp("POST", "/zoom/webhook", signedRequest(body));

    await host.harness.lifecycle.dispose();

    expect(closeCount).toBe(1);
  });
});
