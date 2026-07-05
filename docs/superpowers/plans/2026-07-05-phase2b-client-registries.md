# Phase 2b — Client registries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The client half of roadmap Phase 2 (docs/unified-architecture-design.md §7): `App.tsx`/`ui.tsx` iterate a plugin list instead of hard-coding features, the terminal delete-veto and screenshare after-delete become per-feature room hooks, the ad-hoc polling loops run through a kernel scheduler, and the 1,302-line `AvOverlay.tsx` is dismembered into focused modules — with **zero behaviour change**.

**Architecture:** Mirror of the 2a server split. A `client/src/kernel/` gains three modules: `plugin.ts` (the `ClientPlugin` interface + pure aggregation helpers), `roomHooks.ts` (compose per-plugin delete hooks onto the editor), and `scheduler.ts`/`useEvery.ts` (the §1.2 `scheduler.every(ms, fn)` seam). Each feature exports a `plugin.ts(x)` manifest; `client/src/plugins.ts` is the one ordered registry. `App.tsx` and `ui.tsx` become kernel assemblers that iterate it. AvOverlay splits into orchestrator + six focused modules. This is a client-internal registry (plain modules), **not** npm plugin packages — those are Phase 6.

**Tech Stack:** React 18 (StrictMode), tldraw, @tldraw/sync, livekit-client, @ensembleworks/contracts. Client house style: **tab indentation, extensionless relative imports** (Vite bundler resolution — unlike the server's `./x.ts` style). Tests are self-running tsx scripts (`npx tsx src/<f>.test.ts` from `client/`), pure modules only — **never import tldraw/react/livekit as values in a test** (type-only imports are fine; they erase). Contracts intra-package imports use the `.js` extension.

**Branch / worktree:** `phase2b-client-registries` in `.worktrees/phase2b-client-registries` (controller sets this up before Task 1).

**Checks per task:** `npm run typecheck` from the repo root (covers all workspaces) + the task's own test file. `npm run build` at Tasks 7, 8 and 11.

**Execution model (user directive):** sonnet implementers, opus per-task two-stage reviews, fable final review. Pure code-move tasks (9, 10) get review focus on *move fidelity* — bodies must be verbatim; only imports/exports change.

---

## Parity ledger — the invariants every task and the final audit defend

Behaviour-neutral means all of the following are byte-for-byte or observably identical after Task 11:

1. **Shape-util registration order** (both in `useSync` and `<Tldraw>`): `TerminalShapeUtil, IframeShapeUtil, NekoShapeUtil, RoadmapShapeUtil, ScreenShareShapeUtil`.
2. **`assetUrls.icons`**: exactly `{[NEKO_ICON_NAME]: NEKO_TOOLBAR_ICON, [SCREENSHARE_ICON_NAME]: SCREENSHARE_TOOLBAR_ICON}`, module-level stable reference.
3. **Tools map**: keys `dev-server`, `neko`, `roadmap`, `screenshare` with identical `id/icon/label/readonlyOk/onSelect` bodies.
4. **Toolbar order** after `DefaultToolbarContent`: terminal item, dev-server, neko, roadmap, screenshare (screenshare gated on `useScreenShareAvailable()`).
5. **Main menu group `ensembleworks-demo`**: `seed-demo`, `seed-session`, `about-sessions`, in that order, same labels/icons.
6. **Components map**: `Toolbar`, `MainMenu`, `SharePanel` — same three slots, same behaviour.
7. **Terminal delete-veto**: same confirm text, same `source !== 'user' || shape.type !== 'terminal'` guard, same 250 ms decision-reuse window, per-mount closure state, StrictMode-safe (registered once, cleaned up).
8. **Screenshare after-delete**: deleting a tile (locally or over sync) stops the matching active local capture. No behaviour change from registering at mount instead of lazily (the handler body no-ops when `active` lacks the trackName).
9. **Cadences**: spatial-gain loop 150 ms with `setTargetAtTime(target, ctx.currentTime, 0.08)`; screenshare subscription loop 150 ms, only while a room is registered; transcript poll 4000 ms; session pulse 30 000 ms with an immediate first tick. (Tick *phase* may shift by <1 period where an interval now survives a dep change — accepted; everything observable is per-tick recomputed.)
10. **Kick**: send path (`POST /api/kick` with confirm) and receive path (`{type:'kicked'}` in `useSync.onCustomMessageReceived` → overlay) unchanged. Kick reception stays in App.tsx — it is a sync-connection event, kernel by decision.
11. **Presence stamp** (`getUserPresence` + cached `shapeQuery`) untouched.
12. **Debug hooks**: `window.__ewEditor`, `window.__ewScreenShareRoom` preserved.
13. **`ColorDot` recolour**: picking a colour still updates prefs, next-shape style, and synchronously re-tints all local screenshare tiles (`ownerColor` synced prop) — now via a screenshare-owned helper instead of an inline type-string scan.
14. **`useValue` subscription scoping** (the deliberate narrow subscriptions in App.tsx:56–62 and AvOverlay's `railFaces`/`leashes`/`participants`) must not be widened by the move — keep every `useValue` body and dep array verbatim.

**Deliberate scope exclusions** (record, don't fix): per-shape feature-internal timers (terminal reconnect/backoff, neko mute-enforce, roadmap copied-flag, screenshare 1 s aspect poll) stay as they are; `useLiveKitRoom` → `setScreenShareRoom` room registration stays (Phase 6 `mediaHooks`); `session/layout.ts` → `av/spatial` import stays (geometry derives from the audio model); a general "local colour changed" hook is Phase 6 — `ColorDot` calling a named screenshare API is the Phase 2b resting point.

---

## File structure

```
client/src/
  kernel/                      NEW — client kernel
    plugin.ts                  ClientPlugin type + collectShapeUtils/collectIcons/collectUiSlots
    plugin.test.ts
    roomHooks.ts               attachRoomHooks(editor, plugins)
    roomHooks.test.ts
    scheduler.ts               createScheduler + scheduler singleton
    scheduler.test.ts
    useEvery.ts                React hook over scheduler.every
  plugins.ts                   NEW — THE ordered registry
  App.tsx                      kernel assembler (registry-driven)
  ui.tsx                       kernel assembler (registry-driven)
  terminal/plugin.ts           NEW
  iframe/plugin.tsx            NEW  (+ createDevServerShape.ts moved from ui.tsx)
  neko/plugin.tsx              NEW  (+ createNekoShape.ts moved from ui.tsx)
  roadmap/plugin.tsx           NEW  (+ createRoadmapShape.ts moved from ui.tsx)
  screenshare/plugin.tsx       NEW  (+ SubscriptionLoop.tsx; store.ts + share.ts gain exports)
  av/plugin.ts                 NEW
  demo/                        NEW dir — demo.ts moves to demo/seedDemoCanvas.ts + demo/plugin.tsx
  session/plugin.tsx           NEW
  av/AvOverlay.tsx             shrinks to orchestrator (~260 lines)
  av/icons.tsx                 NEW — AvIconButton/AvIcon
  av/gauges.tsx                NEW — VmStrip/VmBar/LatencyPill/gradeColor/fmtBytes
  av/TranscriptModal.tsx       NEW
  av/rail.tsx                  NEW — FacesRail/RailFace
  av/SessionPanel.tsx          NEW — SessionPanel/ParticipantRow/ColorDot/ScribeRow
  av/leashes.tsx               NEW — Leash/LeashOverlay/useLeashes
  av/useSpatialGainLoop.ts     NEW
contracts/src/user-id.ts       NEW — rawUserId (+ test), exported from index.ts
server/src/kernel/presence.ts  rawUserId becomes a re-export from contracts
```

---

### Task 1: Kernel scheduler + useEvery

**Files:**
- Create: `client/src/kernel/scheduler.ts`
- Create: `client/src/kernel/scheduler.test.ts`
- Create: `client/src/kernel/useEvery.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Run: npx tsx src/kernel/scheduler.test.ts
 */
import assert from 'node:assert/strict'
import { createScheduler } from './scheduler'

// Fake interval host: capture registrations, fire ticks by hand.
function fakeIntervals() {
	let nextId = 1
	const live = new Map<number, { fn: () => void; ms: number }>()
	return {
		set(fn: () => void, ms: number) {
			const id = nextId++
			live.set(id, { fn, ms })
			return id as unknown as ReturnType<typeof setInterval>
		},
		clear(handle: ReturnType<typeof setInterval>) {
			live.delete(handle as unknown as number)
		},
		live,
	}
}

{
	// every() registers one interval at the requested cadence.
	const host = fakeIntervals()
	const scheduler = createScheduler(host.set, host.clear)
	let ticks = 0
	scheduler.every(150, () => ticks++)
	assert.equal(host.live.size, 1)
	assert.equal([...host.live.values()][0]!.ms, 150)
	for (const { fn } of host.live.values()) fn()
	for (const { fn } of host.live.values()) fn()
	assert.equal(ticks, 2)
}

{
	// cancel clears the interval; double-cancel is safe and never clears twice.
	const host = fakeIntervals()
	const scheduler = createScheduler(host.set, host.clear)
	const cancel = scheduler.every(1000, () => {})
	assert.equal(host.live.size, 1)
	cancel()
	assert.equal(host.live.size, 0)
	cancel() // must not throw or clear another subscription's handle
	assert.equal(host.live.size, 0)
}

{
	// Subscriptions are independent: cancelling one leaves the other ticking.
	const host = fakeIntervals()
	const scheduler = createScheduler(host.set, host.clear)
	let a = 0
	let b = 0
	const cancelA = scheduler.every(150, () => a++)
	scheduler.every(4000, () => b++)
	assert.equal(host.live.size, 2)
	cancelA()
	assert.equal(host.live.size, 1)
	for (const { fn } of host.live.values()) fn()
	assert.equal(a, 0)
	assert.equal(b, 1)
}

console.log('scheduler.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `client/`): `npx tsx src/kernel/scheduler.test.ts`
Expected: FAIL — cannot find module `./scheduler`

- [ ] **Step 3: Write the implementation**

`client/src/kernel/scheduler.ts`:

```ts
/**
 * The client cadence service (unified-architecture-design.md §1.2:
 * `scheduler.every(ms, fn)`) — the one seam every recurring loop runs
 * through, instead of ad-hoc setIntervals scattered across features.
 * Each subscription keeps its own interval, so the semantics are identical
 * to the setInterval it replaces; the value is the seam (and, later, that
 * plugin packages receive it as a capability), not tick coalescing.
 */
export type CancelCadence = () => void

export interface Scheduler {
	every(ms: number, fn: () => void): CancelCadence
}

type IntervalHandle = ReturnType<typeof setInterval>

export function createScheduler(
	set: (fn: () => void, ms: number) => IntervalHandle = (fn, ms) => setInterval(fn, ms),
	clear: (handle: IntervalHandle) => void = clearInterval
): Scheduler {
	return {
		every(ms, fn) {
			const handle = set(fn, ms)
			let cancelled = false
			return () => {
				if (cancelled) return
				cancelled = true
				clear(handle)
			}
		},
	}
}

/** The app-wide scheduler instance. */
export const scheduler: Scheduler = createScheduler()
```

`client/src/kernel/useEvery.ts`:

```ts
import { useEffect, useRef } from 'react'
import { scheduler } from './scheduler'

/**
 * Run `fn` every `ms` milliseconds while `enabled`. The latest `fn` is
 * always the one called (ref-forwarded), so callers may close over fresh
 * render state without churning the interval; the interval is created and
 * torn down only when `ms` or `enabled` change (and on unmount).
 */
export function useEvery(ms: number, fn: () => void, enabled = true): void {
	const fnRef = useRef(fn)
	fnRef.current = fn
	useEffect(() => {
		if (!enabled) return
		return scheduler.every(ms, () => fnRef.current())
	}, [ms, enabled])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `client/`): `npx tsx src/kernel/scheduler.test.ts`
Expected: `scheduler.test.ts: all assertions passed`

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add client/src/kernel/scheduler.ts client/src/kernel/scheduler.test.ts client/src/kernel/useEvery.ts
git commit -m "feat(client): kernel scheduler service + useEvery hook"
```

---

### Task 2: ClientPlugin type, aggregation helpers, attachRoomHooks

**Files:**
- Create: `client/src/kernel/plugin.ts`
- Create: `client/src/kernel/plugin.test.ts`
- Create: `client/src/kernel/roomHooks.ts`
- Create: `client/src/kernel/roomHooks.test.ts`

- [ ] **Step 1: Write the plugin types + pure helpers**

`client/src/kernel/plugin.ts`:

```ts
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
```

Note: `TLUiToolItem` and `TLAnyShapeUtilConstructor` are exported by tldraw. If typecheck disagrees on a name, find the actual exported alias in `node_modules/tldraw/dist-cjs/index.d.ts` and use that — do not loosen to `any`.

- [ ] **Step 2: Write the failing helper test**

`client/src/kernel/plugin.test.ts` (type-only tldraw imports erase at runtime — the test never loads tldraw):

```ts
/**
 * Run: npx tsx src/kernel/plugin.test.ts
 */
import assert from 'node:assert/strict'
import type { ClientPlugin } from './plugin'
import { collectIcons, collectShapeUtils, collectUiSlots } from './plugin'

const utilA = class {} as unknown as NonNullable<ClientPlugin['shapeUtils']>[number]
const utilB = class {} as unknown as NonNullable<ClientPlugin['shapeUtils']>[number]
const utilC = class {} as unknown as NonNullable<ClientPlugin['shapeUtils']>[number]

const plugins: ClientPlugin[] = [
	{ id: 'a', shapeUtils: [utilA, utilB], icons: { 'icon-a': 'data:a' } },
	{ id: 'b' },
	{
		id: 'c',
		shapeUtils: [utilC],
		icons: { 'icon-c': 'data:c' },
		uiSlots: { SharePanel: (() => null) as never },
	},
]

// Registry order is preserved across plugins and within a plugin.
assert.deepEqual(collectShapeUtils(plugins), [utilA, utilB, utilC])

// Icons merge across plugins.
assert.deepEqual(collectIcons(plugins), { 'icon-a': 'data:a', 'icon-c': 'data:c' })

// Slots merge; plugins without slots contribute nothing.
assert.deepEqual(Object.keys(collectUiSlots(plugins)), ['SharePanel'])

// Aggregators never mutate their inputs.
assert.equal(plugins[0]!.shapeUtils!.length, 2)

console.log('plugin.test.ts: all assertions passed')
```

Run (from `client/`): `npx tsx src/kernel/plugin.test.ts` — must FAIL before Step 1's file exists, PASS after.

- [ ] **Step 3: Write the failing roomHooks test**

`client/src/kernel/roomHooks.test.ts`:

```ts
/**
 * Run: npx tsx src/kernel/roomHooks.test.ts
 *
 * Uses a duck-typed editor (the screenshare/resolve.ts RoomLike precedent):
 * type-only tldraw imports keep the test runnable under plain tsx.
 */
import assert from 'node:assert/strict'
import type { Editor, TLShape } from 'tldraw'
import type { ClientPlugin } from './plugin'
import { attachRoomHooks } from './roomHooks'

type BeforeHandler = (shape: TLShape, source: 'user' | 'remote') => false | void
type AfterHandler = (shape: TLShape) => void

function fakeEditor() {
	const state = { before: [] as BeforeHandler[], after: [] as AfterHandler[], unregistered: 0 }
	const editor = {
		sideEffects: {
			registerBeforeDeleteHandler(_type: string, handler: BeforeHandler) {
				state.before.push(handler)
				return () => state.unregistered++
			},
			registerAfterDeleteHandler(_type: string, handler: AfterHandler) {
				state.after.push(handler)
				return () => state.unregistered++
			},
		},
	}
	return { editor: editor as unknown as Editor, state }
}

const shape = { id: 'shape:t1', type: 'terminal' } as unknown as TLShape

{
	// No plugins with roomHooks → nothing registered; cleanup is a no-op.
	const { editor, state } = fakeEditor()
	const cleanup = attachRoomHooks(editor, [{ id: 'plain' }])
	assert.equal(state.before.length, 0)
	assert.equal(state.after.length, 0)
	cleanup()
	assert.equal(state.unregistered, 0)
}

{
	// Factories run once per attach, with the editor; vetoes compose: every
	// hook sees the shape, and any single false vetoes the batch.
	const calls: string[] = []
	let factoryRuns = 0
	const vetoPlugin: ClientPlugin = {
		id: 'veto',
		roomHooks: (ed) => {
			factoryRuns++
			assert.ok(ed)
			return {
				beforeShapeDelete(s, source) {
					calls.push(`veto:${s.type}:${source}`)
					return false
				},
			}
		},
	}
	const observePlugin: ClientPlugin = {
		id: 'observe',
		roomHooks: () => ({
			beforeShapeDelete() {
				calls.push('observe')
			},
			afterShapeDelete() {
				calls.push('after')
			},
		}),
	}
	const { editor, state } = fakeEditor()
	const cleanup = attachRoomHooks(editor, [vetoPlugin, observePlugin])
	assert.equal(factoryRuns, 1)
	assert.equal(state.before.length, 1) // one composed handler, not one per plugin
	assert.equal(state.after.length, 1)

	const verdict = state.before[0]!(shape, 'user')
	assert.equal(verdict, false)
	// Both hooks ran, in registry order, despite the first vetoing.
	assert.deepEqual(calls, ['veto:terminal:user', 'observe'])

	state.after[0]!(shape)
	assert.deepEqual(calls.at(-1), 'after')

	cleanup()
	assert.equal(state.unregistered, 2)
}

{
	// No veto → composed handler returns undefined (does not return true).
	const okPlugin: ClientPlugin = { id: 'ok', roomHooks: () => ({ beforeShapeDelete() {} }) }
	const { editor, state } = fakeEditor()
	attachRoomHooks(editor, [okPlugin])
	assert.equal(state.before[0]!(shape, 'user'), undefined)
}

{
	// Plugin-provided cleanup fns run on detach.
	let cleaned = 0
	const withCleanup: ClientPlugin = { id: 'c', roomHooks: () => ({ cleanup: () => cleaned++ }) }
	const { editor } = fakeEditor()
	const cleanup = attachRoomHooks(editor, [withCleanup])
	cleanup()
	assert.equal(cleaned, 1)
}

console.log('roomHooks.test.ts: all assertions passed')
```

Run (from `client/`): `npx tsx src/kernel/roomHooks.test.ts`
Expected: FAIL — cannot find module `./roomHooks`

- [ ] **Step 4: Implement attachRoomHooks**

`client/src/kernel/roomHooks.ts`:

```ts
/**
 * Attach every plugin's room hooks to a freshly mounted editor. One composed
 * before-delete handler and one composed after-delete handler are registered
 * (only when some plugin needs them), so tldraw sees at most two side-effect
 * registrations regardless of plugin count. Returns a cleanup for StrictMode
 * double-mount and real unmounts.
 */
import type { Editor } from 'tldraw'
import type { ClientPlugin, RoomHooks } from './plugin'

export function attachRoomHooks(editor: Editor, plugins: readonly ClientPlugin[]): () => void {
	const hooks: RoomHooks[] = []
	for (const plugin of plugins) {
		if (plugin.roomHooks) hooks.push(plugin.roomHooks(editor))
	}

	const cleanups: Array<() => void> = []

	const before = hooks.filter((h) => h.beforeShapeDelete)
	if (before.length > 0) {
		cleanups.push(
			editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
				// Every feature sees the delete; any single veto cancels the batch.
				let vetoed = false
				for (const h of before) {
					if (h.beforeShapeDelete!(shape, source) === false) vetoed = true
				}
				if (vetoed) return false
			})
		)
	}

	const after = hooks.filter((h) => h.afterShapeDelete)
	if (after.length > 0) {
		cleanups.push(
			editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
				for (const h of after) h.afterShapeDelete!(shape)
			})
		)
	}

	for (const h of hooks) {
		if (h.cleanup) cleanups.push(h.cleanup)
	}

	return () => {
		for (const cleanup of cleanups) cleanup()
	}
}
```

- [ ] **Step 5: Run both tests, typecheck, commit**

Run (from `client/`): `npx tsx src/kernel/plugin.test.ts && npx tsx src/kernel/roomHooks.test.ts`
Expected: both pass. Then:

```bash
npm run typecheck
git add client/src/kernel/plugin.ts client/src/kernel/plugin.test.ts client/src/kernel/roomHooks.ts client/src/kernel/roomHooks.test.ts
git commit -m "feat(client): ClientPlugin manifest type, registry aggregators, attachRoomHooks"
```

---

### Task 3: `rawUserId` moves to contracts

Three copies of the `user:`-prefix strip exist (server `kernel/presence.ts:30`, client `AvOverlay.tsx` `rawId`, client `useSessionPulse.ts` `rawId`). Contracts §1.5 names this exact convention as contracts-owned. This task adds it to contracts and swaps the server; the client copies are retired in Tasks 9–10 as those files are touched.

**Files:**
- Create: `contracts/src/user-id.ts`
- Create: `contracts/src/user-id.test.ts`
- Modify: `contracts/src/index.ts`
- Modify: `server/src/kernel/presence.ts` (definition → re-export)

- [ ] **Step 1: Write the failing test**

`contracts/src/user-id.test.ts`:

```ts
/**
 * Run: npx tsx --test contracts/src/user-id.test.ts   (from the repo root)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rawUserId } from './user-id.js'

test('strips the tldraw presence prefix', () => {
	assert.equal(rawUserId('user:abc123'), 'abc123')
})

test('raw ids pass through', () => {
	assert.equal(rawUserId('abc123'), 'abc123')
})

test('only the leading prefix is stripped', () => {
	assert.equal(rawUserId('user:user:x'), 'user:x')
	assert.equal(rawUserId('xuser:y'), 'xuser:y')
})

test('null and undefined normalise to the empty string', () => {
	assert.equal(rawUserId(null), '')
	assert.equal(rawUserId(undefined), '')
})
```

Run: `npx tsx --test contracts/src/user-id.test.ts` — FAIL (module missing).

- [ ] **Step 2: Implement**

`contracts/src/user-id.ts`:

```ts
/**
 * tldraw presence stores userId as a prefixed TLUserId ("user:abc123");
 * LiveKit identities, server session maps and the pulse/latency wire all use
 * the raw form ("abc123"). Normalise to raw so the two planes join on one id.
 */
