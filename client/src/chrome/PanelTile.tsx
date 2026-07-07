/**
 * A single roster tile (canvas-controls spec §3 item 3): video when the
 * camera is on, else a GitHub avatar (local user only — from ./settings'
 * useSettings(), since remote handles aren't synced), else big initials
 * tinted in the participant's colour. Own tile gets
 * the mic/cam/spatial controls and the identity-colour swatch; other tiles
 * get a cam-status icon and a hover-revealed kick button.
 *
 * The video-attach effect is copied from the old faces rail's RailFace
 * (79-90, deleted at Task 5 cutover); the colour swatch ports the old
 * floating session-panel roster's ColorDot (283-363) verbatim in behaviour.
 * Tiles register their DOM element with the A/V bridge (av/bridge.ts) so
 * leashes anchor here instead of the old faces rail.
 */
import { Track, type LocalTrack, type RemoteTrack } from 'livekit-client'
import { useEffect, useRef, useState } from 'react'
import { DefaultColorStyle, type Editor } from 'tldraw'
import { getHoveredFace, registerFaceEl, setHoveredFace, type AvPanelSnapshot } from '../av/bridge'
import { LatencyPill } from '../av/gauges'
import { AvIcon, AvIconButton } from '../av/icons'
import { IDENTITY_COLORS, hexForColor, type IdentityColor } from '../colors'
import { setUserColor } from '../identity'
import { retintLocalShares } from '../screenshare/share'
import { wm } from '../theme'
import { useSettings } from './settings'

export interface PanelTileParticipant {
	prefixedId: string
	rawId: string
	name: string
	color: string
	isLocal: boolean
}

const TILE_HEIGHT = 84

function initialsFor(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return '?'
	if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase()
	return (words[0]![0] + words[1]![0]).toUpperCase()
}

export function PanelTile({
	editor,
	participant,
	snap,
}: {
	editor: Editor
	participant: PanelTileParticipant
	snap: AvPanelSnapshot | null
}) {
	const { rawId, prefixedId, name, color, isLocal } = participant

	const peer = !isLocal ? (snap?.peers.find((p) => p.id === rawId) ?? null) : null
	const videoTrack: LocalTrack | RemoteTrack | null = isLocal
		? (snap?.localVideoTrack ?? null)
		: (peer?.videoTrack ?? null)
	const isSpeaking = isLocal ? (snap?.localSpeaking ?? false) : (peer?.isSpeaking ?? false)
	const latency = snap?.latencies[rawId] ?? null
	const latencyHistory = snap?.latencyHistory[rawId] ?? []
	const kicking = snap?.kickingId === rawId
	const avAvailable = snap != null && snap.status !== 'disabled' && snap.status !== 'error'

	const videoRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const el = videoRef.current
		if (!el || !videoTrack || videoTrack.kind !== Track.Kind.Video) return
		const video = videoTrack.attach()
		video.muted = true // audio goes through the spatial WebAudio pipeline
		Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'cover' })
		el.appendChild(video)
		return () => {
			videoTrack.detach(video)
			video.remove()
		}
	}, [videoTrack])

	const [avatarFailed, setAvatarFailed] = useState(false)
	// Remote users' GitHub handles aren't synced anywhere today (settings live
	// in per-browser localStorage) — only the local user can show one.
	const localSettings = useSettings()
	const githubHandle = isLocal ? localSettings.githubHandle.trim() || null : null
	const showAvatar = isLocal && !videoTrack && githubHandle && !avatarFailed

	// If this tile unmounts while hovered (e.g. the peer switches page),
	// onPointerLeave never fires and the leash would stick to a now-gone
	// face — clear it here so the bridge's hovered id can't outlive the tile.
	useEffect(() => {
		return () => {
			if (getHoveredFace() === rawId) setHoveredFace(null)
		}
	}, [rawId])

	const [hovered, setHovered] = useState(false)
	const onEnter = () => {
		setHovered(true)
		setHoveredFace(rawId)
	}
	const onLeave = () => {
		setHovered(false)
		setHoveredFace(null)
	}

	return (
		<div
			ref={(el) => registerFaceEl(rawId, el)}
			data-testid={'ew-tile-' + rawId}
			onPointerEnter={onEnter}
			onPointerLeave={onLeave}
			onClick={() => {
				if (!isLocal) editor.zoomToUser(prefixedId)
			}}
			style={{
				position: 'relative',
				height: TILE_HEIGHT,
				overflow: 'hidden',
				borderRadius: 4,
				borderLeft: `4px solid ${color}`,
				background: wm.bgWarm,
				outline: isSpeaking ? `2px solid ${wm.sealBlue}` : 'none',
				outlineOffset: -2,
				cursor: isLocal ? 'default' : 'pointer',
			}}
		>
			{/* Background layer: video > GitHub avatar (local only) > initials. */}
			<div style={{ position: 'absolute', inset: 0 }}>
				{videoTrack ? (
					<div ref={videoRef} style={{ width: '100%', height: '100%' }} />
				) : showAvatar ? (
					<img
						src={`https://github.com/${githubHandle}.png`}
						onError={() => setAvatarFailed(true)}
						alt=""
						style={{ width: '100%', height: '100%', objectFit: 'cover' }}
					/>
				) : (
					<div
						style={{
							width: '100%',
							height: '100%',
							display: 'grid',
							placeItems: 'center',
							background: `${color}22`,
							color,
							fontSize: 26,
							fontWeight: 700,
							fontFamily: wm.sans,
						}}
					>
						{initialsFor(name)}
					</div>
				)}
			</div>

			{/* Foreground content: top row (cam status + latency), bottom row
			    (colour swatch + name + own controls / kick). */}
			<div
				style={{
					position: 'relative',
					zIndex: 1,
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'space-between',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: 4 }}>
					<div>
						{!isLocal && (
							// Cam-status icon derived from track presence — a read-only
							// status glyph, NOT a button (a disabled AvIconButton would
							// read "unavailable" and swallow the tile's click-to-zoom).
							// Mic isn't tracked per-peer today, so it's omitted rather
							// than invented.
							<span
								title={videoTrack ? 'camera on' : 'camera off'}
								style={{
									width: 25,
									height: 25,
									display: 'grid',
									placeItems: 'center',
									pointerEvents: 'none',
									color: videoTrack ? wm.cream : wm.inkMuted,
								}}
							>
								<AvIcon kind="camera" crossedOut={!videoTrack} />
							</span>
						)}
					</div>
					<div style={{ background: 'rgba(15,23,42,0.55)', borderRadius: 3, padding: '1px 3px' }}>
						<LatencyPill latency={latency} history={latencyHistory} />
					</div>
				</div>

				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						padding: '10px 5px 5px',
						background: 'linear-gradient(0deg, rgba(15,23,42,0.62), transparent)',
					}}
				>
					{isLocal && <ColorSwatch editor={editor} color={color} />}
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
							color: wm.cream,
							textShadow: '0 1px 2px rgba(0,0,0,0.5)',
						}}
					>
						{name}
						{isLocal ? ' (you)' : ''}
					</span>
					{isLocal && (
						<div style={{ display: 'flex', gap: 3, flex: '0 0 auto' }}>
							<AvIconButton
								kind="mic"
								enabled={snap?.micEnabled ?? false}
								available={avAvailable}
								onClick={() => snap?.actions.onMic()}
							/>
							<AvIconButton
								kind="camera"
								enabled={snap?.camEnabled ?? false}
								available={avAvailable}
								onClick={() => snap?.actions.onCam()}
							/>
							<AvIconButton
								kind="spatial"
								enabled={!(snap?.standupMode ?? true)}
								available={avAvailable}
								onClick={() => snap?.actions.onStandup()}
							/>
						</div>
					)}
					{!isLocal && hovered && snap && (
						<button
							type="button"
							disabled={kicking}
							onClick={(e) => {
								e.stopPropagation()
								snap.actions.kick(rawId, name)
							}}
							aria-label={`Kick ${name}`}
							style={{
								flex: '0 0 auto',
								border: `1px solid ${wm.ruleStrong}`,
								borderRadius: 2,
								background: wm.bg,
								color: wm.crit,
								padding: '2px 5px',
								fontFamily: wm.mono,
								fontSize: 9,
								textTransform: 'uppercase',
								cursor: 'pointer',
							}}
						>
							{kicking ? 'Kicking' : 'Kick'}
						</button>
					)}
				</div>
			</div>
		</div>
	)
}

