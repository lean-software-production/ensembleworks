# Per-user colour identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every canvas user a coherent colour identity (aligned to tldraw's named palette) that defaults their stickies, their next drawn shapes, and their screenshare-tile border to that colour, with a per-user override picker.

**Architecture:** A new pure `client/src/colors.ts` module owns the palette (10 named tldraw colours), the deterministic id→colour hash, and hex lookup. `identity.ts` composes it (override from `localStorage`, else hash) and exposes `colorKey` + `setUserColor`. `App.tsx` feeds the colour into tldraw presence and sets it as the default style for next shapes on mount. The screenshare custom shape gains an `ownerColor` prop (mirrored in the server schema) stamped at creation and drawn as the tile border. A swatch popover on the local user's roster dot lets them change colour, re-deriving presence + next-shape default live.

**Tech Stack:** TypeScript, React, tldraw (`DefaultColorStyle`, `editor.user.*`, `setStyleForNextShapes`), `@tldraw/tlschema` (server schema), standalone `tsx` test scripts using `node:assert/strict`.

## Global Constraints

- Custom-shape props MUST be mirrored in `server/src/schema.ts` (see comment `Keep in sync with client/src/screenshare/ScreenShareShapeUtil.tsx`). Any new prop needs a matching server change.
- New shape props MUST be **optional with a render fallback** so existing persisted rooms need no migration (follow the existing `stillUrl?` / `status?` pattern).
- `colors.ts` MUST stay pure — no `localStorage`, no `window`, no `import from 'tldraw'` — so it is importable/testable under `npx tsx` (tldraw's entry is not loadable in node).
- Tests are standalone scripts run with `npx tsx <path>`, using `import assert from 'node:assert/strict'`, ending with a `console.log('...PASSED')`. No test framework.
- Verify commands run from the repo root: `npm run typecheck` and `npm run build` cover all three workspaces.
- The identity colour palette is exactly these 10 tldraw colour names (drop `black`/`grey`): `blue, light-blue, green, light-green, violet, light-violet, orange, yellow, red, light-red`.
- Commit messages end with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File Structure

- **Create** `client/src/colors.ts` — pure palette module: `IDENTITY_COLORS`, `IdentityColor`, `hexForColor`, `colorKeyForId`, `isIdentityColor`.
- **Create** `client/src/colors.test.ts` — unit test for the pure module.
- **Modify** `client/src/identity.ts` — `Identity.colorKey` (replaces `color`), override resolution, `setUserColor`.
- **Modify** `client/src/App.tsx` — presence colour from `colorKey`; `setStyleForNextShapes` on mount.
- **Modify** `server/src/schema.ts` — mirror `ownerColor?` on the screenshare schema.
- **Modify** `client/src/screenshare/ScreenShareShapeUtil.tsx` — `ownerColor?` prop + coloured border.
- **Modify** `client/src/screenshare/share.ts` — stamp `ownerColor` at tile creation.
- **Modify** `client/src/av/AvOverlay.tsx` — swatch picker on the local user's roster dot.

---

## Task 1: Pure colour palette module (`colors.ts`)

**Files:**
- Create: `client/src/colors.ts`
- Test: `client/src/colors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `IDENTITY_COLORS: readonly IdentityColor[]` — the 10 palette keys.
  - `type IdentityColor` — union of the 10 tldraw colour-name strings.
  - `colorKeyForId(id: string): IdentityColor` — deterministic hash.
  - `isIdentityColor(x: unknown): x is IdentityColor` — validate an override.
  - `hexForColor(key: IdentityColor, isDark: boolean): string` — solid hex per tldraw's default theme.

- [ ] **Step 1: Write the failing test**

Create `client/src/colors.test.ts`:

```ts
/**
 * Pure identity-colour palette. Run: npx tsx src/colors.test.ts
 */
import assert from 'node:assert/strict'
import {
	IDENTITY_COLORS,
	colorKeyForId,
	hexForColor,
	isIdentityColor,
	type IdentityColor,
} from './colors'

// Exactly 10 colourful keys, no black/grey.
assert.equal(IDENTITY_COLORS.length, 10)
assert.ok(!IDENTITY_COLORS.includes('black' as IdentityColor))
assert.ok(!IDENTITY_COLORS.includes('grey' as IdentityColor))

// Deterministic: same id → same key, always a member of the palette.
const a = colorKeyForId('user-abc')
assert.equal(colorKeyForId('user-abc'), a)
assert.ok(IDENTITY_COLORS.includes(a))

// Different ids can differ (sanity: the hash spreads across the palette).
const spread = new Set(
	Array.from({ length: 200 }, (_, i) => colorKeyForId(`id-${i}`))
)
assert.ok(spread.size >= 5, `hash should spread across palette, got ${spread.size}`)

// isIdentityColor validates overrides.
assert.equal(isIdentityColor('blue'), true)
assert.equal(isIdentityColor('black'), false)
assert.equal(isIdentityColor('nonsense'), false)
assert.equal(isIdentityColor(null), false)
assert.equal(isIdentityColor(42), false)

// Every key resolves to a #rrggbb hex in both themes.
for (const key of IDENTITY_COLORS) {
	for (const isDark of [false, true]) {
		const hex = hexForColor(key, isDark)
		assert.match(hex, /^#[0-9a-f]{6}$/i, `${key} ${isDark ? 'dark' : 'light'} -> ${hex}`)
	}
}

// Spot-check known values against tldraw's default palette.
assert.equal(hexForColor('blue', false), '#4465e9')
assert.equal(hexForColor('blue', true), '#4f72fc')
assert.equal(hexForColor('red', false), '#e03131')

console.log('colors.test.ts: all tests passed')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx tsx src/colors.test.ts`
Expected: FAIL — `Cannot find module './colors'`.

- [ ] **Step 3: Write the module**

Create `client/src/colors.ts`:

```ts
/**
 * The per-user identity palette. A user's colour is one of tldraw's named
 * shape colours, so their sticky fill, their next-drawn shape, their cursor/
 * presence ring, and their screenshare border are all literally the same
 * colour. Kept pure (no localStorage / window / tldraw import) so it is
 * unit-testable under `npx tsx` — identity.ts adds the storage layer on top.
 */

// The "colourful" subset of tldraw's DefaultColorStyle values (black/grey are
// not identity-worthy). These strings ARE valid DefaultColorStyle values, so
// they can be passed straight to setStyleForNextShapes / note-shape colour.
export const IDENTITY_COLORS = [
	'blue',
	'light-blue',
	'green',
	'light-green',
	'violet',
	'light-violet',
	'orange',
	'yellow',
	'red',
	'light-red',
] as const

export type IdentityColor = (typeof IDENTITY_COLORS)[number]

// Solid hex per tldraw's default theme (light/dark). Baked as a constant rather
// than read from getDefaultColorTheme() so this module stays pure and testable
// under tsx (tldraw's entry isn't importable in node). Source: @tldraw/editor
// DefaultColorThemePalette. Re-sync if tldraw ever restyles its palette.
const IDENTITY_HEX: Record<IdentityColor, { light: string; dark: string }> = {
	blue: { light: '#4465e9', dark: '#4f72fc' },
	'light-blue': { light: '#4ba1f1', dark: '#4dabf7' },
	green: { light: '#099268', dark: '#099268' },
	'light-green': { light: '#4cb05e', dark: '#40c057' },
	violet: { light: '#ae3ec9', dark: '#ae3ec9' },
	'light-violet': { light: '#e085f4', dark: '#e599f7' },
	orange: { light: '#e16919', dark: '#f76707' },
	yellow: { light: '#f1ac4b', dark: '#ffc034' },
	red: { light: '#e03131', dark: '#e03131' },
	'light-red': { light: '#f87777', dark: '#ff8787' },
}

export function hexForColor(key: IdentityColor, isDark: boolean): string {
	return IDENTITY_HEX[key][isDark ? 'dark' : 'light']
}

function hashCode(s: string): number {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}

/** Deterministic default colour for a user id (stable across sessions). */
export function colorKeyForId(id: string): IdentityColor {
	return IDENTITY_COLORS[hashCode(id) % IDENTITY_COLORS.length]!
}

export function isIdentityColor(x: unknown): x is IdentityColor {
	return typeof x === 'string' && (IDENTITY_COLORS as readonly string[]).includes(x)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx tsx src/colors.test.ts`
Expected: PASS — prints `colors.test.ts: all tests passed`.

- [ ] **Step 5: Commit**

```bash
git add client/src/colors.ts client/src/colors.test.ts
git commit -m "feat(colors): pure identity-colour palette module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Identity uses a colour key + override; App feeds presence and next-shape default

**Files:**
- Modify: `client/src/identity.ts`
- Modify: `client/src/App.tsx`

**Interfaces:**
- Consumes: `IdentityColor`, `colorKeyForId`, `hexForColor`, `isIdentityColor` from `./colors` (Task 1).
- Produces:
  - `Identity` now has `colorKey: IdentityColor` (the `color: string` field is removed).
  - `setUserColor(key: IdentityColor): void` — persists the override.

- [ ] **Step 1: Rewrite `identity.ts` colour handling**

In `client/src/identity.ts`:

Replace the top-of-file constants/imports block. The file currently starts with the doc comment then:

```ts
const ID_KEY = 'ensembleworks.userId'
const NAME_KEY = 'ensembleworks.userName'

export interface Identity {
	id: string
	name: string
	color: string
}

const COLORS = ['#4f8fef', '#e0598b', '#39b27d', '#e8a33d', '#9d6ce8', '#d96c4a']

function hashCode(s: string): number {
	let h = 0
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
	return Math.abs(h)
}
```

Replace that entire block with:

```ts
import { colorKeyForId, isIdentityColor, type IdentityColor } from './colors'

const ID_KEY = 'ensembleworks.userId'
const NAME_KEY = 'ensembleworks.userName'
const COLOR_KEY = 'ensembleworks.userColor'

export interface Identity {
	id: string
	name: string
	// A tldraw palette colour name (see colors.ts). Override in localStorage if
	// the user picked one, else a stable hash of their id.
	colorKey: IdentityColor
}

/** The user's chosen colour, or the deterministic default for their id. */
function resolveColorKey(id: string): IdentityColor {
	const override = localStorage.getItem(COLOR_KEY)
	return isIdentityColor(override) ? override : colorKeyForId(id)
}

/** Persist a chosen colour so it survives reloads and wins over the hash. */
export function setUserColor(key: IdentityColor): void {
	localStorage.setItem(COLOR_KEY, key)
}
```

Then change the `return` inside `getIdentity()` from:

```ts
	return { id, name, color: COLORS[hashCode(id) % COLORS.length]! }
```

to:

```ts
	return { id, name, colorKey: resolveColorKey(id) }
```

(`peekIdentity` and `getRoomId` are unchanged.)

- [ ] **Step 2: Verify identity.ts compiles in isolation**

Run: `cd client && npx tsc --noEmit`
Expected: the ONLY errors are in `App.tsx` about `identity.color` no longer existing (fixed next step). If `identity.ts` itself errors, fix before continuing.

- [ ] **Step 3: Update `App.tsx` — imports**

In `client/src/App.tsx`, the tldraw import block currently is:

```ts
import {
	Editor,
	Tldraw,
	defaultBindingUtils,
	defaultShapeUtils,
	getUserPreferences,
	setUserPreferences,
} from 'tldraw'
```

Add `DefaultColorStyle`:

```ts
import {
	DefaultColorStyle,
	Editor,
	Tldraw,
	defaultBindingUtils,
	defaultShapeUtils,
	getUserPreferences,
	setUserPreferences,
} from 'tldraw'
```

And update the identity import line:

```ts
import { getIdentity, getRoomId } from './identity'
```

to:

```ts
import { hexForColor } from './colors'
import { getIdentity, getRoomId } from './identity'
```

- [ ] **Step 4: Update `App.tsx` — module-load presence**

Change the `setUserPreferences` call (currently `color: identity.color,`):

```ts
setUserPreferences({
	...getUserPreferences(),
	id: identity.id,
	name: identity.name,
	color: identity.color,
})
```

to (light hex is a fine pre-mount default; `onMount` re-applies with the real theme):

```ts
setUserPreferences({
	...getUserPreferences(),
	id: identity.id,
	name: identity.name,
	color: hexForColor(identity.colorKey, false),
})
```

- [ ] **Step 5: Update `App.tsx` — onMount presence + next-shape default**

In `handleMount`, the line:

```ts
			editor.user.updateUserPreferences({ name: identity.name, color: identity.color })
```

becomes (now theme-aware, and sets the user's colour as the default for shapes they create):

```ts
			const isDark = editor.user.getIsDarkMode()
			editor.user.updateUserPreferences({
				name: identity.name,
				color: hexForColor(identity.colorKey, isDark),
			})
			// New stickies/geo/draw/text the user creates start in their colour.
			// It's a default, not a lock — tldraw's style panel still overrides
			// per shape. Re-applied when they change colour (AvOverlay picker).
			editor.setStyleForNextShapes(DefaultColorStyle, identity.colorKey)
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS (no errors in any workspace).

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Manual smoke (optional but recommended)**

Start the dev stack, draw a sticky note — it should be filled in your identity colour (matching your cursor/roster dot) rather than tldraw's default.

- [ ] **Step 8: Commit**

```bash
git add client/src/identity.ts client/src/App.tsx
git commit -m "feat(identity): colour key + override; default creations to it

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Screenshare tile border in the sharer's colour

**Files:**
- Modify: `server/src/schema.ts`
- Modify: `client/src/screenshare/ScreenShareShapeUtil.tsx`
- Modify: `client/src/screenshare/share.ts`

**Interfaces:**
- Consumes: `editor.user.getColor()` (the presence hex set in Task 2) for the stamp.
- Produces: `ScreenShareShapeProps.ownerColor?: string` — an optional hex, rendered as the tile border, falling back to `wm.ruleStrong` when absent.

- [ ] **Step 1: Mirror the prop in the server schema**

In `server/src/schema.ts`, the `screenshareShapeProps` object ends with:

```ts
	// /uploads URL of the final frame, stamped by the sharer when the share
	// ends; optional so live shares and existing rooms need no migration.
	stillUrl: T.string.optional(),
}
```

Add `ownerColor` before the closing brace:

```ts
	// /uploads URL of the final frame, stamped by the sharer when the share
	// ends; optional so live shares and existing rooms need no migration.
	stillUrl: T.string.optional(),
	// Hex of the sharer's identity colour, stamped at creation so every viewer
	// sees the same owner-coloured border; optional so existing tiles need no
	// migration (border falls back to the neutral rule colour).
	ownerColor: T.string.optional(),
}
```

- [ ] **Step 2: Mirror the prop in the client shape util**

In `client/src/screenshare/ScreenShareShapeUtil.tsx`:

In the `ScreenShareShapeProps` interface, after `stillUrl?: string`:

```ts
	stillUrl?: string
	// Hex of the sharer's identity colour, stamped at creation (share.ts) so
	// every viewer's tile shows the same owner-coloured border. Optional: live
	// shares stamp it, existing rooms need no migration.
	ownerColor?: string
}
```

In the `static override props` object, after `stillUrl: T.string.optional(),`:

```ts
		stillUrl: T.string.optional(),
		ownerColor: T.string.optional(),
	}
```

(Leave `getDefaultProps` unchanged — like `stillUrl`, this optional prop is omitted there and defaults to `undefined`.)

- [ ] **Step 3: Draw the border from `ownerColor`**

In `ScreenShareComponent`, the destructure line:

```ts
	const { w, h, title, participantId, trackName, stillUrl } = shape.props
```

becomes:

```ts
	const { w, h, title, participantId, trackName, stillUrl, ownerColor } = shape.props
```

Then in the outer `HTMLContainer` style, change:

```ts
				border: `1px solid ${wm.ruleStrong}`,
```

to (a slightly thicker, owner-coloured accent; neutral fallback for legacy tiles):

```ts
				border: `2px solid ${ownerColor || wm.ruleStrong}`,
```

- [ ] **Step 4: Stamp the colour at creation**

In `client/src/screenshare/share.ts`, the `editor.createShape({...})` call has a `props` block ending with the `title:` field:

```ts
		props: {
			w,
			...sized,
			participantId: room.localParticipant.identity,
			trackName,
			title: shareTitle(
				room.localParticipant.name || room.localParticipant.identity,
				mediaTrack.label
			),
		},
```

Add `ownerColor` after `title`:

```ts
		props: {
			w,
			...sized,
			participantId: room.localParticipant.identity,
			trackName,
			title: shareTitle(
				room.localParticipant.name || room.localParticipant.identity,
				mediaTrack.label
			),
			// The sharer's identity colour (the same hex as their cursor/ring),
			// captured here so it's synced to every viewer's tile border.
			ownerColor: editor.user.getColor(),
		},
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS (client and server both compile with the new prop).

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Manual smoke (recommended)**

With the dev stack running and audio/video connected, start a screen share. The new tile's border should be your identity colour (2px), matching your cursor. Existing tiles created before this change keep the neutral border (fallback path).

- [ ] **Step 7: Commit**

```bash
git add server/src/schema.ts client/src/screenshare/ScreenShareShapeUtil.tsx client/src/screenshare/share.ts
git commit -m "feat(screenshare): border tile in the sharer's identity colour

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Colour-swatch picker on the local user's roster dot

**Files:**
- Modify: `client/src/av/AvOverlay.tsx`

**Interfaces:**
- Consumes: `IDENTITY_COLORS`, `hexForColor`, `type IdentityColor` from `../colors`; `setUserColor` from `../identity`; `useEditor`, `DefaultColorStyle` from `tldraw`.
- Produces: no new exports — behaviour only. Clicking the local user's roster dot opens a swatch popover; selecting a colour persists it and re-derives presence + next-shape default live.

- [ ] **Step 1: Add imports**

In `client/src/av/AvOverlay.tsx`, the identity import is currently:

```ts
import { getRoomId } from '../identity'
```

Change to:

```ts
import { getRoomId, setUserColor } from '../identity'
```

Add a colours import next to it:

```ts
import { IDENTITY_COLORS, hexForColor, type IdentityColor } from '../colors'
```

Ensure `DefaultColorStyle` is imported from `tldraw`. Find the existing `from 'tldraw'` import block in this file and add `DefaultColorStyle` to it (alphabetical order within the block). If `useEditor` is already imported there, leave it; `ParticipantRow` will call it.

- [ ] **Step 2: Restructure the roster dot into a picker (local user only)**

In `ParticipantRow`, the colour dot is currently a `<span>` nested INSIDE the disabled name `<button>` (a nested-interactive problem for the local row). Pull it out so the dot is a sibling of the name button, and make it a real button for the local user.

The current structure is:

```tsx
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 4,
				border: `1px solid ${wm.rule}`,
				borderRadius: 2,
				background: wm.panel,
				padding: 3,
			}}
		>
			<button
				type="button"
				disabled={participant.isLocal}
				onClick={() => props.onClick(participant.id)}
				title={participant.isLocal ? 'You' : `Find ${participant.name} on the canvas`}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					minWidth: 0,
					flex: 1,
					border: 0,
					background: 'transparent',
					color: wm.ink,
					padding: '2px 3px',
					fontFamily: wm.sans,
					fontSize: 12,
					cursor: participant.isLocal ? 'default' : 'pointer',
				}}
			>
				<span
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						background: participant.color,
						flex: '0 0 auto',
					}}
				/>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{participant.name}{participant.isLocal ? ' (you)' : ''}
				</span>
			</button>
```

Replace that whole block (the row `<div>` opening through the end of the name `</button>`) with the version below — it lifts the dot out as `<ColorDot>` and drops the dot `<span>` from inside the name button:

```tsx
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: 4,
				border: `1px solid ${wm.rule}`,
				borderRadius: 2,
				background: wm.panel,
				padding: 3,
			}}
		>
			<ColorDot color={participant.color} isLocal={participant.isLocal} />
			<button
				type="button"
				disabled={participant.isLocal}
				onClick={() => props.onClick(participant.id)}
				title={participant.isLocal ? 'You' : `Find ${participant.name} on the canvas`}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					minWidth: 0,
					flex: 1,
					border: 0,
					background: 'transparent',
					color: wm.ink,
					padding: '2px 3px',
					fontFamily: wm.sans,
					fontSize: 12,
					cursor: participant.isLocal ? 'default' : 'pointer',
				}}
			>
				<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
					{participant.name}{participant.isLocal ? ' (you)' : ''}
				</span>
			</button>
```

(The rest of `ParticipantRow` — the `LatencyPill`, `avControls`, kick button, and closing `</div>` — is unchanged.)

- [ ] **Step 3: Add the `ColorDot` component with the swatch popover**

Add this component to `client/src/av/AvOverlay.tsx`, immediately AFTER the `ParticipantRow` function's closing brace:

```tsx
// The roster colour dot. For remote users it's a static swatch. For the local
// user it's a button that opens a picker of the identity palette — one control
// that governs the user's whole colour identity (cursor, ring, roster dot, new
// stickies, next-drawn shapes, and future screenshare borders). Lives on the
// roster (not the faces rail) so it's reachable even with the camera off.
function ColorDot({ color, isLocal }: { color: string; isLocal: boolean }) {
	const editor = useEditor()
	const [open, setOpen] = useState(false)

	const dotStyle: React.CSSProperties = {
		width: 8,
		height: 8,
		borderRadius: '50%',
		background: color,
		flex: '0 0 auto',
	}

	if (!isLocal) return <span style={dotStyle} />

	const pick = (key: IdentityColor) => {
		setUserColor(key)
		const hex = hexForColor(key, editor.user.getIsDarkMode())
		editor.user.updateUserPreferences({ color: hex })
		editor.setStyleForNextShapes(DefaultColorStyle, key)
		setOpen(false)
	}

	return (
		<div style={{ position: 'relative', flex: '0 0 auto', display: 'flex' }}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				title="Change your colour"
				style={{
					...dotStyle,
					border: `1px solid ${wm.rule}`,
					padding: 0,
					cursor: 'pointer',
				}}
			/>
			{open && (
				<div
					style={{
						position: 'absolute',
						top: 14,
						left: 0,
						zIndex: 10,
						display: 'grid',
						gridTemplateColumns: 'repeat(5, 16px)',
						gap: 4,
						padding: 6,
						background: wm.panel,
						border: `1px solid ${wm.rule}`,
						borderRadius: 4,
						boxShadow: wm.shadowPaper,
					}}
				>
					{IDENTITY_COLORS.map((key) => {
						const hex = hexForColor(key, editor.user.getIsDarkMode())
						const selected = hex.toLowerCase() === color.toLowerCase()
						return (
							<button
								key={key}
								type="button"
								onClick={() => pick(key)}
								title={key}
								style={{
									width: 16,
									height: 16,
									borderRadius: '50%',
									background: hex,
									border: selected ? `2px solid ${wm.ink}` : `1px solid ${wm.rule}`,
									padding: 0,
									cursor: 'pointer',
								}}
							/>
						)
					})}
				</div>
			)}
		</div>
	)
}
```

Note: `useState`, `useEditor`, and `wm` are already imported/used in this file. Confirm `useState` is in the `react` import; if not, add it.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual smoke (recommended)**

With the dev stack running: open the roster, click your own colour dot — a 2×5 grid of swatches appears with your current colour ringed. Pick a different one:
- Your cursor, faces-rail ring (if camera on), and roster dot change immediately.
- Your next sticky uses the new colour; existing shapes keep theirs.
- Reload the page — the picked colour persists (stored under `ensembleworks.userColor`).

- [ ] **Step 6: Commit**

```bash
git add client/src/av/AvOverlay.tsx
git commit -m "feat(av): colour-swatch picker on the local roster dot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review notes (traceability to spec)

- **Spec §1 colour model** → Task 1 (`colors.ts`) + Task 2 (`identity.ts` override resolution, `setUserColor`).
- **Spec §2 native shapes default** → Task 2 Step 5 (`setStyleForNextShapes`). Note: the spec mentions optionally touching `demo.ts`/`seedSessionCanvas.ts`; those are explicitly left as-is (seed/system scaffolding, not "a user's" sticky) — no user-facing behaviour depends on them, so no task changes them.
- **Spec §3 screenshare border** → Task 3 (schema mirror + prop + border + stamp).
- **Spec §4 swatch picker + propagation** → Task 4. Picker anchored on the roster dot (refined from the faces rail per the reachability decision recorded in the spec).
- **Spec Testing** → Task 1 unit test; typecheck+build gates in Tasks 2–4; manual smoke steps in Tasks 2–4.
- **Types consistent across tasks:** `IdentityColor`, `colorKeyForId`, `hexForColor`, `isIdentityColor`, `setUserColor`, `ownerColor` are named identically wherever produced and consumed.
