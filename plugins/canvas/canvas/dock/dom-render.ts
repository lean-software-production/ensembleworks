
// Imperative DOM reconciliation for the dock's faces.
// Kept separate from lifecycle wiring so live video nodes have one owner.
import { attachVideo, detachVideo } from "../av-room.js";
import type { DockBubble, DockModel } from "./model.js";
import { jumpHref, locationLabel, parseLocation, type BbLocation } from "./where.js";
// Bubbles
// ---------------------------------------------------------------------------

export const EMPTY_MODEL: DockModel = { bubbles: [], overflow: 0 };

export interface BubbleNode {
  readonly root: HTMLElement;
  readonly initials: HTMLSpanElement;
  video: HTMLVideoElement | null;
  /** The face plus the whereabouts line under it, when there is one. The
   * <video> must stay attached to `root`, so the two are separate nodes and
   * this is the one the row inserts. Null on the strip's own faces, which are
   * bare. */
  readonly wrapper: HTMLElement | null;
  /** "jump to them", when their location is known and they are not you. */
  readonly link: HTMLAnchorElement | null;
  /** The same sentence when it is NOT a link — you, or somebody whose location
   * is unknown or stale. Where they are is still worth reading. */
  readonly whereabouts: HTMLSpanElement | null;
}

export interface BubbleOptions {
  /** Whether a camera publisher's face becomes a live tile here. Only the
   * popover's faces do — one attached <video> per person, ever. */
  readonly video: boolean;
  /** Whether a face is a button that flies the canvas camera to that person.
   * The strip's faces are not: they are inside the strip's own <button>. */
  readonly pan: boolean;
  /** Whether each face carries a whereabouts line BELOW it — per the ask, the
   * jump link is a separate affordance from the face, not the face itself. */
  readonly jump: boolean;
  /** The VIEWER's own location, which is what turns "in thread thr_x" into
   * "in this thread". */
  readonly here: BbLocation | null;
}

/**
 * Reconcile a bubble row against the model.
 *
 * Node-by-node rather than innerHTML, for one reason: a `<video>` removed from
 * the document and re-added loses its stream and flashes black. Someone else
 * starting to talk must not blink everyone's camera.
 */
export function renderBubbles(
  model: DockModel,
  container: HTMLElement,
  nodes: Map<string, BubbleNode>,
  options: BubbleOptions,
): void {
  const wanted = new Set(model.bubbles.map((bubble) => bubble.key));
  for (const [key, node] of [...nodes]) {
    if (wanted.has(key)) continue;
    if (node.video !== null) detachVideo(key, node.video);
    (node.wrapper ?? node.root).remove();
    nodes.delete(key);
  }

  model.bubbles.forEach((bubble, index) => {
    let node = nodes.get(bubble.key);
    if (node === undefined) {
      node = createBubble(options);
      nodes.set(bubble.key, node);
    }
    updateBubble(node, bubble, options);
    // Only touch the DOM when the node is not already where the model wants
    // it. A `<video>` re-inserted into the tree — even into the same parent —
    // can drop a frame or pause, and the order is alphabetical and therefore
    // unchanged on the overwhelming majority of renders.
    const outer = node.wrapper ?? node.root;
    if (container.children[index] !== outer) {
      container.insertBefore(outer, container.children[index] ?? null);
    }
  });
}

function createBubble(options: BubbleOptions): BubbleNode {
  const root = document.createElement(options.pan ? "button" : "span");
  if (root instanceof HTMLButtonElement) root.type = "button";
  root.className = "dock-bubble";
  const initials = document.createElement("span");
  initials.className = "dock-initials";
  initials.setAttribute("aria-hidden", "true");
  root.appendChild(initials);
  if (!options.jump) {
    return { root, initials, video: null, wrapper: null, link: null, whereabouts: null };
  }

  const wrapper = document.createElement("div");
  wrapper.className = "dock-face";
  // A REAL LINK, with a real href. That is what makes middle-click, ⌘-click,
  // "copy link address" and the browser's status bar work — none of which a
  // <button> with a click handler can offer, however much script you write.
  const link = document.createElement("a");
  link.className = "dock-jump";
  const whereabouts = document.createElement("span");
  whereabouts.className = "dock-jump dock-jump-inert";
  wrapper.append(root, link, whereabouts);
  return { root, initials, video: null, wrapper, link, whereabouts };
}

