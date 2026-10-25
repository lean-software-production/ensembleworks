import { createDockAnchor, type DockAnchor } from "./anchor.js";
import {
  chooseSqueeze,
  containerWidth,
  nextSqueeze,
  type SqueezeTier,
} from "./squeeze.js";
import { createSyncScheduler } from "./sync-latch.js";
import { placePopoverBox } from "./popover-place.js";
import { shouldScheduleSync, type MutationShape } from "./thread-status.js";
import type { DockRoute } from "./route.js";
import type { DockRows } from "./rows.js";

const HEADER_ROW_SELECTOR = '[data-testid="app-page-header-content-row"]';
const ROW_DECORATION = "[data-canvas-row-presence]";

// Placement has three small jobs that used to be interleaved in mountAvDock:
// locating the strip, choosing its header density, and writing popover
// geometry. It also owns the two drivers that ask for those jobs to run.
//
// Anchor selection remains delegated to anchor.ts. The DOM callbacks here are
// intentionally mechanical: find the named header row, ask the generic
// decision, and move the one root node. The first-child, row-tail, and fixed
// fallback levels are all still represented by the same data attribute and
// the same element identity.
//
// The mutation observer watches body because the host may replace the entire
// layout root on navigation. Its callback never performs layout work. It
// reduces each record to the ownership facts consumed by thread-status.ts and
// raises the scheduler only for a batch containing host-owned work. Mutations
// made by row decoration and bubble rendering consequently do not make a
// second pass by themselves.
//
// The scheduler has a frame driver and the roster-poll backstop. A poll always
// runs the pass and invalidates a frame that was already requested. This is
// why a hidden or throttled tab cannot leave the anchor permanently stale.
// The pass order is fixed: route, anchor, squeeze, row decoration, popover.
// A move can change the row being measured, and a resize that changes no tier
// can still change the fixed popover's viewport position, so both geometry
// operations remain in the pass.
//
// Squeeze state belongs here rather than in the view. It is selected from a
// real header measurement on mount, then changed only after a later measured
// tier differs. The view reads the current tier when it builds the strip model
// and never performs a layout read of its own.
//
// Popover placement deliberately runs after painting. Its anchor rectangle,
// offset dimensions, and document-element viewport dimensions are the exact
// inputs used by popover-place.ts. The custom properties are written on the
// body child itself; writing them on the strip root would not reach the rule
// that consumes the transform.
export interface DockPlacementOptions {
  readonly root: HTMLDivElement;
  readonly popover: HTMLDivElement;
  readonly route: DockRoute;
  readonly rows: DockRows;
  readonly initialSqueeze: SqueezeTier;
  readonly isDisposed: () => boolean;
  readonly render: () => void;
  readonly apply: (event: { readonly type: "reanchored" }) => void;
}

export interface DockPlacement {
  readonly tier: () => SqueezeTier;
  readonly syncAnchor: () => void;
  readonly syncSqueeze: () => void;
  readonly syncPopover: () => void;
  readonly schedule: () => void;
  readonly poll: () => void;
  readonly insideWidget: (node: Node) => boolean;
  readonly stop: () => void;
}

export function initialDockSqueeze(): SqueezeTier {
  const width = measureContainer();
  return chooseSqueeze(width);
}

