/**
 * The EnsembleWorks command bar (canvas-controls spec §4): one floating bar of
 * canvas verbs replacing tldraw's DefaultToolbar. Left to right: ☰ main menu,
 * priority tools (native select/note/text/frame + plugin barItems) with
 * underlined accelerators, the ⋯ overflow (demoted native tools + plugin
 * overflow items, last-used item adopted next to the ⋯ trigger), ▶ Present,
 * and zoom.
 *
 * Present (spec §5) replaces the ENTIRE bar with a slim strip in two cases:
 * presenting locally (laser · note · END PRESENTING · rec dot) or watching
 * someone else present (Following ⟨name⟩ · STOP FOLLOWING, until opted out).
 * See `PresenterStrip`/`ViewerStrip` below and `chrome/present.ts` for the
 * presence-meta plumbing those read.
 *
 * Docking (spec §4 "Docking", Task 5): `settings.dockEdge` picks which
 * screen edge the NORMAL bar renders against — 'bottom' (default) needs no
 * wrapper (the Toolbar slot already anchors there), the other three edges
 * render vertical/icon-only via a `position: fixed` wrapper. Present/viewer
 * strips deliberately ignore dockEdge and always render horizontal
 * bottom-center — they're transient overlays, not the persistent bar, so
 * keeping them simple beats threading dock-edge logic through two more
 * components for a state that's over almost as soon as it starts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
	DefaultZoomMenu,
	TldrawUiButtonIcon,
	TldrawUiToolbar,
	stopEventPropagation,
	useDialogs,
	useEditor,
	useTools,
	useValue,
	type TLUiIconJsx,
	type TLUiToolItem,
} from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { collectBarItems, type BarItemDescriptor, type BarItemHelpers } from '../kernel/plugin'
import { plugins } from '../plugins'
import { wm } from '../theme'
import { displayKeyForKbd, splitAccelLabel } from './accel'
import { EnsembleMainMenu } from './MainMenu'
import { usePanelLayout } from './panelLayout'
import { presentingAtom, tryStartPresenting, useIsPresenting, usePresenter, type Presenter } from './present'
import { updateSettings, useSettings, type DockEdge } from './settings'

// Native tldraw tools shown as first-class verbs, in bar order (spec §4).
const PRIORITY_TOOLS = ['select', 'note', 'text', 'frame'] as const
// Demoted native tools living in the ⋯ overflow, in menu order.
const OVERFLOW_TOOLS = [
	'draw', 'eraser', 'arrow', 'line', 'rectangle', 'ellipse', 'highlight', 'laser', 'hand',
] as const

const LAST_OVERFLOW_KEY = 'ensembleworks.commandBar.lastOverflow.v1'

// Lowercase display labels for native tools; tool.label is a translation key,
// not raw text, so the bar keeps its own label map (spec §4 wants lowercase).
const NATIVE_LABELS: Record<string, string> = {
	select: 'select',
	note: 'note',
	text: 'text',
	frame: 'frame',
	draw: 'draw',
	eraser: 'eraser',
	arrow: 'arrow',
	line: 'line',
	rectangle: 'rectangle',
	ellipse: 'ellipse',
	highlight: 'highlight',
	laser: 'laser',
	hand: 'hand',
}

const barStyle: CSSProperties = {
	display: 'flex',
	flexDirection: 'row',
	alignItems: 'center',
	gap: 2,
	background: wm.bg,
	border: `1px solid ${wm.ruleStrong}`,
	borderRadius: 6,
	boxShadow: wm.shadowPaper,
	padding: '4px 8px',
	pointerEvents: 'auto',
	fontFamily: wm.sans,
}

const dividerStyle: CSSProperties = {
	width: 1,
	alignSelf: 'stretch',
	margin: '4px 4px',
	background: wm.ruleStrong,
}

// Vertical-bar counterpart to dividerStyle above (a horizontal rule instead
// of a vertical one) — used only by the normal bar's left/right dock layout.
const verticalDividerStyle: CSSProperties = {
	height: 1,
	alignSelf: 'stretch',
	margin: '4px 4px',
	background: wm.ruleStrong,
}

// Dock-to menu order, matching the spec §4 wording verbatim ("Dock to:
// bottom · left · top · right").
const DOCK_EDGE_OPTIONS: readonly DockEdge[] = ['bottom', 'left', 'top', 'right']

/**
 * Dock-edge positioning for the command bar (spec §4 "Docking"). 'bottom'
 * needs no wrapper — the Toolbar slot already anchors there via tldraw's own
 * layout, so returning null there means the bar renders straight into the
 * slot exactly as it always has. The other three edges render via a
 * `position: fixed` wrapper placed within the CANVAS region instead: the
 * slot's own container just ends up empty, which is a legitimate use of the
 * slot (confirmed against the phase-3 plan's Task 5 note) rather than a bug
 * to route around.
 *
 * `panelRightOffset` is the side panel's current on-screen width — the rail
 * width when collapsed, else its stored width (chrome/panelLayout.ts's
 * usePanelLayout) — plus an 8px margin, so a right-docked bar never renders
 * underneath the panel.
 */
