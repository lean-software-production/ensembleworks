// Run: npx vitest run tests/dock.test.ts
//
// The presence strip's PURE half. The strip itself is imperative DOM in a
// content script (canvas/dock/dock.ts) — untestable here without a browser and
// covered by the manual smoke checklist in README.md — but every decision it
// makes is a function in canvas/dock/model.ts, and those are what this file
// pins down: who gets a bubble, in what order, who is ringed as speaking, and
// which of that person's tabs a click should fly the canvas camera to.
import { describe, expect, it } from "vitest";
import {
  MAX_DOCK_BUBBLES,
  SPEAKING_HOLD_MS,
  buildDockModel,
  describeRoom,
  overflowLabel,
  mergeRoster,
  holdSpeaking,
  resolveSelfName,
  speakingAt,
  locateEveryone,
  parseRoster,
} from "../canvas/dock/model.js";
import { createContentScriptRpc } from "../canvas/dock/rpc.js";
import { initialsFor } from "../canvas/roster.js";

const member = (clientId: string, name: string) => ({ clientId, name });

const EMPTY = {
  roster: [],
  speaking: [],
  video: [],
  selfName: null,
} as const;

describe("buildDockModel", () => {
  it("gives every room member one bubble, alphabetical, with you last", () => {
    // Position is how a person learns these circles, so the order is stable
    // and boring: alphabetical, and you are always the one on the end.
    const { bubbles, overflow } = buildDockModel({
      ...EMPTY,
      roster: [member("c3", "cara"), member("c1", "alice"), member("c2", "bob")],
      selfName: "bob",
    });

    expect(bubbles.map((bubble) => bubble.name)).toEqual(["alice", "cara", "bob"]);
    expect(bubbles.map((bubble) => bubble.isSelf)).toEqual([false, false, true]);
    expect(overflow).toBe(0);
  });

  it("labels you as yourself and everyone else by name", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [member("c1", "alice"), member("c2", "bob")],
      selfName: "bob",
    });
    expect(bubbles.find((bubble) => bubble.isSelf)?.label).toBe("bob (you)");
    expect(bubbles.find((bubble) => !bubble.isSelf)?.label).toBe("alice");
  });

  it("draws initials and a stable per-name colour", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [member("c1", "ada.lovelace"), member("c2", "local:mrdavidlaing")],
    });
    expect(bubbles.map((bubble) => bubble.initials)).toEqual([
      initialsFor("ada.lovelace"),
      initialsFor("local:mrdavidlaing"),
    ]);
    // Same colour the canvas cursor label uses, so the dock and the canvas
    // agree about who is who.
    expect(bubbles[0]!.color).toMatch(/^#|^hsl|^rgb/);
    const again = buildDockModel({ ...EMPTY, roster: [member("cX", "ada.lovelace")] });
    expect(again.bubbles[0]!.color).toBe(bubbles[0]!.color);
  });

  it("collapses one person's several tabs into one bubble", () => {
    // Membership is per client, but video is per PERSON: two tabs are one
    // LiveKit participant and must not get two faces.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [member("tab-1", "alice"), member("tab-2", "alice")],
    });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.name).toBe("alice");
  });

  it("rings whoever LiveKit says is talking, matched by name", () => {
    // av.ts mints the LiveKit identity FROM the display name, so "is this
    // person talking" is a name lookup, not a second id space.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [member("c1", "alice"), member("c2", "bob")],
      speaking: ["bob"],
    });
    expect(bubbles.map((bubble) => bubble.isSpeaking)).toEqual([false, true]);
  });

  it("marks the people publishing camera so their bubble becomes a tile", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [member("c1", "alice"), member("c2", "bob")],
      video: ["alice"],
    });
    expect(bubbles.map((bubble) => bubble.hasVideo)).toEqual([true, false]);
  });

  it("shows you even when the roster has not reached you yet", () => {
    // You have joined audio but the canvas room's identity broadcast has not
    // round-tripped; a dock with no you in it reads as broken.
    const { bubbles } = buildDockModel({ ...EMPTY, selfName: "bob" });
    expect(bubbles.map((bubble) => bubble.name)).toEqual(["bob"]);
    expect(bubbles[0]!.isSelf).toBe(true);
  });

  it("is empty when nobody is in the room and nobody is signed in", () => {
    expect(buildDockModel(EMPTY)).toEqual({ bubbles: [], overflow: 0 });
  });

  it("carries a pan target, preferring the tab that actually has a cursor", () => {
    // The one behaviour the canvas page's own header had and the dock did not:
    // clicking a face flies the camera to that person. Bubbles are keyed by
    // NAME (one person, however many tabs), but canvasBus.panTo wants a
    // clientId — and only a tab with a cursor on the canvas is a destination.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [
        { clientId: "tab-idle", name: "alice", hasCursor: false },
        { clientId: "tab-live", name: "alice", hasCursor: true },
      ],
    });
    expect(bubbles[0]!.clientId).toBe("tab-live");
    expect(bubbles[0]!.canPan).toBe(true);
  });

  it("refuses to pan to somebody who has no cursor on the canvas", () => {
    // Connected but has not moved a pointer: there is nowhere honest to jump
    // to, and inventing a destination teaches the gesture to lie.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [{ clientId: "c1", name: "alice", hasCursor: false }],
    });
    expect(bubbles[0]!.clientId).toBe("c1");
    expect(bubbles[0]!.canPan).toBe(false);
  });

  it("has no pan target at all off the canvas page", () => {
    // The polled roster (canvas/dock/rpc.ts) knows names and clientIds but
    // nothing about cursors, and on most bb pages there is no canvas panel
    // listening for a pan anyway.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [member("c1", "alice")],
      selfName: "bob",
    });
    expect(bubbles[0]!.canPan).toBe(false);
    // ...and you, before the roster has reached you, are not even a client.
    expect(bubbles[1]!.clientId).toBe(null);
  });

  it("caps the pill's width and counts the rest, never dropping you", () => {
    const crowd = Array.from({ length: MAX_DOCK_BUBBLES + 3 }, (_, index) =>
      member(`c${index}`, `person${index}`),
    );
    const { bubbles, overflow } = buildDockModel({
      ...EMPTY,
      roster: [...crowd, member("me", "zoe")],
      selfName: "zoe",
    });

    expect(bubbles).toHaveLength(MAX_DOCK_BUBBLES);
    expect(bubbles.at(-1)!.isSelf).toBe(true);
    expect(overflow).toBe(crowd.length + 1 - MAX_DOCK_BUBBLES);
  });
});

