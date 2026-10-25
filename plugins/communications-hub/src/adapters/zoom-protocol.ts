import { ZoomPortraitSampler } from "./zoom-portrait-sampler.js";
import { createHash, createHmac } from "node:crypto";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import type { ClientRequestArgs } from "node:http";
import WebSocket from "ws";
import { z } from "zod";
import type { CaptureState, SegmentInput } from "../domain.js";
import type { PresenceEvent } from "../presence/roster.js";
import type { PortraitFrame } from "../presence/portraits.js";
import {
  ZOOM_VIDEO_DATA,
  ZOOM_VIDEO_MEDIA_PARAMS,
  decodeZoomPortraitFrame,
  decodeZoomPresenceEvents,
  eventSubscriptionFrame,
  type ZoomPresenceCodes,
} from "./zoom-presence.js";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAYS_MS = [3_000, 6_000, 12_000, 24_000] as const;

const handshakeResponseSchema = z.object({
  msg_type: z.literal(2),
  status_code: z.number().int(),
  reason: z.string().optional(),
  media_server: z
    .object({
      server_urls: z.object({
        transcript: z.string(),
        // Present only for a deployment whose own Zoom app has video access.
        // Absent is the normal case and is not an error: portraits are optional
        // and their absence never touches the transcript socket.
        video: z.string().optional(),
      }).passthrough(),
    })
    .optional(),
}).passthrough();

const dataHandshakeResponseSchema = z.object({
  msg_type: z.literal(4),
  status_code: z.number().int(),
  reason: z.string().optional(),
}).passthrough();

const keepAliveSchema = z.object({
  msg_type: z.literal(12),
  timestamp: z.union([z.number(), z.string()]),
}).passthrough();

const transcriptSchema = z.object({
  msg_type: z.literal(17),
  content: z.object({
    user_id: z.union([z.number(), z.string()]).optional(),
    user_name: z.string().optional(),
    channel_id: z.string().optional(),
    start_time: z.number().int().nonnegative(),
    end_time: z.number().int().nonnegative(),
    timestamp: z.number().int().nonnegative(),
    language: z.number().int().optional(),
    data: z.string().min(1).max(MAX_MESSAGE_BYTES),
  }).passthrough().refine((content) => content.end_time >= content.start_time),
}).passthrough();

type SocketHandlers = {
  open(): void;
  message(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  error(error: Error): void;
};

export interface RtmsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RtmsSocketFactory = (url: string, handlers: SocketHandlers) => RtmsSocket;

/**
 * Optional presence and portrait wiring.
 *
 * Both halves are strictly additive: with `presence.enabled` false the session
 * sends exactly the frames it has always sent, and with `video.enabled` false it
 * opens exactly the sockets it has always opened. Nothing in either path is
 * allowed to change transcript capture — a refused subscription, a refused video
 * handshake, or a malformed frame is reported and dropped.
 */
export interface ZoomPresenceOptions {
  enabled: boolean;
  codes: ZoomPresenceCodes;
  onEvents(events: PresenceEvent[]): unknown;
  /**
   * The clock observations are stamped with.
   *
   * Supplied by the adapter so that the stamp and the roster's decay window are
   * read from ONE clock. Two clocks disagreeing by a few seconds is enough to
   * make a speaking ring that is already expired when it arrives.
   */
  now?(): number;
  /**
   * This session will not be reporting participants after all.
   *
   * Presence is only ever as true as the subscription behind it. A frame that
   * could not be sent means no event will ever arrive, and a roster left
   * standing on capture's own "capturing" state would be a live-looking room
   * nobody is reporting on. Capture itself is untouched.
   */
  onUnavailable?(detail: string): unknown;
}

export interface ZoomVideoOptions {
  enabled: boolean;
  onFrame(frame: PortraitFrame): unknown;
  /** Called once when this session will not be producing stills after all. */
  onUnavailable(detail: string): unknown;
  /**
   * A video-data frame arrived that could not be used.
   *
   * Reported rather than swallowed so it spends the VIDEO failure budget: a
   * feed that is sending us nothing we can read should retire, and the only way
   * that happens is if somebody counts. No bytes and no reason that could carry
   * payload are passed — the caller is told that a frame was unusable, nothing
   * more.
   */
  onUnusableFrame?(): unknown;
  /** Asked before each frame is offered, so a spent failure budget stops the feed. */
  shouldContinue?(): boolean;
}

export interface ZoomRtmsSessionOptions {
  meetingUuid: string;
  streamId: string;
  signalingUrl: string;
  clientId: string;
  clientSecret: string;
  anchorMs: number;
  socketFactory: RtmsSocketFactory;
  onSegments(segments: SegmentInput[]): unknown;
  onState(state: CaptureState, detail?: string | null): unknown;
  onTerminal?(): unknown;
  presence?: ZoomPresenceOptions;
  video?: ZoomVideoOptions;
  /**
   * Optional wire diagnostics sink for capture bring-up. Receives connection
   * close codes, socket errors and rejected handshake status codes only;
   * transcript content is never passed here.
   */
  log?(message: string): unknown;
}

function isPrivateOrSpecialIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.startsWith("::ffff:")) return isPrivateOrSpecialIp(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return true;
}

