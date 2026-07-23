/**
 * The single-tab gate: children mount only when this tab owns the canvas.
 *
 * This is a GATE, not an overlay. A duplicate tab never renders the app, so it
 * never opens a sync socket, a terminal socket, or a LiveKit connection —
 * which is what stops a second tab from displacing the first one's LiveKit
 * identity (issue #55). An overlay could not achieve that: everything
 * underneath it would already be connected.
 *
 * `pending` renders nothing rather than a spinner. Lock acquisition is
 * sub-millisecond in the ordinary case, so a spinner would be a flash of
 * chrome on every single page load; the blank beat is invisible. It is a
 * distinct state from `blocked` precisely so the refusal screen never flashes
 * on a lone tab.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §5.
 */
import type { ReactNode } from 'react'
import { wm } from '../theme'
import { useCanvasLock } from './useCanvasLock'

/** Pinned by gateCopy.test.ts — see that file for why. */
export const DUPLICATE_TAB_COPY = {
	heading: 'This canvas is open in another tab',
	body: 'You can only open the canvas in one tab at a time. This tab is currently disabled.',
	recovery: 'Close the other tab and this one will connect automatically.',
} as const

export function DuplicateTabNotice() {
	const headingId = 'duplicate-tab-heading'
	const bodyId = 'duplicate-tab-body'
	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: wm.bgWarm,
			}}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby={headingId}
				aria-describedby={bodyId}
				style={{
					background: wm.bg,
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 4,
					padding: 24,
					minWidth: 320,
					maxWidth: 420,
					boxShadow: wm.shadowPaper,
					fontFamily: wm.sans,
					fontSize: 13,
					color: wm.ink,
				}}
			>
				<strong id={headingId} style={{ fontSize: 15 }}>
					{DUPLICATE_TAB_COPY.heading}
				</strong>
				<div id={bodyId} style={{ marginTop: 8 }}>
					{DUPLICATE_TAB_COPY.body}
				</div>
				{/*
				 * No button, by design. Recovery is automatic — this tab's lock
				 * request stays queued, so closing the other tab grants it and the
				 * gate mounts the app on its own. The only control we could offer
				 * would be a takeover, which would have to tear down a live
				 * holder's sync/terminal/LiveKit transports out from under it.
				 * Stating what happens beats offering that.
				 */}
				<div style={{ marginTop: 12, color: wm.inkMuted }}>{DUPLICATE_TAB_COPY.recovery}</div>
			</div>
		</div>
	)
}

export function SingleTabGate(props: { roomId: string; userId: string; children: ReactNode }) {
	const phase = useCanvasLock(props.roomId, props.userId)
	if (phase === 'pending') return null
	if (phase === 'blocked') return <DuplicateTabNotice />
	return <>{props.children}</>
}