export function rawUserId(id: string | null | undefined): string {
	return (id ?? '').replace(/^user:/, '')
}
```

Append to `contracts/src/index.ts`:

```ts
export * from './user-id.js'
```

- [ ] **Step 3: Swap the server definition for a re-export**

In `server/src/kernel/presence.ts`, the current definition is semantically identical (`return (id ?? '').replace(/^user:/, '')`) — verify this by reading it, then replace the function (and its comment block) with:

```ts
// tldraw presence stores userId as a prefixed TLUserId ("user:abc") while the
// LiveKit/session planes use the raw form — the strip lives in contracts now.
export { rawUserId } from '@ensembleworks/contracts'
```

Keep the export so existing `kernel/presence.ts` consumers are untouched. If the body you find is NOT the exact semantics above, stop and report instead of swapping.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx tsx --test contracts/src/user-id.test.ts
npm run typecheck
# run the server test suites that exercise presence (same list 2a used):
for t in server/src/*.test.ts; do npx tsx --test "$t" || break; done
git add contracts/src/user-id.ts contracts/src/user-id.test.ts contracts/src/index.ts server/src/kernel/presence.ts
git commit -m "feat(contracts): rawUserId owns the user:-prefix convention"
```

---

### Task 4: terminal, iframe, neko, roadmap plugin manifests

