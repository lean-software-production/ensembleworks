/**
 * Pure frame-navigation helpers for the Frames drawer. Run:
 * bun client/src/chrome/frameNav.test.ts
 *
 * No tldraw runtime import (type-only, so it runs under bare bun). The one
 * editor-touching helper (jumpCameraToFrame) is exercised through a duck-typed
 * editor — the kernel/roomHooks.test.ts precedent.
 */
import assert from 'node:assert/strict'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import {
	DRAWER_WIDTH,
	drawerRightOffset,
	drawerWidth,
	framesFromShapes,
	isDrawerVisible,
	jumpCameraToFrame,
	sortFrames,
} from './frameNav'

// --- framesFromShapes: keep only frames, read props.name, sorted, blank → "Frame" ---
{
	const shapes = [
		{ id: 'shape:a', type: 'frame', props: { name: 'Brief lessons' } },
		{ id: 'shape:t', type: 'terminal', props: {} },
		{ id: 'shape:b', type: 'frame', props: { name: 'advice — crew A' } },
		{ id: 'shape:c', type: 'frame', props: { name: '' } },
	] as unknown as TLShape[]

	const out = framesFromShapes(shapes)
	assert.deepEqual(
		out.map((f) => f.name),
		['advice — crew A', 'Brief lessons', 'Frame'],
		'non-frames dropped; case-insensitive sort; blank name → "Frame"'
	)
	assert.ok(!out.some((f) => f.id === ('shape:t' as TLShapeId)), 'terminal shape is not a frame')
	assert.deepEqual(out.map((f) => f.id), ['shape:b', 'shape:a', 'shape:c'], 'ids travel with names')
}

// --- sortFrames: case-insensitive AND numeric-aware, stable, non-mutating ---
{
	const input = [
		{ id: 'shape:2' as TLShapeId, name: 'Pair huddle 10' },
		{ id: 'shape:1' as TLShapeId, name: 'Pair huddle 2' },
	]
	const out = sortFrames(input)
	assert.deepEqual(out.map((f) => f.name), ['Pair huddle 2', 'Pair huddle 10'], 'numeric-aware: 2 before 10')
	assert.deepEqual(input.map((f) => f.name), ['Pair huddle 10', 'Pair huddle 2'], 'input array is not mutated')
}

// --- drawerRightOffset: anchors to the panel width, hides (null) when railed ---
{
	const expanded = { collapsed: false, forcedRail: false }
	assert.equal(drawerRightOffset({ width: 280, ...expanded }), 280, 'anchors flush to the panel width')
	assert.equal(drawerRightOffset({ width: 500, ...expanded }), 500, 'tracks the resized width')
	assert.equal(drawerRightOffset({ width: 280, collapsed: true, forcedRail: false }), null, 'collapsed rail → no drawer')
	assert.equal(
		drawerRightOffset({ width: 280, collapsed: false, forcedRail: true }),
		null,
		"Present's forced rail → no drawer, even though layout.collapsed is still false"
	)
}

// --- isDrawerVisible: (pinned OR peeking) AND not railed (collapsed OR Present) ---
{
	const expanded = { collapsed: false, forcedRail: false }
	assert.equal(isDrawerVisible({ pinned: false, peeking: false }, expanded), false, 'closed')
	assert.equal(isDrawerVisible({ pinned: true, peeking: false }, expanded), true, 'pinned shows')
	assert.equal(isDrawerVisible({ pinned: false, peeking: true }, expanded), true, 'peek shows')
	assert.equal(
		isDrawerVisible({ pinned: true, peeking: true }, { collapsed: true, forcedRail: false }),
		false,
		'collapsed always hides'
	)
	assert.equal(
		isDrawerVisible({ pinned: true, peeking: false }, { collapsed: false, forcedRail: true }),
		false,
		"Present's forced rail hides a pinned drawer"
	)
}

// --- drawerWidth: natural width, clamped to the sliver left of a wide panel ---
{
	assert.equal(drawerWidth(280, 0), DRAWER_WIDTH, 'unmeasured viewport (0) → natural width, no clamp')
	assert.equal(drawerWidth(280, 1440), DRAWER_WIDTH, 'ample room → the natural width')
	assert.equal(drawerWidth(1250, 1440), 182, 'a wide panel clamps the drawer to the remaining canvas sliver')
	assert.equal(drawerWidth(1300, 1440), 140, "and never below the 140 floor even when the sliver is thinner")
}

// --- jumpCameraToFrame: zoom to the frame's page bounds; no bounds → no move ---
{
	const zoomCalls: Array<{ bounds: unknown; opts: unknown }> = []
	const editor = {
		getShapePageBounds(id: TLShapeId) {
			return id === ('shape:missing' as TLShapeId) ? undefined : { x: 0, y: 0, w: 100, h: 80 }
		},
		zoomToBounds(bounds: unknown, opts: unknown) {
			zoomCalls.push({ bounds, opts })
		},
	} as unknown as Editor

	jumpCameraToFrame(editor, 'shape:f1' as TLShapeId)
	assert.equal(zoomCalls.length, 1, 'a frame with bounds zooms once')
	assert.deepEqual(zoomCalls[0]!.bounds, { x: 0, y: 0, w: 100, h: 80 }, 'zooms to the frame page bounds')

	jumpCameraToFrame(editor, 'shape:missing' as TLShapeId)
	assert.equal(zoomCalls.length, 1, 'a frame that vanished (no bounds) makes no camera move')
}

console.log('frameNav.test.ts: all assertions passed')
