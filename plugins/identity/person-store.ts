import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";
import { normalizeColorChoice } from "./person-colors.js";

/**
 * The two durable, per-person facts the people page needs: the colour someone CHOSE, and
 * whether Identity has ever seen them.
 *
 * ## Why these live in `bb.storage.kv` and NOT in the `directory` setting
 *
 * READ THIS BEFORE "SIMPLIFYING" IT. The obvious move is to hang a `color` field off the
 * directory entry — one place, one schema, no store. It does not work here:
 *
 *   **The `directory` setting is RENDERED BY ANSIBLE from `ew_bb_people` in the infra
 *   repo.** Every `ew_bb` run writes that setting out again from the infra source of
 *   truth. Anything a person chose through this UI and we wrote back into `directory`
 *   would survive exactly until the next Ansible run and then vanish, silently, with no
 *   error anywhere — the worst possible failure for a preference.
 *
 * So: the directory is read-only INPUT to this plugin, and every per-person fact Identity
 * itself produces is written to kv, which Ansible does not touch. The same argument
 * covers seen-state, which is a fact about this server, not about the org's people list.
 *
 * Both stores follow the discipline the rest of this plugin uses: every kv call is
 * time-bounded (`KV_TIMEOUT_MS`), nothing ever throws at its caller, and storage is
 * bounded by construction — the seen-state writer is on the dispatch path.
 */

/** One kv row holding `person -> #rrggbb`. One row, so a read is one call. */
export const COLOR_OVERRIDES_KEY = "identity/person-color/v1";

/**
 * How many people may have a chosen colour at once.
 *
 * A bound rather than a product limit: the write path refuses a person the directory
 * does not list, so this can only be reached by a directory far larger than any team —
 * but "can only" is not "cannot", and an unbounded kv row is not something this plugin
 * ships. Comfortably inside kv's 256KB per-value limit (256 × ~24 bytes ≈ 6KB).
 */
export const MAX_COLOR_OVERRIDES = 256;

/** What a colour write did, or why it did nothing. */
export type ColorWrite =
  | { ok: true; person: string; from: string | null; to: string | null }
  | { ok: false; person: string; reason: string };

function readOverrides(stored: unknown): Record<string, string> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const rows: Record<string, string> = {};
  for (const [person, value] of Object.entries(stored as Record<string, unknown>)) {
    // Re-proved on the way OUT as well as in: this string reaches a `style` attribute,
    // and the row may have been written by an older or buggier version of this code.
    const color = normalizeColorChoice(typeof value === "string" ? value : null);
    if (color !== null) rows[person] = color;
  }
  return rows;
}

/** The chosen colours, `person -> #rrggbb`. */
export class PersonColorStore {
  readonly #kv: KvLike;
  readonly #timeoutMs: number;
  /** Null until the single row has been read once; the row is small and rarely written. */
  #rows: Record<string, string> | null = null;

  constructor(kv: KvLike, options: { timeoutMs?: number } = {}) {
    this.#kv = kv;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? KV_TIMEOUT_MS);
  }

  /**
   * The stored row, distinguishing "there is nothing" from "storage would not say".
   *
   * A write path MUST have that distinction: reporting "cleared" to someone whose
   * override may still be sitting in an unreadable kv is exactly the kind of quiet lie
   * this plugin is not allowed to tell. The READ path collapses both to empty, because a
   * roster that renders dealt colours is the right degradation.
   */
  async #read(): Promise<{ ok: boolean; rows: Record<string, string> }> {
    if (this.#rows !== null) return { ok: true, rows: this.#rows };
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(COLOR_OVERRIDES_KEY), this.#timeoutMs);
      // A wedged kv is a failure, not an answer: do not cache it.
      if (stored === TIMED_OUT) return { ok: false, rows: {} };
      this.#rows = readOverrides(stored);
      return { ok: true, rows: this.#rows };
    } catch {
      return { ok: false, rows: {} };
    }
  }

