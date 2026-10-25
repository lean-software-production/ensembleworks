// Run: npx vitest run tests/dock-thread-status.test.ts
//
// The thread-row presence DECORATION — every decision, none of the DOM.
//
// This module used to drive `experimental_setThreadRowStatus`. It no longer
// does, and the reason is a defect the product owner reported: the host paints
// that status into the row's DRAFT-GLYPH SLOT, bb reclaims the same slot for
// the row's hover actions, so hovering the row REPLACED the eye — and the label
// naming who it was could only ever be read by hovering. The payload could not
// carry a colour either (`{icon, label, tone}`, icon being a name from bb's own
// registry), so "the same coloured circle as the header AV dock" was not
// expressible through it at all.
//
// So the plugin decorates the row itself, with the strip's own bubbles, in the
// row's TITLE span. Which rows should carry what, and — given what is on them
// already — what to add, update and remove, are the decisions here. dock.ts
// gets hands only, and there is no jsdom in this project: anything decided
// inline against `document` is decided where no test can reach it.
import { describe, expect, it } from "vitest";
import { parseLocation } from "../canvas/dock/where.js";
import { colorForName } from "../canvas/identity.js";
import { initialsFor } from "../canvas/roster.js";
import { buildDockModel } from "../canvas/dock/model.js";
import {
  MAX_ROW_FACES,
  SELF_LABEL,
  isOwnMutation,
  planRowDecorations,
  rowDecorationState,
  shouldScheduleSync,
  threadRowPresence,
  type RowPresence,
  type RowSlot,
} from "../canvas/dock/thread-status.js";

const T1 = "/projects/p1/threads/t1";
const T2 = "/projects/p1/threads/t2";
const CANVAS = "/plugins/canvas/canvas";

/** These cases are about grouping, not about self: the strip has not resolved a
 * self name, so nobody is `you` and every viewer is named. */
const NOBODY_IS_ME = null;

const viewer = (name: string, path: string | null) => ({
  name,
  location: path === null ? null : parseLocation(path),
});

const row = (
  threadId: string,
  signature: string | null = null,
  leading = true,
): RowSlot => ({ threadId, signature, leading });

