/**
 * Kernel UI assembly: tldraw overrides and component slots built from the
 * plugin registry — custom tools, toolbar items after tldraw's defaults,
 * the EnsembleWorks main-menu group, and plugin-owned component slots
 * (the A/V overlay claims SharePanel).
 */
import { DefaultToolbar, DefaultToolbarContent, TLComponents, TLUiOverrides } from 'tldraw'
import { EnsembleMainMenu } from './chrome/MainMenu'
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

export const components: TLComponents = {
	Toolbar: PluginToolbar,
	MainMenu: EnsembleMainMenu,
	...collectUiSlots(plugins),
}
