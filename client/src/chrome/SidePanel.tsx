/**
 * The permanent right-hand side panel — an App-level flex sibling that lives
 * OUTSIDE the tldraw component tree (see plan architecture note). It talks to
 * tldraw via the `editor` prop (useValue works on any signal without React
 * context) and to AvOverlay via the av/bridge module store. No useEditor, no
 * useDialogs, no tldraw CSS variables here — plain overlays + wm tokens only.
 *
 * Header (room + participant count) + VM strip + connection-status line, then
 * the page sections + user tiles (PanelPages.tsx), the recording row (when a
 * scribe bot is present), and the settings/help/about footer (PanelFooter.tsx).
 *
 * Width and collapsed (rail) state come from the panelLayout module store
 * (canvas-controls spec §3 "Panel states"), not a fixed constant: a resize
 * grip on the panel's left edge drags the width, snapping to a 32px
 * collapsed rail below ~140px. Present (spec §5 "Everyone: panel
 * auto-collapses to the rail") temporarily OVERRIDES that store — while
 * anyone presents, the rail renders regardless of `layout.collapsed`, and
 * the resize grip locks (no store writes) so the user's actual width/collapsed
 * preference is untouched and simply resumes once presenting ends.
 */
import { useRef, useState } from 'react'
import { rawUserId } from '@ensembleworks/contracts'
import { type Editor, useValue } from 'tldraw'
import { useAvSnapshot, type AvPanelSnapshot } from '../av/bridge'
import { VmStrip } from '../av/gauges'
import { AvIconButton } from '../av/icons'
import { TranscriptModal } from '../av/TranscriptModal'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import {
	getPanelLayout,
	panelDragAction,
	RAIL_WIDTH,
	setPanelCollapsed,
	setPanelWidth,
	togglePanelCollapsed,
	usePanelLayout,
} from './panelLayout'
import { PanelFooter } from './PanelFooter'
import { PanelPages } from './PanelPages'
import { ColorSwatch, CrosstalkControl, initialsFor, type PanelTileParticipant } from './PanelTile'
import { useIsPresenting, usePresenter } from './present'

// The local user's identity + A/V controls, docked at the panel bottom just
// above the settings footer: colour swatch, name "(you)", mic, camera, and
// the crosstalk slider. Moved here from the self tile — mosaic tiles can get
// too small to host controls, and this spot gives the crosstalk popover the
// full panel height to open upward into. marginTop:auto pins the bar to the
// bottom when the roster is short (the footer follows it).
function YouBar({ editor, snap }: { editor: Editor; snap: AvPanelSnapshot | null }) {
	const name = useValue('youbar-name', () => editor.user.getName() ?? 'teammate', [editor])
	const color = useValue('youbar-color', () => editor.user.getColor(), [editor])
	const avAvailable = snap != null && snap.status !== 'disabled' && snap.status !== 'error'
	return (
		<div
			data-testid="ew-you-bar"
			style={{
				marginTop: 'auto',
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				padding: '8px 12px',
				borderTop: `1px solid ${wm.rule}`,
				background: wm.panel,
			}}
		>
			<ColorSwatch editor={editor} color={color} />
			<span
				style={{
					flex: 1,
					minWidth: 0,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					fontFamily: wm.sans,
					fontSize: 12,
					fontWeight: 600,
					color: wm.ink,
				}}
			>
				{name} (you)
			</span>
			<div style={{ display: 'flex', gap: 3, flex: '0 0 auto' }}>
				<AvIconButton
					kind="mic"
					enabled={snap?.micEnabled ?? false}
					available={avAvailable}
					speaking={snap?.localSpeaking ?? false}
					onClick={() => snap?.actions.onMic()}
				/>
				<AvIconButton
					kind="camera"
					enabled={snap?.camEnabled ?? false}
					available={avAvailable}
					onClick={() => snap?.actions.onCam()}
				/>
				<CrosstalkControl snap={snap} available={avAvailable} />
			</div>
		</div>
	)
}

// Blink animation for the recording dot, ported from the old floating
// session-panel roster's ScribeRow (deleted at Task 5 cutover) — kept as a
// scoped <style> tag next to its only user.
const scribeBlinkKeyframes =
	'@keyframes scribe-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'

