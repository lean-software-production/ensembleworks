/**
 * The two pieces of geometry the strip cannot fake: how wide it is, and where
 * its popover fits.
 *
 * Both are pure functions over numbers, because both are answers the DOM only
 * gives you at runtime and neither is allowed to be decided by eye.
 */

/** One line, always. The row's whole claim on the sidebar is this number. */
export const ROW_HEIGHT_PX = 36;

export type StripTier = "rail" | "narrow" | "full";

/**
 * How much of itself the row can show at this sidebar width.
 *
 * - `full` — room name, three faces, overflow count.
 * - `narrow` — no room name (it would be an ellipsis anyway); two faces.
 * - `rail` — bb's collapsed icon sidebar: a dot and a bare count, nothing that
 *   needs horizontal room. The row is still one line high and still opens the
 *   popover, so a collapsed sidebar loses information, never the control.
 *
 * An unknown width (0, NaN — what a hidden or not-yet-laid-out element reports)
 * is treated as the expanded sidebar: the common case, and the one that degrades
 * visibly rather than silently.
 */
export function decideTier(width: number): StripTier {
  if (!Number.isFinite(width) || width <= 0) return "full";
  if (width < 110) return "rail";
  if (width < 190) return "narrow";
  return "full";
}

/** Faces this tier has room for; the rest become "+N". */
export function facesForTier(tier: StripTier): number {
  if (tier === "rail") return 0;
  return tier === "narrow" ? 2 : 3;
}

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface PopoverPlacement {
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly side: "above" | "below";
  /** Set when `side` is "below". Viewport coordinates. */
  readonly top?: number;
  /** Set when `side` is "above": distance from the viewport's bottom edge. */
  readonly bottom?: number;
}

const GAP_PX = 8;
const MARGIN_PX = 8;
/** Below this a popover is not worth opening in that direction. */
const MIN_USEFUL_HEIGHT_PX = 160;

/**
 * Put the popover above the row, unless above is unusable.
 *
 * Positions are VIEWPORT coordinates for a fixed-position element in `<body>`:
 * the sidebar clips its own overflow and scrolls its thread list, so a popover
 * rendered inside it would be cut off or would ride the list. Anchoring above
 * matches the mockup and keeps the row itself visible while the popover is open.
 *
 * Everything is clamped inside the viewport margins, and the height is returned
 * as a MAXIMUM rather than a height: the popover scrolls its own content, so a
 * meeting with forty people is a scrollable list, never a column that runs off
 * the top of the screen.
 */
export function placePopover(input: {
  anchor: Rect;
  viewport: Viewport;
  desired: { width: number; height: number };
}): PopoverPlacement {
  const width = Math.max(
    160,
    Math.min(input.desired.width, Math.max(160, input.viewport.width - MARGIN_PX * 2)),
  );
  const maxLeft = Math.max(MARGIN_PX, input.viewport.width - width - MARGIN_PX);
  const left = Math.min(Math.max(input.anchor.left, MARGIN_PX), maxLeft);
  const above = Math.max(0, input.anchor.top - GAP_PX - MARGIN_PX);
  const belowTop = input.anchor.top + input.anchor.height + GAP_PX;
  const below = Math.max(0, input.viewport.height - belowTop - MARGIN_PX);
  const preferAbove = above >= Math.min(MIN_USEFUL_HEIGHT_PX, input.desired.height) || above >= below;
  if (preferAbove) {
    return {
      left,
      width,
      side: "above",
      bottom: Math.max(MARGIN_PX, input.viewport.height - input.anchor.top + GAP_PX),
      maxHeight: Math.min(input.desired.height, above),
    };
  }
  return {
    left,
    width,
    side: "below",
    top: belowTop,
    maxHeight: Math.min(input.desired.height, below),
  };
}
