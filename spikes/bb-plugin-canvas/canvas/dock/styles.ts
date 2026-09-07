// The strip's CSS, as a string the content script owns and its disposer removes.
//
// WHY NOT app.css. The plugin's imported stylesheet is Tailwind-compiled from
// the plugin's React sources, and the host keeps it alive for the lifetime of a
// content-script generation — so utility classes would in principle work. They
// are not used here because the class names in an imperative string are not
// obviously "source" to a Tailwind content scan, and a strip that silently
// loses its styling on a build-tool change is worse than one that carries its
// own. The SDK sanctions exactly this: "scripts may own dynamic DOM/style nodes
// only when their disposer removes them".
//
// COLOURS ARE SELF-CONTAINED AND THEME-NEUTRAL: bb's CSS variables are not a
// contract offered to plugins, so nothing here reads one. The strip itself is
// almost entirely colourless — the faces carry the same name-derived hues the
// canvas cursors do, and everything around them is a mid grey that reads on
// both bb themes. The separating ring between overlapping faces is a
// half-transparent grey rather than "the page background", for the same reason:
// we are not allowed to know what the page background is.
//
// THE STRIP IS BAR FURNITURE, NOT A PILL. No shadow, no slab, no border box, no
// backdrop blur, no background of its own — those all belonged to the floating
// dock this replaced, and every one of them is what made it read as something
// laid ON TOP of bb rather than part of it. Only the popover, which genuinely
// is laid on top, gets a surface.

import {
  FACE_GEOMETRY,
  INITIALS_FONT_PX,
  initialsLeftEdgePx,
  runWidthPx,
} from "./face-geometry.js";
import { POPOVER_Z_INDEX } from "./popover-place.js";
import { POPOVER_EDGE_MARGIN_PX } from "./popover-place.js";
import { maxBubblesFor } from "./squeeze.js";

/**
 * THE TWO TREES THIS SHEET STYLES, and they are two rather than one because the
 * popover left the strip.
 *
 * It was a child of the strip's root, positioned against it, and the user's
 * report was that it "shows behind the left side menu" — cut off dead on the
 * vertical line where bb's left navigation pane ends, the faces to the left of
 * that line GONE rather than dimmed. That is what an ancestor's
 * "overflow: hidden" does, not what losing a z-index does, so the popover was
 * moved out to be a child of <body> with an id of its own. See the header of
 * canvas/dock/popover-place.ts for the diagnosis and for how thin it is: there
 * is no browser in this spike and nothing about it was observed.
 *
 * BOTH IDS LIVE HERE, and canvas/dock/dock.ts imports them, so the sheet and
 * the elements cannot drift apart. The strip's used to be a private constant in
 * that file with the string repeated in this one — which was survivable while
 * there was one of them and is not now that a rule's scope decides which of two
 * trees it reaches.
 */
export const DOCK_ROOT_ID = "canvas-av-dock";

/** The popover's own root, on <body>. NOT a prefix relationship anybody may
 * rely on: `#canvas-av-dock-popover` starting with `#canvas-av-dock` is a trap
 * (canvas/dock/style-scope.ts's `isScopedUnder` exists for it), not a feature.
 */
export const DOCK_POPOVER_ID = "canvas-av-dock-popover";

/** The narrowest strip this control can honestly draw, in the prose above the
 * "flex: none" declaration. Derived rather than restated: the paragraph exists
 * to justify never shrinking the box, so a stale number in it is an argument
 * about a strip that no longer exists. */
const CRAMPED_FACE_COUNT = maxBubblesFor("cramped");
const CRAMPED_RUN_PX = runWidthPx("cramped", CRAMPED_FACE_COUNT);

/**
 * The whole strip at the `bare` tier, minus the count, in the same prose.
 *
 * Arithmetic off the declarations in this file and nothing else: the 14px mic
 * glyph (".dock-call"), 3px of padding each side (the tier rule below, shared
 * with cramped) and a 1px border each side (".dock-strip"). The bubble run is
 * "display: none" there and the count is "hidden" when the room is empty, so
 * both are out of the box tree — and with a single flex item left there are no
 * gaps either, which is the whole reason the run is removed rather than merely
 * emptied.
 *
 * DERIVED RATHER THAN TYPED for the same reason CRAMPED_RUN_PX is: the last
 * hand-copied number in this file's prose went stale the moment the geometry it
 * described moved. NOT MEASURED — there is no browser in this spike.
 */
const BARE_EMPTY_PX = 14 + 3 * 2 + 1 * 2;

/**
 * The widget's body text, declared ONCE and used at both roots.
 *
 * It is a constant rather than two literals because it now has to be written
 * twice — see the note on the popover's copy — and a font stack that exists in
 * two places is a font stack that will one day be two different fonts. The
 * value is exactly what `#canvas-av-dock` has always carried; nothing about it
 * was re-chosen here.
 */
const UI_FONT = '12px/1.35 -apple-system, "Segoe UI", system-ui, sans-serif';