function dockWrapperStyle(dockEdge: DockEdge, panelRightOffset: number): CSSProperties | null {
	const base: CSSProperties = { position: 'fixed', zIndex: 300, pointerEvents: 'auto' }
	switch (dockEdge) {
		case 'top':
			return { ...base, top: 8, left: '50%', transform: 'translateX(-50%)' }
		case 'left':
			return { ...base, left: 8, top: '50%', transform: 'translateY(-50%)' }
		case 'right':
			return { ...base, right: panelRightOffset + 8, top: '50%', transform: 'translateY(-50%)' }
		default:
			return null
	}
}

// Shared chrome for the bar's absolute-positioned popovers (⋯ overflow, the
// right-click dock menu) — only the position keys vary, via
// popoverPositionStyle below.
const popoverBoxStyle: CSSProperties = {
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
 * direction is radix-managed and deliberately left alone (see this file's
 * header comment / the phase-3 plan's Task 5 note) — if it ever clips at a
 * docked edge, that's a recorded as-built delta, not something to fight here.
 */
function popoverPositionStyle(dockEdge: DockEdge): CSSProperties {
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

/** "label (KEY)" title text for icon-only buttons — the vertical dock edges
 * drop the visible AccelLabel (spec §4), so the shortcut still needs to be
 * discoverable via the native title tooltip. */
function iconOnlyTitle(label: string, accelerator?: string | null): string {
	return accelerator ? `${label} (${accelerator.toUpperCase()})` : label
}

function AccelLabel({ label, accelerator }: { label: string; accelerator?: string | null }) {
	const split = splitAccelLabel(label, accelerator ?? undefined)
	if (split) {
		return (
			<span style={{ fontSize: 11, color: wm.inkMuted }}>
				{split.pre}
				<u
					style={{
						color: wm.ink,
						fontWeight: 700,
						textDecorationThickness: 2,
						textUnderlineOffset: 2,
					}}
				>
					{split.hit}
				</u>
				{split.post}
			</span>
		)
	}
	return (
		<span style={{ fontSize: 11, color: wm.inkMuted }}>
			{label}
			{accelerator ? <span style={{ fontSize: 9, color: wm.inkSubtle }}> {accelerator}</span> : null}
		</span>
	)
}

interface BarButtonProps {
	id: string
	icon: string | TLUiIconJsx
	label?: string
	accelerator?: string | null
	active?: boolean
	title?: string
	/** Vertical dock edges (spec §4): drop the visible label, keep the
	 * shortcut discoverable via `title` ("label (KEY)") instead. */
	iconOnly?: boolean
	onClick: () => void
}

function BarButton({ id, icon, label, accelerator, active, title, iconOnly, onClick }: BarButtonProps) {
	const resolvedTitle = title ?? (iconOnly && label ? iconOnlyTitle(label, accelerator) : undefined)
	return (
		<button
			type="button"
			data-testid={'ew-bar-' + id}
			title={resolvedTitle}
			onClick={onClick}
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 1,
				padding: '4px 6px',
				background: active ? wm.accentSoft : 'transparent',
				border: active ? `1px solid ${wm.sealBlue}` : '1px solid transparent',
				borderRadius: 4,
				cursor: 'pointer',
			}}
		>
			<TldrawUiButtonIcon icon={icon} small />
			{label && !iconOnly ? <AccelLabel label={label} accelerator={accelerator} /> : null}
		</button>
	)
}

function NativeToolButton({
	tool,
	label,
	currentToolId,
	iconOnly,
}: {
	tool: TLUiToolItem
	label: string
	currentToolId: string
	iconOnly?: boolean
}) {
	const accel = displayKeyForKbd(tool.kbd, label)
	return (
		<BarButton
			id={tool.id}
			icon={tool.icon}
			label={label}
			accelerator={accel}
			active={currentToolId === tool.id}
			iconOnly={iconOnly}
			onClick={() => tool.onSelect('toolbar')}
		/>
	)
}

function PluginBarButton({
	item,
	editor,
	helpers,
	iconOnly,
}: {
	item: BarItemDescriptor
	editor: ReturnType<typeof useEditor>
	helpers: BarItemHelpers
	iconOnly?: boolean
}) {
	const available = item.useAvailable?.() ?? true
	if (!available) return null
	return (
		<BarButton
			id={item.id}
			icon={item.icon}
			label={item.label}
			accelerator={item.accelerator}
			iconOnly={iconOnly}
			onClick={() => item.onSelect(editor, helpers)}
		/>
	)
}

/**
 * Always-mounted invisible probe: calls an item's useAvailable hook and
 * reports the result upward, so availability is known even for overflow items
 * whose buttons only mount while the ⋯ menu is open. One instance per item
 * (hooks rules), keyed by item id; only rendered for items with a hook.
 */
function AvailabilityProbe({
	item,
	report,
}: {
	item: BarItemDescriptor
	report: (id: string, available: boolean) => void
}) {
	const available = item.useAvailable!()
	useEffect(() => {
		report(item.id, available)
	}, [item.id, available, report])
	return null
}

// Blink animation for the presenter strip's rec dot — same visual language as
// the side panel's recording indicators (SidePanel.tsx's scribeBlinkKeyframes
// / PanelFooter), duplicated locally rather than imported since CommandBar
// lives outside that module and the keyframe name/rule is trivially small.
const barRecBlinkKeyframes =
	'@keyframes ew-bar-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'

function RecDot() {
	return (
		<>
			<style>{barRecBlinkKeyframes}</style>
			<span
				aria-hidden="true"
				title="Recording"
				style={{
					width: 8,
					height: 8,
					borderRadius: '50%',
					background: wm.crit,
					flex: '0 0 auto',
					animation: 'ew-bar-rec-blink 1.4s ease-in-out infinite',
				}}
			/>
		</>
	)
}

// A bar button with a permanent colour accent (border + tinted background)
// rather than BarButton's active-state accent — used for ▶ Present (green,
// wm.ok) and the crit/red END PRESENTING · STOP FOLLOWING buttons, which need
// to read as set-off from the rest of the bar regardless of interaction state.
function AccentButton({
	id,
	icon,
	label,
	accelerator,
	accentColor,
	title,
	iconOnly,
	onClick,
}: {
	id: string
	icon: string
	label: string
	accelerator?: string
	accentColor: string
	title?: string
	iconOnly?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			data-testid={'ew-bar-' + id}
			title={title ?? (iconOnly ? iconOnlyTitle(label, accelerator) : undefined)}
			onClick={onClick}
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 1,
				padding: '4px 8px',
				background: `${accentColor}1a`,
				border: `1px solid ${accentColor}`,
				borderRadius: 4,
				cursor: 'pointer',
			}}
		>
			<TldrawUiButtonIcon icon={icon} small />
			{!iconOnly && <AccelLabel label={label} accelerator={accelerator} />}
		</button>
	)
}

