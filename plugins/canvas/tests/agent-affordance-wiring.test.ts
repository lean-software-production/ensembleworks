// Run: npx vitest run tests/agent-affordance-wiring.test.ts
//
// THE .tsx SEAMS OF THE LAUNCH-OR-ATTACH AFFORDANCE.
//
// canvas/agents-ui.tsx is hands: every decision it renders belongs to a pure
// module with its own unit tests (canvas/agent-arms.ts, canvas/agent-menu.ts,
// canvas/thread-picker.ts). This project has no jsdom and may not gain one, so
// the strongest honest statement left about the component is that it CALLS
// those decisions and ATTACHES them to the right elements — and, per Task 1's
// standing rule, that statement has to be made against the PARSED source, not
// against its text.
//
// WHY THE PARSER AND NOT `toContain`. tests/source-guard.test.ts records the
// walk-throughs: a guard satisfied by the file's own doc comment; a real call
// replaced by a STRING containing the same characters; a perfect handler
// DISCONNECTED from its element; a whole effect wrapped in a decoy closure so
// React never ran it; a call re-aimed at a DIFFERENT argument. Each needs a
// question about shape, which is what `jsxAttributes` / `initializerText` /
// `bodyStatements` / `topLevelEffectIn` / `effectStatements` ask.
//
// SERVER.ts IS DELIBERATELY NOT GUARDED HERE. Its half of this feature —
// probe-before-record, the verdict, the list arguments, the record-and-publish
// reuse — is driven end to end through the real plugin factory in
// tests/agents.test.ts, and a behavioural test beats a source guard every time.
// Source guards exist here only because the browser half has no such lane.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  arrowResult,
  bodyStatements,
  callArguments,
  callsTo,
  countInCode,
  effectStatements,
  handlerStatements,
  initializerText,
  jsxAttributes,
  objectLiteralText,
  rootCallee,
  stripComments,
  ternaryArms,
  topLevelEffectIn,
} from "./lib/source.js";

const UI = readFileSync(new URL("../canvas/agents-ui.tsx", import.meta.url), "utf8");
const PANEL =
  readFileSync(new URL("../canvas/panel/session-view.tsx", import.meta.url), "utf8") +
  readFileSync(new URL("../canvas/panel/agent-sync.tsx", import.meta.url), "utf8");
const SESSION = readFileSync(new URL("../canvas/panel/session.tsx", import.meta.url), "utf8");

describe("AgentLayer picks its target from the pure rule", () => {
  it("asks agentTargetFor, over the live selection and the document's kinds", () => {
    expect(initializerText(UI, "target")).toBe(
      "agentTargetFor({\n    selection,\n    kindOf: (shapeId) => doc.byId.get(shapeId)?.kind,\n  })",
    );
  });

  it("projects that target's own shape, not some other id, on THIS page", () => {
    expect(initializerText(UI, "targetBox")).toBe(
      "target === null\n      ? null\n      : screenBoxFor(doc, camera, viewportSize, target.shapeId, currentPageId)",
    );
  });

  it("no longer gates the affordance on the shape being a note", () => {
    // THE WHOLE POINT OF 2a. The old inline `kind === "note"` ternary hid the
    // button on every non-note; attach needs no prompt, so the kind gate moved
    // into `agentArmsFor` and applies to the LAUNCH arm alone. If this string
    // is back in the component, the widening has been undone.
    expect(countInCode(UI, 'kind === "note"')).toBe(0);
    // ...and the single-purpose button it used to mark is gone with it.
    expect(countInCode(UI, "data-canvas-run-note")).toBe(0);
  });

  it("hands the affordance the target, its box, and both attach ports", () => {
    // A handler that is perfect but not ATTACHED is the mutation this asks
    // about; a file-wide `toContain` cannot tell the difference.
    const attrs = jsxAttributes(UI, "loadThreadOptions");
    expect(attrs.target).toBe("target");
    expect(attrs.box).toBe("targetBox");
    expect(attrs.linked).toBe("links[target.shapeId] !== undefined");
    expect(attrs.pendingShapeId).toBe("pendingShapeId");
    expect(attrs.onRun).toBe("onRun");
    expect(attrs.onAttach).toBe("onAttach");
    expect(attrs.loadThreadOptions).toBe("loadThreadOptions");
  });
});

