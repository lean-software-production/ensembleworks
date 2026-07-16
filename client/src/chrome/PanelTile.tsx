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
import {
	getHoveredFace,
	registerFaceEl,
	setHoveredFace,
	usePeerGain,
	type AvPanelSnapshot,
} from '../av/bridge'
import { LatencyPill } from '../av/gauges'
import { AvIcon, AvIconButton } from '../av/icons'
import { clampCrosstalk, DEFAULT_CROSSTALK_LEVEL, otherPageLevel } from '../av/crosstalk'
import { QUIET_GAIN_THRESHOLD, tileOpacityForGain } from '../av/legibility'
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

// The media area holds a FIXED 4:3 aspect ratio at every panel width (webcam
// feel). This is the fix for the face-cropping niggle: a fixed-height tile that
// fills a variable width is wide-and-short, so `object-fit: cover` crops the
// face top/bottom. Letting height track width at a constant aspect keeps the
// whole face visible whether the tile is a narrow single-column row or a big
// two-up/wide "video chat" tile — the aspect never changes, only the size.
const MEDIA_ASPECT = '4 / 3'

// Tiles flow in a centered wrap row (PanelPages' tileListStyle). Each grows to
// fill the row up to TILE_MAX_WIDTH and shrinks to share it; the flex BASIS (not
// a hard min) sets the wrap point — a second tile wraps below ~2×basis. There's
// deliberately no minWidth, so a lone tile in a narrow panel shrinks to fit
// rather than overflowing. Capping the max is what smooths the resize: a single
// tile tops out at TILE_MAX_WIDTH instead of ballooning full-width and then
// snapping to half-width when a column boundary is crossed.
const TILE_BASIS_WIDTH = 220
const TILE_MAX_WIDTH = 320

// Initials font grows a step alongside the tile (twoUp = the wider two-column
// layout PanelPages switches to) so it doesn't look lost in the bigger tile.
const INITIALS_FONT_DEFAULT = 26
const INITIALS_FONT_TWO_UP = 40

// Visual cues ease on roughly the audio ramp's time constant (the loop's
// 0.08 s setTargetAtTime), so eyes and ears agree. Module-level read is fine:
// a changed OS preference applies on next page load.
const REDUCED_MOTION =
	typeof window !== 'undefined' &&
	window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const DIM_TRANSITION = REDUCED_MOTION ? undefined : 'opacity 150ms linear'

// Exported so the collapsed rail's avatar dots (SidePanel.tsx) can share the
// same initial-derivation as the full tile.
export function initialsFor(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return '?'
	if (words.length === 1) return words[0]!.slice(0, 1).toUpperCase()
	return (words[0]![0] + words[1]![0]).toUpperCase()
}

