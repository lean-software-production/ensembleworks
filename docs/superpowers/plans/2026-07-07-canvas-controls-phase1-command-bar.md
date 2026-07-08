# Canvas Controls Phase 1: Command Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace tldraw's stock toolbar/style-panel/navigation chrome with a single EnsembleWorks command bar (priority tools with underlined accelerators, ⋯ overflow with last-used adoption) plus a contextual style panel, per spec `docs/superpowers/specs/2026-07-07-canvas-controls-ux-design.md` §4, §6, and phasing §9 item 1.

**Architecture:** A new `client/src/chrome/` module owns the two chrome pieces (CommandBar, ContextualStylePanel). The plugin registry (`client/src/kernel/plugin.ts`) gains a declarative `barItems` contract — the spec §8 "tool descriptor" — replacing the raw `ToolbarItems` JSX slot. `ui.tsx` takes over tldraw's `Toolbar`, `StylePanel`, `MenuPanel`, `NavigationPanel`, and `InFrontOfTheCanvas` component slots. Page switching stays available via a pages-only top-left panel until Phase 2 moves it into the side panel. The **Present** button is Phase 3 — NOT in this plan.

**Tech Stack:** React 19, tldraw 5.1.0 (`TLComponents` slots, `TLUiOverrides`, `DefaultStylePanel`, `useRelevantStyles`, `DefaultZoomMenu`, `DefaultPageMenu`, `TldrawUiButtonIcon`), Bun (tests are plain `assert` scripts run via `bun <file>`; discovered by `bun scripts/run-tests.ts`).

**Verified API facts (checked against `node_modules/tldraw@5.1.0` — do not re-litigate):**
- `kbd` strings support comma-separated alternatives (`'v,s'` binds both V and S); `!`=shift, `?`=alt, `$`=cmd prefixes.
- Exports confirmed: `DefaultStylePanel`, `useRelevantStyles`, `DefaultZoomMenu`, `DefaultPageMenu`, `TldrawUiButtonIcon`, `stopEventPropagation`, `useTools`, `useValue`, `useDialogs`, `DefaultMainMenu`.
- `editor.getSelectionRotatedScreenBounds()` exists (`@tldraw/editor`).
- tldraw's own shortcut handler skips events targeting INPUT/TEXTAREA/contentEditable, so xterm terminals (textarea-based input) never leak keys to tool shortcuts.

**Working rules:** Run all commands from the repo root. Verify with `bun run typecheck` (all workspaces) and `bun scripts/run-tests.ts`. Code style: tabs, single quotes, no semicolons where the codebase omits them — match `client/src` exactly. Every commit message follows the repo's `feat:`/`refactor:` convention.

---

### Task 1: Bar-item descriptor contract in the plugin kernel

The spec §8 contract: plugins declare command-bar entries as data, not JSX.

**Files:**
- Modify: `client/src/kernel/plugin.ts`
- Test: `client/src/kernel/plugin.test.ts`

- [ ] **Step 1: Add the failing test assertions**

Append to `client/src/kernel/plugin.test.ts` (before the final `console.log` line), and add `collectBarItems` to the existing import from `./plugin`:

```ts
// --- barItems ---------------------------------------------------------------
import { collectBarItems, type BarItemDescriptor } from './plugin'

const noop = () => {}
const mkItem = (
	id: string,
	placement: BarItemDescriptor['placement'],
	accelerator?: string
): BarItemDescriptor => ({
	id,
	label: id,
	accelerator,
	icon: 'tool-frame',
	placement,
	onSelect: noop,
})

const barPlugins: ClientPlugin[] = [
	{ id: 'p1', barItems: [mkItem('terminal', 'priority', 'm'), mkItem('roadmap', 'overflow')] },
	{ id: 'p2' },
	{ id: 'p3', barItems: [mkItem('cast', 'priority', 'c')] },
]

// Placement filter + registry order preserved.
assert.deepEqual(
	collectBarItems(barPlugins, 'priority').map((i) => i.id),
	['terminal', 'cast']
)
assert.deepEqual(
	collectBarItems(barPlugins, 'overflow').map((i) => i.id),
	['roadmap']
)

// An accelerator that doesn't occur in the label is a programmer error.
assert.throws(() =>
	collectBarItems([{ id: 'bad', barItems: [{ ...mkItem('x', 'priority'), label: 'shell', accelerator: 'q' }] }], 'priority')
)
```

