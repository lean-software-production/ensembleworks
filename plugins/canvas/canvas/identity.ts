// Who is at this canvas — the shared identity contract.
//
// Behind Cloudflare Access, the edge authenticates the human and stamps
// `Cf-Access-Authenticated-User-Email` on every request it forwards. That
// header is the only place bb ever sees a real identity for a browser client,
// and it is only present on an HTTP request — not on a plugin rpc call, which
// reaches the handler as validated input and nothing else. So identity enters
// this plugin through exactly one door: the `GET .../http/identity` route,
// which the panel fetches once on mount.
//
// TRUST BOUNDARY (spike-level, deliberately): the panel then carries the name
// it was told back up on `canvas_join`, and the room broadcasts the resulting
// clientId -> name map to everyone. The server therefore takes a client's word
// for its own name. That is fine for a spike on a trusted LAN and wrong for
// anything else; the fix is to key the map inside this route (where the header
// IS present) rather than on the rpc, which needs the panel to send its
// clientId here instead of on join.
//
// This module is imported by BOTH sides, so it stays dependency-free at
// RUNTIME: no bb SDK, no node builtins, no canvas package values. The backend
// passes `os.userInfo().username` in rather than reading it here, and the one
// canvas-react import below is type-only (erased at build).
import type { RemotePresence } from "@ensembleworks/canvas-react";

/** The one header Cloudflare Access stamps that we care about. */
export const CF_ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";

/**
 * The path passed to `bb.http.route`. Leading slash: that is what the SDK's own
 * route validator requires, and bb mounts it at
 * `/api/v1/plugins/canvas/http/identity` either way.
 */
export const IDENTITY_ROUTE_PATH = "/identity";

/** Same-origin URL the panel fetches. `auth: "local"` (the default) accepts it
 * precisely because it comes from a bb app origin. */
export const IDENTITY_URL = "/api/v1/plugins/canvas/http/identity";

/** Longest name this plugin will carry — matches the `canvas_join` schema's
 * cap, so a name that survives here always survives the wire. */
export const MAX_NAME_LENGTH = 64;

export interface CanvasIdentity {
  /** The Cloudflare Access email, or null when the header was absent. */
  readonly email: string | null;
  /** The label peers see on this client's cursor. Never empty. */
  readonly name: string;
}

/**
 * Turn the request's `Cf-Access-Authenticated-User-Email` header into an
 * identity.
 *
 * With the header: the email, plus its local part as the display name — a
 * cursor label wants "alice", not "alice@example.com", and the full address is
 * still returned for anything that needs to be precise.
 *
 * Without it (every local dev run, and any request that did not come through
 * the Access edge): `local:<os username>`, which is honest about being a
 * machine account rather than pretending to be an authenticated person.
 */
export function resolveIdentity(
  header: string | null | undefined,
  localUsername: string,
): CanvasIdentity {
  const email = (header ?? "").trim();
  if (email.length > 0) {
    const localPart = email.split("@")[0]!.trim();
    return {
      email,
      // An email of the pathological form "@example.com" has an empty local
      // part; fall back to the whole address rather than an empty label.
      name: clampName(localPart.length > 0 ? localPart : email),
    };
  }
  const username = localUsername.trim();
  return {
    email: null,
    name: clampName(`local:${username.length > 0 ? username : "unknown"}`),
  };
}

/** Bound a name to MAX_NAME_LENGTH so it always passes the join schema. */
export function clampName(name: string): string {
  return name.length <= MAX_NAME_LENGTH ? name : name.slice(0, MAX_NAME_LENGTH);
}

/**
 * A stable color for a display NAME (not a peer key): the same human is the
 * same color in every tab, on every client, forever — which is what makes a
 * cursor label readable at a glance. Two tabs opened by one person are
 * deliberately the same color, because they are the same person.
 *
 * djb2 hashed to a hue, with fixed saturation/lightness so every color in the
 * set reads at the same weight against the canvas paper. Pure — no clock, no
 * PRNG — for the same reason canvas-react's own `colorForKey` is.
 */
export function colorForName(name: string): string {
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 33 + name.charCodeAt(i)) | 0; // |0 keeps this a 32-bit int
  }
  return `hsl(${Math.abs(hash) % 360} 65% 45%)`;
}

/**
 * Join cursors to names — the render-time half of "presence carries no
 * identity".
 *
 * canvas-sync's `Presence` has no name field and this spike may not modify
 * canvas-sync, so names travel on a parallel channel (the room's
 * `CanvasIdentities` broadcast) and are joined to cursors here. The join key is
 * exact: a `PresenceStore` is constructed with the panel's own `clientId` as
 * its self key, so presence keys ARE clientIds.
 *
 * A peer whose name has not arrived yet (its join broadcast raced this client's
 * subscription) falls back to a short id — a cursor with a stub label beats a
 * cursor with none, and the next broadcast repairs it.
 *
 * Color comes from the NAME, not the key, so one human is one color across all
 * of their tabs.
 *
 * THE PAGE IS CARRIED, NOT DROPPED (design doc D-4). `Cursors` hides a peer
 * whose page is present and differs from the local one, and this adapter is
 * the only thing standing between `Presence.page` on the wire and that filter
 * — a version of this function that built `{cursor, name, color}` made the
 * whole feature inert while every other test stayed green.
 *
 * `?? null` rather than a pass-through: null and undefined are ONE state to
 * every reader (canvas-react's `isOnOtherPage` falls through to "do not hide"
 * for both), and emitting the key always is what keeps "did the adapter drop
 * it?" falsifiable — an omitted key reads back as `undefined`, which `toEqual`
 * treats as absent, so a test written against it would pass either way.
 *
 * ABSENT MEANS UNKNOWN, NEVER "ELSEWHERE": a peer running an older bundle
 * publishes no page at all and must still be drawn.
 */
export function adaptPresence(
  all: Readonly<
    Record<
      string,
      {
        cursor: { x: number; y: number } | null;
        /** Optional and `| null`, mirroring canvas-sync's `Presence.page`
         * exactly — this must accept a payload from a publisher that predates
         * the field. */
        page?: string | null;
      }
    >
  >,
  identities: Readonly<Record<string, string>>,
): Record<string, RemotePresence> {
  const out: Record<string, RemotePresence> = {};
  for (const [key, presence] of Object.entries(all)) {
    const name = identities[key] ?? key.slice(0, 6);
    out[key] = {
      cursor: presence.cursor,
      name,
      color: colorForName(name),
      page: presence.page ?? null,
    };
  }
  return out;
}

/**
 * Ask the backend who this browser is. Same-origin, so the Cloudflare Access
 * header (when there is one) rides along automatically.
 *
 * Never rejects: a canvas that cannot name you is far better than a canvas
 * that will not open, so a failed or malformed response degrades to an
 * anonymous local identity and the panel carries on.
 */
export async function fetchIdentity(
  fetchImpl: typeof fetch = fetch,
): Promise<CanvasIdentity> {
  try {
    const response = await fetchImpl(IDENTITY_URL, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { email: null, name: "local:anonymous" };
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return { email: null, name: "local:anonymous" };
    }
    const { email, name } = body as Partial<CanvasIdentity>;
    return {
      email: typeof email === "string" ? email : null,
      name:
        typeof name === "string" && name.trim().length > 0
          ? clampName(name.trim())
          : "local:anonymous",
    };
  } catch {
    return { email: null, name: "local:anonymous" };
  }
}
