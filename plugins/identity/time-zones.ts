import { ago } from "./ago.js";
import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";

/**
 * The time zone each person's own BB app reports, so an agent can work out what
 * "today" or "tomorrow" means for the person prompting it.
 *
 * The server's clock is UTC and bb records no time zone with a prompt. Identity's
 * frontend already sends a presence heartbeat every few seconds from each person's
 * client, so it adds the browser's IANA zone to that heartbeat; this store keeps the
 * latest zone per identified person and when it was last reported.
 *
 * Same trust as the rest of Identity: a label the person's browser chose, never a
 * credential. Memory always holds the latest report (the instructions provider is
 * synchronous and reads it); kv holds a copy for restarts, written only when the zone
 * changes or the copy is `TIME_ZONE_REFRESH_MS` old, so the heartbeat rate never
 * becomes a write rate. Every storage call is time-bounded and nothing here throws.
 */

/** One kv row holding `person -> { zone, at }`. */
export const TIME_ZONES_KEY = "identity/time-zone/v1";
/** How many people's zones are kept; the least recently reported are dropped past this. */
export const MAX_TIME_ZONE_PEOPLE = 256;
/** An unchanged zone is written back at most this often. */
export const TIME_ZONE_REFRESH_MS = 15 * 60 * 1_000;
/** No person's zone is written more often than this, even when it changes (two devices disagreeing). */
export const TIME_ZONE_MIN_WRITE_MS = 60 * 1_000;

export type ReportedTimeZone = { zone: string; at: number };

const ZONE_SHAPE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_ZONE_CHARS = 100;

/**
 * The zone as the browser reported it, or null when it is not one Intl knows. The
 * browser's own name is kept rather than ICU's canonical form (ICU turns Asia/Kolkata
 * into Asia/Calcutta), so the agent sees the name the person's device uses.
 */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (zone.length === 0 || zone.length > MAX_ZONE_CHARS || !ZONE_SHAPE.test(zone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** The weekday, date, 24-hour time and UTC offset in `zone` at `now`. */
export function localTimeIn(zone: string, now: number): string {
  const parts = new Map(new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const offset = (parts.get("timeZoneName") ?? "").replace(/^GMT/, "UTC");
  return `${parts.get("weekday")} ${parts.get("day")} ${parts.get("month")} ${parts.get("year")}, `
    + `${parts.get("hour")}:${parts.get("minute")} (${offset === "UTC+0" ? "UTC" : offset})`;
}

/** One person's zone for an agent to read, or a plain statement that there is none. */
export function describeReportedTimeZone(reported: ReportedTimeZone | null, now: number): string {
  if (reported === null) return "no time zone reported by their BB app";
  return `${reported.zone}, local time ${localTimeIn(reported.zone, now)}, reported ${ago(reported.at, now)}`;
}

function readRow(stored: unknown): Map<string, ReportedTimeZone> {
  const rows = new Map<string, ReportedTimeZone>();
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return rows;
  for (const [person, value] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const { zone, at } = value as { zone?: unknown; at?: unknown };
    const normalized = normalizeTimeZone(zone);
    if (normalized !== null && typeof at === "number" && Number.isFinite(at)) rows.set(person, { zone: normalized, at });
  }
  return rows;
}

export class ReportedTimeZones {
  readonly #kv: KvLike;
  readonly #timeoutMs: number;
  readonly #max: number;
  /** The latest report per person: what every reader sees. */
  #memory = new Map<string, ReportedTimeZone>();
  /** What kv is believed to hold, to decide when a write is due. */
  #persisted = new Map<string, ReportedTimeZone>();
  /**
   * False until the stored row has been read. A write before then could drop everyone
   * else's zone from the row, so writes wait for a successful read.
   */
  #loaded = false;
  /** One storage chain, so loads and writes never interleave. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(kv: KvLike, options: { timeoutMs?: number; max?: number } = {}) {
    this.#kv = kv;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? KV_TIMEOUT_MS);
    this.#max = Math.max(1, options.max ?? MAX_TIME_ZONE_PEOPLE);
  }

  /** Warm memory from kv. A stored report never replaces a newer one already in memory. */
  load(): Promise<void> {
    return this.#serialised(() => this.#load());
  }

  /** The latest zone this person's app reported, from memory, or null. */
  get(person: string): ReportedTimeZone | null {
    return this.#memory.get(person) ?? null;
  }

  /**
   * Record a report. Answers false, changing nothing, for an invalid zone. Memory is
   * updated before this returns its promise; the kv copy follows when a write is due.
   */
  async report(person: string, zone: unknown, now: number): Promise<boolean> {
    const normalized = normalizeTimeZone(zone);
    if (normalized === null || person.length === 0) return false;
    this.#memory.set(person, { zone: normalized, at: now });
    this.#memory = this.#bounded(this.#memory);
    const last = this.#persisted.get(person);
    const due = last === undefined || (now - last.at >= TIME_ZONE_MIN_WRITE_MS
      && (last.zone !== normalized || now - last.at >= TIME_ZONE_REFRESH_MS));
    if (due) await this.#serialised(() => this.#write());
    return true;
  }

  async #load(): Promise<void> {
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(TIME_ZONES_KEY), this.#timeoutMs);
      if (stored === TIMED_OUT) return;
      this.#persisted = readRow(stored);
      for (const [person, reported] of this.#persisted) {
        const current = this.#memory.get(person);
        if (current === undefined || current.at < reported.at) this.#memory.set(person, reported);
      }
      this.#memory = this.#bounded(this.#memory);
      this.#loaded = true;
    } catch {
      // Unreadable storage: memory carries on, and writes wait for a good read.
    }
  }

  async #write(): Promise<void> {
    if (!this.#loaded) await this.#load();
    if (!this.#loaded) return;
    const snapshot = new Map(this.#memory);
    try {
      const written = await withTimeout(this.#kv.set(TIME_ZONES_KEY, Object.fromEntries(snapshot)), this.#timeoutMs);
      if (written !== TIMED_OUT) this.#persisted = snapshot;
    } catch {
      // Not written: `#persisted` is unchanged, so the next report tries again.
    }
  }

  /** The most recently reported `#max` people. */
  #bounded(rows: Map<string, ReportedTimeZone>): Map<string, ReportedTimeZone> {
    if (rows.size <= this.#max) return rows;
    return new Map([...rows].sort((left, right) => right[1].at - left[1].at).slice(0, this.#max));
  }

  #serialised<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** `bb identity time-zones`: every directory person, in directory order, with their reported zone. */
export function formatDirectoryTimeZones(people: ReadonlyArray<{ person: string; github: string; displayName: string }>,
  timeZoneOf: (person: { person: string }) => ReportedTimeZone | null, now: number): string {
  if (people.length === 0) return "Identity's directory lists nobody, so there are no time zones to show.\n";
  return [
    "Time zones reported by each person's BB app:",
    ...people.map((person) => `- ${person.displayName} (@${person.github}): ${describeReportedTimeZone(timeZoneOf(person), now)}`),
    "",
  ].join("\n");
}