  /** Every chosen colour. Empty — never a throw — when storage will not answer. */
  async all(): Promise<Record<string, string>> {
    return (await this.#read()).rows;
  }

  async #write(rows: Record<string, string>, result: ColorWrite): Promise<ColorWrite> {
    try {
      const written = await withTimeout(this.#kv.set(COLOR_OVERRIDES_KEY, rows), this.#timeoutMs);
      if (written === TIMED_OUT) {
        // The write may still land later, so what is in memory is no longer trustworthy.
        this.#rows = null;
        return { ok: false, person: result.person, reason: "storage did not answer in time" };
      }
      this.#rows = rows;
      return result;
    } catch (error) {
      this.#rows = null;
      return { ok: false, person: result.person, reason: `storage refused the write (${(error as Error).message})` };
    }
  }

  /**
   * Choose `person`'s colour.
   *
   * ANYONE may set ANYONE's — that is the owner's decision and it matches the plugin's
   * trust model (a guardrail against mistakes; the Access header is never verified), plus
   * teammates who never open settings still need a colour someone can fix. The protection
   * is visibility: the caller writes an audit line naming who changed whose, from and to.
   *
   * A person the directory does not list is REFUSED, so a typo cannot quietly accumulate
   * rows nobody will ever see or clean up.
   */
  async set(person: string, color: string, directory: readonly string[]): Promise<ColorWrite> {
    if (!directory.includes(person)) {
      return { ok: false, person, reason: `"${person}" is not in Identity's directory` };
    }
    const normalized = normalizeColorChoice(color);
    if (normalized === null) {
      return { ok: false, person, reason: `"${color}" is not a colour; expected #rrggbb` };
    }
    const current = await this.#read();
    if (!current.ok) return { ok: false, person, reason: "storage did not answer, so nothing was changed" };
    const from = current.rows[person] ?? null;
    if (from === null && Object.keys(current.rows).length >= MAX_COLOR_OVERRIDES) {
      return { ok: false, person, reason: `Identity keeps at most ${MAX_COLOR_OVERRIDES} chosen colours` };
    }
    return this.#write({ ...current.rows, [person]: normalized }, { ok: true, person, from, to: normalized });
  }

  /**
   * Return `person` to their dealt colour.
   *
   * Deliberately NOT gated on the directory: a person removed from `ew_bb_people` still
   * has a row here, and clearing is the only way it ever leaves.
   */
  async clear(person: string): Promise<ColorWrite> {
    const current = await this.#read();
    if (!current.ok) return { ok: false, person, reason: "storage did not answer, so nothing was changed" };
    const from = current.rows[person] ?? null;
    if (from === null) return { ok: true, person, from: null, to: null };
    const next = { ...current.rows };
    delete next[person];
    return this.#write(next, { ok: true, person, from, to: null });
  }
}

/** One kv row holding `person -> last time a thread was attributed to them`. */
export const SEEN_KEY = "identity/seen/v1";
/** Set once the one-shot backfill sweep has run, so it never runs twice. */
export const SEEN_BACKFILL_KEY = "identity/seen/v1/backfilled";

/**
 * How stale a sighting must be before it is written again.
 *
 * `observe` runs on the DISPATCH PATH, so the cost that matters is writes per message,
 * not per person. Coalescing to an hour makes the steady-state cost of seen-state
 * one kv write per person per hour, and zero for every other message.
 */
export const SEEN_WRITE_COALESCE_MS = 60 * 60 * 1_000;

/** How many people's sightings are kept. The oldest is dropped past this. */
export const MAX_SEEN_PEOPLE = 256;

function readSeen(stored: unknown): Record<string, number> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const rows: Record<string, number> = {};
  for (const [person, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) rows[person] = value;
  }
  return rows;
}

