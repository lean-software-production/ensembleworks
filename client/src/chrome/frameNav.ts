/**
 * Pure helpers for the Frames drawer (frame navigation). No tldraw runtime
 * import — type-only, so this module and its test run under bare bun. The one
 * editor-touching helper, jumpCameraToFrame, takes only the two Editor methods
 * it needs, so it stays unit-testable with a duck-typed fake (the
 * kernel/roomHooks.test.ts precedent).
 */
import type { Editor, TLShape, TLShapeId } from 'tldraw'

export interface FrameEntry {
	id: TLShapeId
	name: string
}

// Case-insensitive AND numeric-aware collation, so "Pair huddle 2" sorts before
// "Pair huddle 10" and "advice" sits next to "Advice". Built once — Collator
// construction isn't free and the comparison runs per render.
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Sort frame entries by display name (case-insensitive, numeric-aware). Non-mutating. */
export function sortFrames(frames: readonly FrameEntry[]): FrameEntry[] {
	return [...frames].sort((a, b) => collator.compare(a.name, b.name))
}

/**
 * The current page's frames as sorted {id, name} rows: keep only `type: 'frame'`
 * shapes, read `props.name` (tldraw's frame title), fall back to "Frame" for the
 * blank default, and sort. Takes a plain shape array — exactly what
 * editor.getCurrentPageShapes() returns — so it stays pure and testable.
 */
export function framesFromShapes(shapes: readonly TLShape[]): FrameEntry[] {
	const frames: FrameEntry[] = []
	for (const shape of shapes) {
		if (shape.type !== 'frame') continue
		const name = (shape.props as { name?: string }).name?.trim() || 'Frame'
		frames.push({ id: shape.id, name })
	}
	return sortFrames(frames)
}

// The panel shows its 32px rail in two independent cases (SidePanel.tsx): the
// user collapsed it (layout.collapsed), OR Present temporarily forces the rail
// (forcedRail) without touching layout.collapsed. The drawer must hang off the
// EXPANDED panel, so it hides for either — a "railed" panel has no left edge to
// anchor to.
interface PanelRailState {
	width: number
	collapsed: boolean
	forcedRail: boolean
}

function isPanelRailed(panel: Pick<PanelRailState, 'collapsed' | 'forcedRail'>): boolean {
	return panel.collapsed || panel.forcedRail
}

/**
 * Where the drawer's right edge sits: flush against the panel's left edge, i.e.
 * the panel's current width. null when the panel is railed (collapsed OR forced
 * to the rail by Present) — there's no expanded panel to hang the drawer off.
 */
export function drawerRightOffset(panel: PanelRailState): number | null {
	return isPanelRailed(panel) ? null : panel.width
}

// The drawer's natural width, and the floor it never shrinks below.
export const DRAWER_WIDTH = 208
const DRAWER_MIN_WIDTH = 140
// The canvas gutter kept between the drawer's left edge and the viewport edge.
const DRAWER_EDGE_GAP = 8

/**
 * The drawer's on-screen width: its natural {@link DRAWER_WIDTH}, but never wider
 * than the canvas sliver left of a wide (up to 85%-of-window) panel. Pure and
 * headless like panelLayout's `clampPanelWidth` — the component feeds it a
 * viewport width tracked reactively, so no `window` read happens during render.
 * A viewport of 0 means "not measured yet"; return the natural width until the
 * layout effect fills it in (before paint, so there's no flash).
 */
export function drawerWidth(rightOffset: number, viewportWidth: number): number {
	if (viewportWidth <= 0) return DRAWER_WIDTH
	const available = viewportWidth - rightOffset - DRAWER_EDGE_GAP
	return Math.min(DRAWER_WIDTH, Math.max(DRAWER_MIN_WIDTH, available))
}

/** The drawer shows when pinned or peeked — but never while the panel is railed. */
export function isDrawerVisible(
	state: { pinned: boolean; peeking: boolean },
	panel: Pick<PanelRailState, 'collapsed' | 'forcedRail'>
): boolean {
	return (state.pinned || state.peeking) && !isPanelRailed(panel)
}

// The camera move mirrors chrome/focus.ts's enterFocus: zoom to the shape's page
// bounds with a small inset and a short animation — but with NO lock, because
// this is a navigate, not a focus. The caller pairs it with exitFocus(editor)
// first (same as the page-section header's own nav click in PanelPages.tsx).
const JUMP_OPTIONS = { inset: 16, animation: { duration: 220 } } as const

/**
 * Fly the camera to a frame by id. No-ops if the frame has no page bounds
 * (deleted between the drawer rendering and the click landing) — nothing to
 * zoom to. Does NOT switch pages: the drawer only lists the current page's frames.
 */
export function jumpCameraToFrame(editor: Editor, id: TLShapeId): void {
	const bounds = editor.getShapePageBounds(id)
	if (!bounds) return
	editor.zoomToBounds(bounds, JUMP_OPTIONS)
}
