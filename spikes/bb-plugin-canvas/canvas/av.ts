// The audio contract, shared by the backend token minter and the frontend
// LiveKit client.
//
// Dependency-free at RUNTIME for the same reason identity.ts is: this module is
// imported by BOTH server.ts and the app bundle, so it must not reach anything
// that drags livekit-server-sdk into the browser or livekit-client into node.
// The two SDKs are imported only by their own side (server.ts and
// canvas/av-room.ts respectively).

/**
 * The one LiveKit room this spike ever joins. A CONSTANT, never derived from a
 * setting or a URL: the production EnsembleWorks deployment points at the same
 * LiveKit server, and a spike that could be talked into joining the real team's
 * room — by a stray query param, a copied config, or a future refactor — would
 * drop strangers into a live meeting. There is exactly one room name in this
 * codebase and it is not a production one.
 */
export const LIVEKIT_ROOM = "bb-spike";

/** Token lifetime. Long enough for a working session, short enough that a
 * leaked token is not a standing invitation. */
export const TOKEN_TTL = "2h";

/** LiveKit settings, once all three are known to be present. */
export interface LiveKitConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * The `canvas_av_token` result.
 *
 * A DISCRIMINATED RESULT, not a thrown error, for the unconfigured case
 * specifically: "nobody has pasted a LiveKit key into this plugin yet" is the
 * expected state of a fresh install, not a fault. It reaches the frontend as an
 * ordinary value the Join button turns into one toast, where a throw would
 * arrive as an opaque rpc `handler_error` indistinguishable from the server
 * being broken. Genuine faults (a token that will not mint) still throw.
 */
export type AvTokenResult =
  | {
      readonly ok: true;
      /** The LiveKit websocket URL the client connects to. */
      readonly url: string;
      readonly token: string;
      /** Always LIVEKIT_ROOM; echoed so the client never has to assume. */
      readonly room: string;
      /** The display name this participant joins as. */
      readonly identity: string;
    }
  | {
      readonly ok: false;
      readonly error: "not_configured";
      readonly detail: string;
    };

export const NOT_CONFIGURED_DETAIL =
  "Set livekitUrl, livekitApiKey and livekitApiSecret with `bb plugin config canvas set …`, then reload the plugin.";

/**
 * The LiveKit config, or null when any of the three settings is missing.
 *
 * All-or-nothing on purpose: a URL without a key mints nothing, and a key
 * without a URL connects to nothing, so there is no partially-configured state
 * worth reporting separately — the one "not configured" answer covers all of
 * them and the detail string says which knobs to set.
 */
export function livekitConfigFrom(values: {
  readonly livekitUrl?: string | undefined;
  readonly livekitApiKey?: string | undefined;
  readonly livekitApiSecret?: string | undefined;
}): LiveKitConfig | null {
  const url = (values.livekitUrl ?? "").trim();
  const apiKey = (values.livekitApiKey ?? "").trim();
  const apiSecret = (values.livekitApiSecret ?? "").trim();
  if (url === "" || apiKey === "" || apiSecret === "") return null;
  return { url, apiKey, apiSecret };
}

/**
 * Which name this caller joins LiveKit as.
 *
 * Resolved SERVER-SIDE from the room's own clientId -> name map rather than
 * from anything the caller sends with this rpc, so the identity stamped into a
 * signed token is the same name the room already broadcasts as that client's
 * cursor label — a caller cannot mint a token naming somebody else by passing a
 * different string here. (The name reached that map through the browser in the
 * first place, so this is a consistency guarantee, not an authentication one;
 * see identity.ts's TRUST BOUNDARY note.)
 *
 * `fallback` is the backend's own local identity, used when the caller is not
 * in the room's map — a panel whose canvas session is still booting can still
 * join audio.
 */
export function avIdentityFor(
  clientId: string | undefined,
  identities: Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (clientId === undefined) return fallback;
  const name = identities[clientId];
  return name === undefined || name.length === 0 ? fallback : name;
}