Creates four dormant plugin modules (nothing imports them until Task 6) and moves the three shape-creation helpers out of `ui.tsx` into their features. `ui.tsx` keeps its old overrides/toolbars until Task 8 but imports the moved helpers, so there is a single source of truth for each helper at every commit. The tool *definitions* are temporarily duplicated (live in `ui.tsx`, dormant in `plugin.tsx`) until Task 8 deletes the `ui.tsx` copies — accepted for two tasks.

**Files:**
- Create: `client/src/terminal/plugin.ts`
- Create: `client/src/iframe/createDevServerShape.ts`, `client/src/iframe/plugin.tsx`
- Create: `client/src/neko/createNekoShape.ts`, `client/src/neko/plugin.tsx`
- Create: `client/src/roadmap/createRoadmapShape.ts`, `client/src/roadmap/plugin.tsx`
- Modify: `client/src/ui.tsx` (delete the three local helpers; import them instead)

- [ ] **Step 1: Move the creation helpers (bodies verbatim from ui.tsx)**

`client/src/iframe/createDevServerShape.ts` — move `createDevServerShape` from `ui.tsx:36-50` verbatim, with:

```ts
import { Editor, createShapeId } from 'tldraw'
import { toProxiedUrl } from './IframeShapeUtil'
```

`client/src/neko/createNekoShape.ts` — move `createNekoShape` from `ui.tsx:52-63` verbatim, with:

