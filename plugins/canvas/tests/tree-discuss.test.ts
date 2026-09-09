// Run: npx vitest run tests/tree-discuss.test.ts
//
// W8 — "discuss this node": the OUTBOUND half of D2. A human selects a node on
// the canvas, presses one control, and a reference to that node lands in the
// thread composer. The human still presses send.
//
// What this suite pins, and why each one is a way the affordance could lie:
//
//  1. THE REFERENCE IS THE SAME SYNTAX W9 RENDERS. If emit and render ever
//     disagree the round trip breaks silently — the human sees a line of
//     markup in their own message instead of a card. Tested against W9's own
//     module, never against a second hand-typed fixture.
//  2. IT CARRIES ENOUGH TO BE ANSWERABLE AND NO MORE. The id plus the path to
//     root. A wall of context pasted into a human's composer is a worse trade
//     than a model spending one W6 tool call.
//  3. IT NEVER DESTROYS A DRAFT. A human may be mid-sentence; the insert
//     appends and leaves what they typed alone.
//  4. IT REFUSES VISIBLY WHEN THERE IS NOWHERE TO WRITE. A control that
//     silently writes into nothing is worse than a greyed one that says why.
import { describe, expect, it } from "vitest";
import {
  MAX_PATH_STEPS,
  MAX_REFERENCE_CHARS,
  MAX_STEP_TITLE,
  composerDestination,
  discussArmFor,
  discussReport,
  draftWithReference,
  nodeReferenceFor,
} from "../canvas/tree/discuss.js";
import { nodeDirective } from "../canvas/tree/node-reference.js";
import { treeGestureTargetFor } from "../canvas/tree/gestures.js";
import { EXAMPLE, TREE, docOf } from "./lib/tree-fixture.js";

const targetIn = (doc: ReturnType<typeof docOf>, shapeId: string) =>
  treeGestureTargetFor({ selection: new Set([shapeId]), shapeOf: (id) => doc.byId.get(id) });

const okText = (reference: ReturnType<typeof nodeReferenceFor>): string => {
  if (!reference.ok) throw new Error(`expected a reference, got: ${reference.why}`);
  return reference.text;
};