// The clamp ceiling passed to setPanelWidth is a fraction of window width
// rather than the module's hard cap, so the drag itself governs how wide the
// panel can get. Raised to 0.85 so it can take over the majority of the page
// for a "video-chat" layout (spec §3 "wide = face-to-face", extended) — the
// participant tiles grow with it (PanelPages' responsive grid). Leaves a sliver
// of canvas so the split never fully disappears.
const MAX_WIDTH_FRACTION = 0.85

export function SidePanel({ editor }: { editor: Editor }) {
	const snap = useAvSnapshot()
	const layout = usePanelLayout()
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const participantCount = useValue(
		'panel-participant-count',
		() => editor.getCollaborators().length + 1,
		[editor]
	)

	// Present (spec §5 "Everyone: panel auto-collapses to the rail (presenter's
	// dot ringed); prior width restored on exit"). `forcedRail` overrides
	// `layout.collapsed` for the duration of anyone's presentation — the store
	// itself is never written here, so exiting presenting just falls back to
	// whatever `layout` already held.
	const isPresenting = useIsPresenting()
	const presenter = usePresenter(editor)
	const forcedRail = isPresenting || presenter !== null
	const presentingUserId = isPresenting ? editor.user.getId() : (presenter?.userId ?? null)

	// Self + collaborators, for the collapsed rail's avatar dots — same
	// self-first shape PanelPages.tsx builds for page-section rosters, minus
	// the per-page grouping (the rail just wants one flat list).
	const railParticipants = useValue(
		'panel-rail-participants',
		(): PanelTileParticipant[] => {
			const selfId = editor.user.getId()
			const self: PanelTileParticipant = {
				prefixedId: selfId,
				rawId: rawUserId(selfId),
				name: editor.user.getName() ?? 'teammate',
				color: editor.user.getColor(),
				isLocal: true,
			}
			const collaborators: PanelTileParticipant[] = editor.getCollaborators().map((presence) => ({
				prefixedId: presence.userId,
				rawId: rawUserId(presence.userId),
				name: presence.userName?.trim() || 'Anonymous',
				color: presence.color,
				isLocal: false,
			}))
			return [self, ...collaborators]
		},
		[editor]
	)

	if (layout.collapsed || forcedRail) {
		return (
			<div
				data-testid="ew-panel-rail"
				style={{
					width: RAIL_WIDTH,
					flex: '0 0 auto',
					height: '100%',
					position: 'relative',
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					gap: 8,
					padding: '12px 0',
					background: wm.panel,
					borderLeft: `1px solid ${wm.ruleStrong}`,
				}}
			>
				<PanelResizeGrip locked={forcedRail} />
				{railParticipants.map((participant) => (
					<RailAvatarDot
						key={participant.rawId}
						participant={participant}
						snap={snap}
						isPresentingUser={presentingUserId === participant.prefixedId}
					/>
				))}
				{snap && snap.scribes.length > 0 && (
					<>
						<style>{scribeBlinkKeyframes}</style>
						<span
							aria-hidden="true"
							title="Recording"
							style={{
								width: 8,
								height: 8,
								borderRadius: '50%',
								background: wm.crit,
								flex: '0 0 auto',
								animation: 'scribe-rec-blink 1.4s ease-in-out infinite',
							}}
						/>
					</>
				)}
				<button
					type="button"
					data-testid="ew-panel-expand"
					// Disabled during the Present override — layout.collapsed is
					// untouched by this button, so toggling it here would silently
					// do nothing visible until presenting ends anyway; disabling is
					// the honest affordance rather than a click that appears to fail.
					disabled={forcedRail}
					onClick={() => setPanelCollapsed(false)}
					title={forcedRail ? 'Panel stays collapsed while presenting' : 'Expand panel'}
					style={{
						marginTop: 'auto',
						border: 0,
						background: 'transparent',
						color: wm.inkMuted,
						cursor: forcedRail ? 'not-allowed' : 'pointer',
						opacity: forcedRail ? 0.35 : 1,
						fontSize: 16,
						lineHeight: 1,
						padding: 4,
						flex: '0 0 auto',
					}}
				>
					«
				</button>
			</div>
		)
	}

	return (
		<div
			data-testid="ew-side-panel"
			style={{
				width: layout.width,
				flex: '0 0 auto',
				height: '100%',
				position: 'relative',
				display: 'flex',
				flexDirection: 'column',
				background: wm.panel,
				borderLeft: `1px solid ${wm.ruleStrong}`,
				fontFamily: wm.sans,
				overflowY: 'auto',
			}}
		>
			<PanelResizeGrip />
			<div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
					<span
						style={{
							fontFamily: wm.mono,
							fontSize: 11,
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: 0.9,
							color: wm.ink,
						}}
					>
						{getRoomId()}
					</span>
					<span style={{ fontFamily: wm.mono, fontSize: 11, color: wm.inkMuted }}>
						{participantCount}
					</span>
				</div>

				{snap === null && (
					<span style={{ fontSize: 11, color: wm.inkSubtle }}>connecting…</span>
				)}

				{snap?.vm && <VmStrip vm={snap.vm} />}

				{snap && snap.status !== 'connected' && (
					<span style={{ fontSize: 11, color: wm.inkSubtle }}>
						Audio/video:{' '}
						{snap.status === 'disabled'
							? 'unavailable'
							: snap.status === 'reconnecting' || snap.status === 'retrying'
								? 'reconnecting…'
								: snap.status}
					</span>
				)}

				{/* A failed kick (server 4xx / network) must not fail silently —
				    the tile's "Kicking" label reverts on its own, so this line is
				    the only feedback. Same red treatment as the old floating
				    session panel's. */}
				{snap?.kickError && (
					<span style={{ fontSize: 11, color: wm.crit }}>{snap.kickError}</span>
				)}
			</div>

			<div style={{ padding: '0 12px 12px' }}>
				<PanelPages editor={editor} width={layout.width} />
			</div>

			{snap && snap.scribes.length > 0 && (
				<div style={{ padding: '0 12px 12px' }} data-roster-scribes>
					<style>{scribeBlinkKeyframes}</style>
					<div
						style={{
							fontFamily: wm.mono,
							fontSize: 9,
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: 0.9,
							color: wm.crit,
							marginBottom: 3,
						}}
					>
						Recording
					</div>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
						{snap.scribes.map((scribe) => (
							<ScribeRow key={scribe.id} name={scribe.name} onOpenTranscript={() => setTranscriptOpen(true)} />
						))}
					</div>
				</div>
			)}

			<YouBar editor={editor} snap={snap} />

			<PanelFooter />

			{transcriptOpen && (
				<TranscriptModal roomId={getRoomId()} onClose={() => setTranscriptOpen(false)} />
			)}
		</div>
	)
}

