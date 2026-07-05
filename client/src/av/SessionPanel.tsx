import { useState } from 'react'
import { DefaultColorStyle, stopEventPropagation, useEditor } from 'tldraw'
import { rawUserId } from '@ensembleworks/contracts'
import { IDENTITY_COLORS, hexForColor, type IdentityColor } from '../colors'
import { setUserColor } from '../identity'
import { retintLocalShares } from '../screenshare/share'
import { wm } from '../theme'
import { LatencyPill, VmStrip } from './gauges'
import { AvIconButton } from './icons'
import { type LatencySample, type VmStats } from './useSessionPulse'

export interface SessionParticipant {
	id: string
	name: string
	color: string
	isLocal: boolean
	pageId: string
	pageName: string
}

export function SessionPanel(props: {
	status: string
	micEnabled: boolean
	camEnabled: boolean
	standupMode: boolean
	participants: SessionParticipant[]
	vm: VmStats | null
	latencies: Record<string, LatencySample>
	latencyHistory: Record<string, number[]>
	scribes: { id: string; name: string }[]
	onMic: () => void
	onCam: () => void
	onStandup: () => void
	onParticipantClick: (id: string) => void
	onParticipantKick: (participant: SessionParticipant) => void
	onOpenTranscript: () => void
	kickingId: string | null
	kickError: string | null
}) {
	const avAvailable = props.status !== 'disabled' && props.status !== 'error'
	const participantGroups = new Map<string, SessionParticipant[]>()
	for (const participant of props.participants) {
		const group = participantGroups.get(participant.pageId) ?? []
		group.push(participant)
		participantGroups.set(participant.pageId, group)
	}
	return (
		<div
			// Keep clicks from reaching the canvas underneath.
			onPointerDown={stopEventPropagation}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 7,
				alignItems: 'stretch',
				minWidth: 220,
				maxWidth: 300,
				background: wm.bg,
				border: `1px solid ${wm.ruleStrong}`,
				borderRadius: 4,
				boxShadow: wm.shadowPaper,
				padding: 8,
				pointerEvents: 'auto',
				fontFamily: wm.sans,
			}}
		>
			<div
				style={{
					display: 'flex',
					alignItems: 'baseline',
					justifyContent: 'space-between',
					gap: 12,
				}}
			>
				<strong
					style={{
						fontFamily: wm.mono,
						fontSize: 11,
						textTransform: 'uppercase',
						letterSpacing: 1,
					}}
				>
					In session
				</strong>
				<span style={{ fontSize: 11, color: wm.inkSubtle }}>
					{props.participants.length} {props.participants.length === 1 ? 'person' : 'people'}
				</span>
			</div>
			{props.vm && <VmStrip vm={props.vm} />}
			<div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
				{[...participantGroups.entries()].map(([pageId, group]) => (
					<div key={pageId} data-roster-page={group[0]!.pageName}>
						<div
							style={{
								fontFamily: wm.mono,
								fontSize: 9,
								fontWeight: 700,
								textTransform: 'uppercase',
								letterSpacing: 0.9,
								color: wm.sealBlue,
								marginBottom: 3,
							}}
						>
							{group[0]!.pageName}
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
							{group.map((participant) => (
								<ParticipantRow
									key={participant.id}
									participant={participant}
									latency={props.latencies[rawUserId(participant.id)] ?? null}
									latencyHistory={props.latencyHistory[rawUserId(participant.id)] ?? []}
									kicking={props.kickingId === participant.id}
									onClick={props.onParticipantClick}
									onKick={props.onParticipantKick}
									avControls={
										participant.isLocal
											? {
												available: avAvailable,
												micEnabled: props.micEnabled,
												camEnabled: props.camEnabled,
												spatialEnabled: !props.standupMode,
												onMic: props.onMic,
												onCam: props.onCam,
												onSpatial: props.onStandup,
											}
											: undefined
									}
								/>
							))}
						</div>
					</div>
				))}
			</div>
			{props.scribes.length > 0 && (
				<div data-roster-scribes>
					<style>
						{'@keyframes scribe-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'}
					</style>
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
						{props.scribes.map((scribe) => (
							<ScribeRow key={scribe.id} name={scribe.name} onOpenTranscript={props.onOpenTranscript} />
						))}
					</div>
				</div>
			)}
			{props.kickError && <span style={{ fontSize: 11, color: wm.crit }}>{props.kickError}</span>}
			{props.status !== 'connected' && (
				<span style={{ fontSize: 11, color: wm.inkSubtle }}>
					Audio/video: {props.status === 'disabled' ? 'unavailable' : props.status}
				</span>
			)}
		</div>
	)
}

