/**
 * Page sections (canvas-controls spec §3 item 2): one section per canvas
 * page — even empty ones, since the section list IS the page navigator —
 * with a roster of user tiles (PanelTile.tsx) under each. Lives in the side
 * panel, outside tldraw's React context (see SidePanel.tsx's header comment):
 * roster derivation reads the canvas only through the `editor` prop via
 * `useValue`, which works on any tldraw signal without React context.
 *
 * Roster grouping mirrors av/AvOverlay.tsx's `participants` derivation
 * (self + collaborators grouped by currentPageId); A/V state (video/speaking/
 * latency) is merged in per-tile from the av/bridge snapshot by raw user id.
 */
import { rawUserId } from '@ensembleworks/contracts'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
	getIndexBetween,
	react,
	type Editor,
	type IndexKey,
	type TLPageId,
	useValue,
} from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { wm } from '../theme'
import { exitFocus } from './focus'
import { peekCloseSoon, peekOpen, togglePinned, useFramesDrawer } from './framesDrawerLayout'
import { MOSAIC_GAP, mosaicTileWidth } from './mosaicLayout'
import {
	createSettler,
	orderByRecency,
	orderByViewportDistance,
	updateSpokeRecency,
	VIEWPORT_SETTLE_MS,
	type MosaicPoint,
} from './mosaicOrder'
import { MosaicChip, PanelTile, type PanelTileParticipant } from './PanelTile'

interface PageSectionData {
	id: TLPageId
	name: string
	// The page's fractional sort key (pages render in ascending `index` order).
	// Carried here so the ⋯ menu's Move up/down can compute a new key between
	// neighbours (getIndexBetween) without re-reading the editor.
	index: IndexKey
	participants: PanelTileParticipant[]
}

// Horizontal space the mosaic grid can't use, subtracted from the panel width
// SidePanel hands down before deriving tile width: SidePanel wraps PanelPages
// in `padding: '0 12px 12px'` (12px each side = 24), plus 4 for PanelTile's
// one-sided 4px identity borderLeft — the tile root is content-box (the panel
// renders outside tldraw's border-box reset), so a tile occupies
// tileWidth + borderLeft on the row.
const PANEL_CONTENT_INSET = 28

// The proximity sort keys off a SETTLED viewport centre (spec "settle-after-
// pause"): re-sorting live while panning would shuffle faces mid-gesture —
// the very confusion the mosaic exists to avoid. tldraw's `react` tracks the
// camera signal; the settler (mosaicOrder.ts) holds the value until the
// viewport has been still for VIEWPORT_SETTLE_MS.
function useSettledViewportCentre(editor: Editor): MosaicPoint {
	const [centre, setCentre] = useState<MosaicPoint>(() => {
		const c = editor.getViewportPageBounds().center
		return { x: c.x, y: c.y }
	})
	useEffect(() => {
		const settler = createSettler<MosaicPoint>(VIEWPORT_SETTLE_MS, setCentre)
		const stop = react('mosaic-viewport-settle', () => {
			const c = editor.getViewportPageBounds().center
			settler.feed({ x: c.x, y: c.y })
		})
		return () => {
			stop()
			settler.dispose()
		}
	}, [editor])
	return centre
}

// lastSpokeAt per raw user id, folded from the AV snapshot's speaking flags.
// Drives other-page chip order (spec: "most-recently-spoke, then join order").
function useSpokeRecency(snap: ReturnType<typeof useAvSnapshot>): Record<string, number> {
	const [recency, setRecency] = useState<Record<string, number>>({})
	useEffect(() => {
		if (!snap) return
		const speaking = snap.peers.filter((p) => p.isSpeaking).map((p) => p.id)
		setRecency((prev) => updateSpokeRecency(prev, speaking, Date.now()))
	}, [snap])
	return recency
}

