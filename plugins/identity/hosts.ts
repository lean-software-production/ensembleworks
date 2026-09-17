import { z } from "zod";
import { KV_TIMEOUT_MS, TIMED_OUT, withTimeout, type KvLike } from "./kv.js";
import type { Person } from "./people.js";
import type { StarterSummary } from "./attribution.js";

/**
 * Host mapping: which person, if anyone, a machine belongs to.
 *
 * READ-ONLY AND DISPLAY-ONLY. Nothing in this module rejects, delays or alters a
 * dispatch — it only labels a host `person`, `team` or `unclaimed` so the ownership UI
 * can say who a thread runs as. The guardrail (step 5) is a separate, later change.
 *
 * `Host` carries no owner field in bb (SDK `hostSchema`), so ownership is derived from
 * the `<box>-<person>` naming convention — and names can be changed by anyone
 * (`PATCH /hosts/:id`). So a derived owner is PINNED by host id on first sight, and a
 * later name that disagrees with the pin is NOT followed: it is reported as a conflict
 * for a human to look at.
 */

export type HostRef = { id: string; name: string };

export const hostRefSchema = z.object({ id: z.string(), name: z.string() }).strict();

export const hostPinSchema = z.object({
  hostId: z.string().min(1),
  /** The directory `person` id this host was pinned to. */
  person: z.string().min(1),
  /** The host name that produced the pin, kept so a rename can be reported. */
  name: z.string(),
  pinnedAt: z.number(),
}).strict();
export type HostPin = z.infer<typeof hostPinSchema>;

/** A pinned owner that the host's current name disagrees with. Display only. */
export type HostPinConflict = {
  pinnedName: string;
  pinnedPerson: string;
  currentName: string;
};

export type HostClassification =
  | { kind: "person"; hostId: string; hostName: string; person: StarterSummary; conflict: HostPinConflict | null }
  | { kind: "team"; hostId: string; hostName: string; conflict: null }
  | { kind: "unclaimed"; hostId: string; hostName: string; conflict: null };

export type HostKind = HostClassification["kind"];

/**
 * The `teamMachines` setting: host names, one per line or comma separated (a JSON array
 * is accepted too, because that is how the directory setting is written).
 */
