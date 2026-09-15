// Run: bun src/StylePanel.position.test.ts
// Review fix (post-Task P4) — pins `clampPanelPosition`'s ON-SCREEN
// guarantee: given the selection's screen-space corners, the viewport size,
// and the panel's MAXIMUM rendered size, the returned `{left, top, transform}` position must place the
// panel's REAL on-screen box (after the transform) entirely within
// [0, viewportWidth] x [0, viewportHeight] (a small MARGIN inside that, per
// the function's own contract).
//
// WHY A UNIT TEST, NOT JUST THE BROWSER CONTRACT: the P3 browser contract
// (style-applies-to-selection) seeds two shapes CENTERED in the viewport, so
// its own midX never approaches an edge — it structurally cannot exercise
// this clamp's edge cases. This test drives the pure math directly with an
// anchor near the LEFT edge and near the RIGHT edge instead.
//
// BUG THIS CATCHES (found in code review of Task P4's first pass): the
// original fix clamped only the panel's ANCHOR point to
// [EDGE_CLAMP, viewportWidth - EDGE_CLAMP] with EDGE_CLAMP=90, then centered
// the panel with `translateX(-50%)`. For a 320px panel (160 > 90), a
// panel anchored 90px from an edge still had its actual edge land up to
// (160-90)=70px past the viewport boundary — invisible to the browser
// contract (centered scene) but real for any edge-anchored selection.
import assert from 'node:assert/strict'
import { avoidAnchorOverlap, clampPanelPosition, popoverPosition } from './StylePanel.js'

const VIEWPORT = { width: 1280, height: 720 }
const PANEL_SIZE = { width: 320, height: 200 }
const MARGIN = 8
const FLIP_HEADROOM = 220

/** The panel's REAL on-screen left/right edges, given the CSS this function
 * always returns: `left` + `transform: translateX(-50%)` (both horizontal
 * branches use it) means the rendered box spans `[left - width/2, left +
 * width/2]` — never `[left, left + width]` as a naive reading of `left`
 * alone would suggest. */
function horizontalEdges(left: number, width: number): { readonly leftEdge: number; readonly rightEdge: number } {
	return { leftEdge: left - width / 2, rightEdge: left + width / 2 }
}

// ============================================================================
// 1. Anchor near the LEFT edge (screen-center x=10) — the below-placement
//    branch (a low `minY` forces "below" — see FLIP_HEADROOM). A vertically
//    "low" (small y) box also selects this branch; use y=50 (< FLIP_HEADROOM)
//    so we're pinned to the same left/right-edge concern independent of
//    which vertical branch runs.
// ============================================================================
{
	const c1 = { x: 6, y: 50 }
	const c2 = { x: 14, y: 90 } // tiny 8x40 selection box, center x=10
	const pos = clampPanelPosition(c1, c2, VIEWPORT, PANEL_SIZE, MARGIN, FLIP_HEADROOM)
	const { leftEdge, rightEdge } = horizontalEdges(pos.left, PANEL_SIZE.width)
	assert.ok(
		leftEdge >= 0 && rightEdge <= VIEWPORT.width,
		`panel anchored near the LEFT edge (x=10) must stay fully on-screen — got left=${pos.left}, edges=[${leftEdge}, ${rightEdge}], viewport width=${VIEWPORT.width}`,
	)
	console.log(`ok: clampPanelPosition — left-edge anchor (x=10) keeps the panel on-screen (left=${pos.left}, edges=[${leftEdge}, ${rightEdge}])`)
}

// ============================================================================
// 2. Anchor near the RIGHT edge (screen-center x = viewportWidth - 10).
// ============================================================================
{
	const rightX = VIEWPORT.width - 10
	const c1 = { x: rightX - 4, y: 50 }
	const c2 = { x: rightX + 4, y: 90 }
	const pos = clampPanelPosition(c1, c2, VIEWPORT, PANEL_SIZE, MARGIN, FLIP_HEADROOM)
	const { leftEdge, rightEdge } = horizontalEdges(pos.left, PANEL_SIZE.width)
	assert.ok(
		leftEdge >= 0 && rightEdge <= VIEWPORT.width,
		`panel anchored near the RIGHT edge (x=${rightX}) must stay fully on-screen — got left=${pos.left}, edges=[${leftEdge}, ${rightEdge}], viewport width=${VIEWPORT.width}`,
	)
	console.log(`ok: clampPanelPosition — right-edge anchor (x=${rightX}) keeps the panel on-screen (left=${pos.left}, edges=[${leftEdge}, ${rightEdge}])`)
}

