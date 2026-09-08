// Run: npx vitest run tests/locations.test.ts
//
// The server half of "where is everyone": who has reported a location, how long
// that answer is worth believing, and how it merges with the sync room's own
// membership. Pure and clock-injected, for the same reason CanvasRoomHost's
// sweep takes `nowMs` — the two horizons here (a location goes UNKNOWN long
// before its owner goes AWAY) are the whole design, and a test that had to wait
// two minutes to see the second one would never be written.
import { describe, expect, it } from "vitest";
import {
  LOCATION_IDLE_MS,
  LOCATION_STALE_MS,
  LocationBook,
} from "../canvas/locations.js";

const THREAD = "/projects/p1/threads/t1";
const CANVAS = "/plugins/canvas/canvas";

describe("the two horizons", () => {
  it("goes unknown long before it goes away", () => {
    // The whole point: a member who stopped polling is still a member for a
    // while, but their location stops being an answer almost immediately.
    expect(LOCATION_STALE_MS).toBeLessThan(LOCATION_IDLE_MS);
  });
});

describe("LocationBook.members", () => {
  it("carries a reported location back out", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: "Hi" }, 1_000);
    expect(book.members({}, 1_000)).toEqual([
      {
        clientId: "c1",
        name: "alice",
        path: THREAD,
        title: "Hi",
        seenMs: 1_000,
        focused: false,
        inRoom: false,
      },
    ]);
  });

  it("keeps a sync-room member who has never reported a location", () => {
    // A canvas panel that joined a millisecond ago is in the room and has not
    // polled yet. Present, location unknown — never missing.
    const book = new LocationBook();
    expect(book.members({ c9: "bob" }, 1_000)).toEqual([
      { clientId: "c9", name: "bob", path: null, title: null, seenMs: null, focused: null, inRoom: true },
    ]);
  });

  it("gives a room member their reported location", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c9", name: "bob", path: CANVAS, title: null }, 5_000);
    expect(book.members({ c9: "bob" }, 5_000)).toEqual([
      {
        clientId: "c9",
        name: "bob",
        path: CANVAS,
        title: null,
        seenMs: 5_000,
        focused: false,
        inRoom: true,
      },
    ]);
  });

  it("lists each client exactly once when it is in both halves", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c9", name: "bob", path: CANVAS, title: null }, 5_000);
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: null }, 5_000);
    expect(book.members({ c9: "bob" }, 5_000).map((m) => m.clientId)).toEqual([
      "c9",
      "c1",
    ]);
  });

  it("prefers the room's name over the client's own claim", () => {
    // The room's map is built from `canvas_join`, which is the older and more
    // scrutinised door; when both exist they agree, and when they disagree the
    // room wins rather than the last poll.
    const book = new LocationBook();
    book.seen({ clientId: "c9", name: "impostor", path: CANVAS, title: null }, 1);
    expect(book.members({ c9: "bob" }, 1)[0]?.name).toBe("bob");
  });

  it("drops a reporter that never gave a name and is not in the room", () => {
    // There is nothing to draw: a face needs a label, and inventing one from
    // the clientId would put a stranger in the strip.
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: null, path: THREAD, title: null }, 1);
    expect(book.members({}, 1)).toEqual([]);
  });

  it("orders room members first, then reporters by clientId", () => {
    // Deterministic, because two callers a poll apart must not see the roster
    // reshuffle for no reason.
    const book = new LocationBook();
    book.seen({ clientId: "z", name: "zoe", path: THREAD, title: null }, 1);
    book.seen({ clientId: "a", name: "ada", path: THREAD, title: null }, 1);
    expect(book.members({ m: "mike" }, 1).map((m) => m.clientId)).toEqual([
      "m",
      "a",
      "z",
    ]);
  });
});

describe("staleness", () => {
  it("still answers with a location just inside the horizon", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: "Hi" }, 0);
    const member = book.members({}, LOCATION_STALE_MS - 1)[0];
    expect(member?.path).toBe(THREAD);
    expect(member?.title).toBe("Hi");
  });

  it("reports present-but-unknown once the horizon passes", () => {
    // A STALE LOCATION IS WORSE THAN NONE: it sends a teammate to the page you
    // were on a minute ago and tells them nothing went wrong.
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: "Hi" }, 0);
    expect(book.members({}, LOCATION_STALE_MS)).toEqual([
      { clientId: "c1", name: "alice", path: null, title: null, seenMs: null, focused: null, inRoom: false },
    ]);
  });

  it("comes back the moment they report again", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: null }, 0);
    book.seen({ clientId: "c1", name: "alice", path: CANVAS, title: null }, 60_000);
    expect(book.members({}, 60_000)[0]?.path).toBe(CANVAS);
  });
});

