// Run: npx vitest run   (or `npm test`)
//
// The three decisions behind the roster UI, tested where they live — as pure
// functions, with no DOM and no bb host: who appears in the avatar stack, where
// the camera lands when you click one, and where a speaking ring is drawn.
import { describe, expect, it } from "vitest";
import type { Presence } from "@ensembleworks/canvas-sync";
import {
  buildRoster,
  cameraCenteredOn,
  initialsFor,
  panIntentFor,
  onCanvasCount,
  speakerRingsFor,
  type CountableMember,
} from "../canvas/roster.js";
import { colorForName } from "../canvas/identity.js";

const VIEWPORT = { width: 800, height: 600 };

/** A presence entry with just the field the roster cares about. */
function at(x: number, y: number): Presence {
  return { cursor: { x, y }, viewport: null, stamp: null, presenting: [], editing: null };
}

const NO_CURSOR: Presence = {
  cursor: null,
  viewport: null,
  stamp: null,
  presenting: [],
  editing: null,
};

describe("buildRoster", () => {
  it("lists room membership, you first then alphabetical", async () => {
    const roster = buildRoster(
      { me: "zoe", "client-b": "bob", "client-a": "alice" },
      {},
      "me",
      "zoe",
    );
    expect(roster.map((member) => member.name)).toEqual(["zoe", "alice", "bob"]);
    expect(roster[0]!.isSelf).toBe(true);
  });

  it("colours each member from their name, matching their cursor label", () => {
    const roster = buildRoster({ "client-a": "alice" }, {}, "me", "zoe");
    const alice = roster.find((member) => member.name === "alice");
    expect(alice!.color).toBe(colorForName("alice"));
  });

  it("includes you before the room has broadcast your name back", () => {
    // The identity fetch lands before the first join, but the broadcast that
    // carries it to everyone (including us) is a round trip behind. An avatar
    // stack you are not in reads as a bug.
    const roster = buildRoster({}, {}, "me", "zoe");
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ clientId: "me", name: "zoe", isSelf: true });
  });

  it("keeps a member who has published no presence, but marks them cursorless", () => {
    // Membership is the source of truth, not presence: somebody who just opened
    // the page has moved no pointer, and they are exactly who you want to see
    // arrive.
    const roster = buildRoster(
      { "client-a": "alice", "client-b": "bob" },
      { "client-a": at(10, 10), "client-b": NO_CURSOR },
      "me",
      "zoe",
    );
    const byName = Object.fromEntries(roster.map((m) => [m.name, m.hasCursor]));
    expect(byName).toEqual({ zoe: false, alice: true, bob: false });
  });

  // -------------------------------------------------------------------------
  // PAGE-SCOPED, on the same terms as the cursors and the speaker rings
  // (design doc D-4). `hasCursor` is not a fact about the room, it is the
  // answer to "is there somewhere honest to fly this camera?" — and it drives
  // the dock's pan button (DockBubble.canPan, canvas/dock/model.ts), whose
  // tooltip promises "jump to their cursor". Once D-4 hides a peer on another
  // page, that promise cannot be kept: the click would land on empty canvas
  // where nothing is drawn. The rule is canvas-react's `isOnOtherPage` again,
  // called and not re-derived, so the strip, the rings and the cursors can
  // never disagree about who is elsewhere.
  // -------------------------------------------------------------------------
  const hasCursorFor = (
    page: string | null | undefined,
    localPage?: string,
  ): boolean => {
    const presence: Record<string, Presence> = {
      "client-a": {
        ...at(10, 10),
        ...(page === undefined ? {} : { page }),
      },
    };
    const roster = buildRoster(
      { "client-a": "alice" },
      presence,
      "me",
      "zoe",
      localPage,
    );
    return roster.find((member) => member.name === "alice")!.hasCursor;
  };

  it("marks a peer on ANOTHER page as having no cursor to jump to", () => {
    // THE FAILURE THIS FORBIDS, in the user's words: bob is on page 2, you are
    // on page 1, his avatar is enabled and titled "bob — jump to their
    // cursor", you click it, and the camera flies to his world point on YOUR
    // page — where D-4 has just hidden his cursor. Empty canvas, no
    // explanation. Before page filtering that click was coherent.
    expect(hasCursorFor("page:b", "page:a")).toBe(false);
  });

  it("keeps a peer on the SAME page pannable, exactly as before", () => {
    expect(hasCursorFor("page:a", "page:a")).toBe(true);
  });

  it("keeps a peer who published NO page pannable", () => {
    // Back-compatibility, the invariant that must never regress: absent means
    // UNKNOWN, never "elsewhere". A peer on an older bundle publishes no page,
    // and their cursor is still drawn — so the jump still lands on something.
    expect(hasCursorFor(undefined, "page:a")).toBe(true);
    expect(hasCursorFor(null, "page:a")).toBe(true);
  });

  it("filters nobody when the caller passes no local page", () => {
    // The parameter is optional and last so every existing caller keeps its
    // current meaning — the same shape `speakerRingsFor` took.
    expect(hasCursorFor("page:b", undefined)).toBe(true);
  });
});