/** Reject destinations that could turn a signed webhook into an SSRF primitive. */
export function assertSafeZoomWssUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Zoom RTMS destination is not a valid URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "wss:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0
  ) {
    throw new Error("Zoom RTMS destination must be a public WSS hostname on port 443");
  }
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

type LookupImplementation = (
  hostname: string,
  options: { all: true } & Record<string, unknown>,
  callback: (error: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void,
) => void;

/**
 * DNS lookup that drops private and special-use addresses, so a signed webhook
 * cannot steer the RTMS socket at an internal host.
 *
 * net calls lookup with all: true whenever autoSelectFamily is on, which is the
 * Node default, and then expects the full array back. Answering such a call
 * with a single address makes net read .address off a string and fail with
 * "Invalid IP address: undefined", so the caller's all flag decides the shape
 * of the answer.
 */
export function createPublicOnlyLookup(implementation: LookupImplementation) {
  return function publicOnly(
    hostname: string,
    options: { all?: boolean } & Record<string, unknown>,
    callback: (
      error: NodeJS.ErrnoException | null,
      addressOrAddresses: string | ResolvedAddress[],
      family?: number,
    ) => void,
  ): void {
    implementation(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const publicAddresses = addresses.filter((entry) => !isPrivateOrSpecialIp(entry.address));
      const selected = publicAddresses[0];
      if (!selected) {
        callback(new Error("Zoom RTMS destination resolved to a non-public address"), "", 0);
        return;
      }
      if (options.all === true) {
        callback(null, publicAddresses);
        return;
      }
      callback(null, selected.address, selected.family);
    });
  };
}

const publicOnlyLookup = createPublicOnlyLookup(lookup as unknown as LookupImplementation);

/** Production transport validates the DNS answer used by the actual socket. */
export const zoomWebSocketFactory: RtmsSocketFactory = (value, handlers) => {
  const url = assertSafeZoomWssUrl(value);
  const socket = new WebSocket(url, {
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    lookup: publicOnlyLookup as unknown as ClientRequestArgs["lookup"],
  });
  socket.on("open", handlers.open);
  socket.on("message", (data) => {
    if (typeof data === "string") handlers.message(data);
    else if (Array.isArray(data)) handlers.message(Buffer.concat(data));
    else handlers.message(new Uint8Array(data as ArrayBuffer));
  });
  socket.on("close", (code, reason) => handlers.close(code, reason.toString()));
  socket.on("error", handlers.error);
  return {
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close(code, reason) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    },
  };
};

function asJson(data: string | Uint8Array): unknown | null {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function splitBoundedText(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 2_000) {
      if (chunk.trim()) chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk.trim()) chunks.push(chunk);
  return chunks;
}

function truncateUtf16(value: string, max: number): string {
  let result = "";
  for (const character of value) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result;
}

