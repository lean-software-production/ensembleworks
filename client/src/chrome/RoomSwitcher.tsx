/**
 * The side-panel header's room-id trigger + room-list popover (room-switcher
 * spec §3.2). This is the ONLY React in that feature: every decision it makes
 * — narrowing the `/api/rooms` payload, marking the current room, omitting a
 * zero count — comes from `./rooms`, which is a pure module with its own bare-
 * bun unit test. Keep it that way; there is no unit test for this file by
 * construction (the harness has no DOM and no JSX transform).
 *
 * Navigation is a full page load via `buildRoomLink` (spec §3.3): the room id
 * is bound to ~a dozen subsystems at module-evaluation time (engine selection
 * most of all), so re-keying them in-app is deliberately not attempted.
 */
import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import { buildRoomLink } from './frameLink'
import { popoverBoxStyle } from './popover'
import { parseRoomsPayload, type RoomRow, toRoomRows } from './rooms'

// The exact type treatment of the static <span> this button replaces, so the
// header's height and alignment are unchanged.
const triggerStyle: CSSProperties = {
	fontFamily: wm.mono,
	fontSize: 11,
	fontWeight: 700,
	textTransform: 'uppercase',
	letterSpacing: 0.9,
	color: wm.ink,
	background: 'none',
	border: 'none',
	padding: 0,
	cursor: 'pointer',
	display: 'inline-flex',
	alignItems: 'center',
	gap: 4,
}

const rowStyle: CSSProperties = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: 12,
	background: 'none',
	border: 'none',
	padding: '3px 2px',
	fontFamily: wm.mono,
	fontSize: 11,
	color: wm.ink,
	textAlign: 'left',
	width: '100%',
}

const lineStyle: CSSProperties = {
	fontFamily: wm.mono,
	fontSize: 11,
	padding: '3px 2px',
	whiteSpace: 'nowrap',
}

type LoadState =
	| { status: 'loading' }
	| { status: 'ready'; rows: RoomRow[] }
	| { status: 'error' }

export function RoomSwitcher() {
	const roomId = getRoomId()
	const [open, setOpen] = useState(false)
	const [state, setState] = useState<LoadState>({ status: 'loading' })
	// Viewport-anchored popover position, captured from the trigger's rect at
	// open time. position:fixed escapes the panel root's overflow clipping —
	// the panel is overflowY:auto, which computes overflow-x to auto as well,
	// and can be dragged down to MIN_WIDTH (panelLayout.ts), narrower than the
	// room list. It also lifts the popover out of the header's stacking
	// context, above the participant tiles rendered below it. Same reasoning
	// and the same shape as the device picker's list above.
	// Anchored by its RIGHT edge, like the device picker: the panel is a
	// right-edge sidebar, so left-aligning the list to the trigger pushes it
	// off the viewport once the panel is near MIN_WIDTH.
	const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const abortRef = useRef<AbortController | null>(null)

	// Fetch on open, never on mount (spec §3.2): the panel must not pay for a
	// list nobody looked at, and counts must never be stale-but-plausible.
	const load = useCallback(() => {
		abortRef.current?.abort()
		const controller = new AbortController()
		abortRef.current = controller
		setState({ status: 'loading' })
		fetch('/api/rooms', { signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`)
				return res.json()
			})
			.then((body: unknown) => {
				if (controller.signal.aborted) return
				setState({ status: 'ready', rows: toRoomRows(parseRoomsPayload(body), roomId) })
			})
			.catch(() => {
				if (controller.signal.aborted) return
				setState({ status: 'error' })
			})
	}, [roomId])

	// Abort whatever is in flight when the popover closes or we unmount — the
	// next open starts a fresh request anyway.
	useEffect(() => {
		if (open) return
		abortRef.current?.abort()
		abortRef.current = null
	}, [open])
	useEffect(() => () => abortRef.current?.abort(), [])

	// Dismiss on outside pointerdown or Escape — same pattern as CommandBar's
	// popovers. No focus trap (spec §3.2: this is a 200px popover, not a page).
	useEffect(() => {
		if (!open) return
		function onPointerDown(e: PointerEvent) {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(false)
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape') setOpen(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return () => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [open])

	// The next state is computed outside setOpen: a state updater must be pure,
	// and StrictMode double-invokes it in dev — starting the fetch in there
	// fired two /api/rooms requests per open.
	const toggle = useCallback(() => {
		const next = !open
		if (next) {
			const rect = rootRef.current?.getBoundingClientRect()
			if (rect) {
				setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
			}
			load()
		}
		setOpen(next)
	}, [open, load])

	function onPick(row: RoomRow) {
		// The current room is inert: clicking it only closes the popover, so a
		// mis-click never costs a page load (spec §3.2).
		setOpen(false)
		if (row.isCurrent) return
		window.location.assign(buildRoomLink(window.location.origin, row.id))
	}

	return (
		<div ref={rootRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
			<button
				type="button"
				data-testid="ew-room-switcher"
				aria-haspopup="menu"
				aria-expanded={open}
				title="Switch room"
				onClick={toggle}
				style={triggerStyle}
			>
				{roomId}
				<span aria-hidden="true">▾</span>
			</button>
			{open && anchor && (
				<div
					data-testid="ew-room-switcher-menu"
					role="menu"
					// popoverBoxStyle supplies the shared chrome only; its
					// position:absolute is overridden here (see `anchor` above), and
					// the bar's popoverPositionStyle is dock-edge logic that does
					// not apply to a panel-anchored popover.
					style={{
						...popoverBoxStyle,
						position: 'fixed',
						top: anchor.top,
						right: anchor.right,
						zIndex: 10,
						minWidth: 180,
						maxWidth: 'min(300px, 90vw)',
					}}
				>
					{state.status === 'loading' && (
						<span style={{ ...lineStyle, color: wm.inkSubtle }}>loading…</span>
					)}
					{state.status === 'error' && (
						<span
							style={{ ...lineStyle, color: wm.crit, display: 'flex', gap: 8 }}
						>
							couldn’t load rooms
							<button
								type="button"
								data-testid="ew-room-switcher-retry"
								onClick={load}
								style={{
									background: 'none',
									border: 'none',
									padding: 0,
									cursor: 'pointer',
									fontFamily: wm.mono,
									fontSize: 11,
									color: wm.crit,
									textDecoration: 'underline',
								}}
							>
								retry
							</button>
						</span>
					)}
					{state.status === 'ready' && state.rows.length === 0 && (
						<span style={{ ...lineStyle, color: wm.inkSubtle }}>no rooms</span>
					)}
					{state.status === 'ready' &&
						state.rows.map((row) => (
							<button
								key={row.id}
								type="button"
								role="menuitem"
								data-testid={'ew-room-switcher-row-' + row.id}
								data-current={row.isCurrent ? 'true' : undefined}
								onClick={() => onPick(row)}
								style={{
									...rowStyle,
									fontWeight: row.isCurrent ? 700 : 400,
									cursor: row.isCurrent ? 'default' : 'pointer',
								}}
							>
								<span>
									{row.isCurrent && <span aria-hidden="true">✓ </span>}
									{row.id}
								</span>
								{row.countLabel !== null && (
									<span style={{ color: wm.inkMuted }}>{row.countLabel}</span>
								)}
							</button>
						))}
				</div>
			)}
		</div>
	)
}
