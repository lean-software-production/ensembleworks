import { z } from "zod";
import { createHash } from "node:crypto";
import { starterSummarySchema } from "./attribution.js";
import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";

const PREFIX = "identity/queued-requester/v1/";
const INDEX = `${PREFIX}index`;
export const MAX_QUEUED_REQUESTERS = 1000;
const snapshotSchema = z.object({
  v: z.literal(1), id: z.string().min(1).max(200), threadId: z.string().min(1).max(200),
  email: z.string().nullable(), person: starterSummarySchema.nullable(),
  provenance: z.enum(["upstream-header", "self-selected", "configured-fallback", "unknown"]),
  requestId: z.string().nullable(), capturedAt: z.number(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
}).strict();
export type QueuedRequester = z.infer<typeof snapshotSchema>;

/** Only a digest is persisted; oversized or unserialisable content stays unclaimed. */
export function digestQueuedContent(content: unknown): string | null {
  try {
    const encoded = JSON.stringify(content);
    if (typeof encoded !== "string" || encoded.length > 1_000_000) return null;
    return createHash("sha256").update(encoded).digest("hex");
  } catch { return null; }
}

/** One immutable requester snapshot per queue row. Missing capture is persisted as unknown. */
export class QueuedRequesterLedger {
  readonly #kv: KvLike;
  readonly #pending = new Map<string, QueuedRequester>();
  readonly #inFlight = new Set<string>();
  readonly #first = new Map<string, QueuedRequester>();
  readonly #tombstones = new Set<string>();
  #indexTail: Promise<unknown> = Promise.resolve();
  readonly #max: number;
  constructor(kv: KvLike, max = MAX_QUEUED_REQUESTERS) {
    this.#kv = kv;
    this.#max = Math.max(1, max);
  }
  #withIndex<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#indexTail.then(work, work);
    this.#indexTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async record(snapshot: QueuedRequester): Promise<boolean> {
    if (!snapshotSchema.safeParse(snapshot).success || this.#tombstones.has(snapshot.id)) return false;
    if (this.#inFlight.has(snapshot.id) || this.#first.has(snapshot.id)) return false;
    this.#inFlight.add(snapshot.id);
    const key = `${PREFIX}${snapshot.id}`;
    let attemptedWrite = false;
    try {
      const stored = await withTimeout(this.#kv.get(key), KV_TIMEOUT_MS);
      if (stored === TIMED_OUT || stored !== undefined || this.#tombstones.has(snapshot.id)) return false;
      this.#pending.set(snapshot.id, snapshot);
      attemptedWrite = true;
      if (await withTimeout(this.#kv.set(key, snapshot), KV_TIMEOUT_MS) === TIMED_OUT) {
        throw new Error("queue row write unavailable");
      }
      if (this.#tombstones.has(snapshot.id)) {
        await withTimeout(this.#kv.delete(key), KV_TIMEOUT_MS);
        return false;
      }
      this.#first.set(snapshot.id, snapshot);
      if (this.#first.size > this.#max) this.#first.delete(this.#first.keys().next().value!);
      await this.#withIndex(async () => {
        const index = await withTimeout(this.#kv.get<string[]>(INDEX), KV_TIMEOUT_MS);
        if (index === TIMED_OUT) throw new Error("queue index unavailable");
        const ids = Array.isArray(index) ? index.filter((id) => typeof id === "string" && id !== snapshot.id) : [];
        ids.push(snapshot.id);
        const evicted = ids.splice(0, Math.max(0, ids.length - this.#max));
        if (await withTimeout(this.#kv.set(INDEX, ids), KV_TIMEOUT_MS) === TIMED_OUT) {
          throw new Error("queue index write unavailable");
        }
        for (const id of evicted) {
          this.#first.delete(id);
          await withTimeout(this.#kv.delete(`${PREFIX}${id}`), KV_TIMEOUT_MS);
        }
      });
      return true;
    } catch {
      this.#first.delete(snapshot.id);
      if (attemptedWrite) {
        try { await withTimeout(this.#kv.delete(key), KV_TIMEOUT_MS); } catch { /* Best effort rollback. */ }
      }
      return false;
    }
    finally {
      // Keep the snapshot available synchronously until persistence has settled.
      this.#pending.delete(snapshot.id);
      this.#inFlight.delete(snapshot.id);
    }
  }

  async lookup(id: string): Promise<QueuedRequester | null> {
    if (this.#tombstones.has(id)) return null;
    const first = this.#first.get(id);
    if (first) return first;
    const pending = this.#pending.get(id);
    if (pending) return pending;
    try {
      const raw = await withTimeout(this.#kv.get(`${PREFIX}${id}`), KV_TIMEOUT_MS);
      const parsed = snapshotSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch { /* Missing attribution never blocks a dispatch. */ }
    return null;
  }

  async forget(id: string): Promise<void> {
    this.#tombstones.add(id);
    if (this.#tombstones.size > this.#max) this.#tombstones.delete(this.#tombstones.values().next().value!);
    this.#pending.delete(id);
    this.#first.delete(id);
    try {
      await withTimeout(this.#kv.delete(`${PREFIX}${id}`), KV_TIMEOUT_MS);
      await this.#withIndex(async () => {
        const index = await withTimeout(this.#kv.get<string[]>(INDEX), KV_TIMEOUT_MS);
        if (Array.isArray(index)) await withTimeout(this.#kv.set(INDEX, index.filter((row) => row !== id)), KV_TIMEOUT_MS);
      });
    } catch { /* Best effort cleanup. */ }
  }

  async forgetThread(threadId: string): Promise<void> {
    try {
      await this.#withIndex(async () => {
        const index = await withTimeout(this.#kv.get<string[]>(INDEX), KV_TIMEOUT_MS);
        if (!Array.isArray(index)) return;
        const rows = await Promise.all(index.map((id) => withTimeout(this.#kv.get(`${PREFIX}${id}`), KV_TIMEOUT_MS)));
        const keep: string[] = [];
        const removals: Promise<unknown>[] = [];
        for (let i = 0; i < index.length; i += 1) {
          const id = index[i]!;
          const row = snapshotSchema.safeParse(rows[i]);
          if (!row.success || row.data.threadId !== threadId) { keep.push(id); continue; }
          this.#tombstones.add(id);
          if (this.#tombstones.size > this.#max) this.#tombstones.delete(this.#tombstones.values().next().value!);
          this.#first.delete(id);
          this.#pending.delete(id);
          removals.push(withTimeout(this.#kv.delete(`${PREFIX}${id}`), KV_TIMEOUT_MS));
        }
        await Promise.all(removals);
        await withTimeout(this.#kv.set(INDEX, keep), KV_TIMEOUT_MS);
      });
    } catch { /* A missing cleanup never blocks thread deletion. */ }
  }
}
