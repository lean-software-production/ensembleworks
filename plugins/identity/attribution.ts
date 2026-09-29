import { z } from "zod";
import { hostRefSchema, type HostRef } from "./host-ref.js";
import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";
import type { Provenance } from "./people.js";

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
  /**
   * The machine the dispatch was headed for, as bb resolved it. Optional because
   * records written before step 4 do not have it; those read back as "no machine",
   * never as a corrupt row.
   */
  host: hostRefSchema.nullish(),
  /** Absent on access-origin and legacy rows, preserving their old wire shape. */
  provenance: z.enum(["self-selected", "configured-fallback", "unknown"]).optional(),
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
  /**
   * True when `person` came from the `fallbackEmail` setting rather than from this
   * request. Attribution still records them; the guardrail treats it as anonymous,
   * because on a fallback-configured server every agent path resolves to that person.
   */
  viaFallback: boolean;
  provenance?: Provenance;
  captureSource?: "request" | "queue-ledger" | "queue-content-unknown" | "capture-missing" | "unknown";
  origin: DispatchOrigin;
  originPluginId: string | null;
  lineage: readonly string[];
  /** The machine bb resolved for this dispatch (`context.host`), or null. */
  host: HostRef | null;
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
    host: facts.host,
  } as const;

  if (facts.person !== null) {
    return { ...base, starter: facts.person, via: viaForOrigin(facts.origin), inheritedFrom: null,
      ...(facts.provenance && facts.provenance !== "upstream-header"
        ? { provenance: facts.provenance as "self-selected" | "configured-fallback" | "unknown" } : {}) };
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
        ...(parent.provenance ? { provenance: parent.provenance } : {}),
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
  origin: DispatchOrigin | "mixed";
  originPluginId: string | "mixed" | null;
  startedOnBehalfOf?: { senderThreadId: string } | null;
  parentThreadId: string | null;
  queuedMessage?: { senderThreadId: string | null } | null;
  queuedMessages?: readonly { id: string; senderThreadId: string | null }[];
  /** The machine the turn will run on; null when neither environment nor intent names one. */
  host: { id: string; name: string } | null;
};

