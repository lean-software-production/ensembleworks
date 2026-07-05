/**
 * Kernel UI assembly: tldraw overrides and component slots built from the
 * plugin registry — custom tools, toolbar items after tldraw's defaults,
 * the EnsembleWorks main-menu group, and plugin-owned component slots
 * (the A/V overlay claims SharePanel).
 */
import {
	DefaultMainMenu,
	DefaultMainMenuContent,
	DefaultToolbar,
	DefaultToolbarContent,
	TLComponents,
	TLUiOverrides,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	TldrawUiMenuGroup,
	TldrawUiMenuItem,
	useDialogs,
} from 'tldraw'
import { collectUiSlots } from './kernel/plugin'
import { plugins } from './plugins'

export const uiOverrides: TLUiOverrides = {
	tools(editor, tools) {
		for (const plugin of plugins) {
			if (plugin.tools) Object.assign(tools, plugin.tools(editor))
		}
		return tools
	},
}

function PluginToolbar() {
	return (
		<DefaultToolbar>
			<DefaultToolbarContent />
			{plugins.map((plugin) => {
				const Item = plugin.ToolbarItems
				return Item ? <Item key={plugin.id} /> : null
			})}
		</DefaultToolbar>
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

function PluginMainMenu() {
	return (
		<DefaultMainMenu>
			<DefaultMainMenuContent />
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

export const components: TLComponents = {
	Toolbar: PluginToolbar,
	MainMenu: PluginMainMenu,
	...collectUiSlots(plugins),
}