// The identity-colour swatch — the only tile with one. Ported verbatim in
// behaviour from the old floating session-panel roster's ColorDot (deleted
// at Task 5 cutover): one control that governs the user's whole colour
// identity (cursor, ring, roster dot, new stickies,
// next-drawn shapes, screenshare borders).
function ColorSwatch({ editor, color }: { editor: Editor; color: string }) {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)

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

	const pick = (key: IdentityColor) => {
		setUserColor(key)
		const hex = hexForColor(key, editor.user.getIsDarkMode())
		editor.user.updateUserPreferences({ color: hex })
		editor.setStyleForNextShapes(DefaultColorStyle, key)
		// Re-tint any windows I'm already sharing. ownerColor is a synced prop,
		// so updating it here recolours the tile for every viewer, not just me.
		retintLocalShares(editor, hex)
		setOpen(false)
	}

	return (
		<div ref={rootRef} style={{ position: 'relative', flex: '0 0 auto', display: 'flex' }}>
			<button
				type="button"
				data-testid="ew-tile-color-swatch"
				onClick={(e) => {
					e.stopPropagation()
					setOpen((v) => !v)
				}}
				title="Change your colour"
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 2,
					border: 0,
					background: 'transparent',
					padding: 0,
					cursor: 'pointer',
				}}
			>
				<span
					style={{
						width: 10,
						height: 10,
						borderRadius: '50%',
						background: color,
						border: `1px solid ${wm.cream}`,
						flex: '0 0 auto',
					}}
				/>
				<span style={{ fontSize: 8, color: wm.cream }}>▾</span>
			</button>
			{open && (
				<div
					onClick={(e) => e.stopPropagation()}
					style={{
						position: 'absolute',
						bottom: 18,
						left: 0,
						zIndex: 10,
						display: 'grid',
						gridTemplateColumns: 'repeat(5, 16px)',
						gap: 4,
						padding: 6,
						background: wm.panel,
						border: `1px solid ${wm.rule}`,
						borderRadius: 4,
						boxShadow: wm.shadowPaper,
					}}
				>
					{IDENTITY_COLORS.map((key) => {
						const hex = hexForColor(key, editor.user.getIsDarkMode())
						const selected = hex.toLowerCase() === color.toLowerCase()
						return (
							<button
								key={key}
								type="button"
								onClick={() => pick(key)}
								title={key}
								style={{
									width: 16,
									height: 16,
									borderRadius: '50%',
									background: hex,
									border: selected ? `2px solid ${wm.ink}` : `1px solid ${wm.rule}`,
									padding: 0,
									cursor: 'pointer',
								}}
							/>
						)
					})}
				</div>
			)}
		</div>
	)
}