// ============================================================================
// 3. Vertical, "below" placement near the BOTTOM edge: a selection low
//    enough that minY < FLIP_HEADROOM (forcing "below") but whose maxY is
//    itself near the bottom of a SHORT viewport, so the panel's bottom edge
//    (top + panelHeight) must not spill past viewportHeight.
// ============================================================================
{
	const shortViewport = { width: 1280, height: 260 } // panel (h=200) barely fits
	const c1 = { x: 636, y: 200 }
	const c2 = { x: 644, y: 240 } // low in a short viewport, minY(200) < FLIP_HEADROOM
	const pos = clampPanelPosition(c1, c2, shortViewport, PANEL_SIZE, MARGIN, FLIP_HEADROOM)
	assert.equal(pos.transform, 'translateX(-50%)', 'precondition: minY < FLIP_HEADROOM selects the below-placement branch')
	const topEdge = pos.top
	const bottomEdge = pos.top + PANEL_SIZE.height
	assert.ok(
		topEdge >= 0 && bottomEdge <= shortViewport.height,
		`below-placed panel must stay within the (short) viewport vertically — got top=${topEdge}, bottom=${bottomEdge}, viewport height=${shortViewport.height}`,
	)
	console.log(`ok: clampPanelPosition — below-placement in a short viewport keeps the panel's bottom edge on-screen (top=${topEdge}, bottom=${bottomEdge})`)
}

// ============================================================================
// 4. Vertical, "above" placement near the TOP edge: minY >= FLIP_HEADROOM
//    (selects "above") but only just — not enough real headroom for a
//    PANEL_SIZE.height-tall panel above the selection, so the panel's TOP
//    edge (bottom - panelHeight) must not go negative.
// ============================================================================
{
	const c1 = { x: 636, y: FLIP_HEADROOM + 4 } // just above the flip threshold -> "above" branch
	const c2 = { x: 644, y: FLIP_HEADROOM + 40 }
	const pos = clampPanelPosition(c1, c2, VIEWPORT, PANEL_SIZE, MARGIN, FLIP_HEADROOM)
	assert.equal(pos.transform, 'translate(-50%, -100%)', 'precondition: minY >= FLIP_HEADROOM selects the above-placement branch')
	const bottomEdge = pos.top // `top` IS the bottom edge under translateY(-100%)
	const topEdge = bottomEdge - PANEL_SIZE.height
	assert.ok(
		topEdge >= 0 && bottomEdge <= VIEWPORT.height,
		`above-placed panel with barely enough headroom must not push its TOP edge negative — got top=${topEdge}, bottom=${bottomEdge}`,
	)
	console.log(`ok: clampPanelPosition — above-placement with minimal headroom keeps the panel's top edge on-screen (top=${topEdge}, bottom=${bottomEdge})`)
}

// ============================================================================
// 5. REGRESSION PIN — `avoidAnchorOverlap`'s whole reason to exist: a
//    below-placement selection in a viewport too short to fit a 480px panel
//    fully past the selection's bottom edge. `clampPanelPosition`
//    alone (still correctly, on its own on-screen contract — case 3 above)
//    squeezes `top` back UP to keep a worst-case-height box on-screen, which
//    for an actually-short real panel drags its rendered controls on top of
//    the selection itself — this is EXACTLY the double-click-to-edit /
//    delete / drag-a-selected-shape regression (a color swatch silently ate
//    the click meant for the shape underneath it; reproduced empirically
//    with a 1280x680 viewport, a 200x200 note anchored at screen (300,220),
//    numbers pulled directly from the failing e2e case). `avoidAnchorOverlap`
//    must reposition the panel back to the selection's own edge (no overlap,
//    ever) and shrink it (via the returned `maxHeight`) to fit, while STILL
//    keeping the panel's real (dynamically-sized) box fully on-screen.
// ============================================================================
{
	const viewport = { width: 1280, height: 680 } // matches the e2e case's real viewport (720 minus the 40px toolbar)
	const panelSize = { width: PANEL_SIZE.width, height: 480 }
	const c1 = { x: 200, y: 120 } // note top-left, screen-space (ANCHOR (300,220) minus half a 200x200 note)
	const c2 = { x: 400, y: 320 } // note bottom-right
	const clamped = clampPanelPosition(c1, c2, viewport, panelSize, MARGIN, FLIP_HEADROOM)
	assert.equal(clamped.transform, 'translateX(-50%)', 'precondition: minY(120) < FLIP_HEADROOM(220) selects the below-placement branch')
	assert.ok(clamped.top < c2.y + MARGIN, `precondition: clampPanelPosition alone squeezes top (${clamped.top}) above the selection's bottom edge + margin (${c2.y + MARGIN}) — this is the bug avoidAnchorOverlap fixes`)

	const fixed = avoidAnchorOverlap(clamped, c1, c2, viewport, MARGIN)
	assert.equal(fixed.top, c2.y + MARGIN, `panel repositioned to sit right after the selection's bottom edge, not squeezed into it — got top=${fixed.top}`)
	assert.ok(fixed.maxHeight !== undefined && fixed.maxHeight > 0, `a positive dynamic maxHeight is returned — got ${fixed.maxHeight}`)
	// NO OVERLAP: the panel's real top edge must be at or below the
	// selection's own bottom edge — never inside [minY, maxY].
	assert.ok(fixed.top >= c2.y, `panel's top edge (${fixed.top}) does not land inside the selection's own bounds (bottom=${c2.y})`)
	// STILL ON-SCREEN: bottom edge (top + the dynamic height budget) must not
	// exceed the viewport, same guarantee clampPanelPosition itself pins in
	// case 3 above — just computed against the REAL (dynamic) height, not a
	// hardcoded worst-case one.
	const bottomEdge = fixed.top + fixed.maxHeight!
	assert.ok(bottomEdge <= viewport.height, `panel's dynamically-sized bottom edge (${bottomEdge}) stays within the viewport (${viewport.height})`)
	console.log(`ok: avoidAnchorOverlap — a below-placement squeeze is repositioned off the selection (top=${fixed.top}, maxHeight=${fixed.maxHeight}) and stays fully on-screen`)
}

