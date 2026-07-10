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
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getIndexBetween, type Editor, type IndexKey, type TLPageId, useValue } from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { wm } from '../theme'
import { selfAway } from './away'
import { isAwayPresence } from './awayLogic'
import { exitFocus } from './focus'
import { PanelTile, type PanelTileParticipant } from './PanelTile'

interface PageSectionData {
	id: TLPageId
	name: string
	// The page's fractional sort key (pages render in ascending `index` order).
	// Carried here so the ⋯ menu's Move up/down can compute a new key between
	// neighbours (getIndexBetween) without re-reading the editor.
	index: IndexKey
	participants: PanelTileParticipant[]
}

// Spec §3 "Panel states": "Wide = face-to-face: past ~40% of window, tiles
// reflow two-up per section and grow." The panel itself doesn't know the
// window width fraction — SidePanel.tsx already resolves that against the
// resize-grip clamp (MAX_WIDTH_FRACTION) — so this is a plain pixel
// threshold on the width SidePanel hands down as a prop (kept a prop rather
// than a second store read, per the plan, so the reflow stays obvious/testable).
export const TWO_UP_MIN_WIDTH = 480

export function PanelPages({ editor, width }: { editor: Editor; width: number }) {
	const snap = useAvSnapshot()
	const twoUp = width >= TWO_UP_MIN_WIDTH

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
				// Reading selfAway() inside this reactive derivation re-runs the
				// roster when our away atoms flip, so our own tile shows away too.
				away: selfAway(),
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
					away: isAwayPresence(presence),
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
					twoUp={twoUp}
				/>
			))}
			{unknownParticipants.length > 0 && (
				<UnknownPageSection editor={editor} participants={unknownParticipants} snap={snap} twoUp={twoUp} />
			)}
			<NewPageButton editor={editor} />
		</div>
	)
}

// The tile-list container: a centered wrap row (spec §3 "tiles reflow … and
// grow"). Each tile grows to fill up to its max width and shrinks to share the
// row, wrapping to more-per-row only when there's genuine room (PanelTile owns
// the flex basis/max). This replaced a hard single↔two-column grid breakpoint
// whose lone tile snapped from full-width to half-width mid-resize — the wrap
// flow grows tiles continuously instead. Shared by every section (including the
// unknown-page catch-all) so the reflow is identical everywhere tiles render.
function tileListStyle(): CSSProperties {
	return { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 6 }
}

// Catch-all for participants whose presence points at a page we can't find:
// a static header (nothing to navigate to, nothing to rename or delete) over
// the usual tiles, so nobody silently vanishes from the roster.
function UnknownPageSection({
	editor,
	participants,
	snap,
	twoUp,
}: {
	editor: Editor
	participants: PanelTileParticipant[]
	snap: ReturnType<typeof useAvSnapshot>
	twoUp: boolean
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
			<div style={tileListStyle()}>
				{participants.map((participant) => (
					<PanelTile key={participant.rawId} editor={editor} participant={participant} snap={snap} twoUp={twoUp} />
				))}
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
	twoUp,
}: {
	editor: Editor
	section: PageSectionData
	isCurrent: boolean
	isOnlyPage: boolean
	onMoveUp?: () => void
	onMoveDown?: () => void
	snap: ReturnType<typeof useAvSnapshot>
	twoUp: boolean
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
			{section.participants.length > 0 && (
				<div style={tileListStyle()}>
					{section.participants.map((participant) => (
						<PanelTile
							key={participant.rawId}
							editor={editor}
							participant={participant}
							snap={snap}
							twoUp={twoUp}
						/>
					))}
				</div>
			)}
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