export function createDockPlacement(options: DockPlacementOptions): DockPlacement {
  let squeeze = options.initialSqueeze;
  let observedRow: Element | null = null;
  const anchor = createAnchor(options.root);
  const sizeObserver = new ResizeObserver(() => {
    scheduler.mutation();
  });
  const scheduler = createSyncScheduler({
    requestFrame: (callback) => {
      requestAnimationFrame(callback);
    },
    run: () => {
      if (options.isDisposed()) return;
      options.route.check();
      syncAnchor();
      syncSqueeze();
      options.rows.sync();
      syncPopover();
    },
  });
  const observer = new MutationObserver((records) => {
    const shapes = records.map(shapeOf);
    if (shouldScheduleSync(shapes)) schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  const syncAnchor = (): void => {
    const disposed = options.isDisposed();
    if (disposed) return;
    const moved = anchor.sync();
    if (!moved) return;
    options.apply({ type: "reanchored" });
    options.render();
  };

  const syncSqueeze = (): void => {
    const disposed = options.isDisposed();
    if (disposed) return;
    const row = headerRow();
    if (row !== observedRow) {
      if (observedRow !== null) sizeObserver.unobserve(observedRow);
      if (row !== null) sizeObserver.observe(row);
      observedRow = row;
    }
    const width = measureContainer(row);
    const next = nextSqueeze(squeeze, width);
    if (next === squeeze) return;
    squeeze = next;
    options.root.dataset.dockSqueeze = next;
    options.render();
  };

  const syncPopover = (): void => {
    const disposed = options.isDisposed();
    if (disposed) return;
    const rect = options.root.getBoundingClientRect();
    const anchorLeft = rect.left;
    const anchorRight = rect.right;
    const anchorTop = rect.top;
    const anchorBottom = rect.bottom;
    const popoverWidth = options.popover.offsetWidth;
    const popoverHeight = options.popover.offsetHeight;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const box = placePopoverBox({
      anchorLeft,
      anchorRight,
      anchorTop,
      anchorBottom,
      popoverWidth,
      popoverHeight,
      viewportWidth,
      viewportHeight,
    });
    const left = `${box.left}px`;
    const top = `${box.top}px`;
    options.popover.style.setProperty("--dock-popover-x", left);
    options.popover.style.setProperty("--dock-popover-y", top);
  };

  const schedule = (): void => {
    scheduler.mutation();
  };
  const poll = (): void => {
    scheduler.poll();
  };
  const insideWidget = (node: Node): boolean => {
    const inRoot = node === options.root || options.root.contains(node);
    if (inRoot) return true;
    const inPopover = node === options.popover || options.popover.contains(node);
    if (inPopover) return true;
    return false;
  };

  return {
    tier: () => squeeze,
    syncAnchor,
    syncSqueeze,
    syncPopover,
    schedule,
    poll,
    insideWidget,
    stop: () => {
      observer.disconnect();
      sizeObserver.disconnect();
      scheduler.stop();
    },
  };

  function shapeOf(record: MutationRecord): MutationShape {
    const nodes: boolean[] = [];
    for (let index = 0; index < record.addedNodes.length; index += 1) {
      nodes.push(isOurNode(record.addedNodes[index]!));
    }
    for (let index = 0; index < record.removedNodes.length; index += 1) {
      nodes.push(isOurNode(record.removedNodes[index]!));
    }
    return { targetIsOurs: isOurNode(record.target), nodes };
  }

  function isOurNode(node: Node): boolean {
    if (!(node instanceof Element)) return false;
    return insideWidget(node) || node.closest(ROW_DECORATION) !== null;
  }
}

function createAnchor(root: HTMLDivElement): DockAnchor {
  return createDockAnchor<Element>({
    findMarker: (selector) => {
      return document.querySelector(selector);
    },
    parentOf: (node) => {
      return node.parentElement;
    },
    findRow: headerRow,
    isConnected: () => {
      return root.isConnected;
    },
    isTrailingChildOf: (host) => {
      return host.lastElementChild === root;
    },
    isFirstChildOf: (host) => {
      return host.firstElementChild === root;
    },
    attachAsFirstChild: (host) => {
      root.dataset.dockAnchor = "before";
      host.prepend(root);
    },
    attachToRow: (host) => {
      root.dataset.dockAnchor = "row";
      host.appendChild(root);
    },
    attachFixed: () => {
      root.dataset.dockAnchor = "fixed";
      document.body.appendChild(root);
    },
  });
}

function headerRow(): Element | null {
  return document.querySelector(HEADER_ROW_SELECTOR);
}

function measureContainer(row: Element | null = headerRow()): number {
  const rowWidth = row?.getBoundingClientRect().width ?? null;
  const viewportWidth = window.innerWidth;
  return containerWidth(rowWidth, viewportWidth);
}
