import { wm } from '../theme'

export type AvIconKind = 'mic' | 'camera' | 'spatial'

export function AvIconButton(props: {
	kind: AvIconKind
	enabled: boolean
	available: boolean
	onClick: () => void
}) {
	const names: Record<AvIconKind, string> = {
		mic: 'microphone',
		camera: 'camera',
		spatial: 'spatial audio',
	}
	const label = `${names[props.kind]} ${props.enabled ? 'on' : 'off'}`
	return (
		<button
			type="button"
			disabled={!props.available}
			onClick={props.onClick}
			aria-label={label}
			title={props.available ? label : `${names[props.kind]} unavailable`}
			style={{
				width: 25,
				height: 25,
				display: 'grid',
				placeItems: 'center',
				border: `1px solid ${props.enabled ? wm.sealBlue : wm.ruleStrong}`,
				borderRadius: 2,
				padding: 3,
				background: props.enabled ? wm.sealBlue : 'transparent',
				color: props.enabled ? wm.cream : wm.inkMuted,
				cursor: props.available ? 'pointer' : 'not-allowed',
				opacity: props.available ? 1 : 0.4,
			}}
		>
			<AvIcon kind={props.kind} crossedOut={!props.enabled} />
		</button>
	)
}

// Exported for non-interactive status uses too (e.g. a panel tile showing a
// remote peer's cam state) — the glyph alone, no button chrome.
export function AvIcon({ kind, crossedOut }: { kind: AvIconKind; crossedOut: boolean }) {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			{kind === 'mic' && (
				<>
					<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" />
					<path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</>
			)}
			{kind === 'camera' && (
				<>
					<rect x="3" y="7" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
					<path d="m16 11 5-3v9l-5-3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
				</>
			)}
			{kind === 'spatial' && (
				<>
					<circle cx="12" cy="12" r="2" fill="currentColor" />
					<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</>
			)}
			{crossedOut && <path d="M4 4 20 20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />}
		</svg>
	)
}