export class ZoomRtmsSession {
  private signaling?: RtmsSocket;
  private media?: RtmsSocket;
  private video?: RtmsSocket;
  private videoUrl?: string;
  private videoRetired = false;
  /** One CLIENT_READY_ACK per video media connection, and no more. */
  private videoReadyAcknowledged = false;
  private readonly portraitSampler = new ZoomPortraitSampler((id, subscribe) => {
    if (!this.signaling || this.videoRetired) return;
    try {
      this.signaling.send(JSON.stringify({ msg_type: 28, user_id: Number(id), subscribe, timestamp: Date.now() }));
    } catch {
      this.retireVideo("Zoom video subscription failed");
    }
  }, () => this.options.presence?.now?.() ?? Date.now());
  /**
   * Which signaling connection the other sockets belong to.
   *
   * Every socket Zoom hands us is addressed by a signaling handshake, so a
   * replaced signaling connection invalidates them all. The counter is what
   * lets a late callback from a superseded video socket be recognised as such
   * even if the object identity check somehow passed.
   */
  private signalingGeneration = 0;
  private transcriptUrl?: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private signalingAttempts = 0;
  private mediaAttempts = 0;
  private disposed = false;
  private terminal = false;

  constructor(private readonly options: ZoomRtmsSessionOptions) {
    assertSafeZoomWssUrl(options.signalingUrl);
  }

  start(): void {
    if (this.disposed || this.terminal) return;
    this.emitState("connecting", "Waiting for Zoom RTMS transcript stream");
    this.openSignaling();
  }

  stop(): void {
    if (this.disposed || this.terminal) return;
    this.terminal = true;
    this.clearReconnect();
    this.safeSend(this.signaling, { msg_type: 21, rtms_stream_id: this.options.streamId });
    this.closeSockets();
    this.emitState("stopped", "Stopped on this BB instance");
    this.options.onTerminal?.();
  }

  end(state: "ended" | "interrupted" | "stopped", detail: string): void {
    if (this.disposed || this.terminal) return;
    this.terminal = true;
    this.clearReconnect();
    this.closeSockets();
    this.emitState(state, detail);
    this.options.onTerminal?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearReconnect();
    this.closeSockets();
    if (!this.terminal) this.emitState("interrupted", "Zoom adapter was disposed");
    this.options.onTerminal?.();
  }

  private openSignaling(): void {
    if (this.disposed || this.terminal) return;
    // A new signaling connection is a new generation: whatever the previous one
    // was holding open is no longer addressed by a handshake we own.
    this.signalingGeneration += 1;
    let socket: RtmsSocket;
    try {
      socket = this.options.socketFactory(this.options.signalingUrl, {
        open: () => {
          if (this.signaling !== socket) return;
          this.safeSend(socket, {
            msg_type: 1,
            protocol_version: 1,
            sequence: Date.now(),
            meeting_uuid: this.options.meetingUuid,
            rtms_stream_id: this.options.streamId,
            signature: this.handshakeSignature(),
            buffer_data: false,
          });
        },
        message: (data) => {
          if (this.signaling === socket) this.handleSignaling(data);
        },
        close: (code, reason) => {
          if (this.signaling !== socket) return;
          this.wireDebug("signaling closed", { code, reason, attempts: this.signalingAttempts });
          this.signaling = undefined;
          this.closeMedia();
          // The video socket was opened against THIS signaling handshake. Left
          // alive it would keep feeding stills from a connection we no longer
          // own, and `openVideo` would find `this.video` still set and never
          // open the replacement. It is closed, not retired: the next
          // generation opens its own.
          this.closeVideo();
          this.retrySignaling("Zoom signaling connection closed");
        },
        error: (error) => {
          if (this.signaling !== socket) return;
          this.wireDebug("signaling error", { message: error.message });
          this.emitState("interrupted", "Zoom signaling connection failed");
        },
      });
      this.signaling = socket;
    } catch {
      this.retrySignaling("Zoom signaling connection failed");
    }
  }

