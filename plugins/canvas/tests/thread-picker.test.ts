// Run: npx vitest run tests/thread-picker.test.ts
//
// WHICH THREADS THE ATTACH PICKER OFFERS, in what order, and how the query
// narrows them. Task 2b. Every one of those is a decision, so none of them is
// allowed to live in server.ts's handler or in agents-ui.tsx.
import { describe, expect, it } from "vitest";
import {
  THREAD_PICKER_LIMIT,
  filterThreadOptions,
  threadListArgsFor,
  threadOptionLabel,
  threadOptionNote,
  threadOptionSelectable,
  threadPickerEnterTarget,
  threadPickerOptions,
  type ThreadListRow,
} from "../canvas/thread-picker.js";

function row(overrides: Partial<ThreadListRow> & { id: string }): ThreadListRow {
  return {
    title: null,
    titleFallback: null,
    projectId: "proj_canvas",
    archivedAt: null,
    deletedAt: null,
    updatedAt: 1_000,
    visibility: "visible",
    ...overrides,
  };
}

describe("threadListArgsFor", () => {
  it("scopes the list to the canvas project", () => {
    // The whole point of 2d: a thread the user cannot see in their sidebar is
    // a thread they will conclude does not exist.
    expect(threadListArgsFor("proj_canvas").projectId).toBe("proj_canvas");
  });

  it("asks bb to leave archived threads out", () => {
    expect(threadListArgsFor("proj_canvas").archived).toBe(false);
  });

  it("passes NO limit, because the cap is applied after sorting", () => {
    // `ThreadListArgs` documents `limit`/`offset` but no ordering, so a
    // server-side limit would be "some 50 threads", not "the 50 most recent".
    expect(threadListArgsFor("proj_canvas")).not.toHaveProperty("limit");
  });
});

describe("threadOptionLabel", () => {
  it("prefers the thread's own title", () => {
    expect(
      threadOptionLabel(row({ id: "th_1", title: "Release notes", titleFallback: "fb" })),
    ).toBe("Release notes");
  });

  it("falls back to bb's own fallback title", () => {
    expect(threadOptionLabel(row({ id: "th_1", title: null, titleFallback: "First message" }))).toBe(
      "First message",
    );
  });

  it("falls back to the id when bb has no title at all", () => {
    // Ugly, and better than a blank row: an unlabelled row is unclickable
    // because there is nothing to aim at.
    expect(threadOptionLabel(row({ id: "th_1" }))).toBe("th_1");
  });

  it("treats an all-whitespace title as no title", () => {
    expect(threadOptionLabel(row({ id: "th_1", title: "   ", titleFallback: "Real" }))).toBe("Real");
  });
});

