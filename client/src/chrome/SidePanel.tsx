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
 * collapsed rail below ~140px.
 */
import { useEffect, useRef, useState } from 'react'
import { rawUserId } from '@ensembleworks/contracts'
import { type Editor, useValue } from 'tldraw'
import { useAvSnapshot, type AvPanelSnapshot } from '../av/bridge'
import { VmStrip } from '../av/gauges'
import { TranscriptModal } from '../av/TranscriptModal'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import {
	setPanelCollapsed,
	setPanelWidth,
	togglePanelCollapsed,
	usePanelLayout,
} from './panelLayout'
import { PanelFooter } from './PanelFooter'
import { PanelPages } from './PanelPages'
import { initialsFor, type PanelTileParticipant } from './PanelTile'

// Blink animation for the recording dot, ported from the old floating
// session-panel roster's ScribeRow (deleted at Task 5 cutover) — kept as a
// scoped <style> tag next to its only user.
const scribeBlinkKeyframes =
	'@keyframes scribe-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'

// Below this dragged width the panel snaps to the collapsed rail (store width
// stays untouched — only `collapsed` flips); at/above 180 while collapsed a
// drag back out re-expands. Spec §3 "Panel states": "drag below ~140px
// (snaps)".
const COLLAPSE_THRESHOLD = 140

// The clamp ceiling passed to setPanelWidth is a fraction of window width
// rather than the module's hard 720 cap, so the drag itself never fights the
// spec's "wide = face-to-face" ceiling (past ~40% of window — leave headroom
// above that before the hard clamp bites).
const MAX_WIDTH_FRACTION = 0.6

const RAIL_WIDTH = 32

export function SidePanel({ editor }: { editor: Editor }) {
	const snap = useAvSnapshot()
	const layout = usePanelLayout()
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const participantCount = useValue(
		'panel-participant-count',
		() => editor.getCollaborators().length + 1,
		[editor]
	)

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

	if (layout.collapsed) {
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
				<PanelResizeGrip collapsed={layout.collapsed} />
				{railParticipants.map((participant) => (
					<RailAvatarDot key={participant.rawId} participant={participant} snap={snap} />
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
					onClick={() => setPanelCollapsed(false)}
					title="Expand panel"
					style={{
						marginTop: 'auto',
						border: 0,
						background: 'transparent',
						color: wm.inkMuted,
						cursor: 'pointer',
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
			<PanelResizeGrip collapsed={layout.collapsed} />
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
				<PanelPages editor={editor} />
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
// `collapsed` is read into a ref (rather than closed over directly) so the
// pointermove handler — attached once per render but potentially firing many
// times between renders during a fast drag — always sees the latest
// collapsed/expanded status when deciding whether crossing the 180px
// re-expand threshold should also flip `collapsed` back to false.
function PanelResizeGrip({ collapsed }: { collapsed: boolean }) {
	const collapsedRef = useRef(collapsed)
	useEffect(() => {
		collapsedRef.current = collapsed
	}, [collapsed])

	const draggingRef = useRef(false)

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		e.preventDefault()
		draggingRef.current = true
		e.currentTarget.setPointerCapture(e.pointerId)
		document.body.style.userSelect = 'none'
	}

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return
		const width = window.innerWidth - e.clientX

		if (width < COLLAPSE_THRESHOLD) {
			// Snap to the rail; the stored width is deliberately left alone so
			// re-expanding (chevron or drag-out) restores the last real width.
			setPanelCollapsed(true)
			return
		}

		// Live-update the stored width during the drag. clampPanelWidth's own
		// 180 floor absorbs the 140-180 band while still collapsed (harmless —
		// the rail is what's rendered until the 180 re-expand threshold below).
		setPanelWidth(width, window.innerWidth * MAX_WIDTH_FRACTION)

		if (collapsedRef.current && width >= 180) {
			setPanelCollapsed(false)
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
			onDoubleClick={() => togglePanelCollapsed()}
			style={{
				position: 'absolute',
				left: -3,
				top: 0,
				bottom: 0,
				width: 6,
				cursor: 'ew-resize',
				zIndex: 2,
				touchAction: 'none',
			}}
		/>
	)
}

// One dot per participant in the collapsed rail: colour-tinted circle with
// the first initial, ringed while speaking — same ring colour/semantics as
// PanelTile's full-tile outline (spec §3 "Panel states": "ring = speaking").
function RailAvatarDot({
	participant,
	snap,
}: {
	participant: PanelTileParticipant
	snap: AvPanelSnapshot | null
}) {
	const peer = !participant.isLocal ? (snap?.peers.find((p) => p.id === participant.rawId) ?? null) : null
	const isSpeaking = participant.isLocal ? (snap?.localSpeaking ?? false) : (peer?.isSpeaking ?? false)

	return (
		<div
			title={participant.name + (participant.isLocal ? ' (you)' : '')}
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
				outline: isSpeaking ? `2px solid ${wm.sealBlue}` : 'none',
				outlineOffset: 1,
			}}
		>
			{initialsFor(participant.name)}
		</div>
	)
}