// Presenter mode (spec §5 "Presenter: bar becomes laser · note · END
// PRESENTING (+ rec dot)"): replaces the ENTIRE bar. Laser/note reuse the
// native tools (same NativeToolButton the normal bar uses for its priority
// tools) so arming them behaves identically to picking them off the full bar.
//
// `otherPresenter`: tryStartPresenting (present.ts) closes the render-lag
// simultaneous-press race, but two P presses can still cross on the network —
// both clients present, neither's guard saw the other. When that happens a
// collaborator's presenting meta shows up WHILE we present; surface it here
// so the collision is visible and one of them can END, rather than each
// silently assuming they have the room.
function PresenterStrip({
	tools,
	currentToolId,
	showRecDot,
	otherPresenter,
}: {
	tools: ReturnType<typeof useTools>
	currentToolId: string
	showRecDot: boolean
	otherPresenter: Presenter | null
}) {
	const laserTool = tools['laser']
	const noteTool = tools['note']
	return (
		<div data-testid="ew-command-bar" onPointerDown={stopEventPropagation} style={barStyle}>
			{laserTool && (
				<NativeToolButton tool={laserTool} label={NATIVE_LABELS.laser ?? 'laser'} currentToolId={currentToolId} />
			)}
			{noteTool && (
				<NativeToolButton tool={noteTool} label={NATIVE_LABELS.note ?? 'note'} currentToolId={currentToolId} />
			)}
			<div style={dividerStyle} />
			<AccentButton
				id="end-present"
				icon="cross-circle"
				label="end presenting"
				accentColor={wm.crit}
				title="End presenting (Esc)"
				onClick={() => presentingAtom.set(false)}
			/>
			{showRecDot && <RecDot />}
			{otherPresenter && (
				<span
					data-testid="ew-bar-also-presenting"
					style={{ fontSize: 11, color: wm.warn, padding: '0 8px', whiteSpace: 'nowrap' }}
				>
					{otherPresenter.userName} is also presenting
				</span>
			)}
		</div>
	)
}

