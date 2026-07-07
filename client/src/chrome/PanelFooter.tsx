/**
 * Panel footer (canvas-controls spec §3 item 4, Task 4): pinned to the
 * bottom of the side panel — settings / help / about. We're outside tldraw's
 * React context here (see SidePanel.tsx's header comment), so these are
 * inline expanding sections rather than tldraw dialogs.
 *
 * Help text lists the command bar's actual accelerators (chrome/CommandBar.tsx
 * PRIORITY_TOOLS/OVERFLOW_TOOLS + the terminal/screenshare plugin barItems) —
 * kept honest against that file rather than invented. Note tldraw's `select`
 * tool kbd is only 'v' (no 's' alternative), so it's listed as "select V".
 */
import { useState, type ReactNode } from 'react'
import { wm } from '../theme'
import { updateSettings, useSettings } from './settings'

type OpenSection = 'settings' | 'help' | 'about' | null

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
				<button
					type="button"
					onClick={() => toggle('about')}
					style={{ ...footerButtonStyle, color: open === 'about' ? wm.sealBlue : wm.inkMuted }}
				>
					about
				</button>
			</div>
			{open === 'settings' && <SettingsSection />}
			{open === 'help' && <HelpSection />}
			{open === 'about' && <AboutSection />}
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
				select <b>V</b> · note <b>N</b> · text <b>T</b> · frame <b>F</b> · terminal <b>M</b> · cast{' '}
				<b>C</b>
			</ShortcutLine>
			<ShortcutLine>
				tldraw defaults: draw <b>D</b> · eraser <b>E</b> · arrow <b>A</b> · line <b>L</b> · rectangle{' '}
				<b>R</b> · laser <b>K</b> · hand <b>H</b>
			</ShortcutLine>
		</div>
	)
}

function AboutSection() {
	// __APP_VERSION__ is `git describe --tags --always --dirty` (vite.config.ts)
	// and release tags are already `vX.Y.Z` (deploy/release.sh), so the string
	// already carries its leading "v" — MainMenu.tsx's About dialog renders it
	// bare for the same reason; don't prepend a second one here.
	return (
		<div style={sectionStyle}>
			<span style={{ fontSize: 11, color: wm.inkMuted }}>EnsembleWorks {__APP_VERSION__}</span>
		</div>
	)
}