describe("initialsFor", () => {
  it.each([
    ["alice", "AL"],
    ["local:mrdavidlaing", "MR"],
    ["ada.lovelace", "AL"],
    ["ada-lovelace", "AL"],
    ["ada lovelace", "AL"],
    ["local:", "?"],
  ])("%s -> %s", (name, expected) => {
    expect(initialsFor(name)).toBe(expected);
  });
});

describe("cameraCenteredOn", () => {
  it("puts the point in the middle of the viewport and leaves zoom alone", () => {
    const camera = cameraCenteredOn({ x: 500, y: 250 }, VIEWPORT, 2);
    expect(camera.z).toBe(2);
    // canvas-editor's normative convention: screen = (world + camera.xy) * z.
    const screen = {
      x: (500 + camera.x) * camera.z,
      y: (250 + camera.y) * camera.z,
    };
    expect(screen).toEqual({ x: 400, y: 300 });
  });

  it("works at a zoom other than 1", () => {
    const camera = cameraCenteredOn({ x: -40, y: 90 }, VIEWPORT, 0.5);
    const screen = {
      x: (-40 + camera.x) * camera.z,
      y: (90 + camera.y) * camera.z,
    };
    expect(screen).toEqual({ x: 400, y: 300 });
  });
});

describe("panIntentFor", () => {
  // The other half of the same promise. `hasCursor` decides whether the dock
  // draws the pan button ENABLED; this decides what actually happens when it
  // is clicked, and the two must agree — the dock renders from a roster that
  // is a presence-poll behind, so a peer can switch page (or expire) between
  // the paint and the click. Both call the same rule, which is why it is one
  // function rather than a second copy of the comparison in the panel's .tsx,
  // where no test in this project could reach it.
  const intent = (
    entry: Presence | undefined,
    localPage?: string,
  ) => panIntentFor(entry, "alice", localPage);

  const onPage = (page: string | null | undefined): Presence => ({
    ...at(10, 20),
    ...(page === undefined ? {} : { page }),
  });

  it("flies to the cursor of a peer on the same page", () => {
    expect(intent(onPage("page:a"), "page:a")).toEqual({
      kind: "fly",
      point: { x: 10, y: 20 },
    });
  });

  it("refuses, naming the page, for a peer who is demonstrably elsewhere", () => {
    // Reachable even though the button is disabled for this case: the roster
    // the header rendered from is a poll behind. Refusing is the whole point —
    // flying there would land the camera on empty canvas, because D-4 has
    // hidden the cursor that used to be the destination's explanation.
    const refusal = intent(onPage("page:b"), "page:a");
    expect(refusal.kind).toBe("refuse");
    expect(refusal.kind === "refuse" && refusal.message).toContain("alice");
    expect(refusal.kind === "refuse" && refusal.message).toContain("page");
  });

  it("still flies to a peer who published no page", () => {
    // Back-compatibility, again in the direction that regresses: an older
    // bundle publishes nothing, its cursor is still DRAWN, so the jump still
    // lands on something visible. Refusing here would break a gesture that
    // works today for every peer that has not upgraded.
    expect(intent(onPage(undefined), "page:a").kind).toBe("fly");
    expect(intent(onPage(null), "page:a").kind).toBe("fly");
  });

  it("flies anywhere when the caller does not know its own page", () => {
    expect(intent(onPage("page:b"), undefined).kind).toBe("fly");
  });

  it("refuses when there is no cursor at all", () => {
    expect(intent(NO_CURSOR, "page:a")).toEqual({
      kind: "refuse",
      message: expect.stringContaining("alice"),
    });
    expect(intent(undefined, "page:a").kind).toBe("refuse");
  });

  it("gives the two refusals different words", () => {
    // They are different situations for the person clicking — "they have not
    // moved a pointer" versus "they are somewhere you are not looking" — and
    // one message for both would send somebody hunting for a cursor that is
    // deliberately hidden rather than missing.
    const noCursor = panIntentFor(NO_CURSOR, "alice", "page:a");
    const elsewhere = panIntentFor(onPage("page:b"), "alice", "page:a");
    expect(noCursor.kind === "refuse" && elsewhere.kind === "refuse").toBe(true);
    expect(noCursor).not.toEqual(elsewhere);
  });

  it.each([["page:a"], ["page:b"], [null], [undefined]] as const)(
    "agrees with buildRoster's hasCursor for a peer on page %s",
    (page) => {
      // THE PROPERTY THAT MATTERS, rather than two tables of expectations that
      // could quietly diverge: the button the dock paints ENABLED is exactly
      // the button whose click flies somewhere. Both are one call to this
      // function, and this pins that they stay one.
      const entry: Presence = { ...at(10, 20), ...(page === undefined ? {} : { page }) };
      const roster = buildRoster({ "client-a": "alice" }, { "client-a": entry }, "me", "zoe", "page:a");
      const hasCursor = roster.find((member) => member.name === "alice")!.hasCursor;
      expect(hasCursor).toBe(panIntentFor(entry, "alice", "page:a").kind === "fly");
    },
  );

  it("names a peer it has no name for without saying \"undefined\"", () => {
    const refusal = panIntentFor(NO_CURSOR, undefined, "page:a");
    expect(refusal.kind === "refuse" && refusal.message).not.toContain("undefined");
  });
});

