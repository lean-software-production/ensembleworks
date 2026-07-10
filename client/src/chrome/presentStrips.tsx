/**
 * Present-mode bar replacements (canvas-controls spec §5), split out of
 * CommandBar.tsx: PresenterStrip (laser · note · END PRESENTING · rec dot)
 * and ViewerStrip (Following ⟨name⟩ · STOP FOLLOWING). Both deliberately
 * ignore the dock-edge setting and render horizontal bottom-center — they're
 * transient overlays, not the persistent bar (see CommandBar.tsx's header).
 */
import { stopEventPropagation, useValue, type Editor, type TLUiToolsContextType } from 'tldraw'
import { wm } from '../theme'
import { AccentButton, barStyle, dividerStyle, NATIVE_LABELS, NativeToolButton } from './barButtons'
import {
	presentingAtom,
	promoteTo,
	toggleHand,
	useHandPosition,
	useHandQueue,
	useHandRaised,
	type Presenter,
} from './present'

// Blink animation for the presenter strip's rec dot — same visual language as
// the side panel's recording indicators (SidePanel.tsx's scribeBlinkKeyframes
// / PanelFooter), duplicated locally rather than imported since the bar
// lives outside that module and the keyframe name/rule is trivially small.
const barRecBlinkKeyframes =
	'@keyframes ew-bar-rec-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'

function RecDot() {
	return (
		<>
			<style>{barRecBlinkKeyframes}</style>
			<span
				aria-hidden="true"
				title="Recording"
				style={{
					width: 8,
					height: 8,
					borderRadius: '50%',
					background: wm.crit,
					flex: '0 0 auto',
					animation: 'ew-bar-rec-blink 1.4s ease-in-out infinite',
				}}
			/>
		</>
	)
}

// Request-to-present queue, presenter's view (see chrome/handQueue.ts): the
// ordered hands-up list (front bolded) plus a one-click hand-off that promotes
// the FRONT of the queue. Renders nothing when no hands are up. `promoteTo`
// stamps a handoff token in our presence meta and steps us down; the promoted
// client sees the token and takes over (present.ts's useConsumeHandoff) — no
// server message, same presence channel as everything else in Present mode.
function QueueControl({ editor }: { editor: Editor }) {
	const queue = useHandQueue(editor)
	if (queue.length === 0) return null
	const next = queue[0]!
	return (
		<>
			<div style={dividerStyle} />
			<span
				data-testid="ew-hand-queue"
				aria-label={`Hands raised: ${queue.map((r) => r.userName).join(', ')}`}
				style={{ fontSize: 11, color: wm.inkMuted, whiteSpace: 'nowrap' }}
			>
				<span aria-hidden="true">{'✋ '}</span>
				{queue.map((r, i) => (
					<span
						key={r.userId}
						style={{ color: i === 0 ? wm.ink : wm.inkMuted, fontWeight: i === 0 ? 700 : 400 }}
					>
						{i > 0 ? ', ' : ''}
						{r.userName}
					</span>
				))}
			</span>
			<AccentButton
				id="promote-next"
				icon="chevron-up"
				label="hand off"
				accentColor={wm.ok}
				title={`Hand off to ${next.userName}`}
				onClick={() => promoteTo(next.userId)}
			/>
		</>
	)
}

// Raise-hand toggle (see chrome/handQueue.ts): request the room. Shown in the
// viewer strip; also lives on the normal bar (CommandBar) so raising works when
// nobody is presenting. Amber when raised (waiting), with your place in line.
export function RaiseHandButton({ editor, iconOnly }: { editor: Editor; iconOnly?: boolean }) {
	const raised = useHandRaised()
	const position = useHandPosition(editor)
	return (
		<AccentButton
			id="raise-hand"
			icon="tool-hand"
			label={raised ? (position ? `hand raised · #${position}` : 'hand raised') : 'raise hand'}
			accentColor={raised ? wm.warn : wm.sealBlue}
			title={raised ? 'Lower hand (Q)' : 'Raise hand to request to present (Q)'}
			iconOnly={iconOnly}
			onClick={toggleHand}
		/>
	)
}