// A roster row for a subscribe-only bot (the transcriber scribe). Unlike a
// participant tile it isn't clickable (no cursor to zoom to) or kickable —
// it's session infrastructure, shown purely so people know they're being
// recorded. Ported from the old floating session-panel roster's ScribeRow
// (deleted at Task 5 cutover) verbatim in behaviour.
function ScribeRow({ name, onOpenTranscript }: { name: string; onOpenTranscript: () => void }) {
	return (
		<div
			title="Transcribing the session into the live minutes"
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				border: `1px solid ${wm.rule}`,
				borderRadius: 2,
				background: wm.panel,
				padding: '4px 5px',
				fontFamily: wm.sans,
				fontSize: 12,
				color: wm.ink,
			}}
		>
			<span
				aria-hidden="true"
				style={{
					width: 8,
					height: 8,
					borderRadius: '50%',
					background: wm.crit,
					flex: '0 0 auto',
					animation: 'scribe-rec-blink 1.4s ease-in-out infinite',
				}}
			/>
			<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{name}
			</span>
			<button
				type="button"
				onClick={onOpenTranscript}
				title="Show the live transcript"
				style={{
					marginLeft: 'auto',
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 2,
					background: 'transparent',
					color: wm.sealBlue,
					padding: '3px 6px',
					fontFamily: wm.mono,
					fontSize: 9,
					textTransform: 'uppercase',
					letterSpacing: 0.9,
					cursor: 'pointer',
					flex: '0 0 auto',
				}}
			>
				Transcript
			</button>
		</div>
	)
}