export const DOCK_STYLES = `
/* The two in-bar placements — "before" (level 1: inside a thread header's
   action cluster, in front of the workflow buttons) and "row" (level 2: the
   trailing child of the header row) — are deliberately styled the same. The
   strip is a flex item in a flex line either way, and the whole point is that
   it does not announce which level of anchor.ts's chain it happens to be on.
   Only "fixed", below, needs rules of its own. */
#canvas-av-dock {
  /* NO "position: relative" ANY MORE, and its removal is deliberate rather than
     an oversight. It was here for one reason — "the popover is positioned
     against this box" — and the popover is now a child of <body> positioned
     against the viewport, so the declaration had no remaining purpose and a
     positioned box whose stated purpose has gone is an invitation to position
     something against it by accident. Nothing else inside this tree is out of
     flow: the only absolutely-positioned descendant anywhere in the dock is
     ".dock-video", and it positions against ".dock-bubble"'s own
     "position: relative". Removing it also cannot change what paints over what
     — "position: relative" with "z-index: auto" opens no stacking context, so
     there was never one here to lose. */
  display: flex;
  align-items: center;
  /* The same 4px bb's own action cluster uses between its buttons (gap-1).
     Inert as things stand — the strip is this box's only child now that the
     popover has left — and kept anyway, so that anything ever placed beside the
     strip lands on the host's rhythm rather than on one of ours. */
  gap: 4px;
  /* NEVER SHRINKS, AND THAT IS THE DECISION, not a default nobody revisited.
     It was reopened because of where the strip sits on a thread route: level 1
     of anchor.ts makes it the FIRST child of the header's action cluster, so
     when that row runs out of width the strip is the last thing to be pushed
     out and bb's own buttons are the first — the reverse of the polite
     arrangement, and the reason to ask whether it should give way instead.

     It should not, because flex-shrink shrinks a BOX and this box's contents
     are fixed: ".dock-bubble" is "flex: none" and the faces are sized in the
     squeeze tiers below, so a narrowed strip cannot lose a face — it can only
     become narrower than the run it contains. The strip sets no "overflow", so
     that run would spill out through the button's own rounded border and land
     on top of the bb button beside it; declaring "overflow: hidden" to contain
     it would instead slice a circle down the middle. A face cut in half reads
     as a rendering fault, and a control overlapping the host's is worse than
     the crowding it was meant to relieve — so both ends of that trade are worse
     than the row simply being full.

     THE TIERS ARE THE SHRINKING. canvas/dock/squeeze.ts already narrows the
     strip as its CONTAINER narrows, and it does it in whole faces with a dead
     band, so every intermediate state is a complete, legible strip rather than
     a clipped one. Arithmetic off the declarations below, NOT a measurement of
     the running app — there is no browser in this spike; and INTERPOLATED from
     canvas/dock/face-geometry.ts rather than typed, because the last version of
     this paragraph was a hand-copied 36px run that the cramped tier's geometry
     then moved out from under. The cramped tier draws ${CRAMPED_FACE_COUNT} faces of
     ${FACE_GEOMETRY.cramped.diameterPx}px overlapping by ${FACE_GEOMETRY.cramped.overlapPx}px — a ${CRAMPED_RUN_PX}px run — plus the 14px mic
     glyph, the 4px gap between them, 3px of padding each side and a 1px
     border: ${CRAMPED_RUN_PX + 26}px
     of box with no count badge (which is "hidden" when there is nothing left
     over, so it is out of the box tree and takes its gap with it). It is
     reached by removing content rather than by clipping it. How that compares
     to the width of bb's own header buttons is not recorded here because it was
     never measured.

     IT IS NOT THE FLOOR ANY MORE, and this paragraph used to say it was. Below
     cramped is the "bare" tier (its own block near the end of these rules), and
     it takes the whole run away rather than shrinking it again. The strip there
     is the mic glyph and the count: ${BARE_EMPTY_PX}px with the count hidden, and with a
     count on screen that plus one 4px gap plus however wide its digits render —
     a text measurement, which is not something this file gets to state. The
     argument above is unchanged by that; a tier that draws no faces has even
     less reason to be shrinkable, since there is no run left to spill.

     One more reason not to make it shrinkable: if it were the only item in the
     cluster with a shrink factor, the whole of any overflow would land on it
     alone, so the strip would collapse to a sliver while bb's buttons stayed
     full size. There is no width at which that looks better than the cramped
     tier. */
  flex: none;
  margin-left: 4px;
  color: #8b929c;
  font: ${UI_FONT};
}

/* The home route renders no <header> at all (canvas/dock/anchor.ts). The strip
   drops into the same 48px band at the top right rather than disappearing —
   still flat, still not a pill — and moves back into the row the instant one
   appears.

   The 10px top is the band the header row puts its own 28px controls in, so
   the strip does not move vertically when it swaps between the two placements.
   The 52px right clears the one control that route floats in the same corner:
   bb's right gutter is 16px and that button is 28px wide, so 16 + 28 + 8 keeps
   an 8px gap and covers nothing. Measured against the running app rather than
   guessed — a fixed overlay that sits ON a host button is exactly the kind of
   in-the-way this redesign exists to remove. */
#canvas-av-dock[data-dock-anchor="fixed"] {
  position: fixed;
  top: 10px;
  right: 52px;
  margin-left: 0;
  /* Above ordinary app content, BELOW modal layers. bb's dialogs, popovers and
     command palette sit at z-index 50+; a call control is not more important
     than the dialog you just opened, and an overlay that cannot be dismissed by
     the thing on top of it is a trap. */
  z-index: 45;
}

/* ---- the strip ----------------------------------------------------------- */
/*
   IT HAS TO LOOK LIKE ONE OF BB'S BUTTONS, so bb's own were measured first
   rather than guessed at. The reference is the panel toggle that sits three
   controls to the right of the strip in the same cluster, the one whose
   aria-label is 'Show right panel (Ctrl + J)' — read off the running app
   (bb 0.40.0, Dracula dark)
   with getComputedStyle:

     height / width      28px / 28px      (Tailwind h-[28px] w-[28px])
     border-radius       6px              (rounded-md)
     padding             0px              (p-0, it is icon-only)
     resting background  rgba(0,0,0,0)    — transparent
     border              none
     hover               hover:bg-state-hover   = foreground @ 13.8% alpha
     pressed / open      aria-pressed:bg-state-active,
                         data-[state=open]:bg-state-active
                                                = foreground @ 22.5% alpha
     focus               focus-visible:outline-none
                         focus-visible:ring-1 focus-visible:ring-ring
     motion              transition-colors duration-150 hover:duration-0
     cursor              pointer

   Everything below is that contract, with two deliberate departures.

   1. IT DOES NOT REST TRANSPARENT. bb's icon buttons are recognisable at rest
      because they are 28x28 squares holding one 16px lucide glyph — the SHAPE
      is the affordance. The strip is a huddle of avatars, which at rest read as
      a decoration rather than a control (they did: "perhaps we can just wrap it
      so it looks a bit like a button"). So it carries a hairline border and a
      faint fill, and the affordance exists BEFORE the pointer arrives.

   2. THE COLOURS ARE A FIXED MID GREY, not bb's variables. "--state-hover" and
      "--state-active" are alpha ramps on "--foreground", which is near-white on
      a dark theme and near-black on a light one — and reaching into a host's
      CSS variables is not a contract offered to plugins (see the note at the
      top of this file). rgb(128,134,145) at the alphas below lands within a few
      points of bb's own on BOTH ends: over the dark theme's #282a36, hover
      computes to about rgb(69,72,84) against bb's rgb(69,70,80); over a white
      background it computes to about rgb(213,215,219) against bb's
      rgb(220,220,220). A mid grey is the one hue that can do that.

   ONE CONTROL, NOT TWO. An earlier version of this block styled the strip and
   a 📜 transcript button together, because a bordered strip beside a
   borderless glyph read as one control and one piece of stray text. The
   transcript button has since moved into the popover (".dock-transcript",
   below, on the ".dock-btn" treatment its neighbours there wear): bb's header
   row is the scarce surface — on a narrow screen it holds the page title and
   everything bb itself wants there — and the popover, which we open on demand,
   is not. So the measurements above now describe exactly one thing. */

#canvas-av-dock .dock-strip {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 5px;
  border: 1px solid rgba(128, 134, 145, 0.38);
  /* 6px, not the 8px this used to be: rounded-md is what every control in that
     row is cut to. */
  border-radius: 6px;
  background: rgba(128, 134, 145, 0.14);
  color: inherit;
  font: inherit;
  cursor: pointer;
  /* bb's transition-colors duration-150 hover:duration-0 — a considered fade
     out, an instant response in. */
  transition: background-color 150ms, border-color 150ms, box-shadow 150ms;
}

/* A PLAIN :hover, where bb's Tailwind utilities are wrapped in
   "@media (hover: hover)". The difference is deliberate and it is a trade:
   media-gating costs nothing on a desktop and avoids a highlight that sticks
   after a tap on a touch screen, but it silently removes the affordance on
   every surface whose UA reports a coarse pointer — and that set is wider than
   it sounds. Measured while verifying this change: the headless Chromium used
   to review it reports "(hover: none)" and "(pointer: coarse)", so bb's OWN
   button hovers never paint there. An affordance that disappears on a UA
   sniff is worse than a highlight that clears on the next tap, and :active
   below answers a tap anyway. */
#canvas-av-dock .dock-strip:hover {
  background: rgba(128, 134, 145, 0.3);
  border-color: rgba(128, 134, 145, 0.48);
  transition-duration: 0s;
}

/* Pressed. This is what a push paints on a CLOSED strip.

   It is NOT what an already-open one paints, though an earlier version of this
   comment claimed so: the toggled rules below have equal specificity (one id
   plus two class-equivalents each) and come later in the sheet, so they win.
   Measured with a held pointer while the popover was open — 0.46, the
   toggled+hover value, not the 0.50 below. The intent still holds by a
   different route: pushing an open strip moves it 0.42 -> 0.46, so the control
   always answers. Raise this rule's specificity if that ever needs to be the
   0.50 step instead. */
#canvas-av-dock .dock-strip:active {
  background: rgba(128, 134, 145, 0.5);
  border-color: rgba(128, 134, 145, 0.62);
  transition-duration: 0s;
}

/* TOGGLED, not merely clicked. The strip is a <button aria-expanded> that owns
   a popover, and bb draws exactly this state on its own toggles
   ("data-[state=open]:bg-state-active"). The inset line is the extra half-word
   that says "held down" rather than "hovered" — a hover and an open popover
   must not look the same, because one of them is a state you have to click
   again to leave. */
#canvas-av-dock[data-dock-expanded="true"] .dock-strip {
  background: rgba(128, 134, 145, 0.42);
  border-color: rgba(128, 134, 145, 0.58);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.22);
}

#canvas-av-dock[data-dock-expanded="true"] .dock-strip:hover {
  background: rgba(128, 134, 145, 0.46);
}

/* A REAL focus ring, because it is a real button and always was. bb uses
   "ring-1 ring-ring" — one pixel of the theme's accent — which we cannot read;
   two pixels of the same mid grey, offset clear of the border, is the
   theme-neutral equivalent that stays visible on both ends of the range.
   ":focus-visible" and not ":focus", so a mouse click does not leave a ring
   behind. */
#canvas-av-dock .dock-strip:focus-visible {
  outline: 2px solid rgba(150, 157, 168, 0.95);
  outline-offset: 1px;
}

#canvas-av-dock .dock-bubbles {
  display: flex;
  align-items: center;
}

/* ---- the faces, in BOTH trees -------------------------------------------

   THE NEXT FOUR RULES NAME TWO ROOTS EACH, and that is the cost of the popover
   moving to <body>. "renderBubbles" (canvas/dock/dock.ts) draws the same
   ".dock-bubble" markup twice — small and initials-only in the strip, big and
   video-carrying in the popover — and until the split one "#canvas-av-dock"
   scope reached both. It no longer does. A rule left on the strip's root alone
   goes on looking perfectly correct while the popover's faces quietly lose
   their border-radius, their overflow clip and their separator ring: there is
   no wrong-looking selector to notice.

   So it is checked mechanically instead. canvas/dock/style-scope.ts classifies
   every selector in this sheet by the classes it names, and requires a rule
   naming a class that exists in both trees to appear under both roots — as a
   selector list, as here, or as two rules; it does not care which.

   THE POPOVER'S OWN OVERRIDES ARE FURTHER DOWN (".dock-faces .dock-bubble"),
   and they still win by specificity and source order. These are the base each
   tree starts from.

   THE THREE NUMBERS ARE INTERPOLATED, not typed. Face size, overlap and glyph
   offset have to agree with each other — the overlap decides how much of a face
   its neighbour leaves showing, and that has to be wide enough for a capital —
   and three pixel literals per tier in a template string is the one arrangement
   in which nothing can check that. They live in canvas/dock/face-geometry.ts
   with tests/dock-face-geometry.test.ts on the relationship between them. */
#canvas-av-dock .dock-bubble,
#canvas-av-dock-popover .dock-bubble {
  position: relative;
  width: ${FACE_GEOMETRY.roomy.diameterPx}px;
  height: ${FACE_GEOMETRY.roomy.diameterPx}px;
  margin-left: -${FACE_GEOMETRY.roomy.overlapPx}px;
  flex: none;
  border: 0;
  border-radius: 50%;
  padding: 0;
  overflow: hidden;
  color: #fff;
  font: 600 ${INITIALS_FONT_PX}px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  /* The separator between overlapping faces. Drawn OUTSIDE the circle with
     box-shadow rather than by widening a border, so a face never changes size. */
  box-shadow: 0 0 0 1.5px rgba(128, 134, 145, 0.55);
}

/* INERT IN THE POPOVER and carried there anyway. Each of its faces is the first
   child of its own ".dock-face" column, so this would zero a margin the
   ".dock-faces .dock-bubble" rule below already zeroes with more specificity.
   Mirrored because the alternative is a per-rule judgement about which of these
   the popover happens to need today, and the one that gets that judgement wrong
   fails silently — the whole reason the check is mechanical. */
#canvas-av-dock .dock-bubble:first-child,
#canvas-av-dock-popover .dock-bubble:first-child {
  margin-left: 0;
}

/* The speaking ring, the same green the canvas cursor rings use. Also drawn
   with box-shadow, so a bubble does not resize when its owner starts talking
   and shove the whole row sideways. The popover overrides this with a heavier
   ring for its bigger faces, further down. */
#canvas-av-dock .dock-bubble[data-canvas-dock-speaking="true"],
#canvas-av-dock-popover .dock-bubble[data-canvas-dock-speaking="true"] {
  box-shadow: 0 0 0 2px #3fb96b;
}

/* YOU, in either row. This one is NOT inert in the popover — nothing there
   restates it, so before the mirror your own big face in the popover would have
   lost its dashed outline while the small one in the strip kept it. */
#canvas-av-dock .dock-bubble[data-canvas-dock-self="true"],
#canvas-av-dock-popover .dock-bubble[data-canvas-dock-self="true"] {
  outline: 1px dashed rgba(128, 134, 145, 0.75);
  outline-offset: 1px;
}

/* ---- the squeeze tiers ---------------------------------------------------
   THE SAME STRIP, WITH LESS ROOM. "data-dock-squeeze" is one of "roomy",
   "tight", "cramped" or "bare" — canvas/dock/squeeze.ts's four named layouts,
   chosen from how wide the container the strip sits in currently is.
   Everything above is the ROOMY tier, which is why there is no
   [data-dock-squeeze="roomy"] rule: the unsqueezed strip is the strip, and a
   tier that has to restate it is a second copy of it to keep in step.

   THE FIRST THREE ARE THE SAME STRIP; THE FOURTH IS NOT. "bare" draws no faces
   at all, so its rules are about the box rather than about the run: they are
   the padding rule it shares with cramped, and a block of its own at the end.

   THE PIXEL WIDTHS THE TIERS SWITCH AT ARE NOT HERE. They are
   SQUEEZE_ROOMY_MIN_PX, SQUEEZE_TIGHT_MIN_PX and SQUEEZE_BARE_MIN_PX in
   canvas/dock/squeeze.ts,
   with a hysteresis band around each, and a media query restating them in CSS
   would be a second set of thresholds drifting from the first — and it would be
   measuring the wrong thing anyway. The constraint is the width of the HEADER
   ROW, which inside a split pane is nothing like the width of the viewport a
   media query would answer about.

   SCOPED TO ".dock-strip", so the popover's faces are untouched by name rather
   than by luck of source order. The popover is a surface we open on demand and
   size ourselves; it is not the thing running out of room, and its faces are
   the deliberately bigger ones (".dock-faces .dock-bubble", further down).

   THE FACES GET SMALLER AND OVERLAP HARDER, AND NOTHING ELSE MOVES:

   * The strip stays 28px tall at every tier. That height is bb's own header
     button (see the measurements at the top of this file) and the strip has to
     keep lining up with the controls beside it however narrow the row gets.
   * The type stays 10px. It is at most two capitals (canvas/roster.ts's
     "initialsFor"), and it is the thing all this is being done FOR — faces you
     can still tell apart. A second variable shrinking alongside the circle
     would make the tier that most needs to be legible the least.
   * The separating ring and the speaking ring are both still drawn OUTSIDE the
     circle with box-shadow (see the base rules above), which is what makes a
     heavier overlap safe: a face that is half-covered is still exactly as wide
     as its neighbours, and one that starts speaking still does not shove the
     row sideways.

   HOLDING THE TYPE AT 10px IS A CLAIM ABOUT THE OVERLAP, AND IT USED TO BE A
   FALSE ONE. Keeping the glyph the same size is worth nothing if the next face
   is drawn on top of it, and at cramped it was: a 20px face pulled back by 12px
   left an 8px sliver, and two centred capitals sat at x 2.8-17.2, so every face
   but the last showed about 5px of a ~7px leading capital and nothing at all of
   the second — one clipped letter standing in for the name. The fix is
   in the numbers rather than in this paragraph — cramped now leaves 10px and
   pushes its glyph into it (the ".dock-initials" rule below) — and the
   arithmetic is checked in tests/dock-face-geometry.test.ts rather than
   asserted here. */

#canvas-av-dock[data-dock-squeeze="tight"] .dock-strip .dock-bubble {
  width: ${FACE_GEOMETRY.tight.diameterPx}px;
  height: ${FACE_GEOMETRY.tight.diameterPx}px;
  margin-left: -${FACE_GEOMETRY.tight.overlapPx}px;
}

#canvas-av-dock[data-dock-squeeze="cramped"] .dock-strip .dock-bubble {
  width: ${FACE_GEOMETRY.cramped.diameterPx}px;
  height: ${FACE_GEOMETRY.cramped.diameterPx}px;
  margin-left: -${FACE_GEOMETRY.cramped.overlapPx}px;
}

/* THE GLYPH MOVES INTO THE PART OF THE FACE THAT IS STILL VISIBLE — the only
   tier that needs this, and only on the faces that are actually covered.

   WHICH PART IS VISIBLE IS THE LEFT ONE. ".dock-bubbles" is a plain flex row
   and nothing in this sheet gives ".dock-bubble" a z-index, so paint order is
   DOM order and each face is drawn OVER the one before it. Getting that
   backwards would move the glyph the wrong way and hide it completely.

   ":not(:last-child)" is not a nicety. The trailing face has nothing on top of
   it, so its circle is whole and a glyph shoved to one side of it would read as
   a rendering fault rather than as a stack. Left-aligned on the covered faces
   and centred on the final one is what makes the run look like evenly spaced
   letters instead of a pile.

   "justify-content" has to be restated: the base rule centres the glyph, and a
   margin on a centred flex item shifts the item's MARGIN box rather than
   setting where its content starts, so the offset would come out at roughly
   half what face-geometry.ts reasoned about. The margin is on the inner span
   rather than as padding on the circle because nothing here declares
   "box-sizing" and this file does not get to assume bb's (see the top): padding
   on a "width: 20px" content box would make a 21.5px circle. */
#canvas-av-dock[data-dock-squeeze="cramped"] .dock-strip .dock-bubble:not(:last-child) {
  justify-content: flex-start;
}

#canvas-av-dock[data-dock-squeeze="cramped"] .dock-strip .dock-bubble:not(:last-child) .dock-initials {
  margin-left: ${initialsLeftEdgePx("cramped")}px;
}

/* ":first-child" has to be restated per tier: the base rule that zeroes it is
   "#canvas-av-dock .dock-bubble:first-child", which is one class-equivalent
   lighter than the tier rules above and would lose to them — pulling the run's
   leading face out through the strip's left border by the new overlap. */
#canvas-av-dock[data-dock-squeeze="tight"] .dock-strip .dock-bubble:first-child,
#canvas-av-dock[data-dock-squeeze="cramped"] .dock-strip .dock-bubble:first-child {
  margin-left: 0;
}

/* The strip's own side padding, which is 5px of empty box on each end.
   Trimming it buys back 4px without touching the border, the radius or the
   height — i.e. without the strip ceasing to look like one of bb's buttons,
   which is the one property this control is not allowed to lose.

   BOTH NARROW TIERS, one rule. It was cramped's alone when cramped was the
   floor; "bare" is narrower still and there is no argument for giving the
   narrowest tier back the padding the one above it gave up. */
#canvas-av-dock[data-dock-squeeze="cramped"] .dock-strip,
#canvas-av-dock[data-dock-squeeze="bare"] .dock-strip {
  padding: 0 3px;
}

/* ---- the bare tier -------------------------------------------------------
   THE ONE TIER THAT IS NOT "THE SAME STRIP, SMALLER". The three above shrink
   the faces and overlap them harder; this one stops drawing them.

   WHY, in the user's words, reported against a screenshot of a thread header
   with no title in it at all: "On narrow screens the presence icons hide the
   thread title (Perhaps if this is about to happen we should drop the presence
   icons and just keep the mic icon? ...) Thread title is important". So the
   faces go and the title gets the row back. Nothing is lost to the TIER — the
   popover draws the faces full size from a model the tier never reaches
   ("currentModels" in canvas/dock/dock.ts). Not "everyone", which would be an
   overclaim: that model still carries MAX_DOCK_BUBBLES, the strip's own
   legibility cap, and a room bigger than it folds the tail away in the popover
   too. That cap is a separate question and is untouched here.

   THE FACE COUNT IS NOT DECIDED HERE. canvas/dock/squeeze.ts's
   maxBubblesFor("bare") is 0 and canvas/dock/model.ts draws that literally,
   so at this tier ".dock-bubbles" is already empty. This rule is about the BOX,
   not about the contents.

   "display: none" AND NOT MERELY AN EMPTY SPAN, and that is the entire point of
   the rule. ".dock-strip" is a flex line with "gap: 4px", and a gap is charged
   between ITEMS regardless of their size — so an empty ".dock-bubbles" would go
   on holding 4px of the row open for a run that is not there, at the one tier
   that exists to hand width back. Taking it out of the box tree takes its gap
   with it. (Reasoned from the two declarations, not observed: there is no
   browser in this spike.)

   WHAT SURVIVES, deliberately: the border, the radius, the height, the hover /
   pressed / toggled / focus-visible treatments, and the mic glyph with its
   in-call colour. This is still a button that opens the popover, and at the
   width where it holds least it can least afford to stop looking like one. */
#canvas-av-dock[data-dock-squeeze="bare"] .dock-bubbles {
  display: none;
}

#canvas-av-dock .dock-overflow {
  padding-left: 2px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/* The 2px above separates the count from the face run to its left. At "bare"
   there is no run to its left — the count is the leading item in the line — so
   the separator would be 2px of nothing between the strip's own padding and the
   first digit. canvas/dock/model.ts's "overflowLabel" drops the "+" here for
   the same reason: with no faces beside it, "+3" is a plus sign with nothing to
   add to. */
#canvas-av-dock[data-dock-squeeze="bare"] .dock-overflow {
  padding-left: 0;
}

/* The quiet "you are in a call" tell, and the thing left to click when there
   are no faces to click: a mic glyph, grey while you are out of the call, green
   while you are in it, and warm red while you are in it muted.

   TWO WAYS THE FACES CAN BE ABSENT NOW, and this glyph is the affordance in
   both: an empty room, and the "bare" tier, where the room is full but the run
   is not drawn. It is "flex: none" and no tier rule names it, so it is the same
   14px glyph at every tier — which is what keeps the strip recognisable as the
   control that opens the popover once the faces have gone. */
#canvas-av-dock .dock-call {
  width: 14px;
  height: 14px;
  flex: none;
  opacity: 0.75;
}

#canvas-av-dock[data-dock-phase="live"] .dock-call {
  color: #3fb96b;
  opacity: 1;
}

#canvas-av-dock[data-dock-phase="live"][data-dock-mic="muted"] .dock-call {
  color: #d98a8a;
}

/* ---- the popover -------------------------------------------------------- */

/* THIS BOX IS A CHILD OF <body>, NOT OF THE STRIP, and that is the fix rather
   than a tidy-up. The user's report was that the popover "shows behind the left
   side menu"; the screenshot cuts it off dead on the vertical line where bb's
   left navigation pane ends, with the faces to the left of that line GONE
   rather than dimmed. Deleted pixels are what an ancestor's "overflow: hidden"
   does — a z-index loser is painted UNDER an opaque box, which looks the same
   only where that box actually covers it, and here the cut lands where bb's own
   panel content does not reach. The popover's containing block used to be
   "#canvas-av-dock", which lives deep inside bb's panes, so any one of those
   ancestors could have been the scissors.

   "POSITION: FIXED" ALONE WOULD NOT HAVE BEEN ENOUGH, and this is the trap
   worth writing down: a fixed box is still clipped by — and re-based on — an
   ancestor carrying "transform", "filter", "backdrop-filter", "will-change" or
   "contain", any of which turns that ancestor into the fixed box's containing
   block. Modern app shells are full of them. Leaving the ancestor chain
   entirely is what makes the escape unconditional: parented to <body> there is
   no ancestor left to clip it and none to trap it in a foreign stacking
   context.

   NONE OF THIS WAS OBSERVED. There is no browser in this spike, so the clipping
   ancestor was never identified and this fix was never seen to work; the
   falsification is cheap and specific, and canvas/dock/popover-place.ts's
   header records it — if the same cut survives on <body>, it was never the
   ancestor chain and stacking is where to look next.

   THE VIEWPORT IS THE CONTAINING BLOCK, so this box has no resting position to
   hang from: "left: 0; top: 0" is a start line, not a placement, and the
   translate below is where it actually goes. Both numbers come from
   placePopoverBox in canvas/dock/popover-place.ts, which is why nothing in this
   rule mentions the strip. */
#canvas-av-dock-popover {
  position: fixed;
  left: 0;
  top: 0;
  /* ABOVE BB'S ORDINARY CHROME, BELOW ITS MODAL LAYERS — 45, the same number
     the strip's fixed placement carries, and it means MORE here than it used
     to. Inside "#canvas-av-dock" this box's z-index was resolved against
     whatever stacking context the nearest positioned-and-layered ancestor
     happened to open, so bb's pane could decide the outcome and 45 settled
     nothing. On <body> there is no such ancestor: 45 is compared in the root
     stacking context, against bb's own top-level layers, which is the only
     arrangement in which choosing a number is choosing an answer.

     WHY NOT HIGHER. bb's dialogs, popovers and command palette sit at 50+ (the
     figure this file already carried; not re-measured for this change and not
     verifiable here). A call control is not more important than the dialog you
     just opened, and an overlay that cannot be dismissed by the thing on top of
     it is a trap. WHY NOT LOWER: the whole point of leaving the pane is to be
     paintable over it.

     THE DIGITS NOW LIVE IN canvas/dock/popover-place.ts (POPOVER_Z_INDEX), not
     here, because a second <body>-portalled popover has since arrived — the
     page switcher's — and two files each choosing a layer is how one of them
     silently loses this argument. This rule interpolates that constant.

     WHAT IS NOT KNOWN: the z-index of the pane that was doing the clipping was
     never read, so "45 is above bb's ordinary chrome" is inherited belief
     rather than a measurement. If the popover now escapes its clip but still
     paints under something, this is the number to look at first — and that
     would ALSO be the evidence that the clipping diagnosis above was wrong. */
  z-index: ${POPOVER_Z_INDEX};
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: max-content;
  /* THIS CAP LEAVES THE CLAMP'S DEGENERATE BRANCH UNREACHABLE AT ANY WIDTH A
     BROWSER WINDOW CAN ACTUALLY BE, which is worth stating because
     popover-place.ts carries that branch for a popover too wide to satisfy both
     margins, and this is why it is there for totality rather than because we
     expect to arrive in it.

     THE ARITHMETIC IS ON THE BORDER BOX, because that is what dock.ts measures
     ("offsetWidth") and what the margins are checked against. "max-width"
     bounds the CONTENT box unless a host reset has already made this element
     "border-box" — nothing here declares one, and this file does not get to
     assume bb's (see the top of the file) — so the honest worst case is the cap
     plus this box's own 10px padding and 1px border on each side: 22px.

     Against POPOVER_EDGE_MARGIN_PX (8px, canvas/dock/popover-place.ts) a
     viewport of width W leaves W - 16 of legal room. The 80vw arm therefore
     asks for 0.8W + 22, and 0.8W + 22 <= W - 16 for every W >= 190. The 420px
     arm only binds once 80vw exceeds 420, i.e. above W = 525, and there it asks
     442 against at least 509. Below about 190px the degenerate branch does
     become reachable, and its answer is the right one anyway — it pins the LEFT
     edge, the end the content reads from.

     The cap was left exactly as it was rather than restated in terms of the
     margin: rewriting a rule that is already correct only creates a second
     place for the number to be wrong. */
  max-width: min(80vw, 420px);
  /* WHERE IT ACTUALLY GOES, both axes, decided by placePopoverBox in
     canvas/dock/popover-place.ts and written onto this element by dock.ts.

     A TRANSFORM AND NOT "left"/"top", AND THE ARGUMENT GOT STRONGER RATHER THAN
     WEAKER WHEN THIS BOX WENT FIXED. A transform does not participate in layout
     at all, so applying it can neither invalidate the measurement it was
     computed from nor cost a second layout pass. Moving "left" instead WOULD
     now feed back: the containing block is the viewport, "width" is
     "max-content" and "right" is auto, so the room a shrink-to-fit width is
     solved against is "viewport width minus left" — write a left, get a
     different width, measure it, get a different left. When this box hung
     "right: 0" inside the strip that loop was only latent (an absolutely
     positioned box with a specified width has its offset solved for, not its
     width); as a fixed box it is live, and the transform is what keeps it out
     of reach. It is the same reason dock.ts reads "offsetWidth" here: layout
     width, which a transform cannot affect even in principle.

     THE FALLBACKS ARE THE SAFE CORNER, not "unmoved". An absolutely positioned
     popover had a resting position to fall back to and 0px meant "leave it";
     this one has none — the transform IS the position, and 0px would park it in
     the viewport's top-left corner, on top of bb's own chrome. So the defaults
     are the same margin placePopoverBox itself falls back to when it cannot
     read the anchor, INTERPOLATED from POPOVER_EDGE_MARGIN_PX rather than typed
     so the sheet and the module cannot disagree about where "somewhere
     certainly on-screen" is. Reached only in the window before the first
     measurement, which "render" closes synchronously in the same task that
     unhides the box. */
  transform: translate(
    var(--dock-popover-x, ${POPOVER_EDGE_MARGIN_PX}px),
    var(--dock-popover-y, ${POPOVER_EDGE_MARGIN_PX}px)
  );
  padding: 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(23, 28, 34, 0.97);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  color: #d7dde4;
  /* THE ONE THING THE MOVE TOOK AWAY THAT NO SELECTOR SHOWS. Inside
     "#canvas-av-dock" this box inherited that rule's font, and the popover's
     text is built on the assumption that it did: ".dock-btn" says
     "font: inherit" outright, and ".dock-jump" and ".dock-status" set a SIZE
     with no family. A child of <body> inherits bb's typography instead —
     family, size and line-height — which is the one dependency the top of this
     file refuses everywhere else, since bb's theme is not a contract offered to
     plugins.

     Re-declared rather than re-chosen: this is the same value the strip's root
     carries and the popover has been drawing all along, shared through UI_FONT
     so the two roots cannot drift. NOT OBSERVED — there is no browser in this
     spike, so what bb's own body font actually is, and therefore how different
     the popover looked without this, was never seen. The invariant is checked
     mechanically instead: "rootsWithoutOwnFont" in canvas/dock/style-scope.ts
     asks every root this sheet owns for a font of its own, because none of them
     has an ancestor inside this sheet to inherit one from. */
  font: ${UI_FONT};
  cursor: default;
}

/* The fold. It is the ROOT that carries "hidden" now rather than a descendant
   of the strip, so this is "#id[hidden]" and not "#id .dock-popover[hidden]" —
   and it still has to be declared rather than left to the UA, because the rule
   above sets "display: flex" and that beats the UA's own
   "[hidden] { display: none }". */
#canvas-av-dock-popover[hidden] {
  display: none;
}

#canvas-av-dock-popover .dock-faces {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
}

/* One person: the face, and under it the sentence saying where in bb they are.
   BELOW the video, per the ask — the face itself keeps its own gesture (fly the
   canvas camera to their cursor), and this is a second, separate affordance. */
#canvas-av-dock-popover .dock-face {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  max-width: 96px;
}

#canvas-av-dock-popover .dock-jump {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 1.3;
  text-align: center;
  color: #9fb6d9;
  text-decoration: none;
}

#canvas-av-dock-popover .dock-jump[hidden] {
  display: none;
}

#canvas-av-dock-popover a.dock-jump:hover,
#canvas-av-dock-popover a.dock-jump:focus-visible {
  color: #cfe0f7;
  text-decoration: underline;
}

/* The same sentence when there is nowhere honest to send anybody — you, or
   somebody whose location is unknown or has gone stale. Readable, not
   clickable, and visibly so. */
#canvas-av-dock-popover .dock-jump-inert {
  color: rgba(198, 205, 216, 0.55);
  cursor: default;
}

#canvas-av-dock-popover .dock-faces:empty {
  display: none;
}

/* Bigger here — this is the "slightly larger things" the strip expands to show,
   and it is the only place a camera becomes a live tile. */
#canvas-av-dock-popover .dock-faces .dock-bubble {
  width: 44px;
  height: 44px;
  margin-left: 0;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.18);
}

#canvas-av-dock-popover .dock-faces .dock-bubble:disabled {
  cursor: default;
  opacity: 0.65;
}

#canvas-av-dock-popover .dock-faces .dock-bubble[data-canvas-dock-speaking="true"] {
  box-shadow: 0 0 0 2px #3fb96b;
}

#canvas-av-dock-popover .dock-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  background: #11141a;
}

/* ".dock-faces" is in this selector to say what was previously only true by
   accident: a <video> is attached ONLY in the popover ("renderBubbles" is
   called with "video: true" here and "video: false" for the strip), so this is
   a rule about the popover's faces and not a shared one that happens never to
   fire in the strip. Naming a popover-only class is also what tells
   canvas/dock/style-scope.ts not to demand a strip twin for it — a rule for a
   state the strip can never be in. */
#canvas-av-dock-popover .dock-faces .dock-bubble[data-canvas-dock-video="true"] .dock-initials {
  visibility: hidden;
}

/* WRAPS, since the transcript button made this four labelled controls rather
   than three. The popover is "width: max-content" capped at "min(80vw, 420px)",
   so on a narrow viewport the cap binds and an unwrapped line would resolve by
   shrinking the buttons — squashing four labels instead of moving one onto a
   second line. Wrapping is the ONLY thing that changed here; the row is still
   one line everywhere it fits, which is everywhere the popover is not being
   squeezed. */
#canvas-av-dock-popover .dock-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

#canvas-av-dock-popover .dock-btn {
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

#canvas-av-dock-popover .dock-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
}

#canvas-av-dock-popover .dock-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

#canvas-av-dock-popover .dock-mic[data-canvas-dock-mic="muted"],
#canvas-av-dock-popover .dock-camera[data-canvas-dock-camera="on"] {
  border-color: rgba(63, 185, 107, 0.7);
}

/* The transcript button needs no geometry of its own — it is a ".dock-btn"
   with a word in it, exactly like the three beside it, which is the whole
   argument for moving it here off bb's header row.

   The one rule it does get is this. ".dock-btn" above sets no "display", so
   the UA's own "[hidden] { display: none }" already hides it today; this pins
   that, because it is hidden on every non-thread route (the common case, not
   an edge one) and a later "display: inline-flex" on .dock-btn would otherwise
   turn a control with nowhere to go back on with nothing to notice it. */
#canvas-av-dock-popover .dock-transcript[hidden] {
  display: none;
}

#canvas-av-dock-popover .dock-status {
  margin: 0;
  max-width: 320px;
  color: #f0b8b8;
  font-size: 11px;
}

/* THE ONE RULE THAT REACHED ACROSS THE SPLIT. It used to key on an attribute of
   the strip's root and hide a descendant of it; the status line is no longer a
   descendant of that root, so the attribute is MIRRORED onto the popover by
   dock.ts and the rule reads it there. The strip's root keeps its copy: it is a
   read-back other things grep for ("#canvas-av-dock[data-dock-status]"), and
   dropping it to satisfy a stylesheet would break them for nothing. */
#canvas-av-dock-popover[data-dock-status=""] .dock-status {
  display: none;
}

/* ---------------------------------------------------------------------------
   THE SIDEBAR THREAD-ROW DECORATION

   NOT SCOPED TO EITHER OF THIS SHEET'S TWO ROOTS — not #canvas-av-dock and not
   #canvas-av-dock-popover — and deliberately so: these rules style nodes this
   plugin owns but that live in bb's own sidebar rows. Every one of them is removed by the content script's
   disposer, which is the condition the SDK attaches to exactly this ("Styling
   or decorating existing app-shell DOM belongs here rather than in an
   always-on frontend stylesheet"). They are scoped by our own attribute
   instead, so nothing here can reach a host node.

   Sized for a 28px row: 18px circles against the strip's 24px, overlapping by
   5px, with the same box-shadow separator so a face never changes size. The
   hue and the initials are the SAME per-person values the strip's bubbles and
   the canvas cursors use — that identity is the whole point of drawing these.
   --------------------------------------------------------------------------- */
[data-canvas-row-presence] {
  display: inline-flex;
  align-items: center;
  flex: none;
  margin-right: 2px;
  /* The row's own click target is an absolutely-positioned <a> covering the
     row, which paints above this static span — so a click here already reaches
     the row. Declining pointer events makes that a guarantee rather than a
     consequence of paint order, and it is why the accessible name is an
     aria-label rather than only a title. */
  pointer-events: none;
}

[data-canvas-row-presence] .canvas-row-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-left: -5px;
  flex: none;
  border-radius: 50%;
  color: #fff;
  font: 600 8px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
  letter-spacing: 0.02em;
  /* Same half-transparent grey the strip uses between overlapping faces: bb's
     CSS variables are not a contract offered to plugins, so nothing here reads
     one, and this reads on both themes. */
  box-shadow: 0 0 0 1.5px rgba(128, 134, 145, 0.55);
}

[data-canvas-row-presence] .canvas-row-face:first-child {
  margin-left: 0;
}

/* You, on the row you are reading: the same dashed outline your own face
   carries in the strip. */
[data-canvas-row-presence] .canvas-row-face[data-canvas-row-self="true"] {
  outline: 1px dashed rgba(128, 134, 145, 0.75);
  outline-offset: 1px;
}

[data-canvas-row-presence] .canvas-row-more {
  padding-left: 3px;
  color: #8b929c;
  font: 500 9px/1 -apple-system, "Segoe UI", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
`;
