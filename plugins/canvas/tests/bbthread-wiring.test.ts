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
import {
  bodyStatements,
  callsTo,
  countInCode,
  effectStatements,
  initializerText,
  jsxAttributes,
  jsxElementRange,
  ternaryArms,
  topLevelEffectIn,
} from "./lib/source.js";

const SHAPE = readFileSync(new URL("../canvas/shapes/BbThreadShape.tsx", import.meta.url), "utf8");
const BOOT = readFileSync(new URL("../canvas/panel/connection-boot.ts", import.meta.url), "utf8");
const FOLLOW = readFileSync(new URL("../canvas/shapes/bbthread-follow.ts", import.meta.url), "utf8");

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

describe("the pane's ThreadChat gains the composer while focused (2026-09-15 trial)", () => {
  it("picks the ThreadChat variant with a ternary on interaction.interactive, compact/timeline", () => {
    const arms = ternaryArms(SHAPE, "chatVariant");
    expect(arms.condition).toBe("interaction.interactive");
    expect(arms.whenTrue).toBe('"compact"');
    expect(arms.whenFalse).toBe('"timeline"');
  });

  it("passes both chatVariant and a focusRequest counter to the ThreadChat element", () => {
    const attrs = jsxAttributes(SHAPE, "className");
    expect(attrs.variant).toBe("chatVariant");
    expect(attrs.focusRequest).toBe("focusRequest");
  });

  it("bumps focusRequest from a useEffect keyed on interaction.interactive, not unconditionally", () => {
    const effect = topLevelEffectIn(SHAPE, "BbThreadShapeInner", "setFocusRequest");
    expect(effect).toContain("[interaction.interactive]");
    const statements = effectStatements(effect);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("if (interaction.interactive)");
    expect(statements[0]).toContain("setFocusRequest((n) => n + 1)");
  });
});

describe("the resize divider is a sibling of the pane, forwarded to the canvas", () => {
  it("renders the divider OUTSIDE the pane div, after it in DOM order", () => {
    const pane = jsxElementRange(SHAPE, 'data-canvas-bbthread="pane"');
    const divider = jsxElementRange(SHAPE, 'data-canvas-bbthread="divider"');
    // Not nested: a divider inside the pane's own range would never be
    // reachable while the pane carries `data-canvas-interactive` (the
    // viewport yield rule swallows events aimed at anything inside it).
    const nestedInPane = divider.start >= pane.start && divider.end <= pane.end;
    expect(nestedInPane).toBe(false);
    // After, not before: painted on top of the pane's own borderLeft.
    expect(divider.start).toBeGreaterThan(pane.end);
  });

  it("the divider has no pointer handlers and is never marked interactive", () => {
    const range = jsxElementRange(SHAPE, 'data-canvas-bbthread="divider"');
    const text = SHAPE.slice(range.start, range.end);
    expect(text).not.toContain("onPointerDown");
    expect(text).not.toContain("data-canvas-interactive");
    // It still needs to look draggable and sit where paneLayout says.
    expect(text).toContain("ew-resize");
    expect(text).toContain("layout.divider");
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

describe("autoscroll while idle (2026-09-16 follow-up)", () => {
  it("calls useFollowLatest with !interaction.interactive as the enabled flag", () => {
    const calls = callsTo(SHAPE, "useFollowLatest");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("useFollowLatest(chatRootRef, !interaction.interactive)");
  });

  it('wraps ThreadChat in a data-canvas-bbthread="chat" div carrying the chat root ref, nested inside the pane but distinct from it', () => {
    const chat = jsxElementRange(SHAPE, 'data-canvas-bbthread="chat"');
    const pane = jsxElementRange(SHAPE, 'data-canvas-bbthread="pane"');
    const text = SHAPE.slice(chat.start, chat.end);
    expect(chat.start).toBeGreaterThan(pane.start);
    expect(chat.end).toBeLessThan(pane.end);
    expect(text).toContain("ref={setChatRootEl}");
    expect(text).toContain("<ThreadChat");
    expect(text).toContain("flex: 1");
    expect(text).toContain("minHeight: 0");
    expect(text).toContain('flexDirection: "column"');
  });

  it("never wraps the unbound picker or the gone/loading messages — only a bound ThreadChat is followed", () => {
    const chat = jsxElementRange(SHAPE, 'data-canvas-bbthread="chat"');
    const text = SHAPE.slice(chat.start, chat.end);
    expect(text).not.toContain("UnboundPicker");
    expect(text).not.toContain("archived or no longer available");
    expect(text).not.toContain("Loading…");
  });

  it("re-derives chatRootRef with useMemo keyed on chatRootEl, not a plain useRef", () => {
    // A plain `useRef` would freeze `rootRef.current` at whatever it was when
    // `useFollowLatest`'s effect first ran — missing the "bound" wrapper div
    // mounting later than this component's own first render (RED, recorded
    // in the task report: with `const chatRootRef = useRef<...>(null)` swapped
    // in, a thread that finishes loading in view mode never starts following).
    expect(initializerText(SHAPE, "chatRootRef")).toBe("useMemo(() => ({ current: chatRootEl }), [chatRootEl])");
  });
});

describe("useFollowLatest (bbthread-follow.ts) disconnects everything it observes", () => {
  it("bails out before touching the DOM when disabled", () => {
    const effect = topLevelEffectIn(FOLLOW, "useFollowLatest", "MutationObserver");
    const statements = effectStatements(effect);
    expect(statements[0]).toBe("if (!enabled) return;");
  });

  it("returns a cleanup that disconnects both observers and cancels the pending frame", () => {
    const effect = topLevelEffectIn(FOLLOW, "useFollowLatest", "MutationObserver");
    const statements = effectStatements(effect);
    const cleanup = statements.at(-1) ?? "";
    expect(cleanup.startsWith("return")).toBe(true);
    expect(cleanup).toContain("mutationObserver.disconnect()");
    expect(cleanup).toContain("resizeObserver?.disconnect()");
    expect(cleanup).toContain("cancelAnimationFrame(frame)");
  });

  it("observes childList, subtree and characterData on the mutation observer", () => {
    expect(countInCode(FOLLOW, "childList: true, subtree: true, characterData: true")).toBe(1);
  });
});
