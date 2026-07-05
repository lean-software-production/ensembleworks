/**
 * The client plugin manifest (unified-architecture-design.md §1.1/§1.2,
 * client half). A plugin is a plain module object — composition is
 * build-time via the ordered list in ../plugins.ts. Registry order is
 * meaningful: it fixes shape-util registration order and toolbar/menu
 * render order.
 */
import type { ComponentType } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLComponents, TLShape, TLUiToolItem } from 'tldraw'

export interface RoomHooks {
	/**
	 * Veto-able per-shape delete gate (runs for every shape in the gesture).
	 * Return false to cancel the whole delete batch.
	 */
	beforeShapeDelete?: (shape: TLShape, source: 'user' | 'remote') => false | void
	/** Runs after a shape is actually deleted (locally or over sync). */
	afterShapeDelete?: (shape: TLShape) => void
	/** Torn down when the editor unmounts. */
	cleanup?: () => void
}

/** Called once per editor mount, so hook closures get per-mount state. */
export type RoomHooksFactory = (editor: Editor) => RoomHooks

export interface ClientPlugin {
	id: string
	/** ShapeUtil classes contributed to the editor, in declaration order. */
	shapeUtils?: readonly TLAnyShapeUtilConstructor[]
	/** Custom toolbar icons merged into tldraw's assetUrls.icons. */
	icons?: Readonly<Record<string, string>>
	/** Custom tools merged into the tldraw tool map (uiOverrides.tools). */
	tools?: (editor: Editor) => Record<string, TLUiToolItem>
	/** Rendered after DefaultToolbarContent, in registry order. */
	ToolbarItems?: ComponentType
	/** Rendered inside the EnsembleWorks main-menu group, in registry order. */
	MenuItems?: ComponentType
	/** Rendered as a child of <Tldraw> (inside editor context). */
	Overlay?: ComponentType
	/** tldraw component-slot overrides (e.g. the A/V panel claims SharePanel). */
	uiSlots?: Partial<TLComponents>
	/** Delete vetoes / after-delete effects, attached at editor mount. */
	roomHooks?: RoomHooksFactory
}

export function collectShapeUtils(plugins: readonly ClientPlugin[]): TLAnyShapeUtilConstructor[] {
	return plugins.flatMap((plugin) => [...(plugin.shapeUtils ?? [])])
}

export function collectIcons(plugins: readonly ClientPlugin[]): Record<string, string> {
	const icons: Record<string, string> = {}
	for (const plugin of plugins) Object.assign(icons, plugin.icons ?? {})
	return icons
}

export function collectUiSlots(plugins: readonly ClientPlugin[]): Partial<TLComponents> {
	const slots: Partial<TLComponents> = {}
	for (const plugin of plugins) Object.assign(slots, plugin.uiSlots ?? {})
	return slots
}