describe("threadPickerOptions", () => {
  it("orders most recently updated first", () => {
    const options = threadPickerOptions(
      [
        row({ id: "th_old", updatedAt: 100 }),
        row({ id: "th_new", updatedAt: 900 }),
        row({ id: "th_mid", updatedAt: 500 }),
      ],
      {},
    );
    expect(options.map((option) => option.threadId)).toEqual(["th_new", "th_mid", "th_old"]);
  });

  it("breaks a tie on id, so two peers see the same list", () => {
    const options = threadPickerOptions(
      [row({ id: "th_b", updatedAt: 100 }), row({ id: "th_a", updatedAt: 100 })],
      {},
    );
    expect(options.map((option) => option.threadId)).toEqual(["th_a", "th_b"]);
  });

  it("drops an archived thread even when bb sent one", () => {
    const options = threadPickerOptions(
      [row({ id: "th_live" }), row({ id: "th_gone", archivedAt: 5 })],
      {},
    );
    expect(options.map((option) => option.threadId)).toEqual(["th_live"]);
  });

  it("drops a deleted thread", () => {
    const options = threadPickerOptions(
      [row({ id: "th_live" }), row({ id: "th_gone", deletedAt: 5 })],
      {},
    );
    expect(options.map((option) => option.threadId)).toEqual(["th_live"]);
  });

  it("drops a hidden thread", () => {
    const options = threadPickerOptions(
      [row({ id: "th_live" }), row({ id: "th_hidden", visibility: "hidden" })],
      {},
    );
    expect(options.map((option) => option.threadId)).toEqual(["th_live"]);
  });

  it("MARKS an already-attached thread rather than hiding it", () => {
    const options = threadPickerOptions(
      [row({ id: "th_taken" }), row({ id: "th_free" })],
      { th_taken: "shape:a" },
    );
    expect(options.map((option) => option.threadId).sort()).toEqual(["th_free", "th_taken"]);
    const taken = options.find((option) => option.threadId === "th_taken");
    expect(taken?.attachedShapeId).toBe("shape:a");
    expect(options.find((option) => option.threadId === "th_free")?.attachedShapeId).toBeNull();
  });

  it("caps the list at THREAD_PICKER_LIMIT, keeping the most recent", () => {
    // An ABSOLUTE assertion on the constant as well as a relative one: a
    // threshold checked only against itself is a threshold that can be moved
    // freely past a green suite.
    expect(THREAD_PICKER_LIMIT).toBe(50);
    const many = Array.from({ length: 60 }, (_unused, i) =>
      row({ id: `th_${String(i).padStart(2, "0")}`, updatedAt: i }),
    );
    const options = threadPickerOptions(many, {});
    expect(options).toHaveLength(50);
    expect(options[0]?.threadId).toBe("th_59");
    // th_10 is the 50th most recent; th_09 and below are cut.
    expect(options.at(-1)?.threadId).toBe("th_10");
  });

  it("carries updatedAt through, so the UI can say how stale a thread is", () => {
    expect(threadPickerOptions([row({ id: "th_1", updatedAt: 4_242 })], {})[0]?.updatedAt).toBe(
      4_242,
    );
  });
});

describe("filterThreadOptions", () => {
  const options = threadPickerOptions(
    [
      row({ id: "th_alpha", title: "Release notes", updatedAt: 300 }),
      row({ id: "th_beta", title: "Refactor the parser", updatedAt: 200 }),
      row({ id: "th_gamma", title: null, titleFallback: null, updatedAt: 100 }),
    ],
    {},
  );

  it("returns everything for an empty or whitespace query", () => {
    expect(filterThreadOptions(options, "")).toHaveLength(3);
    expect(filterThreadOptions(options, "   ")).toHaveLength(3);
  });

  it("matches the label case-insensitively, as a substring", () => {
    expect(filterThreadOptions(options, "RELEASE").map((o) => o.threadId)).toEqual(["th_alpha"]);
    expect(filterThreadOptions(options, "the").map((o) => o.threadId)).toEqual(["th_beta"]);
  });

  it("preserves the order rather than ranking", () => {
    expect(filterThreadOptions(options, "re").map((o) => o.threadId)).toEqual([
      "th_alpha",
      "th_beta",
    ]);
  });

  it("matches a thread id only when the query IS that id", () => {
    // Pasting an id is a real way to say "this exact thread". A SUBSTRING
    // match on ids would make "th" — two letters of half the English
    // language — select the whole list. Driven over a set where no LABEL
    // contains an id, so only the id rule can be what answers.
    const titled = threadPickerOptions(
      [
        row({ id: "th_alpha", title: "Release notes", updatedAt: 300 }),
        row({ id: "th_beta", title: "Refactor a parser", updatedAt: 200 }),
      ],
      {},
    );
    expect(filterThreadOptions(titled, "th_beta").map((o) => o.threadId)).toEqual(["th_beta"]);
    expect(filterThreadOptions(titled, " TH_BETA ").map((o) => o.threadId)).toEqual(["th_beta"]);
    expect(filterThreadOptions(titled, "th_").map((o) => o.threadId)).toEqual([]);
    expect(filterThreadOptions(titled, "th").map((o) => o.threadId)).toEqual([]);
  });

  it("still finds a thread whose label fell back to its id", () => {
    // Not the id rule — the LABEL is the id here, so an ordinary substring
    // query finds it.
    expect(filterThreadOptions(options, "gamma").map((o) => o.threadId)).toEqual(["th_gamma"]);
  });
});

