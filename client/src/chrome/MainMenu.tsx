/**
 * The EnsembleWorks main menu (☰) and its About dialog, rendered inside the
 * command bar (canvas-controls spec §4).
 *
 * ☰ is trimmed to canvas verbs only (spec §4: Edit, View, Export, embed/
 * upload) — Preferences, Language and Keyboard-shortcuts move out per spec
 * §3 ("The panel absorbs from tldraw's stock menus: Preferences, Language,
 * Keyboard shortcuts…"). We don't reuse tldraw's `DefaultMainMenuContent`
 * wholesale (it also composes `PreferencesGroup`, which itself renders
 * `LanguageMenu` and `KeyboardShortcutsMenuItem` as siblings inside the same
 * group) — instead we compose the individually-exported pieces directly.
 */
import {
	AccessibilityMenu,
	ColorSchemeMenu,
	DefaultMainMenu,
	EditSubmenu,
	ExportFileContentSubMenu,
	ExtrasGroup,
	InputModeMenu,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	TldrawUiMenuSubmenu,
	ToggleDebugModeItem,
	ToggleDynamicSizeModeItem,
	ToggleEdgeScrollingItem,
	ToggleFocusModeItem,
	ToggleGridItem,
	TogglePasteAtCursorItem,
	ToggleSnapModeItem,
	ToggleToolLockItem,
	ToggleWrapModeItem,
	useDialogs,
	ViewSubmenu,
} from 'tldraw'
import { plugins } from '../plugins'

/**
 * Trimmed stand-in for tldraw's `PreferencesGroup`: same editor-preference
 * toggles and user-interface submenus (accessibility, input mode, colour
 * scheme) as the stock group, minus the `LanguageMenu` and
 * `KeyboardShortcutsMenuItem` siblings the stock group also renders — those
 * two are explicitly dropped from ☰ per spec §4 (help now lists shortcuts
 * in the panel footer; no language switcher exists yet).
 *
 * Colour-scheme switching (`ColorSchemeMenu`) has nowhere else to live yet —
 * the panel's settings footer (chrome/PanelFooter.tsx, Task 4) doesn't expose
 * a dark-mode toggle, and adding one is a phase-3 question, not this cutover
 * — so it's kept here rather than dropped outright with the rest of
 * Preferences. Revisit once the panel grows a colour-scheme control.
 */
function TrimmedPreferencesGroup() {
	return (
		<TldrawUiMenuGroup id="preferences">
			<TldrawUiMenuSubmenu id="preferences" label="menu.preferences">
				<TldrawUiMenuGroup id="preferences-actions">
					<ToggleSnapModeItem />
					<ToggleToolLockItem />
					<ToggleGridItem />
					<ToggleWrapModeItem />
					<ToggleFocusModeItem />
					<ToggleEdgeScrollingItem />
					<ToggleDynamicSizeModeItem />
					<TogglePasteAtCursorItem />
					<ToggleDebugModeItem />
				</TldrawUiMenuGroup>
				<TldrawUiMenuGroup id="user-interface-submenus">
					<AccessibilityMenu />
					<InputModeMenu />
					<ColorSchemeMenu />
				</TldrawUiMenuGroup>
			</TldrawUiMenuSubmenu>
		</TldrawUiMenuGroup>
	)
}

function AboutDialog(_props: { onClose: () => void }) {
	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>EnsembleWorks</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ maxWidth: 420 }}>
				<p style={{ margin: '0 0 12px' }}>Multi-player Agentic Workspace for Teams</p>
				<p style={{ margin: 0, opacity: 0.7 }}>
					Version <code>{__APP_VERSION__}</code>
				</p>
			</TldrawUiDialogBody>
		</>
	)
}

function AboutMenuItem() {
	const { addDialog } = useDialogs()
	return (
		<TldrawUiMenuItem
			id="about-sessions"
			label="About"
			icon="info-circle"
			onSelect={() => {
				addDialog({ component: AboutDialog })
			}}
		/>
	)
}

export function EnsembleMainMenu() {
	return (
		<DefaultMainMenu>
			<TldrawUiMenuGroup id="basic">
				<EditSubmenu />
				<ViewSubmenu />
				<ExportFileContentSubMenu />
				<ExtrasGroup />
			</TldrawUiMenuGroup>
			<TrimmedPreferencesGroup />
			<TldrawUiMenuGroup id="ensembleworks-demo">
				{plugins.map((plugin) => {
					const Items = plugin.MenuItems
					return Items ? <Items key={plugin.id} /> : null
				})}
				<AboutMenuItem />
			</TldrawUiMenuGroup>
		</DefaultMainMenu>
	)
}
