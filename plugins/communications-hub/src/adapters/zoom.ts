import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { CaptureState, Registrant, Room, TranscriptSink } from "../domain.js";
import { ZoomApi } from "./zoom-api.js";
import {
  ZoomRtmsSession,
  assertSafeZoomWssUrl,
  zoomWebSocketFactory,
  type RtmsSocketFactory,
} from "./zoom-protocol.js";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const MAX_REPLAY_ENTRIES = 2_048;
/** Finished captures kept addressable so a late `rtms_stopped` can still record its reason. */
const MAX_FINISHED_CAPTURES = 64;

/**
 * Name a capture by its meeting and its occurrence.
 *
 * A recurring meeting keeps one meeting id but gets a fresh `meeting_uuid` every time the
 * room fills, so the id alone repeats: leaving and rejoining 70 seconds apart produced two
 * conversations with identical titles and no way to tell them apart in a list.
 *
 * The timestamp is UTC and says so. `label` is the meeting's own name when we can find one:
 * a room's name, or the topic read back from Zoom's API. RTMS events never carry it, so
 * without a label the best a capture can do is identify the room it happened in.
 */
export function occurrenceTitle(meetingId: string, anchorMs: number, label?: string | null): string {
  const named = label?.trim();
  const base = named ? named : meetingId ? `Zoom meeting ${meetingId}` : "Zoom meeting";
  if (!Number.isSafeInteger(anchorMs) || anchorMs < 0) return base;
  const stamp = new Date(anchorMs).toISOString().slice(0, 16).replace("T", " ");
  return `${base} · ${stamp}Z`;
}

const webhookEnvelopeSchema = z.object({
  event: z.string().min(1).max(100),
  event_ts: z.number().int().nonnegative(),
  payload: z.unknown(),
}).passthrough();

const validationPayloadSchema = z.object({
  plainToken: z.string().min(1).max(1_000),
}).passthrough();

const startedPayloadSchema = z.object({
  meeting_uuid: z.string().min(1).max(512),
  meeting_id: z.union([z.string(), z.number()]).optional(),
  operator_id: z.string().max(512).optional(),
  is_original_host: z.literal(true),
  rtms_stream_id: z.string().min(1).max(512),
  server_urls: z.string().min(1).max(4_096),
}).passthrough();

const stoppedPayloadSchema = z.object({
  meeting_uuid: z.string().min(1).max(512),
  rtms_stream_id: z.string().min(1).max(512),
  stop_reason: z.number().int().optional(),
}).passthrough();

const interruptedPayloadSchema = z.object({
  meeting_uuid: z.string().min(1).max(512),
  rtms_stream_id: z.string().min(1).max(512),
  server_urls: z.string().min(1).max(4_096),
}).passthrough();

export interface ZoomController {
  stop(conversationId: string): void;
  status(): Promise<{ configured: boolean; enabled: boolean; canCreateRooms: boolean }>;
  /**
   * Create a reusable Zoom meeting and record it as a room.
   *
   * Deliberately not exposed as an agent tool. Transcript text sits in an agent's context, so
   * "schedule a follow-up with the vendor" spoken in a meeting is indistinguishable from an
   * induced tool call. Creating a meeting costs money and sends a real invitation, so it stays
   * on the UI action and the CLI, where a human is the one asking.
   */
  createRoom(name: string): Promise<Room>;
  /**
   * Register a person for a room and store the personal join URL Zoom issues.
   *
   * Held to the same rule as room creation: UI action and CLI only, never an agent tool. This
   * sends a real invitation to a real address, and transcript text in an agent's context must
   * never be able to reach it.
   */
  addRegistrant(roomId: string, person: {name: string; email: string}): Promise<Registrant>;
  /** Push a room's expiry out, keeping its meeting id, join URL and personal links. */
  renewRoom(roomId: string): Promise<Room>;
  /**
   * Delete a room's meeting at Zoom and retire the room.
   *
   * Separate from archiving, which is local and leaves the meeting working. This makes the room
   * unreachable for everyone holding a link, so like room creation it stays a UI action and a
   * CLI command and is never an agent tool.
   */
  deleteRoom(roomId: string): Promise<Room>;
}

