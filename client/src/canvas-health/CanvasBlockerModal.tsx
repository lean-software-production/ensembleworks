/**
 * The blocker: one overlay, two reasons. Renders only when blocked, and
 * auto-dismisses the instant the blocking condition clears (it is a pure
 * function of useCanvasAvailability — there is no dismiss button by design
 * for the `connection` reason; `duplicate-tab` gets exactly one action,
 * "Use it here").
 *
 * The overlay both DIMS the canvas and SWALLOWS input: a capture-phase
 * keydown/pointerdown stop, so a stray key cannot fire a tldraw shortcut into
 * a canvas that can't sync it. See `shouldSwallowKey` for exactly what is and
 * isn't let through, and why the swallow is not optional polish here.
 *
 * Design: docs/plans/2026-07-22-connection-health-modal-design.md §4.
 */
import { useEffect, useRef } from 'react'
import { LatencyPill } from '../av/gauges'
import type { LatencySample } from '../av/useSessionPulse'
import { wm } from '../theme'
import {
	chipThreshold,
	countdownSeconds,
	transportChip,
	TRANSPORTS,
	type BlockReason,
	type HealthState,
	type TransportId,
} from './connectionHealth'
import type { Thresholds } from './constants'

export function transportLabel(id: TransportId): string {
	if (id === 'canvas') return 'Canvas'
	if (id === 'terminals') return 'Terminals'
	return 'Video'
}

// Per-blocking-transport copy: the name as a sentence-opener, the same name
// lowercased for when it isn't the first subject, and the verb it takes when
// it is the sole subject ("canvas sync" is singular, "terminals" is plural —
// that's a fact about the noun, not something derivable from the tripped
// count, so it's data here rather than a branch on the string it produces).
const BLOCKED_TRANSPORT_COPY: Record<'canvas' | 'terminals', { name: string; lower: string; verb: string }> = {
	canvas: { name: 'Canvas sync', lower: 'canvas sync', verb: 'is' },
	terminals: { name: 'Terminals', lower: 'terminals', verb: 'are' },
}

/** The connection headline's second line: which transports are actually down. */
export function blockedSummary(tripped: readonly TransportId[]): string {
	if (tripped.length === 0) return 'Checking your connection…'
	// Only canvas/terminals can ever appear here — livekit never trips (design §3).
	const [first, ...rest] = tripped as ('canvas' | 'terminals')[]
	const firstCopy = BLOCKED_TRANSPORT_COPY[first]
	if (rest.length === 0) return `${firstCopy.name} ${firstCopy.verb} not reaching the server.`
	// Two or more subjects joined by "and" always read as plural, regardless
	// of what each one takes alone.
	const names = [firstCopy.name, ...rest.map((id) => BLOCKED_TRANSPORT_COPY[id].lower)]
	return `${names.join(' and ')} are not reaching the server.`
}

