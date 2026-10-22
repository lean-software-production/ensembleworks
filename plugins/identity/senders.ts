import { createHash } from "node:crypto";
import { z } from "zod";
import { starterSummarySchema, type StarterSummary } from "./attribution.js";
import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";

/**
 * Who sent each prompt on a thread, so an agent can tell two people apart.
 *
 * Attribution records only who STARTED a thread; when two people pair in one thread
 * the agent needs the sender of each message. This ledger keeps a short, bounded list
 * per thread of (content digest, sender, preview), written from the dispatch hook and
 * read back by the `identity_recent_senders` agent tool.
 *
 * Same trust as the rest of Identity: a label, never a credential. Observe-only: nothing
 * here can affect a dispatch, and every storage call is time-bounded and swallowed.
 * Only IDENTIFIED senders are recorded — an unknown sender leaves no entry rather than an
 * "unidentified" one, so the agent is told a name or told nothing.
 */

export const MAX_SENDERS_PER_THREAD = 50;
export const PREVIEW_CHARS = 80;
/** Threads whose sender list is held in memory for the synchronous instructions provider. */
export const MAX_CACHED_THREADS = 256;
const PREFIX = "senders:";

export const senderEntrySchema = z.object({
  /** sha256 of the prompt text, so a caller can match a prompt without trusting order. */
  digest: z.string().length(64),
  person: starterSummarySchema,
  /** The person's default email (directory first, else the request's); absent on the earliest rows. */
  email: z.string().nullable().optional(),
  at: z.number(),
  preview: z.string(),
}).strict();
export type SenderEntry = z.infer<typeof senderEntrySchema>;

const senderLogSchema = z.object({
  v: z.literal(1),
  threadId: z.string().min(1),
  /** Oldest first on disk; `recent()` reverses. */
  entries: z.array(senderEntrySchema),
}).strict();
type SenderLog = z.infer<typeof senderLogSchema>;

export function digestMessageText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** First line only, bounded, with an ellipsis when anything was cut. */
export function previewOf(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const trimmed = firstLine.trim();
  const cut = trimmed.length < text.trim().length || trimmed.length > PREVIEW_CHARS;
  const head = trimmed.slice(0, PREVIEW_CHARS).trimEnd();
  return cut ? `${head}…` : head;
}

export class SenderLedger {
  readonly #kv: KvLike;
  readonly #max: number;
  /** Per-thread in-memory copy; insertion-ordered so it can be bounded LRU-ish. */
  readonly #cache = new Map<string, SenderLog>();
  /** One write chain per thread, so concurrent records on one thread never lose an entry. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(kv: KvLike, max = MAX_SENDERS_PER_THREAD) {
    this.#kv = kv;
    this.#max = Math.max(1, max);
  }

  /**
   * Record one identified sender. Answers false (and writes nothing) for an unidentified
   * sender, for a back-to-back repeat of the same text by the same person (a re-run of
   * one logical dispatch — the hook re-runs on retry and drain), and on any storage
   * failure. The in-memory copy is updated synchronously so `peopleOf` knows the person
   * before storage settles.
   */
  async record(input: { threadId: string; text: string; person: StarterSummary | null; email: string | null; at: number }): Promise<boolean> {
    if (input.person === null) return false;
    const entry: SenderEntry = {
      digest: digestMessageText(input.text), person: input.person, email: input.email, at: input.at, preview: previewOf(input.text),
    };
    const cached = this.#cache.get(input.threadId);
    if (cached && isRepeat(cached.entries.at(-1), entry)) return false;
    if (cached) this.#remember(input.threadId, append(cached, entry, this.#max));
    else this.#remember(input.threadId, { v: 1, threadId: input.threadId, entries: [entry] });

    return this.#serialised(input.threadId, async () => {
      try {
        const stored = await this.#load(input.threadId);
        if (stored === null && cached === undefined) {
          // Nothing on disk: the fresh in-memory log is the truth.
        } else if (stored !== null && isRepeat(stored.entries.at(-1), entry)) {
          this.#remember(input.threadId, stored);
          return false;
        }
        const next = append(stored ?? { v: 1, threadId: input.threadId, entries: [] }, entry, this.#max);
        if (await withTimeout(this.#kv.set(`${PREFIX}${input.threadId}`, next), KV_TIMEOUT_MS) === TIMED_OUT) {
          throw new Error("sender log write unavailable");
        }
        this.#remember(input.threadId, next);
        return true;
      } catch {
        // Memory mirrors storage: undo the optimistic entry rather than remember a write that never happened.
        if (cached) this.#remember(input.threadId, cached);
        else this.#cache.delete(input.threadId);
        return false;
      }
    });
  }