// ============================================================================
// 6. avoidAnchorOverlap is a no-op when clampPanelPosition never needed to
//    squeeze (plenty of room below the selection) — it must not perturb an
//    already-correct, already-non-overlapping position.
// ============================================================================
{
	const viewport = VIEWPORT // the roomy 1280x720 default used throughout this file
	const c1 = { x: 636, y: 50 }
	const c2 = { x: 644, y: 90 } // tiny selection, tons of room below in a tall viewport
	const clamped = clampPanelPosition(c1, c2, viewport, PANEL_SIZE, MARGIN, FLIP_HEADROOM)
	const fixed = avoidAnchorOverlap(clamped, c1, c2, viewport, MARGIN)
	assert.deepEqual(fixed, clamped, `no squeeze needed — avoidAnchorOverlap returns clampPanelPosition's result unchanged (no maxHeight override) — clamped: ${JSON.stringify(clamped)}, fixed: ${JSON.stringify(fixed)}`)
	console.log('ok: avoidAnchorOverlap — a no-op when clampPanelPosition never squeezed (plenty of room)')
}

// ============================================================================
// 7. LAYOUT DEFECT (b), style-memory task — TALL PANEL / GEO CASE:
//    `avoidAnchorOverlap`'s below-placement squeeze must flip to ABOVE
//    placement when that gives strictly more room than squeezing below would
//    — the reported bug (v2-geo-selected.png): a geo selection near the
//    bottom of a short-ish viewport forced BELOW placement (clampPanelPosition
//    picked "below" because minY < FLIP_HEADROOM), got squeezed into a sliver
//    of room below the selection, and the geo/"Shape" row (last of six groups)
//    rendered mostly off the bottom of the viewport. A selection whose top is
//    close to the viewport top (small minY, so clampPanelPosition's own
//    branch choice is "below") but whose BOTTOM sits deep in a short viewport
//    (little room actually below it) is exactly this shape: below-room is
//    tiny, above-room is comparatively larger — avoidAnchorOverlap must
//    prefer the roomier side instead of mechanically honoring the
//    branch clampPanelPosition already committed to.
// ============================================================================
{
	const viewport = { width: 1280, height: 300 } // short viewport, geo-panel-scale content
	const c1 = { x: 636, y: 80 } // minY(80) < FLIP_HEADROOM(220) -> clampPanelPosition picks "below"
	const c2 = { x: 644, y: 280 } // maxY(280) close to the viewport's own bottom (300) -> almost no room below
	const clamped = clampPanelPosition(c1, c2, viewport, PANEL_SIZE, MARGIN, FLIP_HEADROOM)
	assert.equal(clamped.transform, 'translateX(-50%)', 'precondition: minY < FLIP_HEADROOM selects the below-placement branch')

	const fixed = avoidAnchorOverlap(clamped, c1, c2, viewport, MARGIN)
	assert.equal(
		fixed.transform,
		'translate(-50%, -100%)',
		`the tall-panel/short-viewport case must FLIP to above placement (more real room above the selection than below it) — fixed: ${JSON.stringify(fixed)}`,
	)
	assert.ok(fixed.maxHeight !== undefined && fixed.maxHeight > 0, `a positive dynamic maxHeight is returned after the flip — got ${fixed.maxHeight}`)
	// The flipped (above) box must still stay fully on-screen and never
	// overlap the selection's own bounds — same guarantees as case 5's
	// below-branch squeeze, just for the flipped direction.
	const bottomEdge = fixed.top // 'above' transform: `top` IS the box's bottom edge
	const topEdge = bottomEdge - fixed.maxHeight!
	assert.ok(topEdge >= 0, `the flipped panel's top edge (${topEdge}) must not go negative`)
	assert.ok(bottomEdge <= Math.min(c1.y, c2.y), `the flipped panel's bottom edge (${bottomEdge}) must not overlap the selection (top=${Math.min(c1.y, c2.y)})`)
	console.log(`ok: avoidAnchorOverlap — a tall panel with more room ABOVE than below flips placement instead of squeezing into a sliver below (top=${fixed.top}, maxHeight=${fixed.maxHeight})`)
}