```ts
import { Editor, createShapeId } from 'tldraw'
import { NEKO_DEFAULT_BASE, NEKO_DEFAULT_H, NEKO_DEFAULT_W } from './NekoShapeUtil'
```

`client/src/roadmap/createRoadmapShape.ts` — move `createRoadmapShape` from `ui.tsx:65-86` verbatim (keep its comment block), with:

```ts
import { slugify } from '@ensembleworks/contracts'
import { Editor, createShapeId } from 'tldraw'
import { ROADMAP_DEFAULT_H, ROADMAP_DEFAULT_W } from './RoadmapShapeUtil'
```

In `ui.tsx`: delete the three function definitions and their now-unused imports (`slugify`, `createShapeId`, `toProxiedUrl`, `NEKO_DEFAULT_*`, `ROADMAP_DEFAULT_*`), and add:

```ts
import { createDevServerShape } from './iframe/createDevServerShape'
import { createNekoShape } from './neko/createNekoShape'
import { createRoadmapShape } from './roadmap/createRoadmapShape'
```

(The old `export function` becomes a plain import — nothing outside `ui.tsx` imported these.)

- [ ] **Step 2: Terminal plugin**

`client/src/terminal/plugin.ts`:

```ts
/**
 * Terminal plugin: shape util, the "New terminal" toolbar button, and the
 * delete-veto room hook.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { TerminalShapeUtil } from './TerminalShapeUtil'
import { TerminalToolbarItem } from './TerminalToolbarItem'

export const terminalPlugin: ClientPlugin = {
	id: 'terminal',
	shapeUtils: [TerminalShapeUtil],
	ToolbarItems: TerminalToolbarItem,
	roomHooks: () => {
		// Terminals are easy to delete by accident (one stray Backspace on a
		// selected shape). Veto local deletions unless the user confirms. One
		// dialog covers the whole delete gesture: batch members reach the
		// handler microseconds apart, so a decision is reused (and its window
		// extended) while calls keep arriving within 250ms of the last one —
		// measured from when the dialog closed, since confirm() blocks for
		// however long the user thinks. The tmux session itself survives.
		let decision = false
		let decidedAt = 0
		return {
			beforeShapeDelete(shape, source) {
				if (source !== 'user' || shape.type !== 'terminal') return
				const props = shape.props as { title?: string; sessionId?: string }
				if (Date.now() - decidedAt > 250) {
					decision = window.confirm(
						`Delete terminal "${props.title ?? ''}"` +
							` (and any other terminals in this selection)?\n\n` +
							`tmux sessions keep running on the VM — reattach with: ` +
							`tmux attach -t canvas-${props.sessionId ?? '<id>'}`
					)
				}
				decidedAt = Date.now()
				if (!decision) return false
			},
		}
	},
}
```

(The hook body is the `App.tsx:144-159` veto verbatim; the factory closure replaces the `handleMount` closure so state stays per-mount. App.tsx itself is untouched until Task 7.)

- [ ] **Step 3: iframe, neko, roadmap plugins**

`client/src/iframe/plugin.tsx`:

```tsx
/**
 * Iframe plugin: proxied-iframe shape, the "Embed dev server" tool, and the
 * paste-a-URL handler.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createDevServerShape } from './createDevServerShape'
import { IframeShapeUtil } from './IframeShapeUtil'
import { PasteUrlHandler } from './PasteUrlHandler'

function DevServerToolbarItem() {
	const tools = useTools()
	if (!tools['dev-server']) return null
	return <TldrawUiMenuItem {...tools['dev-server']} />
}

export const iframePlugin: ClientPlugin = {
	id: 'iframe',
	shapeUtils: [IframeShapeUtil],
	tools: (editor: Editor) => ({
		'dev-server': {
			id: 'dev-server',
			icon: 'tool-embed',
			label: 'Embed dev server',
			readonlyOk: false,
			onSelect() {
				createDevServerShape(editor)
			},
		},
	}),
	ToolbarItems: DevServerToolbarItem,
	Overlay: PasteUrlHandler,
}
```

`client/src/neko/plugin.tsx`:

```tsx
/**
 * Neko plugin: the shared-browser shape, its toolbar icon and tool.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createNekoShape } from './createNekoShape'
import { NEKO_ICON_NAME, NEKO_TOOLBAR_ICON, NekoShapeUtil } from './NekoShapeUtil'

function NekoToolbarItem() {
	const tools = useTools()
	if (!tools['neko']) return null
	return <TldrawUiMenuItem {...tools['neko']} />
}

export const nekoPlugin: ClientPlugin = {
	id: 'neko',
	shapeUtils: [NekoShapeUtil],
	icons: { [NEKO_ICON_NAME]: NEKO_TOOLBAR_ICON },
	tools: (editor: Editor) => ({
		neko: {
			id: 'neko',
			icon: NEKO_ICON_NAME,
			label: 'New shared browser',
			readonlyOk: false,
			onSelect() {
				createNekoShape(editor)
			},
		},
	}),
	ToolbarItems: NekoToolbarItem,
}
```

`client/src/roadmap/plugin.tsx`:

```tsx
/**
 * Roadmap plugin: the roadmap shape and its toolbar tool.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { createRoadmapShape } from './createRoadmapShape'
import { RoadmapShapeUtil } from './RoadmapShapeUtil'

function RoadmapToolbarItem() {
	const tools = useTools()
	if (!tools['roadmap']) return null
	return <TldrawUiMenuItem {...tools['roadmap']} />
}

export const roadmapPlugin: ClientPlugin = {
	id: 'roadmap',
	shapeUtils: [RoadmapShapeUtil],
	tools: (editor: Editor) => ({
		roadmap: {
			id: 'roadmap',
			icon: 'tool-note',
			label: 'New roadmap',
			readonlyOk: false,
			onSelect() {
				createRoadmapShape(editor)
			},
		},
	}),
	ToolbarItems: RoadmapToolbarItem,
}
```

- [ ] **Step 4: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add client/src/terminal/plugin.ts client/src/iframe/ client/src/neko/ client/src/roadmap/ client/src/ui.tsx
git commit -m "feat(client): terminal/iframe/neko/roadmap plugin manifests; creation helpers move into features"
```

---

### Task 5: screenshare plugin (subscription loop, delete hook, retint helper)

**Files:**
- Modify: `client/src/screenshare/store.ts` (add `useScreenShareRoom`)
- Modify: `client/src/screenshare/share.ts` (add `stopShareForDeletedShape` + `retintLocalShares`; keep `installDeleteHandler` for now — Task 7 removes it)
- Create: `client/src/screenshare/SubscriptionLoop.tsx`
- Create: `client/src/screenshare/plugin.tsx`
- Modify: `client/src/av/AvOverlay.tsx` (ColorDot uses `retintLocalShares`)

- [ ] **Step 1: store.ts — reactive room hook**

Add to `client/src/screenshare/store.ts` (below `useScreenShareTrack`):

```ts
/** The registered LiveKit room, reactively (null while A/V is down). */
export function useScreenShareRoom(): Room | null {
	useSyncExternalStore(subscribeStore, getVersion)
	return room
}
```

- [ ] **Step 2: share.ts — exported hook body + retint helper**

Add to `client/src/screenshare/share.ts` (after `stopScreenShare`; import `TLShape` type from tldraw):

```ts
/**
 * Room-hook body (registered by plugin.tsx): deleting a live share's tile —
 * locally or by a teammate over sync — stops the capture, since a tile-less
 * stream would otherwise keep uploading invisibly.
 */