export interface ZoomAdapterDependencies {
  now(): number;
  socketFactory: RtmsSocketFactory;
  fetch: typeof globalThis.fetch;
}

interface ActiveCapture {
  conversationId: string;
  meetingUuid: string;
  streamId: string;
  signalingUrl: string;
  anchorMs: number;
  clientId: string;
  clientSecret: string;
  session: ZoomRtmsSession;
}

const productionDependencies: ZoomAdapterDependencies = {
  now: () => Date.now(),
  socketFactory: zoomWebSocketFactory,
  fetch: (...args) => globalThis.fetch(...args),
};

export function registerZoom(bb: BbPluginApi, sink: TranscriptSink): ZoomController {
  return registerZoomWithDependencies(bb, sink, productionDependencies);
}

/** Dependency seam for deterministic protocol tests; production uses registerZoom. */
export function registerZoomWithDependencies(
  bb: BbPluginApi,
  sink: TranscriptSink,
  dependencies: ZoomAdapterDependencies,
): ZoomController {
  const settings = bb.settings.define({
    zoomClientId: { type: "string", label: "Zoom client ID" },
    zoomClientSecret: { type: "string", label: "Zoom client secret", secret: true },
    zoomWebhookSecret: { type: "string", label: "Zoom webhook secret", secret: true },
    zoomEnabled: { type: "boolean", label: "Enable Zoom capture", default: false },
    zoomAccountId: { type: "string", label: "Zoom account ID (for creating rooms)" },
    zoomApiClientId: { type: "string", label: "Zoom Server-to-Server client ID" },
    zoomApiClientSecret: { type: "string", label: "Zoom Server-to-Server client secret", secret: true },
    zoomHostUser: { type: "string", label: "Zoom host user (email or user ID) that installed the RTMS app" },
  });
  const activeByConversation = new Map<string, ActiveCapture>();
  const activeByStream = new Map<string, ActiveCapture>();
  const activeByOccurrence = new Map<string, ActiveCapture>();
  const finishedByStream = new Map<string, { conversationId: string; meetingUuid: string }>();
  const replayCache = new Map<string, number>();
  let disposed = false;

  function removeActive(capture: ActiveCapture): void {
    if (activeByConversation.get(capture.conversationId) === capture) {
      activeByConversation.delete(capture.conversationId);
    }
    if (activeByStream.get(capture.streamId) === capture) activeByStream.delete(capture.streamId);
    if (activeByOccurrence.get(capture.meetingUuid) === capture) {
      activeByOccurrence.delete(capture.meetingUuid);
    }
    rememberFinished(capture);
  }

  /**
   * The socket and the `rtms_stopped` webhook are two observations of one event, and the
   * socket usually wins: it ends the session, which removes the capture from the active
   * maps before the webhook arrives. The webhook is the one carrying `stop_reason` — the
   * only signal separating a deliberate end from a dropped connection — so a finished
   * capture stays addressable by stream id long enough for that reason to be recorded.
   */
  function rememberFinished(capture: ActiveCapture): void {
    finishedByStream.set(capture.streamId, {
      conversationId: capture.conversationId,
      meetingUuid: capture.meetingUuid,
    });
    while (finishedByStream.size > MAX_FINISHED_CAPTURES) {
      const oldest = finishedByStream.keys().next();
      if (oldest.done) break;
      finishedByStream.delete(oldest.value);
    }
  }

  function updateCapture(conversationId: string, state: CaptureState, detail?: string | null): void {
    try {
      sink.setCapture(conversationId, state, detail);
    } catch {
      // Sink failures must not crash the plugin event loop or expose transcript data.
    }
  }

  function createCapture(input: Omit<ActiveCapture, "session">): ActiveCapture {
    let capture: ActiveCapture | undefined;
    const session = new ZoomRtmsSession({
      meetingUuid: input.meetingUuid,
      streamId: input.streamId,
      signalingUrl: input.signalingUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      anchorMs: input.anchorMs,
      socketFactory: dependencies.socketFactory,
      onSegments: (segments) => {
        try {
          sink.appendSegments(input.conversationId, segments);
        } catch {
          updateCapture(input.conversationId, "interrupted", "Transcript storage failed");
        }
      },
      onState: (state, detail) => updateCapture(input.conversationId, state, detail),
      log: (message) => bb.log.warn(message),
      onTerminal: () => {
        if (capture) removeActive(capture);
      },
    });
    capture = { ...input, session };
    return capture;
  }

  function installCapture(capture: ActiveCapture): void {
    const previous = activeByOccurrence.get(capture.meetingUuid) ?? activeByStream.get(capture.streamId);
    if (previous) {
      removeActive(previous);
      previous.session.dispose();
    }
    activeByConversation.set(capture.conversationId, capture);
    activeByStream.set(capture.streamId, capture);
    activeByOccurrence.set(capture.meetingUuid, capture);
    capture.session.start();
  }

  async function captureAnchor(meetingUuid: string, proposed: number): Promise<number> {
    const digest = createHash("sha256").update(meetingUuid).digest("hex");
    const key = `zoom:anchor:${digest}`;
    const existing = await bb.storage.kv.get<number>(key);
    if (disposed) throw new Error("Zoom adapter disposed");
    if (typeof existing === "number" && Number.isSafeInteger(existing) && existing >= 0) return existing;
    await bb.storage.kv.set(key, proposed);
    if (disposed) throw new Error("Zoom adapter disposed");
    return proposed;
  }

  /**
   * Find the room a meeting belongs to.
   *
   * The Zoom meeting id is stable across occurrences while meeting_uuid is not, so this is what
   * gathers a room's sittings together. A meeting nobody created through BB has no room, which
   * is normal and not an error, and a lookup failure must never stop a capture starting.
   */
  function findRoomSafely(meetingId: string): Room | null {
    try {
      return sink.findRoom("zoom", meetingId);
    } catch (error) {
      bb.log.warn(`zoom room lookup failed ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }

  /**
   * Name a capture from Zoom's own meeting topic, after capture has started.
   *
   * Deliberately not awaited. The topic needs a REST round trip, and speech arriving while we
   * waited for it would be speech we never recorded. A late but correct name costs nothing;
   * a delayed socket costs transcript.
   *
   * The rename is conditional on the title still being the generated one, so it can never
   * overwrite a name a human chose in the meantime.
   */
  async function nameFromZoom(conversationId: string, meetingId: string, generated: string, anchorMs: number): Promise<void> {
    if (!meetingId) return;
    try {
      const api = await restClient();
      if (!api) return;
      const topic = await api.meetingTopic(meetingId);
      if (!topic || disposed) return;
      sink.renameIfUnchanged(conversationId, generated, occurrenceTitle(meetingId, anchorMs, topic));
    } catch (error) {
      // A capture with a dull name is a far smaller loss than a capture that failed to start.
      bb.log.warn(`zoom topic lookup failed ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  /** The REST client, or null when the Server-to-Server credential is not configured. */
  async function restClient(): Promise<ZoomApi | null> {
    const current = await settings.get();
    const accountId = current.zoomAccountId?.trim();
    const clientId = current.zoomApiClientId?.trim();
    const clientSecret = current.zoomApiClientSecret?.trim();
    if (!accountId || !clientId || !clientSecret) return null;
    return new ZoomApi({ accountId, clientId, clientSecret }, {
      fetch: dependencies.fetch,
      now: dependencies.now,
    });
  }

  async function startCapture(payload: z.infer<typeof startedPayloadSchema>, eventTs: number): Promise<void> {
    let currentSettings = await settings.get();
    if (
      disposed ||
      !currentSettings.zoomEnabled ||
      !currentSettings.zoomClientId?.trim() ||
      !currentSettings.zoomClientSecret?.trim() ||
      !currentSettings.zoomWebhookSecret?.trim()
    ) return;
    // Field names only, never values. The schemas use passthrough, so Zoom may be sending
    // fields we never look at — a meeting topic among them would remove the need for an
    // API lookup to name a conversation. Names are safe to log; payload values are not.
    bb.log.info(`zoom rtms_started fields ${Object.keys(payload).sort().join(",")}`);
    const signalingUrl = assertSafeZoomWssUrl(payload.server_urls).href;
    const meetingId = payload.meeting_id === undefined ? "" : String(payload.meeting_id).trim();
    const proposedAnchor = Number.isSafeInteger(eventTs) ? eventTs : dependencies.now();
    const anchorMs = await captureAnchor(payload.meeting_uuid, proposedAnchor);
    // A room already carries the name we gave Zoom, so the common case needs no API call and
    // cannot delay the socket. Meetings BB did not create are named afterwards instead.
    const room = meetingId ? findRoomSafely(meetingId) : null;
    const title = occurrenceTitle(meetingId, anchorMs, room?.name);
    currentSettings = await settings.get();
    if (
      disposed ||
      !currentSettings.zoomEnabled ||
      !currentSettings.zoomClientId?.trim() ||
      !currentSettings.zoomClientSecret?.trim() ||
      !currentSettings.zoomWebhookSecret?.trim()
    ) return;
    const conversation = sink.ensureConversation("zoom", payload.meeting_uuid, title);
    if (room) sink.setConversationRoom(conversation.id, room.id);
    else void nameFromZoom(conversation.id, meetingId, title, anchorMs);
    installCapture(createCapture({
      conversationId: conversation.id,
      meetingUuid: payload.meeting_uuid,
      streamId: payload.rtms_stream_id,
      signalingUrl,
      anchorMs,
      clientId: currentSettings.zoomClientId.trim(),
      clientSecret: currentSettings.zoomClientSecret.trim(),
    }));
  }

  /** Classify a Zoom `stop_reason`. Undefined means Zoom told us nothing beyond "stopped". */
  function classifyStop(reason: number | undefined): { state: "ended" | "interrupted" | "stopped"; detail: string } {
    if (reason !== undefined && ((reason >= 10 && reason <= 19) || reason === 24)) {
      return { state: "interrupted", detail: `Zoom RTMS stopped after a connection failure (${reason})` };
    }
    if (reason === 6) return { state: "ended", detail: "Zoom meeting ended" };
    return { state: "stopped", detail: reason === undefined ? "Zoom RTMS stopped" : `Zoom RTMS stopped (${reason})` };
  }

  function finishCapture(payload: z.infer<typeof stoppedPayloadSchema>): void {
    const capture = activeByStream.get(payload.rtms_stream_id);
    const target = capture ?? finishedByStream.get(payload.rtms_stream_id);
    if (!target || target.meetingUuid !== payload.meeting_uuid) return;
    // A newer stream for this occurrence has taken over. The old stream's stop reason
    // describes a capture that is no longer the live one, and writing it would report the
    // running capture as stopped.
    if (!capture && activeByOccurrence.has(payload.meeting_uuid)) {
      finishedByStream.delete(payload.rtms_stream_id);
      return;
    }
    const { state, detail } = classifyStop(payload.stop_reason);
    if (capture) {
      removeActive(capture);
      capture.session.end(state, detail);
    }
    // Applied even when the session already went terminal from its socket. The socket
    // reports only that the stream stopped; the webhook reports why, and recording the
    // weaker observation first must not discard the stronger one that follows.
    updateCapture(target.conversationId, state, detail);
    finishedByStream.delete(payload.rtms_stream_id);
  }

  async function reconnectCapture(payload: z.infer<typeof interruptedPayloadSchema>): Promise<void> {
    const current = activeByStream.get(payload.rtms_stream_id);
    if (!current || current.meetingUuid !== payload.meeting_uuid || disposed) return;
    const currentSettings = await settings.get();
    if (!currentSettings.zoomEnabled) return;
    const signalingUrl = assertSafeZoomWssUrl(payload.server_urls).href;
    removeActive(current);
    current.session.dispose();
    installCapture(createCapture({
      conversationId: current.conversationId,
      meetingUuid: current.meetingUuid,
      streamId: current.streamId,
      signalingUrl,
      anchorMs: current.anchorMs,
      clientId: current.clientId,
      clientSecret: current.clientSecret,
    }));
  }

  function verifyRequest(rawBody: string, headers: Headers, secret: string): Response | null {
    const timestamp = headers.get("x-zm-request-timestamp") ?? "";
    const supplied = headers.get("x-zm-signature") ?? "";
    if (!/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/i.test(supplied)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(dependencies.now() / 1_000);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
      return new Response("Unauthorized", { status: 401 });
    }
    const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
    const expectedBytes = Buffer.from(expected, "utf8");
    const suppliedBytes = Buffer.from(supplied, "utf8");
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      return new Response("Unauthorized", { status: 401 });
    }
    for (const [key, seenAt] of replayCache) {
      if (nowSeconds - seenAt > WEBHOOK_TOLERANCE_SECONDS) replayCache.delete(key);
    }
    if (replayCache.has(supplied)) return new Response("Duplicate delivery", { status: 409 });
    if (replayCache.size >= MAX_REPLAY_ENTRIES) replayCache.delete(replayCache.keys().next().value!);
    replayCache.set(supplied, nowSeconds);
    return null;
  }

  bb.http.route("POST", "/zoom/webhook", async (context) => {
    const contentLength = Number(context.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
    const rawBody = await context.req.raw.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
    const currentSettings = await settings.get();
    const webhookSecret = currentSettings.zoomWebhookSecret?.trim();
    if (!webhookSecret) return new Response("Zoom webhook is not configured", { status: 503 });
    const verificationFailure = verifyRequest(rawBody, context.req.raw.headers, webhookSecret);
    if (verificationFailure) return verificationFailure;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const envelope = webhookEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) return new Response("Invalid webhook", { status: 400 });
    if (envelope.data.event === "endpoint.url_validation") {
      const payload = validationPayloadSchema.safeParse(envelope.data.payload);
      if (!payload.success) return new Response("Invalid challenge", { status: 400 });
      const encryptedToken = createHmac("sha256", webhookSecret)
        .update(payload.data.plainToken)
        .digest("hex");
      return Response.json({ plainToken: payload.data.plainToken, encryptedToken });
    }
    if (envelope.data.event === "meeting.rtms_started") {
      const payload = startedPayloadSchema.safeParse(envelope.data.payload);
      if (!payload.success) {
        const possible = envelope.data.payload as { is_original_host?: unknown } | null;
        if (possible && possible.is_original_host === false) return new Response(null, { status: 204 });
        return new Response("Invalid RTMS start event", { status: 400 });
      }
      try {
        await startCapture(payload.data, envelope.data.event_ts);
      } catch {
        return new Response("Invalid RTMS start event", { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    if (envelope.data.event === "meeting.rtms_stopped") {
      const payload = stoppedPayloadSchema.safeParse(envelope.data.payload);
      if (!payload.success) return new Response("Invalid RTMS stop event", { status: 400 });
      finishCapture(payload.data);
      return new Response(null, { status: 204 });
    }
    if (envelope.data.event === "meeting.rtms_interrupted") {
      const payload = interruptedPayloadSchema.safeParse(envelope.data.payload);
      if (!payload.success) return new Response("Invalid RTMS interrupted event", { status: 400 });
      try {
        await reconnectCapture(payload.data);
      } catch {
        return new Response("Invalid RTMS interrupted event", { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  }, { auth: "none" });

  settings.onChange((next, previous) => {
    bb.realtime.publish("communications-changed", { reason: "zoom-settings" });
    if (previous.zoomEnabled && !next.zoomEnabled) {
      for (const capture of [...activeByConversation.values()]) {
        removeActive(capture);
        capture.session.stop();
      }
    }
  });

  bb.onDispose(() => {
    disposed = true;
    for (const capture of [...activeByConversation.values()]) {
      removeActive(capture);
      capture.session.dispose();
    }
    replayCache.clear();
  });

  return {
    stop(conversationId) {
      const capture = activeByConversation.get(conversationId);
      if (!capture) return;
      removeActive(capture);
      capture.session.stop();
    },
    async status() {
      const current = await settings.get();
      return {
        configured: Boolean(
          current.zoomClientId?.trim() &&
          current.zoomClientSecret?.trim() &&
          current.zoomWebhookSecret?.trim()
        ),
        enabled: current.zoomEnabled,
        canCreateRooms: Boolean(
          current.zoomAccountId?.trim() &&
          current.zoomApiClientId?.trim() &&
          current.zoomApiClientSecret?.trim() &&
          current.zoomHostUser?.trim()
        ),
      };
    },
    async addRegistrant(roomId: string, person: {name: string; email: string}) {
      const room = sink.getRoom(roomId);
      const api = await restClient();
      if (!api) throw new Error("Registering a person needs the Server-to-Server credential in plugin settings.");
      const name = z.string().trim().min(1).max(200).parse(person.name);
      const email = z.string().trim().email().max(320).parse(person.email);
      // Zoom splits the display name into two fields and rejoins them with a space, so the
      // remainder of the name goes in the last-name field rather than being dropped.
      const cut = name.indexOf(" ");
      const firstName = cut === -1 ? name : name.slice(0, cut);
      const lastName = cut === -1 ? "-" : name.slice(cut + 1);
      const issued = await api.addRegistrant(room.externalId, { email, firstName, lastName });
      return sink.createRegistrant({
        roomId: room.id, name, email,
        externalId: issued.registrantId, joinUrl: issued.joinUrl,
      });
    },
    async deleteRoom(roomId: string) {
      const room = sink.getRoom(roomId);
      const api = await restClient();
      if (!api) throw new Error("Deleting a room needs the Server-to-Server credential in plugin settings.");
      await api.deleteMeeting(room.externalId);
      // Recorded only after Zoom confirms, so the hub never claims a meeting is gone while it
      // is still reachable. Conversations keep their roomId, so past sittings stay readable.
      return sink.markRoomDeleted(room.id);
    },
    async renewRoom(roomId: string) {
      const room = sink.getRoom(roomId);
      const api = await restClient();
      if (!api) throw new Error("Renewing a room needs the Server-to-Server credential in plugin settings.");
      const expiresAt = await api.renewRoomMeeting(room.externalId);
      return sink.setRoomExpiry(room.id, expiresAt);
    },
    async createRoom(name: string) {
      const current = await settings.get();
      const hostUser = current.zoomHostUser?.trim();
      const api = await restClient();
      if (!api || !hostUser) {
        throw new Error("Zoom room creation needs the account ID, Server-to-Server credential and host user in plugin settings.");
      }
      const topic = z.string().trim().min(1).max(200).parse(name);
      const meeting = await api.createRoomMeeting(hostUser, topic);
      // Recorded only after Zoom confirms, so a stored room always has a working join URL.
      return sink.createRoom({
        name: meeting.topic,
        sourceId: "zoom",
        externalId: meeting.meetingId,
        joinUrl: meeting.joinUrl,
        hostUser,
        expiresAt: meeting.expiresAt,
      });
    },
  };
}
