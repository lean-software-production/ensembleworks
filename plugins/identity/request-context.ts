import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { readNamedCookie, SELECTION_COOKIE } from "./selection.js";

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
  /**
   * A short id for this request, unique within this process's lifetime. It is what joins
   * the audit log's three streams: a dispatch line carries the id of the request that
   * caused it, so `bb plugin logs identity | jq` can put a refusal next to the POST that
   * triggered it.
   */
  id: string;
  email: string | null;
  /** Opaque, bounded cookie value. Only the plugin generation may interpret it. */
  selection: string | null;
  method: string | undefined;
  url: string | undefined;
  startedAt: number;
  finishedAt?: number;
};

/** Called with the facts of every http request bb handles. Must not throw; wrapped anyway. */
export type RequestObserver = (facts: RequestFacts) => void;

/**
 * The shape version of the process-global context.
 *
 * The global survives plugin reloads by design (see `installRequestContext`), so its shape
 * is a CONTRACT BETWEEN VERSIONS of this plugin, not an implementation detail. Version 1
 * was the pre-audit context with `current()` only; the deployed generation of it is what
 * broke the first #106 install with `requestContext.observe is not a function`. Bump this
 * whenever `RequestContext` gains or changes a member, and a running server will migrate
 * on reload instead of handing a new generation an object it cannot use.
 */
export const REQUEST_CONTEXT_VERSION = 4;

export type RequestContext = {
  /** The shape version this context was built at. Absent on a version-1 context. */
  version?: number;
  /** The facts of the request being handled, or undefined outside any request. */
  current(): RequestFacts | undefined;
  /**
   * Watch every request. Returns a disposer.
   *
   * Observers are per-generation and DO come off on dispose, unlike the `emit` patch
   * itself (S7 lesson 1): a disposer removes only the callback it registered, so a
   * reloaded generation's observer is never removed by the old generation's dispose.
   */
  observe(observer: RequestObserver): () => void;
  /** Configure the single named selection cookie captured by this process. */
  setCookieName(name: string): void;
  cookieName(): string;
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
  type LegacyRequestContext = Pick<RequestContext, "current">;
  const globals = globalThis as typeof globalThis & { [GLOBAL_KEY]?: RequestContext | LegacyRequestContext };
  const existing = globals[GLOBAL_KEY];
  // Reuse a context at THIS shape or newer; migrate anything older. A version-1 context
  // (the pre-audit shape, no `version`) reads as 1. Comparing versions rather than
  // sniffing for a method means the next member added migrates without a bespoke check,
  // and a generation that finds a NEWER context leaves it alone instead of downgrading
  // the object a still-live older generation is holding.
  const existingVersion = existing === undefined ? 0 : (existing as RequestContext).version ?? 1;
  if (existing !== undefined && existingVersion >= REQUEST_CONTEXT_VERSION) return existing as RequestContext;

  // Below this line we are MIGRATING. The older generation deliberately left both its
  // global and its emit patch installed across the reload, so a fresh context is layered
  // over the legacy patch: the old generation keeps its own reference until BB disposes
  // it, while the new generation gets ids and observers. Replacing the global also makes
  // later reloads reuse this complete context normally.
  //
  // The cost of a migration is one extra `emit` layer for the life of the process. That
  // is bounded by how many shape versions a single process crosses, which is one per
  // upgrade-with-reload — not per reload.

  const als = new AsyncLocalStorage<RequestFacts>();
  const observers = new Set<RequestObserver>();
  let cookieName = SELECTION_COOKIE;
  let counter = 0;
  const boot = Math.floor(Math.random() * 0xffffff).toString(36);
  const originalEmit = http.Server.prototype.emit;
  const emit = originalEmit as (this: http.Server, event: string | symbol, ...args: unknown[]) => boolean;
  http.Server.prototype.emit = function patchedEmit(this: http.Server, event: string | symbol, ...args: unknown[]) {
    if (event === "request") {
      const request = args[0] as http.IncomingMessage;
      counter += 1;
      const facts: RequestFacts = {
        id: `${boot}-${counter.toString(36)}`,
        email: normalizeEmail(request.headers[ACCESS_EMAIL_HEADER]),
        selection: readNamedCookie(request.headers.cookie, cookieName),
        method: request.method,
        url: request.url,
        startedAt: Date.now(),
      };
      const response = args[1] as http.ServerResponse | undefined;
      response?.once("finish", () => { facts.finishedAt = Date.now(); });
      response?.once("close", () => { facts.finishedAt ??= Date.now(); });
      for (const observer of observers) {
        try {
          observer(facts);
        } catch {
          // An audit line is never worth failing a request over.
        }
      }
      return als.run(facts, () => emit.call(this, event, ...args));
    }
    return emit.call(this, event, ...args);
  } as typeof http.Server.prototype.emit;
  Object.defineProperty(http.Server.prototype.emit, PATCH_MARKER, { value: true });

  const context: RequestContext = {
    version: REQUEST_CONTEXT_VERSION,
    current: () => als.getStore(),
    observe: (observer) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    setCookieName: (name) => { if (/^ew-identity-selection-v1(?:-[0-9a-f]{12})?$/.test(name)) cookieName = name; },
    cookieName: () => cookieName,
  };
  globals[GLOBAL_KEY] = context;
  return context;
}

/** Is the `emit` currently on the prototype our patch? */
export function requestContextPatchIsLive(): boolean {
  const emit = http.Server.prototype.emit as unknown as Record<symbol, unknown>;
  return emit[PATCH_MARKER] === true;
}

export type SelfTestResult = { ok: boolean; detail: string; cookie: { ok: boolean; detail: string } };

export const SELF_TEST_EMAIL = "identity-self-test@localhost.invalid";
export const SELF_TEST_COOKIE = "identity-cookie-probe-v3";

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
    return { ok: false, detail: "the live http.Server.prototype.emit is not Identity's patch", cookie: { ok: false, detail: "patch unavailable" } };
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
    return { ok: false, detail: `the self-test probe failed: ${(error as Error).message}`, cookie: { ok: false, detail: "probe unavailable" } };
  }
  const email = (seen as { email?: unknown } | null)?.email;
  if (email !== SELF_TEST_EMAIL) {
    return { ok: false, detail: `the probe's request context had email ${JSON.stringify(email ?? null)}`, cookie: { ok: false, detail: "email probe failed" } };
  }
  try {
    const cookieSeen = await options.probe({ cookie: `${context.cookieName()}=${SELF_TEST_COOKIE}` });
    const ok = (cookieSeen as { selection?: unknown } | null)?.selection === SELF_TEST_COOKIE;
    return { ok: true, detail: `request context is live (probe saw its own tagged email${nested})`,
      cookie: { ok, detail: ok ? "named cookie reached request context" : "named cookie did not reach request context" } };
  } catch (error) {
    return { ok: true, detail: `request context is live (probe saw its own tagged email${nested})`,
      cookie: { ok: false, detail: `cookie probe failed: ${(error as Error).message}` } };
  }
}
