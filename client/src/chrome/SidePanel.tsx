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
 */
import { useState } from 'react'
import { type Editor, useValue } from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { VmStrip } from '../av/gauges'
import { TranscriptModal } from '../av/TranscriptModal'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import { PanelFooter } from './PanelFooter'
import { PanelPages } from './PanelPages'

// Blink animation for the recording dot, ported from the old floating
// session-panel roster's ScribeRow (deleted at Task 5 cutover) — kept as a
// scoped <style> tag next to its only user.
const scribeBlinkKeyframes =
	'@keyframes scribe-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'

export function SidePanel({ editor }: { editor: Editor }) {
	const snap = useAvSnapshot()
	const [transcriptOpen, setTranscriptOpen] = useState(false)
	const participantCount = useValue(
		'panel-participant-count',
		() => editor.getCollaborators().length + 1,
		[editor]
	)

	return (
		<div
			data-testid="ew-side-panel"
			style={{
				width: 280,
				flex: '0 0 auto',
				height: '100%',
				display: 'flex',
				flexDirection: 'column',
				background: wm.panel,
				borderLeft: `1px solid ${wm.ruleStrong}`,
				fontFamily: wm.sans,
				overflowY: 'auto',
			}}
		>
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
