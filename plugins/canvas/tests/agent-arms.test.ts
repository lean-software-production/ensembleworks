// Run: npx vitest run tests/agent-arms.test.ts
//
// WHICH ARMS THE AGENT AFFORDANCE OFFERS. Task 2a: the single "Run as agent"
// button becomes a two-armed menu, and the arms are not the same shape —
// launching needs prompt text so it stays notes-only, attaching needs none so
// it works on anything. That asymmetry used to be a `kind === "note"` ternary
// in agents-ui.tsx, where this project (no jsdom, deliberately) can reach it
// with nothing but a source-text guard.
import { describe, expect, it } from "vitest";
import {
  AGENT_ARM_IDS,
  agentArmsFor,
  agentTargetFor,
  type AgentArm,
} from "../canvas/agent-arms.js";

/** A `kindOf` over a plain map, the shape agents-ui.tsx's `doc.byId` lookup
 * reduces to. */
function kinds(entries: Record<string, string>) {
  return (shapeId: string): string | undefined => entries[shapeId];
}

function armById(arms: readonly AgentArm[], id: string): AgentArm {
  const arm = arms.find((candidate) => candidate.id === id);
  if (arm === undefined) throw new Error(`no ${id} arm`);
  return arm;
}

describe("agentTargetFor", () => {
  it("is the one selected shape", () => {
    expect(
      agentTargetFor({
        selection: new Set(["shape:a"]),
        kindOf: kinds({ "shape:a": "note" }),
      }),
    ).toEqual({ shapeId: "shape:a", kind: "note" });
  });

  it("offers nothing for an empty selection", () => {
    expect(
      agentTargetFor({ selection: new Set(), kindOf: kinds({}) }),
    ).toBeNull();
  });

  it("offers nothing for a multi-selection", () => {
    // A menu anchored to "the" shape has no anchor when there are two, and
    // "attach both to one thread" is not a thing the kv mirror can hold.
    expect(
      agentTargetFor({
        selection: new Set(["shape:a", "shape:b"]),
        kindOf: kinds({ "shape:a": "note", "shape:b": "note" }),
      }),
    ).toBeNull();
  });

  it("offers nothing for a shape that is not in the document", () => {
    // A create tool mid-drag has a selection before the shape lands.
    expect(
      agentTargetFor({
        selection: new Set(["shape:ghost"]),
        kindOf: kinds({}),
      }),
    ).toBeNull();
  });

  it("offers a target for a NON-note, which the old button did not", () => {
    // The whole point of 2a: attach needs no prompt, so the affordance itself
    // is no longer notes-only. Before this change the button was absent here.
    expect(
      agentTargetFor({
        selection: new Set(["shape:box"]),
        kindOf: kinds({ "shape:box": "geo" }),
      }),
    ).toEqual({ shapeId: "shape:box", kind: "geo" });
  });
});

describe("agentArmsFor", () => {
  it("offers exactly the two declared arms, launch first", () => {
    const arms = agentArmsFor({ shapeId: "shape:a", kind: "note" }, false);
    expect(arms.map((arm) => arm.id)).toEqual(["launch", "attach"]);
    expect(AGENT_ARM_IDS).toEqual(["launch", "attach"]);
  });

  it("enables launch on a note", () => {
    const arms = agentArmsFor({ shapeId: "shape:a", kind: "note" }, false);
    expect(armById(arms, "launch").enabled).toBe(true);
  });

  it("DISABLES launch on every other kind, rather than hiding it", () => {
    for (const kind of ["geo", "text", "frame", "image", "terminal"]) {
      const arms = agentArmsFor({ shapeId: "shape:a", kind }, false);
      expect(armById(arms, "launch").enabled).toBe(false);
      // Present, so a reader can see WHY it cannot be used — the same
      // disabled-not-hidden call the page tab menu already makes.
      expect(armById(arms, "launch").label.length).toBeGreaterThan(0);
    }
  });

  it("enables attach on every kind, note or not", () => {
    for (const kind of ["note", "geo", "text", "frame", "image", "terminal"]) {
      expect(armById(agentArmsFor({ shapeId: "shape:a", kind }, false), "attach").enabled).toBe(
        true,
      );
    }
  });

  it("says 'again' on the launch arm only once the shape is linked", () => {
    const fresh = armById(agentArmsFor({ shapeId: "shape:a", kind: "note" }, false), "launch");
    const linked = armById(agentArmsFor({ shapeId: "shape:a", kind: "note" }, true), "launch");
    expect(fresh.label).toBe("Run as new thread");
    expect(linked.label).toBe("Run again as new thread");
  });

  it("keeps the attach arm's label and enablement unchanged by an existing link", () => {
    // Re-attaching a linked shape is legal — `AgentLinks.record` replaces —
    // so a link must not disable or rename this arm.
    const fresh = armById(agentArmsFor({ shapeId: "shape:a", kind: "note" }, false), "attach");
    const linked = armById(agentArmsFor({ shapeId: "shape:a", kind: "note" }, true), "attach");
    expect(fresh.label).toBe("Attach to existing thread…");
    expect(linked).toEqual(fresh);
  });
});
