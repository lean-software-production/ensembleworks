// The bb-specific wire contract shared by the backend room host and the
// frontend transport. Kept dependency-free on purpose: transport.ts is bundled
// into the frontend, so it must not reach anything that drags SyncServerPeer,
// better-sqlite3, or node:buffer along with it.

/** The one room this spike serves. */
export const ROOM_ID = "main";

/** The realtime channel every server -> client frame is published on. */
export const CANVAS_CHANNEL = "canvas:main";

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