/**
 * The overlay's swallow decision, extracted so it's independently testable.
 *
 * This is NOT a cosmetic nicety. tldraw's keyboard-shortcut handler is
 * attached to `document.body` itself, not to its own container
 * (`tldraw/dist-esm/lib/ui/context/useKeyboardShortcuts.mjs`), and its own
 * `shouldSkipEvent` only exempts inputs/textarea/contenteditable — nothing
 * about where this modal sits in the tree, or where focus is, keeps a
 * keydown from also reaching tldraw. So this predicate is the ONLY thing
 * standing between a blocked, unsynced canvas and Ctrl/Cmd+Z (undo),
 * Ctrl/Cmd+Shift+Z (redo), and Ctrl/Cmd+A (select-all) reaching tldraw and
 * mutating local canvas state while the modal is up.
 *
 * Allowlist, not a blanket modifier exemption: only Ctrl/Cmd+C (copy — does
 * not mutate) and bare Tab (focus movement into the modal's own button) pass
 * through. Everything else chorded with a modifier — including Ctrl/Cmd+X
 * (cut), Ctrl/Cmd+V (paste), Ctrl/Cmd+Z/Shift+Z, Ctrl/Cmd+A, all of which
 * mutate — is swallowed, same as unmodified keys.
 *
 * `insidePanel` is NOT a blanket bypass, on purpose, even though it looks
 * like the obvious way to exempt "the modal's own button." The modal moves
 * focus into itself on mount for accessibility (the takeover button when
 * present, otherwise the panel div, which has `tabIndex={-1}`) — so
 * `insidePanel` is true in the *common* case, for as long as the user hasn't
 * clicked or tabbed elsewhere. Treating it as "don't swallow" would silently
 * disable the swallow for the entire time the modal is up, which is exactly
 * the bug this predicate exists to prevent. So `insidePanel` only widens the
 * allowlist to the two keys that operate a focused button — `Enter` and
 * `' '` (Space) — and only when unmodified. Every modifier chord is swallowed
 * regardless of focus location (except Ctrl/Cmd+C, per above), and every
 * other bare key (letters, Delete, Backspace, Escape, …) is swallowed
 * regardless of focus location too, because those are exactly the keys
 * tldraw's `document.body`-level handler treats as tool shortcuts.
 *
 * Reload/close/devtools (Ctrl/Cmd+R, Ctrl/Cmd+W, Cmd+Tab, F12) are swallowed
 * too, and that's fine: those are non-cancelable browser-chrome shortcuts in
 * every major browser, so `preventDefault` on them is already a no-op, and
 * `stopPropagation` only ever stops *page*-level handlers (i.e. tldraw) from
 * seeing them, never the browser itself. A blocked user can still reload and
 * still close the tab.
 */
export function shouldSwallowKey(input: {
	key: string
	ctrlKey: boolean
	metaKey: boolean
	altKey: boolean
	shiftKey: boolean
	insidePanel: boolean
}): boolean {
	const chorded = input.ctrlKey || input.metaKey || input.altKey
	if (input.key === 'Tab' && !chorded) return false
	if (chorded) {
		const isCopy = (input.ctrlKey || input.metaKey) && !input.altKey && input.key.toLowerCase() === 'c'
		return !isCopy
	}
	if (input.insidePanel && (input.key === 'Enter' || input.key === ' ')) return false
	return true
}

const CHIP_STYLE: Record<'connected' | 'degrading' | 'down', { text: string; color: string }> = {
	connected: { text: '✓ connected', color: wm.ok },
	degrading: { text: '⏳ degrading', color: wm.warn },
	down: { text: '✗ down', color: wm.crit },
}

function TransportRow(props: {
	id: TransportId
	health: HealthState
	now: number
	thresholds: Thresholds
	tripped: readonly TransportId[]
}) {
	const chip = transportChip(props.health[props.id], props.now, chipThreshold(props.id, props.thresholds))
	const style = CHIP_STYLE[chip.kind]
	const isTripped = props.tripped.includes(props.id)
	const secs = Math.round(chip.unhealthyMs / 1000)
	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'space-between',
				gap: 16,
				padding: '4px 8px',
				borderRadius: 3,
				background: isTripped ? 'rgba(224,50,42,0.08)' : 'transparent',
				fontWeight: isTripped ? 600 : 400,
			}}
		>
			<span>{transportLabel(props.id)}</span>
			<span style={{ color: style.color }}>
				{style.text}
				{chip.kind === 'degrading' ? ` (${secs}s)` : ''}
			</span>
		</div>
	)
}

