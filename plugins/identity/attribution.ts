import { z } from "zod";
import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";

export type { KvLike } from "./kv.js";
export { KV_TIMEOUT_MS } from "./kv.js";

/**
 * Attribution: who started a thread, and how the dispatch that started it reached bb.
 *
 * HIGH TRUST, like the rest of Identity. The starter comes from the unverified
 * `Cf-Access-Authenticated-User-Email` header (see request-context.ts) or from the
 * lineage fields a caller supplies. Both are labels, not credentials. This module
 * only OBSERVES and RECORDS: nothing here rejects a dispatch.
 */

/** How a dispatch reached bb. `unknown` is the honest, never-an-error fallback. */
export const VIA = ["browser", "agent", "plugin", "unknown"] as const;
export type Via = (typeof VIA)[number];

/** bb's `ThreadCreateOrigin`, plus null for a core-driven send (a drain). */
export type DispatchOrigin = "app" | "cli" | "plugin" | "sdk" | null;

export const starterSummarySchema = z.object({
  person: z.string(),
  displayName: z.string(),
  github: z.string(),
}).strict();
export type StarterSummary = z.infer<typeof starterSummarySchema>;

export const starterRecordSchema = z.object({
  threadId: z.string().min(1),
  /** The person, or null when nothing identified the dispatch. */
  starter: starterSummarySchema.nullable(),
  /** The email the attribution came from, even when it matched no person. */
  email: z.string().nullable(),
  via: z.enum(VIA),
  origin: z.enum(["app", "cli", "plugin", "sdk"]).nullable(),
  originPluginId: z.string().nullable(),
  /** The thread this starter was inherited from, for a lineage dispatch. */
  inheritedFrom: z.string().nullable(),
  recordedAt: z.number(),
}).strict();
export type StarterRecord = z.infer<typeof starterRecordSchema>;

export function viaForOrigin(origin: DispatchOrigin): Via {
  switch (origin) {
    case "plugin":
      return "plugin";
    case "cli":
    case "sdk":
      return "agent";
    default:
      // "app", and null for a core-driven send. A null origin only ever carries an
      // identity when the patch saw a request, which means a browser.
      return "browser";
  }
}

/**
 * The threads this dispatch could inherit a starter from, most specific first.
 *
 * All four fields exist in SDK 0.4.84, but not all on the hook context:
 * `parentThreadId` and `startedOnBehalfOf.senderThreadId` are hook-context fields,
 * `sourceThreadId` (a fork's source) lives on `context.thread`, and a drain's
 * `senderThreadId` lives on `context.queuedMessage`. All of them are caller-supplied,
 * so lineage is taken at face value (Decisions: high trust).
 */
export function lineageOf(input: {
  threadId: string;
  parentThreadId: string | null | undefined;
  sourceThreadId: string | null | undefined;
  senderThreadIds: readonly (string | null | undefined)[];
}): string[] {
  const candidates = [...input.senderThreadIds, input.parentThreadId, input.sourceThreadId];
  const seen = new Set<string>();
  const lineage: string[] = [];
  for (const candidate of candidates) {
    const id = typeof candidate === "string" ? candidate.trim() : "";
    if (id.length === 0 || id === input.threadId || seen.has(id)) continue;
    seen.add(id);
    lineage.push(id);
  }
  return lineage;
}

export type AttributionFacts = {
  threadId: string;
  /** The requester's email from the ALS request context (or the fallback setting). */
  email: string | null;
  /** The person that email resolved to in the directory, or null. */
  person: StarterSummary | null;
  origin: DispatchOrigin;
  originPluginId: string | null;
  lineage: readonly string[];
  now: number;
};

/**
 * Choose the starter and `via` for one dispatch, in priority order:
 *
 * 1. the person the request's own email resolved to;
 * 2. else the recorded starter of the first lineage thread that has one (`via: agent`);
 * 3. else `via: plugin` for a plugin-origin dispatch (an automation, scheduled send…);
 * 4. else `via: unknown` — a drain, a headerless shell, or the plugin-load race.
 *
 * An email that matches nobody is treated as no identity of its own (so lineage still
 * wins) but is kept on the record, because knowing which unknown address asked is
 * useful and costs nothing.
 */
