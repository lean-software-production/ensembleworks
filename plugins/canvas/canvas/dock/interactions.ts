import type { DockDom } from "./dom.js";
import type { ExpandEvent } from "./expand.js";

// These listeners are the gesture boundary of the dock. The strip and
// popover listeners remain attached to their owned nodes until those nodes are
// removed, while the document listeners have explicit teardown because the
// document outlives a plugin generation.
//
// Pointerdown is intentionally used for outside dismissal. It runs before a
// later click and therefore folds the widget before an outside control acts.
// A target in either of the two owned trees is inside; the popover is a body
// child rather than a root descendant, so checking only root.contains would
// fold the widget before Join audio, Mute, or Camera could run.
//
// Escape, strip-click, and popover-click are expressed as the existing expand
// events. No event policy is recreated here: the expand state machine remains
// the only authority for whether a gesture changes the folded state.
export interface DockInteractionsOptions {
  readonly dom: DockDom;
  readonly apply: (event: ExpandEvent) => void;
  readonly setStatus: (text: string) => void;
  readonly insideWidget: (node: Node) => boolean;
}

export interface DockInteractions {
  readonly stop: () => void;
}

export function createDockInteractions(options: DockInteractionsOptions): DockInteractions {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      options.apply({ type: "escape" });
    }
  };
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && options.insideWidget(target)) {
      return;
    }
    options.apply({ type: "outside-click" });
  };
  options.dom.strip.addEventListener(
    "click",
    () => options.apply({ type: "strip-click" }),
  );
  options.dom.popover.addEventListener(
    "click",
    () => options.apply({ type: "popover-click" }),
  );
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onPointerDown);

  const stop = (): void => {
    document.removeEventListener(
      "keydown",
      onKeyDown,
    );
    document.removeEventListener(
      "pointerdown",
      onPointerDown,
    );
  };

  return {
    stop,
  };
}
