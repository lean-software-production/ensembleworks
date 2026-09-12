// THE FLOATING CHROME: where the canvas's own controls sit, what they let
// through, and what they drop when there is no room.
//
// Owner request, 2026-09-05, two halves of one change: "can we make the
// command palette something that floats over the canvas; perhaps docked at the
// bottom?" and "lets make the 'pages' look like tabs". Before this, up to TWO
// rows of chrome sat ABOVE the drawing surface inside the canvas column — a
// toolbar row and, on a wide enough column, a page tab row — and both cost
// height permanently. They now leave the column's flow entirely and become one
// bottom-centred floating group over a full-bleed canvas: the tldraw/Figma
// arrangement, and the one the owner picked against a mockup showing BOTH rows
// leaving the flow.
//
// WHY A MODULE AND NOT STYLES IN THE .tsx. The same split canvas/dock/
// squeeze.ts and canvas/pages/page-tabs-fit.ts state in their own headers:
// this project has no jsdom and may not gain one, so an offset, a layer, a
// pointer-events policy or a visibility rule written inline in a component is
// a decision no test can read, and a mutation can move it in either direction
// with the whole suite green. tests/chrome-dock.test.ts holds every number
// below, and pins that CanvasPanel.tsx NAMES them rather than re-deciding.
//
// NOTHING HERE WAS SEEN IN A BROWSER. There is none in this spike. Every claim
// about what a reader will observe is an inference from the source and the CSS
// semantics, and is marked as such where it is made.

/**
 * How far the floating group is inset from the drawing surface's edges.
 *
 * The wrapper is pinned `bottom/left/right` by this one number, so the card it
 * centres can never be wider than the panel and never touches the edge. 8px,
 * and deliberately the SAME VALUE as canvas/dock/popover-place.ts's
 * POPOVER_EDGE_MARGIN_PX without being imported from it: that one is clearance
 * from the WINDOW's edge for a <body>-portalled box, this one is clearance from
 * a PANEL's edge for a box inside it. Two numbers that agree today are not one
 * number, and importing would mean a retune of the presence popover silently
 * moved the canvas toolbar — the same argument PAGE_TABS_MIN_PX makes for not
 * importing SQUEEZE_ROOMY_MIN_PX.
 */
export const CHROME_DOCK_EDGE_GAP_PX = 8;

/**
 * The layer the floating group paints on.
 *
 * IT IS THE FIRST LAYERED THING IN THIS PLUGIN THAT IS NOT PORTALLED TO
 * <body>. It is an absolutely-positioned sibling of the `data-canvas-viewport`
 * box inside the canvas column, and comes after it, so DOM order alone would
 * already put it over the canvas; the number is here for the comparison it CAN
 * lose — against the two <body>-parented popovers, which are in the root
 * stacking context and one of which is anchored to a button in this very card.
 *
 * WHY BELOW POPOVER_Z_INDEX (45). The Pages popover flips ABOVE its button
 * when it will not fit below (canvas/dock/popover-place.ts's `popoverTop`),
 * which from a bottom dock is the normal case — but when neither side fits,
 * that function's stated "bottom margin wins" clamp slides the box back DOWN
 * over the anchor. A card that outranked the popover would then paint over the
 * page list the user just opened from it. tests/page-switcher-layering.test.ts
 * pins the whole ladder as a chain.
 *
 * WHY ABOVE 0: it has to beat the canvas content it floats over.
 *
 * WHAT IS NOT KNOWN, inherited unchanged from canvas/dock/styles.ts: whether
 * these numbers are genuinely above bb's ordinary chrome. Nothing in this spike
 * has read bb's stylesheet.
 */
export const CHROME_DOCK_Z_INDEX = 40;

/**
 * Who takes pointer events in the floating group, and who passes them through.
 *
 * THE REGRESSION THIS EXISTS TO PREVENT is invisible to every test in this
 * project and would be very visible to a user: the wrapper is STRETCHED across
 * the full width of the drawing surface (that is how the card gets centred),
 * so if the wrapper took pointer events, the whole bottom band of the canvas
 * would silently stop drawing. A gesture starting there would hit the wrapper
 * instead of <Viewport>, produce nothing, and look like the canvas was broken.
 *
 * So: the wrapper is transparent to the pointer and only the CARD takes
 * clicks. `pointer-events: auto` on the card is not redundant with the default
 * — the property inherits, so a child of a `none` wrapper is `none` too unless
 * it says otherwise.
 *
 * NOT VERIFIED IN A BROWSER; this is the documented CSS semantics of
 * `pointer-events` applied to the structure in CanvasPanel.tsx, not an
 * observation.
 */
