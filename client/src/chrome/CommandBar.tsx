/**
 * The EnsembleWorks command bar (canvas-controls spec §4): one floating bar of
 * canvas verbs replacing tldraw's DefaultToolbar. Left to right: ☰ main menu,
 * priority tools (native select/note/text/frame + plugin barItems) with
 * underlined accelerators, the ⋯ overflow (demoted native tools + plugin
 * overflow items, last-used item adopted next to the ⋯ trigger), ▶ Present,
 * and zoom.
 *
 * This file keeps the bar's state, accelerator handling, dock wrapper and
 * composition; the pieces live next door — button primitives + bar styles in
 * barButtons.tsx, popover chrome in popover.ts, the ⋯ menu in
 * OverflowMenu.tsx, the right-click dock menu in DockMenu.tsx, and the
 * Present strips in presentStrips.tsx.
 *
 * Present (spec §5) replaces the ENTIRE bar with a slim strip in two cases:
 * presenting locally (laser · note · END PRESENTING · rec dot) or watching
 * someone else present (Following ⟨name⟩ · STOP FOLLOWING, until opted out).
 * See presentStrips.tsx and `chrome/present.ts` for the presence-meta
 * plumbing those read.
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
	TldrawUiToolbar,
	stopEventPropagation,
	useDialogs,
	useEditor,
	useTools,
	useValue,
} from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { collectBarItems, type BarItemDescriptor, type BarItemHelpers } from '../kernel/plugin'
import { plugins } from '../plugins'
import {
	AccentButton,
	BarButton,
	barStyle,
	dividerStyle,
	NATIVE_LABELS,
	NativeToolButton,
	OVERFLOW_TOOLS,
	PluginBarButton,
	verticalDividerStyle,
} from './barButtons'
import { DockMenu } from './DockMenu'
import { EnsembleMainMenu } from './MainMenu'
import { OverflowMenu } from './OverflowMenu'
import { usePanelLayout } from './panelLayout'
import { presentingAtom, tryStartPresenting, useIsPresenting, usePresenter } from './present'
import { PresenterStrip, ViewerStrip } from './presentStrips'
import { useSettings, type DockEdge } from './settings'
import { wm } from '../theme'

// Native tldraw tools shown as first-class verbs, in bar order (spec §4).
const PRIORITY_TOOLS = ['select', 'note', 'text', 'frame'] as const

const LAST_OVERFLOW_KEY = 'ensembleworks.commandBar.lastOverflow.v1'

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
		// The dock and ⋯ overflow menus are mutually exclusive: both anchor at
		// the same popover position, and both triggers live INSIDE rootRef, so
		// the outside-pointerdown dismissal below never fires for a click on
		// the other trigger — opening one must explicitly close the other or
		// they stack unreadably.
		setOverflowOpen(false)
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
				onClick={() => {
					// Mutually exclusive with the dock menu — see onBarContextMenu.
					setDockMenuOpen(false)
					setOverflowOpen((open) => !open)
				}}
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
				<OverflowMenu
					tools={tools}
					currentToolId={currentToolId}
					dockEdge={dockEdge}
					overflowItems={overflowItems}
					isItemAvailable={isItemAvailable}
					editor={editor}
					helpers={helpers}
					recordLastOverflow={recordLastOverflow}
					onClose={() => setOverflowOpen(false)}
				/>
			) : null}

			{dockMenuOpen ? <DockMenu dockEdge={dockEdge} onClose={() => setDockMenuOpen(false)} /> : null}
		</div>
	)

	// 'bottom' renders straight into the Toolbar slot (no wrapper — see
	// dockWrapperStyle's doc comment); the other edges need the fixed wrapper
	// to escape the slot's bottom-center anchor.
	const wrapperStyle = dockWrapperStyle(dockEdge, panelRightOffset)
	return wrapperStyle ? <div style={wrapperStyle}>{bar}</div> : bar
}