describe("speakerRingsFor", () => {
  const camera = { x: 0, y: 0, z: 1 };
  const identities = { "client-a": "alice", "client-b": "bob", me: "zoe" };
  const presence = {
    "client-a": at(100, 120),
    "client-b": at(200, 220),
    me: at(300, 320),
  };

  it("rings only the peers LiveKit says are talking", () => {
    const rings = speakerRingsFor(
      presence,
      identities,
      ["alice"],
      camera,
      VIEWPORT,
      "me",
    );
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({
      clientId: "client-a",
      name: "alice",
      left: 100,
      top: 120,
      color: colorForName("alice"),
    });
  });

  it("never rings yourself", () => {
    // canvas-react's Cursors filters the local peer out, so a self ring would
    // be a marker floating over nothing. Local speaking feedback is the header
    // avatar's job.
    expect(
      speakerRingsFor(presence, identities, ["zoe"], camera, VIEWPORT, "me"),
    ).toEqual([]);
  });

  it("skips a talking peer whose cursor has left the viewport", () => {
    const offscreen = { "client-a": at(5000, 5000) };
    expect(
      speakerRingsFor(offscreen, identities, ["alice"], camera, VIEWPORT, "me"),
    ).toEqual([]);
  });

  it("skips a talking participant who is not on this canvas", () => {
    // Somebody can be in the LiveKit room without a canvas cursor — another
    // device, or a tab on a different page.
    expect(
      speakerRingsFor(presence, identities, ["carol"], camera, VIEWPORT, "me"),
    ).toEqual([]);
  });

  it("does no work at all when nobody is speaking", () => {
    expect(speakerRingsFor(presence, identities, [], camera, VIEWPORT, "me")).toEqual(
      [],
    );
  });
});

describe("onCanvasCount", () => {
  // THE SIDEBAR'S NUMBER HAS TWO SOURCES AND THEY MUST MEASURE THE SAME SET.
  // `CanvasOnlineCount` seeds itself from `canvas_roster` and then follows the
  // room's identity broadcast. Widening the roster to carry every bb tab's
  // location made the seed count every TAB IN THE BUILDING while the broadcast
  // still counted canvas clients, so the badge (whose accessible label asserts
  // "N on the canvas") read 7 when 3 people were on the canvas, and snapped
  // between the two numbers on every join/leave/idle-sweep publish. The
  // reply's `inRoom` flag is the server saying "this clientId is in
  // room.identities" — counting on it is what makes the two sources agree.
  /** One `canvas_roster` row as the count sees it — the count reads one field,
   * so `CountableMember` is one field wide and the clientId/name a real reply
   * carries are deliberately not part of it. */
  const row = (inRoom: boolean): CountableMember => ({ inRoom });

  it("counts only the members the sync room knows", () => {
    // alice and carol have canvas panels open; bob is a bb tab on a thread.
    expect(onCanvasCount([row(true), row(false), row(true)])).toBe(2);
  });

  it("is zero when every member is a bb tab that never opened the canvas", () => {
    expect(onCanvasCount([row(false), row(false)])).toBe(0);
  });

  it("agrees with the identity broadcast the badge also listens to", () => {
    // The two sources, side by side: whatever `room.identities` contains is
    // exactly what the seed must count, because the next realtime publish will
    // overwrite the seed with `Object.keys(identities).length`.
    const identities = { a: "alice", c: "carol" };
    const members = [row(true), row(false), row(true)];
    expect(onCanvasCount(members)).toBe(Object.keys(identities).length);
  });

  it("refuses to count a member whose flag is missing or junk", () => {
    // Reads a value this process did not construct; anything that is not
    // literally `true` is not a canvas client. Erring low keeps the badge
    // honest (and at zero it renders nothing at all).
    const wire = [{}, { inRoom: "yes" }, { inRoom: null }] as unknown as
      CountableMember[];
    expect(onCanvasCount(wire)).toBe(0);
  });

  it("counts nothing in an empty roster", () => {
    expect(onCanvasCount([])).toBe(0);
  });
});