describe("nodeReferenceFor", () => {
  const doc = docOf(EXAMPLE);

  it("opens with the directive W9 renders, on its own line", () => {
    const text = okText(nodeReferenceFor(doc, TREE, "shape:schema"));
    const [first] = text.split("\n");
    // The EMITTER is the definition; W9's parse side is tested against this
    // same function in tests/tree-node-directive.test.ts.
    expect(first).toBe(nodeDirective("shape:schema"));
  });

  it("carries the path to root, root first, ending at the node itself", () => {
    const text = okText(nodeReferenceFor(doc, TREE, "shape:schema"));
    expect(text).toContain("Ship discovery trees");
    expect(text).toContain("Tree service");
    expect(text).toContain("Encoding contract");
    expect(text.indexOf("Ship discovery trees")).toBeLessThan(text.indexOf("Tree service"));
    expect(text.indexOf("Tree service")).toBeLessThan(text.indexOf("Encoding contract"));
  });

  it("carries nothing else — no context note, no blocker list, no state", () => {
    const doc2 = docOf({ ...EXAMPLE, context: { "shape:schema": "a long context note" } });
    const text = okText(nodeReferenceFor(doc2, TREE, "shape:schema"));
    expect(text).not.toContain("a long context note");
    expect(text).not.toContain("Arrow renderer"); // a sibling blocker
    expect(text.split("\n")).toHaveLength(2);
  });

  it("names a root node without pretending it has ancestors", () => {
    const text = okText(nodeReferenceFor(doc, TREE, "shape:goal"));
    expect(text).toContain("Ship discovery trees");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("says an untitled node is untitled rather than rendering an empty step", () => {
    const bare = docOf({ nodes: { "shape:bare": "todo" }, edges: [] });
    const text = okText(nodeReferenceFor(bare, TREE, "shape:bare"));
    expect(text).toContain("(untitled)");
  });

  it("keeps the root and the nearest steps when the path is deeper than the cap", () => {
    const ids = Array.from({ length: MAX_PATH_STEPS + 4 }, (_, i) => `shape:n${i}`);
    const deep = docOf({
      nodes: Object.fromEntries(ids.map((id, i) => [id, ["todo", `Step ${i}`] as const])),
      // n0 is the root; each next node blocks the one before it.
      edges: ids.slice(1).map((id, i) => [id, ids[i] as string] as const),
    });
    const last = ids[ids.length - 1] as string;
    const text = okText(nodeReferenceFor(deep, TREE, last));
    expect(text).toContain("Step 0"); // the root survives — it is the goal
    expect(text).toContain(`Step ${ids.length - 1}`); // and so does the node
    expect(text).toContain("…"); // and the middle says it was cut
    expect(text).not.toContain("Step 3");
    expect(text.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
  });

  it("stays inside the character bound even when every title is enormous", () => {
    const ids = Array.from({ length: MAX_PATH_STEPS }, (_, i) => `shape:n${i}`);
    const shouty = docOf({
      nodes: Object.fromEntries(
        ids.map((id, i) => [id, ["todo", `${"x".repeat(400)}${i}`] as const]),
      ),
      edges: ids.slice(1).map((id, i) => [id, ids[i] as string] as const),
    });
    const text = okText(nodeReferenceFor(shouty, TREE, ids[ids.length - 1] as string));
    expect(text.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS);
    // Each step is cut to a readable label, not to the whole note.
    const path = (text.split("\n")[1] ?? "").replace(/^Path: /, "");
    for (const step of path.split("›")) {
      expect(step.trim().length).toBeLessThanOrEqual(MAX_STEP_TITLE + 1);
    }
  });

  it("uses only the first line of a multi-line note", () => {
    const doc2 = docOf({ nodes: { "shape:n": ["todo", "Title line\nand the body"] }, edges: [] });
    const text = okText(nodeReferenceFor(doc2, TREE, "shape:n"));
    expect(text).toContain("Title line");
    expect(text).not.toContain("and the body");
  });

  it("still references the node when the tree above it has a cycle, and says the path is missing", () => {
    // Two individually-legal concurrent edits (W11's subject). The reference is
    // still the most useful thing here — the node is real and a human wants to
    // ask about it — but a path we cannot read must not be invented.
    const cyclic = docOf({
      nodes: { "shape:a": "todo", "shape:b": "todo" },
      edges: [
        ["shape:a", "shape:b"],
        ["shape:b", "shape:a"],
      ],
    });
    const reference = nodeReferenceFor(cyclic, TREE, "shape:a");
    const text = okText(reference);
    expect(text.split("\n")[0]).toBe(nodeDirective("shape:a"));
    expect(text).toContain("cycle");
  });

  it("refuses a shape that is not a node of this tree", () => {
    const reference = nodeReferenceFor(doc, TREE, "shape:missing");
    expect(reference.ok).toBe(false);
    if (!reference.ok) expect(reference.why).toContain("shape:missing");
  });
});

describe("composerDestination", () => {
  it("writes into the thread the canvas is open beside", () => {
    const where = composerDestination({ kind: "thread", threadId: "thr_1" });
    expect(where.ok).toBe(true);
  });

  it("writes into a queued message being edited, and into a side chat", () => {
    expect(
      composerDestination({ kind: "queued-message", threadId: "t", queuedMessageId: "q" }).ok,
    ).toBe(true);
    expect(
      composerDestination({
        kind: "side-chat",
        projectId: "p",
        parentThreadId: "t",
        tabId: "tab",
        childThreadId: null,
      }).ok,
    ).toBe(true);
  });

  it("seeds a new-thread draft when one is resolved", () => {
    expect(composerDestination({ kind: "new-thread", projectId: "prj_1" }).ok).toBe(true);
  });

  it("refuses a new-thread composer that has not resolved a project yet", () => {
    const where = composerDestination({ kind: "new-thread", projectId: null });
    expect(where.ok).toBe(false);
  });

  it("refuses when there is no composer at all", () => {
    const where = composerDestination(null);
    expect(where.ok).toBe(false);
    if (!where.ok) expect(where.why.length).toBeGreaterThan(0);
  });
});

describe("discussArmFor", () => {
  const doc = docOf(EXAMPLE);
  const armOf = (...args: Parameters<typeof discussArmFor>) => {
    const arm = discussArmFor(...args);
    if (arm === null) throw new Error("expected an arm");
    return arm;
  };
  const here = composerDestination({ kind: "thread", threadId: "thr_1" });
  const nowhere = composerDestination(null);

  it("is offered on a tree node with a composer in scope", () => {
    const arm = armOf(targetIn(doc, "shape:api"), here);
    expect(arm.enabled).toBe(true);
    expect(arm.reason).toBe("");
  });

  it("is greyed — never hidden — on a shape that is not a tree node", () => {
    const loose = docOf({ nodes: {}, edges: [], extraPages: [] });
    const arm = armOf({ shapeId: "shape:loose", treeId: null }, here);
    expect(arm.enabled).toBe(false);
    expect(arm.reason.length).toBeGreaterThan(0);
    expect(loose).toBeDefined();
  });

  it("is greyed with the destination's own reason when there is nowhere to write", () => {
    const arm = armOf(targetIn(doc, "shape:api"), nowhere);
    expect(arm.enabled).toBe(false);
    if (!nowhere.ok) expect(arm.reason).toBe(nowhere.why);
  });

  it("has no arm at all without a target — there is nothing to anchor it to", () => {
    expect(discussArmFor(null, here)).toBeNull();
  });
});

describe("draftWithReference", () => {
  const reference = `${nodeDirective("shape:api")}\nShip discovery trees › Tree service`;

  it("is the whole draft when the composer is empty", () => {
    expect(draftWithReference("", reference)).toBe(reference);
    expect(draftWithReference("   \n ", reference)).toBe(reference);
  });

  it("APPENDS to a draft in progress rather than replacing it", () => {
    // The trade this node refuses to make: a human mid-sentence must not lose
    // what they typed to gain a reference.
    const draft = draftWithReference("why is this stuck?", reference);
    expect(draft).not.toBeNull();
    expect(draft).toContain("why is this stuck?");
    expect(draft?.indexOf("why is this stuck?")).toBeLessThan(draft?.indexOf("::node") ?? -1);
  });

  it("puts a blank line between the draft and the reference", () => {
    expect(draftWithReference("why is this stuck?", reference)).toBe(
      `why is this stuck?\n\n${reference}`,
    );
    // Trailing whitespace in the draft does not become three blank lines.
    expect(draftWithReference("why is this stuck?  \n\n", reference)).toBe(
      `why is this stuck?\n\n${reference}`,
    );
  });

  it("is a no-op when this node is already referenced in the draft", () => {
    const draft = `look at ${nodeDirective("shape:api")} please`;
    expect(draftWithReference(draft, reference)).toBeNull();
  });

  it("still inserts when a DIFFERENT node is already referenced", () => {
    const draft = `${nodeDirective("shape:ui")}\nsomething else`;
    expect(draftWithReference(draft, reference)).toContain(nodeDirective("shape:api") as string);
  });
});

describe("discussReport", () => {
  // The panel writes through `updateText`, so what happened is only knowable
  // from whether the updater ran and what it decided. Three answers, three
  // different things to say — and none of them is silence: the composer can be
  // scrolled out of view, and a control that appears to do nothing is
  // indistinguishable from a broken one.
  it("names where the reference landed", () => {
    const report = discussReport("inserted", "this thread");
    expect(report.tone).toBe("success");
    expect(report.text).toContain("this thread");
  });

  it("says the node was already referenced rather than claiming a second insert", () => {
    const report = discussReport("duplicate", "this thread");
    expect(report.tone).toBe("info");
    expect(report.text).toMatch(/already/i);
  });

  it("reports a composer that never ran the update as a FAILURE, not a duplicate", () => {
    // These two are not the same fact, and defaulting to "already there" would
    // tell a human their reference is in a message that does not contain it.
    const report = discussReport("unrun", "this thread");
    expect(report.tone).toBe("error");
    expect(report.text).not.toMatch(/already/i);
  });
});