// Viewer mode (spec §5 "Viewers: … bar becomes 'Following ⟨name⟩ · STOP
// FOLLOWING'. Esc or STOP opts out locally (chrome stays minimal until
// presenting ends or they exit)."): once no longer following, the STOP button
// disappears (there's nothing left to stop) but the strip itself stays — the
// bar does NOT return to its normal contents until the presenter's meta clears.
//
// "Following" is derived from the editor's ACTUAL follow state
// (getInstanceState().followingUserId), not from our opt-out flag: tldraw
// itself stops following on any user pan/zoom, and a label driven by optedOut
// alone would keep claiming "Following" after such a manual pan-away. The
// opt-out flag still exists, but only up in CommandBar, solely to keep Esc
// from firing stopFollowing twice — it plays no part in what this strip shows.
// (A pan-away deliberately does NOT set optedOut; the auto-follow effect only
// fires on presenter-id change, so nothing yanks the viewport back either way.)
function ViewerStrip({
	editor,
	presenter,
	onStop,
}: {
	editor: ReturnType<typeof useEditor>
	presenter: Presenter
	onStop: () => void
}) {
	const isFollowing = useValue(
		'ew following presenter',
		() => editor.getInstanceState().followingUserId === presenter.userId,
		[editor, presenter.userId]
	)
	return (
		<div data-testid="ew-command-bar" onPointerDown={stopEventPropagation} style={barStyle}>
			<span style={{ fontSize: 11, color: wm.inkMuted, padding: '0 8px', whiteSpace: 'nowrap' }}>
				{isFollowing ? `Following ${presenter.userName}` : `${presenter.userName} is presenting`}
			</span>
			{isFollowing && (
				<AccentButton
					id="stop-following"
					icon="cross-circle"
					label="stop following"
					accentColor={wm.crit}
					title="Stop following (Esc)"
					onClick={onStop}
				/>
			)}
		</div>
	)
}