  private openMedia(url = this.transcriptUrl): void {
    if (this.disposed || this.terminal || !url || !this.signaling) return;
    this.transcriptUrl = assertSafeZoomWssUrl(url).href;
    let socket: RtmsSocket;
    try {
      socket = this.options.socketFactory(this.transcriptUrl, {
        open: () => {
          if (this.media !== socket) return;
          this.safeSend(socket, {
            msg_type: 3,
            protocol_version: 1,
            sequence: Date.now(),
            meeting_uuid: this.options.meetingUuid,
            rtms_stream_id: this.options.streamId,
            signature: this.handshakeSignature(),
            media_type: 8,
            media_params: { transcript: { content_type: 5 } },
            payload_encryption: false,
          });
        },
        message: (data) => {
          if (this.media === socket) this.handleMedia(data);
        },
        close: (code, reason) => {
          if (this.media !== socket) return;
          this.wireDebug("transcript closed", { code, reason, attempts: this.mediaAttempts });
          this.media = undefined;
          this.retryMedia("Zoom transcript connection closed");
        },
        error: (error) => {
          if (this.media !== socket) return;
          this.wireDebug("transcript error", { message: error.message });
          this.emitState("interrupted", "Zoom transcript connection failed");
        },
      });
      this.media = socket;
    } catch {
      this.retryMedia("Zoom transcript connection failed");
    }
  }

  private handleSignaling(data: string | Uint8Array): void {
    const value = asJson(data);
    if (!value || typeof value !== "object") return;
    const keepAlive = keepAliveSchema.safeParse(value);
    if (keepAlive.success) {
      this.safeSend(this.signaling, { msg_type: 13, timestamp: keepAlive.data.timestamp });
      return;
    }
    const handshake = handshakeResponseSchema.safeParse(value);
    if (handshake.success) {
      if (handshake.data.status_code !== 0 || !handshake.data.media_server) {
        this.wireDebug("signaling handshake rejected", {
          statusCode: handshake.data.status_code,
          hasMediaServer: Boolean(handshake.data.media_server),
        });
        this.end("interrupted", "Zoom rejected the signaling handshake");
        return;
      }
      this.signalingAttempts = 0;
      this.videoUrl = handshake.data.media_server.server_urls.video;
      try {
        this.openMedia(handshake.data.media_server.server_urls.transcript);
      } catch {
        this.end("interrupted", "Zoom supplied an unsafe transcript destination");
      }
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.msg_type === 6 && (message.event as Record<string, unknown> | undefined)?.event_type === 7) {
      this.closeMedia();
      this.retryMedia("Zoom transcript connection was interrupted");
      return;
    }
    if (message.msg_type === 8) this.applyStreamState(message.state);
    if (message.msg_type === 9) this.applySessionState(message.state);
    if (message.msg_type === 29 && message.status_code !== 0 && message.user_id !== undefined) {
      this.portraitSampler.rejected(String(message.user_id));
    }
    this.handlePresence(message);
  }

