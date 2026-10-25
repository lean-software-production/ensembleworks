// Who is where — the room's second membership book.
//
// WHY THERE IS A SECOND ONE AT ALL. `CanvasRoomHost` knows exactly the clients
// that called `canvas_join`, which is the canvas PANEL and nothing else. A bb
// tab sitting on a thread has never joined: it runs the presence strip (a
// content script) and nothing more, so before this module the room could not
// see it, and "which thread is alice looking at" had no possible answer. The
// preflight for this feature proved it — opening two fresh bb tabs (a thread
// and /settings) left `canvas_debug.clientIds` unchanged.
//
// So every tab now reports itself on the roster poll it was already making, and
// this book holds those reports. It is NOT a second identity system: the
// clientId is the same per-tab address `newClientId()` mints (one per tab, now
// shared by the panel and the strip — see canvas/tab-id.ts), and the name is
// the same one `/http/identity` resolves. It is a second MEMBERSHIP list,
// because being in the sync room and being in the building are different facts.
//
// It is deliberately NOT wired into `CanvasRoomHost`: a room member owns a
// `ClientTransport`, and every canvas delta is published once per transport.
// Giving every bb tab in the building one would multiply canvas traffic by the
// number of tabs that will never render a canvas.
//
// Pure and clock-injected — no bb SDK, no node builtins — so the two horizons
// below are testable without waiting for them.

/**
 * How old a location may be and still be an answer.
 *
 * The strip polls every ROSTER_POLL_MS (2s), so this is seven or eight missed
 * polls: long enough that a slow frame, a GC pause or one dropped request
 * changes nothing, short enough that nobody is sent to a page the person left
 * fifteen seconds ago. Past it a member is reported PRESENT WITH NO LOCATION
 * rather than dropped — they are still in the room, we just stopped knowing
 * where. A stale location is worse than none: it is wrong and it looks right.
 */
export const LOCATION_STALE_MS = 15_000;

/**
 * How long a reporter stays in the roster after its last report.
 *
 * Deliberately the same two minutes as `CLIENT_IDLE_MS` in canvas/room.ts, so
 * the two membership books expire people on one clock rather than two. A
 * BACKGROUND TAB STOPS POLLING (the strip skips the poll while
 * `document.hidden`), so this is also the window in which a minimised bb window
 * quietly leaves the room — which is the honest answer, because a hidden tab is
 * not somewhere anyone is.
 */
export const LOCATION_IDLE_MS = 2 * 60 * 1000;

/** A ceiling on the book. Every bb tab reports here and only a sweep removes
 * one, so the cap is what keeps a burst of tabs from becoming a slow leak. */
export const MAX_LOCATION_CLIENTS = 512;

/** One tab telling the room where it is. */
export interface LocationReport {
  readonly clientId: string;
  /** The name this client resolved from `/http/identity`, or null if it has
   * not managed to yet. */
  readonly name: string | null;
  readonly path: string;
  /** The reporting tab's own `document.title`, so a thread can be labelled by
   * title without this server ever looking a thread up. Null off a thread. */
  readonly title: string | null;
  /**
   * Whether that tab had the OS focus when it reported (`document.hasFocus()`).
   *
   * ONE BIT, AND IT EARNS ITS PLACE. A person with two live bb windows has two
   * reporters whose polls drift past each other, so "whichever reported last"
   * is a coin flip that made their whereabouts oscillate between windows —
   * observed live as a blinking thread-row glyph and a jump link that changed
   * href under the pointer. Only one window can hold the focus, so this is the
   * one fact that settles it. Optional on the wire: a bb window running an
   * older bundle simply never claims it.
   */
  readonly focused?: boolean;
}

/** One row of `canvas_roster`'s answer. */
export interface LocatedMember {
  readonly clientId: string;
  readonly name: string;
  /** Null means PRESENT, LOCATION UNKNOWN — never "not here". */
  readonly path: string | null;
  readonly title: string | null;
  /** When this location was reported, so a viewer with two tabs open can be
   * shown the one they are actually using. Null whenever `path` is. */
  readonly seenMs: number | null;
  /** Whether that tab had the focus. Null whenever `path` is: focus is a fact
   * ABOUT a location, and once we have stopped believing where somebody is we
   * cannot claim they are looking at it. */
  readonly focused: boolean | null;
  /**
   * Whether this clientId is in the SYNC ROOM (`room.identities`) — i.e. has an
   * open canvas panel — as opposed to being merely a bb tab that reports where
   * it is.
   *
   * IT EXISTS BECAUSE THE ROSTER GREW A SECOND MEANING. Before locations, "a
   * roster member" and "a canvas client" were the same set, and the sidebar's
   * "N on the canvas" badge could seed itself from `members.length` and then
   * follow the room's identity broadcast without the two ever disagreeing. Now
   * the roster is every bb tab in the building, so the badge needs the room's
   * subset stated explicitly rather than inferred — inferring it from `path`
   * would be a guess (a canvas tab that has not polled yet has no path, and a
   * tab parked on /plugins/canvas/canvas whose panel has unmounted is not a
   * room member). Only the room knows, so the room says.
   */
  readonly inRoom: boolean;
}