describe("what a marked row says and whether it can be chosen", () => {
  const option = (attachedShapeId: string | null) => ({
    threadId: "th_1",
    label: "Release notes",
    updatedAt: 1,
    attachedShapeId,
  });

  it("says nothing about a free thread", () => {
    expect(threadOptionNote(option(null), "shape:me")).toBeNull();
  });

  it("says a thread is on THIS shape, without repeating the shape id", () => {
    // The user is looking at that shape; naming its id back at them is noise.
    expect(threadOptionNote(option("shape:me"), "shape:me")).toBe("already on this shape");
  });

  it("names the OTHER shape holding a thread", () => {
    // Marked rather than hidden (see `threadPickerOptions`), so the mark has
    // to answer the question the row raises: where is it, then?
    expect(threadOptionNote(option("shape:other"), "shape:me")).toBe("on shape:other");
  });

  it("lets a free thread be chosen", () => {
    expect(threadOptionSelectable(option(null), "shape:me")).toBe(true);
  });

  it("lets THIS shape re-choose the thread it already has", () => {
    // Idempotent, and the same call `attachVerdictFor` makes — an enabled row
    // whose attach would be refused is the failure this duplication could
    // introduce, and tests/agent-attach.test.ts pins the other half.
    expect(threadOptionSelectable(option("shape:me"), "shape:me")).toBe(true);
  });

  it("REFUSES a thread held by another shape", () => {
    // The kv mirror is keyed both directions, so one thread cannot badge two
    // shapes. Disabled here rather than hidden, so the row can explain itself.
    expect(threadOptionSelectable(option("shape:other"), "shape:me")).toBe(false);
  });
});

describe("threadPickerEnterTarget", () => {
  // WHAT ENTER IN THE FILTER BOX BINDS THE SHAPE TO. Untested until 2026-09-07,
  // and the gap was not academic: replacing the body with
  // `options[options.length - 1] ?? null` — Enter binds the shape to the
  // LEAST recently updated match instead of the top one — left the whole suite
  // at 49 files / 1183 tests passed, and so did `return null`. A wrong,
  // durable kv write with no error, and nothing noticed.
  const option = (threadId: string) => ({
    threadId,
    label: threadId,
    updatedAt: 1,
    attachedShapeId: null,
  });

  it("takes the FIRST row, which is the one the picker highlights", () => {
    // Not the last, not an arbitrary one: `threadPickerOptions` draws the list
    // most-recent-first and `filterThreadOptions` preserves that order, so the
    // top row is the one under the user's eye when they press Enter.
    expect(
      threadPickerEnterTarget([option("th_top"), option("th_middle"), option("th_last")])
        ?.threadId,
    ).toBe("th_top");
  });

  it("takes the only row when the filter narrowed to one", () => {
    expect(threadPickerEnterTarget([option("th_only")])?.threadId).toBe("th_only");
  });

  it("takes NOTHING when the filter matched nothing", () => {
    // The difference between "Enter is the fast path" and "Enter does something
    // surprising when the filter matched nothing".
    expect(threadPickerEnterTarget([])).toBeNull();
  });

  it("returns the row itself, not a copy, so the caller attaches what it read", () => {
    const rows = [option("th_top"), option("th_other")];
    expect(threadPickerEnterTarget(rows)).toBe(rows[0]);
  });

  it("agrees with the list the picker actually draws", () => {
    // End to end over the two functions the filter box composes: Enter must
    // take the top of the FILTERED rows, not the top of the unfiltered offer.
    const options = threadPickerOptions(
      [
        row({ id: "th_alpha", title: "Release notes", updatedAt: 300 }),
        row({ id: "th_beta", title: "Refactor the parser", updatedAt: 200 }),
      ],
      {},
    );
    expect(threadPickerEnterTarget(options)?.threadId).toBe("th_alpha");
    expect(
      threadPickerEnterTarget(filterThreadOptions(options, "refactor"))?.threadId,
    ).toBe("th_beta");
  });
});