export function stopShareForDeletedShape(shape: TLShape): void {
	if (shape.type !== 'screenshare') return
	const trackName = (shape.props as { trackName: string }).trackName
	if (active.has(trackName)) stopScreenShare(trackName)
}

/**
 * Re-tint every screenshare tile owned by the local user. ownerColor is a
 * synced prop, so this recolours the tile for every viewer, not just me.
 * Called by the roster colour picker; owning it here keeps knowledge of the
 * screenshare shape type and its props out of the A/V layer.
 */
export function retintLocalShares(editor: Editor, hex: string): void {
	const myId = editor.user.getId()
	for (const record of editor.store.allRecords()) {
		if (
			record.typeName === 'shape' &&
			record.type === 'screenshare' &&
			record.props.participantId === myId
		) {
			editor.updateShape({ id: record.id, type: 'screenshare', props: { ownerColor: hex } })
		}
	}
}
```

(`retintLocalShares` body is the `AvOverlay.tsx:746-755` loop verbatim. Do NOT remove `installDeleteHandler`/`deleteHandlerInstalled` yet — the plugin's hook isn't wired until Task 7; removing the lazy install now would leave a window with no delete handler at all. Refactor `installDeleteHandler`'s handler to call `stopShareForDeletedShape` so the body isn't duplicated:)

```ts
function installDeleteHandler(editor: Editor) {
	if (deleteHandlerInstalled.has(editor)) return
	deleteHandlerInstalled.add(editor)
	editor.sideEffects.registerAfterDeleteHandler('shape', stopShareForDeletedShape)
}
```

- [ ] **Step 3: AvOverlay ColorDot uses the helper**

In `client/src/av/AvOverlay.tsx`, inside `ColorDot`'s `pick`, replace the `const myId = ...` line and the `for (const record of editor.store.allRecords()) {...}` loop with:

```ts
		retintLocalShares(editor, hex)
```

keeping the two-line comment above it (`// Re-tint any windows I'm already sharing. ownerColor is a synced prop,` / `// so updating it here recolours the tile for every viewer, not just me.`). Add `import { retintLocalShares } from '../screenshare/share'`.

- [ ] **Step 4: the subscription-loop component**

`client/src/screenshare/SubscriptionLoop.tsx`:

```tsx
/**
 * Viewport-scoped screen-share delivery, hosted by the screenshare feature
 * itself (formerly a loop inside AvOverlay): every 150 ms, subscribe only to
 * screen tracks whose tile is in (or near) the viewport, with hysteresis so
 * edge-panning doesn't flap. Runs only while a LiveKit room is registered.
 * Audio subscriptions untouched.
 */
import { useEditor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { useScreenShareRoom } from './store'
import { updateScreenShareSubscriptions } from './subscriptions'

export function ScreenShareSubscriptionLoop() {
	const editor = useEditor()
	const room = useScreenShareRoom()
	useEvery(
		150,
		() => {
			if (room) updateScreenShareSubscriptions(editor, room)
		},
		room != null
	)
	return null
}
```

- [ ] **Step 5: the plugin manifest**

`client/src/screenshare/plugin.tsx`:

```tsx
/**
 * Screenshare plugin: shape util, toolbar icon + tool (offered only when A/V
 * is up and this participant may publish), the viewport-scoped subscription
 * loop, and the delete room-hook that stops a live capture with its tile.
 */
import type { Editor } from 'tldraw'
import { TldrawUiMenuItem, useTools } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import {
	SCREENSHARE_ICON_NAME,
	SCREENSHARE_TOOLBAR_ICON,
	ScreenShareShapeUtil,
} from './ScreenShareShapeUtil'
import { startScreenShare, stopShareForDeletedShape } from './share'
import { useScreenShareAvailable } from './store'
import { ScreenShareSubscriptionLoop } from './SubscriptionLoop'

function ScreenShareToolbarItem() {
	const tools = useTools()
	const available = useScreenShareAvailable()
	if (!available || !tools['screenshare']) return null
	return <TldrawUiMenuItem {...tools['screenshare']} />
}

export const screensharePlugin: ClientPlugin = {
	id: 'screenshare',
	shapeUtils: [ScreenShareShapeUtil],
	icons: { [SCREENSHARE_ICON_NAME]: SCREENSHARE_TOOLBAR_ICON },
	tools: (editor: Editor) => ({
		screenshare: {
			id: 'screenshare',
			icon: SCREENSHARE_ICON_NAME,
			label: 'Share screen',
			readonlyOk: false,
			onSelect() {
				void startScreenShare(editor)
			},
		},
	}),
	ToolbarItems: ScreenShareToolbarItem,
	Overlay: ScreenShareSubscriptionLoop,
	roomHooks: () => ({
		afterShapeDelete: stopShareForDeletedShape,
	}),
}
```

- [ ] **Step 6: Tests, typecheck, commit**

```bash
cd client && npx tsx src/screenshare/visibility.test.ts && npx tsx src/screenshare/resolve.test.ts && npx tsx src/screenshare/screenshare.test.ts && cd ..
npm run typecheck
git add client/src/screenshare/ client/src/av/AvOverlay.tsx
git commit -m "feat(client): screenshare plugin — subscription loop, delete hook, retint helper"
```

---

### Task 6: av / demo / session plugins + the registry

**Files:**
- Create: `client/src/av/plugin.ts`
- Move: `client/src/demo.ts` → `client/src/demo/seedDemoCanvas.ts` (git mv, content verbatim)
- Create: `client/src/demo/plugin.tsx`
- Create: `client/src/session/plugin.tsx`
- Create: `client/src/plugins.ts`
- Modify: `client/src/ui.tsx` (import path for `seedDemoCanvas`)

- [ ] **Step 1: av plugin**

`client/src/av/plugin.ts`:

```ts
/**
 * A/V plugin: the session panel (roster, faces rail, spatial audio,
 * transcript, VM strip) claims tldraw's SharePanel slot.
 */
import type { ClientPlugin } from '../kernel/plugin'
import { AvOverlay } from './AvOverlay'

export const avPlugin: ClientPlugin = {
	id: 'av',
	uiSlots: { SharePanel: AvOverlay },
}
```

- [ ] **Step 2: demo move + plugin**

```bash
mkdir -p client/src/demo && git mv client/src/demo.ts client/src/demo/seedDemoCanvas.ts
```

Update `ui.tsx`: `import { seedDemoCanvas } from './demo'` → `from './demo/seedDemoCanvas'`.

`client/src/demo/plugin.tsx`:

```tsx
/**
 * Demo plugin: the "Seed demo layout" main-menu entry.
 */
import { TldrawUiMenuItem, useEditor } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { seedDemoCanvas } from './seedDemoCanvas'

function DemoMenuItems() {
	const editor = useEditor()
	return (
		<TldrawUiMenuItem
			id="seed-demo"
			label="Seed demo layout"
			icon="duplicate"
			onSelect={() => seedDemoCanvas(editor)}
		/>
	)
}

export const demoPlugin: ClientPlugin = {
	id: 'demo',
	MenuItems: DemoMenuItems,
}
```

- [ ] **Step 3: session plugin**

`client/src/session/plugin.tsx`:

```tsx
/**
 * Session plugin: the "Seed session layout" main-menu entry.
 */
import { TldrawUiMenuItem, useEditor } from 'tldraw'
import type { ClientPlugin } from '../kernel/plugin'
import { seedSessionCanvas } from './seedSessionCanvas'

function SessionMenuItems() {
	const editor = useEditor()
	return (
		<TldrawUiMenuItem
			id="seed-session"
			label="Seed session layout"
			icon="duplicate"
			onSelect={() => {
				seedSessionCanvas(editor)
			}}
		/>
	)
}

export const sessionPlugin: ClientPlugin = {
	id: 'session',
	MenuItems: SessionMenuItems,
}
```