interface Entry {
  name: string | null;
  path: string;
  title: string | null;
  seenMs: number;
  focused: boolean;
}

export interface LocationBookOptions {
  readonly maxClients?: number;
  readonly staleMs?: number;
  readonly idleMs?: number;
}

export class LocationBook {
  readonly #entries = new Map<string, Entry>();
  readonly #maxClients: number;
  readonly #staleMs: number;
  readonly #idleMs: number;

  constructor(options: LocationBookOptions = {}) {
    this.#maxClients = options.maxClients ?? MAX_LOCATION_CLIENTS;
    this.#staleMs = options.staleMs ?? LOCATION_STALE_MS;
    this.#idleMs = options.idleMs ?? LOCATION_IDLE_MS;
  }

  /** Record one report. Overwrites whatever that client said last — this is a
   * "where are you now", not a trail. */
  seen(report: LocationReport, nowMs: number): void {
    if (!this.#entries.has(report.clientId)) this.#makeRoom(nowMs);
    this.#entries.set(report.clientId, {
      name: report.name,
      path: report.path,
      title: report.title,
      seenMs: nowMs,
      focused: report.focused === true,
    });
  }

  /** Drop a client outright. */
  forget(clientId: string): void {
    this.#entries.delete(clientId);
  }

  /** Remove every reporter silent past the idle window. Returns how many. */
  sweep(nowMs: number): number {
    let swept = 0;
    for (const [clientId, entry] of [...this.#entries]) {
      if (nowMs - entry.seenMs <= this.#idleMs) continue;
      this.#entries.delete(clientId);
      swept += 1;
    }
    return swept;
  }

  /**
   * The roster: the sync room's members, then everyone else who has reported.
   *
   * A client in BOTH appears once, named by the ROOM — `canvas_join` is the
   * older and better-scrutinised door, and when the two disagree the room's
   * answer is the one to keep (a reporter cannot rename a room member by
   * asserting a different name on a poll).
   *
   * A reporter with no name and no room entry is dropped: a face needs a label,
   * and minting one from the clientId would put a stranger in the strip.
   *
   * Order is deterministic — room members in the room's own order, then
   * reporters by clientId — because a roster that reshuffles between two polls
   * two seconds apart is unreadable.
   */
  members(
    identities: Readonly<Record<string, string>>,
    nowMs: number,
  ): LocatedMember[] {
    const out: LocatedMember[] = [];
    const seen = new Set<string>();

    for (const [clientId, name] of Object.entries(identities)) {
      seen.add(clientId);
      out.push(this.#row(clientId, name, nowMs, true));
    }

    const rest = [...this.#entries.keys()]
      .filter((clientId) => !seen.has(clientId))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const clientId of rest) {
      const entry = this.#entries.get(clientId);
      if (entry === undefined || entry.name === null) continue;
      // A reporter IS its report: past the idle window it is not a member at
      // all, so it leaves the roster rather than lingering as a nameplate with
      // nowhere attached. (Room members take the other branch above — they are
      // still present, merely located nowhere.) Checked here as well as in
      // `sweep` so a host that forgot to sweep still cannot report the dead.
      if (nowMs - entry.seenMs > this.#idleMs) continue;
      out.push(this.#row(clientId, entry.name, nowMs, false));
    }
    return out;
  }

  /** How many reporters the book is holding. Introspection only. */
  get size(): number {
    return this.#entries.size;
  }

  #row(
    clientId: string,
    name: string,
    nowMs: number,
    inRoom: boolean,
  ): LocatedMember {
    const entry = this.#entries.get(clientId);
    const age = entry === undefined ? Infinity : nowMs - entry.seenMs;
    // Two gates, and the second one is belt and braces: `sweep` normally
    // removes an entry past the idle window, but a host that forgot to call it
    // must still never report a location for somebody long gone.
    //
    // `inRoom` is NOT subject to either: staleness is a fact about a LOCATION
    // report, and room membership is a different book with its own expiry (the
    // room's own idle sweep). Forgetting where a canvas client is must not
    // silently drop it out of the sidebar's count.
    if (entry === undefined || age >= this.#staleMs || age > this.#idleMs) {
      return {
        clientId,
        name,
        path: null,
        title: null,
        seenMs: null,
        focused: null,
        inRoom,
      };
    }
    return {
      clientId,
      name,
      path: entry.path,
      title: entry.title,
      seenMs: entry.seenMs,
      focused: entry.focused,
      inRoom,
    };
  }

  /** Evict the least recently heard-from reporter to make room for a new one. */
  #makeRoom(nowMs: number): void {
    if (this.#entries.size < this.#maxClients) return;
    // A sweep first: the cap should only ever bite on genuinely live tabs.
    this.sweep(nowMs);
    while (this.#entries.size >= this.#maxClients) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      for (const [clientId, entry] of this.#entries) {
        if (entry.seenMs < oldestAt) {
          oldestAt = entry.seenMs;
          oldestId = clientId;
        }
      }
      if (oldestId === null) return;
      this.#entries.delete(oldestId);
    }
  }
}