// ---------------------------------------------------------------------------
// How many faces fit
//
// MAX_DOCK_BUBBLES was the whole answer while the strip's width was fixed. It
// stops being the whole answer once the header is allowed to squeeze the strip:
// how many faces fit RIGHT NOW is a measurement, so it becomes an input — and
// MAX_DOCK_BUBBLES stays behind it as the ceiling a measurement may not lift.
// ---------------------------------------------------------------------------

describe("buildDockModel — the bubble limit", () => {
  /** Nine strangers and you: more people than any limit in this block. */
  const crowded = {
    ...EMPTY,
    roster: [
      ...Array.from({ length: MAX_DOCK_BUBBLES + 3 }, (_, index) =>
        member(`c${index}`, `person${index}`),
      ),
      member("me", "zoe"),
    ],
    selfName: "zoe",
  };
  const everyone = MAX_DOCK_BUBBLES + 4;

  it("draws only as many faces as the strip says it has room for", () => {
    const { bubbles, overflow } = buildDockModel({ ...crowded, limit: 3 });
    expect(bubbles).toHaveLength(3);
    expect(overflow).toBe(everyone - 3);
  });

  it("squeezes a room that was never over the hard cap in the first place", () => {
    // The case the cap alone can never catch, and the one the whole feature is
    // for: five people is comfortably under MAX_DOCK_BUBBLES, so the old
    // "everybody fits" shortcut fires and the limit is never consulted. In a
    // narrow header those five faces are exactly what pushes the page title out
    // of the row.
    const room = ["alice", "bob", "cara", "dan"].map((name, index) =>
      member(`c${index}`, name),
    );
    const { bubbles, overflow } = buildDockModel({
      ...EMPTY,
      roster: [...room, member("me", "zoe")],
      selfName: "zoe",
      limit: 3,
    });
    expect(bubbles.map((bubble) => bubble.name)).toEqual(["alice", "bob", "zoe"]);
    expect(overflow).toBe(2);
  });

  it("spends the last place on YOU when there is room for exactly one face", () => {
    // Same rule as the cap, at its sharpest: the mic and camera controls are
    // read off your own face, so the one face a squeezed strip can afford is
    // the one that makes them attributable.
    const { bubbles, overflow } = buildDockModel({ ...crowded, limit: 1 });
    expect(bubbles.map((bubble) => bubble.name)).toEqual(["zoe"]);
    expect(bubbles[0]!.isSelf).toBe(true);
    expect(overflow).toBe(everyone - 1);
  });

  it("will not let a measurement ask for MORE faces than the cap", () => {
    // The clamp is one-directional on purpose. The cap is about how many
    // 24px circles a title bar stays legible with, which no amount of
    // available width changes; a wide header is not permission to draw ten.
    const { bubbles, overflow } = buildDockModel({
      ...crowded,
      limit: MAX_DOCK_BUBBLES + 4,
    });
    expect(bubbles).toHaveLength(MAX_DOCK_BUBBLES);
    expect(overflow).toBe(everyone - MAX_DOCK_BUBBLES);
  });

  it("draws NO faces when the caller asks for none, and counts everybody", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE — "still draws one face when the
    // measurement says there is room for none" — and the floor it pinned was
    // right for every caller that existed when it was written. It is wrong now
    // that canvas/dock/squeeze.ts has a `bare` tier whose whole point is a
    // strip with no faces on it (`maxBubblesFor("bare") === 0`), which the
    // floor of one turned into a strip with exactly one: the most expensive
    // face to draw and the least honest thing to say, since one circle out of a
    // room of ten reads as "one person is here".
    //
    // The old test's fear — a broken measurement emptying a strip that has
    // people in it — is answered, but NOT here any more. A width that is not a
    // measurement never reaches this function as a 0: `chooseSqueeze` answers
    // an unreadable width with `cramped` and `nextSqueeze` holds the tier
    // already drawn, so `bare` is only ever reached by a width that WAS read.
    // The undefined/non-finite cases below are what still guards this end.
    //
    // Negative goes the same way. "Room for less than none" is not a request
    // for a face; it is the same request with a worse number in it.
    for (const limit of [0, -3]) {
      const { bubbles, overflow } = buildDockModel({ ...crowded, limit });
      expect(bubbles).toEqual([]);
      // Including you — at this tier nobody is drawn, so the count that stands
      // in for the faces has to count everybody or it is short by one.
      expect(overflow).toBe(everyone);
    }
  });

  it("counts everybody at a zero limit when nobody is signed in either", () => {
    // The self-less path is a different branch of the same function, and the
    // two fail differently once the clamp stops flooring at one: with a self to
    // append the limit becomes `slice(0, -1)`, which drops ONE person and keeps
    // the rest, while this branch slices `(0, 0)` and is right by luck. Both
    // are pinned, because "right by luck" is what stops being true next time
    // somebody edits the slicing.
    const { bubbles, overflow } = buildDockModel({
      ...crowded,
      selfName: null,
      limit: 0,
    });
    expect(bubbles).toEqual([]);
    // Everybody, with no discount for the self that is not there: `crowded`'s
    // "zoe" is just another stranger once nobody is signed in.
    expect(overflow).toBe(everyone);
  });

  it("says nobody rather than counting nobody when a zero limit meets an empty room", () => {
    // A limit of zero and a room of zero are different facts and must not add
    // up to a "+0": the strip hides the count when the overflow is 0, and this
    // is the case that has to reach it.
    const { bubbles, overflow } = buildDockModel({ ...EMPTY, limit: 0 });
    expect(bubbles).toEqual([]);
    expect(overflow).toBe(0);
  });

  it("degrades to today's cap when the measurement is not a number", () => {
    // A broken measurement — an element with no layout yet, a division by a
    // zero width — must land on the behaviour the strip had before it was
    // measured at all, never on an empty strip.
    for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { bubbles, overflow } = buildDockModel({ ...crowded, limit });
      expect(bubbles).toHaveLength(MAX_DOCK_BUBBLES);
      expect(overflow).toBe(everyone - MAX_DOCK_BUBBLES);
    }
  });

  it("floors a fractional limit rather than drawing a face that does not fit", () => {
    // `limit` is typed `number`, so a caller that ever computes one (rather
    // than picking a tier, which is all canvas/dock/squeeze.ts does today) has
    // to land somewhere defined. Down: room for 3.7 faces is room for three,
    // and rounding up draws the face that did not fit.
    const { bubbles, overflow } = buildDockModel({ ...crowded, limit: 3.7 });
    expect(bubbles).toHaveLength(3);
    expect(overflow).toBe(everyone - 3);
  });

  it("is exactly the old behaviour when no measurement is offered", () => {
    // Every caller that does not measure, and every test above that does not
    // care, must be untouched by this field existing.
    expect(buildDockModel(crowded)).toEqual(
      buildDockModel({ ...crowded, limit: MAX_DOCK_BUBBLES }),
    );
    const { bubbles, overflow } = buildDockModel(crowded);
    expect(bubbles).toHaveLength(MAX_DOCK_BUBBLES);
    expect(bubbles.at(-1)!.isSelf).toBe(true);
    expect(overflow).toBe(everyone - MAX_DOCK_BUBBLES);
  });

  it("counts the limit against the faces drawn, self or no self", () => {
    // Nobody signed in yet: the strip is all strangers, and the limit still
    // means the same thing.
    const { bubbles, overflow } = buildDockModel({
      ...crowded,
      selfName: null,
      limit: 2,
    });
    expect(bubbles.map((bubble) => bubble.name)).toEqual(["person0", "person1"]);
    expect(overflow).toBe(everyone - 2);
  });
});

