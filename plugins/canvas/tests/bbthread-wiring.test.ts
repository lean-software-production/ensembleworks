// Run: npx vitest run tests/bbthread-wiring.test.ts
//
// This project has no jsdom, so the shape body itself (canvas/shapes/
// BbThreadShape.tsx) cannot be mounted — see tests/lib/source.ts's own
// header for why every guard here reads the PARSED source instead. The
// strongest honest statement this suite can make is that the body CALLS the
// pure decisions in bbthread-model.ts (bbthread-model.test.ts unit-tests
// those directly) rather than re-deciding inline, and that connection-boot
// actually registers the 'bbthread' kind — mirrors the deleted
// tests/agent-affordance-wiring.test.ts's house style (see
// `git show dc70212^:plugins/canvas/tests/agent-affordance-wiring.test.ts`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodyStatements, callsTo, countInCode, initializerText, ternaryArms } from "./lib/source.js";

const SHAPE = readFileSync(new URL("../canvas/shapes/BbThreadShape.tsx", import.meta.url), "utf8");
const BOOT = readFileSync(new URL("../canvas/panel/connection-boot.ts", import.meta.url), "utf8");

describe("BbThreadShape renders the pure decisions, not inline logic", () => {
  it("computes the pane state with bbthreadPaneState, not a reimplemented rule", () => {
    expect(initializerText(SHAPE, "pane")).toBe("bbthreadPaneState(shape, thread, sidebar.status)");
  });

  it("computes every rect with paneLayout, not hand-derived geometry", () => {
    expect(initializerText(SHAPE, "layout")).toBe("paneLayout(shape)");
    // No fraction/height literal re-deriving what bbthread-model.ts already
    // owns (BBTHREAD_PANE_FRACTION, FRAME_HEADER_HEIGHT) — a decoy that kept
    // calling paneLayout() but ALSO hand-rolled its own split would satisfy
    // the assertion above while silently drifting from it.
    expect(countInCode(SHAPE, "1 / 3")).toBe(0);
  });

  it("decides pane interactivity/hint with paneInteraction, not a reimplemented rule", () => {
    expect(initializerText(SHAPE, "interaction")).toBe(
      "paneInteraction(shape, pane, { editingId: editorState.editingId, editingRegion: editorState.editingRegion })",
    );
  });

  it("sets data-canvas-interactive on the pane conditionally, never unconditionally", () => {
    const arms = ternaryArms(SHAPE, "interactiveAttrs");
    expect(arms.condition).toBe("interaction.interactive");
    expect(arms.whenTrue.replace(/\s+/g, "")).toBe('{"data-canvas-interactive":""}');
    expect(arms.whenFalse.replace(/\s+/g, "")).toBe("{}");
    // The pane element must actually spread this computed value — a decoy
    // that kept `interactiveAttrs` perfectly conditional but never attached
    // it to any element would satisfy the assertions above while leaving
    // the pane permanently non-interactive to the viewport.
    expect(countInCode(SHAPE, "{...interactiveAttrs}")).toBe(1);
  });

  it("no longer swallows events itself — no shouldSwallowEvents/stopPropagation left in the body", () => {
    expect(countInCode(SHAPE, "shouldSwallowEvents")).toBe(0);
    expect(countInCode(SHAPE, "stopPropagation")).toBe(0);
    expect(countInCode(SHAPE, "reduceInteractionMode")).toBe(0);
    expect(countInCode(SHAPE, "useBbThreadInteraction")).toBe(0);
    expect(countInCode(SHAPE, "onDoubleClick")).toBe(0);
  });

  it("the memo comparator reads editorState.editingId and editingRegion, not just shape content", () => {
    const statements = bodyStatements(SHAPE, "bbthreadPropsEqual");
    const ret = statements.at(-1) ?? "";
    expect(ret.startsWith("return")).toBe(true);
    expect(ret).toContain("a.editorState.editingId === b.editorState.editingId");
    expect(ret).toContain("a.editorState.editingRegion === b.editorState.editingRegion");
  });

  it("seeds the spawn prompt with spawnPromptFor over the frame's own children", () => {
    const calls = callsTo(SHAPE, "spawnPromptFor");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("childrenOf(snapshot, shape.id)");
  });
});

describe("connection-boot registers the plugin-only 'bbthread' kind", () => {
  it("calls registerShape('bbthread', BbThreadShape) inside boot(), after the core shapes", () => {
    const statements = bodyStatements(BOOT, "boot");
    const coreIndex = statements.indexOf("registerCoreShapes();");
    const bbthreadIndex = statements.indexOf('registerShape("bbthread", BbThreadShape);');
    expect(coreIndex).toBeGreaterThanOrEqual(0);
    expect(bbthreadIndex).toBeGreaterThan(coreIndex);
  });

  it("imports BbThreadShape and registerShape from the right modules", () => {
    expect(BOOT).toContain('import { registerCoreShapes, registerShape } from "@ensembleworks/canvas-react";');
    expect(BOOT).toContain('import { BbThreadShape } from "../shapes/BbThreadShape.js";');
  });
});