Note: `mkItem('terminal', 'priority', 'm')` is valid because 'm' occurs in 'terminal'; `mkItem('roadmap', 'overflow')` has no accelerator.

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun client/src/kernel/plugin.test.ts`
Expected: FAIL — `collectBarItems` is not exported.

- [ ] **Step 3: Implement the contract**

In `client/src/kernel/plugin.ts`: extend the tldraw type import with `TLUiDialogProps`, then add below the `RoomHooksFactory` type:

```ts
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
```

Add to the `ClientPlugin` interface (after `ToolbarItems`):

```ts
	/** Declarative command-bar entries; replaces ToolbarItems (spec §8). */
	barItems?: readonly BarItemDescriptor[]
```

Add the collector after `collectUiSlots`:

```ts
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
```

- [ ] **Step 4: Run test + typecheck, verify pass**

Run: `bun client/src/kernel/plugin.test.ts && bun run typecheck`
Expected: `plugin.test.ts: all assertions passed`, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/kernel/plugin.ts client/src/kernel/plugin.test.ts
git commit -m "feat(chrome): declarative barItems contract in plugin kernel"
```

---

### Task 2: Accelerator label helper

Pure helper that splits a label around its accelerator letter for underline rendering.

**Files:**
- Create: `client/src/chrome/accel.ts`
- Test: `client/src/chrome/accel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `client/src/chrome/accel.test.ts`:

```ts
/**
 * Run: bun client/src/chrome/accel.test.ts
 */
import assert from 'node:assert/strict'
import { displayKeyForKbd, splitAccelLabel } from './accel'

// First occurrence, case-insensitive, split into pre/hit/post.
assert.deepEqual(splitAccelLabel('select', 's'), { pre: '', hit: 's', post: 'elect' })
assert.deepEqual(splitAccelLabel('terminal', 'm'), { pre: 'ter', hit: 'm', post: 'inal' })
assert.deepEqual(splitAccelLabel('cast', 'c'), { pre: '', hit: 'c', post: 'ast' })

// Letter absent (or no accelerator) → null; caller renders a plain label.
assert.equal(splitAccelLabel('laser', 'k'), null)
assert.equal(splitAccelLabel('menu', undefined), null)

// tldraw kbd → display key: prefer an alternative that occurs in the label.
assert.equal(displayKeyForKbd('v,s', 'select'), 's')
assert.equal(displayKeyForKbd('n', 'note'), 'n')
// No alternative in the label → first plain (modifier-free) alternative.
assert.equal(displayKeyForKbd('k', 'laser'), 'k')
// Modifier chords are never displayed as inline accelerators.
assert.equal(displayKeyForKbd('!d', 'highlight'), null)
assert.equal(displayKeyForKbd(undefined, 'anything'), null)