describe("describeRoom", () => {
  // WHAT THE STRIP SAYS IT IS SHOWING, which stopped matching what it shows
  // the moment a tier could draw no faces. This lived in canvas/dock/dock.ts as
  // a private `describe()` plus a ternary on `bubbles.length === 0`, i.e. in
  // the one file no test in this project can reach; at `bare` that ternary
  // announced "nobody here yet" to a room with five people in it, because the
  // strip's model has no bubbles there. It is a decision, so it is here now.
  const face = (name: string) => ({ clientId: name, name });

  it("names the faces it is actually drawing", () => {
    const model = buildDockModel({
      ...EMPTY,
      roster: [face("alice"), face("bob")],
      selfName: "bob",
    });
    expect(describeRoom(model)).toBe("alice, bob (you)");
  });

  it("adds the ones it could not fit", () => {
    const model = buildDockModel({
      ...EMPTY,
      roster: ["alice", "bob", "cara", "dan"].map(face),
      selfName: "dan",
      limit: 2,
    });
    expect(describeRoom(model)).toBe("alice, dan (you) and 2 more");
  });

  it("counts the room when it is drawing no faces at all", () => {
    // The `bare` tier. "and 3 more" than WHAT — there is nothing on screen for
    // them to be more than, and naming nobody while claiming a remainder is the
    // half-sentence a screen reader would read out.
    const model = buildDockModel({
      ...EMPTY,
      roster: ["alice", "bob", "cara"].map(face),
      selfName: "cara",
      limit: 0,
    });
    expect(describeRoom(model)).toBe("3 people");
  });

  it("counts one person as a person", () => {
    const model = buildDockModel({ ...EMPTY, roster: [face("alice")], limit: 0 });
    expect(describeRoom(model)).toBe("1 person");
  });

  it("says nobody is here when nobody is here", () => {
    // Not "0 people". This is the answer on every page of a quiet bb, so it is
    // the sentence most people will ever read off this control.
    expect(describeRoom(buildDockModel(EMPTY))).toBe("nobody here yet");
  });
});

