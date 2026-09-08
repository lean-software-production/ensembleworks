import { detachVideo } from "../av-room.js";
import { canvasBus } from "../panel-bus.js";
import {
  buildDockModel,
  describeRoom,
  locateEveryone,
  mergeRoster,
  overflowLabel,
  resolveSelfName,
  whereChoiceOf,
  type DockModel,
  type DockModelInput,
  type WhereChoice,
} from "./model.js";
import { EMPTY_MODEL, renderBubbles, type BubbleNode } from "./dom-render.js";
import { EXPANDED_AT_LOAD, nextExpanded, type ExpandEvent } from "./expand.js";
import {
  decideDoorVisible,
  decideTranscriptClick,
  transcriptDoor,
} from "./transcript-door.js";
import type { DockDom } from "./dom.js";
import type { DockRepaint } from "./repaint.js";
import type { DockRoute } from "./route.js";
import type { DockRows } from "./rows.js";
import { maxBubblesFor, type SqueezeTier } from "./squeeze.js";

// The view is the imperative renderer for the always-mounted content script.
// It receives every mutable service through a typed port and does not create
// document-wide listeners or timers. Model construction, node reconciliation,
// control painting, and final geometry placement stay in one visible order.
//
// Two models come from one roster snapshot. The strip is constrained by the
// header squeeze tier, while the popover retains the full room. A bare strip
// can therefore show no faces while still describing a non-empty room.
// `renderBubbles` owns node identity and LiveKit video attachment; the view
// supplies its two maps and gives the folded popover an empty model.
//
// Status is written to both root and popover because the popover is a body
// child. A non-empty status forces expansion through the existing state machine
// and the final render is retained on both changed and unchanged transitions.
// The transcript control remains a relay to transcript-door.ts, whose outcome
// decides whether the status is visible and whether the popover folds.
export interface DockViewOptions {
  readonly dom: DockDom;
  readonly route: DockRoute;
  readonly rows: DockRows;
  readonly selfIdentity: () => string | null;
  readonly squeeze: () => SqueezeTier;
  readonly repaint: DockRepaint;
  readonly placePopover: () => void;
}

export interface DockView {
  readonly render: () => void;
  readonly apply: (event: ExpandEvent) => void;
  readonly setStatus: (text: string) => void;
  readonly disposeBubbles: () => void;
}

interface DockModels {
  readonly strip: DockModel;
  readonly popover: DockModel;
}

interface DockBubbleRenderOptions {
  readonly video: boolean;
  readonly pan: boolean;
  readonly jump: boolean;
  readonly here: ReturnType<DockRoute["current"]>;
}

interface DockViewState {
  readonly options: DockViewOptions;
  expanded: boolean;
  whereChoice: WhereChoice;
  readonly stripNodes: Map<string, BubbleNode>;
  readonly popoverNodes: Map<string, BubbleNode>;
}

export function createDockView(options: DockViewOptions): DockView {
  const state: DockViewState = {
    options,
    expanded: EXPANDED_AT_LOAD,
    whereChoice: new Map(),
    stripNodes: new Map(),
    popoverNodes: new Map(),
  };
  return {
    render: () => renderDock(state),
    apply: (event) => applyDockEvent(state, event),
    setStatus: (text) => setDockStatus(state, text),
    disposeBubbles: () => disposeDockBubbles(state),
  };
}

function currentModels(state: DockViewState): DockModels {
  const snapshot = canvasBus.snapshot();
  const roster = snapshot.roster;
  const av = snapshot.av;
  const polledRoster = state.options.route.roster();
  const merged = mergeRoster(roster, polledRoster);
  const where = locateEveryone(merged, state.whereChoice);
  state.whereChoice = whereChoiceOf(where);
  const speaking = state.options.repaint.current();
  const selfName = resolveSelfName(
    roster,
    av.self,
    state.options.selfIdentity(),
  );
  const room: DockModelInput = {
    roster: merged,
    where,
    speaking,
    video: av.video,
    selfName,
  };
  const stripLimit = maxBubblesFor(state.options.squeeze());
  const strip = buildDockModel({
    ...room,
    limit: stripLimit,
  });
  const popover = buildDockModel(room);
  return {
    strip,
    popover,
  };
}

function setDockStatus(state: DockViewState, text: string): void {
  const statusElement = state.options.dom.status;
  const rootElement = state.options.dom.root;
  const popoverElement = state.options.dom.popover;
  statusElement.textContent = text;
  const shown = text === "" ? "" : "shown";
  rootElement.dataset.dockStatus = shown;
  popoverElement.dataset.dockStatus = shown;
  applyDockEvent(state, {
    type: "status",
    text,
  });
  renderDock(state);
}

function applyDockEvent(state: DockViewState, event: ExpandEvent): void {
  const next = nextExpanded(state.expanded, event);
  if (next === state.expanded) return;
  state.expanded = next;
  renderDock(state);
}