- [ ] **Step 4: the registry**

`client/src/plugins.ts`:

```ts
/**
 * The client plugin registry: the one ordered list of features composed into
 * the editor. Order is meaningful — it fixes shape-util registration order,
 * toolbar order (after tldraw's defaults) and menu order, and reproduces the
 * pre-registry hard-coded ordering exactly:
 *   shape utils  terminal, iframe, neko, roadmap, screenshare   (App.tsx:31)
 *   toolbar      terminal, dev-server, neko, roadmap, screenshare (ui.tsx:130)
 *   menu         seed-demo, seed-session                          (ui.tsx:164)
 */
import { avPlugin } from './av/plugin'
import { demoPlugin } from './demo/plugin'
import { iframePlugin } from './iframe/plugin'
import type { ClientPlugin } from './kernel/plugin'
import { nekoPlugin } from './neko/plugin'
import { roadmapPlugin } from './roadmap/plugin'
import { screensharePlugin } from './screenshare/plugin'
import { sessionPlugin } from './session/plugin'
import { terminalPlugin } from './terminal/plugin'

export const plugins: readonly ClientPlugin[] = [
	terminalPlugin,
	iframePlugin,
	nekoPlugin,
	roadmapPlugin,
	screensharePlugin,
	avPlugin,
	demoPlugin,
	sessionPlugin,
]
```

- [ ] **Step 5: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add client/src/av/plugin.ts client/src/demo/ client/src/session/plugin.tsx client/src/plugins.ts client/src/ui.tsx
git rm --cached client/src/demo.ts 2>/dev/null || true
git commit -m "feat(client): av/demo/session plugins + the ordered plugin registry"
```

---

### Task 7: App.tsx becomes a kernel assembler

The switchover, part 1. App derives shape utils, icons, room hooks and overlays from the registry; the legacy paths those hooks replace are deleted **in the same commit** (terminal veto inline in `handleMount`; screenshare lazy `installDeleteHandler`; AvOverlay's subscription-loop effect — its replacement Overlay starts rendering now).

**Files:**
- Modify: `client/src/App.tsx` (full rewrite below)
- Modify: `client/src/screenshare/share.ts` (delete `installDeleteHandler`, `deleteHandlerInstalled`, and the `installDeleteHandler(editor)` call in `startScreenShare`)
- Modify: `client/src/av/AvOverlay.tsx` (delete the screenshare-subscription `useEffect` at lines 210–219 and the now-unused `updateScreenShareSubscriptions` import)

- [ ] **Step 1: Rewrite App.tsx**

Full new content (everything not shown as changed is verbatim from today — preserve all comments):

```tsx
import { useSync } from '@tldraw/sync'
import { useMemo, useState } from 'react'
import {
	DefaultColorStyle,
	Editor,
	Tldraw,
	defaultBindingUtils,
	defaultShapeUtils,
	getDefaultUserPresence,
	getUserPreferences,
	setUserPreferences,
} from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { computeStamp, type StampRecord } from '@ensembleworks/contracts'
import { assetStore } from './assetStore'
import { hexForColor } from './colors'
import { getIdentity, getRoomId } from './identity'
import { collectIcons, collectShapeUtils } from './kernel/plugin'
import { attachRoomHooks } from './kernel/roomHooks'
import { plugins } from './plugins'
import { components, uiOverrides } from './ui'

// Feature composition is registry-driven: every shape util, toolbar icon,
// overlay and room hook comes from the plugin list, in registry order.
// Module-level so the references stay stable across renders (the asset-url
// and shape-util props must not churn).
const customShapeUtils = collectShapeUtils(plugins)
const assetUrls = { icons: collectIcons(plugins) }
```

Then lines 48–110 of the current file **verbatim** (`COLOR_SCHEME_SEEDED_KEY` through the end of the `useSync` config — the color-scheme comment, `identity`/`roomId`, the `shapeQuery` cache + comments, `setUserPreferences`, `wsBase`, `App()`'s `wasKicked` state and the whole `useSync` block).

`handleMount` becomes:

```tsx
	const handleMount = useMemo(
		() => (editor: Editor) => {
			// Debug/e2e hook: headless probes (docs/headless-browser.md) drive
			// the canvas through this. Harmless in production.
			;(window as unknown as { __ewEditor?: Editor }).__ewEditor = editor
			// Default users to the paper-light canvas, but only once: tldraw
			// persists colorScheme in its own localStorage, so afterwards we leave
			// whatever the user chose via Preferences → Color scheme alone.
			if (!localStorage.getItem(COLOR_SCHEME_SEEDED_KEY)) {
				editor.user.updateUserPreferences({ colorScheme: 'light' })
				localStorage.setItem(COLOR_SCHEME_SEEDED_KEY, '1')
			}
			// Hex is derived from the theme as settled at mount time; a later
			// Preferences → Color scheme toggle won't re-tint the cursor until
			// the next reload or colour pick.
			const isDark = editor.user.getIsDarkMode()
			editor.user.updateUserPreferences({
				name: identity.name,
				color: hexForColor(identity.colorKey, isDark),
			})
			// New stickies/geo/draw/text the user creates start in their colour.
			// It's a default, not a lock — tldraw's style panel still overrides
			// per shape. Re-applied when they change colour (AvOverlay picker).
			editor.setStyleForNextShapes(DefaultColorStyle, identity.colorKey)

			// Feature room hooks (the terminal delete-veto, the screenshare
			// after-delete) come from the plugin registry. React StrictMode
			// mounts twice — the returned cleanup keeps hooks from doubling up.
			return attachRoomHooks(editor, plugins)
		},
		[]
	)
```

Render block — `<PasteUrlHandler />` is replaced by the registry's overlays (the iframe plugin contributes it; screenshare contributes the subscription loop). The kicked overlay stays verbatim:

```tsx
			<Tldraw
				store={store}
				onMount={handleMount}
				deepLinks
				assetUrls={assetUrls}
				shapeUtils={customShapeUtils}
				overrides={uiOverrides}
				components={components}
			>
				{plugins.map((plugin) => {
					const Overlay = plugin.Overlay
					return Overlay ? <Overlay key={plugin.id} /> : null
				})}
			</Tldraw>
```

Deleted imports: `IframeShapeUtil`, `PasteUrlHandler`, `NEKO_ICON_NAME`/`NEKO_TOOLBAR_ICON`/`NekoShapeUtil`, `SCREENSHARE_*`/`ScreenShareShapeUtil`, `TerminalShapeUtil`, `RoadmapShapeUtil`.

- [ ] **Step 2: Remove the legacy screenshare lazy install**

In `client/src/screenshare/share.ts`: delete `deleteHandlerInstalled`, `installDeleteHandler`, and the `installDeleteHandler(editor)` call at the end of `startScreenShare` (its comment about the delete handler moves onto `stopShareForDeletedShape`, which already carries it).

- [ ] **Step 3: Remove AvOverlay's subscription-loop effect**

In `client/src/av/AvOverlay.tsx`: delete the `useEffect` block at (current) lines 210–219 including its four-line comment, and the `import { updateScreenShareSubscriptions } from '../screenshare/subscriptions'` line. Also update the file's doc-header bullet list: drop nothing yet except, if present, any mention of the screenshare loop (the "viewport-scoped" behaviour is now documented in `SubscriptionLoop.tsx`).

- [ ] **Step 4: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add client/src/App.tsx client/src/screenshare/share.ts client/src/av/AvOverlay.tsx
git commit -m "refactor(client): App.tsx assembles from the plugin registry (shape utils, icons, room hooks, overlays)"
```

---

### Task 8: ui.tsx becomes a kernel assembler

The switchover, part 2: tools/toolbar/menu/component-slots all iterate the registry; the per-feature knowledge deleted here already lives in the Task 4–6 plugin manifests.