// A 6px hit area on the panel's (or rail's) left edge: drag to resize,
// double-click to toggle the collapsed rail. Rendered as the first child of
// both the full panel and the rail so the grip survives the collapse.
//
// Collapse state is read synchronously from the store (getPanelLayout())
// inside the handlers rather than from a prop, so a fast drag firing many
// pointermoves between renders always sees the current value.
//
// `locked` (Present's rail override): the grip becomes inert — no drag, no
// double-click toggle — so the panelLayout store genuinely stays untouched
// while presenting forces the rail, per this file's header comment.
function PanelResizeGrip({ locked }: { locked?: boolean }) {
	const [hovered, setHovered] = useState(false)
	const draggingRef = useRef(false)
	// The stored width when this drag began. A drag that ends in the rail
	// live-resizes through 220 → 200 → 181 on the way down, so by the time
	// 'collapse' fires the store holds ~180, not where the user started —
	// restoring this snapshot at collapse-entry is what makes expand return
	// to the pre-drag width (e.g. 400), not the drag's last live value.
	const dragStartWidthRef = useRef(0)

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (locked) return
		e.preventDefault()
		draggingRef.current = true
		dragStartWidthRef.current = getPanelLayout().width
		e.currentTarget.setPointerCapture(e.pointerId)
		document.body.style.userSelect = 'none'
	}

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (locked || !draggingRef.current) return
		const width = window.innerWidth - e.clientX

		// panelDragAction's dead band (140-179) guarantees no store write below
		// 180, so clampPanelWidth's floor can never leak into the store; the
		// collapse branch then restores the drag-start width (see ref above).
		switch (panelDragAction(width)) {
			case 'collapse':
				if (!getPanelLayout().collapsed) {
					setPanelWidth(dragStartWidthRef.current)
					setPanelCollapsed(true)
				}
				break
			case 'resize':
				setPanelWidth(width, window.innerWidth * MAX_WIDTH_FRACTION)
				if (getPanelLayout().collapsed) setPanelCollapsed(false)
				break
			case 'ignore':
				// Dead band: no store writes — stay expanded/collapsed as-is.
				break
		}
	}

	const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return
		draggingRef.current = false
		e.currentTarget.releasePointerCapture(e.pointerId)
		document.body.style.userSelect = ''
	}

	return (
		<div
			data-testid="ew-panel-grip"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			onDoubleClick={() => {
				if (!locked) togglePanelCollapsed()
			}}
			style={{
				position: 'absolute',
				left: -3,
				top: 0,
				bottom: 0,
				width: 6,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				cursor: locked ? 'default' : 'ew-resize',
				zIndex: 2,
				touchAction: 'none',
			}}
		>
			{/* Visible grab pill: makes the (otherwise invisible) drag affordance
			    obvious. Hidden while locked (Present's rail override), where the
			    grip is inert and a pill would falsely imply it's draggable. */}
			{!locked && (
				<span
					aria-hidden="true"
					style={{
						width: 4,
						height: 30,
						borderRadius: 2,
						background: hovered ? wm.sealBlue : wm.ruleStrong,
						transition: 'background 120ms ease',
					}}
				/>
			)}
		</div>
	)
}

// One dot per participant in the collapsed rail: colour-tinted circle with
// the first initial, ringed while speaking — same ring colour/semantics as
// PanelTile's full-tile outline (spec §3 "Panel states": "ring = speaking").
// `isPresentingUser` (spec §5 "presenter's dot ringed") takes precedence over
// the speaking ring: there's one outline slot on the dot, and who's
// presenting is rarer and more important to spot at a glance than the
// flickering speaking indicator — a presenter who's also talking just keeps
// the presenter's colour rather than the two trying to combine.
function RailAvatarDot({
	participant,
	snap,
	isPresentingUser,
}: {
	participant: PanelTileParticipant
	snap: AvPanelSnapshot | null
	isPresentingUser: boolean
}) {
	const peer = !participant.isLocal ? (snap?.peers.find((p) => p.id === participant.rawId) ?? null) : null
	const isSpeaking = participant.isLocal ? (snap?.localSpeaking ?? false) : (peer?.isSpeaking ?? false)
	const ringColor = isPresentingUser ? wm.ok : isSpeaking ? wm.sealBlue : null

	return (
		<div
			title={participant.name + (participant.isLocal ? ' (you)' : '') + (isPresentingUser ? ' — presenting' : '')}
			style={{
				width: 20,
				height: 20,
				borderRadius: '50%',
				flex: '0 0 auto',
				display: 'grid',
				placeItems: 'center',
				background: `${participant.color}33`,
				color: participant.color,
				fontFamily: wm.sans,
				fontSize: 10,
				fontWeight: 700,
				outline: ringColor ? `2px solid ${ringColor}` : 'none',
				outlineOffset: 1,
			}}
		>
			{initialsFor(participant.name)}
		</div>
	)
}
