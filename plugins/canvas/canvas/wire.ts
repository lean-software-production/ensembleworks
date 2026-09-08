// The bb-specific wire contract shared by the backend room host and the
// frontend transport. Kept dependency-free on purpose: transport.ts is bundled
// into the frontend, so it must not reach anything that drags SyncServerPeer,
// better-sqlite3, or node:buffer along with it.

/** The one room this spike serves. */
export const ROOM_ID = "main";

/** The realtime channel every server -> client frame is published on. */
export const CANVAS_CHANNEL = "canvas:main";

/**
 * The realtime channel agent-thread status rides. Deliberately SEPARATE from
 * CANVAS_CHANNEL: that channel carries opaque CRDT frames at pointer cadence
 * and four decoders already race over every publish on it, whereas this one
 * carries a handful of small, human-scale status messages. Splitting them
 * means a panel that only wants badges is not decoding frame envelopes, and a
 * malformed status message can never be mistaken for a frame.
 */
export const AGENT_CHANNEL = "canvas:threads";

/**
 * The realtime channel the room transcript rides — one message per ingested
 * utterance. Separate from the other two for the same reason they are separate
 * from each other: a panel that only wants to tail the conversation should not
 * be decoding CRDT frame envelopes at pointer cadence, and a transcript line is
 * human-scale, low-rate, and interesting to surfaces that have no canvas at all.
 */
export const TRANSCRIPT_CHANNEL = "canvas:transcript";

/**
 * One utterance in the room. The SAME object is the scribe route's input, the
 * durable row, the realtime message, and the rpc result — one shape, no
 * translation layer.
 *
 * `ts` is epoch milliseconds. The scribe service (LiveKit -> Whisper, on the
 * VM) may stamp its own — an utterance is timed by when it was SPOKEN, not by
 * when the POST happened to land — and the route defaults it to server now when
 * it does not.
 */
export interface TranscriptEntry {
  ts: number;
  speaker: string;
  text: string;
}

/**
 * Decode a realtime payload from TRANSCRIPT_CHANNEL, or null when it is not a
 * well-formed entry. Every field is checked for the same reason `agentLinkFrom`
 * checks its own: this reaches React as a row's key, colour and text, and a
 * malformed message should cost one line, never the panel.
 */
export function transcriptEntryFrom(payload: unknown): TranscriptEntry | null {
  if (typeof payload !== "object" || payload === null) return null;
  const entry = payload as Partial<TranscriptEntry>;
  if (typeof entry.ts !== "number" || !Number.isFinite(entry.ts)) return null;
  if (typeof entry.speaker !== "string" || entry.speaker.length === 0) return null;
  if (typeof entry.text !== "string" || entry.text.length === 0) return null;
  return { ts: entry.ts, speaker: entry.speaker, text: entry.text };
}

/**
 * A canvas note's linked agent thread, as both the realtime status message and
 * the durable kv row. Three states, mapped 1:1 from the three bb thread
 * lifecycle events that MOVE a badge:
 *
 *   thread.active -> "running"   thread.idle -> "idle"   thread.failed -> "failed"
 *
 * There is deliberately no "queued"/"unknown": a link is created at spawn time
 * already "running", so every link a client ever sees is in one of these three.
 *
 * The other two events this plugin listens to — `thread.archived` and
 * `thread.deleted` — deliberately have NO status of their own. A thread that
 * has ended is not a fourth badge colour, it is the absence of a badge: there
 * is nothing left to open, so the link is removed and a `CanvasAgentUnlink`
 * goes out instead.
 */
export const AGENT_STATUSES = ["running", "idle", "failed"] as const;
export type CanvasAgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * One shape -> thread link. The SAME object is the rpc result, the realtime
 * message on AGENT_CHANNEL, and the kv value — one shape so there is no
 * translation layer to keep in step.
 */
export interface CanvasAgentLink {
  shapeId: string;
  threadId: string;
  status: CanvasAgentStatus;
}

/**
 * Decode a realtime payload from AGENT_CHANNEL, or null when it is not a
 * well-formed link. Every field is checked because this reaches React as a
 * badge's key, tooltip, and the threadId a ThreadChat is mounted with — a
 * malformed message should lose its own badge, never break the overlay.
 */
export function agentLinkFrom(payload: unknown): CanvasAgentLink | null {
  if (typeof payload !== "object" || payload === null) return null;
  const link = payload as Partial<CanvasAgentLink>;
  if (typeof link.shapeId !== "string" || link.shapeId.length === 0) return null;
  if (typeof link.threadId !== "string" || link.threadId.length === 0) return null;
  if (!(AGENT_STATUSES as readonly unknown[]).includes(link.status)) return null;
  return {
    shapeId: link.shapeId,
    threadId: link.threadId,
    status: link.status as CanvasAgentStatus,
  };
}