describe("the overlay is scoped to the page on screen", () => {
  // OWNER REPORT, 2026-09-08: "if you switch tabs you can still see the dot
  // (even though you can't see the note it is attached to)". The rule itself is
  // canvas/agents-view.ts's (`pageIdOf` vs `currentPageId`, unit-tested there);
  // what a source guard can still say is that the component ASKS it, with the
  // page it was handed rather than a constant.
  it("projects a badge's note against the current page", () => {
    expect(initializerText(UI, "box")).toBe(
      "screenBoxFor(doc, camera, viewportSize, link.shapeId, currentPageId)",
    );
  });

  it("takes the page as a prop instead of deciding one", () => {
    // A component that read `doc.pages[0]` or hardcoded a page id would satisfy
    // the call-shape guard above and still draw every page's badges on page 1.
    expect(UI).toMatch(/^ {2}readonly currentPageId: string;$/m);
    expect(UI).toMatch(/^ {2}currentPageId,$/m);
  });

  it("drops a badge whose dot would paint outside the drawing surface", () => {
    // The second half of the same report — "the dot floats above the canvas
    // tabs". Bounded to the guard clause, un-negated: a stray `!` here would
    // draw ONLY the dots that overhang, and agents-view.ts's own unit tests
    // would stay green.
    expect(UI).toMatch(
      /^ {8}if \(!badgeAnchorVisible\(box, viewportSize\)\) return null;$/m,
    );
    expect(countInCode(UI, "badgeAnchorVisible(")).toBe(1);
  });
});

describe("Open thread goes to bb's own thread surface", () => {
  // OWNER REQUEST, 2026-09-08: "When we choose to 'open thread' it opens the
  // thread in the sidebar rather than in the main thread window. remove the
  // 'fake' thread opening in the sidebar of the canvas."
  it("has no in-canvas thread panel left to open into", () => {
    for (const gone of ["ThreadAside", "ThreadChat", "useThreadPanel", "THREAD_PANEL_WIDTH"]) {
      expect(countInCode(UI, gone)).toBe(0);
      expect(countInCode(PANEL, gone)).toBe(0);
    }
    // The badge's "is my thread the open one?" highlight went with the panel —
    // there is no such thing as an open thread inside the canvas any more.
    expect(countInCode(UI, "openThreadId")).toBe(0);
    expect(countInCode(PANEL, "threadPanel")).toBe(0);
  });

  it("hands the badge's open port straight to bb's navigator", () => {
    // ATTACHED, not merely present: `navigate.toThread` somewhere in the file
    // is satisfied by a call nothing reaches. This pins it to the prop the
    // menu item calls.
    // Marked by `onUnlink`, which only <AgentLayer> has — `loadThreadOptions`
    // is also on <CanvasSession> one level up.
    expect(jsxAttributes(SESSION, "onUnlink").onOpen).toBe(
      "(threadId) => navigate.toThread(threadId)",
    );
  });

  it("hands the layer the page it must scope to", () => {
    expect(jsxAttributes(PANEL, "onUnlink").currentPageId).toBe(
      "editorState.currentPageId",
    );
  });
});

describe("the affordance renders the pure decisions", () => {
  it("builds its arms with agentArmsFor, over the target and its link state", () => {
    expect(initializerText(UI, "arms")).toBe("agentArmsFor(target, linked)");
  });

  it("filters the picker's rows with filterThreadOptions", () => {
    // `options ?? []` and not `options`: null is "still loading", a state the
    // filter has no opinion about.
    expect(initializerText(UI, "visibleRows")).toBe(
      "filterThreadOptions(options ?? [], query)",
    );
  });

  it("asks the pure rules whether a row may be chosen and what it says", () => {
    expect(initializerText(UI, "selectable")).toBe(
      "threadOptionSelectable(option, target.shapeId)",
    );
    expect(initializerText(UI, "note")).toBe("threadOptionNote(option, target.shapeId)");
  });

  it("re-checks selectability before calling out, in that order", () => {
    // The guard is the FIRST statement the function runs — a decoy closure can
    // put that line anywhere, but it cannot put it back in the list of
    // statements `attach` executes, in the order it executes them.
    expect(bodyStatements(UI, "attach")).toEqual([
      "if (!threadOptionSelectable(option, target.shapeId)) return;",
      'dispatch({ type: "attached" });',
      "onAttach(target.shapeId, option.threadId);",
    ]);
  });
});