  /** Newest first. Never throws; a broken or corrupt store reads as empty. */
  async recent(threadId: string, limit = 10): Promise<SenderEntry[]> {
    const log = await this.#serialised(threadId, () => this.#load(threadId));
    if (log !== null) this.#remember(threadId, log);
    const entries = (log ?? this.#cache.get(threadId))?.entries ?? [];
    return [...entries].reverse().slice(0, Math.max(0, limit)).map((entry) => ({ ...entry, email: entry.email ?? null }));
  }

  /**
   * Distinct people seen on a thread, first-seen order, from memory only: the
   * instructions provider must be synchronous. An unseen thread answers nobody and
   * starts a background load so the next resolution knows.
   */
  peopleOf(threadId: string): StarterSummary[] {
    const log = this.#cache.get(threadId);
    if (log === undefined) {
      void this.recent(threadId, 0);
      return [];
    }
    const seen = new Map<string, StarterSummary>();
    for (const entry of log.entries) if (!seen.has(entry.person.person)) seen.set(entry.person.person, entry.person);
    return [...seen.values()];
  }

  async #load(threadId: string): Promise<SenderLog | null> {
    try {
      const raw = await withTimeout(this.#kv.get(`${PREFIX}${threadId}`), KV_TIMEOUT_MS);
      if (raw === TIMED_OUT || raw === undefined) return null;
      const parsed = senderLogSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  #remember(threadId: string, log: SenderLog): void {
    this.#cache.delete(threadId);
    this.#cache.set(threadId, log);
    while (this.#cache.size > MAX_CACHED_THREADS) this.#cache.delete(this.#cache.keys().next().value!);
  }

  #serialised<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const tail = this.#tails.get(threadId) ?? Promise.resolve();
    const result = tail.then(work, work);
    const settled = result.then(() => undefined, () => undefined);
    this.#tails.set(threadId, settled);
    void settled.then(() => { if (this.#tails.get(threadId) === settled) this.#tails.delete(threadId); });
    return result;
  }
}

function isRepeat(last: SenderEntry | undefined, entry: SenderEntry): boolean {
  return last !== undefined && last.digest === entry.digest && last.person.person === entry.person.person;
}

function append(log: SenderLog, entry: SenderEntry, max: number): SenderLog {
  const entries = [...log.entries, entry];
  return { ...log, entries: entries.slice(Math.max(0, entries.length - max)) };
}

function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The `Co-authored-by` trailer for a person: their default email, else GitHub's noreply form. */
export function coAuthorTrailer(person: StarterSummary, email: string | null): string {
  return `Co-authored-by: ${person.displayName} <${email ?? `${person.github}@users.noreply.github.com`}>`;
}

/**
 * The `identity_recent_senders` tool's answer: newest first, one line per prompt, then a
 * ready-to-paste commit trailer per distinct person so pairing credit is one copy away.
 */
export function formatRecentSenders(entries: readonly SenderEntry[], now: number): string {
  if (entries.length === 0) return "No identified senders are recorded for this thread yet.";
  const trailers = new Map<string, string>();
  for (const entry of entries) {
    if (!trailers.has(entry.person.person)) trailers.set(entry.person.person, coAuthorTrailer(entry.person, entry.email ?? null));
  }
  return [
    "Recent prompts on this thread, newest first:",
    ...entries.map((entry, index) =>
      `${index + 1}. ${entry.person.displayName} (@${entry.person.github}, ${ago(entry.at, now)}): ${JSON.stringify(entry.preview)}`),
    "",
    "Commit trailers for these people:",
    ...trailers.values(),
  ].join("\n");
}

/** The dynamic instructions line for a thread, or null when nobody is known (say nothing). */
export function senderInstructions(people: readonly StarterSummary[]): string | null {
  if (people.length === 0) return null;
  const names = people.map((person) => `${person.displayName} (@${person.github})`).join(", ");
  if (people.length === 1) {
    return `The person prompting you on this thread so far: ${names}. `
      + "Call identity_recent_senders if you need to check who sent a prompt.";
  }
  return `People who have sent prompts on this thread: ${names}. `
    + "More than one person may be prompting you here, so address them by name and keep each person's "
    + "questions distinct. Call identity_recent_senders to see who sent each recent prompt.";
}