/**
 * Has Identity ever attributed a thread to this person?
 *
 * ## The cost, and why it is shaped this way
 *
 * The naive answer is to scan `AttributionLedger`'s records at render time. That is up to
 * 2000 kv reads EVERY time someone opens the settings page — unacceptable, and it gets
 * worse exactly as the server gets more used.
 *
 * Instead the answer is MAINTAINED: the dispatch that records a thread's starter also
 * marks that person seen, which is O(1) and coalesced to at most one write per person per
 * hour. Reading it is ONE kv get, cached. The settings page therefore costs nothing.
 *
 * Because that only knows about dispatches since this code shipped, there is ONE bounded
 * catch-up sweep of the records the ledger still retains — at most `MAX_STARTER_RECORDS`
 * (2000) reads, once ever per server, off the render path, with a durable marker so a
 * restart does not repeat it.
 *
 * **What the answer therefore means, exactly:** "a thread has been attributed to them
 * within the records Identity still retains, or at any time since seen-state shipped".
 * It is NOT "they have never used this server" — the ledger keeps only the newest 2000
 * threads, and Identity did not exist for this server's whole life. The UI must say the
 * narrower thing.
 */
export class SeenPeople {
  readonly #kv: KvLike;
  readonly #timeoutMs: number;
  readonly #max: number;
  #rows: Record<string, number> | null = null;

  constructor(kv: KvLike, options: { timeoutMs?: number; max?: number } = {}) {
    this.#kv = kv;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? KV_TIMEOUT_MS);
    this.#max = Math.max(1, options.max ?? MAX_SEEN_PEOPLE);
  }

  async all(): Promise<Record<string, number>> {
    if (this.#rows !== null) return this.#rows;
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(SEEN_KEY), this.#timeoutMs);
      if (stored === TIMED_OUT) return {};
      this.#rows = readSeen(stored);
      return this.#rows;
    } catch {
      return {};
    }
  }

  /** Drop the oldest sightings until the row is inside the cap. */
  #bound(rows: Record<string, number>): Record<string, number> {
    const entries = Object.entries(rows);
    if (entries.length <= this.#max) return rows;
    entries.sort((left, right) => right[1] - left[1]);
    return Object.fromEntries(entries.slice(0, this.#max));
  }

  async #save(rows: Record<string, number>): Promise<boolean> {
    const bounded = this.#bound(rows);
    try {
      const written = await withTimeout(this.#kv.set(SEEN_KEY, bounded), this.#timeoutMs);
      if (written === TIMED_OUT) {
        this.#rows = null;
        return false;
      }
      this.#rows = bounded;
      return true;
    } catch {
      this.#rows = null;
      return false;
    }
  }

  /**
   * Mark a person seen. Called from the dispatch path, so it never throws and writes only
   * when the sighting is new or `SEEN_WRITE_COALESCE_MS` stale.
   */
  async observe(person: string | null, now: number): Promise<void> {
    if (person === null || person.length === 0) return;
    const current = await this.all();
    const last = current[person];
    if (last !== undefined && now - last < SEEN_WRITE_COALESCE_MS) return;
    await this.#save({ ...current, [person]: now });
  }

  /**
   * The one-shot catch-up sweep over the records the ledger still retains.
   *
   * `sweep` returns the starter person of every retained record (duplicates and all); it
   * is injected so this module never depends on the ledger. Fire-and-forget: it never
   * throws, and a failure leaves the marker unset so the next boot can try again.
   *
   * A sighting already on record is NEVER overwritten by the sweep's flat timestamp — the
   * maintained set is the more precise of the two.
   */
  async backfill(sweep: () => Promise<readonly string[]>, now: number): Promise<void> {
    try {
      const done = await withTimeout(this.#kv.get<unknown>(SEEN_BACKFILL_KEY), this.#timeoutMs);
      if (done === TIMED_OUT || done !== undefined) return;
      const people = await sweep();
      const rows = { ...(await this.all()) };
      for (const person of people) {
        if (person.length > 0 && rows[person] === undefined) rows[person] = now;
      }
      if (!(await this.#save(rows))) return;
      await withTimeout(this.#kv.set(SEEN_BACKFILL_KEY, { at: now, records: people.length }), this.#timeoutMs);
    } catch {
      // Deliberately silent, and deliberately without the marker: a sweep that failed
      // should be retried on the next boot, not recorded as done.
    }
  }
}
