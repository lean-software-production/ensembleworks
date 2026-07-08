/**
 * Panel footer (canvas-controls spec §3 item 4, Task 4): pinned to the
 * bottom of the side panel — settings / help / about. We're outside tldraw's
 * React context here (see SidePanel.tsx's header comment), so these are
 * inline expanding sections rather than tldraw dialogs.
 *
 * Help text lists the command bar's actual accelerators (chrome/CommandBar.tsx
 * PRIORITY_TOOLS/OVERFLOW_TOOLS + the terminal/screenshare plugin barItems) —
 * kept honest against that file rather than invented. Note select is S/V:
 * tldraw's own kbd is just 'v', but ui.tsx's tools override aliases it to
 * 'v,s' (the Phase-1 "s̲elect" accelerator, spec §4), and displayKeyForKbd
 * makes the bar underline the S — so S leads here too.
 */
import { useState, type ReactNode } from 'react'
import { wm } from '../theme'
import { DOCK_EDGE_OPTIONS, updateSettings, useSettings } from './settings'

type OpenSection = 'settings' | 'help' | null

const footerButtonStyle = {
	flex: 1,
	border: 0,
	background: 'transparent',
	color: wm.inkMuted,
	padding: '8px 4px',
	fontFamily: wm.mono,
	fontSize: 10,
	textTransform: 'uppercase' as const,
	letterSpacing: 0.9,
	cursor: 'pointer',
}

const sectionStyle = {
	padding: '8px 12px 12px',
	borderTop: `1px solid ${wm.rule}`,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: 6,
}

export function PanelFooter() {
	const [open, setOpen] = useState<OpenSection>(null)
	const toggle = (section: OpenSection) => setOpen((current) => (current === section ? null : section))

	return (
		<div style={{ marginTop: 'auto', borderTop: `1px solid ${wm.ruleStrong}` }}>
			<div style={{ display: 'flex' }}>
				<button
					type="button"
					onClick={() => toggle('settings')}
					style={{ ...footerButtonStyle, color: open === 'settings' ? wm.sealBlue : wm.inkMuted }}
				>
					⚙ settings
				</button>
				<button
					type="button"
					onClick={() => toggle('help')}
					style={{ ...footerButtonStyle, color: open === 'help' ? wm.sealBlue : wm.inkMuted }}
				>
					? help
				</button>
				{/* The old "about" button just toggled a panel that showed the
				    version — so show the version here directly (spec §3 footer).
				    __APP_VERSION__ (vite.config.ts) is `git describe`, and release
				    tags are `vX.Y.Z`, so the leading "v" is already there. */}
				<span
					title="EnsembleWorks version"
					style={{
						...footerButtonStyle,
						cursor: 'default',
						color: wm.inkSubtle,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						textAlign: 'center',
					}}
				>
					{__APP_VERSION__}
				</span>
			</div>
			{open === 'settings' && <SettingsSection />}
			{open === 'help' && <HelpSection />}
		</div>
	)
}

function SettingsSection() {
	const settings = useSettings()
	return (
		<div style={sectionStyle}>
			<label
				htmlFor="ew-settings-github"
				style={{
					fontFamily: wm.mono,
					fontSize: 9,
					fontWeight: 700,
					textTransform: 'uppercase',
					letterSpacing: 0.9,
					color: wm.inkMuted,
				}}
			>
				GitHub handle (avatar)
			</label>
			<input
				id="ew-settings-github"
				data-testid="ew-settings-github"
				type="text"
				value={settings.githubHandle}
				placeholder="octocat"
				onChange={(e) => updateSettings({ githubHandle: e.target.value })}
				style={{
					border: `1px solid ${wm.rule}`,
					borderRadius: 3,
					background: wm.bg,
					color: wm.ink,
					padding: '5px 7px',
					fontFamily: wm.sans,
					fontSize: 12,
				}}
			/>

			<span
				style={{
					fontFamily: wm.mono,
					fontSize: 9,
					fontWeight: 700,
					textTransform: 'uppercase',
					letterSpacing: 0.9,
					color: wm.inkMuted,
					marginTop: 4,
				}}
			>
				Command bar
			</span>
			<div style={{ display: 'flex', gap: 4 }}>
				{DOCK_EDGE_OPTIONS.map((edge) => (
					<button
						key={edge}
						type="button"
						data-testid={'ew-settings-dock-' + edge}
						onClick={() => updateSettings({ dockEdge: edge })}
						style={{
							flex: 1,
							border: edge === settings.dockEdge ? `1px solid ${wm.sealBlue}` : `1px solid ${wm.rule}`,
							borderRadius: 3,
							background: edge === settings.dockEdge ? wm.accentSoft : wm.bg,
							color: wm.ink,
							padding: '5px 4px',
							fontFamily: wm.sans,
							fontSize: 11,
							cursor: 'pointer',
						}}
					>
						{edge}
					</button>
				))}
			</div>
		</div>
	)
}

function ShortcutLine({ children }: { children: ReactNode }) {
	return (
		<div style={{ fontSize: 11, color: wm.inkMuted, lineHeight: 1.5 }}>{children}</div>
	)
}

function HelpSection() {
	return (
		<div style={sectionStyle}>
			<ShortcutLine>
				select <b>S/V</b> · note <b>N</b> · text <b>T</b> · frame <b>F</b> · terminal <b>M</b> · cast{' '}
				<b>C</b>
			</ShortcutLine>
			<ShortcutLine>
				tldraw defaults: draw <b>D</b> · eraser <b>E</b> · arrow <b>A</b> · line <b>L</b> · rectangle{' '}
				<b>R</b> · ellipse <b>O</b> · highlight <b>⇧D</b> · laser <b>K</b> · hand <b>H</b>
			</ShortcutLine>
			<ShortcutLine>
				pan the canvas: hold <b>Space</b> and drag, or drag with the <b>middle mouse button</b>
			</ShortcutLine>
		</div>
	)
}

