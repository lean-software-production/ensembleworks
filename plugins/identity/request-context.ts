import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";

/**
 * Who made the HTTP request the current code is running for.
 *
 * HIGH TRUST: `email` is the raw `Cf-Access-Authenticated-User-Email` header. It is
 * not verified (no Access JWT check). Cloudflare Access overwrites it on traffic that
 * goes through Access, but anything reaching bb directly (loopback, tailnet) can set
 * it to anything. That is accepted: Identity helps honest people avoid mistakes and
 * see who is doing what; it is not an access control.
 */
export type RequestFacts = {
  email: string | null;
  method: string | undefined;
  url: string | undefined;
};

export type RequestContext = {
  /** The facts of the request being handled, or undefined outside any request. */
  current(): RequestFacts | undefined;
};

export const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

const GLOBAL_KEY = Symbol.for("ew.identity.requestContext.v1");

export function normalizeEmail(value: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Patch `http.Server.prototype.emit` so every "request" event runs inside
 * `als.run(facts, ...)`. RPC handlers get no request object from the SDK, but they run
 * inside the request's async context, so they can read the facts from here (spike S7).
 *
 * Installed ONCE per process behind a `Symbol.for` global, and NEVER unpatched:
 * bb loads a plugin generation more than once (at startup and again on reload) and
 * disposes the old generation only AFTER the new one has installed. A
 * "restore emit in onDispose" pattern therefore silently removed the live patch in
 * S7. Every generation must share the one patch and read through this singleton.
 *
 * Startup race: a request that arrives while plugins are still loading is handled
 * before the patch exists, and its code sees no context. Callers treat that as an
 * unknown (anonymous) requester, which is the high-trust design's fallback anyway.
 */
export function installRequestContext(): RequestContext {
  const globals = globalThis as typeof globalThis & { [GLOBAL_KEY]?: RequestContext };
  const existing = globals[GLOBAL_KEY];
  if (existing) return existing;

  const als = new AsyncLocalStorage<RequestFacts>();
  const originalEmit = http.Server.prototype.emit;
  const emit = originalEmit as (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;
  http.Server.prototype.emit = function patchedEmit(this: http.Server, event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const request = args[0] as http.IncomingMessage;
      const facts: RequestFacts = {
        email: normalizeEmail(request.headers[ACCESS_EMAIL_HEADER]),
        method: request.method,
        url: request.url,
      };
      return als.run(facts, () => emit.call(this, event, ...args));
    }
    return emit.call(this, event, ...args);
  } as typeof http.Server.prototype.emit;

  const context: RequestContext = { current: () => als.getStore() };
  globals[GLOBAL_KEY] = context;
  return context;
}