// Presenter mode (spec §5 "Presenter: bar becomes laser · note · END
// PRESENTING (+ rec dot)"): replaces the ENTIRE bar. Laser/note reuse the
// native tools (same NativeToolButton the normal bar uses for its priority
// tools) so arming them behaves identically to picking them off the full bar.
//
// `otherPresenter`: tryStartPresenting (present.ts) closes the render-lag
// simultaneous-press race, but two P presses can still cross on the network —
// both clients present, neither's guard saw the other. When that happens a
// collaborator's presenting meta shows up WHILE we present; surface it here
// so the collision is visible and one of them can END, rather than each
// silently assuming they have the room.
export function PresenterStrip({
	editor,
	tools,
	currentToolId,
	showRecDot,
	otherPresenter,
}: {
	editor: Editor
	tools: TLUiToolsContextType
	currentToolId: string
	showRecDot: boolean
	otherPresenter: Presenter | null
}) {
	const laserTool = tools['laser']
	const noteTool = tools['note']
	return (
		<div data-testid="ew-command-bar" onPointerDown={stopEventPropagation} style={barStyle}>
			{laserTool && (
				<NativeToolButton tool={laserTool} label={NATIVE_LABELS.laser ?? 'laser'} currentToolId={currentToolId} />
			)}
			{noteTool && (
				<NativeToolButton tool={noteTool} label={NATIVE_LABELS.note ?? 'note'} currentToolId={currentToolId} />
			)}
			<div style={dividerStyle} />
			<AccentButton
				id="end-present"
				icon="cross-circle"
				label="end presenting"
				accentColor={wm.crit}
				title="End presenting (Esc)"
				onClick={() => presentingAtom.set(false)}
			/>
			<QueueControl editor={editor} />
			{showRecDot && <RecDot />}
			{otherPresenter && (
				<span
					data-testid="ew-bar-also-presenting"
					style={{ fontSize: 11, color: wm.warn, padding: '0 8px', whiteSpace: 'nowrap' }}
				>
					{otherPresenter.userName} is also presenting
				</span>
			)}
		</div>
	)
}

// Viewer mode (spec §5 "Viewers: … bar becomes 'Following ⟨name⟩ · STOP
// FOLLOWING'. Esc or STOP opts out locally (chrome stays minimal until
// presenting ends or they exit)."): once no longer following, the STOP button
// disappears (there's nothing left to stop) but the strip itself stays — the
// bar does NOT return to its normal contents until the presenter's meta clears.
//
// "Following" is derived from the editor's ACTUAL follow state
// (getInstanceState().followingUserId), not from our opt-out flag: tldraw
// itself stops following on any user pan/zoom, and a label driven by optedOut
// alone would keep claiming "Following" after such a manual pan-away. The
// opt-out flag still exists, but only up in CommandBar, solely to keep Esc
// from firing stopFollowing twice — it plays no part in what this strip shows.
// (A pan-away deliberately does NOT set optedOut; the auto-follow effect only
// fires on presenter-id change, so nothing yanks the viewport back either way.)
export function ViewerStrip({
	editor,
	presenter,
	onStop,
}: {
	editor: Editor
	presenter: Presenter
	onStop: () => void
}) {
	const isFollowing = useValue(
		'ew following presenter',
		() => editor.getInstanceState().followingUserId === presenter.userId,
		[editor, presenter.userId]
	)
	return (
		<div data-testid="ew-command-bar" onPointerDown={stopEventPropagation} style={barStyle}>
			<span style={{ fontSize: 11, color: wm.inkMuted, padding: '0 8px', whiteSpace: 'nowrap' }}>
				{isFollowing ? `Following ${presenter.userName}` : `${presenter.userName} is presenting`}
			</span>
			{isFollowing && (
				<AccentButton
					id="stop-following"
					icon="cross-circle"
					label="stop following"
					accentColor={wm.crit}
					title="Stop following (Esc)"
					onClick={onStop}
				/>
			)}
			<div style={dividerStyle} />
			<RaiseHandButton editor={editor} />
		</div>
	)
}