describe("the affordance's elements carry the handlers", () => {
  it("toggles the menu from its own button", () => {
    const attrs = jsxAttributes(UI, "data-canvas-agent-affordance");
    expect(attrs.onClick).toBe('() => dispatch({ type: "button-click" })');
    expect(attrs["aria-expanded"]).toBe('state !== "closed"');
    expect(attrs.disabled).toBe("pendingShapeId !== null");
    expect(attrs["data-canvas-agent-affordance"]).toBe("target.shapeId");
  });

  it("routes an arm click through the machine AND runs the launch arm", () => {
    const attrs = jsxAttributes(UI, "data-canvas-agent-arm");
    // Both halves, in one attribute, AS THE STATEMENTS THE HANDLER RUNS — not
    // as substrings of it. `toContain` here was defeated on 2026-09-07 by the
    // decoy tests/lib/source.ts records: `onClick={() => { const act = ():
    // void => { dispatch({ type: "arm", id: arm.id }); if (arm.id ===
    // "launch") onRun(target.shapeId); }; void act; }}` contains both strings
    // verbatim, and clicking "Run as new thread" does nothing at all — no
    // spawn, and the menu does not even close.
    expect(handlerStatements(attrs.onClick ?? "")).toEqual([
      'dispatch({ type: "arm", id: arm.id });',
      'if (arm.id === "launch") onRun(target.shapeId);',
    ]);
    expect(attrs.disabled).toBe("!arm.enabled");
  });

  it("wires a thread row to attach, and disables it from the pure rule", () => {
    const attrs = jsxAttributes(UI, "data-canvas-thread-option");
    expect(attrs.onClick).toBe("() => attach(option)");
    expect(attrs.disabled).toBe("!selectable");
    expect(attrs["data-canvas-thread-option"]).toBe("option.threadId");
  });

  it("gives the filter box Enter-to-attach against the FILTERED rows", () => {
    const attrs = jsxAttributes(UI, "data-canvas-thread-filter");
    expect(attrs.onChange).toBe("(event) => setQuery(event.target.value)");
    // `visibleRows`, not `options`: Enter must take what the user narrowed to.
    // Listed as STATEMENTS, in order, for the same reason as the arm above —
    // the identical decoy closure satisfies a `toContain` on this attribute
    // while Enter in the filter box does nothing.
    expect(handlerStatements(attrs.onKeyDown ?? "")).toEqual([
      'if (event.key !== "Enter") return;',
      "const top = threadPickerEnterTarget(visibleRows);",
      "if (top !== null) attach(top);",
    ]);
  });
});

