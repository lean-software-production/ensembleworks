/**
 * Pop-out A/V host: React-portals the video tiles into the child window that
 * chrome/avPopoutWindow.ts opened. Mounted once in App as a flex sibling of the
 * side panel; it renders NOTHING in the canvas window (only a portal, and only
 * while a pop-out window is live).
 *
 * Why a portal (and not a second page load): the product constraint is ONE
 * meeting on ONE connection — you must not appear to peers as a duplicate
 * participant. A portal renders the tiles into a second, same-origin window
 * while they still execute in THIS tab's React tree, so the single LiveKit Room
 * (av/useLiveKitRoom.ts) and the single tldraw presence connection are
 * untouched. The child window is a second VIEW of the same session's video,
 * never a second participant. See chrome/avPopout.ts for the pure lifecycle and
 * chrome/avPopoutWindow.ts for how the window is acquired.
 *
 * The tiles are the same PanelTile the side panel renders, with leashing off
 * (leashable=false) — a cursor leash can't span the two windows' coordinate
 * spaces. When popped, the side panel stops rendering its own tiles (see
 * SidePanel.tsx), so nothing double-attaches a video track or double-registers.
 */
import { useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { rawUserId } from '@ensembleworks/contracts'
import { type Editor, useValue } from 'tldraw'
import { useAvSnapshot } from '../av/bridge'
import { wm } from '../theme'
import { usePopoutState } from './avPopout'
import { closeAvPopout, handlePopoutWindowClosed, usePopoutWindow } from './avPopoutWindow'
import { PanelTile, type PanelTileParticipant } from './PanelTile'

export function AvPopoutHost({ editor }: { editor: Editor }) {
	const state = usePopoutState()
	const popoutWindow = usePopoutWindow()

	useEffect(() => {
		if (state !== 'popped' || !popoutWindow) return
		// Notice the user closing the child window (its own close button) and
		// self-heal to docked. Polling `closed` is the portable way to catch a
		// manual close of a popup / PiP window.
		const poll = window.setInterval(() => {
			if (popoutWindow.closed) handlePopoutWindowClosed()
		}, 400)
		// If the CANVAS window unloads (reload/close), take the child with it — no
		// orphan window, no persistence across reload. React does not run effect
		// cleanups on a browser unload, so this explicit listener is required.
		const closeChild = () => popoutWindow.close()
		window.addEventListener('pagehide', closeChild)

		return () => {
			window.clearInterval(poll)
			window.removeEventListener('pagehide', closeChild)
			// Close AFTER React has unmounted the portal above (this cleanup runs
			// once the window ref is cleared / we dock), so the tiles detach from a
			// live document. A no-op if the window is already gone.
			popoutWindow.close()
		}
	}, [state, popoutWindow])

	if (state !== 'popped' || !popoutWindow) return null
	return createPortal(<PopoutView editor={editor} />, popoutWindow.document.body)
}

const tileWrapStyle: CSSProperties = {
	display: 'flex',
	flexWrap: 'wrap',
	justifyContent: 'center',
	gap: 8,
}

// The child window's content: a slim header (title + Bring back) over the same
// participant tiles the panel builds — self first, then collaborators — flat
// (no page grouping): the ask is "just the video tiles". Runs in the opener's
// React tree, so useValue / useAvSnapshot subscribe to the live editor and A/V
// snapshot exactly as the panel does.
function PopoutView({ editor }: { editor: Editor }) {
	const snap = useAvSnapshot()
	const participants = useValue(
		'popout-participants',
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

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 8,
					padding: '8px 12px',
					background: wm.panel,
					borderBottom: `1px solid ${wm.ruleStrong}`,
					flex: '0 0 auto',
				}}
			>
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
					A/V
				</span>
				<button
					type="button"
					data-testid="ew-av-bring-back"
					onClick={() => closeAvPopout()}
					title="Bring the video tiles back into the canvas window"
					style={{
						border: `1px solid ${wm.ruleStrong}`,
						borderRadius: 4,
						background: wm.bg,
						color: wm.ink,
						padding: '4px 10px',
						fontFamily: wm.sans,
						fontSize: 12,
						cursor: 'pointer',
						flex: '0 0 auto',
					}}
				>
					Bring back
				</button>
			</div>
			<div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
				<div style={tileWrapStyle}>
					{participants.map((participant) => (
						<PanelTile
							key={participant.rawId}
							editor={editor}
							participant={participant}
							snap={snap}
							twoUp
							leashable={false}
						/>
					))}
				</div>
			</div>
		</div>
	)
}