export const CHROME_DOCK_POINTER_EVENTS: {
  readonly wrapper: "none";
  readonly card: "auto";
} = { wrapper: "none", card: "auto" };

/**
 * What the toolbar does when its contents are wider than the panel.
 *
 * WRAP, not scroll and not clip. The toolbar's contents are a BOUNDED set — the
 * Pages button, six tool buttons and one chip — so a second line ends the
 * problem outright and every control stays visible and reachable. Scrolling
 * would hide controls behind a gesture with no affordance announcing it, and
 * clipping would delete them. The cost is that a wrapped bar covers more of the
 * canvas, which is cheap here in a way it was not when this was a flow row: the
 * canvas underneath is pannable, so nothing is unreachable, whereas a flow row
 * took the height away permanently.
 *
 * THE PAGE TAB STRIP ANSWERS THE OPPOSITE WAY (`overflowX: "auto"` in
 * canvas/pages/PageSwitcher.tsx) because pages are UNBOUNDED: wrapping them
 * would let the card grow until it ate the canvas. Two different answers, one
 * reason — whether the thing being laid out has a ceiling.
 */
export const CHROME_DOCK_TOOLBAR_OVERFLOW = "wrap" as const;

// NO WIDTH LADDER. There used to be one — `ChromeDockFit`, a 480px threshold
// with 48px of hysteresis, and `chromeDockShowsSelfName` — and the ONE thing it
// dropped on a narrow column was the self-name chip; every CONTROL was drawn at
// both fits. Owner request, 2026-09-08: "Please remove the presence icon from
// the control bar." With the chip gone the ladder had no subject, so it was
// deleted rather than left standing as a policy about nothing.
//
// WHAT IS LOST, AND WHY IT IS AFFORDABLE: the chip was your own name in the
// colour peers see your cursor in, so "which cursor is me" could be checked
// against it. It was never the only copy — your cursor carries the same name
// and the same colour, from the same `colorForName`.
//
// IF A BAR ITEM EVER NEEDS TO BE WIDTH-GATED AGAIN, it comes back here as a
// named ladder with its own unit tests, not as an `if` in the .tsx —
// canvas/pages/page-tabs-fit.ts is the surviving worked example, and this
// module's header says why a rule written inline in a component is a rule no
// test in this project can read.

// ---------------------------------------------------------------------------
// THE PALETTE.
//
// Shared BB theme tokens also resolve for menus portalled to document.body.

/** The chrome's own text, one stack, declared once — same reason the presence
 * dock has a UI_FONT: a portalled node inherits nothing, and a font written in
 * two places becomes two fonts. */
export const CHROME_FONT = '12px/1.35 -apple-system, "Segoe UI", system-ui, sans-serif';

export const CHROME_INK = "var(--foreground)";
export const CHROME_PAPER = "var(--card)";
/** An input's own surface — brighter than the card, so a field reads as a
 * field. */
export const CHROME_FIELD = "var(--background)";
export const CHROME_ACCENT = "var(--primary)";
export const CHROME_HAIRLINE = "var(--border)";
export const CHROME_FAINT = "var(--border)";
export const CHROME_MUTED = "var(--muted-foreground)";
/** A tab that is NOT the current one: pushed back behind the card's surface
 * rather than tinted a different hue, so "recessed" survives being looked at
 * quickly. */
export const CHROME_RECESS = "var(--muted)";

/**
 * What makes the card legible over arbitrary drawn content.
 *
 * The card floats over whatever people drew — a dark sticky, a photo, a dense
 * sketch. An opaque paper fill plus a hairline border plus this shadow is what
 * separates it from that content; the shadow is deeper and softer than the
 * popover's because this box sits ON the surface it must be distinguished from,
 * rather than hanging off a bar in the host's own chrome.
 *
 * NOT VERIFIED AGAINST REAL CONTENT — there is no browser here, and no
 * screenshot of the bar over a dark sticky has been taken.
 */
export const CHROME_SHADOW = "0 6px 24px rgba(15,23,42,0.28)";

/**
 * The lift under a <body>-portalled popover hanging off this chrome.
 *
 * A DIFFERENT SHADOW FROM CHROME_SHADOW ON PURPOSE, not a duplicate: this box
 * is detached from the surface entirely (it escapes the panel to <body>), so it
 * is thrown further and softer than the card, which sits ON the canvas. Moved
 * here from PageSwitcher.tsx only so that one palette file holds every colour
 * the chrome paints — the value is unchanged from what that file drew.
 */
export const CHROME_POPOVER_SHADOW = "0 10px 30px rgba(0,0,0,0.25)";
