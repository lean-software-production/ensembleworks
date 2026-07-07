/**
 * The EnsembleWorks command bar (canvas-controls spec §4): one floating bar of
 * canvas verbs replacing tldraw's DefaultToolbar. Left to right: ☰ main menu,
 * priority tools (native select/note/text/frame + plugin barItems) with
 * underlined accelerators, the ⋯ overflow (demoted native tools + plugin
 * overflow items, last-used item adopted next to the ⋯ trigger), and zoom.
 * Present button lands in Phase 3.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
	DefaultZoomMenu,
	TldrawUiButtonIcon,
	stopEventPropagation,
	useDialogs,
	useEditor,
	useTools,
	useValue,
	type TLUiIconJsx,
	type TLUiToolItem,
} from 'tldraw'
import { collectBarItems, type BarItemDescriptor, type BarItemHelpers } from '../kernel/plugin'
import { plugins } from '../plugins'
import { wm } from '../theme'
import { displayKeyForKbd, splitAccelLabel } from './accel'
import { EnsembleMainMenu } from './MainMenu'

// Native tldraw tools shown as first-class verbs, in bar order (spec §4).
const PRIORITY_TOOLS = ['select', 'note', 'text', 'frame'] as const
// Demoted native tools living in the ⋯ overflow, in menu order.
const OVERFLOW_TOOLS = [
	'draw', 'eraser', 'arrow', 'line', 'rectangle', 'ellipse', 'highlight', 'laser', 'hand',
] as const

const LAST_OVERFLOW_KEY = 'ensembleworks.commandBar.lastOverflow.v1'

// Lowercase display labels for native tools; tool.label is a translation key,
// not raw text, so the bar keeps its own label map (spec §4 wants lowercase).
const NATIVE_LABELS: Record<string, string> = {
	select: 'select',
	note: 'note',
	text: 'text',
	frame: 'frame',
	draw: 'draw',
	eraser: 'eraser',
	arrow: 'arrow',
	line: 'line',
	rectangle: 'rectangle',
	ellipse: 'ellipse',
	highlight: 'highlight',
	laser: 'laser',
	hand: 'hand',
}

const barStyle: CSSProperties = {
	display: 'flex',
	flexDirection: 'row',
	alignItems: 'center',
	gap: 2,
	background: wm.bg,
	border: `1px solid ${wm.ruleStrong}`,
	borderRadius: 6,
	boxShadow: wm.shadowPaper,
	padding: '4px 8px',
	pointerEvents: 'auto',
	fontFamily: wm.sans,
}

const dividerStyle: CSSProperties = {
	width: 1,
	alignSelf: 'stretch',
	margin: '4px 4px',
	background: wm.ruleStrong,
}

function AccelLabel({ label, accelerator }: { label: string; accelerator?: string | null }) {
	const split = splitAccelLabel(label, accelerator ?? undefined)
	if (split) {
		return (
			<span style={{ fontSize: 11, color: wm.inkMuted }}>
				{split.pre}
				<u
					style={{
						color: wm.ink,
						fontWeight: 700,
						textDecorationThickness: 2,
						textUnderlineOffset: 2,
					}}
				>
					{split.hit}
				</u>
				{split.post}
			</span>
		)
	}
	return (
		<span style={{ fontSize: 11, color: wm.inkMuted }}>
			{label}
			{accelerator ? <span style={{ fontSize: 9, color: wm.inkSubtle }}> {accelerator}</span> : null}
		</span>
	)
}

interface BarButtonProps {
	id: string
	icon: string | TLUiIconJsx
	label?: string
	accelerator?: string | null
	active?: boolean
	title?: string
	onClick: () => void
}

function BarButton({ id, icon, label, accelerator, active, title, onClick }: BarButtonProps) {
	return (
		<button
			type="button"
			data-testid={'ew-bar-' + id}
			title={title}
			onClick={onClick}
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 1,
				padding: '4px 6px',
				background: active ? wm.accentSoft : 'transparent',
				border: active ? `1px solid ${wm.sealBlue}` : '1px solid transparent',
				borderRadius: 4,
				cursor: 'pointer',
			}}
		>
			<TldrawUiButtonIcon icon={icon} small />
			{label ? <AccelLabel label={label} accelerator={accelerator} /> : null}
		</button>
	)
}

function NativeToolButton({
	tool,
	label,
	currentToolId,
}: {
	tool: TLUiToolItem
	label: string
	currentToolId: string
}) {
	const accel = displayKeyForKbd(tool.kbd, label)
	return (
		<BarButton
			id={tool.id}
			icon={tool.icon}
			label={label}
			accelerator={accel}
			active={currentToolId === tool.id}
			onClick={() => tool.onSelect('toolbar')}
		/>
	)
}

function PluginBarButton({
	item,
	editor,
	helpers,
}: {
	item: BarItemDescriptor
	editor: ReturnType<typeof useEditor>
	helpers: BarItemHelpers
}) {
	const available = item.useAvailable?.() ?? true
	if (!available) return null
	return (
		<BarButton
			id={item.id}
			icon={item.icon}
			label={item.label}
			accelerator={item.accelerator}
			onClick={() => item.onSelect(editor, helpers)}
		/>
	)
}

/**
 * Always-mounted invisible probe: calls an item's useAvailable hook and
 * reports the result upward, so availability is known even for overflow items
 * whose buttons only mount while the ⋯ menu is open. One instance per item
 * (hooks rules), keyed by item id; only rendered for items with a hook.
 */