**Files:**
- Modify: `client/src/ui.tsx` (full rewrite below)

- [ ] **Step 1: Rewrite ui.tsx**

Full new content (`AboutDialog` body is verbatim from today):

```tsx
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
```

Everything else in the old file is deleted: the tool definitions (now in plugins), `ToolbarWithTerminal`, `MainMenuWithDemo` (its `useEditor` moved into the plugin MenuItems), and all feature imports (`TerminalToolbarItem`, `AvOverlay`, `SCREENSHARE_ICON_NAME`, `startScreenShare`, `useScreenShareAvailable`, `seedDemoCanvas`, `seedSessionCanvas`, the creation helpers, `NEKO_*`, `ROADMAP_*`).

- [ ] **Step 2: Parity spot-check**

Confirm against the parity ledger: tools keys/fields (3), toolbar order (4 — registry order terminal→iframe→neko→roadmap→screenshare matches the old hard-coding), menu order (5 — demo→session→About), components map (6 — `collectUiSlots` supplies `SharePanel: AvOverlay` via the av plugin). Menu-group id stays `ensembleworks-demo`.

- [ ] **Step 3: Typecheck, build, commit**

```bash
npm run typecheck && npm run build
git add client/src/ui.tsx
git commit -m "refactor(client): ui.tsx assembles tools, toolbar, menu and slots from the plugin registry"
```

---

### Task 9: AvOverlay dismemberment I — presentational leaves

Pure moves: bodies byte-identical, only imports/exports added. After this task `AvOverlay.tsx` imports the four new modules and is ~450 lines lighter.

**Files:**
- Create: `client/src/av/icons.tsx` — move `AvIconKind`, `AvIconButton`, `AvIcon` (current lines 1238–1302). Exports: `AvIconButton` and `export type AvIconKind`. Imports: `import { wm } from '../theme'`.
- Create: `client/src/av/gauges.tsx` — move `gradeColor`, `fmtBytes`, `VmStrip`, `VmBar`, `LatencyPill` (current lines 1055–1236, keeping every comment incl. the gradeColor "shared by the VM bars and the latency pills" note). Exports: `VmStrip`, `LatencyPill`. Imports: `import { wm } from '../theme'` and `import { type LatencySample, type VmStats } from './useSessionPulse'`.
- Create: `client/src/av/TranscriptModal.tsx` — move `TranscriptLine` + `TranscriptModal` (current lines 875–1053). Export: `TranscriptModal`. Imports: `react` (`useEffect, useRef, useState`), `stopEventPropagation` from tldraw, `wm`, and `import { scheduler } from '../kernel/scheduler'`.
- Create: `client/src/av/rail.tsx` — move `FACE`, `FACE_SPEAKING`, `RailFaceData`, `FacesRail`, `RailFace` (current lines 26–37 and 320–457). Exports: `FacesRail`, `export type RailFaceData`. Imports: livekit-client types (`LocalTrack, RemoteTrack, Track`), `react` (`useEffect, useRef`), `stopEventPropagation` from tldraw, `wm`.
- Modify: `client/src/av/AvOverlay.tsx` — delete the moved code, import from the new modules.

- [ ] **Step 1: Move the four leaves** (bodies verbatim — copy exactly, adjust nothing inside function bodies)

- [ ] **Step 2: The one allowed body change — TranscriptModal's poll goes through the scheduler**

In the moved `TranscriptModal`, replace:

```ts
		const timer = setInterval(load, 4000)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
```

with:

```ts
		const cancel = scheduler.every(4000, () => {
			void load()
		})
		return () => {
			cancelled = true
			cancel()
		}
```

(Same 4000 ms cadence, same immediate `load()` call before it, same teardown semantics.)

- [ ] **Step 3: Rewire AvOverlay.tsx**

Add imports; remove the now-unneeded ones (`LocalTrack, RemoteTrack, Track` if no longer referenced by remaining code — note `RailFaceData` is still needed for the `railFaces` `useValue` type parameter):

```ts
import { VmStrip } from './gauges'          // ← only if still referenced here; SessionPanel moves in Task 10
import { FacesRail, type RailFaceData } from './rail'
import { TranscriptModal } from './TranscriptModal'
```