export function PanelPages({ editor, width }: { editor: Editor; width: number }) {
	const snap = useAvSnapshot()
	const settledCentre = useSettledViewportCentre(editor)
	const recency = useSpokeRecency(snap)

	const { currentPageId, sections, unknownParticipants } = useValue(
		'panel-page-sections',
		() => {
			const pages = editor.getPages()
			const currentPageId = editor.getCurrentPageId()

			const selfId = editor.user.getId()
			const selfEntry: PanelTileParticipant = {
				prefixedId: selfId,
				rawId: rawUserId(selfId),
				name: editor.user.getName() ?? 'teammate',
				color: editor.user.getColor(),
				isLocal: true,
			}

			// Self goes in first under the page it's currently viewing; collaborator
			// presence then joins in under whichever page each of them is on.
			const byPage = new Map<TLPageId, PanelTileParticipant[]>()
			byPage.set(currentPageId, [selfEntry])
			for (const presence of editor.getCollaborators()) {
				const list = byPage.get(presence.currentPageId) ?? []
				list.push({
					prefixedId: presence.userId,
					rawId: rawUserId(presence.userId),
					name: presence.userName?.trim() || 'Anonymous',
					color: presence.color,
					isLocal: false,
				})
				byPage.set(presence.currentPageId, list)
			}

			const sections: PageSectionData[] = pages.map((page) => ({
				id: page.id,
				name: page.name,
				index: page.index,
				participants: byPage.get(page.id) ?? [],
			}))

			// A collaborator's presence can point at a page that no longer exists
			// (deleted from under them, or presence arriving mid-churn). Keep them
			// visible — the old AvOverlay roster grouped these under 'Unknown page'
			// — in one catch-all section rather than dropping them from the roster.
			const knownIds = new Set(pages.map((page) => page.id))
			const unknownParticipants: PanelTileParticipant[] = []
			for (const [pageId, list] of byPage) {
				if (!knownIds.has(pageId)) unknownParticipants.push(...list)
			}

			return { currentPageId, sections, unknownParticipants }
		},
		[editor]
	)

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
			{sections.map((section, i) => (
				<PageSectionView
					key={section.id}
					editor={editor}
					section={section}
					isCurrent={section.id === currentPageId}
					isOnlyPage={sections.length === 1}
					// Move up/down reorder the page by writing a fractional index
					// between the neighbours it's hopping over (getIndexBetween
					// handles the ends via null). undefined at the list ends so the
					// menu item disables. Pages render in ascending index order.
					onMoveUp={
						i > 0
							? () =>
									editor.updatePage({
										id: section.id,
										index: getIndexBetween(sections[i - 2]?.index ?? null, sections[i - 1]!.index),
									})
							: undefined
					}
					onMoveDown={
						i < sections.length - 1
							? () =>
									editor.updatePage({
										id: section.id,
										index: getIndexBetween(sections[i + 1]!.index, sections[i + 2]?.index ?? null),
									})
							: undefined
					}
					snap={snap}
					width={width}
					settledCentre={settledCentre}
					recency={recency}
				/>
			))}
			{unknownParticipants.length > 0 && (
				<UnknownPageSection editor={editor} participants={unknownParticipants} snap={snap} recency={recency} />
			)}
			<NewPageButton editor={editor} />
		</div>
	)
}

// Other pages' participants render as a wrap row of fixed-size ambient chips
// — pinned at minimum regardless of panel width (spec "Sizing rules").
function chipRowStyle(): CSSProperties {
	return { display: 'flex', flexWrap: 'wrap', gap: MOSAIC_GAP, marginTop: 6 }
}

// Apply an id-order function to a participant list (comparators in
// mosaicOrder.ts work on raw ids so they stay tldraw-free and bun-testable).
function orderParticipants(
	participants: PanelTileParticipant[],
	orderIds: (ids: string[]) => string[]
): PanelTileParticipant[] {
	const byId = new Map(participants.map((p) => [p.rawId, p]))
	return orderIds(participants.map((p) => p.rawId)).map((id) => byId.get(id)!)
}

