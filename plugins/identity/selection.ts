import { createHash, createHmac, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";

export const SELECTION_COOKIE = "ew-identity-selection-v1";

export function identityMutationAllowed(
  contentType: string | undefined,
  origin: string | undefined,
  publicOrigin: string,
  browserOrigin?: string,
): boolean {
  if (!/^application\/json(?:;|$)/i.test(contentType ?? "")) return false;
  // WKWebView may omit Origin for a same-origin fetch. A browser cross-origin
  // JSON request still sends Origin and cannot add our custom origin header
  // without a successful CORS preflight. Some native WebViews rewrite Origin,
  // so accept the page-reported origin only when it exactly matches config.
  return origin === undefined || origin === publicOrigin || browserOrigin === publicOrigin;
}
export function selectionCookieName(origin: string): string {
  return `${SELECTION_COOKIE}-${createHash("sha256").update(origin).digest("hex").slice(0, 12)}`;
}
export const SELECTION_MAX_AGE_MS = 30 * 86400_000;
const PERSON_ID = /^[a-z_][a-z0-9_-]{0,79}$/;
const TOKEN_MAX = 1024;

type SelectionPayload = { v: 1; personId: string; origin: string; issuedAt: number; expiresAt: number; nonce: string };

export function mintSelection(personId: string, origin: string, key: Buffer | KeyObject, now = Date.now()): string {
  if (!PERSON_ID.test(personId) || !origin || origin.length > 256) throw new Error("invalid selection input");
  const payload: SelectionPayload = {
    v: 1, personId, origin, issuedAt: now, expiresAt: now + SELECTION_MAX_AGE_MS,
    nonce: randomBytes(12).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(`ew.identity.selection.v1.${body}`).digest("base64url");
  return `v1.${body}.${signature}`;
}

export type SelectionVerification = { status: "valid"; personId: string } | { status: "expired" | "invalid" };

export function verifySelection(token: string, origin: string, key: Buffer | KeyObject, now = Date.now()): SelectionVerification {
  if (typeof token !== "string" || token.length > TOKEN_MAX || token.length < 30) return { status: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1] ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[2] ?? "")) return { status: "invalid" };
  const expected = createHmac("sha256", key).update(`ew.identity.selection.v1.${parts[1]}`).digest();
  const supplied = Buffer.from(parts[2]!, "base64url");
  if (supplied.length !== expected.length || supplied.toString("base64url") !== parts[2]
    || !timingSafeEqual(supplied, expected)) return { status: "invalid" };
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return { status: "invalid" };
    const p = value as Partial<SelectionPayload>;
    if (Object.keys(p).sort().join() !== "expiresAt,issuedAt,nonce,origin,personId,v"
      || p.v !== 1 || typeof p.personId !== "string" || !PERSON_ID.test(p.personId)
      || p.origin !== origin || typeof p.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(p.nonce)
      || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt)
      || p.expiresAt! - p.issuedAt! !== SELECTION_MAX_AGE_MS || p.issuedAt! > now + 60_000) return { status: "invalid" };
    if (now >= p.expiresAt!) return { status: "expired" };
    return { status: "valid", personId: p.personId };
  } catch {
    return { status: "invalid" };
  }
}

export function selectionCookie(token: string | null, secure: boolean, origin = ""): string {
  const name = origin ? selectionCookieName(origin) : SELECTION_COOKIE;
  return `${name}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax; ${secure ? "Secure; " : ""}Max-Age=${token === null ? 0 : Math.floor(SELECTION_MAX_AGE_MS / 1000)}`;
}

export function readNamedCookie(header: string | string[] | undefined, name = SELECTION_COOKIE): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || raw.length > 8192) return null;
  const matches = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(name.length + 1);
  return token.length <= TOKEN_MAX && /^[A-Za-z0-9_.-]*$/.test(token) ? token : null;
}
