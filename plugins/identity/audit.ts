import type { AttributionFacts, DispatchOrigin, GuardOutcome, StarterSummary, Via } from "./attribution.js";

/**
 * Audit mode: what identity actually reaches Identity, written down.
 *
 * The owner's ask (2026-09-18): install Identity on the real server, show what identity
 * it can resolve across the UX, and keep a verbose log we can analyse to see which human
 * actions and which agent actions carry identity and which do not — "like enabling
 * restrictions, but instead of blocking things we just log what we would have blocked
 * (and what we couldn't block)".
 *
 * Two owner decisions this module implements, and does not revisit:
 * - **One three-way setting** (`enforcement`), never a second boolean.
 * - **Logs go through `bb.log` only** — no ring buffer, no `/audit` route, no UI log
 *   page. One JSON object per line, prefixed so `bb plugin logs identity` can be piped
 *   into `jq`.
 *
 * Emails appear in these lines BY DESIGN — that is the question being answered — and are
 * stated as such in the README. Message bodies and thread content never do.
 */

/** Bumped whenever a line's shape changes, so a later format change is detectable. */
export const AUDIT_SCHEMA_VERSION = 1;

/**
 * Every audit line starts with this token. `bb plugin logs identity` prefixes each line
 * with its own timestamp and level, so a consumer needs something to cut on:
 * `bb plugin logs identity | sed -n 's/.*identity-audit //p' | jq`.
 */
export const AUDIT_LINE_PREFIX = "identity-audit";

export const ENFORCEMENT_MODES = ["off", "audit", "enforce"] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/**
 * Read the `enforcement` setting. Anything unrecognised — an empty string, a stale
 * `restrictStarts`-era value, a typo — is `off`: an unreadable setting must never be the
 * thing that starts refusing people's work.
 */
export function parseEnforcement(value: string | undefined | null): EnforcementMode {
  return (ENFORCEMENT_MODES as readonly string[]).includes(value ?? "") ? (value as EnforcementMode) : "off";
}

/** One audit line. Open-ended on purpose: every kind adds its own fields. */
export type AuditLine = { v: number; kind: string; at: number } & Record<string, unknown>;

export type AuditSink = (line: AuditLine) => void;

export function formatAuditLine(line: AuditLine): string {
  return `${AUDIT_LINE_PREFIX} ${JSON.stringify(line)}`;
}

/**
 * Hand one line to the sink, swallowing everything.
 *
 * Audit logging sits inside the dispatch hook, which is fail-closed: a throw there fails
 * a real user's message. So a broken logger — a throwing sink, a value JSON cannot
 * serialize — costs a log line and nothing else.
 */
export function emitAudit(sink: AuditSink, line: AuditLine): void {
  try {
    sink(line);
  } catch {
    // Deliberately silent: the only thing available to report a logging failure with is
    // the logger that just failed.
  }
}