function updateBubble(
  node: BubbleNode,
  bubble: DockBubble,
  options: BubbleOptions,
): void {
  node.root.dataset.canvasDockBubble = bubble.key;
  node.root.dataset.canvasDockSpeaking = bubble.isSpeaking ? "true" : "false";
  node.root.dataset.canvasDockSelf = bubble.isSelf ? "true" : "false";
  node.root.style.background = bubble.color;
  node.initials.textContent = bubble.initials;

  if (options.pan) {
    // Disabled when that person has no cursor on the canvas: they are
    // connected but have not moved a pointer, so there is nowhere honest to
    // jump to, and inventing a destination would teach the gesture to lie.
    const canPan = bubble.canPan && bubble.clientId !== null;
    if (canPan && bubble.clientId !== null) {
      node.root.dataset.canvasDockPan = bubble.clientId;
    } else {
      delete node.root.dataset.canvasDockPan;
    }
    if (node.root instanceof HTMLButtonElement) node.root.disabled = !canPan;
    node.root.title = canPan
      ? `${bubble.label} — jump to their cursor`
      : `${bubble.label} — no cursor on the canvas yet`;
  } else {
    node.root.title = bubble.label;
  }
  node.root.setAttribute("aria-label", bubble.label);

  if (node.link !== null && node.whereabouts !== null) {
    updateWhereabouts(node.link, node.whereabouts, bubble, options.here);
  }

  if (options.video && bubble.hasVideo && node.video === null) {
    const video = document.createElement("video");
    video.className = "dock-video";
    video.autoplay = true;
    video.playsInline = true;
    // Your own tile is your own camera: muting it is the difference between a
    // self-view and a feedback loop.
    video.muted = true;
    // attachVideo answers false when the track vanished between the bus update
    // and this frame — in which case we keep initials rather than showing a
    // black rectangle.
    if (attachVideo(bubble.key, video)) {
      node.root.appendChild(video);
      node.video = video;
    }
  } else if ((!options.video || !bubble.hasVideo) && node.video !== null) {
    detachVideo(bubble.key, node.video);
    node.video.remove();
    node.video = null;
  }
  node.root.dataset.canvasDockVideo = node.video === null ? "false" : "true";
}


/**
 * The line under a face: where that person is, as a link when it is somewhere
 * this browser can honestly be sent.
 *
 * NO LINK FOR YOU, and no link for somebody whose location is unknown or stale
 * — the server nulls a location past LOCATION_STALE_MS precisely so this can
 * decline rather than send a teammate to the page you were on a minute ago. In
 * both cases the SENTENCE still shows: where somebody is is worth reading even
 * when there is nowhere to click.
 *
 * `href` is set from `jumpHref`, which refuses anything that is not a rooted
 * same-origin path — this string came off the wire from another client.
 */
function updateWhereabouts(
  link: HTMLAnchorElement,
  inert: HTMLSpanElement,
  bubble: DockBubble,
  here: BbLocation | null,
): void {
  const there = bubble.path === null ? null : parseLocation(bubble.path);
  const label = locationLabel(there, here, bubble.title);
  const href = bubble.isSelf ? null : jumpHref(bubble.path);

  if (href === null) {
    link.hidden = true;
    link.removeAttribute("href");
    delete link.dataset.canvasDockJump;
    // And the sentence goes with them. The node is display:none and carries no
    // href, so only textContent scraping could ever see it — but a stale "in
    // \u201cUnread thread\u201d" left lying inside the DOM is a wrong answer to
    // anyone who reads the DOM, which is exactly what a test harness does.
    link.textContent = "";
    link.removeAttribute("title");
    inert.hidden = false;
    inert.textContent = label;
    inert.title = bubble.isSelf ? `You are ${label}` : `${bubble.label} — ${label}`;
    return;
  }

  inert.hidden = true;
  inert.textContent = "";
  link.hidden = false;
  link.href = href;
  // The path is carried in a data attribute as well as the href so the click
  // handler reads exactly what was rendered, not the absolute URL the DOM
  // resolves `.href` to.
  link.dataset.canvasDockJump = href;
  link.textContent = label;
  link.title = `${bubble.label} — ${label}. Click to go there.`;
  link.setAttribute("aria-label", `Go to ${bubble.name} — ${label}`);
}