export function decideAttribution(
  facts: AttributionFacts,
  inherited: (threadId: string) => StarterRecord | null,
): StarterRecord {
  const base = {
    threadId: facts.threadId,
    email: facts.email,
    origin: facts.origin,
    originPluginId: facts.originPluginId,
    recordedAt: facts.now,
  } as const;

  if (facts.person !== null) {
    return { ...base, starter: facts.person, via: viaForOrigin(facts.origin), inheritedFrom: null };
  }
  for (const threadId of facts.lineage) {
    const parent = inherited(threadId);
    if (parent?.starter) {
      return {
        ...base,
        starter: parent.starter,
        email: facts.email ?? parent.email,
        via: "agent",
        inheritedFrom: threadId,
      };
    }
  }
  if (facts.origin === "plugin") return { ...base, starter: null, via: "plugin", inheritedFrom: null };
  return { ...base, starter: null, via: "unknown", inheritedFrom: null };
}

/**
 * The shape of bb's `MessageDispatchHookContext` that attribution reads. Structural on
 * purpose: this module never imports the SDK, and typecheck still proves the field
 * names exist, because server.ts passes the real hook context in.
 */
export type DispatchContextLike = {
  thread: { id: string; parentThreadId: string | null; sourceThreadId: string | null };
  origin: DispatchOrigin;
  originPluginId: string | null;
  startedOnBehalfOf: { senderThreadId: string } | null;
  parentThreadId: string | null;
  queuedMessage: { senderThreadId: string | null } | null;
};

/** Turn one dispatch plus the requester's identity into the facts of an attribution. */
export function factsFromDispatch(
  context: DispatchContextLike,
  identity: { email: string | null; person: StarterSummary | null },
  now: number,
): AttributionFacts {
  return {
    threadId: context.thread.id,
    email: identity.email,
    person: identity.person,
    origin: context.origin,
    originPluginId: context.originPluginId,
    lineage: lineageOf({
      threadId: context.thread.id,
      // The hook context's own parent, falling back to the thread row's.
      parentThreadId: context.parentThreadId ?? context.thread.parentThreadId,
      sourceThreadId: context.thread.sourceThreadId,
      senderThreadIds: [context.startedOnBehalfOf?.senderThreadId, context.queuedMessage?.senderThreadId],
    }),
    now,
  };
}

const KEY_PREFIX = "identity/starter/v1/thread/";
const INDEX_KEY = "identity/starter/v1/index";

/**
 * Storage policy, deliberate and bounded: one small record per thread (~200 bytes) in
 * `bb.storage.kv`, plus an insertion-ordered index of thread ids. Past `max` threads
 * the oldest records are deleted. Attribution is a guardrail aid, not an audit log, so
 * losing the oldest entries is acceptable — an evicted thread reads back as "unknown",
 * exactly like a thread that predates the plugin. The cap also keeps the index row
 * well inside kv's 256KB per-value limit (2000 ids ≈ 50KB).
 */
export const MAX_STARTER_RECORDS = 2_000;

/**
 * The read-through cache is bounded SEPARATELY from storage, and much smaller: the read
 * path (`identity_thread_starter`, `GET /thread-starter`) caches every thread id it is
 * asked about, including misses, so a storage-sized cap would not bound it at all — a
 * caller can ask about ids that were never written. Oldest-inserted entries are dropped
 * first; the cache only ever saves a kv round-trip, so dropping one is free.
 */
export const MAX_CACHED_STARTERS = 256;

export class AttributionLedger {
  readonly #kv: KvLike;
  readonly #max: number;
  readonly #cacheMax: number;
  readonly #timeoutMs: number;
  /** Bounded read-through cache; `null` means "storage says there is no record". */
  readonly #cache = new Map<string, StarterRecord | null>();
  #index: string[] | null = null;