describe("the affordance's effects are effects React actually runs", () => {
  it("closes the menu when the selection moves to another shape", () => {
    const effect = topLevelEffectIn(UI, "AgentAffordance", "target-changed");
    expect(effectStatements(effect)).toEqual(['dispatch({ type: "target-changed" });']);
    // Re-run on the SHAPE, not on every render.
    expect(effect).toContain("[dispatch, target.shapeId]");
  });

  it("registers BOTH dismissal listeners inside the dismissal effect", () => {
    // The exact mutation tests/lib/source.ts records: both listeners moved into
    // `const register = () => {…}; void register;` inside the surviving effect,
    // leaving `callsTo` true and the menu registering nothing.
    const effect = topLevelEffectIn(UI, "AgentAffordance", 'addEventListener("pointerdown"');
    const statements = effectStatements(effect);
    expect(statements).toContain(
      'document.addEventListener("pointerdown", onPointerDown, true);',
    );
    expect(statements).toContain('document.addEventListener("keydown", onKeyDown);');
    // Capture phase, so a press is seen before the canvas begins a gesture.
    expect(effect).toContain('removeEventListener("pointerdown", onPointerDown, true)');
  });

  it("fetches the picker's offer from the injected port when it opens", () => {
    const effect = topLevelEffectIn(UI, "AgentAffordance", "loadThreadOptions()");
    const statements = effectStatements(effect);
    expect(statements[0]).toBe('if (state !== "picker") return;');
    // A late answer must not write into a picker that has closed or moved.
    expect(statements).toContain("let cancelled = false;");
    // THE FETCH IS A STATEMENT THE EFFECT RUNS. Not reported by the validator,
    // but the identical hole to the panel's `attachThread` seam: wrapping this
    // one statement in `void (() => { … })` keeps the `toContain` below true
    // and the picker never asks for anything. Pinned the same way, so the two
    // ends of one rpc are not guarded to two different standards.
    const fetch = statements.find((statement) => statement.startsWith("loadThreadOptions("));
    expect(fetch).toBeDefined();
    expect(rootCallee(fetch ?? "")).toBe("loadThreadOptions");
    expect(effect).toContain("if (!cancelled) setOptions(loaded);");
  });

  it("places the picker with the shared clamp, anchored to its own button", () => {
    const effect = topLevelEffectIn(UI, "AgentAffordance", "placePopoverBox");
    // IT PLACES THE BOX WHEN IT OPENS, and re-places it on resize and scroll.
    // Every assertion below is about the ARGUMENTS of a call, so deleting just
    // `place();` — leaving `const place = …` and both registrations intact —
    // left them all green while the picker opened pinned at
    // POPOVER_EDGE_MARGIN_PX in the window's top-left corner until the user
    // happened to resize or scroll (2026-09-07). Only the statement list the
    // effect runs fails on that.
    const statements = effectStatements(effect);
    expect(statements[0]).toBe('if (state !== "picker") return;');
    expect(statements).toContain("place();");
    expect(statements).toContain('window.addEventListener("resize", place);');
    expect(statements).toContain('window.addEventListener("scroll", place, true);');
    // ANCHORED TO THE BUTTON. The recorded mutation here is a call re-aimed at
    // a different argument, which puts every open in the corner.
    const anchors = callsTo(effect, "anchorOf");
    expect(anchors.map((call) => call.text)).toEqual(["anchorOf(buttonRef.current)"]);
    const args = callArguments(stripComments(effect), "placePopoverBox");
    expect(args).toContain("...anchorOf(buttonRef.current)");
    expect(args).toContain("popoverWidth: popover.width");
    expect(args).toContain("popoverHeight: popover.height");
    expect(args).toContain("viewportWidth: window.innerWidth");
    expect(args).toContain("viewportHeight: window.innerHeight");
    // ...and nothing overrides the spread afterwards, which is the other
    // recorded mutation (`anchorLeft: 0, anchorRight: 0, …` after a correct
    // spread — `PopoverAnchor` is exactly those four).
    for (const key of ["anchorLeft", "anchorRight", "anchorTop", "anchorBottom"]) {
      expect(args).not.toContain(`${key}:`);
    }
    // Re-placed as the list's height changes under the filter.
    expect(effect).toContain("[state, options, query]");
  });
});