(At this task's end, `SessionPanel`/`ParticipantRow`/`ColorDot`/`ScribeRow` are still in AvOverlay.tsx and now import `LatencyPill`/`VmStrip` from `./gauges` and `AvIconButton` from `./icons` — update those references.)

- [ ] **Step 4: Verify the moves are verbatim**

```bash
git diff --color-moved=dimmed-zebra HEAD -- client/src/av/ | less -R
```

Every moved block should render as *moved* (dimmed), not as edit noise — except the one scheduler swap in Step 2.

- [ ] **Step 5: Typecheck, tests, commit**

```bash
npm run typecheck
cd client && npx tsx src/av/spatial.test.ts && cd ..
git add client/src/av/
git commit -m "refactor(av): extract icons, gauges, TranscriptModal and faces rail from AvOverlay"
```

---

### Task 10: AvOverlay dismemberment II — panel, leashes, spatial loop, orchestrator

**Files:**
- Create: `client/src/av/SessionPanel.tsx` — move `SessionParticipant`, `SessionPanel`, `ParticipantRow`, `ColorDot`, `ScribeRow` (bodies verbatim). Exports: `SessionPanel`, `export type SessionParticipant`. Imports: react (`useState`), tldraw (`DefaultColorStyle, stopEventPropagation, useEditor`), `rawUserId` from `@ensembleworks/contracts` (replaces the local `rawId` in the two `props.latencies[...]`/`props.latencyHistory[...]` lookups), `IDENTITY_COLORS, hexForColor, type IdentityColor` from `../colors`, `setUserColor` from `../identity`, `retintLocalShares` from `../screenshare/share`, `wm` from `../theme`, `AvIconButton` from `./icons`, `LatencyPill, VmStrip` from `./gauges`, `type LatencySample, type VmStats` from `./useSessionPulse`.
- Create: `client/src/av/leashes.tsx`:

```tsx
/**
 * Leashes from rail faces to their teammate's live cursor — drawn only for
 * the active speaker or the face you're hovering, and only when that cursor
 * is on the page you're viewing. The leash anchors at the face's on-screen
 * centre (live DOM rects from the rail's ref map), so it must recompute
 * after faces render — the useValue below re-derives on camera pans, peer
 * changes and hover changes.
 */
import { Editor, useValue } from 'tldraw'
import { rawUserId } from '@ensembleworks/contracts'
import type { RemotePeer } from './useLiveKitRoom'

export interface Leash {
	id: string
	x1: number
	y1: number
	x2: number
	y2: number
	color: string
	strong: boolean
}

export function useLeashes(
	editor: Editor,
	peers: RemotePeer[],
	hoveredId: string | null,
	faceRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
): Leash[] {
	return useValue<Leash[]>(
		'leashes',
		() => {
			// …body verbatim from AvOverlay.tsx lines 152–176, with rawId → rawUserId…
		},
		[editor, peers, hoveredId]
	)
}

// LeashOverlay component: moved verbatim (current lines 287–318).
```

  (The `useValue` body and `LeashOverlay` are verbatim moves; only `rawId` → `rawUserId` and `lk.peers` → the `peers` parameter change. Dep array `[editor, peers, hoveredId]` mirrors today's `[editor, lk.peers, hoveredId]`.)
- Create: `client/src/av/useSpatialGainLoop.ts`:

```ts
/**
 * The spatial audio loop: every 150 ms, set each peer's GainNode from the
 * canvas distance between my viewport centre and their cursor. Standup mode
 * pins everyone to full volume; a peer off my page fades to silence. The
 * 0.08 s setTargetAtTime constant is the smoothing that keeps pans from
 * clicking — behaviour, not taste.
 */
import { rawUserId } from '@ensembleworks/contracts'
import type { Editor } from 'tldraw'
import { useEvery } from '../kernel/useEvery'
import { DEFAULT_SPATIAL_SETTINGS, distance, gainForDistance } from './spatial'
import type { LiveKitState } from './useLiveKitRoom'

export function useSpatialGainLoop(editor: Editor, lk: LiveKitState, standupMode: boolean): void {
	useEvery(150, () => {
		const ctx = lk.audioContext
		if (!ctx) return
		const my = editor.getViewportPageBounds().center
		const collaborators = editor.getCollaboratorsOnCurrentPage()
		for (const peer of lk.peers) {
			if (!peer.gain) continue
			const presence = collaborators.find((c) => rawUserId(c.userId) === rawUserId(peer.identity))
			const target = !presence
				? 0
				: standupMode
					? 1
					: presence.cursor
						? gainForDistance(
								distance(my.x, my.y, presence.cursor.x, presence.cursor.y),
								DEFAULT_SPATIAL_SETTINGS
							)
						: 1
			peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08)
		}
	})
}
```

  (The `peersRef`/`standupRef` mirror refs are retired: `useEvery` ref-forwards the callback, so it closes over fresh `lk.peers`/`standupMode` every render. `LiveKitState` field names — `audioContext`, `peers`, `gain` on `RemotePeer` — must be verified against `useLiveKitRoom.ts` when writing this.)
- Modify: `client/src/av/useSessionPulse.ts` — two changes: (a) replace `const timer = setInterval(tick, PULSE_INTERVAL_MS)` / `clearInterval(timer)` with `const cancel = scheduler.every(PULSE_INTERVAL_MS, () => { void tick() })` / `cancel()` (adding `import { scheduler } from '../kernel/scheduler'`); (b) delete the local `rawId` + its comment, import `rawUserId` from `@ensembleworks/contracts`, and rename the one call site.
- Modify: `client/src/av/AvOverlay.tsx` — becomes the orchestrator:

```tsx
/**
 * The session panel orchestrator, rendered in tldraw's top-right SharePanel
 * slot. Derives the roster, rail faces and leashes from tldraw presence +
 * LiveKit state, runs the spatial-audio loop, and composes the pieces:
 * SessionPanel (roster/controls), FacesRail, LeashOverlay, TranscriptModal.
 * The screenshare subscription loop lives with the screenshare plugin.
 */
import { rawUserId } from '@ensembleworks/contracts'
import { useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { getRoomId } from '../identity'
import { wm } from '../theme'
import { LeashOverlay, useLeashes } from './leashes'
import { FacesRail, type RailFaceData } from './rail'
import { SessionPanel, type SessionParticipant } from './SessionPanel'
import { TranscriptModal } from './TranscriptModal'
import { useLiveKitRoom } from './useLiveKitRoom'
import { useSessionPulse } from './useSessionPulse'
import { useSpatialGainLoop } from './useSpatialGainLoop'
```

  Body: current lines 56–285 with these deltas and nothing else —
  - `rawId` local function deleted; all uses → `rawUserId`
  - the spatial-loop `useEffect` + `peersRef`/`standupRef` (current 180–208) → `useSpatialGainLoop(editor, lk, standupMode)`
  - the `leashes` `useValue` (current 150–178) → `const leashes = useLeashes(editor, lk.peers, hoveredId, faceRefs)`
  - `participants`, `scribes`, `railFaces`, `kickParticipant`, and the whole render tree stay verbatim (kick keeps its `/api/kick` fetch here — send path is orchestrator state).

- [ ] **Step 1: Create the three new modules; move the panel components** (verbatim bodies; the SessionPanel move carries the `rawId` → `rawUserId` rename at its two lookup sites)

- [ ] **Step 2: Swap useSessionPulse onto the scheduler + contracts rawUserId**

- [ ] **Step 3: Shrink AvOverlay.tsx to the orchestrator**

- [ ] **Step 4: Verify moves + behaviour parity**

```bash
git diff --color-moved=dimmed-zebra HEAD~2 -- client/src/av/ | less -R
grep -rn "setInterval\|setTimeout" client/src/av/     # expect: NO hits (all cadences via scheduler/useEvery)
grep -rn "rawId" client/src/av/ client/src/App.tsx    # expect: no local definitions left
grep -c "" client/src/av/AvOverlay.tsx                # expect: ~260 lines
```

- [ ] **Step 5: Typecheck, build, tests, commit**

```bash
npm run typecheck && npm run build
cd client && npx tsx src/av/spatial.test.ts && cd ..
git add client/src/av/
git commit -m "refactor(av): AvOverlay -> orchestrator + SessionPanel, leashes, spatial-gain loop; pulse via scheduler"
```

---

### Task 11: Full-sweep parity audit + checks

**Files:** none created — this is the audit gate (2a's Task 11 route-order audit, client edition).

- [ ] **Step 1: Run everything**

```bash
npm run typecheck && npm run build
cd client
for t in $(find src -name '*.test.ts'); do echo "== $t"; npx tsx "$t" || break; done
cd ..
for t in server/src/*.test.ts; do echo "== $t"; npx tsx --test "$t" || break; done
npx tsx --test contracts/src/user-id.test.ts contracts/src/stamp.test.ts contracts/src/slug.test.ts
```

Expected: all green.

- [ ] **Step 2: Parity audit against the ledger**

Walk all 14 ledger items. Mechanical checks:

```bash
# 1. shape-util order
grep -n "shapeUtils" client/src/plugins.ts client/src/*/plugin.ts*
# 9. cadence inventory — the only remaining raw timers must be the feature-internal ones
grep -rn "setInterval\|setTimeout" client/src/ --include='*.ts*' | grep -v '.test.ts'
# expected survivors: terminal/TerminalShapeUtil.tsx (reconnect + font probe),
# neko/NekoShapeUtil.tsx (mute backstop + nudge), roadmap/RoadmapShapeUtil.tsx
# (copied flag), screenshare/share.ts (aspect poll), kernel/scheduler.ts (the host)
# 7/8. exactly one delete-registration site
grep -rn "registerBeforeDeleteHandler\|registerAfterDeleteHandler" client/src/ --include='*.ts*'
# expected: kernel/roomHooks.ts only
# 12. debug hooks
grep -rn "__ewEditor\|__ewScreenShareRoom" client/src/
```

For items 3–6, diff the rendered structure by eye against the pre-branch `ui.tsx`/`App.tsx` (`git show main:client/src/ui.tsx`).

- [ ] **Step 3: Live smoke (if the dev stack is available)**

`bin/dev up` then load `http://localhost:5173` (headless probe per docs/headless-browser.md or the Chrome tools): toolbar shows terminal/dev-server/neko/roadmap items; `window.__ewEditor` exists; creating + deleting a terminal shape raises the confirm dialog once (StrictMode check); the session panel renders. If the stack can't run in this environment, record that the smoke was skipped and why.

- [ ] **Step 4: Commit any audit fixes, then write the execution postscript**

Append to this plan file: deviations, deferred items discovered during execution, and the audit results table.

```bash
git add -A && git commit -m "docs(plan): phase2b execution postscript"
```

---

## Self-review notes (writing-plans checklist)

- **Spec coverage:** §7 Phase 2 client scope = plugin list iteration (Tasks 4–8), roomHooks (Tasks 2, 4, 5, 7), scheduler (Tasks 1, 5, 9, 10), AvOverlay dismemberment (Tasks 9–10). Contracts `rawUserId` (Task 3) implements the §1.5 "user:-prefix stripping" line.
- **Type consistency:** `ClientPlugin` fields (`shapeUtils/icons/tools/ToolbarItems/MenuItems/Overlay/uiSlots/roomHooks`) are used with exactly those names in Tasks 4–8; `RoomHooks.beforeShapeDelete/afterShapeDelete/cleanup` match between Task 2 and Tasks 4–5; `scheduler.every`/`useEvery`/`CancelCadence` match between Task 1 and Tasks 5, 9, 10; `LiveKitState`/`RemotePeer` are the real exported names in `useLiveKitRoom.ts`.
- **Known judgment points for implementers:** exact tldraw type names (`TLUiToolItem`, `TLAnyShapeUtilConstructor`, the `source` union on delete handlers) — verify against the installed tldraw d.ts, don't loosen types; `LiveKitState` field names in Task 10; the server `rawUserId` body check in Task 3.
