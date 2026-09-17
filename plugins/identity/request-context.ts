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
/** Stamped on the patched `emit` so the self-test can tell OUR patch is the live one. */
const PATCH_MARKER = Symbol.for("ew.identity.requestContext.patched.v1");

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
  Object.defineProperty(http.Server.prototype.emit, PATCH_MARKER, { value: true });

  const context: RequestContext = { current: () => als.getStore() };
  globals[GLOBAL_KEY] = context;
  return context;
}

/** Is the `emit` currently on the prototype our patch? */
export function requestContextPatchIsLive(): boolean {
  const emit = http.Server.prototype.emit as unknown as Record<symbol, unknown>;
  return emit[PATCH_MARKER] === true;
}

export type SelfTestResult = { ok: boolean; detail: string };

export const SELF_TEST_EMAIL = "identity-self-test@localhost.invalid";

/**
 * Prove the patch is live IN THIS PROCESS: check that the `emit` on the prototype is
 * still ours (S7's lesson 1 — a later generation restoring `emit` silently removed the
 * live patch), then drive one real request through the server carrying a tagged email
 * and assert the handler read that email back out of the async context rather than off
 * the request.
 *
 * Never throws and never touches the patch: a failure is REPORTED, and Identity carries
 * on with no identity (starter "unknown"), because a broken patch must cost UX only and
 * must never block bb from working.
 */
export async function selfTestRequestContext(
  context: RequestContext,
  options: { probe: (headers: Record<string, string>) => Promise<unknown> },
): Promise<SelfTestResult> {
  if (!requestContextPatchIsLive()) {
    return { ok: false, detail: "the live http.Server.prototype.emit is not Identity's patch" };
  }
  // The plugin factory — and any timer it schedules — runs inside the async context of
  // the request that loaded the plugin (`bb plugin reload` is an HTTP request), so this
  // is normal and must NOT fail the test. It is only worth naming in the detail: the
  // verdict itself comes from the probe's own, separate request.
  const nested = context.current() !== undefined ? ", nested in the loading request's context" : "";
  let seen: unknown;
  try {
    seen = await options.probe({ [ACCESS_EMAIL_HEADER]: SELF_TEST_EMAIL });
  } catch (error) {
    return { ok: false, detail: `the self-test probe failed: ${(error as Error).message}` };
  }
  const email = (seen as { email?: unknown } | null)?.email;
  if (email !== SELF_TEST_EMAIL) {
    return { ok: false, detail: `the probe's request context had email ${JSON.stringify(email ?? null)}` };
  }
  return { ok: true, detail: `request context is live (probe saw its own tagged email${nested})` };
}