describe("overflowLabel", () => {
  // The little "+3" beside the faces — and what it says when there are no
  // faces beside it. Same defect as `describeRoom`, one element over: "+" means
  // "as well as these", so at `bare` it is a plus sign with nothing on its left.
  const face = (name: string) => ({ clientId: name, name });
  const room = (limit: number) =>
    buildDockModel({
      ...EMPTY,
      roster: ["alice", "bob", "cara"].map(face),
      selfName: "cara",
      limit,
    });

  it("is a plus and a number while faces are on screen", () => {
    // Three in the room, two faces on screen, one left over.
    expect(overflowLabel(room(2))).toBe("+1");
  });

  it("is a plain count when the strip is drawing no faces", () => {
    expect(overflowLabel(room(0))).toBe("3");
  });

  it("is empty when there is nothing left over", () => {
    // What the strip keys its `hidden` off, so it has to be the empty string
    // and not a "0" or a "+0".
    expect(overflowLabel(room(MAX_DOCK_BUBBLES))).toBe("");
    expect(overflowLabel(buildDockModel({ ...EMPTY, limit: 0 }))).toBe("");
  });
});

describe("holdSpeaking", () => {
  it("keeps a ring lit through the gaps in LiveKit's speaker events", () => {
    // ActiveSpeakersChanged flaps between syllables. Without a hold the ring
    // strobes, which reads as a rendering bug rather than as speech.
    let hold = holdSpeaking({}, ["alice"], 1_000);
    expect(speakingAt(hold, 1_000)).toEqual(["alice"]);

    hold = holdSpeaking(hold, [], 1_100);
    expect(speakingAt(hold, 1_100)).toEqual(["alice"]);

    expect(speakingAt(hold, 1_000 + SPEAKING_HOLD_MS - 1)).toEqual(["alice"]);
    expect(speakingAt(hold, 1_000 + SPEAKING_HOLD_MS + 1)).toEqual([]);
  });

  it("refreshes the hold every time the speaker is seen again", () => {
    let hold = holdSpeaking({}, ["alice"], 1_000);
    hold = holdSpeaking(hold, ["alice"], 1_500);
    expect(speakingAt(hold, 1_500 + SPEAKING_HOLD_MS - 1)).toEqual(["alice"]);
  });

  it("forgets speakers whose hold has long expired instead of growing forever", () => {
    // This map is fed by an event that fires several times a second for the
    // whole session; it must not accumulate one key per person who ever spoke.
    let hold = holdSpeaking({}, ["alice", "bob"], 1_000);
    hold = holdSpeaking(hold, ["cara"], 1_000 + SPEAKING_HOLD_MS * 4);
    expect(Object.keys(hold)).toEqual(["cara"]);
  });

  it("returns the same object when nothing changed, so the dock can skip a repaint", () => {
    const hold = holdSpeaking({}, ["alice"], 1_000);
    expect(holdSpeaking(hold, ["alice"], 1_000)).toBe(hold);
  });

  it("sorts its answer so equal states compare equal", () => {
    const hold = holdSpeaking({}, ["cara", "alice", "bob"], 1_000);
    expect(speakingAt(hold, 1_000)).toEqual(["alice", "bob", "cara"]);
  });
});