console.log('accel.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun client/src/chrome/accel.test.ts`
Expected: FAIL — module `./accel` not found.

- [ ] **Step 3: Implement**

Create `client/src/chrome/accel.ts`:

```ts
/**
 * Accelerator-label helpers for the command bar (canvas-controls spec §4):
 * labels carry their shortcut as an underlined letter, menu-accelerator style.
 */

export interface AccelSplit {
	pre: string
	hit: string
	post: string
}

/** Split `label` around the first occurrence of `accelerator` (case-insensitive),
 * or null when there's nothing to underline. */
export function splitAccelLabel(label: string, accelerator?: string): AccelSplit | null {
	if (!accelerator) return null
	const idx = label.toLowerCase().indexOf(accelerator.toLowerCase())
	if (idx === -1) return null
	return { pre: label.slice(0, idx), hit: label.slice(idx, idx + 1), post: label.slice(idx + 1) }
}

/**
 * Pick the display key for a tldraw kbd string ('v,s' = alternatives; !?$ are
 * modifier prefixes). Prefers an alternative that occurs in the label (so
 * 'v,s' + 'select' → 's'); falls back to the first modifier-free alternative;
 * null when every alternative needs a modifier (never shown inline).
 */
export function displayKeyForKbd(kbd: string | undefined, label: string): string | null {
	if (!kbd) return null
	const plain = kbd
		.split(',')
		.map((alt) => alt.trim())
		.filter((alt) => alt.length === 1 && !/[!?$]/.test(alt))
	if (plain.length === 0) return null
	return plain.find((alt) => label.toLowerCase().includes(alt.toLowerCase())) ?? plain[0]!
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `bun client/src/chrome/accel.test.ts`
Expected: `accel.test.ts: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add client/src/chrome/accel.ts client/src/chrome/accel.test.ts
git commit -m "feat(chrome): accelerator label helpers"
```

---

### Task 3: Plugins declare barItems (additive — ToolbarItems keeps working)

Migrate the five toolbar-contributing plugins to the descriptor contract. `ToolbarItems` components stay in place until Task 6 removes them, so the app keeps working after this task.

**Files:**
- Create: `client/src/terminal/openNewTerminal.tsx`
- Modify: `client/src/terminal/TerminalToolbarItem.tsx`, `client/src/terminal/plugin.ts`
- Modify: `client/src/screenshare/store.ts`, `client/src/screenshare/plugin.tsx`
- Modify: `client/src/iframe/plugin.tsx`, `client/src/neko/plugin.tsx`, `client/src/roadmap/plugin.tsx`

- [ ] **Step 1: Extract the terminal-creation flow out of the toolbar component**

Create `client/src/terminal/openNewTerminal.tsx` — move `fetchGateways`, `GatewayInfo` and `GatewayPickerDialog` verbatim from `TerminalToolbarItem.tsx`, then export:

```tsx
/**
 * The "new terminal" flow, decoupled from any toolbar component so both the
 * command bar (barItems) and keyboard accelerator can call it. Fast path: no
 * remote gateways registered → create a local terminal immediately; otherwise
 * open the gateway-picker dialog.
 */
import {
	TldrawUiButton,
	TldrawUiDialogBody,
	TldrawUiDialogCloseButton,
	TldrawUiDialogHeader,
	TldrawUiDialogTitle,
	type Editor,
	type TLUiDialogProps,
} from 'tldraw'
import type { BarItemHelpers } from '../kernel/plugin'
import { createTerminalShape } from './createTerminalShape'

// ... (fetchGateways, GatewayInfo, GatewayPickerDialog moved here unchanged)

export function openNewTerminal(editor: Editor, helpers: BarItemHelpers): void {
	void fetchGateways().then((gateways) => {
		if (gateways.length === 0) {
			createTerminalShape(editor)
			return
		}
		helpers.addDialog({
			id: 'terminal-gateway-picker', // dedupe: double-activation reuses the one dialog
			component: (props: TLUiDialogProps) => (
				<GatewayPickerDialog {...props} editor={editor} gateways={gateways} />
			),
		})
	})
}
```

Rewrite `client/src/terminal/TerminalToolbarItem.tsx` to delegate (temporary — deleted in Task 6):

```tsx
/** Legacy toolbar slot for the terminal button; delegates to openNewTerminal.
 * Removed in Phase-1 Task 6 when the command bar replaces DefaultToolbar. */
import { TldrawUiMenuItem, useDialogs, useEditor } from 'tldraw'
import { openNewTerminal } from './openNewTerminal'

export function TerminalToolbarItem() {
	const editor = useEditor()
	const { addDialog } = useDialogs()
	return (
		<TldrawUiMenuItem
			id="terminal"
			icon="tool-frame"
			label="New terminal"
			readonlyOk={false}
			onSelect={() => openNewTerminal(editor, { addDialog })}
		/>
	)
}
```

- [ ] **Step 2: Terminal plugin declares its bar item**

In `client/src/terminal/plugin.ts`, import `openNewTerminal` and add to `terminalPlugin`:

```ts
	barItems: [
		{
			id: 'terminal',
			label: 'terminal',
			accelerator: 'm',
			icon: 'tool-frame',
			placement: 'priority',
			onSelect: openNewTerminal,
		},
	],
```

- [ ] **Step 3: Screenshare — non-hook availability getter + bar item**

In `client/src/screenshare/store.ts`, add below `useScreenShareAvailable` (same predicate, callable outside React — the accelerator handler needs it):

```ts
/** Non-reactive twin of useScreenShareAvailable, for keyboard handlers. */
export function isScreenShareAvailable(): boolean {
	return room != null && room.localParticipant.permissions?.canPublish !== false
}
```

In `client/src/screenshare/plugin.tsx`, import `isScreenShareAvailable` and `useScreenShareAvailable` from `./store`, and add to `screensharePlugin`:

```ts
	barItems: [
		{
			id: 'cast',
			label: 'cast',
			accelerator: 'c',
			icon: SCREENSHARE_ICON_NAME,
			placement: 'priority',
			onSelect: (editor) => {
				if (!isScreenShareAvailable()) return
				void startScreenShare(editor)
			},
			useAvailable: useScreenShareAvailable,
		},
	],
```

(Label is 'cast' per spec §4 — renamed from 'screenshare' so the label carries its key.)

- [ ] **Step 4: iframe / neko / roadmap declare overflow items**

`client/src/iframe/plugin.tsx` — add to `iframePlugin`:

```ts
	barItems: [
		{
			id: 'dev-server',
			label: 'dev server',
			icon: 'tool-embed',
			placement: 'overflow',
			onSelect: (editor) => createDevServerShape(editor),
		},
	],
```

`client/src/neko/plugin.tsx` — add to `nekoPlugin`:

```ts
	barItems: [
		{
			id: 'neko',
			label: 'browser',
			icon: NEKO_ICON_NAME,
			placement: 'overflow',
			onSelect: (editor) => createNekoShape(editor),
		},
	],
```

`client/src/roadmap/plugin.tsx` — add to `roadmapPlugin`:

```ts
	barItems: [
		{
			id: 'roadmap',
			label: 'roadmap',
			icon: 'tool-note',
			placement: 'overflow',
			onSelect: (editor) => createRoadmapShape(editor),
		},
	],
```

Check each create function's signature before wiring (`createNekoShape(editor)`, `createRoadmapShape(editor)`, `createDevServerShape(editor)` — all take the editor as sole required arg today; adapt the arrow if one takes extras with defaults).

- [ ] **Step 5: Typecheck + tests, verify green**

Run: `bun run typecheck && bun scripts/run-tests.ts`
Expected: clean; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/terminal client/src/screenshare client/src/iframe/plugin.tsx client/src/neko/plugin.tsx client/src/roadmap/plugin.tsx
git commit -m "feat(chrome): plugins declare command-bar items (barItems)"
```

---

### Task 4: Extract the main menu, build the CommandBar

**Files:**
- Create: `client/src/chrome/MainMenu.tsx` (moved out of `ui.tsx`)
- Create: `client/src/chrome/CommandBar.tsx`
- Modify: `client/src/ui.tsx` (imports only — slot wiring is Task 6)

- [ ] **Step 1: Move the main menu into chrome/**

Create `client/src/chrome/MainMenu.tsx` by moving `AboutDialog`, `AboutMenuItem`, and `PluginMainMenu` from `ui.tsx` verbatim (with their imports: `DefaultMainMenu`, `DefaultMainMenuContent`, `TldrawUiDialogBody/CloseButton/Header/Title`, `TldrawUiMenuGroup`, `TldrawUiMenuItem`, `useDialogs`, plus `plugins`). Rename `PluginMainMenu` → `EnsembleMainMenu` and export it. Update `ui.tsx` to `import { EnsembleMainMenu } from './chrome/MainMenu'` and use it in the `MainMenu:` slot where `PluginMainMenu` was. Run `bun run typecheck` — clean.

- [ ] **Step 2: Build the CommandBar**

Create `client/src/chrome/CommandBar.tsx`:

```tsx
/**
 * The EnsembleWorks command bar (canvas-controls spec §4): one floating bar of
 * canvas verbs replacing tldraw's DefaultToolbar. Left to right: ☰ main menu,
 * priority tools (native select/note/text/frame + plugin barItems) with
 * underlined accelerators, the ⋯ overflow (demoted native tools + plugin
 * overflow items, last-used item adopted next to the ⋯ trigger), and zoom.
 * Present button lands in Phase 3.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
	DefaultZoomMenu,
	TldrawUiButtonIcon,
	stopEventPropagation,
	useDialogs,
	useEditor,
	useTools,
	useValue,
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
	'draw',
	'eraser',
	'arrow',
	'line',
	'rectangle',
	'ellipse',
	'highlight',
	'laser',
	'hand',
] as const

const LAST_OVERFLOW_KEY = 'ensembleworks.commandBar.lastOverflow.v1'

const barStyle: CSSProperties = {
	display: 'flex',
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

function AccelLabel(props: { label: string; accel: string | null }) {
	const split = props.accel ? splitAccelLabel(props.label, props.accel) : null
	const style: CSSProperties = { fontSize: 11, color: wm.inkMuted }
	if (!split) {
		return (
			<span style={style}>
				{props.label}
				{props.accel ? (
					<span style={{ marginLeft: 4, fontSize: 9, color: wm.inkSubtle }}>{props.accel}</span>
				) : null}
			</span>
		)
	}
	return (
		<span style={style}>
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

function BarButton(props: {
	id: string
	icon: string
	label?: string
	accel?: string | null
	active?: boolean
	title?: string
	onClick: () => void
}) {
	return (
		<button
			type="button"
			data-testid={`ew-bar-${props.id}`}
			title={props.title ?? props.label}
			onClick={props.onClick}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 5,
				padding: '5px 8px',
				border: props.active ? `1px solid ${wm.sealBlue}` : '1px solid transparent',
				borderRadius: 5,
				background: props.active ? wm.accentSoft : 'transparent',
				cursor: 'pointer',
			}}
		>
			<TldrawUiButtonIcon icon={props.icon} small />
			{props.label ? <AccelLabel label={props.label} accel={props.accel ?? null} /> : null}
		</button>
	)
}

function NativeToolButton(props: { tool: TLUiToolItem; label: string; currentToolId: string }) {
	return (
		<BarButton
			id={props.tool.id}
			icon={typeof props.tool.icon === 'string' ? props.tool.icon : 'tool-pencil'}
			label={props.label}
			accel={displayKeyForKbd(props.tool.kbd, props.label)}
			active={props.currentToolId === props.tool.id}
			onClick={() => props.tool.onSelect('toolbar')}
		/>
	)
}

function PluginBarButton(props: { item: BarItemDescriptor; helpers: BarItemHelpers }) {
	const editor = useEditor()
	const available = props.item.useAvailable?.() ?? true
	if (!available) return null
	return (
		<BarButton
			id={props.item.id}
			icon={props.item.icon}
			label={props.item.label}
			accel={props.item.accelerator ?? null}
			onClick={() => props.item.onSelect(editor, props.helpers)}
		/>
	)
}

const dividerStyle: CSSProperties = { width: 1, alignSelf: 'stretch', background: wm.rule, margin: '2px 4px' }

export function CommandBar() {
	const editor = useEditor()
	const tools = useTools()
	const { addDialog } = useDialogs()
	const helpers = useMemo<BarItemHelpers>(() => ({ addDialog }), [addDialog])
	const currentToolId = useValue('current tool', () => editor.getCurrentToolId(), [editor])
	const [overflowOpen, setOverflowOpen] = useState(false)
	const [lastOverflowId, setLastOverflowId] = useState<string | null>(
		() => localStorage.getItem(LAST_OVERFLOW_KEY)
	)

	const priorityItems = useMemo(() => collectBarItems(plugins, 'priority'), [])
	const overflowItems = useMemo(() => collectBarItems(plugins, 'overflow'), [])

	// Bare-letter accelerators for plugin bar items. Native tools keep tldraw's
	// own shortcut handling (kbd on the tool item). Guards mirror tldraw's:
	// never while typing (inputs/textarea/contenteditable — covers xterm), never
	// while editing a shape, never with modifiers held.
	useEffect(() => {
		const byKey = new Map<string, BarItemDescriptor>()
		for (const item of [...priorityItems, ...overflowItems]) {
			if (item.accelerator) byKey.set(item.accelerator.toLowerCase(), item)
		}
		function onKeyDown(e: KeyboardEvent) {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
			const target = e.target as HTMLElement | null
			if (
				target &&
				(target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
			)
				return
			if (editor.getEditingShapeId() !== null) return
			if (!editor.getInstanceState().isFocused) return
			const item = byKey.get(e.key.toLowerCase())
			if (!item) return
			e.preventDefault()
			item.onSelect(editor, helpers)
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [editor, helpers, priorityItems, overflowItems])

	const nativeLabels: Record<string, string> = {
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

	const runOverflowNative = (id: string) => {
		tools[id]?.onSelect('toolbar')
		setLastOverflowId(id)
		localStorage.setItem(LAST_OVERFLOW_KEY, id)
		setOverflowOpen(false)
	}
	const runOverflowPlugin = (item: BarItemDescriptor) => {
		item.onSelect(editor, helpers)
		setLastOverflowId(item.id)
		localStorage.setItem(LAST_OVERFLOW_KEY, item.id)
		setOverflowOpen(false)
	}

	// The ⋯ trigger adopts the last-used overflow item (spec §4): the adopted
	// item renders as a plain slot next to a narrow ⌄ that opens the menu.
	const lastNative = lastOverflowId && (OVERFLOW_TOOLS as readonly string[]).includes(lastOverflowId)
		? tools[lastOverflowId]
		: undefined
	const lastPlugin = overflowItems.find((item) => item.id === lastOverflowId)

	return (
		<div
			data-testid="ew-command-bar"
			onPointerDown={stopEventPropagation}
			style={{ position: 'relative', ...barStyle }}
		>
			<EnsembleMainMenu />
			<div style={dividerStyle} />
			{PRIORITY_TOOLS.map((id) =>
				tools[id] ? (
					<NativeToolButton
						key={id}
						tool={tools[id]!}
						label={nativeLabels[id]!}
						currentToolId={currentToolId}
					/>
				) : null
			)}
			{priorityItems.map((item) => (
				<PluginBarButton key={item.id} item={item} helpers={helpers} />
			))}
			{lastNative ? (
				<NativeToolButton
					tool={lastNative}
					label={nativeLabels[lastNative.id] ?? lastNative.id}
					currentToolId={currentToolId}
				/>
			) : lastPlugin ? (
				<PluginBarButton item={lastPlugin} helpers={helpers} />
			) : null}
			<BarButton
				id="overflow"
				icon="dots-horizontal"
				title="More tools"
				onClick={() => setOverflowOpen((open) => !open)}
			/>
			<div style={dividerStyle} />
			<DefaultZoomMenu />
			{overflowOpen && (
				<div
					data-testid="ew-bar-overflow-menu"
					style={{
						position: 'absolute',
						bottom: 'calc(100% + 8px)',
						right: 0,
						display: 'flex',
						flexDirection: 'column',
						gap: 2,
						...barStyle,
					}}
				>
					{OVERFLOW_TOOLS.map((id) =>
						tools[id] ? (
							<BarButton
								key={id}
								id={`overflow-${id}`}
								icon={typeof tools[id]!.icon === 'string' ? (tools[id]!.icon as string) : 'tool-pencil'}
								label={nativeLabels[id]!}
								accel={displayKeyForKbd(tools[id]!.kbd, nativeLabels[id]!)}
								active={currentToolId === id}
								onClick={() => runOverflowNative(id)}
							/>
						) : null
					)}
					{overflowItems.map((item) => (
						<BarButton
							key={item.id}
							id={`overflow-${item.id}`}
							icon={item.icon}
							label={item.label}
							accel={item.accelerator ?? null}
							onClick={() => runOverflowPlugin(item)}
						/>
					))}
				</div>
			)}
		</div>
	)
}
```

Implementation notes for this step:
- If `TldrawUiButtonIcon` refuses to render outside a `TldrawUiButton` (check at runtime, not assumed), fall back to tldraw's `TldrawUiIcon`-equivalent or an `<img>` from the collected `assetUrls` — but try `TldrawUiButtonIcon` first; it is a plain icon `<div>` in 5.1.0.
- If the icon name `dots-horizontal` doesn't exist in tldraw's icon set, use `dots-vertical` or `chevron-up` (check `node_modules/tldraw/assets/icons/icon/` for real names).
- `DefaultZoomMenu` renders its own trigger showing the zoom %.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: clean. (The component isn't wired into the UI yet — that's Task 6.)

- [ ] **Step 4: Commit**

```bash
git add client/src/chrome/MainMenu.tsx client/src/chrome/CommandBar.tsx client/src/ui.tsx
git commit -m "feat(chrome): CommandBar component + main menu extraction"
```

---

### Task 5: Contextual style panel

**Files:**
- Create: `client/src/chrome/ContextualStylePanel.tsx`

- [ ] **Step 1: Implement the component**

Create `client/src/chrome/ContextualStylePanel.tsx`:

```tsx
/**
 * Contextual style panel (canvas-controls spec §6): no fixed top-right panel.
 * One component, two anchors — above the selection bounds when a selection
 * exists (same spot as tldraw's rich-text toolbar), or floated above the
 * command bar when a style-bearing tool is armed with nothing selected.
 * Hidden mid-gesture so it never chases a drag.
 */
import { type CSSProperties } from 'react'
import {
	DefaultStylePanel,
	stopEventPropagation,
	useEditor,
	useRelevantStyles,
	useValue,
} from 'tldraw'

// Tools whose next-shape styles are worth editing before drawing.
const STYLE_TOOLS = new Set(['draw', 'highlight', 'arrow', 'line', 'geo', 'note', 'text', 'frame'])

export function ContextualStylePanel() {
	const editor = useEditor()
	const styles = useRelevantStyles()
	const currentToolId = useValue('current tool', () => editor.getCurrentToolId(), [editor])
	const selectionBounds = useValue(
		'selection screen bounds',
		() => {
			if (editor.getSelectedShapeIds().length === 0) return null
			return editor.getSelectionRotatedScreenBounds() ?? null
		},
		[editor]
	)
	const midGesture = useValue(
		'mid gesture',
		() =>
			editor.isInAny(
				'select.translating',
				'select.resizing',
				'select.rotating',
				'select.brushing',
				'select.pointing_shape',
				'select.dragging_handle'
			),
		[editor]
	)

	if (!styles || styles.styles.size === 0) return null
	if (midGesture) return null

	let style: CSSProperties
	if (selectionBounds) {
		const margin = 8
		const left = Math.min(Math.max(selectionBounds.midX, 90), window.innerWidth - 90)
		const top = selectionBounds.minY - margin
		if (top < 60) {
			// No headroom above the selection — drop below it instead.
			style = {
				position: 'absolute',
				left,
				top: selectionBounds.maxY + margin,
				transform: 'translateX(-50%)',
			}
		} else {
			style = { position: 'absolute', left, top, transform: 'translate(-50%, -100%)' }
		}
	} else if (STYLE_TOOLS.has(currentToolId)) {
		style = { position: 'absolute', left: '50%', bottom: 72, transform: 'translateX(-50%)' }
	} else {
		return null
	}

	return (
		<div
			data-testid="ew-style-panel"
			onPointerDown={stopEventPropagation}
			style={{ ...style, pointerEvents: 'all', zIndex: 400 }}
		>
			<DefaultStylePanel />
		</div>
	)
}
```

Implementation notes:
- `useRelevantStyles()` returns a `ReadonlySharedStyleMap | null`; if the `.styles.size` access doesn't match 5.1.0's shape, check its type in `node_modules/tldraw` and use the correct emptiness test (it may be the map itself — then use `styles.size === 0`).
- `getSelectionRotatedScreenBounds()` returns viewport-relative coordinates; `InFrontOfTheCanvas` (where Task 6 mounts this) is a viewport-filling overlay, so they line up.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/chrome/ContextualStylePanel.tsx
git commit -m "feat(chrome): contextual style panel, two anchors"
```

---

### Task 6: Wire the slots, retire ToolbarItems

The cutover: CommandBar replaces the toolbar, stock style panel and navigation disappear, page menu survives top-left (until Phase 2), select gains the S alias, `ToolbarItems` leaves the plugin contract.

**Files:**
- Modify: `client/src/ui.tsx`
- Modify: `client/src/kernel/plugin.ts` (remove `ToolbarItems`)
- Modify: `client/src/terminal/plugin.ts`, `client/src/screenshare/plugin.tsx`, `client/src/iframe/plugin.tsx`, `client/src/neko/plugin.tsx`, `client/src/roadmap/plugin.tsx`
- Delete: `client/src/terminal/TerminalToolbarItem.tsx`

- [ ] **Step 1: Rewrite ui.tsx**

Replace `client/src/ui.tsx` wholesale with:

```tsx
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

/** Pages-only top-left panel: page switching must survive Phase 1 (spec §9). */
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
```

(The `MainMenu` slot entry disappears — `EnsembleMainMenu` renders inside the CommandBar. `AboutDialog` and the plugin `MenuItems` render through it unchanged.)

- [ ] **Step 2: Remove ToolbarItems from the contract and plugins**

- `client/src/kernel/plugin.ts`: delete the `ToolbarItems?: ComponentType` member (keep `MenuItems`).
- `client/src/terminal/plugin.ts`: remove the `ToolbarItems: TerminalToolbarItem` line and its import; delete `client/src/terminal/TerminalToolbarItem.tsx` (`git rm`).
- `client/src/screenshare/plugin.tsx`: remove `ScreenShareToolbarItem` (component + `ToolbarItems:` line); keep the `tools:` entry (the screenshare tool map entry stays harmless and may be referenced elsewhere — verify with `grep -rn "tools\['screenshare'\]" client/src` and remove the tools entry too if nothing else reads it).
- `client/src/iframe/plugin.tsx`, `client/src/neko/plugin.tsx`, `client/src/roadmap/plugin.tsx`: same — remove the `*ToolbarItem` components and `ToolbarItems:` lines; keep `tools:` entries only if referenced elsewhere (same grep check per id).

- [ ] **Step 3: Full check**

Run: `bun run typecheck && bun scripts/run-tests.ts && bun run build`
Expected: all clean. Build failures here are usually a missed import of a deleted symbol — `grep -rn "ToolbarItems\|TerminalToolbarItem" client/src` must return nothing.

- [ ] **Step 4: Commit**

```bash
git add -A client/src
git commit -m "feat(chrome)!: command bar replaces stock toolbar/style/nav chrome"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Static gates**

Run: `bun run typecheck && bun scripts/run-tests.ts && bun run build`
Expected: everything green. If not, fix before proceeding.

- [ ] **Step 2: Live smoke (best effort — requires the dev stack)**

Check whether the devcontainer stack is up: `bin/dev status --json 2>/dev/null`. If it isn't running, skip this step and SAY SO in your report — do not silently pass.

If up, follow `docs/headless-browser.md` to drive `http://localhost:8080` (or the Vite port :5173) headlessly and verify:
1. `[data-testid="ew-command-bar"]` exists; the stock `.tlui-toolbar` does not.
2. Clicking `[data-testid="ew-bar-note"]` arms the note tool (`window.__ewEditor.getCurrentToolId() === 'note'`); pressing `s` returns to select; pressing `n` arms note again.
3. Selecting a drawn shape shows `[data-testid="ew-style-panel"]`; deselecting hides it.
4. `[data-testid="ew-bar-overflow"]` opens the overflow; picking `draw` arms it and the adopted slot appears after reopening.
5. The page menu is still reachable top-left.

- [ ] **Step 3: Report**

Summarize: gates run + results, smoke run or skipped, any deviations from the plan (there will be some — tldraw internals; record what changed and why).

---

## Deviation policy

tldraw 5.1.0 internals (icon names, `useRelevantStyles` return shape, `TldrawUiButtonIcon` standalone rendering, `DefaultZoomMenu`/`DefaultPageMenu` styling outside their zones) may differ in detail from the code above. Adapt in place, keep the spec behavior (§4 bar contents/order, underlined accelerators, §6 two-anchor style panel), and record every adaptation in the final report. Do not fall back to `DefaultToolbar`.