// Cheap FLIP: after a re-order, each moved tile animates from its previous
// screen position to its new one, so eyes can track who went where (spec
// "animated tile position transitions"). Skipped under reduced motion.
const REDUCED_MOTION =
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function CurrentPageMosaic({
	editor,
	participants,
	snap,
	width,
	settledCentre,
}: {
	editor: Editor
	participants: PanelTileParticipant[]
	snap: ReturnType<typeof useAvSnapshot>
	width: number
	settledCentre: MosaicPoint
}) {
	const cursors = useValue(
		'mosaic-cursors',
		() => {
			const map: Record<string, MosaicPoint | undefined> = {}
			const selfPoint = editor.inputs.currentPagePoint
			map[rawUserId(editor.user.getId())] = { x: selfPoint.x, y: selfPoint.y }
			for (const presence of editor.getCollaborators()) {
				if (presence.cursor) {
					map[rawUserId(presence.userId)] = { x: presence.cursor.x, y: presence.cursor.y }
				}
			}
			return map
		},
		[editor]
	)

	const tileWidth = mosaicTileWidth(width - PANEL_CONTENT_INSET, participants.length)
	const ordered = orderParticipants(participants, (ids) =>
		orderByViewportDistance(ids, cursors, settledCentre)
	)

	// FLIP bookkeeping: previous rects by rawId, measured after every render.
	const gridRef = useRef<HTMLDivElement>(null)
	const prevRects = useRef<Map<string, DOMRect>>(new Map())
	useLayoutEffect(() => {
		const grid = gridRef.current
		if (!grid) return
		const next = new Map<string, DOMRect>()
		for (const el of Array.from(grid.children)) {
			if (!(el instanceof HTMLElement) || !el.dataset.mosaicId) continue
			const rect = el.getBoundingClientRect()
			next.set(el.dataset.mosaicId, rect)
			const prev = prevRects.current.get(el.dataset.mosaicId)
			if (prev && !REDUCED_MOTION) {
				const dx = prev.left - rect.left
				const dy = prev.top - rect.top
				if (dx !== 0 || dy !== 0) {
					el.animate(
						[{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
						{ duration: 250, easing: 'ease-out' }
					)
				}
			}
		}
		prevRects.current = next
	})

	return (
		<div
			ref={gridRef}
			data-testid="ew-mosaic-grid"
			style={{ display: 'flex', flexWrap: 'wrap', gap: MOSAIC_GAP, marginTop: 6 }}
		>
			{ordered.map((participant) => (
				<div key={participant.rawId} data-mosaic-id={participant.rawId} style={{ display: 'flex' }}>
					<PanelTile editor={editor} participant={participant} snap={snap} tileWidth={tileWidth} />
				</div>
			))}
		</div>
	)
}

// Catch-all for participants whose presence points at a page we can't find:
// a static header (nothing to navigate to, nothing to rename or delete) over
// ambient chips, so nobody silently vanishes from the roster.
function UnknownPageSection({
	editor,
	participants,
	snap,
	recency,
}: {
	editor: Editor
	participants: PanelTileParticipant[]
	snap: ReturnType<typeof useAvSnapshot>
	recency: Record<string, number>
}) {
	return (
		<div data-roster-page="Unknown page">
			<div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
				<span
					style={{
						fontFamily: wm.mono,
						fontSize: 10,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 0.9,
						color: wm.inkMuted,
					}}
				>
					Unknown page
				</span>
				<span style={{ fontFamily: wm.mono, fontSize: 10, color: wm.inkMuted, flex: '0 0 auto' }}>
					{participants.length}
				</span>
			</div>
			<div style={chipRowStyle()}>
				{orderParticipants(participants, (ids) => orderByRecency(ids, recency)).map(
					(participant) => (
						<MosaicChip key={participant.rawId} editor={editor} participant={participant} snap={snap} />
					)
				)}
			</div>
		</div>
	)
}

function PageSectionView({
	editor,
	section,
	isCurrent,
	isOnlyPage,
	onMoveUp,
	onMoveDown,
	snap,
	width,
	settledCentre,
	recency,
}: {
	editor: Editor
	section: PageSectionData
	isCurrent: boolean
	isOnlyPage: boolean
	onMoveUp?: () => void
	onMoveDown?: () => void
	snap: ReturnType<typeof useAvSnapshot>
	width: number
	settledCentre: MosaicPoint
	recency: Record<string, number>
}) {
	return (
		<div>
			<SectionHeader
				editor={editor}
				section={section}
				isCurrent={isCurrent}
				isOnlyPage={isOnlyPage}
				onMoveUp={onMoveUp}
				onMoveDown={onMoveDown}
			/>
			{section.participants.length > 0 &&
				(isCurrent ? (
					// Your room: the width-linked proximity mosaic (spec "Sizing rules"
					// / "Ordering rules") — tiles grow with the panel, sort by cursor
					// distance from your settled viewport centre.
					<CurrentPageMosaic
						editor={editor}
						participants={section.participants}
						snap={snap}
						width={width}
						settledCentre={settledCentre}
					/>
				) : (
					// Other rooms: fixed-size ambient chips, most-recently-spoke first
					// (proximity is meaningless cross-page).
					<div style={chipRowStyle()}>
						{orderParticipants(section.participants, (ids) => orderByRecency(ids, recency)).map(
							(participant) => (
								<MosaicChip
									key={participant.rawId}
									editor={editor}
									participant={participant}
									snap={snap}
								/>
							)
						)}
					</div>
				))}
		</div>
	)
}

const menuItemStyle: CSSProperties = {
	border: 0,
	background: 'transparent',
	color: wm.ink,
	padding: '6px 10px',
	fontFamily: wm.sans,
	fontSize: 11,
	textAlign: 'left',
	cursor: 'pointer',
}

// The caret on the LEFT of the current page's section header: the Frames drawer
// trigger. Hover peeks the drawer open (a short grace bridges the caret→drawer
// gap); click pins it open (persisted). Points left because the drawer flies out
// to the left of the panel; turns seal-blue when pinned. The drawer itself lives
// in FramesDrawer.tsx — this is only its handle.
function FramesCaret() {
	const { pinned, peeking } = useFramesDrawer()
	return (
		<button
			type="button"
			data-testid="ew-frames-caret"
			onClick={() => togglePinned()}
			onMouseEnter={peekOpen}
			onMouseLeave={peekCloseSoon}
			title={pinned ? 'Hide frames' : 'Show frames (J)'}
			aria-label={pinned ? 'Hide frames on this page' : 'Show frames on this page'}
			// Reflects whether the drawer is actually on screen — pinned OR peeking.
			aria-expanded={pinned || peeking}
			style={{
				flex: '0 0 auto',
				width: 16,
				height: 16,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				border: 0,
				background: 'transparent',
				borderRadius: 4,
				padding: 0,
				cursor: 'pointer',
				fontSize: 12,
				lineHeight: 1,
				color: pinned ? wm.sealBlue : peeking ? wm.kraft : wm.inkMuted,
			}}
		>
			‹
		</button>
	)
}

function SectionHeader({
	editor,
	section,
	isCurrent,
	isOnlyPage,
	onMoveUp,
	onMoveDown,
}: {
	editor: Editor
	section: PageSectionData
	isCurrent: boolean
	isOnlyPage: boolean
	onMoveUp?: () => void
	onMoveDown?: () => void
}) {
	const [menuOpen, setMenuOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)

	// Run a move handler (if enabled) and close the menu. undefined handlers
	// come from the list ends — their buttons render disabled, so this is only
	// reached for a live move.
	const move = (handler?: () => void) => {
		if (!handler) return
		setMenuOpen(false)
		handler()
	}

	// Dismiss on outside click, same pattern as CommandBar's overflow popover.
	useEffect(() => {
		if (!menuOpen) return
		function onPointerDown(e: PointerEvent) {
			if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
				setMenuOpen(false)
			}
		}
		window.addEventListener('pointerdown', onPointerDown)
		return () => window.removeEventListener('pointerdown', onPointerDown)
	}, [menuOpen])

	const rename = () => {
		setMenuOpen(false)
		const name = window.prompt('Rename page', section.name)?.trim()
		if (name) editor.renamePage(section.id, name)
	}

	const remove = () => {
		setMenuOpen(false)
		if (isOnlyPage) return
		if (!window.confirm(`Delete page "${section.name}"? This deletes everything on it.`)) return
		editor.deletePage(section.id)
	}

	return (
		<div ref={rootRef} data-roster-page={section.name} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 2 }}>
			{/* Frames drawer trigger — only the current page's frames are jumpable,
			    so only its section carries the caret (spec: current page only). A
			    matched-width spacer on other sections keeps page names aligned. */}
			{isCurrent ? (
				<FramesCaret />
			) : (
				<span aria-hidden="true" style={{ width: 16, flex: '0 0 auto' }} />
			)}
			<button
				type="button"
				onClick={() => {
					// Focus view (spec §7): "clicking a page section header exits
					// focus first, then navigates." exitFocus is idempotent (a no-op
					// when nothing's focused — see its doc comment), so this calls it
					// unconditionally rather than reading focusedShapeIdAtom first;
					// simpler than threading a reactive read into this non-reactive
					// click handler for no behavioural difference.
					exitFocus(editor)
					editor.setCurrentPage(section.id)
				}}
				style={{
					flex: 1,
					minWidth: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					border: 0,
					background: 'transparent',
					padding: '3px 0',
					cursor: 'pointer',
					textAlign: 'left',
				}}
			>
				{isCurrent && (
					<span
						aria-hidden="true"
						style={{ width: 5, height: 5, borderRadius: '50%', background: wm.sealBlue, flex: '0 0 auto' }}
					/>
				)}
				<span
					style={{
						fontFamily: wm.mono,
						fontSize: 10,
						fontWeight: 700,
						textTransform: 'uppercase',
						letterSpacing: 0.9,
						color: isCurrent ? wm.sealBlue : wm.ink,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{section.name}
				</span>
				<span style={{ fontFamily: wm.mono, fontSize: 10, color: wm.inkMuted, flex: '0 0 auto' }}>
					{section.participants.length}
				</span>
			</button>
			<button
				type="button"
				onClick={() => setMenuOpen((v) => !v)}
				title="Page options"
				aria-label={`Options for ${section.name}`}
				style={{
					flex: '0 0 auto',
					border: 0,
					background: 'transparent',
					color: wm.inkMuted,
					cursor: 'pointer',
					padding: '2px 5px',
					fontSize: 13,
					lineHeight: 1,
				}}
			>
				⋯
			</button>
			{menuOpen && (
				<div
					style={{
						position: 'absolute',
						top: '100%',
						right: 0,
						zIndex: 10,
						display: 'flex',
						flexDirection: 'column',
						minWidth: 110,
						background: wm.panel,
						border: `1px solid ${wm.rule}`,
						borderRadius: 4,
						boxShadow: wm.shadowPaper,
						overflow: 'hidden',
					}}
				>
					<button
						type="button"
						onClick={() => move(onMoveUp)}
						disabled={!onMoveUp}
						style={{ ...menuItemStyle, opacity: onMoveUp ? 1 : 0.4, cursor: onMoveUp ? 'pointer' : 'not-allowed' }}
					>
						Move up
					</button>
					<button
						type="button"
						onClick={() => move(onMoveDown)}
						disabled={!onMoveDown}
						style={{ ...menuItemStyle, opacity: onMoveDown ? 1 : 0.4, cursor: onMoveDown ? 'pointer' : 'not-allowed' }}
					>
						Move down
					</button>
					<button type="button" onClick={rename} style={menuItemStyle}>
						Rename
					</button>
					<button
						type="button"
						onClick={remove}
						disabled={isOnlyPage}
						title={isOnlyPage ? "Can't delete the only page" : undefined}
						style={{
							...menuItemStyle,
							color: wm.crit,
							opacity: isOnlyPage ? 0.4 : 1,
							cursor: isOnlyPage ? 'not-allowed' : 'pointer',
						}}
					>
						Delete
					</button>
				</div>
			)}
		</div>
	)
}

function NewPageButton({ editor }: { editor: Editor }) {
	return (
		<button
			type="button"
			data-testid="ew-panel-new-page"
			onClick={() => {
				// Focus view (spec §7): exit before navigating, same as the page
				// header click above — exitFocus is idempotent so this is safe
				// unconditionally.
				exitFocus(editor)
				// createPage returns the Editor, not the new page — diff the page
				// list before/after to find the id it was given (name dedup means
				// we can't predict it from the requested name alone).
				const before = new Set(editor.getPages().map((p) => p.id))
				editor.createPage({ name: 'Page 1' })
				const created = editor.getPages().find((p) => !before.has(p.id))
				if (created) editor.setCurrentPage(created.id)
			}}
			style={{
				border: `1px dashed ${wm.ruleStrong}`,
				borderRadius: 4,
				background: 'transparent',
				color: wm.inkMuted,
				padding: '6px 8px',
				fontFamily: wm.mono,
				fontSize: 10,
				textTransform: 'uppercase',
				letterSpacing: 0.9,
				cursor: 'pointer',
			}}
		>
			+ new page
		</button>
	)
}