export function parseTeamMachines(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  let parts: string[];
  if (trimmed.startsWith("[")) {
    try {
      const json: unknown = JSON.parse(trimmed);
      parts = Array.isArray(json) ? json.filter((value): value is string => typeof value === "string") : [];
    } catch {
      parts = [];
    }
  } else {
    parts = trimmed.split(/[\n,]/);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const name = part.trim();
    if (name.length === 0 || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

function summarize(person: Person): StarterSummary {
  return { person: person.person, displayName: person.displayName, github: person.github };
}

/**
 * The person a host name names, by the `<box>-<person>` convention: the last
 * dash-separated segment, matched case-insensitively against the directory's `person`
 * ids and github handles. Null when it matches nobody — including the team machine,
 * whose last segment ("main") is deliberately not a person.
 */
export function personFromHostName(name: string, people: readonly Person[]): Person | null {
  const segment = name.trim().split("-").pop()?.toLowerCase() ?? "";
  if (segment.length === 0) return null;
  return people.find((entry) =>
    entry.person.toLowerCase() === segment || entry.github.toLowerCase() === segment) ?? null;
}

/** A pinned person who is no longer in the directory still gets a name to render. */
function pinnedSummary(pin: HostPin, people: readonly Person[]): StarterSummary {
  const known = people.find((entry) => entry.person === pin.person);
  return known ? summarize(known) : { person: pin.person, displayName: pin.person, github: pin.person };
}

/**
 * Label one host.
 *
 * Order: the `teamMachines` setting wins (team membership is configuration, and a
 * machine moved onto that list is meant to be team); then the pin; then the name; and
 * anything left is **unclaimed** — never silently folded into "team" (answer 6).
 */
export function classifyHost(
  host: HostRef,
  context: { people: readonly Person[]; teamMachines: readonly string[]; pin: HostPin | null },
): HostClassification {
  const base = { hostId: host.id, hostName: host.name } as const;
  const isTeam = context.teamMachines.some((name) => name.toLowerCase() === host.name.trim().toLowerCase());
  if (isTeam) return { kind: "team", ...base, conflict: null };

  const derived = personFromHostName(host.name, context.people);
  const pin = context.pin;
  if (pin !== null) {
    const disagrees = (derived?.person ?? null) !== pin.person;
    return {
      kind: "person",
      ...base,
      person: pinnedSummary(pin, context.people),
      conflict: disagrees
        ? { pinnedName: pin.name, pinnedPerson: pin.person, currentName: host.name }
        : null,
    };
  }
  if (derived !== null) return { kind: "person", ...base, person: summarize(derived), conflict: null };
  return { kind: "unclaimed", ...base, conflict: null };
}

export type PinDecision =
  | { action: "pin"; pin: HostPin }
  | { action: "keep" }
  | { action: "none" };

/** Pin a host to the person its name names, once. A later disagreement is never followed. */
export function decidePin(
  existing: HostPin | null,
  host: HostRef,
  people: readonly Person[],
  now: number,
): PinDecision {
  if (existing !== null) return { action: "keep" };
  const derived = personFromHostName(host.name, people);
  if (derived === null) return { action: "none" };
  return { action: "pin", pin: { hostId: host.id, person: derived.person, name: host.name, pinnedAt: now } };
}

const PIN_PREFIX = "identity/host-pin/v1/";

/**
 * The durable `hostId -> person` pins, in `bb.storage.kv`.
 *
 * Bounded by construction: one small record per host id, and a host id only ever
 * arrives from bb itself (the dispatch hook's `context.host`, or the server's own host
 * list), never from a browser. Every call is time-bounded and never throws, because the
 * dispatch hook that drives `observe` must never fail an attempt.
 */
export class HostPins {
  readonly #kv: KvLike;
  readonly #timeoutMs: number;
  #people: readonly Person[];
  readonly #cache = new Map<string, HostPin | null>();
  /** Conflicts seen since load, for the operator-facing read path. Display only. */
  readonly #conflicts = new Map<string, HostPinConflict>();

  constructor(kv: KvLike, people: readonly Person[], options: { timeoutMs?: number } = {}) {
    this.#kv = kv;
    this.#people = people;
    this.#timeoutMs = Math.max(1, options.timeoutMs ?? KV_TIMEOUT_MS);
  }

  /** The directory changes without a reload, so the pins follow it. */
  setPeople(people: readonly Person[]): void {
    this.#people = people;
  }

  async get(hostId: string): Promise<HostPin | null> {
    const cached = this.#cache.get(hostId);
    if (cached !== undefined) return cached;
    let pin: HostPin | null = null;
    try {
      const stored = await withTimeout(this.#kv.get<unknown>(PIN_PREFIX + hostId), this.#timeoutMs);
      if (stored === TIMED_OUT) return null;
      const parsed = stored === undefined ? null : hostPinSchema.safeParse(stored);
      pin = parsed && parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
    this.#cache.set(hostId, pin);
    return pin;
  }

  /**
   * Record what a host is called right now: pin it on first sight, and on a later
   * disagreement keep the pin and remember the conflict. Returns the pin in force.
   */
  async observe(host: HostRef, now = Date.now()): Promise<HostPin | null> {
    const existing = await this.get(host.id);
    const decision = decidePin(existing, host, this.#people, now);
    if (decision.action === "pin") {
      try {
        const written = await withTimeout(this.#kv.set(PIN_PREFIX + host.id, decision.pin), this.#timeoutMs);
        if (written === TIMED_OUT) return null;
      } catch {
        return null;
      }
      this.#cache.set(host.id, decision.pin);
      return decision.pin;
    }
    if (existing !== null) {
      const derived = personFromHostName(host.name, this.#people);
      if ((derived?.person ?? null) !== existing.person) {
        this.#conflicts.set(host.id, {
          pinnedName: existing.name,
          pinnedPerson: existing.person,
          currentName: host.name,
        });
      } else {
        this.#conflicts.delete(host.id);
      }
    }
    return existing;
  }

  conflicts(): HostPinConflict[] {
    return [...this.#conflicts.values()];
  }
}