  /**
   * Presence observations ride the signaling socket beside everything else.
   *
   * Decoding runs last and returns nothing for every message the transcript path
   * already understood, so adding it cannot change how a keep-alive, a handshake
   * or a stream-state message is handled. A decoder failure is contained here:
   * presence is the feature that degrades, never capture.
   */
  private handlePresence(message: Record<string, unknown>): void {
    const presence = this.options.presence;
    if (!presence?.enabled) return;
    try {
      const events = decodeZoomPresenceEvents(message, presence.codes, presence.now?.() ?? Date.now());
      if (events.length > 0) presence.onEvents(events);
      if (this.options.video?.enabled && !this.videoRetired) {
        for (const event of events) this.portraitSampler.event(event);
      }
    } catch (error) {
      this.wireDebug("presence decode failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private handleMedia(data: string | Uint8Array): void {
    const value = asJson(data);
    if (!value || typeof value !== "object") return;
    const keepAlive = keepAliveSchema.safeParse(value);
    if (keepAlive.success) {
      this.safeSend(this.media, { msg_type: 13, timestamp: keepAlive.data.timestamp });
      return;
    }
    const handshake = dataHandshakeResponseSchema.safeParse(value);
    if (handshake.success) {
      if (handshake.data.status_code !== 0) {
        this.wireDebug("transcript handshake rejected", { statusCode: handshake.data.status_code });
        this.end("interrupted", "Zoom rejected the transcript handshake");
        return;
      }
      this.mediaAttempts = 0;
      this.safeSend(this.signaling, { msg_type: 7, rtms_stream_id: this.options.streamId });
      this.emitState("capturing", "Receiving Zoom transcript");
      // Only after transcript capture is established: the two optional paths ask
      // for things this app may have no access to, and neither is allowed to
      // delay or endanger the stream people rely on.
      this.subscribePresence();
      this.openVideo();
      return;
    }
    const transcript = transcriptSchema.safeParse(value);
    if (!transcript.success) return;
    const content = transcript.data.content;
    const speaker = content.user_name ? truncateUtf16(content.user_name, 200) : null;
    // Zoom display names are self-chosen free text: two participants can share one, and a
    // participant can change theirs mid-meeting. user_id is Zoom's own participant identity
    // for this occurrence, so it is what actually distinguishes speakers.
    const speakerId = content.user_id === undefined || content.user_id === null
      ? null
      : truncateUtf16(String(content.user_id), 200);
    const fingerprint = createHash("sha256").update(JSON.stringify({
      meetingUuid: this.options.meetingUuid,
      userId: content.user_id ?? null,
      speaker,
      startTime: content.start_time,
      endTime: content.end_time,
      timestamp: content.timestamp,
      text: content.data,
    })).digest("hex");
    const segments = splitBoundedText(content.data).map((text, index): SegmentInput => ({
      sourceKey: `zoom:${fingerprint}:${index}`,
      speaker,
      speakerId,
      text,
      startMs: Math.max(0, content.start_time - this.options.anchorMs),
      endMs: Math.max(0, content.end_time - this.options.anchorMs),
    }));
    if (segments.length > 0) this.options.onSegments(segments);
  }

  private retrySignaling(detail: string): void {
    if (this.disposed || this.terminal) return;
    this.emitState("interrupted", detail);
    if (this.signalingAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.terminal = true;
      this.closeSockets();
      this.options.onTerminal?.();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.signalingAttempts++]!;
    this.schedule(() => this.openSignaling(), delay);
  }

  private retryMedia(detail: string): void {
    if (this.disposed || this.terminal || !this.signaling || !this.transcriptUrl) return;
    this.emitState("interrupted", detail);
    if (this.mediaAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.terminal = true;
      this.closeSockets();
      this.options.onTerminal?.();
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.mediaAttempts++]!;
    this.schedule(() => this.openMedia(), delay);
  }

  private schedule(callback: () => void, delay: number): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      callback();
    }, delay);
  }

  private applyStreamState(state: unknown): void {
    if (state === 1 || state === 6) this.emitState("capturing", "Receiving Zoom transcript");
    else if (state === 2) this.emitState("interrupted", "Zoom RTMS stream interrupted");
    else if (state === 5) this.emitState("paused", "Zoom RTMS stream paused");
    else if (state === 3 || state === 4) this.end("ended", "Zoom RTMS stream ended");
  }

  private applySessionState(state: unknown): void {
    if (state === 3) this.emitState("paused", "Zoom RTMS session paused");
    else if (state === 2 || state === 4) this.emitState("capturing", "Receiving Zoom transcript");
    else if (state === 5) this.end("ended", "Zoom RTMS session ended");
  }

  private wireDebug(event: string, detail: Record<string, unknown>): void {
    this.options.log?.(`zoom ${event} ${JSON.stringify(detail)}`);
  }

  private handshakeSignature(): string {
    return createHmac("sha256", this.options.clientSecret)
      .update(`${this.options.clientId},${this.options.meetingUuid},${this.options.streamId}`)
      .digest("hex");
  }

  private safeSend(socket: RtmsSocket | undefined, value: unknown): void {
    if (!socket) return;
    try {
      socket.send(JSON.stringify(value));
    } catch {
      this.emitState("interrupted", "Zoom RTMS connection failed while sending");
    }
  }

  /**
   * Ask Zoom for participant and active-speaker events.
   *
   * Deliberately not `safeSend`: that reports a failed send as an interrupted
   * CAPTURE, which would be a lie here. A subscription that cannot be sent means
   * there are no presence events, and the strip says so.
   */
  private subscribePresence(): void {
    const presence = this.options.presence;
    if (!presence?.enabled) return;
    try {
      if (!this.signaling) throw new Error("no signaling connection");
      this.signaling.send(JSON.stringify(eventSubscriptionFrame(presence.codes)));
    } catch (error) {
      this.wireDebug("presence subscription failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      try {
        presence.onUnavailable?.("Zoom did not accept the participant-event subscription");
      } catch {
        // Presence wiring must never be able to fault the capture session.
      }
    }
  }

  /**
   * Open the optional still feed.
   *
   * Everything about this socket is allowed to fail. No video URL, an unsafe
   * one, a refused handshake, a dropped connection, a spent failure budget —
   * each retires the feed for this session with a reason, and none of them
   * touches capture state, the transcript socket, or the reconnect budget.
   */
  private openVideo(url = this.videoUrl): void {
    const video = this.options.video;
    if (!video?.enabled || this.disposed || this.terminal || this.videoRetired || this.video) return;
    if (!url) {
      this.retireVideo("Zoom offered no video stream for this meeting");
      return;
    }
    let safeUrl: string;
    try {
      safeUrl = assertSafeZoomWssUrl(url).href;
    } catch {
      this.retireVideo("Zoom supplied an unsafe video destination");
      return;
    }
    this.videoUrl = safeUrl;
    const generation = this.signalingGeneration;
    /** A socket from a replaced signaling generation speaks for nobody. */
    const current = (candidate: RtmsSocket): boolean =>
      this.video === candidate && generation === this.signalingGeneration;
    try {
      const socket = this.options.socketFactory(safeUrl, {
        open: () => {
          if (!current(socket)) return;
          this.safeVideoSend(socket, {
            msg_type: 3,
            protocol_version: 1,
            sequence: Date.now(),
            meeting_uuid: this.options.meetingUuid,
            rtms_stream_id: this.options.streamId,
            signature: this.handshakeSignature(),
            ...ZOOM_VIDEO_MEDIA_PARAMS,
            payload_encryption: false,
          });
        },
        message: (data) => {
          if (current(socket)) this.handleVideo(data);
        },
        close: (code, reason) => {
          if (!current(socket)) return;
          this.wireDebug("video closed", { code, reason });
          this.video = undefined;
          this.retireVideo("Zoom video stream closed");
        },
        error: (error) => {
          if (!current(socket)) return;
          this.wireDebug("video error", { message: error.message });
        },
      });
      this.video = socket;
    } catch {
      this.retireVideo("Zoom video connection failed");
    }
  }

  private handleVideo(data: string | Uint8Array): void {
    const video = this.options.video;
    if (!video?.enabled) return;
    const value = asJson(data);
    if (!value || typeof value !== "object") return;
    const keepAlive = keepAliveSchema.safeParse(value);
    if (keepAlive.success) {
      this.safeVideoSend(this.video, { msg_type: 13, timestamp: keepAlive.data.timestamp });
      return;
    }
    const handshake = dataHandshakeResponseSchema.safeParse(value);
    if (handshake.success) {
      // A refused video handshake is the expected answer for an app without
      // video access. It retires the feed and says nothing about the transcript.
      if (handshake.data.status_code !== 0) {
        this.wireDebug("video handshake rejected", { statusCode: handshake.data.status_code });
        this.retireVideo("Zoom refused the video stream; portraits are unavailable");
        return;
      }
      this.acknowledgeVideoReady();
      if (!this.videoRetired) this.portraitSampler.start();
      return;
    }
    // Anything else on this socket that is not video data is not the video
    // feed failing — a keep-alive, or a message type we never asked for. It is
    // ignored without spending the budget that exists to retire a BROKEN feed.
    if ((value as Record<string, unknown>).msg_type !== ZOOM_VIDEO_DATA) return;
    if (video.shouldContinue && !video.shouldContinue()) {
      this.retireVideo("Too many unusable video frames; portraits are unavailable");
      return;
    }
    const frame = decodeZoomPortraitFrame(value);
    // Frame contents are never logged: a rejected still is counted by the
    // portrait store, and its bytes go no further than this function.
    if (frame) {
      if (this.portraitSampler.wants(frame.participantId)) {
        const accepted = video.onFrame(frame);
        if (accepted !== false) this.portraitSampler.captured(frame.participantId);
      }
      return;
    }
    // A video-data frame we could not read is a failure of this feed, and has
    // to be counted as one: otherwise a feed sending nothing but garbage is
    // indistinguishable from a quiet meeting and never retires.
    try {
      video.onUnusableFrame?.();
    } catch {
      // Counting a failure must never be able to fault the capture session.
    }
  }

  /**
   * Tell signaling this app is ready for the VIDEO media connection.
   *
   * Zoom documents CLIENT_READY_ACK as the answer to a data handshake response
   * "from the media connection", sent on the signaling connection once "the
   * signaling and media connections have been established", and says media data
   * follows it (developers.zoom.us/docs/rtms/event-reference/, "Client ready
   * ACK message", read 2026-09-18). The video socket is a second media
   * connection opened after the transcript one, so the acknowledgement the
   * transcript handshake sent does not cover it: without this, a compliant
   * server has been told nothing about the video connection's readiness.
   *
   * Sent once per video socket, and never for a handshake Zoom refused. It is
   * deliberately not `safeSend`: a failed send here means no stills, which is a
   * retired video feed, NOT an interrupted transcript capture.
   */
  private acknowledgeVideoReady(): void {
    if (this.videoReadyAcknowledged || !this.video) return;
    this.videoReadyAcknowledged = true;
    const signaling = this.signaling;
    if (!signaling) {
      this.retireVideo("Zoom video stream could not be acknowledged; portraits are unavailable");
      return;
    }
    try {
      signaling.send(JSON.stringify({ msg_type: 7, rtms_stream_id: this.options.streamId }));
    } catch (error) {
      this.wireDebug("video ready ack failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
      this.retireVideo("Zoom video stream could not be acknowledged; portraits are unavailable");
    }
  }

  private retireVideo(detail: string): void {
    if (this.videoRetired) return;
    this.videoRetired = true;
    this.closeVideo();
    try {
      this.options.video?.onUnavailable(detail);
    } catch {
      // Portrait wiring must never be able to fault the capture session.
    }
  }

  private safeVideoSend(socket: RtmsSocket | undefined, value: unknown): void {
    if (!socket) return;
    try {
      socket.send(JSON.stringify(value));
    } catch {
      this.retireVideo("Zoom video connection failed while sending");
    }
  }

  private closeVideo(): void {
    this.portraitSampler.reset();
    const socket = this.video;
    this.video = undefined;
    // The next video socket is a new media connection and needs its own ack.
    this.videoReadyAcknowledged = false;
    try {
      socket?.close(1000, "closing");
    } catch {
      // Best-effort: the feed is optional and its teardown is idempotent.
    }
  }

  private closeMedia(): void {
    const socket = this.media;
    this.media = undefined;
    try {
      socket?.close(1000, "closing");
    } catch {
      // The state transition is handled by the caller; close is best-effort.
    }
  }

  private closeSockets(): void {
    const signaling = this.signaling;
    this.signaling = undefined;
    this.closeVideo();
    this.closeMedia();
    try {
      signaling?.close(1000, "closing");
    } catch {
      // Socket disposal remains idempotent when the transport already failed.
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emitState(state: CaptureState, detail?: string | null): void {
    this.options.onState(state, detail);
  }
}