  constructor(kv: KvLike, options: { max?: number; cacheMax?: number; timeoutMs?: number } = {}) {
    this.#kv = kv;
    this.#max = Math.max(1, options.max ?? MAX_STARTER_RECORDS);
    this.#cacheMax = Math.max(1, options.cacheMax ?? MAX_CACHED_STARTERS);
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? KV_TIMEOUT_MS);
  }

  /** Cache `record` under `threadId`, dropping the oldest entry when the cache is full. */
  #remember(threadId: string, record: StarterRecord | null): void {
    this.#cache.delete(threadId);
    this.#cache.set(threadId, record);
    while (this.#cache.size > this.#cacheMax) {
      const oldest = this.#cache.keys().next();
      if (oldest.done === true) break;
      this.#cache.delete(oldest.value);
    }
  }

  /**
   * The recorded starter for a thread, or null when there is none. Never throws: a
   * storage failure or a corrupt row degrades to "no record", because the dispatch
   * hook that calls this must never fail an attempt (hooks are fail-closed).
   */
  async get(threadId: string): Promise<StarterRecord | null> {
    const cached = this.#cache.get(threadId);
    if (cached !== undefined) return cached;
    let record: StarterRecord | null = null;
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(KEY_PREFIX + threadId), this.#timeoutMs);
      // A hung kv is a failure, not an answer: do not cache it, and never wait it out.
      if (stored === TIMED_OUT) return null;
      const parsed = stored === undefined ? null : starterRecordSchema.safeParse(stored);
      record = parsed && parsed.success ? parsed.data : null;
    } catch {
      // Unreadable storage: treat as no record, and do not cache the failure.
      return null;
    }
    this.#remember(threadId, record);
    return record;
  }

  /**
   * Record a thread's starter, FIRST WRITE WINS: a later dispatch never rewrites it.
   * Returns whether this call was the write, and the record now in force (null only
   * when storage failed).
   *
   * Safe against concurrent first dispatches because bb runs the whole
   * `message.dispatch` pass under one server-wide lock (SDK `PluginHooks.on`).
   */
  async record(record: StarterRecord): Promise<{ recorded: boolean; record: StarterRecord | null }> {
    const existing = await this.get(record.threadId);
    if (existing !== null) return { recorded: false, record: existing };
    try {
      const written = await withTimeout(this.#kv.set(KEY_PREFIX + record.threadId, record), this.#timeoutMs);
      if (written === TIMED_OUT) {
        this.#cache.delete(record.threadId);
        return { recorded: false, record: null };
      }
      this.#remember(record.threadId, record);
      await withTimeout(this.#appendToIndex(record.threadId), this.#timeoutMs);
      return { recorded: true, record };
    } catch {
      this.#cache.delete(record.threadId);
      return { recorded: false, record: null };
    }
  }

  async #appendToIndex(threadId: string): Promise<void> {
    if (this.#index === null) {
      const stored = await this.#kv.get<unknown>(INDEX_KEY);
      this.#index = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    }
    const index = this.#index.filter((id) => id !== threadId);
    index.push(threadId);
    const evicted = index.splice(0, Math.max(0, index.length - this.#max));
    this.#index = index;
    await this.#kv.set(INDEX_KEY, index);
    for (const id of evicted) {
      this.#cache.delete(id);
      await this.#kv.delete(KEY_PREFIX + id);
    }
  }
}

/** The ledger slice one dispatch needs — the class, or a fake in a test. */
export type LedgerLike = {
  get(threadId: string): Promise<StarterRecord | null>;
  record(record: StarterRecord): Promise<{ recorded: boolean; record: StarterRecord | null }>;
};

export type DispatchDeps = {
  ledger: LedgerLike;
  /** The requester's identity, read from the async request context. May throw. */
  identity: () => { email: string | null; person: StarterSummary | null };
  now: () => number;
  log: { info: (message: string) => void; warn: (message: string) => void };
};

/**
 * The whole body of the `message.dispatch` hook, as a testable function.
 *
 * Its contract, which its tests hold it to: it ALWAYS returns `{ action: "proceed" }`,
 * it never throws, and it never rejects or delays a dispatch. Every failure — a wedged
 * kv, a throwing identity lookup, a corrupt row — degrades to a warning and a proceed.
 * Step 5's guardrails are a later, separate change; nothing here may refuse anything.
 */
export async function attributeDispatch(
  context: DispatchContextLike,
  deps: DispatchDeps,
): Promise<{ action: "proceed" }> {
  try {
    const facts = factsFromDispatch(context, deps.identity(), deps.now());
    const inheritable = new Map(await Promise.all(
      facts.lineage.map(async (id) => [id, await deps.ledger.get(id)] as const),
    ));
    const decided = decideAttribution(facts, (id) => inheritable.get(id) ?? null);
    const outcome = await deps.ledger.record(decided);
    if (outcome.recorded) {
      deps.log.info(
        `identity: thread ${decided.threadId} started by ${decided.starter?.person ?? "unknown"} `
        + `(via ${decided.via}${decided.inheritedFrom ? `, inherited from ${decided.inheritedFrom}` : ""})`,
      );
    }
  } catch (error) {
    deps.log.warn(`identity: could not record attribution: ${(error as Error).message}`);
  }
  return { action: "proceed" } as const;
}
