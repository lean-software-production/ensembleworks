// bb-plugin-canvas — the BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
// loro-crdt's wasm, by contrast, IS bundled — canvas-doc imports the
// `loro-crdt/base64` build, which inlines its wasm as a JS string.
//
// This file is deliberately just the registration; the whole canvas lives in
// canvas/CanvasPanel.tsx.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { CanvasPanel } from "./canvas/CanvasPanel.js";
import { decidePageCommandAvailable, pageDoor } from "./canvas/pages/page-door.js";
import { CANVAS_PANEL_PATH } from "./canvas/pages/page-route.js";
import { TranscriptView } from "./canvas/transcript-ui.js";
import { CanvasReturnAction } from "./canvas/thread-return-ui.js";

/** The `threadPanelAction` id, referenced by the palette row that opens it. */
const TRANSCRIPT_ACTION = "transcript";

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "back-to-canvas",
    title: "Back to canvas",
    component: CanvasReturnAction,
  });
  app.slots.navPanel({
    id: "canvas",
    title: "Canvas",
    icon: "PenTool",
    // Routed at /plugins/canvas/canvas. BB renders the title bar itself and
    // gives the component the full-bleed body below it with zero padding —
    // which is exactly what a canvas wants, so CanvasPanel fills it edge to
    // edge and owns its own chrome.
    //
    // THE CONSTANT, not the literal, because the plugin navigates BACK to this
    // path to put the current page in the URL — canvas/pages/page-route.ts's
    // `reconcilePageRoute` calls `toPluginPanel(CANVAS_PANEL_PATH, { subPath,
    // replace })` (design doc D-3). A navigation to a path with no panel
    // registered at it goes nowhere and says nothing, so the registration and
    // the navigation are pinned to one string.
    path: CANVAS_PANEL_PATH,
    component: CanvasPanel,
  });

  // The room transcript: three registrations and four doors, ONE component.
  //
  // It is deliberately not a tab on the canvas page: what the room said out
  // loud is context for whatever you are doing in bb, and the place you most
  // want it is beside the thread you are briefing — next to Terminal, in the
  // right panel, on any thread.
  //
  // "flush": the view owns its own scrolling (it has a pinned live tail) and
  // its own footer (the search box), which the host's padded scroll container
  // would fight.
  app.slots.threadPanelAction({
    id: TRANSCRIPT_ACTION,
    title: "Room transcript",
    icon: "MessageCircle",
    layout: "flush",
    component: TranscriptView,
  });

  // The New-thread screen has its own panel launcher and none of the thread
  // one's registrations, so the same action is declared again for it. This is
  // the surface where the transcript earns the most: writing the prompt for a
  // brand-new agent while reading what the room just decided.
  app.slots.experimental_newThreadPanelAction({
    id: TRANSCRIPT_ACTION,
    title: "Room transcript",
    icon: "MessageCircle",
    layout: "flush",
    component: TranscriptView,
  });

  app.slots.commandPaletteAction({
    id: "open-transcript",
    // Self-identifying: the palette matches the query against this title, and
    // it sits among every core bb command.
    title: "Canvas: open room transcript",
    // The palette opens anywhere — over Settings, over a plugin page — and
    // `openPanel` only has somewhere to go on the main thread view. Hiding the
    // row where it would decline beats offering a command that does nothing.
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({ actionId: TRANSCRIPT_ACTION, title: "Room transcript" });
    },
  });

  // Pages, from anywhere: the zero-pixel surface of the three the design doc's
  // D-2 asks for. It cannot BE the page list — `commandPaletteAction` is one
  // static row registered here, with no way to enumerate rows per page and no
  // navigate in its context — so it is a door onto the list the canvas panel
  // draws, opened with its filter focused. canvas/pages/page-door.ts holds the
  // seam and the reasoning.
  app.slots.commandPaletteAction({
    id: "go-to-page",
    // The ellipsis is the promise the row keeps: it opens a picker rather than
    // going straight somewhere.
    title: "Canvas: go to page…",
    // The same idiom as the transcript row above: the list lives in the canvas
    // panel, so off the canvas route there is nothing to open. Hiding the row
    // beats offering a command that does nothing.
    isAvailable: () => decidePageCommandAvailable({ hasDoor: pageDoor.hasOpener() }),
    run: () => {
      const outcome = pageDoor.open();
      // Reachable despite `isAvailable`: `run` executes after the palette
      // closes, so a route change in between leaves nobody to ask. Say so
      // rather than looking like a command that did nothing.
      if (outcome.kind === "no-door") toast.message(outcome.status);
    },
  });

});
