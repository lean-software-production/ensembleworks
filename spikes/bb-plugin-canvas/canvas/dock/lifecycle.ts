import type { DockDom } from "./dom.js";
import type { DockInteractions } from "./interactions.js";
import type { DockPlacement } from "./placement.js";
import type { DockSubscriptions } from "./subscriptions.js";
import type { DockView } from "./view.js";
import type { DockRows } from "./rows.js";

const POPOVER_SELECTOR = "[data-canvas-dock-popover]";

export interface DockLifecycleResources {
  readonly dom: DockDom;
  readonly rows: DockRows;
  readonly placement: DockPlacement;
  readonly interactions: DockInteractions;
  readonly subscriptions: DockSubscriptions;
  readonly view: DockView;
}

export function disposeDockLifecycle(resources: DockLifecycleResources): void {
  resources.placement.stop();
  resources.subscriptions.stop();
  resources.rows.clear();
  resources.interactions.stop();
  resources.view.disposeBubbles();
  removeDockDom(resources.dom);
}

function removeDockDom(dom: DockDom): void {
  removeDockRoots(dom);
  removeRetiredPopovers();
  dom.style.remove();
}

function removeDockRoots(dom: DockDom): void {
  dom.root.remove();
  dom.popover.remove();
}

function removeRetiredPopovers(): void {
  const retiredPopovers = Array.from(
    document.querySelectorAll(POPOVER_SELECTOR),
  );
  for (const node of retiredPopovers) {
    node.remove();
  }
}
