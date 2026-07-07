/**
 * The client plugin manifest (unified-architecture-design.md §1.1/§1.2,
 * client half). A plugin is a plain module object — composition is
 * build-time via the ordered list in ../plugins.ts. Registry order is
 * meaningful: it fixes shape-util registration order and toolbar/menu
 * render order.
 */
import type { ComponentType } from 'react'
import type {
	Editor,
	TLAnyShapeUtilConstructor,
	TLComponents,
	TLShape,
	TLUiDialogProps,
	TLUiToolItem,
} from 'tldraw'

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

export interface BarItemHelpers {
	/** tldraw's dialog opener (from useDialogs), passed through by the bar. */
	addDialog: (dialog: { id?: string; component: ComponentType<TLUiDialogProps> }) => void
}

/**
 * A declarative command-bar entry (canvas-controls spec §8). The bar renders
 * icon + label with the accelerator letter underlined, and fires onSelect on
 * click or on the bare accelerator key.
 */
export interface BarItemDescriptor {
	id: string
	/** Lower-case label; if `accelerator` is set it must occur in this string. */
	label: string
	/** Single lower-case letter fired without modifiers. Optional. */
	accelerator?: string
	/** tldraw icon name — built-in, or contributed via the plugin's `icons`. */
	icon: string
	placement: 'priority' | 'overflow'
	onSelect: (editor: Editor, helpers: BarItemHelpers) => void
	/** Optional availability hook; the bar hides the item (and disables its
	 * accelerator) when it returns false. Must be a stable hook function. */
	useAvailable?: () => boolean
}

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
	/** Declarative command-bar entries; replaces ToolbarItems (spec §8). */
	barItems?: readonly BarItemDescriptor[]
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

export function collectBarItems(
	plugins: readonly ClientPlugin[],
	placement: BarItemDescriptor['placement']
): BarItemDescriptor[] {
	const items = plugins.flatMap((plugin) =>
		(plugin.barItems ?? []).filter((item) => item.placement === placement)
	)
	for (const item of items) {
		if (item.accelerator && !item.label.toLowerCase().includes(item.accelerator.toLowerCase())) {
			throw new Error(
				`barItems: accelerator "${item.accelerator}" not in label "${item.label}" (item ${item.id})`
			)
		}
	}
	return items
}