describe("mergeRoster", () => {
  // THIS RULE INVERTED when locations arrived, and the old one is worth
  // recording because it was right at the time. It used to be "the bus roster
  // wins outright, because the canvas panel refreshes it on every presence tick
  // and the poll is only for pages that are not the canvas". That worked while
  // the poll knew strictly LESS than the bus.
  //
  // It no longer does. The poll now returns everybody in the building — every
  // bb tab that reported a location, not just the sync-room clients a canvas
  // panel can see — so preferring the bus meant that opening the canvas page
  // made everyone off it vanish from your strip, took their whereabouts with
  // them, and silently cleared every thread-row glyph. Observed live, on the
  // canvas route, before this was fixed.
  //
  // So the POLL is the membership truth, and the bus contributes the one thing
  // only it knows: which clients have a cursor on the canvas.

  it("keeps everyone the poll knows about, canvas panel or not", () => {
    const bus = [{ clientId: "c1", name: "alice", hasCursor: true }];
    const polled = [
      { clientId: "c1", name: "alice", path: "/plugins/canvas/canvas", seenMs: 2 },
      { clientId: "c2", name: "bob", path: "/settings", seenMs: 1 },
    ];
    expect(mergeRoster(bus, polled).map((entry) => entry.name)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("keeps the location the poll carries", () => {
    const bus = [{ clientId: "c1", name: "alice", hasCursor: true }];
    const polled = [
      { clientId: "c1", name: "alice", path: "/plugins/canvas/canvas", seenMs: 2 },
    ];
    expect(mergeRoster(bus, polled)[0]?.path).toBe("/plugins/canvas/canvas");
  });

  it("overlays hasCursor, which only the bus knows", () => {
    const bus = [{ clientId: "c1", name: "alice", hasCursor: true }];
    const polled = [{ clientId: "c1", name: "alice", path: "/x", seenMs: 1 }];
    expect(mergeRoster(bus, polled)[0]?.hasCursor).toBe(true);
  });

  it("does not invent a cursor for somebody the bus has never seen", () => {
    const polled = [{ clientId: "c2", name: "bob", path: "/x", seenMs: 1 }];
    expect(mergeRoster([], polled)[0]?.hasCursor).toBe(false);
  });

  it("keeps a bus member the poll has not caught up with yet", () => {
    // You, in the first moments after mounting the canvas panel: the panel puts
    // you in the bus roster immediately, and your first poll has not returned.
    // A strip with no you in it reads as broken.
    const bus = [{ clientId: "c1", name: "alice", hasCursor: false }];
    expect(mergeRoster(bus, []).map((entry) => entry.name)).toEqual(["alice"]);
  });

  it("is just the poll when no canvas panel is mounted", () => {
    const polled = [{ clientId: "c2", name: "bob", path: "/x", seenMs: 1 }];
    expect(mergeRoster([], polled)).toEqual([
      {
        clientId: "c2",
        name: "bob",
        path: "/x",
        title: null,
        seenMs: 1,
        focused: false,
        hasCursor: false,
      },
    ]);
  });

  it("does not resurrect a member the poll has seen leave", () => {
    // The original rule's real concern, still honoured: the poll is the
    // membership truth, so a bus entry for somebody it no longer lists is only
    // kept when the bus is the ONLY source (the case above), never merged back
    // in alongside a poll that has moved on.
    const bus = [
      { clientId: "c1", name: "alice", hasCursor: true },
      { clientId: "gone", name: "departed", hasCursor: true },
    ];
    const polled = [{ clientId: "c1", name: "alice", path: "/x", seenMs: 1 }];
    expect(mergeRoster(bus, polled).map((entry) => entry.name)).toEqual(["alice"]);
  });
});

describe("resolveSelfName", () => {
  it("uses the canvas panel's own identity when it has one", () => {
    expect(
      resolveSelfName([{ clientId: "c1", name: "alice", isSelf: true }], "someone-else"),
    ).toBe("alice");
  });

  it("falls back to the LiveKit identity on pages with no canvas panel", () => {
    expect(resolveSelfName([], "bob")).toBe("bob");
  });

  it("admits it does not know who you are before either arrives", () => {
    expect(resolveSelfName([], null)).toBe(null);
  });
});

describe("createContentScriptRpc", () => {
  /** A fetch stand-in that records what it was asked for. */
  function recordingFetch(response: unknown, ok = true) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => response,
      } as Response;
    };
    return { calls, impl: impl as unknown as typeof fetch };
  }

  it("posts to the plugin's documented rpc path and unwraps the result", async () => {
    const { calls, impl } = recordingFetch({ ok: true, result: { members: [] } });
    const rpc = createContentScriptRpc("canvas", impl);

    await expect(rpc.call("canvas_roster", null)).resolves.toEqual({ members: [] });
    expect(calls[0]!.url).toBe("/api/v1/plugins/canvas/rpc/canvas_roster");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("null");
  });

  it("sends the input as the whole body, the way the host client does", async () => {
    const { calls, impl } = recordingFetch({ ok: true, result: { ok: false } });
    await createContentScriptRpc("canvas", impl).call("canvas_av_token", {
      clientId: "c1",
    });
    expect(calls[0]!.init.body).toBe('{"clientId":"c1"}');
  });

  it("escapes a plugin id and a method name into the path", async () => {
    const { calls, impl } = recordingFetch({ ok: true, result: null });
    await createContentScriptRpc("my plugin", impl).call("a/b", null);
    expect(calls[0]!.url).toBe("/api/v1/plugins/my%20plugin/rpc/a%2Fb");
  });

  it("rejects with the server's message when the handler reports an error", async () => {
    const { impl } = recordingFetch(
      { ok: false, error: { message: "livekit exploded", code: "handler_error" } },
      false,
    );
    await expect(
      createContentScriptRpc("canvas", impl).call("canvas_av_token", {}),
    ).rejects.toThrow("livekit exploded");
  });

  it("still rejects when the body is not JSON at all", async () => {
    const impl = (async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;
    await expect(
      createContentScriptRpc("canvas", impl).call("canvas_roster", null),
    ).rejects.toThrow(/canvas_roster/);
  });
});

// ---------------------------------------------------------------------------
// Where everyone is
//
// Added with the presence-location feature. Two decisions moved into (or grew
// inside) model.ts rather than staying inline in dock.ts: parsing the widened
// `canvas_roster` reply — a value the strip did not construct — and choosing
// WHICH of a person's tabs is the one worth pointing at, now that a person can
// be in three places at once.
// ---------------------------------------------------------------------------

describe("parseRoster", () => {
  it("reads the widened member shape", () => {
    expect(
      parseRoster({
        members: [
          {
            clientId: "c1",
            name: "alice",
            path: "/projects/p/threads/t",
            title: "Standup",
            seenMs: 1_700,
          },
        ],
      }),
    ).toEqual([
      {
        clientId: "c1",
        name: "alice",
        path: "/projects/p/threads/t",
        title: "Standup",
        seenMs: 1_700,
        focused: false,
      },
    ]);
  });

  it("still reads a member with no location at all", () => {
    // Present, location unknown. The server says this with nulls; a bb build
    // that predates the widening says it by omission, and both must land in
    // the same place rather than costing the whole poll.
    expect(parseRoster({ members: [{ clientId: "c1", name: "alice" }] })).toEqual([
      { clientId: "c1", name: "alice", path: null, title: null, seenMs: null, focused: false },
    ]);
  });

  it("drops a member whose location fields are the wrong type", () => {
    // The member survives — a face with no jump link is still a face — but the
    // junk never reaches an href.
    expect(
      parseRoster({
        members: [{ clientId: "c1", name: "alice", path: 7, title: {}, seenMs: "x" }],
      }),
    ).toEqual([
      { clientId: "c1", name: "alice", path: null, title: null, seenMs: null, focused: false },
    ]);
  });

  it("skips a member with no clientId or no name, and keeps the rest", () => {
    expect(
      parseRoster({
        members: [{ clientId: "c1" }, { name: "bob" }, null, { clientId: "c2", name: "cara" }],
      }),
    ).toEqual([
      { clientId: "c2", name: "cara", path: null, title: null, seenMs: null, focused: false },
    ]);
  });

  it("answers with an empty roster for anything that is not a reply", () => {
    expect(parseRoster(null)).toEqual([]);
    expect(parseRoster({})).toEqual([]);
    expect(parseRoster({ members: "lots" })).toEqual([]);
    expect(parseRoster("nope")).toEqual([]);
  });
});

describe("buildDockModel — where each person is", () => {
  const at = (
    clientId: string,
    name: string,
    path: string | null,
    seenMs: number | null,
  ) => ({ clientId, name, path, title: null, seenMs });

  it("carries one person's location onto their bubble", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [at("c1", "alice", "/settings", 10)],
    });
    expect(bubbles[0]?.path).toBe("/settings");
  });

  it("shows a person with two tabs the one they are actually using", () => {
    // One person is ONE bubble (that is the model's whole keying rule), so a
    // person with bb open twice needs a single answer, and the honest one is
    // the tab that reported most recently.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [
        at("c1", "alice", "/settings", 10),
        at("c2", "alice", "/projects/p/threads/t", 99),
      ],
    });
    expect(bubbles[0]?.path).toBe("/projects/p/threads/t");
  });

  it("prefers a located tab over one whose location went stale", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [at("c1", "alice", null, null), at("c2", "alice", "/settings", 5)],
    });
    expect(bubbles[0]?.path).toBe("/settings");
  });

  it("says nothing rather than guessing when no tab of theirs is located", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [at("c1", "alice", null, null)],
    });
    expect(bubbles[0]?.path).toBeNull();
    expect(bubbles[0]?.title).toBeNull();
  });

  it("carries the thread title that travelled with the location", () => {
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [
        {
          clientId: "c1",
          name: "alice",
          path: "/projects/p/threads/t",
          title: "Standup",
          seenMs: 3,
        },
      ],
    });
    expect(bubbles[0]?.title).toBe("Standup");
  });

  it("keeps the pan target and the location independent", () => {
    // They answer different questions — "which tab has a cursor on the canvas"
    // and "which tab is most recently where somebody is" — and a person can
    // easily be two tabs where the answers differ.
    const { bubbles } = buildDockModel({
      ...EMPTY,
      roster: [
        { clientId: "c1", name: "alice", hasCursor: true, path: null, seenMs: null },
        { clientId: "c2", name: "alice", path: "/settings", seenMs: 50 },
      ],
    });
    expect(bubbles[0]?.clientId).toBe("c1");
    expect(bubbles[0]?.canPan).toBe(true);
    expect(bubbles[0]?.path).toBe("/settings");
  });
});

