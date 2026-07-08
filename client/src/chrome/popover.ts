/**
 * Shared chrome + per-dock-edge positioning for the command bar's own
 * popovers (⋯ overflow, right-click dock menu). Lives in its own leaf module
 * — rather than staying exported from CommandBar.tsx — so OverflowMenu/
 * DockMenu can import it without importing the bar that renders them.
 */
import type { CSSProperties } from 'react'
import { wm } from '../theme'
import type { DockEdge } from './settings'

// Shared chrome for the bar's absolute-positioned popovers (⋯ overflow, the
// right-click dock menu) — only the position keys vary, via
// popoverPositionStyle below.
export const popoverBoxStyle: CSSProperties = {
	position: 'absolute',
	display: 'flex',
	flexDirection: 'column',
	gap: 2,
	background: wm.bg,
	border: `1px solid ${wm.ruleStrong}`,
	borderRadius: 6,
	boxShadow: wm.shadowPaper,
	padding: '4px 8px',
	pointerEvents: 'auto',
	fontFamily: wm.sans,
}

/**
 * Where a bar popover opens relative to the bar, per dock edge — always AWAY
 * from the docked edge (spec §4: "popovers flip away from the docked edge"),
 * so it never renders off-canvas or underneath the bar itself. This governs
 * OUR OWN popovers (⋯ overflow, dock menu) only; DefaultZoomMenu's dropdown
 * direction is radix-managed and deliberately left alone (see CommandBar.tsx's
 * header comment / the phase-3 plan's Task 5 note) — if it ever clips at a
 * docked edge, that's a recorded as-built delta, not something to fight here.
 */
export function popoverPositionStyle(dockEdge: DockEdge): CSSProperties {
	switch (dockEdge) {
		case 'top':
			return { top: 'calc(100% + 8px)', right: 0 }
		case 'left':
			return { left: 'calc(100% + 8px)', top: 0 }
		case 'right':
			return { right: 'calc(100% + 8px)', top: 0 }
		default:
			// 'bottom' (today's default) — open upward, above the bar.
			return { bottom: 'calc(100% + 8px)', right: 0 }
	}
}
