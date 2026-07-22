// Run: bun src/canvas-v2/StylePanel.position.test.ts
// Review fix (post-Task P4) — pins `clampPanelPosition`'s ON-SCREEN
// guarantee: given the selection's screen-space corners, the viewport size,
// and the panel's MAXIMUM rendered size (PANEL_MAX_WIDTH/PANEL_MAX_HEIGHT —
// real CSS caps on PANEL_STYLE, so the actual DOM node can never exceed
// them), the returned `{left, top, transform}` position must place the
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
// the panel with `translateX(-50%)`. Since PANEL_MAX_WIDTH/2 = 160 > 90, a
// panel anchored 90px from an edge still had its actual edge land up to
// (160-90)=70px past the viewport boundary — invisible to the browser
// contract (centered scene) but real for any edge-anchored selection.
import assert from 'node:assert/strict'
import { clampPanelPosition } from './StylePanel.js'

const VIEWPORT = { width: 1280, height: 720 }
const PANEL_SIZE = { width: 320, height: 200 } // mirrors PANEL_MAX_WIDTH/height-under-cap
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

console.log('ok: StylePanel.position.test.ts — all cases passed')
