/**
 * The permanent right-hand side panel — an App-level flex sibling that lives
 * OUTSIDE the tldraw component tree (see plan architecture note). It talks to
 * tldraw via the `editor` prop (useValue works on any signal without React
 * context) and to AvOverlay via the av/bridge module store. No useEditor, no
 * useDialogs, no tldraw CSS variables here — plain overlays + wm tokens only.
 *
 * This task lays down the skeleton: header (room + participant count) + VM
 * strip + connection-status line. Page sections/tiles, recording row and the
 * settings/help/about footer land in later tasks.
 */
import { type Editor, useValue } from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { VmStrip } from '../av/gauges'
import { getRoomId } from '../identity'
import { wm } from '../theme'

export function SidePanel({ editor }: { editor: Editor }) {
	const snap = useAvSnapshot()
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
		</div>
	)
}
