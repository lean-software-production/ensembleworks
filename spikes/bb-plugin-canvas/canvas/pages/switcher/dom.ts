import {
  NO_POPOVER_ANCHOR,
  type PopoverAnchor,
} from "../../dock/popover-place.js";

export function anchorOf(element: Element | null): PopoverAnchor {
  if (element === null) return NO_POPOVER_ANCHOR;
  const anchor = element.getBoundingClientRect();
  return {
    anchorLeft: anchor.left,
    anchorRight: anchor.right,
    anchorTop: anchor.top,
    anchorBottom: anchor.bottom,
  };
}
