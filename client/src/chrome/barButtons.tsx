/**
 * Shared command-bar building blocks, split out of CommandBar.tsx: the button
 * primitives (BarButton / NativeToolButton / PluginBarButton / AccentButton),
 * the bar/divider styles, and the native-tool label vocabulary — everything
 * the bar, the present strips (presentStrips.tsx) and the ⋯ overflow menu
 * (OverflowMenu.tsx) all draw on.
 */
import type { CSSProperties } from 'react'
import { TldrawUiButtonIcon, type Editor, type TLUiIconJsx, type TLUiToolItem } from 'tldraw'
import type { BarItemDescriptor, BarItemHelpers } from '../kernel/plugin'
import { wm } from '../theme'
import { displayKeyForKbd, splitAccelLabel } from './accel'

// Demoted native tools living in the ⋯ overflow, in menu order (spec §4).
// Lives here rather than in OverflowMenu.tsx because CommandBar also needs it
// (the "last-used overflow item adopted next to ⋯" lookup).
export const OVERFLOW_TOOLS = [
	'draw', 'eraser', 'arrow', 'line', 'rectangle', 'ellipse', 'highlight', 'laser', 'hand',
] as const

// Lowercase display labels for native tools; tool.label is a translation key,
// not raw text, so the bar keeps its own label map (spec §4 wants lowercase).
export const NATIVE_LABELS: Record<string, string> = {
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

export const barStyle: CSSProperties = {
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

export const dividerStyle: CSSProperties = {
	width: 1,
	alignSelf: 'stretch',
	margin: '4px 4px',
	background: wm.ruleStrong,
}

// Vertical-bar counterpart to dividerStyle above (a horizontal rule instead
// of a vertical one) — used only by the normal bar's left/right dock layout.
export const verticalDividerStyle: CSSProperties = {
	height: 1,
	alignSelf: 'stretch',
	margin: '4px 4px',
	background: wm.ruleStrong,
}

/** "label (KEY)" title text for icon-only buttons — the vertical dock edges
 * drop the visible AccelLabel (spec §4), so the shortcut still needs to be
 * discoverable via the native title tooltip. */
export function iconOnlyTitle(label: string, accelerator?: string | null): string {
	return accelerator ? `${label} (${accelerator.toUpperCase()})` : label
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
	/** Vertical dock edges (spec §4): drop the visible label, keep the
	 * shortcut discoverable via `title` ("label (KEY)") instead. */
	iconOnly?: boolean
	/** Focus view (spec §7): canvas tools disable while a terminal is
	 * focused. Native button `disabled` (keyboard/AT-correct, blocks clicks
	 * for free) plus dimmed opacity + default cursor so it visibly reads as
	 * inert rather than merely unstyled. */
	disabled?: boolean
	onClick: () => void
}

export function BarButton({ id, icon, label, accelerator, active, title, iconOnly, disabled, onClick }: BarButtonProps) {
	const resolvedTitle = title ?? (iconOnly && label ? iconOnlyTitle(label, accelerator) : undefined)
	return (
		<button
			type="button"
			data-testid={'ew-bar-' + id}
			title={resolvedTitle}
			disabled={disabled}
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
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.4 : 1,
			}}
		>
			<TldrawUiButtonIcon icon={icon} small />
			{label && !iconOnly ? <AccelLabel label={label} accelerator={accelerator} /> : null}
		</button>
	)
}

export function NativeToolButton({
	tool,
	label,
	currentToolId,
	iconOnly,
	disabled,
}: {
	tool: TLUiToolItem
	label: string
	currentToolId: string
	iconOnly?: boolean
	disabled?: boolean
}) {
	const accel = displayKeyForKbd(tool.kbd, label)
	return (
		<BarButton
			id={tool.id}
			icon={tool.icon}
			label={label}
			accelerator={accel}
			active={currentToolId === tool.id}
			iconOnly={iconOnly}
			disabled={disabled}
			onClick={() => tool.onSelect('toolbar')}
		/>
	)
}

export function PluginBarButton({
	item,
	editor,
	helpers,
	iconOnly,
	disabled,
}: {
	item: BarItemDescriptor
	editor: Editor
	helpers: BarItemHelpers
	iconOnly?: boolean
	disabled?: boolean
}) {
	const available = item.useAvailable?.() ?? true
	if (!available) return null
	return (
		<BarButton
			id={item.id}
			icon={item.icon}
			label={item.label}
			accelerator={item.accelerator}
			iconOnly={iconOnly}
			disabled={disabled}
			onClick={() => item.onSelect(editor, helpers)}
		/>
	)
}

// A bar button with a permanent colour accent (border + tinted background)
// rather than BarButton's active-state accent — used for ▶ Present (green,
// wm.ok) and the crit/red END PRESENTING · STOP FOLLOWING buttons, which need
// to read as set-off from the rest of the bar regardless of interaction state.
export function AccentButton({
	id,
	icon,
	label,
	accelerator,
	accentColor,
	title,
	iconOnly,
	onClick,
}: {
	id: string
	icon: string
	label: string
	accelerator?: string
	accentColor: string
	title?: string
	iconOnly?: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			data-testid={'ew-bar-' + id}
			title={title ?? (iconOnly ? iconOnlyTitle(label, accelerator) : undefined)}
			onClick={onClick}
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 1,
				padding: '4px 8px',
				background: `${accentColor}1a`,
				border: `1px solid ${accentColor}`,
				borderRadius: 4,
				cursor: 'pointer',
			}}
		>
			<TldrawUiButtonIcon icon={icon} small />
			{!iconOnly && <AccelLabel label={label} accelerator={accelerator} />}
		</button>
	)
}