export function CommandBar() {
	const editor = useEditor()
	const tools = useTools()
	const { addDialog } = useDialogs()
	const helpers: BarItemHelpers = useMemo(() => ({ addDialog }), [addDialog])

	const currentToolId = useValue('current tool', () => editor.getCurrentToolId(), [editor])

	// Present (spec §5). isPresenting: am I broadcasting? presenter: who (if
	// anyone else) is — derived from presence meta, see chrome/present.ts.
	const isPresenting = useIsPresenting()
	const presenter = usePresenter(editor)
	const snap = useAvSnapshot()

	// Viewer opt-out: STOP FOLLOWING (or Esc) sets this without touching
	// `presenter`, so the auto-follow effect below — keyed only on
	// presenter?.userId — does NOT re-trigger and drag the viewport back.
	const [optedOut, setOptedOut] = useState(false)
	// Tracks the previous presenter id purely to detect session BOUNDARIES
	// (someone starts/stops presenting) inside a single effect below, without
	// needing presenter identity in the auto-follow effect's own deps.
	const prevPresenterIdRef = useRef<string | null>(null)

	// Session-boundary effect: when the presenter changes (including to/from
	// nobody), reset the local opt-out for the new session, and — if a
	// presenter session just ENDED — stop following them (only if we're still
	// actually following; STOP already did this if we'd opted out).
	useEffect(() => {
		const currentId = presenter?.userId ?? null
		const prevId = prevPresenterIdRef.current
		if (currentId === prevId) return
		if (prevId && !currentId && editor.getInstanceState().followingUserId === prevId) {
			editor.stopFollowingUser()
		}
		prevPresenterIdRef.current = currentId
		setOptedOut(false)
	}, [editor, presenter?.userId])

	// Auto-follow (spec §5 "auto-follow ONCE per presenter session"): keyed
	// ONLY on presenter?.userId, deliberately excluding `optedOut` — a manual
	// STOP flips optedOut without changing presenter.userId, so this effect
	// does not re-run and does not re-trigger following after STOP.
	useEffect(() => {
		if (!presenter) return
		editor.startFollowingUser(presenter.userId)
	}, [editor, presenter?.userId])

	const stopFollowing = useCallback(() => {
		editor.stopFollowingUser()
		setOptedOut(true)
	}, [editor])

	const rootRef = useRef<HTMLDivElement>(null)
	const [overflowOpen, setOverflowOpen] = useState(false)
	const [lastOverflowId, setLastOverflowId] = useState<string | null>(() =>
		localStorage.getItem(LAST_OVERFLOW_KEY)
	)
	const recordLastOverflow = useCallback((id: string) => {
		setLastOverflowId(id)
		localStorage.setItem(LAST_OVERFLOW_KEY, id)
	}, [])

	// Dock edge (spec §4 "Docking", Task 5). Computed here (before the
	// Present/viewer early returns below) so hook order stays fixed regardless
	// of which branch ends up rendering — those branches ignore it entirely
	// (see this file's header comment on why).
	const dockEdge = useSettings().dockEdge
	const vertical = dockEdge === 'left' || dockEdge === 'right'
	const barDividerStyle = vertical ? verticalDividerStyle : dividerStyle
	// Right-docked offset: the panel's current on-screen width (rail when
	// collapsed, else its stored width) + 8px margin — see dockWrapperStyle's
	// doc comment above.
	const panelLayout = usePanelLayout()
	const panelRightOffset = panelLayout.collapsed ? 32 : panelLayout.width

	const [dockMenuOpen, setDockMenuOpen] = useState(false)
	const onBarContextMenu = useCallback((e: MouseEvent) => {
		e.preventDefault()
		setDockMenuOpen((open) => !open)
	}, [])

	// Dismiss the dock menu on outside pointerdown or Escape — same pattern as
	// the overflow-menu dismissal effect below.
	useEffect(() => {
		if (!dockMenuOpen) return
		function onPointerDown(e: PointerEvent) {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) setDockMenuOpen(false)
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape') setDockMenuOpen(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return () => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [dockMenuOpen])

	const priorityItems = useMemo(() => collectBarItems(plugins, 'priority'), [])
	const overflowItems = useMemo(() => collectBarItems(plugins, 'overflow'), [])

	// Availability of plugin items with a useAvailable hook, fed by the
	// always-mounted probes below. The ref keeps the keydown listener current
	// without re-subscribing; the version bump re-renders the overflow menu.
	const availabilityRef = useRef<Map<string, boolean>>(new Map())
	const [, setAvailabilityVersion] = useState(0)
	const reportAvailability = useCallback((id: string, available: boolean) => {
		if (availabilityRef.current.get(id) === available) return
		availabilityRef.current.set(id, available)
		setAvailabilityVersion((v) => v + 1)
	}, [])
	// Priority items subscribe twice — a probe here plus PluginBarButton's own
	// hook call. Intentional and harmless; the probe covers the keydown map.
	const probeItems = useMemo(
		() => [...priorityItems, ...overflowItems].filter((item) => item.useAvailable),
		[priorityItems, overflowItems]
	)
	// Items without a hook are always available.
	const isItemAvailable = (item: BarItemDescriptor) =>
		!item.useAvailable || (availabilityRef.current.get(item.id) ?? true)

	useEffect(() => {
		const itemsByAccelerator = new Map<string, BarItemDescriptor>()
		for (const item of [...priorityItems, ...overflowItems]) {
			if (item.accelerator) itemsByAccelerator.set(item.accelerator.toLowerCase(), item)
		}

		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
			const target = e.target as HTMLElement | null
			if (target) {
				if (target.isContentEditable) return
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
			}
			if (editor.getEditingShapeId() !== null) return
			if (!editor.getInstanceState().isFocused) return

			// Present (spec §5): Esc always returns to Work chrome — ends the
			// broadcast if I'm presenting, opts out of follow if I'm watching.
			// 'p' starts presenting from the normal bar. Both share this
			// handler's typing/editing guards above rather than getting an
			// always-on path: a deliberate tradeoff (noted in the plan) — Esc
			// won't reach Present while a shape is being edited or a text
			// field is focused, same as every other accelerator here, for
			// uniform behaviour rather than a special case.
			if (e.key === 'Escape') {
				if (isPresenting) {
					e.preventDefault()
					presentingAtom.set(false)
					return
				}
				if (presenter && !optedOut) {
					e.preventDefault()
					stopFollowing()
					return
				}
				return
			}
			if (e.key.toLowerCase() === 'p' && !isPresenting && !presenter) {
				e.preventDefault()
				// tryStartPresenting re-checks collaborators imperatively: the
				// `presenter` in this closure is render-fresh at best, so two
				// people pressing P near-simultaneously would both pass the
				// guard above (see present.ts's doc comment).
				tryStartPresenting(editor)
				return
			}

			const item = itemsByAccelerator.get(e.key.toLowerCase())
			if (!item) return
			// Unavailable items have their accelerator disabled (plugin contract).
			if (item.useAvailable && availabilityRef.current.get(item.id) === false) return
			e.preventDefault()
			item.onSelect(editor, helpers)
			// Overflow items fired via accelerator get adopted next to ⋯ too.
			if (item.placement === 'overflow') recordLastOverflow(item.id)
		}

		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [editor, helpers, priorityItems, overflowItems, recordLastOverflow, isPresenting, presenter, optedOut, stopFollowing])

	// Dismiss the overflow menu on outside pointerdown or Escape. Escape is
	// safe to handle even where the accelerator typing guards would apply.
	useEffect(() => {
		if (!overflowOpen) return
		function onPointerDown(e: PointerEvent) {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) setOverflowOpen(false)
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape') setOverflowOpen(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return () => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [overflowOpen])

	// Present mode replaces the ENTIRE bar (spec §5) — these two branches
	// return BEFORE the normal bar's remaining derived state/JSX below, which
	// is fine: every hook this component uses has already run above them.
	// While WE present, `presenter` (never self) being non-null means a
	// network-race second presenter — passed through for the collision notice.
	if (isPresenting) {
		return (
			<PresenterStrip
				tools={tools}
				currentToolId={currentToolId}
				showRecDot={!!snap && snap.scribes.length > 0}
				otherPresenter={presenter}
			/>
		)
	}
	if (presenter) {
		return <ViewerStrip editor={editor} presenter={presenter} onStop={stopFollowing} />
	}

	const lastOverflowNativeTool =
		lastOverflowId && (OVERFLOW_TOOLS as readonly string[]).includes(lastOverflowId)
			? tools[lastOverflowId]
			: undefined
	const lastOverflowPluginItem = lastOverflowId
		? overflowItems.find((item) => item.id === lastOverflowId)
		: undefined

	const bar = (
		<div
			ref={rootRef}
			data-testid="ew-command-bar"
			onPointerDown={stopEventPropagation}
			onContextMenu={onBarContextMenu}
			style={{ position: 'relative', ...barStyle, flexDirection: vertical ? 'column' : 'row' }}
		>
			{probeItems.map((item) => (
				<AvailabilityProbe key={item.id} item={item} report={reportAvailability} />
			))}
			<EnsembleMainMenu />
			<div style={barDividerStyle} />

			{PRIORITY_TOOLS.map((id) => {
				const tool = tools[id]
				if (!tool) return null
				return (
					<NativeToolButton
						key={id}
						tool={tool}
						label={NATIVE_LABELS[id] ?? id}
						currentToolId={currentToolId}
						iconOnly={vertical}
					/>
				)
			})}

			{priorityItems.map((item) => (
				<PluginBarButton key={item.id} item={item} editor={editor} helpers={helpers} iconOnly={vertical} />
			))}

			{lastOverflowNativeTool ? (
				<NativeToolButton
					tool={lastOverflowNativeTool}
					label={NATIVE_LABELS[lastOverflowNativeTool.id] ?? lastOverflowNativeTool.id}
					currentToolId={currentToolId}
					iconOnly={vertical}
				/>
			) : lastOverflowPluginItem ? (
				<PluginBarButton item={lastOverflowPluginItem} editor={editor} helpers={helpers} iconOnly={vertical} />
			) : null}

			<BarButton
				id="overflow"
				icon="dots-horizontal"
				title="More tools"
				onClick={() => setOverflowOpen((open) => !open)}
			/>

			<div style={barDividerStyle} />
			<AccentButton
				id="present"
				icon="share-1"
				label="present"
				accelerator="p"
				accentColor={wm.ok}
				title="Present (P)"
				iconOnly={vertical}
				// tryStartPresenting, not presentingAtom.set(true): the button is
				// hidden while someone else presents, but render state lags
				// presence — two near-simultaneous clicks would otherwise both
				// start presenting (see present.ts's doc comment).
				onClick={() => tryStartPresenting(editor)}
			/>

			<div style={barDividerStyle} />
			{/* DefaultZoomMenu's trigger is a Radix RovingFocusGroupItem, so it
			    must live inside a Radix Toolbar.Root — TldrawUiToolbar provides
			    it (cf. DefaultNavigationPanel). Scoped to just the zoom menu;
			    style neutralized so our paper bar styling stays authoritative.
			    Its own dropdown's open direction is radix-managed — NOT flipped
			    per dock edge here (see this file's header comment); orientation
			    still tracks vertical/horizontal for correct roving-focus nav. */}
			<TldrawUiToolbar
				label="Zoom"
				orientation={vertical ? 'vertical' : 'horizontal'}
				style={{ padding: 0, background: 'transparent', border: 'none', boxShadow: 'none' }}
			>
				<DefaultZoomMenu />
			</TldrawUiToolbar>

			{overflowOpen ? (
				<div
					data-testid="ew-bar-overflow-menu"
					style={{ ...popoverBoxStyle, ...popoverPositionStyle(dockEdge) }}
				>
					{OVERFLOW_TOOLS.map((id) => {
						const tool = tools[id]
						if (!tool) return null
						const accel = displayKeyForKbd(tool.kbd, NATIVE_LABELS[id] ?? id)
						return (
							<BarButton
								key={id}
								id={'overflow-' + id}
								icon={tool.icon}
								label={NATIVE_LABELS[id] ?? id}
								accelerator={accel}
								active={currentToolId === id}
								onClick={() => {
									tool.onSelect('toolbar')
									recordLastOverflow(id)
									setOverflowOpen(false)
								}}
							/>
						)
					})}
					{overflowItems.map((item) => {
						// Unavailable plugin items are hidden (plugin contract).
						if (!isItemAvailable(item)) return null
						return (
							<BarButton
								key={item.id}
								id={'overflow-' + item.id}
								icon={item.icon}
								label={item.label}
								accelerator={item.accelerator}
								onClick={() => {
									item.onSelect(editor, helpers)
									recordLastOverflow(item.id)
									setOverflowOpen(false)
								}}
							/>
						)
					})}
				</div>
			) : null}

			{dockMenuOpen ? (
				<div
					data-testid="ew-bar-dock-menu"
					style={{ ...popoverBoxStyle, ...popoverPositionStyle(dockEdge) }}
				>
					<span
						style={{
							fontSize: 9,
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: 0.9,
							color: wm.inkMuted,
							padding: '2px 6px',
						}}
					>
						Dock to
					</span>
					{DOCK_EDGE_OPTIONS.map((edge) => (
						<button
							key={edge}
							type="button"
							data-testid={'ew-bar-dock-' + edge}
							onClick={() => {
								updateSettings({ dockEdge: edge })
								setDockMenuOpen(false)
							}}
							style={{
								display: 'flex',
								alignItems: 'center',
								padding: '4px 8px',
								background: edge === dockEdge ? wm.accentSoft : 'transparent',
								border: edge === dockEdge ? `1px solid ${wm.sealBlue}` : '1px solid transparent',
								borderRadius: 4,
								fontFamily: wm.sans,
								fontSize: 11,
								color: wm.ink,
								cursor: 'pointer',
								textAlign: 'left',
								whiteSpace: 'nowrap',
							}}
						>
							{edge}
						</button>
					))}
				</div>
			) : null}
		</div>
	)

	// 'bottom' renders straight into the Toolbar slot (no wrapper — see
	// dockWrapperStyle's doc comment); the other edges need the fixed wrapper
	// to escape the slot's bottom-center anchor.
	const wrapperStyle = dockWrapperStyle(dockEdge, panelRightOffset)
	return wrapperStyle ? <div style={wrapperStyle}>{bar}</div> : bar
}
