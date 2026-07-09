/**
 * The Frames drawer (frame navigation): a fly-out that opens to the LEFT of the
 * side panel, listing the CURRENT page's frames so you can jump the camera
 * straight to one. Triggered by the caret on the left of the current page's
 * section header (PanelPages.tsx) — hover peeks, click pins (persisted).
 *
 * An App-level sibling of SidePanel (rendered in App.tsx), OUTSIDE the tldraw
 * React context — it reads the editor purely through the `editor` prop + useValue,
 * exactly like SidePanel. It anchors its RIGHT edge to the panel's live width
 * (drawerRightOffset), so it stays flush to the panel and slides with it as the
 * panel resizes, and hides when the panel rails (collapsed OR Present's forcedRail).
 *
 * Scope (v1, deliberately minimal): current page only, names only — no search,
 * no counts, no cross-page switching.
 */
import { useEffect, useLayoutEffect, useState } from 'react'
import { type Editor, useValue } from 'tldraw'
import { wm } from '../theme'
import {
	drawerRightOffset,
	drawerWidth,
	type FrameEntry,
	framesFromShapes,
	isDrawerVisible,
	jumpCameraToFrame,
} from './frameNav'
import { peekCloseSoon, peekOpen, setPeeking, togglePinned, useFramesDrawer } from './framesDrawerLayout'
import { exitFocus, focusedShapeIdAtom } from './focus'
import { usePanelLayout } from './panelLayout'
import { useIsPresenting, usePresenter } from './present'

// tldraw already binds F (frame tool) and G (select-geo-tool), so the drawer
// toggles on J ("jump to frame") — a key tldraw leaves free.
const TOGGLE_KEY = 'j'

// Stable empty list so the reactive frames query returns a constant (and reads
// no shape signals) while the drawer is closed — no recompute per shape change.
const NO_FRAMES: FrameEntry[] = []

const labelStyle = {
	fontFamily: wm.mono,
	fontSize: 9,
	fontWeight: 700,
	textTransform: 'uppercase',
	letterSpacing: 0.9,
} as const

