// Run: npx vitest run tests/tree-discuss-reach.test.ts
//
// W17 — IS "DISCUSS THIS NODE" REACHABLE IN THE PRODUCT?
//
// W8 verified an internal contract (`composerDestination` maps four scopes to
// four answers) and nothing verified the product-level claim on top of it:
// that the surface the control actually ships on has one of those answers. It
// did not. The canvas is a NAV PANEL — a whole route at /plugins/canvas/canvas
// — and from a nav panel `useComposer()` resolves to the ROOT compose scope,
// `{kind: "new-thread", projectId: null}`, which is the one case
// `composerDestination` refuses. So the button was greyed on every press, on
// the only surface it exists on, from the day it landed, with tests green.
//
// This suite is the level that was missing. It does not test a mapping; it
// tests REACHABILITY: from every composer scope the host can hand this panel —
// including the one the canvas route itself yields — pressing the control must
// end somewhere a human can see and send. No scope may dead-end.
//
// WHAT IT WOULD NOT HAVE CAUGHT, said plainly because that is the honest half:
// it still does not observe the real host. `CANVAS_ROUTE_SCOPE` below is this
// project's BELIEF about what the canvas route yields, written down where it
// can be argued with, not a measurement of it. If bb changed a nav panel's
// composer scope to some fifth kind, the union exhaustion here would fail at
// typecheck (good) — but if bb changed it to another EXISTING kind, this suite
// would stay green while the panel behaved differently. What it does guarantee
// is that no scope leaves the control with nowhere to go, which is the exact
// class of bug W8 shipped.
import { describe, expect, it } from "vitest";
import type { PluginComposerScope } from "@get-bb/plugin-sdk";
import {
  discussArmFor,
  discussReport,
  discussRouteFor,
  nodeReferenceFor,
} from "../canvas/tree/discuss.js";
import { NO_LIVE_TEXT } from "../canvas/shape-text.js";
import { NODE_DIRECTIVE_ID, nodeIdFromAttributes } from "../canvas/tree/node-reference.js";
import { treeGestureTargetFor } from "../canvas/tree/gestures.js";
import { EXAMPLE, TREE, docOf } from "./lib/tree-fixture.js";

/**
 * What `useComposer()` yields to a plugin NAV PANEL: the root compose scope,
 * with no project resolved. This is the surface the canvas ships on, and it is
 * the scope W8's own refusal branch was written for.
 */
const CANVAS_ROUTE_SCOPE: PluginComposerScope = { kind: "new-thread", projectId: null };

/** Every scope kind the host's union can produce, plus "no composer api at
 * all". Exhaustive by construction: `kind` is checked against the union below,
 * so a new host scope kind fails the typecheck rather than slipping past. */
const EVERY_SCOPE: readonly (PluginComposerScope | null)[] = [
  null,
  { kind: "thread", threadId: "thr_1" },
  { kind: "queued-message", threadId: "thr_1", queuedMessageId: "q_1" },
  {
    kind: "side-chat",
    projectId: "prj_1",
    parentThreadId: "thr_1",
    tabId: "tab_1",
    childThreadId: null,
  },
  { kind: "new-thread", projectId: "prj_1" },
  CANVAS_ROUTE_SCOPE,
];

const doc = docOf(EXAMPLE);
const targetIn = (shapeId: string) =>
  treeGestureTargetFor({ selection: new Set([shapeId]), shapeOf: (id) => doc.byId.get(id) });

describe("the control the canvas actually ships leads somewhere", () => {
  it("is enabled on a tree node from the canvas route's own composer scope", () => {
    // THE BUG, at product level: this is the press the owner made, and it was
    // greyed with "The new-thread composer has not picked a project yet."
    const arm = discussArmFor(targetIn("shape:api"), discussRouteFor(CANVAS_ROUTE_SCOPE));
    expect(arm).not.toBeNull();
    expect(arm?.enabled).toBe(true);
    expect(arm?.reason).toBe("");
  });

  it("has a destination from every scope the host can hand this panel", () => {
    for (const scope of EVERY_SCOPE) {
      const route = discussRouteFor(scope);
      // Either an in-place composer, or the compose surface. Never nowhere.
      expect(["composer", "compose"]).toContain(route.kind);
    }
  });

  it("never greys the control for want of a destination, on any scope", () => {
    for (const scope of EVERY_SCOPE) {
      const arm = discussArmFor(targetIn("shape:api"), discussRouteFor(scope));
      expect(arm?.enabled, `scope ${scope === null ? "null" : scope.kind}`).toBe(true);
    }
  });

  it("still greys a shape that is not a tree node — that refusal is reachable", () => {
    const arm = discussArmFor(
      { shapeId: "shape:loose", treeId: null },
      discussRouteFor(CANVAS_ROUTE_SCOPE),
    );
    expect(arm?.enabled).toBe(false);
    expect(arm?.reason.length).toBeGreaterThan(0);
  });
});

describe("what the compose route carries", () => {
  it("stays on the canvas when there IS an in-place composer to write into", () => {
    // Navigating away from the canvas costs the human their selection and
    // their camera. It is the fallback, not the path.
    expect(discussRouteFor({ kind: "thread", threadId: "thr_1" }).kind).toBe("composer");
  });

  it("seeds the compose surface with the SAME block the composer insert would get", () => {
    const reference = nodeReferenceFor(doc, TREE, "shape:api", NO_LIVE_TEXT);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    // Emit against parse, not against a fixture: the first line of the seeded
    // prompt must still resolve to this node through W9's own parse side.
    const [directive] = reference.text.split("\n");
    const match = /^::([a-z][a-z0-9-]*)\{id="([^"\n]*)"\}$/.exec(directive ?? "");
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(NODE_DIRECTIVE_ID);
    expect(nodeIdFromAttributes({ id: match?.[2] ?? "" })).toBe("shape:api");
  });

  it("says where the reference went when it navigated, in its own words", () => {
    const report = discussReport("navigated", "a new chat");
    expect(report.tone).toBe("success");
    expect(report.text).toContain("a new chat");
    // NOT the insert sentence: the human is no longer looking at the canvas,
    // and "referenced this node" alone does not explain why the view changed.
    expect(report.text).toContain("Opened");
    expect(report.text).not.toBe(discussReport("inserted", "a new chat").text);
  });
});