describe("resolveSelfName — off the canvas page", () => {
  it("falls back to the identity this tab fetched for itself", () => {
    // The strip runs on every bb route, and on most of them there is no canvas
    // panel and no LiveKit session — so before this fallback the strip could
    // not tell which bubble was you, and drew your own face as a stranger's.
    expect(resolveSelfName([], null, "local:mrdavidlaing")).toBe(
      "local:mrdavidlaing",
    );
  });

  it("still prefers the panel's answer, then LiveKit's, then its own", () => {
    const bus = [{ name: "from-panel", isSelf: true }];
    expect(resolveSelfName(bus, "from-livekit", "from-identity")).toBe("from-panel");
    expect(resolveSelfName([], "from-livekit", "from-identity")).toBe("from-livekit");
    expect(resolveSelfName([], null, null)).toBeNull();
  });
});

describe("locateEveryone", () => {
  const at = (
    clientId: string,
    name: string,
    path: string | null,
    seenMs: number | null,
  ) => ({ clientId, name, path, title: null, seenMs });

  it("answers once per PERSON, not once per tab", () => {
    expect(
      locateEveryone([
        at("c1", "alice", "/settings", 1),
        at("c2", "alice", "/settings", 2),
      ]),
      // One answer, and it names the tab it came from — the memory that keeps
      // that answer from flip-flopping next poll (tests/dock-whereabouts).
    ).toEqual([{ name: "alice", path: "/settings", title: null, clientId: "c2" }]);
  });

  it("is not capped the way the strip's faces are", () => {
    // The strip draws MAX_DOCK_BUBBLES faces and folds the rest into "+N", but
    // the thread-row glyphs are drawn by the HOST on rows that have nothing to
    // do with that cap. A seventh person reading a thread must still light it
    // up.
    const roster = Array.from({ length: MAX_DOCK_BUBBLES + 3 }, (_, index) =>
      at(`c${index}`, `person${index}`, `/projects/p/threads/t${index}`, index),
    );
    expect(locateEveryone(roster)).toHaveLength(MAX_DOCK_BUBBLES + 3);
  });

  it("falls back to the most recent tab, and the bubbles agree", () => {
    // The LAST tiebreak, not the first: focus outranks it and the previously
    // chosen tab defends against drift (tests/dock-whereabouts.test.ts). With
    // neither in play, ninety seconds newer is a real difference.
    const roster = [
      at("c1", "alice", "/settings", 10),
      at("c2", "alice", "/projects/p/threads/t", 99),
    ];
    expect(locateEveryone(roster)[0]?.path).toBe("/projects/p/threads/t");
    expect(buildDockModel({ ...EMPTY, roster }).bubbles[0]?.path).toBe(
      "/projects/p/threads/t",
    );
  });

  it("still lists a person nobody has located", () => {
    expect(locateEveryone([at("c1", "alice", null, null)])).toEqual([
      { name: "alice", path: null, title: null, clientId: "c1" },
    ]);
  });

  it("is sorted by name, so a diff of it is stable", () => {
    expect(
      locateEveryone([
        at("c1", "cara", null, null),
        at("c2", "alice", null, null),
        at("c3", "bob", null, null),
      ]).map((entry) => entry.name),
    ).toEqual(["alice", "bob", "cara"]);
  });
});

