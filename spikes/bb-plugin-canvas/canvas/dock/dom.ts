import { DOCK_POPOVER_ID, DOCK_ROOT_ID, DOCK_STYLES } from "./styles.js";

export interface DockDom {
  readonly style: HTMLStyleElement;
  readonly root: HTMLDivElement;
  readonly strip: HTMLButtonElement;
  readonly bubbles: HTMLSpanElement;
  readonly overflow: HTMLSpanElement;
  readonly popover: HTMLDivElement;
  readonly faces: HTMLDivElement;
  readonly audioButton: HTMLButtonElement;
  readonly micButton: HTMLButtonElement;
  readonly cameraButton: HTMLButtonElement;
  readonly scribe: HTMLButtonElement;
  readonly status: HTMLParagraphElement;
}
export function createDockDom(squeeze: string): DockDom {
  const style = document.createElement("style");
  style.id = "canvas-av-dock-styles";
  style.textContent = DOCK_STYLES;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = DOCK_ROOT_ID;
  root.dataset.canvasDock = "";
  root.dataset.dockStatus = "";
  root.dataset.dockExpanded = "false";
  root.dataset.dockAnchor = "fixed";
  root.dataset.dockSqueeze = squeeze;
  root.dataset.dockRowDecor = "idle";
  root.dataset.dockRows = "0";
  root.dataset.dockRowWrites = "0";

  const strip = document.createElement("button");
  strip.type = "button";
  strip.className = "dock-strip";
  strip.dataset.canvasDockStrip = "";
  strip.setAttribute("aria-haspopup", "dialog");
  strip.setAttribute("aria-expanded", "false");
  strip.setAttribute("aria-controls", DOCK_POPOVER_ID);
  const bubbles = document.createElement("span");
  bubbles.className = "dock-bubbles";
  const overflow = document.createElement("span");
  overflow.className = "dock-overflow";
  const callDot = micGlyph();
  callDot.classList.add("dock-call");
  strip.append(bubbles, overflow, callDot);

  const popover = document.createElement("div");
  popover.id = DOCK_POPOVER_ID;
  popover.className = "dock-popover";
  popover.dataset.canvasDockPopover = "";
  popover.dataset.dockStatus = "";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Canvas room audio");
  popover.hidden = true;

  const faces = document.createElement("div");
  faces.className = "dock-faces";
  const controls = document.createElement("div");
  controls.className = "dock-controls";
  const audioButton = button("dock-btn dock-audio", "", "");
  const micButton = button("dock-btn dock-mic", "", "");
  const cameraButton = button("dock-btn dock-camera", "", "");
  const scribe = button("dock-btn dock-transcript", "Transcript", "Open the room transcript");
  scribe.dataset.canvasDockScribe = "";
  scribe.setAttribute("aria-label", "Open the room transcript");
  scribe.hidden = true;
  controls.append(audioButton, micButton, cameraButton, scribe);

  const status = document.createElement("p");
  status.className = "dock-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  popover.append(faces, controls, status);
  root.append(strip);
  document.body.appendChild(popover);
  return { style, root, strip, bubbles, overflow, popover, faces, audioButton, micButton, cameraButton, scribe, status };
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.title = title;
  return element;
}

function micGlyph(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}
