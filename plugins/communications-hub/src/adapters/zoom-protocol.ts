import { createHash, createHmac } from "node:crypto";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import type { ClientRequestArgs } from "node:http";
import WebSocket from "ws";
import { z } from "zod";
import type { CaptureState, SegmentInput } from "../domain.js";

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_RECONNECT_ATTEMPTS = 4;
const RECONNECT_DELAYS_MS = [3_000, 6_000, 12_000, 24_000] as const;

const handshakeResponseSchema = z.object({
  msg_type: z.literal(2),
  status_code: z.number().int(),
  reason: z.string().optional(),
  media_server: z
    .object({ server_urls: z.object({ transcript: z.string() }).passthrough() })
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