export function FramesDrawer({ editor }: { editor: Editor }) {
	const layout = usePanelLayout()
	const drawer = useFramesDrawer()
	// Present temporarily forces the panel to its rail without writing
	// layout.collapsed (SidePanel.tsx's forcedRail), so mirror that same derivation
	// here — otherwise a pinned drawer would float detached beside the 32px rail.
	// Both hooks called unconditionally (no || short-circuit) per rules-of-hooks.
	const isPresenting = useIsPresenting()
	const presenter = usePresenter(editor)
	const forcedRail = isPresenting || presenter !== null

	const panel = { width: layout.width, collapsed: layout.collapsed, forcedRail }
	const visible = isDrawerVisible(drawer, panel)
	const rightOffset = drawerRightOffset(panel)

	// Only walk the page's shapes when the drawer is actually showing. When
	// closed the selector reads no shape signals, so it neither recomputes nor
	// re-renders on canvas edits.
	const frames = useValue(
		'frames-drawer-frames',
		() => (visible ? framesFromShapes(editor.getCurrentPageShapes()) : NO_FRAMES),
		[editor, visible]
	)
	const pageName = useValue(
		'frames-drawer-page-name',
		() => (visible ? editor.getCurrentPage().name : ''),
		[editor, visible]
	)

	// Anchor the drawer's top to the caret so a hover-peek is a straight shot left
	// (the panel header pushes the current section well below the viewport top, and
	// the panel scrolls). `viewport` is the window width the drawer's own width
	// clamps against — tracked in state, not read during render, so the clamp stays
	// reactive and headless (frameNav's drawerWidth). Both re-measured together on
	// panel scroll / resize / content reflow. 0 = not yet measured.
	const [anchorTop, setAnchorTop] = useState<number | null>(null)
	const [viewport, setViewport] = useState(0)

	// The J accelerator. Registered even while the drawer is closed (so it can
	// OPEN it) and in the CAPTURE phase — tldraw arms its own tool shortcuts from a
	// bubble-phase listener on document.body, so capture runs ahead of it (the same
	// idiom FocusOverlay.tsx uses). Same typing-context guards as CommandBar's
	// accelerator engine; also suppressed while a shape is focused. (Deliberately
	// no canvas-focused guard — this is global chrome, not a canvas tool.)
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
			if (e.key.toLowerCase() !== TOGGLE_KEY) return
			const target = e.target as HTMLElement | null
			if (target) {
				if (target.isContentEditable) return
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
			}
			if (editor.getEditingShapeId() !== null) return
			if (focusedShapeIdAtom.get() !== null) return
			e.preventDefault()
			e.stopPropagation()
			togglePinned()
		}
		window.addEventListener('keydown', onKeyDown, true)
		return () => window.removeEventListener('keydown', onKeyDown, true)
	}, [editor])

	// Clear the transient peek whenever the panel rails. Present (or a peer
	// presenting) swaps the panel to its rail and unmounts the caret + drawer
	// WITHOUT a pointer move, so no onMouseLeave fires — without this, a peek left
	// hanging would re-show the drawer the moment Present ends.
	useEffect(() => {
		if (forcedRail || layout.collapsed) setPeeking(false)
	}, [forcedRail, layout.collapsed])

	useLayoutEffect(() => {
		if (!visible) return
		const measure = () => {
			const caret = document.querySelector('[data-testid="ew-frames-caret"]')
			setAnchorTop(caret ? caret.getBoundingClientRect().top : null)
			setViewport(window.innerWidth)
		}
		measure()
		const panelEl = document.querySelector('[data-testid="ew-side-panel"]')
		window.addEventListener('resize', measure)
		panelEl?.addEventListener('scroll', measure)
		// The panel's content reflows without a scroll or window resize — e.g. a
		// teammate joining shifts the AV roster and pushes the current section down.
		// A ResizeObserver keeps the drawer pinned to the caret through that too.
		const observer = panelEl ? new ResizeObserver(measure) : null
		if (panelEl) observer!.observe(panelEl)
		return () => {
			window.removeEventListener('resize', measure)
			panelEl?.removeEventListener('scroll', measure)
			observer?.disconnect()
		}
	}, [visible])

	if (!visible || rightOffset === null) return null

	const top = Math.max(8, (anchorTop ?? 52) - 6)
	// Never let the drawer run off the left edge on a very wide (up to 85% window)
	// panel — clamp its width to the canvas sliver that remains (headless helper,
	// fed the reactively-tracked viewport width).
	const width = drawerWidth(rightOffset, viewport)

	const jump = (id: FrameEntry['id']) => {
		// Exit focus first (idempotent no-op if nothing's focused), same order as
		// the page-section header's own nav click in PanelPages, then fly the camera.
		exitFocus(editor)
		jumpCameraToFrame(editor, id)
	}

	return (
		<div
			data-testid="ew-frames-drawer"
			role="region"
			aria-label={`Frames on ${pageName}`}
			onMouseEnter={peekOpen}
			onMouseLeave={peekCloseSoon}
			style={{
				position: 'absolute',
				top,
				right: rightOffset,
				width,
				maxHeight: 'min(60vh, 420px)',
				display: 'flex',
				flexDirection: 'column',
				background: wm.bg,
				border: `1px solid ${wm.ruleStrong}`,
				// Flush against the panel: drop the shared (right) edge, round only
				// the left corners, and throw the shadow leftward over the canvas.
				borderRight: 0,
				borderRadius: '10px 0 0 10px',
				boxShadow: '-10px 10px 34px rgba(0,0,0,0.14)',
				overflow: 'hidden',
				zIndex: 6,
				fontFamily: wm.sans,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '9px 10px 8px 12px',
					borderBottom: `1px solid ${wm.rule}`,
					flex: '0 0 auto',
				}}
			>
				<span style={{ ...labelStyle, color: wm.sealBlue }}>Frames</span>
				<span
					title={pageName}
					style={{
						flex: 1,
						minWidth: 0,
						fontFamily: wm.mono,
						fontSize: 9,
						color: wm.inkMuted,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{pageName}
				</span>
				<button
					type="button"
					data-testid="ew-frames-drawer-pin"
					onClick={() => togglePinned()}
					title={drawer.pinned ? 'Unpin frames' : 'Pin frames open'}
					aria-pressed={drawer.pinned}
					style={{
						flex: '0 0 auto',
						...labelStyle,
						fontSize: 8,
						cursor: 'pointer',
						padding: '3px 7px',
						borderRadius: 5,
						border: `1px solid ${drawer.pinned ? wm.sealBlue : wm.rule}`,
						background: drawer.pinned ? wm.accentSoft : 'transparent',
						color: drawer.pinned ? wm.sealBlue : wm.inkMuted,
					}}
				>
					{drawer.pinned ? 'Pinned' : 'Pin'}
				</button>
			</div>

			<div style={{ overflowY: 'auto', padding: 6 }}>
				{frames.length === 0 ? (
					<div style={{ padding: '10px 8px', fontSize: 12, color: wm.inkSubtle }}>No frames on this page.</div>
				) : (
					frames.map((frame) => (
						<button
							key={frame.id}
							type="button"
							data-testid="ew-frames-drawer-row"
							onClick={() => jump(frame.id)}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								width: '100%',
								border: 0,
								background: 'transparent',
								borderRadius: 7,
								padding: '7px 8px',
								textAlign: 'left',
								cursor: 'pointer',
								color: wm.ink,
								fontFamily: wm.sans,
								fontSize: 12,
							}}
							onMouseEnter={(e) => (e.currentTarget.style.background = wm.panel)}
							onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
						>
							<span
								aria-hidden="true"
								style={{ width: 5, height: 5, borderRadius: '50%', background: wm.inkSubtle, flex: '0 0 auto' }}
							/>
							<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{frame.name}
							</span>
						</button>
					))
				)}
			</div>
		</div>
	)
}