function renderDock(state: DockViewState): void {
  const snapshot = canvasBus.snapshot();
  const av = snapshot.av;
  const models = currentModels(state);
  const dom = state.options.dom;
  const expandedAttribute = state.expanded ? "true" : "false";
  const micAttribute = av.muted ? "muted" : "live";
  const title = state.expanded
    ? "Hide the room controls"
    : `Canvas room — ${describeRoom(models.strip)}`;
  paintDockSurface(
    dom,
    state.expanded,
    expandedAttribute,
    av.status,
    micAttribute,
    title,
  );
  state.options.rows.sync();

  renderStripBubbles(
    state,
    models.strip,
  );

  renderPopoverBubbles(
    state,
    models.popover,
  );

  paintDockIndicators(dom, models.strip);
  paintControls(dom, av.status, av.muted, av.cameraOn);
  state.options.placePopover();
}

function paintDockSurface(
  dom: DockDom,
  expanded: boolean,
  expandedAttribute: string,
  status: "off" | "connecting" | "live",
  micAttribute: string,
  title: string,
): void {
  dom.root.dataset.dockExpanded = expandedAttribute;
  dom.root.dataset.dockPhase = status;
  dom.root.dataset.dockMic = micAttribute;
  dom.popover.hidden = !expanded;
  dom.strip.setAttribute(
    "aria-expanded",
    String(expanded),
  );
  dom.strip.title = title;
  dom.strip.setAttribute(
    "aria-label",
    title,
  );
}

function paintDockIndicators(dom: DockDom, model: DockModel): void {
  const count = overflowLabel(model);
  const overflowElement = dom.overflow;
  overflowElement.textContent = count;
  overflowElement.hidden = count === "";
  const hasOpener = transcriptDoor.hasOpener();
  const transcriptVisible = decideDoorVisible({ hasOpener });
  dom.scribe.hidden = !transcriptVisible;
}

function renderStripBubbles(
  state: DockViewState,
  model: DockModel,
): void {
  const dom = state.options.dom;
  const stripOptions: DockBubbleRenderOptions = {
    video: false,
    pan: false,
    jump: false,
    here: state.options.route.current(),
  };
  renderBubbles(
    model,
    dom.bubbles,
    state.stripNodes,
    stripOptions,
  );
}

function renderPopoverBubbles(
  state: DockViewState,
  model: DockModel,
): void {
  const dom = state.options.dom;
  const popoverOptions: DockBubbleRenderOptions = {
    video: true,
    pan: true,
    jump: true,
    here: state.options.route.current(),
  };
  const popoverModel = state.expanded
    ? model
    : EMPTY_MODEL;
  renderBubbles(
    popoverModel,
    dom.faces,
    state.popoverNodes,
    popoverOptions,
  );
}

function disposeDockBubbles(state: DockViewState): void {
  for (const [key, node] of state.popoverNodes) {
    const video = node.video;
    if (video === null) continue;
    detachVideo(key, video);
  }
  state.popoverNodes.clear();
  state.stripNodes.clear();
}

function paintControls(
  dom: DockDom,
  status: "off" | "connecting" | "live",
  muted: boolean,
  cameraOn: boolean,
): void {
  const live = status === "live";
  const connecting = status === "connecting";
  paintAudioButton(dom.audioButton, live, connecting);
  paintMicButton(dom.micButton, live, muted);
  paintCameraButton(dom.cameraButton, live, cameraOn);
}

function paintAudioButton(
  button: HTMLButtonElement,
  live: boolean,
  connecting: boolean,
): void {
  const label = live
    ? "Leave"
    : connecting
      ? "Joining…"
      : "Join audio";
  const title = live
    ? "Leave the room audio"
    : "Join the room audio (the same call as the canvas page's Join audio)";
  button.textContent = label;
  button.disabled = connecting;
  button.title = title;
  button.dataset.canvasDockAudio = live ? "leave" : "join";
}

function paintMicButton(
  button: HTMLButtonElement,
  live: boolean,
  muted: boolean,
): void {
  const label = muted ? "Unmute" : "Mute";
  const title = muted ? "Unmute your microphone" : "Mute your microphone";
  button.textContent = label;
  button.disabled = !live;
  button.setAttribute(
    "aria-pressed",
    String(muted),
  );
  button.dataset.canvasDockMic = muted ? "muted" : "live";
  button.title = title;
  button.setAttribute(
    "aria-label",
    title,
  );
}

function paintCameraButton(
  button: HTMLButtonElement,
  live: boolean,
  cameraOn: boolean,
): void {
  const label = cameraOn ? "Camera off" : "Camera on";
  const title = cameraOn
    ? "Turn your camera off"
    : "Turn your camera on";
  button.textContent = label;
  button.disabled = !live;
  button.setAttribute(
    "aria-pressed",
    String(cameraOn),
  );
  button.dataset.canvasDockCamera = cameraOn ? "on" : "off";
  button.title = title;
  button.setAttribute(
    "aria-label",
    title,
  );
}

export function transcriptClick(
  setStatus: (text: string) => void,
  apply: (event: ExpandEvent) => void,
  event: Event,
): void {
  event.stopPropagation();
  const outcome = transcriptDoor.open();
  const decision = decideTranscriptClick(outcome);
  setStatus(decision.status);
  if (decision.fold) {
    apply({ type: "transcript" });
  }
}