const ID_SEGMENT = /^([a-z]{2,6}_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/;

/**
 * A request's path as a SHAPE: query string dropped (ids and free text hide there), and
 * every opaque id collapsed to `:id`. Without this, a rollup keyed by path would have one
 * bucket per thread and stop being a rollup.
 */
export function normalizeAuditPath(url: string | undefined | null): string {
  if (typeof url !== "string" || url.length === 0) return "(no url)";
  const path = url.split("?")[0]?.split("#")[0] ?? "";
  if (path.length === 0) return "(no url)";
  return path
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

/**
 * Identity's own presence RPCs. They fire every few seconds per open tab, per person —
 * the single biggest source of volume, and the least interesting: a heartbeat is not a
 * "human action" anyone is auditing. Rolled up, never logged one by one.
 */
const PRESENCE_RPCS = ["presence_heartbeat", "presence_typing", "presence_snapshot", "presence_thread", "presence_typing_list"];

/**
 * Identity's own READ RPCs. The shipped BB client sends every plugin RPC over POST, and
 * `app.tsx` polls `identity_whoami` every REFRESH_MS (5s) per open tab, so a "POST is a
 * mutation" rule made our own polling the single loudest thing in the log — about twelve
 * lines a minute per tab — and filed it as a human action. Reads are counted, not logged.
 *
 * Only Identity's own RPCs are listed: another plugin's RPC names are not ours to
 * interpret, so they still get a line each and will show up if they are chatty. That is
 * the deliberate trade of keeping the policy in code rather than adding a second setting.
 */
const IDENTITY_READ_RPCS = [
  "identity_whoami",
  "identity_thread_starter",
  "identity_thread_ownership",
  "identity_machines",
];

/**
 * Other known high-frequency shapes: the event stream, and any plugin RPC whose name says
 * presence. Canvas is a busy plugin and its presence chatter is the same kind of noise.
 */
function isHighFrequency(path: string): boolean {
  if (PRESENCE_RPCS.some((rpc) => path.endsWith(`/rpc/${rpc}`))) return true;
  if (IDENTITY_READ_RPCS.some((rpc) => path.endsWith(`/rpc/${rpc}`))) return true;
  if (/\/rpc\/[a-z0-9_]*presence[a-z0-9_]*$/i.test(path)) return true;
  // Measured on a throwaway bb with nothing open at all: the host daemon posts
  // `/internal/session/events` every few seconds, which would otherwise be four
  // individual lines a minute on an idle server.
  if (path.startsWith("/internal/session/")) return true;
  return path === "/api/v1/events" || path.endsWith("/events/stream");
}

export type RequestStream = "line" | "rollup";

/**
 * The volume policy, in one function.
 *
 * MEASURED first (see the design note's audit-mode section): with one browser tab open
 * and idle, an unfiltered request stream is dominated by reads and presence chatter, and
 * a per-request line would flood the log inside a day. So:
 * - a **mutation** (POST/PUT/PATCH/DELETE) that is not known high-frequency chatter gets
 *   its OWN line — that is the set of "human actions and agent actions" the owner is
 *   asking about, and it is small;
 * - everything else — every read, and the presence/event chatter — is **counted** into a
 *   periodic rollup line instead, so "which paths carried identity?" is still answerable
 *   for them, without one line per poll.
 */
export function requestStreamChoice(method: string | undefined, path: string): RequestStream {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return "rollup";
  return isHighFrequency(path) ? "rollup" : "line";
}

export type AuditRequestFacts = {
  id: string;
  method: string | undefined;
  url: string | undefined;
  email: string | null;
  person: StarterSummary | null;
};

export const ROLLUP_MS = 60_000;
export const MAX_ROLLUP_BUCKETS = 200;

type Bucket = { method: string; path: string; access: boolean; person: string | null; count: number };

/**
 * The request stream (a), and its volume policy in force.
 *
 * The ALS patch sees EVERY http request bb handles — including the routes the dispatch
 * hook never sees: terminals, Stop, Archive, answering approvals, host routes, plugin
 * RPCs. That is what answers the owner's actual question, and it is also what would
 * flood the log, so this class is where "log it" and "count it" are decided.
 *
 * No timer: the window is flushed lazily, by the next observation past the deadline (and
 * by `flush()` on dispose). A rollup for a window that ends in silence is therefore late
 * rather than lost, which is the right trade for a class that must never keep the process
 * alive or fire inside a dispatch.
 */
export class RequestAuditor {
  readonly #emit: AuditSink;
  readonly #now: () => number;
  readonly #rollupMs: number;
  readonly #maxBuckets: number;
  #buckets = new Map<string, Bucket>();
  #windowStart: number | null = null;
  #total = 0;
  #dropped = 0;

  constructor(options: { emit: AuditSink; now: () => number; rollupMs?: number; maxBuckets?: number }) {
    this.#emit = options.emit;
    this.#now = options.now;
    this.#rollupMs = Math.max(1, options.rollupMs ?? ROLLUP_MS);
    this.#maxBuckets = Math.max(1, options.maxBuckets ?? MAX_ROLLUP_BUCKETS);
  }

  observe(facts: AuditRequestFacts): void {
    const at = this.#now();
    const path = normalizeAuditPath(facts.url);
    const method = (facts.method ?? "GET").toUpperCase();
    if (this.#windowStart !== null && at - this.#windowStart >= this.#rollupMs) this.flush();
    if (requestStreamChoice(method, path) === "line") {
      emitAudit(this.#emit, {
        v: AUDIT_SCHEMA_VERSION,
        kind: "request",
        at,
        req: facts.id,
        method,
        path,
        access: facts.email !== null,
        person: facts.person?.person ?? null,
      });
      return;
    }
    if (this.#windowStart === null) this.#windowStart = at;
    this.#total += 1;
    const person = facts.person?.person ?? null;
    const access = facts.email !== null;
    const key = `${method} ${path} ${access ? "1" : "0"} ${person ?? ""}`;
    const bucket = this.#buckets.get(key);
    if (bucket !== undefined) {
      bucket.count += 1;
      return;
    }
    if (this.#buckets.size >= this.#maxBuckets) {
      this.#dropped += 1;
      return;
    }
    this.#buckets.set(key, { method, path, access, person, count: 1 });
  }

  /** Emit the current window's counters, if it saw anything. */
  flush(): void {
    if (this.#buckets.size === 0 && this.#total === 0) return;
    emitAudit(this.#emit, {
      v: AUDIT_SCHEMA_VERSION,
      kind: "request.rollup",
      at: this.#now(),
      from: this.#windowStart,
      total: this.#total,
      /** Requests whose bucket did not fit the cap: counted in `total`, not itemised. */
      dropped: this.#dropped,
      buckets: [...this.#buckets.values()],
    });
    this.#buckets = new Map();
    this.#windowStart = null;
    this.#total = 0;
    this.#dropped = 0;
  }
}

export type DispatchAuditInput = {
  at: number;
  requestId: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  mode: EnforcementMode;
  facts: AttributionFacts;
  /** How the machine classified ("person" | "team" | "unclaimed"), when one was named. */
  hostKind: string | null;
  /** The starter already on record for this thread, if any. */
  recordedStarter: StarterSummary | null;
  /** The starter this dispatch would be attributed to, and how it reached bb. */
  starter: StarterSummary | null;
  via: Via | null;
  /** What the guardrail decided — identical in `audit` and `enforce`. */
  verdict: GuardOutcome["verdict"];
  /** What the hook actually returned. In `audit` this is always `proceed`. */
  action: "proceed" | "reject";
};

/**
 * The dispatch stream (b): every `message.dispatch`, with the full attribution facts,
 * the guardrail verdict (the rule that fired and the refusal it would have produced) and
 * the action actually returned.
 *
 * `verdict` and `action` are separate fields on purpose: in `audit` they differ, and that
 * difference is the whole product — "what we would have blocked".
 */
export function dispatchAuditLine(input: DispatchAuditInput): AuditLine {
  const rejected = input.verdict.action === "reject";
  return {
    v: AUDIT_SCHEMA_VERSION,
    kind: "dispatch",
    at: input.at,
    req: input.requestId,
    method: input.requestMethod,
    path: input.requestPath,
    mode: input.mode,
    threadId: input.facts.threadId,
    email: input.facts.email,
    person: input.facts.person?.person ?? null,
    viaFallback: input.facts.viaFallback,
    origin: input.facts.origin satisfies DispatchOrigin,
    originPluginId: input.facts.originPluginId,
    lineage: [...input.facts.lineage],
    host: input.facts.host === null
      ? null
      : { id: input.facts.host.id, name: input.facts.host.name, kind: input.hostKind },
    recordedStarter: input.recordedStarter?.person ?? null,
    starter: input.starter?.person ?? null,
    via: input.via,
    verdict: input.verdict.action,
    rule: rejected ? ((input.verdict as { rule: string }).rule) : null,
    refusal: rejected ? ((input.verdict as { message: string }).message) : null,
    action: input.action,
  };
}

export type PostDispatchAuditInput = {
  kind: "message.queued" | "message.dispatched";
  at: number;
  requestId: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  mode: EnforcementMode;
  entryId: string | null;
  threadId: string | null;
  senderThreadId: string | null;
  email: string | null;
  person: StarterSummary | null;
};

/**
 * The post-dispatch stream (c): `message.queued` and `message.dispatched`.
 *
 * Per S7 these run in the REQUESTER's async context, so they see Send-now and queued
 * drains — the paths that skip the dispatch hook entirely. This is the "what we couldn't
 * block" half of the ask: it cannot stop anything, it can only say what identity those
 * paths carried.
 */
export function postDispatchAuditLine(input: PostDispatchAuditInput): AuditLine {
  return {
    v: AUDIT_SCHEMA_VERSION,
    kind: input.kind,
    at: input.at,
    req: input.requestId,
    method: input.requestMethod,
    path: input.requestPath,
    mode: input.mode,
    entryId: input.entryId,
    threadId: input.threadId,
    senderThreadId: input.senderThreadId,
    access: input.email !== null,
    email: input.email,
    person: input.person?.person ?? null,
  };
}