describe("expiry", () => {
  it("sweeps a reporter who has been silent past the idle window", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: null }, 0);
    expect(book.sweep(LOCATION_IDLE_MS)).toBe(0);
    expect(book.sweep(LOCATION_IDLE_MS + 1)).toBe(1);
    expect(book.members({}, LOCATION_IDLE_MS + 1)).toEqual([]);
  });

  it("never lets a location outlive the person even without a sweep", () => {
    // Belt and braces: `members` filters on the same window, so a host that
    // forgot to run the sweep still cannot report a dead client.
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: null }, 0);
    expect(book.members({}, LOCATION_IDLE_MS + 1)).toEqual([]);
  });

  it("keeps a swept reporter out of the room's own membership", () => {
    // If the sync room still holds them (a canvas panel pinging away), they
    // are still present — just located nowhere.
    const book = new LocationBook();
    book.seen({ clientId: "c9", name: "bob", path: CANVAS, title: null }, 0);
    book.sweep(LOCATION_IDLE_MS + 1);
    expect(book.members({ c9: "bob" }, LOCATION_IDLE_MS + 1)).toEqual([
      { clientId: "c9", name: "bob", path: null, title: null, seenMs: null, focused: null, inRoom: true },
    ]);
  });

  it("forgets a client on demand", () => {
    const book = new LocationBook();
    book.seen({ clientId: "c1", name: "alice", path: THREAD, title: null }, 0);
    book.forget("c1");
    expect(book.members({}, 0)).toEqual([]);
  });

  it("forgetting an unknown client is a no-op, not a throw", () => {
    const book = new LocationBook();
    expect(() => book.forget("nobody")).not.toThrow();
  });
});

describe("the book does not grow without bound", () => {
  it("evicts the oldest reporter once it is full", () => {
    // Every bb tab in the building reports here, and nothing but a sweep ever
    // removes one. A hard cap means a burst of tabs cannot become a leak.
    const book = new LocationBook({ maxClients: 3 });
    for (const [index, clientId] of ["a", "b", "c"].entries()) {
      book.seen({ clientId, name: clientId, path: THREAD, title: null }, index);
    }
    book.seen({ clientId: "d", name: "d", path: THREAD, title: null }, 10);
    expect(book.members({}, 10).map((m) => m.clientId).sort()).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  it("re-reporting an existing client never evicts anyone", () => {
    const book = new LocationBook({ maxClients: 2 });
    book.seen({ clientId: "a", name: "a", path: THREAD, title: null }, 0);
    book.seen({ clientId: "b", name: "b", path: THREAD, title: null }, 1);
    book.seen({ clientId: "a", name: "a", path: CANVAS, title: null }, 2);
    expect(book.members({}, 2).map((m) => m.clientId).sort()).toEqual(["a", "b"]);
  });
});

describe("the focus flag", () => {
  // One boolean, added to the report for one reason: a person with two live
  // windows needs an answer to "which one are you actually in" that is not a
  // race between two polling timers. `document.hasFocus()` is that answer, and
  // it costs one bit on a call every tab was already making.
  it("carries a reporter's focus back out", () => {
    const book = new LocationBook();
    book.seen(
      { clientId: "c1", name: "alice", path: THREAD, title: null, focused: true },
      1_000,
    );
    expect(book.members({}, 1_000)[0]?.focused).toBe(true);
  });

  it("says false for a tab that reported it does not have focus", () => {
    const book = new LocationBook();
    book.seen(
      { clientId: "c1", name: "alice", path: THREAD, title: null, focused: false },
      1_000,
    );
    expect(book.members({}, 1_000)[0]?.focused).toBe(false);
  });

  it("forgets the focus with the location it belongs to", () => {
    // Focus is a fact about a location, not about a person: past the staleness
    // horizon we do not know where they are, so we cannot know whether they
    // are looking at it either. Reporting a remembered `true` here would let a
    // stale tab out-rank a live one forever.
    const book = new LocationBook();
    book.seen(
      { clientId: "c1", name: "alice", path: THREAD, title: null, focused: true },
      1_000,
    );
    expect(book.members({ c1: "alice" }, 1_000 + LOCATION_STALE_MS)).toEqual([
      { clientId: "c1", name: "alice", path: null, title: null, seenMs: null, focused: null, inRoom: true },
    ]);
  });

  it("says nothing about a room member who has never reported", () => {
    const book = new LocationBook();
    expect(book.members({ c9: "bob" }, 1_000)[0]?.focused).toBe(null);
  });
});