export function PanelTile({
	editor,
	participant,
	snap,
	twoUp = false,
}: {
	editor: Editor
	participant: PanelTileParticipant
	snap: AvPanelSnapshot | null
	// Set by PanelPages.tsx once the panel is wide enough for its two-up grid
	// (spec §3 "wide = face-to-face"): grows the tile and its initials a step.
	twoUp?: boolean
}) {
	const { rawId, prefixedId, name, color, isLocal } = participant
	const initialsFontSize = twoUp ? INITIALS_FONT_TWO_UP : INITIALS_FONT_DEFAULT

	const peer = !isLocal ? (snap?.peers.find((p) => p.id === rawId) ?? null) : null
	// When the LOCAL camera is toggled off, LiveKit keeps the camera track
	// published-but-muted (no LocalTrackUnpublished fires), so localVideoTrack
	// stays set and the attached <video> shows a black frame instead of the
	// avatar. Gate the local video on the actual camEnabled flag so an off
	// camera falls through to the avatar/initials like a remote peer's does.
	const rawVideoTrack: LocalTrack | RemoteTrack | null = isLocal
		? (snap?.localVideoTrack ?? null)
		: (peer?.videoTrack ?? null)
	const videoTrack = isLocal ? ((snap?.camEnabled ?? false) ? rawVideoTrack : null) : rawVideoTrack
	const isSpeaking = isLocal ? (snap?.localSpeaking ?? false) : (peer?.isSpeaking ?? false)
	const latency = snap?.latencies[rawId] ?? null
	const latencyHistory = snap?.latencyHistory[rawId] ?? []
	const kicking = snap?.kickingId === rawId
	const avAvailable = snap != null && snap.status !== 'disabled' && snap.status !== 'error'

	// Applied spatial gain for this peer (bridge store, published by the gain
	// loop). Local tile: you always hear yourself at "full" — never dimmed.
	const peerGain = usePeerGain(rawId)
	const gain = isLocal ? 1 : peerGain
	const quiet = !isLocal && gain <= QUIET_GAIN_THRESHOLD

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
				flex: `1 1 ${TILE_BASIS_WIDTH}px`,
				maxWidth: TILE_MAX_WIDTH,
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
				borderRadius: 4,
				borderLeft: `4px solid ${color}`,
				background: wm.bgWarm,
				outline: isSpeaking ? `2px solid ${wm.sealBlue}` : 'none',
				outlineOffset: -2,
				cursor: isLocal ? 'default' : 'pointer',
			}}
		>
			{/* Media area — FIXED 4:3 (MEDIA_ASPECT) so a wide tile never crops
			    the face. video > GitHub avatar (local only) > initials, with the
			    latency pill and remote cam-status glyph floated over it. */}
			<div
				style={{
					position: 'relative',
					width: '100%',
					aspectRatio: MEDIA_ASPECT,
					overflow: 'hidden',
					background: `${color}22`,
					opacity: tileOpacityForGain(gain),
					transition: DIM_TRANSITION,
				}}
			>
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
							color,
							fontSize: initialsFontSize,
							fontWeight: 700,
							fontFamily: wm.sans,
						}}
					>
						{initialsFor(name)}
					</div>
				)}

				<div
					style={{
						position: 'absolute',
						top: 4,
						right: 4,
						background: 'rgba(15,23,42,0.55)',
						borderRadius: 3,
						padding: '1px 3px',
					}}
				>
					<LatencyPill latency={latency} history={latencyHistory} />
				</div>

				{!isLocal && (
					// Read-only cam-status glyph (NOT a button — a disabled
					// AvIconButton would read "unavailable" and swallow the tile's
					// click-to-zoom). Mic isn't tracked per-peer today, so it's
					// omitted rather than invented.
					<span
						title={videoTrack ? 'camera on' : 'camera off'}
						style={{
							position: 'absolute',
							top: 4,
							left: 4,
							width: 22,
							height: 22,
							display: 'grid',
							placeItems: 'center',
							pointerEvents: 'none',
							borderRadius: 3,
							background: 'rgba(15,23,42,0.45)',
							color: videoTrack ? wm.cream : wm.inkMuted,
						}}
					>
						<AvIcon kind="camera" crossedOut={!videoTrack} />
					</span>
				)}

				{quiet && (
					// Non-opacity "quiet" cue (a11y: legible without perceiving the
					// dim): same glyph style as the cam-status badge, bottom-left.
					<span
						title={`Quiet — out of earshot (${Math.round(gain * 100)}%)`}
						data-testid={'ew-tile-quiet-' + rawId}
						style={{
							position: 'absolute',
							bottom: 4,
							left: 4,
							width: 22,
							height: 22,
							display: 'grid',
							placeItems: 'center',
							pointerEvents: 'none',
							borderRadius: 3,
							background: 'rgba(15,23,42,0.45)',
							color: wm.inkMuted,
						}}
					>
						<AvIcon kind="spatial" crossedOut />
					</span>
				)}

				{!isLocal && hovered && (
					// On-demand exact volume readout (legibility cue #4).
					<span
						data-testid={'ew-tile-volume-' + rawId}
						style={{
							position: 'absolute',
							bottom: 4,
							right: 4,
							pointerEvents: 'none',
							borderRadius: 3,
							padding: '1px 4px',
							background: 'rgba(15,23,42,0.55)',
							color: wm.cream,
							fontFamily: wm.mono,
							fontSize: 10,
						}}
					>
						vol {Math.round(gain * 100)}%
					</span>
				)}
			</div>

			{/* Control strip — BELOW the media on a solid panel background, so the
			    mic/cam/spatial buttons (and name / kick) are always legible rather
			    than overlaid on a dark video. Colour swatch + name + own controls,
			    or a hover-revealed kick for peers. */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					padding: '5px 6px',
					background: wm.panel,
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
						color: wm.ink,
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
						<CrosstalkControl snap={snap} available={avAvailable} />
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
	)
}

// The self-tile crosstalk control: ONE slider for "how loud are people I
// can't currently see?". People whose cursors are in your viewport are always
// 100%; the slider is the level the on-page fade bottoms out at, and other
// pages sit one step further (av/crosstalk.ts otherPageLevel). Full (the
// default) = hear everyone on every page — the old standup mode; 0 = only who
// you can see. The volume rides the same single per-participant gain as
// in-room voice (useSpatialGainLoop) — no echo, no doubled voice, and it
// survives page hops/reconnects because the gain node is per-participant, not
// per-page. Reuses the concentric-waves "spatial" glyph and mirrors
// AvIconButton's styling for a consistent control strip.

