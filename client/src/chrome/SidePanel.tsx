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
import { useEffect, useRef, useState } from 'react'
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
			<div style={{ display: 'flex', gap: 3, flex: '0 0 auto', alignItems: 'center' }}>
				<AvIconButton
					kind="mic"
					enabled={snap?.micEnabled ?? false}
					available={avAvailable}
					speaking={snap?.localSpeaking ?? false}
					onClick={() => snap?.actions.onMic()}
				/>
				<DevicePicker
					kind="audioinput"
					activeId={snap?.micDeviceId ?? null}
					available={avAvailable}
					onPick={(id) => snap?.actions.setAvDevice('audioinput', id)}
				/>
				<AvIconButton
					kind="camera"
					enabled={snap?.camEnabled ?? false}
					available={avAvailable}
					onClick={() => snap?.actions.onCam()}
				/>
				<DevicePicker
					kind="videoinput"
					activeId={snap?.camDeviceId ?? null}
					available={avAvailable}
					onPick={(id) => snap?.actions.setAvDevice('videoinput', id)}
				/>
				<CrosstalkControl snap={snap} available={avAvailable} />
			</div>
		</div>
	)
}

// Chevron beside the mic/camera buttons: opens an upward popover listing the
// browser's input devices of that kind (enumerated fresh on every open, so
// plugging in a headset shows up on the next click). Picking one calls
// LiveKit's switchActiveDevice via the bridge — the live track hops devices
// without a mute/unmute cycle. Device labels are only populated once the
// user has granted media permission, which holding a mic/cam session implies;
// unlabeled devices fall back to "microphone 2"-style names.
function DevicePicker({
	kind,
	activeId,
	available,
	onPick,
}: {
	kind: 'audioinput' | 'videoinput'
	activeId: string | null
	available: boolean
	onPick: (deviceId: string) => void
}) {
	const [open, setOpen] = useState(false)
	const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null)
	// Viewport-anchored popover position, captured from the chevron's rect at
	// open time. position:fixed escapes the panel root's overflow clipping —
	// an absolutely-positioned list wide enough for real device labels would
	// otherwise get cropped at the panel's left edge (overflowY:auto on the
	// panel computes overflow-x to auto as well, which clips).
	const [anchor, setAnchor] = useState<{ right: number; bottom: number } | null>(null)
	const rootRef = useRef<HTMLDivElement>(null)
	const noun = kind === 'audioinput' ? 'microphone' : 'camera'

	// Close on outside click, same pattern as CrosstalkControl/ColorSwatch.
	useEffect(() => {
		if (!open) return
		function onPointerDown(e: PointerEvent) {
			if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
				setOpen(false)
			}
		}
		window.addEventListener('pointerdown', onPointerDown)
		return () => window.removeEventListener('pointerdown', onPointerDown)
	}, [open])

	useEffect(() => {
		if (!open) return
		let cancelled = false
		navigator.mediaDevices
			.enumerateDevices()
			.then((all) => {
				if (!cancelled) setDevices(all.filter((d) => d.kind === kind))
			})
			.catch(() => {
				if (!cancelled) setDevices([])
			})
		return () => {
			cancelled = true
		}
	}, [open, kind])

	// null activeId = never explicitly switched → the browser default device.
	const isActive = (d: MediaDeviceInfo, i: number) =>
		activeId === null ? d.deviceId === 'default' || (i === 0 && !devices?.some((x) => x.deviceId === 'default')) : d.deviceId === activeId

	return (
		<div ref={rootRef} style={{ position: 'relative', flex: '0 0 auto', display: 'flex' }}>
			<button
				type="button"
				data-testid={`ew-device-picker-${kind}`}
				disabled={!available}
				onClick={(e) => {
					e.stopPropagation()
					const rect = rootRef.current?.getBoundingClientRect()
					if (rect) {
						setAnchor({
							right: window.innerWidth - rect.right,
							bottom: window.innerHeight - rect.top + 5,
						})
					}
					setOpen((v) => !v)
				}}
				aria-label={`Choose ${noun}`}
				aria-expanded={open}
				title={available ? `Choose ${noun}` : `${noun} unavailable`}
				style={{
					width: 16,
					height: 25,
					display: 'grid',
					placeItems: 'center',
					border: `1px solid ${wm.ruleStrong}`,
					borderRadius: 2,
					padding: 0,
					background: open ? wm.bgWarm : 'transparent',
					color: open ? wm.ink : wm.inkMuted,
					cursor: available ? 'pointer' : 'not-allowed',
					opacity: available ? 1 : 0.4,
				}}
			>
				{/* Solid caret rather than the ▾ glyph: at this size the character
				    rendered as a hairline that read as decoration, not a control.
				    An SVG triangle keeps the familiar select-box affordance crisp
				    at any DPI, and flips up while the list is open. */}
				<svg
					width="9"
					height="6"
					viewBox="0 0 9 6"
					aria-hidden="true"
					style={{
						transform: open ? 'rotate(180deg)' : undefined,
						transition: 'transform 120ms ease-out',
					}}
				>
					<path d="M0.5 1h8L4.5 5.5z" fill="currentColor" />
				</svg>
			</button>
			{open && anchor && (
				<div
					onClick={(e) => e.stopPropagation()}
					data-testid={`ew-device-list-${kind}`}
					style={{
						position: 'fixed',
						bottom: anchor.bottom,
						right: anchor.right,
						zIndex: 10,
						minWidth: 190,
						maxWidth: 'min(300px, 90vw)',
						display: 'flex',
						flexDirection: 'column',
						padding: 4,
						background: wm.panel,
						border: `1px solid ${wm.rule}`,
						borderRadius: 4,
						boxShadow: wm.shadowPaper,
					}}
				>
					<div
						style={{
							fontFamily: wm.mono,
							fontSize: 9,
							fontWeight: 700,
							textTransform: 'uppercase',
							letterSpacing: 0.9,
							color: wm.inkMuted,
							padding: '4px 6px',
						}}
					>
						{noun}
					</div>
					{devices === null && (
						<span style={{ padding: '4px 6px', fontSize: 11, color: wm.inkSubtle }}>looking…</span>
					)}
					{devices?.length === 0 && (
						<span style={{ padding: '4px 6px', fontSize: 11, color: wm.inkSubtle }}>
							no {noun}s found
						</span>
					)}
					{devices?.map((d, i) => (
						<button
							key={d.deviceId || i}
							type="button"
							onClick={() => {
								onPick(d.deviceId)
								setOpen(false)
							}}
							style={{
								border: 0,
								background: 'transparent',
								color: wm.ink,
								padding: '5px 6px',
								fontFamily: wm.sans,
								fontSize: 11,
								fontWeight: isActive(d, i) ? 700 : 400,
								textAlign: 'left',
								cursor: 'pointer',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
							}}
						>
							{isActive(d, i) ? '✓ ' : ' '}
							{d.label || `${noun} ${i + 1}`}
						</button>
					))}
				</div>
			)}
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