describe("the focus flag on the wire", () => {
  // Where it comes from and where it goes: `document.hasFocus()` in the
  // reporting tab -> canvas_roster -> here -> `locateEveryone`'s ranking. The
  // strip has to survive a bb on the other end that knows nothing about it,
  // which is what "absent reads as not focused" means below.
  it("is read off a member", () => {
    expect(
      parseRoster({
        members: [
          { clientId: "c1", name: "alice", path: "/x", title: null, seenMs: 1, focused: true },
        ],
      })[0]?.focused,
    ).toBe(true);
  });

  it("reads absent, null and junk as NOT focused", () => {
    // Never as focused: an older bb answering without the field must not
    // out-rank a live tab that honestly said true.
    expect(parseRoster({ members: [{ clientId: "c1", name: "alice" }] })[0]?.focused).toBe(
      false,
    );
    expect(
      parseRoster({ members: [{ clientId: "c1", name: "alice", focused: null }] })[0]
        ?.focused,
    ).toBe(false);
    expect(
      parseRoster({ members: [{ clientId: "c1", name: "alice", focused: "yes" }] })[0]
        ?.focused,
    ).toBe(false);
  });

  it("survives the merge with the bus roster", () => {
    // The bus knows cursors, the poll knows focus; the join must not drop it.
    const polled = [
      { clientId: "c1", name: "alice", path: "/x", seenMs: 1, focused: true },
    ];
    expect(mergeRoster([], polled)[0]?.focused).toBe(true);
  });
});