describe("the picker is a portal on the shared layer, with no clamp of its own", () => {
  it("IS the <body> portal on the open arm, not merely a mention of one", () => {
    // The recorded "built node NEVER RENDERED" mutation, aimed one level up
    // from the guard below it: wrapping the false arm in an un-invoked IIFE —
    // `((): ReactNode => { const built = createPortal(…); void built; return
    // null; })()` — leaves `picker` permanently null, so clicking "Attach to
    // existing thread…" opens nothing, while every `toContain` on the
    // initializer text stays true (2026-09-07, suite 1183/1183, tsc 0).
    // Splitting the ternary lets the guard say the open arm IS the portal call.
    const { condition, whenTrue, whenFalse } = ternaryArms(UI, "picker");
    expect(condition).toBe('state !== "picker"');
    expect(whenTrue).toBe("null");
    const portals = callsTo(whenFalse, "createPortal");
    expect(portals).toHaveLength(1);
    expect(portals[0]?.text).toBe(whenFalse);
    expect(whenFalse).toContain("document.body");
  });

  it("is actually RENDERED, not merely built", () => {
    // `{false ? picker : null}` keeps every other guard in this file green.
    const statements = bodyStatements(UI, "AgentAffordance");
    const returned = statements.at(-1) ?? "";
    expect(returned.startsWith("return (")).toBe(true);
    expect(returned).toContain("{picker}");
    expect(returned).toContain("{arms.map(");
  });

  it("positions the portalled box from the computed rect", () => {
    expect(jsxAttributes(UI, "data-canvas-thread-picker").style).toBe(
      "{ ...pickerStyle, left: pickerBox.left, top: pickerBox.top }",
    );
  });

  it("writes no second clamp of its own", () => {
    // "Reuse placePopoverBox — do not write a second clamp." Two clamps drift,
    // which is the argument canvas/dock/popover-place.ts's header makes at
    // length about `placePopover` being CALLED by `placePopoverBox` rather
    // than copied into it.
    expect(callsTo(UI, "placePopoverBox")).toHaveLength(1);
    expect(countInCode(UI, "Math.min")).toBe(0);
    expect(countInCode(UI, "Math.max")).toBe(0);
  });

  it("paints on the shared popover layer, by name and not by number", () => {
    const style = objectLiteralText(UI, "pickerStyle");
    expect(style).toContain("zIndex: POPOVER_Z_INDEX");
    // An inline number here would silently reverse the argument
    // popover-place.ts makes for 45 — the page popover arrived carrying
    // 2147483000 and did exactly that.
    expect(style).not.toMatch(/zIndex:\s*\d/);
  });

  it("takes its colours from the chrome palette, never a literal", () => {
    // The plugin styling rule: never read bb's CSS variables, and never invent
    // a colour beside the one palette (canvas/pages/chrome-dock.ts). A
    // <body>-portalled box is outside this plugin's class scope, so inline
    // styles are the only option and the palette is the only source.
    const style = objectLiteralText(UI, "pickerStyle");
    expect(style).not.toMatch(/#[0-9a-fA-F]{3}/);
    expect(style).not.toContain("rgba(");
    expect(style).toContain("CHROME_PAPER");
    expect(style).toContain("CHROME_INK");
  });
});

describe("the panel is the affordance's only route to the backend", () => {
  it("attaches through canvas_attach_thread and records the answer", () => {
    const statements = bodyStatements(PANEL, "attachThread");
    expect(statements).toHaveLength(1);
    const [call] = statements as [string];
    // THAT ONE STATEMENT IS THE RPC ITSELF. `void ((): void => { <this
    // statement> });` keeps the list at length one and keeps every substring
    // below true, and no call is ever issued: the user picks a thread, no
    // badge appears, no toast fires, suite green (2026-09-07). Asking what the
    // statement's own expression IS fails on it immediately.
    expect(rootCallee(call)).toBe("rpcRef.current.call");
    expect(call).toContain('.call("canvas_attach_thread", { shapeId, threadId })');
    // NOT optimistic: the badge lands only on the backend's own answer,
    // because an attach can be refused (archived / other project / other
    // shape) and a badge painted ahead of the verdict would be a lie on
    // exactly the paths where the answer is no.
    expect(call).toContain("setAgentLinks((previous) => ({ ...previous, [link.shapeId]: link }))");
    expect(call).toContain("toast.error(");
  });

  it("fetches the picker's offer through canvas_thread_options", () => {
    // WHAT THE CALLBACK RETURNS, not what its text mentions. Giving it a block
    // body that computes the real chain into a dead local and returns
    // `Promise.resolve([])` instead satisfies both `toContain`s below, and the
    // picker then says "No threads in this project yet." forever because the
    // rpc is never issued (2026-09-07, suite 1183/1183, tsc 0).
    const returned = arrowResult(initializerText(PANEL, "loadThreadOptions"));
    expect(rootCallee(returned)).toBe("rpcRef.current.call");
    expect(returned).toContain('.call("canvas_thread_options", null)');
    expect(returned).toContain("result.options");
  });

  it("hands both ports down to the layer", () => {
    const attrs = jsxAttributes(SESSION, "onAttach");
    expect(attrs.onAttach).toBe("onAttachThread");
    expect(attrs.loadThreadOptions).toBe("loadThreadOptions");
    // ...and the launch arm's own port is untouched by the widening.
    expect(attrs.onRun).toBe("handleRunNote");
  });
});