// The fade diagram above the slider: three nested bands — your viewport
// (always 100%), the rest of your page (the slider level), other pages (one
// step softer). Each band is an opaque panel backing plus a level-mapped
// tint, so the opacities read absolutely rather than stacking.
function CrosstalkDiagram({ level }: { level: number }) {
	const pageLevel = clampCrosstalk(level)
	const otherLevel = otherPageLevel(level)
	// Visual tint for a gain: keep even 0 faintly visible so the band reads.
	const tint = (gain: number) => 0.08 + 0.82 * gain
	// Labels flip ink → cream once their band's tint gets dark enough that
	// ink would lose contrast.
	const label = (gain: number) => ({
		fontFamily: wm.mono,
		fontSize: 8,
		fill: tint(gain) > 0.5 ? wm.cream : wm.ink,
	})
	return (
		<svg
			viewBox="0 0 174 96"
			data-testid="ew-crosstalk-diagram"
			style={{ width: '100%', display: 'block', borderRadius: 3 }}
			role="img"
			aria-label={`Fade diagram: in view 100%, this page ${Math.round(pageLevel * 100)}%, other pages ${Math.round(otherLevel * 100)}%`}
		>
			{/* other pages */}
			<rect x={0} y={0} width={174} height={96} fill={wm.panel} />
			<rect x={0} y={0} width={174} height={96} fill={wm.sealBlue} opacity={tint(otherLevel)} />
			{/* this page */}
			<rect x={16} y={22} width={142} height={74} rx={3} fill={wm.panel} />
			<rect
				x={16}
				y={22}
				width={142}
				height={74}
				rx={3}
				fill={wm.sealBlue}
				opacity={tint(pageLevel)}
			/>
			{/* your viewport — always full volume */}
			<rect x={54} y={48} width={66} height={36} rx={2} fill={wm.panel} />
			<rect x={54} y={48} width={66} height={36} rx={2} fill={wm.sealBlue} opacity={tint(1)} />
			<rect
				x={54}
				y={48}
				width={66}
				height={36}
				rx={2}
				fill="none"
				stroke={wm.cream}
				strokeWidth={1.2}
			/>
			<text x={6} y={13} {...label(otherLevel)}>
				other pages {Math.round(otherLevel * 100)}%
			</text>
			<text x={22} y={35} {...label(pageLevel)}>
				this page {Math.round(pageLevel * 100)}%
			</text>
			{/* The viewport band is always the solid dark tint, so always cream. */}
			<text x={87} y={69} textAnchor="middle" {...label(1)}>
				in view 100%
			</text>
		</svg>
	)
}

function CrosstalkControl({
	snap,
	available,
}: {
	snap: AvPanelSnapshot | null
	available: boolean
}) {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)
	const level = snap?.crosstalkLevel ?? DEFAULT_CROSSTALK_LEVEL
	// "Active" = you've dialled focus in (the slider is shaping volumes);
	// crossed out = strict focus (people outside your view are silent).
	const active = level < 1
	const pct = Math.round(level * 100)
	const label = `Crosstalk ${pct}%`

	// Close on an outside click (same pattern as ColorSwatch below).
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

	return (
		<div ref={rootRef} style={{ position: 'relative', flex: '0 0 auto', display: 'flex' }}>
			<button
				type="button"
				data-testid="ew-tile-crosstalk"
				disabled={!available}
				onClick={(e) => {
					e.stopPropagation()
					setOpen((v) => !v)
				}}
				aria-label={label}
				title={available ? label : 'Crosstalk unavailable'}
				style={{
					width: 25,
					height: 25,
					display: 'grid',
					placeItems: 'center',
					border: `1px solid ${active ? wm.sealBlue : wm.ruleStrong}`,
					borderRadius: 2,
					padding: 3,
					background: active ? wm.sealBlue : 'transparent',
					color: active ? wm.cream : wm.inkMuted,
					cursor: available ? 'pointer' : 'not-allowed',
					opacity: available ? 1 : 0.4,
				}}
			>
				<AvIcon kind="spatial" crossedOut={level === 0} />
			</button>
			{open && snap && (
				<div
					onClick={(e) => e.stopPropagation()}
					data-testid="ew-crosstalk-popover"
					style={{
						position: 'absolute',
						bottom: 30,
						right: 0,
						zIndex: 10,
						width: 194,
						display: 'flex',
						flexDirection: 'column',
						gap: 8,
						padding: 10,
						background: wm.panel,
						border: `1px solid ${wm.rule}`,
						borderRadius: 4,
						boxShadow: wm.shadowPaper,
					}}
				>
					<div style={{ fontFamily: wm.sans, fontSize: 11, fontWeight: 700, color: wm.ink }}>
						Crosstalk volume
					</div>
					<CrosstalkDiagram level={level} />
					<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
						<input
							type="range"
							min={0}
							max={1}
							step={0.05}
							value={level}
							data-testid="ew-crosstalk-slider"
							aria-label="Crosstalk level"
							onChange={(e) => snap.actions.setCrosstalk(Number(e.target.value))}
							style={{ flex: 1, minWidth: 0, accentColor: wm.sealBlue, cursor: 'pointer' }}
						/>
						<span
							style={{
								flex: '0 0 auto',
								width: 30,
								textAlign: 'right',
								fontFamily: wm.mono,
								fontSize: 10,
								color: wm.inkMuted,
							}}
						>
							{level === 0 ? 'off' : `${pct}%`}
						</span>
					</div>
				</div>
			)}
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