/** Turn one dispatch plus the requester's identity into the facts of an attribution. */
export function factsFromDispatch(
  context: DispatchContextLike,
  identity: { email: string | null; person: StarterSummary | null; viaFallback?: boolean; provenance?: Provenance;
    captureSource?: AttributionFacts["captureSource"] },
  now: number,
): AttributionFacts {
  return {
    threadId: context.thread.id,
    email: identity.email,
    person: identity.person,
    viaFallback: identity.viaFallback ?? false,
    provenance: identity.provenance ?? (identity.viaFallback ? "configured-fallback" : identity.email ? "upstream-header" : "unknown"),
    captureSource: identity.captureSource ?? "unknown",
    origin: context.origin === "mixed" ? null : context.origin,
    originPluginId: context.originPluginId === "mixed" ? null : context.originPluginId,
    lineage: lineageOf({
      threadId: context.thread.id,
      // The hook context's own parent, falling back to the thread row's.
      parentThreadId: context.parentThreadId ?? context.thread.parentThreadId,
      sourceThreadId: context.thread.sourceThreadId,
      senderThreadIds: [context.startedOnBehalfOf?.senderThreadId, context.queuedMessage?.senderThreadId,
        ...(context.queuedMessages ?? []).map((row) => row.senderThreadId)],
    }),
    host: context.host === null ? null : { id: context.host.id, name: context.host.name },
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

/** How many evictions one index append may perform, so a backlog cannot eat the budget. */
export const EVICTIONS_PER_APPEND = 2;

/** How many not-yet-indexed thread ids are carried forward past a wedged kv. */
export const MAX_PENDING_INDEX_APPENDS = 64;

export class AttributionLedger {
  readonly #kv: KvLike;
  readonly #max: number;
  readonly #cacheMax: number;
  readonly #timeoutMs: number;
  /** Bounded read-through cache; `null` means "storage says there is no record". */
  readonly #cache = new Map<string, StarterRecord | null>();
  #index: string[] | null = null;
  /** Thread ids recorded but not yet in the index, carried forward past a wedged kv. */
  #pending: string[] = [];

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
      await this.#appendToIndex(record.threadId);
      return { recorded: true, record };
    } catch {
      this.#cache.delete(record.threadId);
      return { recorded: false, record: null };
    }
  }

  /**
   * Add a thread to the eviction index, and evict what the cap pushed out.
   *
   * EVERY kv call here is timed out INDIVIDUALLY. Wrapping the whole method in one
   * timeout (which is what this used to do) bounded the caller's wait but left the inner
   * call unsettled — one leaked promise per dispatch against a wedged kv — and could
   * leave a record written whose id never reached the index, so it would never be
   * evicted.
   *
   * An id whose index write did not land stays in `#pending` and is retried on the next
   * append, so nothing is lost short of a restart; `#pending` is itself capped, because
   * an unbounded retry list is just another leak. At most `EVICTIONS_PER_APPEND` records
   * are deleted per call, so a long pending list cannot blow the hook's time budget —
   * the rest stay in the index and are evicted on the following appends, which means the
   * index may briefly sit a little above `max`. That is deliberate: the cap is a storage
   * bound, not a promise about an exact count.
   */
  async #appendToIndex(threadId: string): Promise<void> {
    if (!this.#pending.includes(threadId)) this.#pending.push(threadId);
    while (this.#pending.length > MAX_PENDING_INDEX_APPENDS) this.#pending.shift();
    if (this.#index === null) {
      const stored = await withTimeout(this.#kv.get<unknown>(INDEX_KEY), this.#timeoutMs);
      // A hung index read: keep the ids pending and try again on the next record.
      if (stored === TIMED_OUT) return;
      this.#index = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    }
    const appending = [...this.#pending];
    const index = this.#index.filter((id) => !appending.includes(id)).concat(appending);
    const overflow = Math.max(0, index.length - this.#max);
    const evicted = index.splice(0, Math.min(overflow, EVICTIONS_PER_APPEND));
    const written = await withTimeout(this.#kv.set(INDEX_KEY, index), this.#timeoutMs);
    if (written === TIMED_OUT) {
      // The write may still land later, so the in-memory index is no longer trustworthy.
      this.#index = null;
      return;
    }
    this.#index = index;
    this.#pending = [];
    for (const id of evicted) {
      this.#cache.delete(id);
      await withTimeout(this.#kv.delete(KEY_PREFIX + id), this.#timeoutMs);
    }
  }

  /**
   * The starter of every record still retained, for the ONE-SHOT seen-state backfill.
   *
   * COST, stated plainly: one index read plus up to `MAX_STARTER_RECORDS` (2000) kv gets.
   * That is why `SeenPeople` runs this at most once ever per server, behind a durable
   * marker, off every render path — and why the steady-state answer is maintained on the
   * dispatch path instead. Nothing else may call this.
   *
   * Never throws: an unreadable index or record is simply a person this cannot vouch for.
   */
  /**
   * How many records the index holds, for the settings section's ledger fill. ONE index
   * read, never a read per record. Null when the index cannot be read in time.
   */
  async count(): Promise<number | null> {
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(INDEX_KEY), this.#timeoutMs);
      if (stored === TIMED_OUT) return null;
      return Array.isArray(stored) ? stored.filter((id) => typeof id === "string").length : 0;
    } catch {
      return null;
    }
  }

  async starterSweep(): Promise<string[]> {
    let ids: string[] = [];
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(INDEX_KEY), this.#timeoutMs);
      if (stored === TIMED_OUT) return [];
      ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
    const people: string[] = [];
    for (const id of ids.slice(0, this.#max)) {
      const found = await this.get(id);
      const person = found?.starter?.person;
      if (typeof person === "string" && person.length > 0) people.push(person);
    }
    return people;
  }
}

/** The ledger slice one dispatch needs — the class, or a fake in a test. */
export type LedgerLike = {
  get(threadId: string): Promise<StarterRecord | null>;
  record(record: StarterRecord): Promise<{ recorded: boolean; record: StarterRecord | null }>;
};

/** What the `message.dispatch` hook may answer. `wait` is deliberately never used. */
export type DispatchDecision = { action: "proceed" } | { action: "reject"; message: string };

/**
 * What the guardrail decided, and what it did about it.
 *
 * `verdict` and `action` are separate because of audit mode: in `audit` the verdict can
 * be a refusal while the action is always `proceed`. The dispatch audit line carries
 * both, and the difference between them is the "what we would have blocked" the audit
 * exists to report.
 */
export type GuardOutcome = {
  /** The `enforcement` setting in force: "off" | "audit" | "enforce". */
  mode: string;
  /** How the machine classified ("person" | "team" | "unclaimed"), when one was named. */
  hostKind: string | null;
  verdict: { action: "proceed" } | { action: "reject"; rule: string; message: string };
  /** What the hook returns. Never a rejection unless the mode is `enforce`. */
  action: DispatchDecision;
};

/**
 * The guardrail's decision function (step 5, `guardrail.ts`), injected rather than
 * imported so this module stays the OBSERVE half: with no `guard`, attribution can only
 * ever proceed, which is exactly what its tests still hold it to.
 */
export type Guard = (input: {
  facts: AttributionFacts;
  /** The thread's already-recorded attribution: null means this dispatch is its first. */
  existing: StarterRecord | null;
}) => GuardOutcome | Promise<GuardOutcome>;

/** Everything one dispatch knows, handed to the audit log (stream b). */
export type DispatchAuditRecord = {
  facts: AttributionFacts;
  /** The starter already on record, or null when this dispatch is the thread's first. */
  existing: StarterRecord | null;
  outcome: GuardOutcome;
  /**
   * The attribution this dispatch would be recorded as — null when it was refused, which
   * is deliberately never recorded.
   */
  decided: StarterRecord | null;
};

/**
 * The whole hook's time budget, well inside the SDK's 10s fail-closed ceiling.
 *
 * The individual kv calls are each bounded by `KV_TIMEOUT_MS`, but they compose: a
 * worst case of one wedged read after another adds up (the storage arithmetic here is
 * ~8s — see the design note), so the arithmetic alone is not a safe guarantee. This is a
 * single deadline over the whole body instead, and it fails OPEN: a dispatch Identity
 * could not decide about in time proceeds, unrecorded and unrefused. That is the right
 * direction for a guardrail — Identity is not an access control.
 */
export const HOOK_BUDGET_MS = 5_000;

/** The SDK's own limit: a `message.dispatch` handler past this FAILS the attempt. */
export const SDK_HOOK_DECISION_CEILING_MS = 10_000;

export type DispatchDeps = {
  ledger: LedgerLike;
  /** The guardrail. Absent (the default) means nothing can be refused. */
  guard?: Guard;
  /** Overrides the hook's overall deadline. Tests only. */
  budgetMs?: number;
  /** The requester's identity, read from the async request context. May throw. */
  identity: (context: DispatchContextLike) => { email: string | null; person: StarterSummary | null; viaFallback?: boolean;
    provenance?: Provenance; captureSource?: AttributionFacts["captureSource"] } | Promise<{ email: string | null;
    person: StarterSummary | null; viaFallback?: boolean; provenance?: Provenance; captureSource?: AttributionFacts["captureSource"] }>;
  /**
   * The audit log (stream b), injected. Absent means no audit logging at all, which is
   * what `enforcement: off` gets. It must never throw — `emitAudit` swallows — but this
   * call is wrapped anyway, because a logging bug may not fail a dispatch.
   */
  audit?: (record: DispatchAuditRecord) => void;
  now: () => number;
  log: { info: (message: string) => void; warn: (message: string) => void };
  /**
   * Called with the machine this dispatch is headed for, so the host pins see every
   * host bb itself names. Observe-only, time-bounded by the pins' own kv timeout, and
   * its failure is swallowed like everything else here.
   */
  observeHost?: (host: HostRef) => Promise<unknown>;
  /**
   * Called with the person a newly recorded thread was attributed to, so seen-state is
   * MAINTAINED rather than scanned (see `SeenPeople`). Called only for a dispatch that
   * was actually recorded and actually named someone: a refused dispatch never happened,
   * and an unattributed one names nobody. Its failure is swallowed like everything else
   * here — it is bookkeeping, never a gate.
   */
  observeStarter?: (person: string) => Promise<unknown>;
};

/**
 * The whole body of the `message.dispatch` hook, as a testable function.
 *
 * Its contract, which its tests hold it to: it never throws, it always answers within
 * `HOOK_BUDGET_MS`, and the ONLY way it can answer anything but `proceed` is a `guard`
 * that refused. Every failure — a wedged kv, a throwing identity lookup, a corrupt row,
 * a throwing guard — degrades to a warning and a proceed.
 *
 * A refused dispatch is deliberately NOT recorded: the message never runs, so recording
 * a starter for it would attribute a thread to a start that did not happen, and would
 * then let the same person's next, legitimate attempt inherit the wrong answer.
 */
export async function attributeDispatch(
  context: DispatchContextLike,
  deps: DispatchDeps,
): Promise<DispatchDecision> {
  const budget = Math.max(1, deps.budgetMs ?? HOOK_BUDGET_MS);
  const decided = await withTimeout(decideDispatch(context, deps), budget);
  if (decided !== TIMED_OUT) return decided;
  deps.log.warn(
    `identity: gave up on a dispatch after ${budget}ms (storage is not answering); proceeding unrecorded`,
  );
  return { action: "proceed" };
}

async function decideDispatch(context: DispatchContextLike, deps: DispatchDeps): Promise<DispatchDecision> {
  try {
    const facts = factsFromDispatch(context, await deps.identity(context), deps.now());
    // One parallel storage phase, so the slowest single call — not their sum — is what
    // the dispatch waits for: this thread's own record (which is what tells a start from
    // a follow-up), its lineage's records, and the host pins' first sight of the machine.
    const [existing, inheritable] = await Promise.all([
      deps.ledger.get(facts.threadId),
      Promise.all(facts.lineage.map(async (id) => [id, await deps.ledger.get(id)] as const))
        .then((entries) => new Map(entries)),
      facts.host !== null && deps.observeHost !== undefined
        ? deps.observeHost(facts.host).catch((error: unknown) => {
          deps.log.warn(`identity: could not observe the machine: ${(error as Error).message}`);
        })
        : undefined,
    ]);

    const proceed = { action: "proceed" as const };
    const guarded: GuardOutcome = deps.guard === undefined
      ? { mode: "off", hostKind: null, verdict: proceed, action: proceed }
      : await deps.guard({ facts, existing });
    const refused = guarded.action.action === "reject";
    // A refused dispatch is never recorded (the message never runs), so the attribution
    // it WOULD have had is computed for the audit line only.
    const decided = decideAttribution(facts, (id) => inheritable.get(id) ?? null);
    audit(deps, { facts, existing, outcome: guarded, decided: refused ? null : decided });
    if (guarded.action.action === "reject") {
      deps.log.info(`identity: refused a dispatch on thread ${facts.threadId} — ${guarded.action.message}`);
      // Only the two fields bb's `MessageDispatchHookDecision` declares: the guardrail's
      // own `rule` is for Identity's logs and tests, and an extra key handed to core is
      // exactly the shape that failed strict output validation on the machine-list RPC.
      return { action: "reject", message: guarded.action.message };
    }

    const outcome = await deps.ledger.record(decided);
    const starter = decided.starter?.person ?? null;
    if (starter !== null && deps.observeStarter !== undefined) {
      await deps.observeStarter(starter).catch((error: unknown) => {
        deps.log.warn(`identity: could not mark ${starter} seen: ${(error as Error).message}`);
      });
    }
    if (outcome.recorded) {
      deps.log.info(
        `identity: thread ${decided.threadId} started by ${decided.starter?.person ?? "unknown"} `
        + `(via ${decided.via}${decided.inheritedFrom ? `, inherited from ${decided.inheritedFrom}` : ""})`,
      );
    }
  } catch (error) {
    deps.log.warn(`identity: could not record attribution: ${(error as Error).message}`);
  }
  return { action: "proceed" };
}

/** Hand one dispatch to the audit log, never letting a logging failure reach the hook. */
function audit(deps: DispatchDeps, record: DispatchAuditRecord): void {
  if (deps.audit === undefined) return;
  try {
    deps.audit(record);
  } catch (error) {
    deps.log.warn(`identity: could not write an audit line: ${(error as Error).message}`);
  }
}
