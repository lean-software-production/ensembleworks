/**
 * The sidebar presence strip, from mount to disposer.
 *
 * This is the composition root: it owns the clocks, the observer, the data and
 * the lifecycle, and it makes no decisions of its own — every question it asks
 * is answered by a pure module beside it (`anchor.ts`, `layout.ts`, `model.ts`),
 * so the answers are testable without a browser.
 *
 * WHY A CONTENT SCRIPT. `app.contentScripts.register` is the only surface bb
 * offers that survives a route change: the SDK mounts it "once per active
 * frontend generation in each bb app window" and calls the returned disposer
 * exactly once. Every other registration is route-scoped — a `navPanel` exists
 * only on its own page, a `threadPanelAction` only inside a thread's panel — and
 * a row that vanished when you opened a thread would not be a presence strip.
 * Mounted once per generation is also what makes DUPLICATE MOUNTS impossible:
 * there is one node, and placement MOVES it.
 *
 * LIVING IN SOMEBODY ELSE'S REACT TREE. bb rebuilds the sidebar on navigation,
 * and renders a second one (the mobile drawer) on narrow windows. A
 * MutationObserver on `document.body` — not on a React-owned node, which could
 * be remounted out from under the observer — re-asks the placement question,
 * coalesced to one answer per frame: the callback only raises a flag, so a
 * streamed token in the composer costs a boolean rather than a `querySelector`.
 */

import type { PresenceView } from "../view.js";
import { chooseSidebar, decideAnchor, type AnchorAttachment } from "./anchor.js";
import { decideTier, placePopover, type StripTier } from "./layout.js";
import { popoverModel, rowModel } from "./model.js";
import { createContentScriptRpc, type ContentScriptRpc } from "./rpc.js";
import { createStrip } from "./strip.js";

const POLL_MS = 2_500;
/** Speaking decays on its own clock, so the ring has to be re-asked about. */
const TICK_MS = 500;
const POPOVER_WIDTH = 270;
const POPOVER_HEIGHT = 340;
/** How many faces we are ever willing to hold a picture for at once. */
const PORTRAIT_CACHE = 8;

export interface PresenceMountOptions {
  document: Document;
  pluginId: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected so tier behaviour is testable without a layout engine. */
  measure?: (element: Element) => number;
  viewport?: () => { width: number; height: number };
  pollMs?: number;
}

export interface MountedPresenceStrip {
  dispose(): void;
  /** Test seam: run one poll now and render the result. */
  refresh(): Promise<void>;
  /** Test seam: re-run the placement decision now. */
  syncAnchor(): void;
  /** Test seam: what the strip currently believes. */
  view(): PresenceView | null;
}

/**
 * Is this sidebar the one the user can actually see?
 *
 * bb renders the desktop sidebar and the mobile drawer from one tree, so both
 * can be in the document at once. Hidden-ness is read structurally — `hidden`,
 * `aria-hidden`, `inert`, a closed `data-state`, an inline `display: none` —
 * rather than from layout, because layout is exactly what a test has none of and
 * a strip that mounts into the invisible copy is a strip nobody sees.
 */
export function isSidebarShown(element: Element): boolean {
  if (!element.isConnected) return false;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    if (node.hasAttribute("inert")) return false;
    if (node.getAttribute("data-state") === "closed") return false;
    const style = (node as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  }
  return true;
}

