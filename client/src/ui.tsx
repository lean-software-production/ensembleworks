/**
 * Kernel UI assembly (canvas-controls spec §4/§6/§8): the EnsembleWorks
 * command bar claims tldraw's Toolbar slot, the style panel goes contextual
 * via InFrontOfTheCanvas, navigation/menu chrome is suppressed, and the
 * top-left panel is pages-only until Phase 2 moves pages into the side panel.
 * Plugin-owned component slots (the A/V overlay claims SharePanel) merge in
 * from the registry.
 */
import { DefaultPageMenu, TLComponents, TLUiOverrides } from 'tldraw'
import { CommandBar } from './chrome/CommandBar'
import { ContextualStylePanel } from './chrome/ContextualStylePanel'
import { collectUiSlots } from './kernel/plugin'
import { plugins } from './plugins'

export const uiOverrides: TLUiOverrides = {
	tools(editor, tools) {
		// S aliases V for select, so the bar's underlined accelerator ("s̲elect")
		// works without breaking tldraw muscle memory (spec §4).
		if (tools.select) tools.select = { ...tools.select, kbd: 'v,s' }
		for (const plugin of plugins) {
			if (plugin.tools) Object.assign(tools, plugin.tools(editor))
		}
		return tools
	},
}

/**
 * Pages-only top-left panel: page switching must survive Phase 1 (spec §9).
 * Deliberately omits vs tldraw's DefaultMenuPanel: no menu-zone chrome (main
 * menu / people menu wrapper), no wheel pass-through to the canvas, and no
 * auto-hide when there's only a single page — acceptable Phase-1 interim
 * behavior, to be revisited when pages move into the side panel.
 */
function PagesMenuPanel() {
	return (
		<div style={{ margin: 8, pointerEvents: 'auto' }}>
			<DefaultPageMenu />
		</div>
	)
}

export const components: TLComponents = {
	Toolbar: CommandBar,
	StylePanel: null,
	MenuPanel: PagesMenuPanel,
	NavigationPanel: null,
	InFrontOfTheCanvas: ContextualStylePanel,
	...collectUiSlots(plugins),
}