describe("threadRowPresence", () => {
  it("decorates the row of a thread somebody is viewing", () => {
    const rows = threadRowPresence([viewer("alice", T1)], NOBODY_IS_ME);
    expect([...rows.keys()]).toEqual(["t1"]);
    const presence = rows.get("t1")!;
    expect(presence.threadId).toBe("t1");
    expect(presence.faces).toHaveLength(1);
    expect(presence.overflow).toBe(0);
    expect(presence.label).toBe("alice viewing");
  });

  it("gives each face the SAME initials and hue the strip's bubble has", () => {
    // The entire point of the change: one person is one colour and one pair of
    // initials, in the header strip and on the sidebar row. Asserted against
    // the strip's own model rather than against a copy of the formula.
    const rows = threadRowPresence([viewer("ada.lovelace", T1)], NOBODY_IS_ME);
    const face = rows.get("t1")!.faces[0]!;
    const strip = buildDockModel({
      roster: [{ clientId: "c1", name: "ada.lovelace" }],
      speaking: [],
      video: [],
      selfName: null,
    });
    expect(face.initials).toBe(strip.bubbles[0]!.initials);
    expect(face.color).toBe(strip.bubbles[0]!.color);
    expect(face.initials).toBe(initialsFor("ada.lovelace"));
    expect(face.color).toBe(colorForName("ada.lovelace"));
  });

  it("names everyone on the row, alphabetically", () => {
    const rows = threadRowPresence(
      [viewer("carol", T1), viewer("alice", T1), viewer("bob", T1)],
      NOBODY_IS_ME,
    );
    expect(rows.get("t1")!.label).toBe("alice, bob, carol viewing");
    expect(rows.get("t1")!.faces.map((face) => face.name)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("counts a person once however many tabs they have on that thread", () => {
    const rows = threadRowPresence([viewer("alice", T1), viewer("alice", T1)], NOBODY_IS_ME);
    expect(rows.get("t1")!.faces).toHaveLength(1);
    expect(rows.get("t1")!.label).toBe("alice viewing");
  });

  it("gives each thread its own decoration", () => {
    const rows = threadRowPresence([viewer("alice", T1), viewer("bob", T2)], NOBODY_IS_ME);
    expect(rows.get("t1")!.label).toBe("alice viewing");
    expect(rows.get("t2")!.label).toBe("bob viewing");
  });

  it("ignores anyone who is not in a thread at all", () => {
    expect(
      threadRowPresence([viewer("alice", CANVAS), viewer("bob", "/settings")], NOBODY_IS_ME).size,
    ).toBe(0);
  });

  it("ignores anyone whose location is unknown or stale", () => {
    expect(threadRowPresence([viewer("alice", null)], NOBODY_IS_ME).size).toBe(0);
  });

  it("decorates nothing when nobody is anywhere", () => {
    expect(threadRowPresence([], NOBODY_IS_ME).size).toBe(0);
  });
});

describe("threadRowPresence — you", () => {
  it("shows you on the row you are reading, labelled `you`", () => {
    const rows = threadRowPresence([viewer("alice", T1)], "alice");
    expect(rows.get("t1")!.label).toBe("you viewing");
    const face = rows.get("t1")!.faces[0]!;
    expect(face.isSelf).toBe(true);
    expect(face.label).toBe(SELF_LABEL);
    // The CIRCLE is still yours: your real name's initials and hue, because it
    // has to match the face you are looking at in the strip.
    expect(face.initials).toBe(initialsFor("alice"));
    expect(face.color).toBe(colorForName("alice"));
  });

  it("never echoes your own name back at you", () => {
    expect(threadRowPresence([viewer("alice", T1)], "alice").get("t1")!.label).not.toContain(
      "alice",
    );
  });

  it("puts you FIRST, not alphabetically", () => {
    const rows = threadRowPresence(
      [viewer("matt", T1), viewer("alice", T1), viewer("aaron", T1)],
      "alice",
    );
    expect(rows.get("t1")!.label).toBe("you, aaron, matt viewing");
    expect(rows.get("t1")!.faces.map((face) => face.label)).toEqual([
      "you",
      "aaron",
      "matt",
    ]);
  });

  it("collapses your several tabs into ONE `you`", () => {
    const rows = threadRowPresence(
      [viewer("alice", T1), viewer("alice", T1), viewer("bob", T1)],
      "alice",
    );
    expect(rows.get("t1")!.label).toBe("you, bob viewing");
    expect(rows.get("t1")!.faces).toHaveLength(2);
  });

  it("marks NOBODY as you when the strip does not know who you are", () => {
    const rows = threadRowPresence([viewer("alice", T1), viewer("bob", T1)], null);
    expect(rows.get("t1")!.label).toBe("alice, bob viewing");
    expect(rows.get("t1")!.faces.some((face) => face.isSelf)).toBe(false);
  });

  it("does not invent a row for you when you are not in a thread at all", () => {
    expect(threadRowPresence([viewer("alice", CANVAS)], "alice").size).toBe(0);
  });
});

describe("threadRowPresence — overflow", () => {
  const crowd = (count: number, path: string) =>
    Array.from({ length: count }, (_unused, index) =>
      viewer(`person${index}`, path),
    );

  it("draws at most MAX_ROW_FACES circles and folds the rest into +N", () => {
    // The strip's own convention (MAX_DOCK_BUBBLES then "+N"), not a second
    // one invented for the row.
    const rows = threadRowPresence(crowd(MAX_ROW_FACES + 3, T1), NOBODY_IS_ME);
    expect(rows.get("t1")!.faces).toHaveLength(MAX_ROW_FACES);
    expect(rows.get("t1")!.overflow).toBe(3);
  });

  it("still names EVERYBODY in the accessible label", () => {
    // The label is the accessible name, and it is the answer to "who". A "+3"
    // that hides three names from a screen reader would re-create the defect
    // this change exists to fix.
    const rows = threadRowPresence(crowd(MAX_ROW_FACES + 2, T1), NOBODY_IS_ME);
    for (let index = 0; index < MAX_ROW_FACES + 2; index += 1) {
      expect(rows.get("t1")!.label).toContain(`person${index}`);
    }
  });

  it("never drops YOU from the drawn faces", () => {
    // Same rule the strip follows over the cap: whoever else is folded away,
    // you are on the row you are reading.
    const viewers = [...crowd(MAX_ROW_FACES + 3, T1), viewer("zeta", T1)];
    const rows = threadRowPresence(viewers, "zeta");
    const faces = rows.get("t1")!.faces;
    expect(faces).toHaveLength(MAX_ROW_FACES);
    expect(faces[0]!.isSelf).toBe(true);
    expect(rows.get("t1")!.overflow).toBe(MAX_ROW_FACES + 4 - MAX_ROW_FACES);
  });

  it("does not fold when the crowd exactly fits", () => {
    const rows = threadRowPresence(crowd(MAX_ROW_FACES, T1), NOBODY_IS_ME);
    expect(rows.get("t1")!.faces).toHaveLength(MAX_ROW_FACES);
    expect(rows.get("t1")!.overflow).toBe(0);
  });
});

describe("threadRowPresence — the signature", () => {
  it("is identical for two ticks that mean the same thing", () => {
    // THE LOAD-BEARING PROPERTY. The roster is re-serialised every 2s and tab
    // order is not stable; a signature that depended on it would rewrite every
    // decorated row's DOM every two seconds forever.
    const tick1 = threadRowPresence(
      [viewer("alice", T1), viewer("matt", T1), viewer("aaron", T1)],
      "alice",
    );
    const tick2 = threadRowPresence(
      [viewer("aaron", T1), viewer("alice", T1), viewer("matt", T1)],
      "alice",
    );
    expect(tick2.get("t1")!.signature).toBe(tick1.get("t1")!.signature);
  });

  it("changes when somebody joins the row", () => {
    const before = threadRowPresence([viewer("alice", T1)], NOBODY_IS_ME);
    const after = threadRowPresence([viewer("alice", T1), viewer("bob", T1)], NOBODY_IS_ME);
    expect(after.get("t1")!.signature).not.toBe(before.get("t1")!.signature);
  });

  it("changes when a viewer becomes you", () => {
    // Same names, different rendering — the self face is labelled and ringed
    // differently, so the decoration must be rewritten.
    const stranger = threadRowPresence([viewer("alice", T1)], NOBODY_IS_ME);
    const me = threadRowPresence([viewer("alice", T1)], "alice");
    expect(me.get("t1")!.signature).not.toBe(stranger.get("t1")!.signature);
  });

  it("changes when the overflow count changes but the drawn faces do not", () => {
    const three = threadRowPresence(
      Array.from({ length: MAX_ROW_FACES + 1 }, (_u, i) => viewer(`p${i}`, T1)),
      NOBODY_IS_ME,
    );
    const four = threadRowPresence(
      Array.from({ length: MAX_ROW_FACES + 2 }, (_u, i) => viewer(`p${i}`, T1)),
      NOBODY_IS_ME,
    );
    expect(four.get("t1")!.signature).not.toBe(three.get("t1")!.signature);
  });
});

describe("planRowDecorations", () => {
  const presenceOf = (viewers: Parameters<typeof threadRowPresence>[0], self: string | null = null) =>
    threadRowPresence(viewers, self);

  it("adds a decoration to a bare row somebody is viewing", () => {
    const presence = presenceOf([viewer("alice", T1)]);
    expect(planRowDecorations([row("t1")], presence)).toEqual([
      { action: "add", index: 0, threadId: "t1", presence: presence.get("t1") },
    ]);
  });

  it("does NOTHING to a row already carrying exactly the right decoration", () => {
    // The whole reason this is a plan and not a re-render: it runs on every
    // coalesced DOM mutation in the app, forever.
    const presence = presenceOf([viewer("alice", T1)]);
    const signature = presence.get("t1")!.signature;
    expect(planRowDecorations([row("t1", signature)], presence)).toEqual([]);
  });

  it("updates a row whose viewers changed", () => {
    const presence = presenceOf([viewer("alice", T1), viewer("bob", T1)]);
    const plan = planRowDecorations([row("t1", "something-older")], presence);
    expect(plan).toEqual([
      { action: "update", index: 0, threadId: "t1", presence: presence.get("t1") },
    ]);
  });

  it("removes a decoration from a row nobody is on any more", () => {
    expect(planRowDecorations([row("t1", "stale")], new Map())).toEqual([
      { action: "remove", index: 0, threadId: "t1" },
    ]);
  });

  it("leaves an undecorated row with no viewers completely alone", () => {
    expect(planRowDecorations([row("t1")], new Map())).toEqual([]);
  });

  it("does nothing at all when the sidebar has no thread rows", () => {
    // GRACEFUL DEGRADATION. Another plugin has replaced the thread list (yaks
    // does exactly this): there is nothing to decorate, and that is not an
    // error.
    const presence = presenceOf([viewer("alice", T1)]);
    expect(planRowDecorations([], presence)).toEqual([]);
  });

  it("ignores presence for threads that are not in the sidebar right now", () => {
    // The sidebar is scrolled and virtualised; a row that is not rendered is
    // not a row to decorate, and must not be conjured.
    const presence = presenceOf([viewer("alice", T1), viewer("bob", T2)]);
    const plan = planRowDecorations([row("t2")], presence);
    expect(plan.map((step) => step.threadId)).toEqual(["t2"]);
  });

  it("addresses each row by POSITION, so a duplicated thread row is handled twice", () => {
    const presence = presenceOf([viewer("alice", T1)]);
    const plan = planRowDecorations([row("t1"), row("t1")], presence);
    expect(plan.map((step) => step.index)).toEqual([0, 1]);
  });

  it("moves a decoration React has shuffled out of first place", () => {
    // anchor.ts's rule, applied to a second container: writing into a React
    // container is safe, and the condition that makes it safe is noticing when
    // our position has drifted and restoring it. React reconciles only its own
    // children — it can shuffle a foreign node's POSITION but not its
    // existence — so the row's title can end up in front of the faces.
    const presence = presenceOf([viewer("alice", T1)]);
    const signature = presence.get("t1")!.signature;
    expect(planRowDecorations([row("t1", signature, false)], presence)).toEqual([
      { action: "move", index: 0, threadId: "t1" },
    ]);
  });

  it("does not move a decoration that is already leading", () => {
    const presence = presenceOf([viewer("alice", T1)]);
    const signature = presence.get("t1")!.signature;
    expect(planRowDecorations([row("t1", signature, true)], presence)).toEqual([]);
  });

  it("folds a drifted AND stale decoration into one update, not two steps", () => {
    // An update re-inserts as well as repaints, so emitting a move beside it
    // would be a second DOM write for one change.
    const presence = presenceOf([viewer("alice", T1)]);
    expect(planRowDecorations([row("t1", "stale", false)], presence)).toEqual([
      { action: "update", index: 0, threadId: "t1", presence: presence.get("t1") },
    ]);
  });

  it("removes a drifted decoration nobody wants any more", () => {
    expect(planRowDecorations([row("t1", "stale", false)], new Map())).toEqual([
      { action: "remove", index: 0, threadId: "t1" },
    ]);
  });

  it("keeps a mixed pass in row order", () => {
    const presence = presenceOf([viewer("alice", T1)]);
    const plan = planRowDecorations(
      [row("t2", "stale"), row("t1"), row("t1", presence.get("t1")!.signature)],
      presence,
    );
    expect(plan.map((step) => [step.action, step.index])).toEqual([
      ["remove", 0],
      ["add", 1],
    ]);
  });
});

describe("isOwnMutation / shouldScheduleSync", () => {
  // THE FEEDBACK LOOP GUARD. The decoration pass writes into the very subtree
  // the MutationObserver watches, so without this every write would schedule
  // another pass, forever. A record is OURS when the mutated node is ours, or
  // when a childList record's added/removed nodes are all ours — which is
  // exactly the shape of "we inserted a decoration into a host row".
  const foreign = { targetIsOurs: false, nodes: [] as boolean[] };

  it("calls a mutation of our own subtree ours", () => {
    expect(isOwnMutation({ targetIsOurs: true, nodes: [] })).toBe(true);
  });

  it("calls inserting our decoration into a HOST row ours", () => {
    expect(isOwnMutation({ targetIsOurs: false, nodes: [true] })).toBe(true);
  });

  it("calls removing our decoration from a HOST row ours", () => {
    expect(isOwnMutation({ targetIsOurs: false, nodes: [true, true] })).toBe(true);
  });

  it("does not claim a batch that also moved a host node", () => {
    expect(isOwnMutation({ targetIsOurs: false, nodes: [true, false] })).toBe(false);
  });

  it("does not claim a host attribute change", () => {
    expect(isOwnMutation(foreign)).toBe(false);
  });

  it("schedules nothing when every record in the batch was ours", () => {
    expect(
      shouldScheduleSync([
        { targetIsOurs: true, nodes: [] },
        { targetIsOurs: false, nodes: [true] },
      ]),
    ).toBe(false);
  });

  it("schedules as soon as one record was the host's", () => {
    expect(shouldScheduleSync([{ targetIsOurs: true, nodes: [] }, foreign])).toBe(true);
  });

  it("schedules nothing for an empty batch", () => {
    expect(shouldScheduleSync([])).toBe(false);
  });
});

describe("rowDecorationState", () => {
  it("says `no-rows` when the sidebar has no thread rows to decorate", () => {
    // "Nothing to decorate" and "broken" must stay distinguishable from
    // outside the app — the same job `data-dock-row-status` did for the
    // feature-detected host API this replaced.
    expect(rowDecorationState(0, false)).toBe("no-rows");
  });

  it("says `ok` once there are rows", () => {
    expect(rowDecorationState(7, false)).toBe("ok");
  });

  it("says `failed` when the pass threw, whatever the row count", () => {
    expect(rowDecorationState(7, true)).toBe("failed");
    expect(rowDecorationState(0, true)).toBe("failed");
  });
});

describe("the presence value is inert", () => {
  it("carries no host icon name and no tone", () => {
    // The old surface was `{icon, label, tone}` where icon had to be a name
    // from bb's registry. Nothing here goes through the host, so nothing here
    // is constrained by it — and a leftover `icon` field would be a sign the
    // old call path had grown back.
    const presence: RowPresence = threadRowPresence([viewer("alice", T1)], null).get("t1")!;
    expect(Object.keys(presence).sort()).toEqual([
      "faces",
      "label",
      "overflow",
      "signature",
      "threadId",
    ]);
  });
});