export function mountPresenceStrip(options: PresenceMountOptions): MountedPresenceStrip {
  const doc = options.document;
  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? POLL_MS;
  const measure = options.measure ?? ((element: Element) => element.getBoundingClientRect().width);
  const viewport = options.viewport ?? (() => ({
    width: doc.defaultView?.innerWidth ?? 0,
    height: doc.defaultView?.innerHeight ?? 0,
  }));
  const rpc: ContentScriptRpc = createContentScriptRpc(
    options.pluginId,
    options.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: options.signal })),
  );

  let disposed = false;
  let view: PresenceView | null = null;
  let attached: AnchorAttachment<Element> | null = null;
  let tier: StripTier = "full";
  let frame: number | null = null;
  /** The last thing actually drawn, so an unchanged repaint costs nothing. */
  let painted = "";
  const portraits = new Map<string, { capturedAt: number; dataUrl: string }>();
  const requested = new Set<string>();

  const strip = createStrip({
    document: doc,
    callbacks: {
      selectRoom: (roomId) => {
        void rpc.call("presence.select", { roomId }).then(
          (next) => {
            view = next as PresenceView;
            render();
          },
          () => { /* A failed selection leaves the previous room on screen. */ },
        );
      },
      portrait: (participantId, capturedAt) => {
        const held = portraits.get(participantId);
        return held && held.capturedAt === capturedAt ? held.dataUrl : null;
      },
      openChanged: (open) => {
        if (open) placeOpenPopover();
      },
    },
  });

  /**
   * Draw what we already know. Never fetches, so it cannot feed itself.
   *
   * Two clocks land here — a 2.5s poll and a 500ms tick that exists only so a
   * speaking ring expires on time — and most of their firings change nothing.
   * Comparing the models first keeps a quiet room from rebuilding the
   * participant list twice a second underneath whoever is reading it.
   */
  const paint = (): void => {
    if (disposed || view === null || view.room === null) return;
    const row = rowModel(view, tier, strip.isOpen());
    const popover = popoverModel(view, { pluginId: options.pluginId, now: now() });
    // The images are part of what is on screen but not part of the models, so
    // an arriving still has to count as a change.
    const stills = [...portraits].map(([id, held]) => `${id}@${held.capturedAt}`).join(",");
    const signature = JSON.stringify([row, popover, stills]);
    if (signature === painted) return;
    painted = signature;
    strip.renderRow(row);
    strip.renderPopover(popover);
    if (strip.isOpen()) placeOpenPopover();
  };

  const render = (): void => {
    if (disposed) return;
    if (view === null || view.room === null) {
      // Nothing honest to show: no rooms, or Zoom is not configured. The row is
      // removed rather than rendered empty, so the sidebar costs nothing.
      if (strip.root.isConnected) strip.root.remove();
      attached = null;
      strip.close();
      return;
    }
    syncAnchor();
    paint();
    void fetchPortraits();
  };

  const syncAnchor = (): void => {
    if (disposed || view?.room == null) return;
    const candidates = Array.from(doc.querySelectorAll('[data-sidebar="sidebar"]')).map((root) => ({
      root,
      footer: root.querySelector('[data-sidebar="footer"]'),
      mobile: root.closest('[data-sidebar="panel"]') !== null,
      visible: isSidebarShown(root),
    }));
    const host = chooseSidebar(candidates);
    const decision = decideAnchor({
      footer: host?.footer ?? null,
      sidebar: host?.root ?? null,
      attached,
      connected: strip.root.isConnected,
      beforeFooter: attached?.kind === "footer" && attached.host.previousElementSibling === strip.root,
      lastInSidebar: attached?.kind === "sidebar" && attached.host.lastElementChild === strip.root,
    });
    if (decision.action === "footer") {
      decision.host.parentElement?.insertBefore(strip.root, decision.host);
      attached = { kind: "footer", host: decision.host };
    } else if (decision.action === "sidebar") {
      decision.host.append(strip.root);
      attached = { kind: "sidebar", host: decision.host };
    } else if (decision.action === "detach") {
      strip.root.remove();
      attached = null;
      strip.close();
    }
    if (attached !== null && host !== null) {
      // The tier follows the SIDEBAR's width, not the row's: a row inside a
      // collapsed rail is as wide as the rail, and that is the fact that
      // decides whether a name fits.
      const next = decideTier(measure(host.root));
      if (next !== tier) {
        tier = next;
        if (view) strip.renderRow(rowModel(view, tier, strip.isOpen()));
      }
    }
  };

  const placeOpenPopover = (): void => {
    if (!strip.isOpen() || !strip.root.isConnected) return;
    const anchor = strip.row.getBoundingClientRect();
    const placement = placePopover({
      anchor: { top: anchor.top, left: anchor.left, width: anchor.width, height: anchor.height },
      viewport: viewport(),
      desired: { width: POPOVER_WIDTH, height: POPOVER_HEIGHT },
    });
    const style = strip.popover.style;
    style.left = `${placement.left}px`;
    style.width = `${placement.width}px`;
    style.maxHeight = `${placement.maxHeight}px`;
    if (placement.side === "above") {
      style.bottom = `${placement.bottom}px`;
      style.top = "auto";
    } else {
      style.top = `${placement.top}px`;
      style.bottom = "auto";
    }
  };

  const fetchPortraits = async (): Promise<void> => {
    const room = view?.room;
    if (!room) return;
    if (!room.portraits) {
      // Portraits stopped (or never ran): drop anything still held here too, so
      // a face cannot outlive the feed that produced it.
      if (portraits.size > 0) {
        portraits.clear();
        paint();
      }
      return;
    }
    for (const participant of room.participants.slice(0, PORTRAIT_CACHE)) {
      if (participant.portraitAt === null) continue;
      const held = portraits.get(participant.id);
      if (held && held.capturedAt === participant.portraitAt) continue;
      const key = `${participant.id}:${participant.portraitAt}`;
      if (requested.has(key)) continue;
      requested.add(key);
      try {
        const result = await rpc.call("presence.portrait", { participantId: participant.id }) as
          { participantId: string; capturedAt: number; dataUrl: string } | null;
        // The answer is filed under the id the SERVER returned, so a response
        // that arrives for somebody else cannot be pinned to this face.
        if (result && result.participantId === participant.id) {
          portraits.set(result.participantId, { capturedAt: result.capturedAt, dataUrl: result.dataUrl });
        }
      } catch {
        // A missing still is a face with initials; nothing else changes.
      } finally {
        requested.delete(key);
      }
    }
    // Bounded, and scoped to people we are currently being told about: a sitting
    // that ended leaves no images behind in this client either.
    const live = new Set(room.participants.map((participant) => participant.id));
    for (const id of [...portraits.keys()]) {
      if (!live.has(id) || portraits.size > PORTRAIT_CACHE) portraits.delete(id);
    }
    paint();
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      view = await rpc.call("presence.get", null) as PresenceView;
    } catch {
      // Keep the last honest answer on screen rather than blanking the row on a
      // single failed poll; the next tick will correct it.
      return;
    }
    render();
  };

  const schedule = (): void => {
    if (frame !== null || disposed) return;
    const raf = doc.defaultView?.requestAnimationFrame;
    if (!raf) {
      syncAnchor();
      return;
    }
    frame = raf.call(doc.defaultView, () => {
      frame = null;
      syncAnchor();
    });
  };

  const observer = new (doc.defaultView?.MutationObserver ?? MutationObserver)(() => schedule());
  observer.observe(doc.body, { childList: true, subtree: true });

  const onPointerDown = (event: Event): void => {
    if (!strip.isOpen()) return;
    // A click that lands anywhere else dismisses the popover, and deliberately
    // does NOT pull focus back to the row: the user is on their way somewhere.
    if (!strip.owns(event.target as Node | null)) strip.close();
  };
  const onScroll = (): void => placeOpenPopover();
  const onResize = (): void => {
    syncAnchor();
    placeOpenPopover();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && strip.isOpen()) strip.close({ restoreFocus: true });
  };
  const onVisibility = (): void => {
    if (!doc.hidden) void refresh();
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("visibilitychange", onVisibility);
  doc.defaultView?.addEventListener("scroll", onScroll, true);
  doc.defaultView?.addEventListener("resize", onResize);

  const poll = setInterval(() => {
    // Placement is re-checked even while hidden, so a window that comes back
    // does not come back to a row that drifted out of the sidebar.
    schedule();
    if (!doc.hidden) void refresh();
  }, pollMs);
  // The speaking ring expires on time rather than on the next poll.
  const tick = setInterval(() => {
    if (view !== null && !doc.hidden) paint();
  }, TICK_MS);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(poll);
    clearInterval(tick);
    observer.disconnect();
    if (frame !== null) doc.defaultView?.cancelAnimationFrame(frame);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("visibilitychange", onVisibility);
    doc.defaultView?.removeEventListener("scroll", onScroll, true);
    doc.defaultView?.removeEventListener("resize", onResize);
    portraits.clear();
    requested.clear();
    strip.destroy();
    attached = null;
  };

  options.signal.addEventListener("abort", dispose, { once: true });
  void refresh();

  return {
    dispose,
    refresh,
    syncAnchor,
    view: () => view,
  };
}