function AvailabilityProbe({
	item,
	report,
}: {
	item: BarItemDescriptor
	report: (id: string, available: boolean) => void
}) {
	const available = item.useAvailable!()
	useEffect(() => {
		report(item.id, available)
	}, [item.id, available, report])
	return null
}

export function CommandBar() {
	const editor = useEditor()
	const tools = useTools()
	const { addDialog } = useDialogs()
	const helpers: BarItemHelpers = useMemo(() => ({ addDialog }), [addDialog])

	const currentToolId = useValue('current tool', () => editor.getCurrentToolId(), [editor])

	const rootRef = useRef<HTMLDivElement>(null)
	const [overflowOpen, setOverflowOpen] = useState(false)
	const [lastOverflowId, setLastOverflowId] = useState<string | null>(() =>
		localStorage.getItem(LAST_OVERFLOW_KEY)
	)
	const recordLastOverflow = useCallback((id: string) => {
		setLastOverflowId(id)
		localStorage.setItem(LAST_OVERFLOW_KEY, id)
	}, [])

	const priorityItems = useMemo(() => collectBarItems(plugins, 'priority'), [])
	const overflowItems = useMemo(() => collectBarItems(plugins, 'overflow'), [])

	// Availability of plugin items with a useAvailable hook, fed by the
	// always-mounted probes below. The ref keeps the keydown listener current
	// without re-subscribing; the version bump re-renders the overflow menu.
	const availabilityRef = useRef<Map<string, boolean>>(new Map())
	const [, setAvailabilityVersion] = useState(0)
	const reportAvailability = useCallback((id: string, available: boolean) => {
		if (availabilityRef.current.get(id) === available) return
		availabilityRef.current.set(id, available)
		setAvailabilityVersion((v) => v + 1)
	}, [])
	// Priority items subscribe twice — a probe here plus PluginBarButton's own
	// hook call. Intentional and harmless; the probe covers the keydown map.
	const probeItems = useMemo(
		() => [...priorityItems, ...overflowItems].filter((item) => item.useAvailable),
		[priorityItems, overflowItems]
	)
	// Items without a hook are always available.
	const isItemAvailable = (item: BarItemDescriptor) =>
		!item.useAvailable || (availabilityRef.current.get(item.id) ?? true)

	useEffect(() => {
		const itemsByAccelerator = new Map<string, BarItemDescriptor>()
		for (const item of [...priorityItems, ...overflowItems]) {
			if (item.accelerator) itemsByAccelerator.set(item.accelerator.toLowerCase(), item)
		}

		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
			const target = e.target as HTMLElement | null
			if (target) {
				if (target.isContentEditable) return
				const tag = target.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
			}
			if (editor.getEditingShapeId() !== null) return
			if (!editor.getInstanceState().isFocused) return

			const item = itemsByAccelerator.get(e.key.toLowerCase())
			if (!item) return
			// Unavailable items have their accelerator disabled (plugin contract).
			if (item.useAvailable && availabilityRef.current.get(item.id) === false) return
			e.preventDefault()
			item.onSelect(editor, helpers)
			// Overflow items fired via accelerator get adopted next to ⋯ too.
			if (item.placement === 'overflow') recordLastOverflow(item.id)
		}

		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [editor, helpers, priorityItems, overflowItems, recordLastOverflow])

	// Dismiss the overflow menu on outside pointerdown or Escape. Escape is
	// safe to handle even where the accelerator typing guards would apply.
	useEffect(() => {
		if (!overflowOpen) return
		function onPointerDown(e: PointerEvent) {
			const root = rootRef.current
			if (root && e.target instanceof Node && !root.contains(e.target)) setOverflowOpen(false)
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape') setOverflowOpen(false)
		}
		window.addEventListener('pointerdown', onPointerDown)
		window.addEventListener('keydown', onKeyDown)
		return () => {
			window.removeEventListener('pointerdown', onPointerDown)
			window.removeEventListener('keydown', onKeyDown)
		}
	}, [overflowOpen])

	const lastOverflowNativeTool =
		lastOverflowId && (OVERFLOW_TOOLS as readonly string[]).includes(lastOverflowId)
			? tools[lastOverflowId]
			: undefined
	const lastOverflowPluginItem = lastOverflowId
		? overflowItems.find((item) => item.id === lastOverflowId)
		: undefined

	return (
		<div
			ref={rootRef}
			data-testid="ew-command-bar"
			onPointerDown={stopEventPropagation}
			style={{ position: 'relative', ...barStyle }}
		>
			{probeItems.map((item) => (
				<AvailabilityProbe key={item.id} item={item} report={reportAvailability} />
			))}
			<EnsembleMainMenu />
			<div style={dividerStyle} />

			{PRIORITY_TOOLS.map((id) => {
				const tool = tools[id]
				if (!tool) return null
				return (
					<NativeToolButton
						key={id}
						tool={tool}
						label={NATIVE_LABELS[id] ?? id}
						currentToolId={currentToolId}
					/>
				)
			})}

			{priorityItems.map((item) => (
				<PluginBarButton key={item.id} item={item} editor={editor} helpers={helpers} />
			))}

			{lastOverflowNativeTool ? (
				<NativeToolButton
					tool={lastOverflowNativeTool}
					label={NATIVE_LABELS[lastOverflowNativeTool.id] ?? lastOverflowNativeTool.id}
					currentToolId={currentToolId}
				/>
			) : lastOverflowPluginItem ? (
				<PluginBarButton item={lastOverflowPluginItem} editor={editor} helpers={helpers} />
			) : null}

			<BarButton
				id="overflow"
				icon="dots-horizontal"
				title="More tools"
				onClick={() => setOverflowOpen((open) => !open)}
			/>

			<div style={dividerStyle} />
			<DefaultZoomMenu />

			{overflowOpen ? (
				<div
					data-testid="ew-bar-overflow-menu"
					style={{
						position: 'absolute',
						bottom: 'calc(100% + 8px)',
						right: 0,
						display: 'flex',
						flexDirection: 'column',
						gap: 2,
						background: wm.bg,
						border: `1px solid ${wm.ruleStrong}`,
						borderRadius: 6,
						boxShadow: wm.shadowPaper,
						padding: '4px 8px',
						pointerEvents: 'auto',
						fontFamily: wm.sans,
					}}
				>
					{OVERFLOW_TOOLS.map((id) => {
						const tool = tools[id]
						if (!tool) return null
						const accel = displayKeyForKbd(tool.kbd, NATIVE_LABELS[id] ?? id)
						return (
							<BarButton
								key={id}
								id={'overflow-' + id}
								icon={tool.icon}
								label={NATIVE_LABELS[id] ?? id}
								accelerator={accel}
								active={currentToolId === id}
								onClick={() => {
									tool.onSelect('toolbar')
									recordLastOverflow(id)
									setOverflowOpen(false)
								}}
							/>
						)
					})}
					{overflowItems.map((item) => {
						// Unavailable plugin items are hidden (plugin contract).
						if (!isItemAvailable(item)) return null
						return (
							<BarButton
								key={item.id}
								id={'overflow-' + item.id}
								icon={item.icon}
								label={item.label}
								accelerator={item.accelerator}
								onClick={() => {
									item.onSelect(editor, helpers)
									recordLastOverflow(item.id)
									setOverflowOpen(false)
								}}
							/>
						)
					})}
				</div>
			) : null}
		</div>
	)
}