function ParticipantRow(props: {
	participant: SessionParticipant
	latency: LatencySample | null
	latencyHistory: number[]
	kicking: boolean
	onClick: (id: string) => void
	onKick: (participant: SessionParticipant) => void
	avControls?: {
		available: boolean
		micEnabled: boolean
		camEnabled: boolean
		spatialEnabled: boolean
		onMic: () => void
		onCam: () => void
		onSpatial: () => void
	}
}) {
	const participant = props.participant
	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 4,
				border: `1px solid ${wm.rule}`,
				borderRadius: 2,
				background: wm.panel,
				padding: 3,
			}}
		>
			<ColorDot color={participant.color} isLocal={participant.isLocal} />
			<button
				type="button"
				disabled={participant.isLocal}
				onClick={() => props.onClick(participant.id)}
				title={participant.isLocal ? 'You' : `Find ${participant.name} on the canvas`}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					minWidth: 0,
					flex: 1,
					border: 0,
					background: 'transparent',
					color: wm.ink,
					padding: '2px 3px',
					fontFamily: wm.sans,
					fontSize: 12,
					cursor: participant.isLocal ? 'default' : 'pointer',
				}}
			>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{participant.name}{participant.isLocal ? ' (you)' : ''}
				</span>
			</button>
			<LatencyPill latency={props.latency} history={props.latencyHistory} />
			{props.avControls && (
				<div style={{ display: 'flex', gap: 3, flex: '0 0 auto' }}>
					<AvIconButton
						kind="mic"
						enabled={props.avControls.micEnabled}
						available={props.avControls.available}
						onClick={props.avControls.onMic}
					/>
					<AvIconButton
						kind="camera"
						enabled={props.avControls.camEnabled}
						available={props.avControls.available}
						onClick={props.avControls.onCam}
					/>
					<AvIconButton
						kind="spatial"
						enabled={props.avControls.spatialEnabled}
						available={props.avControls.available}
						onClick={props.avControls.onSpatial}
					/>
				</div>
			)}
			{!participant.isLocal && (
				<button
					type="button"
					disabled={props.kicking}
					onClick={() => props.onKick(participant)}
					aria-label={`Kick ${participant.name}`}
					style={{
						border: `1px solid ${wm.ruleStrong}`,
						borderRadius: 2,
						background: 'transparent',
						color: wm.crit,
						padding: '3px 5px',
						fontFamily: wm.mono,
						fontSize: 9,
						textTransform: 'uppercase',
						cursor: 'pointer',
					}}
				>
					{props.kicking ? 'Kicking' : 'Kick'}
				</button>
			)}
		</div>
	)
}

// The roster colour dot. For remote users it's a static swatch. For the local
// user it's a button that opens a picker of the identity palette — one control
// that governs the user's whole colour identity (cursor, ring, roster dot, new
// stickies, next-drawn shapes, and screenshare borders). Lives on the roster
// (not the faces rail) so it's reachable even with the camera off.
function ColorDot({ color, isLocal }: { color: string; isLocal: boolean }) {
	const editor = useEditor()
	const [open, setOpen] = useState(false)

	const dotStyle: React.CSSProperties = {
		width: 8,
		height: 8,
		borderRadius: '50%',
		background: color,
		flex: '0 0 auto',
	}

	if (!isLocal) return <span style={dotStyle} />

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
		<div style={{ position: 'relative', flex: '0 0 auto', display: 'flex' }}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				title="Change your colour"
				style={{
					...dotStyle,
					border: `1px solid ${wm.rule}`,
					padding: 0,
					cursor: 'pointer',
				}}
			/>
			{open && (
				<div
					style={{
						position: 'absolute',
						top: 14,
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

// A roster row for a subscribe-only bot (the transcriber scribe). Unlike a
// ParticipantRow it isn't clickable (no cursor to zoom to) or kickable — it's
// session infrastructure, shown purely so people know they're being recorded.
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