/**
 * Server -> client "this note has no agent thread any more", published on
 * AGENT_CHANNEL when a link ENDS: its thread was archived or deleted in bb, or
 * a human chose "Unlink thread" on the badge.
 *
 * Carries no threadId on purpose. The shape id is the whole address a client
 * needs (`agentLinks` is keyed by it) and naming the dead thread would invite a
 * receiver to match on it — which is exactly the check that goes wrong after a
 * note has been re-run, because the tab's link may already point at a NEWER
 * thread than the one the server is retiring.
 *
 * `unlinked: true` is a literal discriminator in the same style as
 * `CanvasResync`'s `resync`, so one subscriber can tell a removal from a status
 * message without either decoder having to know about the other: a status
 * message has a `threadId` and a `status`, a removal has neither, and
 * `agentLinkFrom` / `agentUnlinkFrom` each reject the other's payload outright.
 */
export interface CanvasAgentUnlink {
  shapeId: string;
  unlinked: true;
}

/**
 * Decode a realtime removal from AGENT_CHANNEL, or null when the payload is not
 * one. Checked as strictly as `agentLinkFrom` and for the same reason: this
 * DELETES a badge, so a malformed message must cost nothing rather than clear a
 * badge the user is still using.
 */
export function agentUnlinkFrom(payload: unknown): CanvasAgentUnlink | null {
  if (typeof payload !== "object" || payload === null) return null;
  const message = payload as Partial<CanvasAgentUnlink>;
  if (message.unlinked !== true) return null;
  if (typeof message.shapeId !== "string" || message.shapeId.length === 0) {
    return null;
  }
  return { shapeId: message.shapeId, unlinked: true };
}

/** Everything the backend publishes on AGENT_CHANNEL. */
export type CanvasAgentMessage = CanvasAgentLink | CanvasAgentUnlink;

/**
 * Server -> client envelope. realtime is broadcast-only, so `to` is the
 * address and every client drops envelopes that are not its own. `data` is a
 * base64 canvas-sync frame.
 */
export interface CanvasEnvelope {
  to: string;
  data: string;
}

/** Client -> server, the `canvas_frame` rpc input. */
export interface CanvasFramePayload {
  clientId: string;
  data: string;
}

/**
 * Server -> client "the room host just (re)started" broadcast, published once
 * per plugin load. A plugin reload throws away every server-side transport
 * while browser tabs keep their SyncClientPeer alive; a tab that happens to
 * send a frame re-joins itself (CanvasRoomHost.frame auto-joins), but an idle
 * tab would sit stranded, silently missing every later update. This is the
 * push that tells it to re-join. `epoch` is the load's own timestamp, so a
 * client can ignore a hello it has already acted on.
 */
export interface CanvasServerHello {
  hello: number;
}

/**
 * Server -> client "I do not think you are connected — re-handshake" push,
 * addressed to one client.
 *
 * The room drops a client from its set for reasons the CLIENT cannot observe:
 * the idle sweep closed it, or a plugin reload replaced the whole room host and
 * this client missed the hello. Either way the server stops relaying to it, and
 * the client's SyncClientPeer has no way to notice — it is not waiting on
 * anything, so it just silently stops receiving updates until the page reloads.
 *
 * So the server says so, at the two moments it learns a client thought it was
 * connected and was not: an inbound frame from an unknown client (auto-join,
 * see CanvasRoomHost.frame) and a `canvas_ping` from one (see its rpc handler,
 * which answers `connected: false` rather than publishing). The client's
 * response is a full resync — re-join, then peer.reconnect, which re-arms the
 * handshake and pulls whatever it missed.
 */
export interface CanvasResync {
  to: string;
  resync: true;
}

/**
 * Server -> client "here is who is in the room", broadcast to everyone
 * whenever the membership or a name changes (join, leave, idle sweep).
 *
 * canvas-sync's `Presence` carries no identity fields and this spike may not
 * modify canvas-sync, so names travel BESIDE presence rather than inside it:
 * a plain clientId -> display-name map, joined to cursors at render time. The
 * join is exact because a `PresenceStore` is constructed with this panel's own
 * `clientId` as its self key, so the presence map and this map share keys.
 *
 * Unaddressed on purpose — every client needs every name.
 */
export interface CanvasIdentities {
  identities: Record<string, string>;
}

/** Everything the backend publishes on CANVAS_CHANNEL. */
export type CanvasServerMessage =
  | CanvasEnvelope
  | CanvasServerHello
  | CanvasResync
  | CanvasIdentities;