export function CanvasBlockerModal(props: {
	reason: BlockReason
	tripped: readonly TransportId[]
	health: HealthState
	thresholds: Thresholds
	now: number
	nextProbeAt: number
	latency: LatencySample | null
	latencyHistory: number[]
	onTakeover: () => void
}) {
	const panelRef = useRef<HTMLDivElement>(null)
	const takeoverButtonRef = useRef<HTMLButtonElement>(null)
	const headingId = 'canvas-blocker-heading'
	const bodyId = 'canvas-blocker-body'

	// Swallow input at the window's capture phase for as long as we are
	// mounted. Listening on the overlay element alone is not enough: keyboard
	// events go to document.activeElement, which may still be a tldraw node.
	// See `shouldSwallowKey` above for exactly what passes through and why.
	useEffect(() => {
		const swallowPointer = (ev: PointerEvent) => {
			if (panelRef.current?.contains(ev.target as Node)) return
			ev.stopPropagation()
			ev.preventDefault()
		}
		const swallowKey = (ev: KeyboardEvent) => {
			const insidePanel = !!panelRef.current?.contains(ev.target as Node)
			if (
				!shouldSwallowKey({
					key: ev.key,
					ctrlKey: ev.ctrlKey,
					metaKey: ev.metaKey,
					altKey: ev.altKey,
					shiftKey: ev.shiftKey,
					insidePanel,
				})
			)
				return
			ev.stopPropagation()
			ev.preventDefault()
		}
		const opts = { capture: true } as const
		window.addEventListener('keydown', swallowKey, opts)
		window.addEventListener('pointerdown', swallowPointer, opts)
		return () => {
			window.removeEventListener('keydown', swallowKey, opts)
			window.removeEventListener('pointerdown', swallowPointer, opts)
		}
	}, [])

	// Move focus into the dialog on mount (the button when there is one to act
	// on, the panel itself otherwise so a screen reader announces it via
	// role="dialog" + aria-labelledby), and give it back on unmount — this
	// modal has no close button, so unmount only ever happens because the
	// blocking condition cleared on its own.
	useEffect(() => {
		const previouslyFocused = document.activeElement as HTMLElement | null
		const target = props.reason === 'duplicate-tab' ? takeoverButtonRef.current : panelRef.current
		target?.focus()
		return () => {
			previouslyFocused?.focus?.()
		}
	}, [props.reason])

	return (
		<div
			style={{
				position: 'fixed',
				inset: 0,
				display: 'grid',
				placeItems: 'center',
				background: 'rgba(15,23,42,0.35)',
				backdropFilter: 'saturate(0.4)',
				zIndex: 10001, // above the wasKicked overlay's 10000
			}}
		>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={headingId}
				aria-describedby={bodyId}
				tabIndex={-1}
				style={{
					background: wm.bg,
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 4,
					padding: 24,
					minWidth: 320,
					boxShadow: wm.shadowPaper,
					fontFamily: wm.sans,
					fontSize: 13,
					color: wm.ink,
				}}
			>
				{props.reason === 'duplicate-tab' ? (
					<>
						<strong id={headingId} style={{ fontSize: 15 }}>
							This canvas is open in another tab
						</strong>
						<div id={bodyId} style={{ marginTop: 8 }}>
							Only one tab per person can drive the canvas — a second one would double your
							cursor and knock your microphone off the call. That other tab is active right now.
						</div>
						<button
							ref={takeoverButtonRef}
							type="button"
							onClick={props.onTakeover}
							style={{ marginTop: 16, padding: '6px 12px', borderRadius: 3, cursor: 'pointer' }}
						>
							Use it here
						</button>
					</>
				) : (
					<>
						<strong id={headingId} style={{ fontSize: 15 }}>
							Lost connection to the server
						</strong>
						<div id={bodyId} style={{ marginTop: 8 }}>
							{blockedSummary(props.tripped)}
						</div>
						<div style={{ marginTop: 16, display: 'grid', gap: 2 }}>
							{TRANSPORTS.map((id) => (
								<TransportRow
									key={id}
									id={id}
									health={props.health}
									now={props.now}
									thresholds={props.thresholds}
									tripped={props.tripped}
								/>
							))}
						</div>
						<div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
							<span>Latency</span>
							<LatencyPill latency={props.latency} history={props.latencyHistory} />
						</div>
						<div style={{ marginTop: 12, color: wm.inkMuted }}>
							Retrying in {countdownSeconds(props.now, props.nextProbeAt)}…
						</div>
					</>
				)}
			</div>
		</div>
	)
}