// ============================================================================
// 8. The flip in case 7 must NOT fire when below-room is already the roomier
//    side (case 5's own scenario, re-affirmed) — avoidAnchorOverlap must not
//    flip gratuitously just because a squeeze happened at all.
// ============================================================================
{
	const viewport = { width: 1280, height: 680 }
	const panelSize = { width: PANEL_SIZE.width, height: 480 }
	const c1 = { x: 200, y: 120 }
	const c2 = { x: 400, y: 320 }
	const clamped = clampPanelPosition(c1, c2, viewport, panelSize, MARGIN, FLIP_HEADROOM)
	const fixed = avoidAnchorOverlap(clamped, c1, c2, viewport, MARGIN)
	assert.equal(fixed.transform, 'translateX(-50%)', 'below-room is still roomier here — must NOT flip to above')
	assert.equal(fixed.top, c2.y + MARGIN, 'unflipped squeeze behaves exactly as case 5 pins')
	console.log('ok: avoidAnchorOverlap — does not flip when the originally-chosen side is already the roomier one')
}

// ============================================================================
// 9. popoverPosition — opens on the side of the bar away from the selection,
//    centred on its trigger, clamped to the viewport.
// ============================================================================
{
	// Above the selection: popover opens above the bar, centred on its trigger.
	assert.deepEqual(
		popoverPosition({ left: 400, top: 300, width: 200, height: 40 }, { left: 420, width: 30 }, { width: 180, height: 60 }, { width: 1280, height: 720 }, 'above', 8),
		{ left: 345, top: 232, maxHeight: 60 },
	)
	// Below the selection: popover opens below the bar.
	assert.deepEqual(
		popoverPosition({ left: 400, top: 300, width: 200, height: 40 }, { left: 420, width: 30 }, { width: 180, height: 60 }, { width: 1280, height: 720 }, 'below', 8),
		{ left: 345, top: 348, maxHeight: 60 },
	)
	// Clamped at the viewport's left edge.
	assert.equal(popoverPosition({ left: 0, top: 300, width: 200, height: 40 }, { left: 4, width: 30 }, { width: 180, height: 60 }, { width: 1280, height: 720 }, 'below', 8).left, 8)
	console.log('ok: popoverPosition opens away from the selection and clamps')
}

// ============================================================================
// 10. popoverPosition never crosses back over the bar (and so the selection)
//     when the away side is short: it caps its height to the room there.
//     Geometry: 1280x680 viewport, selection y 200->500, bar below at 508.
// ============================================================================
{
	const viewport = { width: 1280, height: 680 }
	const popover = { width: 200, height: 220 }
	const below = { left: 500, top: 508, width: 215, height: 40 }
	const pos = popoverPosition(below, { left: 510, width: 32 }, popover, viewport, 'below', 8)
	assert.ok(pos.top >= below.top + below.height + 8, `below-bar popover starts past the bar's bottom edge — got top=${pos.top}`)
	assert.equal(pos.maxHeight, 680 - 556 - 8, `height capped to the room left below — got ${pos.maxHeight}`)
	assert.ok(pos.top + pos.maxHeight <= viewport.height - 8, 'capped popover stays on-screen')

	const above = { left: 500, top: 100, width: 215, height: 40 }
	const up = popoverPosition(above, { left: 510, width: 32 }, popover, viewport, 'above', 8)
	assert.ok(up.top + up.maxHeight <= above.top - 8, `above-bar popover ends before the bar's top edge — got bottom=${up.top + up.maxHeight}`)
	assert.equal(up.top, 8, 'capped above-bar popover starts at the viewport margin')
	assert.equal(up.maxHeight, 100 - 8 - 8, 'height capped to the room left above')
	console.log('ok: popoverPosition caps its height to the away-side room instead of overlapping the bar')
}

console.log('ok: StylePanel.position.test.ts — all cases passed')
