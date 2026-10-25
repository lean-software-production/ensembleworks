# Terminal Fix-In-Place Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six observed problems with the canvas terminal (Shift+Enter newline, glyph-atlas tofu, view/edit jump, copy-mode trap, missing Nerd Font symbols, fractional-font artifacts) in the existing xterm.js stack.

**Architecture:** All client changes live in `client/src/terminal/` (pure helpers in new small files, wiring in `TerminalShapeUtil.tsx`); tmux behaviour changes live in the two identical copies of `tmux-ensembleworks.conf`. No server, protocol, or gateway changes. The four invariants in `docs/terminal-grid-sizing.md` are hard constraints throughout.

**Tech Stack:** TypeScript/React (client), xterm.js 6 + WebGL addon, tmux ≥3.4 conf, Bun for tests/typecheck, Playwright (scratch-dir install per `docs/headless-browser.md`) for probes.

**Spec:** `docs/superpowers/specs/2026-07-10-terminal-fixes-bundle-design.md`

**Task order is the spec's land order: 1 → 3 → 2 → 4 → 5 → 6.** Tasks 1–5 are independent; task 6 is investigation-grade and goes last.

## File structure

| File | Responsibility |
|---|---|
| `client/src/terminal/keys.ts` (create) | Pure key-event → PTY-input mapping (Shift/Alt+Enter → `ESC CR`) |
| `client/src/terminal/keys.test.ts` (create) | Dependency-free tests for the mapping |
| `client/src/terminal/webgl.ts` (create) | Pure per-machine WebGL opt-out predicate |
| `client/src/terminal/webgl.test.ts` (create) | Tests for the predicate against a fake Storage |
| `client/src/terminal/TerminalShapeUtil.tsx` (modify) | Wire keys + webgl helpers; atlas heal; constant border; padding |
| `client/src/terminal/grid.ts` (modify) | `TERMINAL_PAD.y` update in lockstep with the container CSS |
| `client/src/theme.ts` + `client/src/theme.css` (modify) | Nerd Font fallback in the mono stack (both copies of the token) |
| `client/public/fonts/SymbolsNerdFontMono-Regular.ttf` (create) | Self-hosted symbols-only fallback font |
| `deploy/tmux-ensembleworks.conf` + `deploy/features/ensembleworks-cli/tmux-ensembleworks.conf` (modify) | Drop M-Enter splits; Escape exits copy-mode. **The two files are identical copies — every edit goes to both.** |
| `client/e2e/terminal-editpad-probe.mjs` (create) | Headless check: edit-toggle pixel stability |
| `client/e2e/terminal-zoom-probe.mjs` (create) | Investigation probe: seams + selection at fractional zooms |

### Task 0: Feature branch

- [ ] **Step 1: Create the branch**

```bash
cd /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb
git checkout main && git pull && git checkout -b fix/terminal-bundle
```

---

### Task 1: Shift+Enter / Alt+Enter newline in claude code

**Files:**
- Create: `client/src/terminal/keys.ts`
- Test: `client/src/terminal/keys.test.ts`
- Modify: `client/src/terminal/TerminalShapeUtil.tsx` (the `attachCustomKeyEventHandler` block, ~line 415)
- Modify: `deploy/tmux-ensembleworks.conf` AND `deploy/features/ensembleworks-cli/tmux-ensembleworks.conf` (the "Pane Controls" block)

**Why:** xterm.js encodes Shift+Enter identically to Enter, so claude code submits instead of inserting a newline. Separately, the tmux conf binds `M-Enter`/`M-S-Enter` to pane splits in the root table, so Alt+Enter never reaches claude at all. `extended-keys` is already configured server-side; no server work.

- [ ] **Step 1: Write the failing test**

Create `client/src/terminal/keys.test.ts`:

```ts
// Run with: bun src/terminal/keys.test.ts   (from client/)
import assert from 'node:assert/strict'
import { NEWLINE_INPUT, ptyInputForKey } from './keys'

const ev = (over: Partial<Parameters<typeof ptyInputForKey>[0]> = {}) => ({
	type: 'keydown',
	key: 'Enter',
	shiftKey: false,
	ctrlKey: false,
	altKey: false,
	metaKey: false,
	...over,
})

// Shift+Enter → ESC CR (the byte pair claude code treats as "insert newline").
assert.equal(ptyInputForKey(ev({ shiftKey: true })), NEWLINE_INPUT)

// Alt+Enter too — xterm's own alt handling differs by platform (macOS Option
// composes characters), so we normalise it ourselves.
assert.equal(ptyInputForKey(ev({ altKey: true })), NEWLINE_INPUT)

// Plain Enter stays Enter (submit).
assert.equal(ptyInputForKey(ev()), null)

// Ctrl/Cmd+Enter are not ours to rewrite.
assert.equal(ptyInputForKey(ev({ ctrlKey: true, shiftKey: true })), null)
assert.equal(ptyInputForKey(ev({ metaKey: true, shiftKey: true })), null)

// Only keydown fires input; keyup/keypress pass through.
assert.equal(ptyInputForKey(ev({ type: 'keyup', shiftKey: true })), null)

// Non-Enter keys pass through untouched.
assert.equal(ptyInputForKey(ev({ key: 'a', shiftKey: true })), null)

console.log('keys.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && bun src/terminal/keys.test.ts
```

Expected: FAIL — `Cannot find module './keys'`.

- [ ] **Step 3: Write the implementation**

Create `client/src/terminal/keys.ts`:

```ts
/**
 * Pure key-event → PTY-input mapping for the canvas terminal.
 *
 * Shift+Enter must insert a newline in TUIs (claude code) rather than submit,
 * but xterm.js encodes Shift+Enter identically to Enter (`\r`), so the app
 * inside can't tell them apart. We translate Shift+Enter (and Alt+Enter,
 * whose xterm encoding is platform-dependent) to ESC CR — the byte pair
 * Alt+Enter produces in native terminals — which claude code already treats
 * as "insert newline". Pure and dependency-free so it tests under plain bun.
 */

export interface EnterKeyEvent {
	type: string
	key: string
	shiftKey: boolean
	ctrlKey: boolean
	altKey: boolean
	metaKey: boolean
}

// ESC CR — what Alt+Enter sends in a native terminal.
export const NEWLINE_INPUT = '\x1b\r'

/**
 * The PTY input that should replace this key event, or null to let xterm
 * handle the key normally.
 */
export function ptyInputForKey(e: EnterKeyEvent): string | null {
	if (e.type !== 'keydown' || e.key !== 'Enter') return null
	if (e.ctrlKey || e.metaKey) return null
	return e.shiftKey || e.altKey ? NEWLINE_INPUT : null
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && bun src/terminal/keys.test.ts
```

Expected: `keys.test.ts: all assertions passed`

- [ ] **Step 5: Wire into the key handler**

In `client/src/terminal/TerminalShapeUtil.tsx`:

Add to the imports from `./grid`'s neighbourhood:

```ts
import { ptyInputForKey } from './keys'
```

In `term.attachCustomKeyEventHandler((e) => { ... })`, insert this as the FIRST block inside the handler (before the existing `if (e.type === 'keydown' && (e.ctrlKey || e.metaKey))`):

```ts
			// Shift/Alt+Enter → newline (ESC CR) instead of submit — see ./keys.
			// preventDefault + return false so xterm doesn't also send \r.
			const ptyInput = ptyInputForKey(e)
			if (ptyInput) {
				e.preventDefault()
				const ws = wsRef.current
				if (ws?.readyState === WebSocket.OPEN) {
					const msg: TermClientMessage = { type: 'input', data: ptyInput }
					ws.send(JSON.stringify(msg))
				}
				return false
			}
```

- [ ] **Step 6: Typecheck**

```bash
cd client && bunx tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 7: Remove the tmux M-Enter split bindings (BOTH conf copies)**

In `deploy/tmux-ensembleworks.conf` AND `deploy/features/ensembleworks-cli/tmux-ensembleworks.conf`, replace:

```
# Pane Controls
bind -n M-Enter split-window -v -c "#{pane_current_path}"
bind -n M-S-Enter split-window -h -c "#{pane_current_path}"
bind -n M-Escape kill-pane
```

with:

```
# Pane Controls
# ENSEMBLEWORKS: no root-table M-Enter/M-S-Enter splits (Omarchy has them).
# Alt+Enter must reach the app inside — claude code treats ESC CR as
# "insert newline" — and the canvas client sends exactly that for
# Shift+Enter. Splits stay available on prefix h / v.
bind -n M-Escape kill-pane
```

- [ ] **Step 8: Verify the bindings are gone (scripted tmux check)**

```bash
tmux -L ewplantest -f deploy/tmux-ensembleworks.conf new-session -d -x 80 -y 24 sleep 30
tmux -L ewplantest list-keys | grep -c 'M-Enter' || echo 'M-Enter gone'
tmux -L ewplantest kill-server
diff deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf && echo 'confs identical'
```

Expected: `M-Enter gone` (grep matches 0 lines) and `confs identical`.

- [ ] **Step 9: Commit**

```bash
git add client/src/terminal/keys.ts client/src/terminal/keys.test.ts client/src/terminal/TerminalShapeUtil.tsx deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf
git commit -m "fix(terminal): Shift+Enter and Alt+Enter insert newline in TUIs

Shift+Enter was indistinguishable from Enter (xterm.js encoding), and tmux
stole Alt+Enter for a root-table pane split. Send ESC CR from the client
for Shift/Alt+Enter and drop the M-Enter split bindings (prefix h/v remain)."
```

- [ ] **Step 10: Live acceptance (requires dev stack)**

```bash
bin/dev up   # from the host, if not already running
```

In a browser at the dev canvas: create a terminal, run `claude`, and verify: Shift+Enter inserts a newline in the prompt; Alt+Enter inserts a newline; plain Enter submits. Record the result in the PR description. (If claude is not installed in the container, `cat -v` shows Shift+Enter arriving as `^[^M`.)

---

### Task 2: View/edit content jump + edge clipping

*(Spec item 3 — second in land order.)*

**Files:**
- Modify: `client/src/terminal/TerminalShapeUtil.tsx` (the terminal box `border`/`boxShadow` styles ~line 628, the container `padding` ~line 646)
- Modify: `client/src/terminal/grid.ts` (`TERMINAL_PAD`)
- Create: `client/e2e/terminal-editpad-probe.mjs`

**Why:** The border switches 1px ↔ 2px with edit state, shrinking the content box 2px per axis — the visible jump. Bottom padding of 0 clips descenders in the last row. `TERMINAL_PAD` and the container CSS are one fact recorded twice and must change together.

- [ ] **Step 1: Constant border, ring via box-shadow**

In `TerminalShapeUtil.tsx`, in the terminal box `<div>` style (the one with `borderRadius: 4`), replace:

```ts
					// Thin dark line to match the canvas frames' 1px stroke (was the
					// fainter ruleStrong); seal-blue only while editing for selection.
					border: isEditing ? `2px solid ${wm.sealBlue}` : `1px solid ${wm.ink}`,
					boxShadow: wm.shadowPaper,
```

with:

```ts
					// Constant 1px border in BOTH modes: a border-width change would
					// shrink the content box and visibly shift the terminal text on
					// every edit toggle. The editing highlight is an outer box-shadow
					// ring instead — zero layout impact.
					border: `1px solid ${isEditing ? wm.sealBlue : wm.ink}`,
					boxShadow: isEditing ? `0 0 0 1.5px ${wm.sealBlue}, ${wm.shadowPaper}` : wm.shadowPaper,
```

- [ ] **Step 2: Bottom padding for last-row descenders, grid constant in lockstep**

In `TerminalShapeUtil.tsx`, in the `containerRef` div style, replace:

```ts
					padding: '10px 20px 0 12px',
```

with:

```ts
					padding: '10px 20px 4px 12px',
```

In `client/src/terminal/grid.ts`, replace:

```ts
// Padding baked into the terminal box: the container style is "10px 20px 0 12px"
// (top right bottom left), and with scrollback:0 xterm reserves no scrollbar.
export const TERMINAL_PAD = { x: 12 + 20, y: 10 + 0 }
```

with:

```ts
// Padding baked into the terminal box: the container style is "10px 20px 4px 12px"
// (top right bottom left; the 4px bottom keeps last-row descenders unclipped),
// and with scrollback:0 xterm reserves no scrollbar. KEEP IN SYNC with the
// containerRef padding in TerminalShapeUtil.tsx — one fact, recorded twice.
export const TERMINAL_PAD = { x: 12 + 20, y: 10 + 4 }
```

- [ ] **Step 3: Run the grid tests and typecheck**

```bash
cd client && bun src/terminal/grid.test.ts && bunx tsc --noEmit
```

Expected: `grid.test.ts: all assertions passed` (tests use `TERMINAL_PAD` symbolically) and clean typecheck.

- [ ] **Step 4: Write the headless edit-toggle probe**

Create `client/e2e/terminal-editpad-probe.mjs` (follows `docs/headless-browser.md`; run from a scratch dir with playwright installed):

```js
// Probe: toggling a terminal's edit mode must not shift its rendered content.
//
// Prereq: dev stack up (bin/dev up), a room with at least one terminal shape
// in view. Run from a directory with playwright installed
// (docs/headless-browser.md):
//   node <repo>/client/e2e/terminal-editpad-probe.mjs 'http://localhost:5173/?room=probe'
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.cwd() + '/')('playwright')

const url = process.argv[2] ?? 'http://localhost:5173/?room=probe'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
// The name prompt is a blocking window.prompt() — answer before navigating.
page.on('dialog', (d) => d.accept('probe-bot').catch(() => {}))
await page.goto(url, { waitUntil: 'domcontentloaded' })

// .xterm-screen is xterm's rendered grid — the thing that must not move.
const screen = page.locator('.xterm-screen').first()
await screen.waitFor({ timeout: 15000 })
const before = await screen.boundingBox()

// Double-click enters editing; Esc Esc leaves it.
await screen.dblclick()
await page.waitForTimeout(300)
const during = await screen.boundingBox()
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const after = await screen.boundingBox()

const shift = (a, b) =>
	Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height))
console.log({ before, during, after, editShift: shift(before, during), roundTrip: shift(before, after) })
if (shift(before, during) > 0.5 || shift(before, after) > 0.5) {
	console.error('FAIL: terminal content moved on edit toggle')
	process.exit(1)
}
console.log('PASS: edit toggle is pixel-stable')
await browser.close()
```

- [ ] **Step 5: Run the probe**

```bash
bin/dev up   # if not running; then create one terminal in room "probe" via the browser
cd /tmp/canvas-probe   # scratch dir with playwright (docs/headless-browser.md "Setup")
node /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb/client/e2e/terminal-editpad-probe.mjs 'http://localhost:5173/?room=probe'
```

Expected: `PASS: edit toggle is pixel-stable`. Also eyeball a full-height TUI (`htop` or `claude`) for complete glyphs in the last row/column in both modes.

- [ ] **Step 6: Commit**

```bash
git add client/src/terminal/TerminalShapeUtil.tsx client/src/terminal/grid.ts client/e2e/terminal-editpad-probe.mjs
git commit -m "fix(terminal): pixel-stable edit toggle, unclipped last row

Border width no longer changes with edit state (highlight is an outer
box-shadow ring), and the container gains 4px bottom padding — with
TERMINAL_PAD updated in lockstep — so last-row descenders render.
Existing terminals re-grid once on deploy (single authoritative resize)."
```

---

### Task 3: Glyph-atlas ("tofu") corruption — auto-heal + WebGL opt-out

*(Spec item 2 — third in land order.)*

**Files:**
- Create: `client/src/terminal/webgl.ts`
- Test: `client/src/terminal/webgl.test.ts`
- Modify: `client/src/terminal/TerminalShapeUtil.tsx` (WebGL addon load ~line 271, `reconnectWhenVisible` ~line 367, editing-focus effect ~line 478)

**Why:** The WebGL glyph atlas silently corrupts on one Linux/Wayland machine (no context-loss event fires, so the existing fallback never triggers). Auto-heal via `clearTextureAtlas()` on visibility/edit, plus a per-machine opt-out flag.

- [ ] **Step 1: Write the failing test**

Create `client/src/terminal/webgl.test.ts`:

```ts
// Run with: bun src/terminal/webgl.test.ts   (from client/)
import assert from 'node:assert/strict'
import { WEBGL_PREF_KEY, webglEnabled } from './webgl'

const store = (val: string | null): Pick<Storage, 'getItem'> => ({
	getItem: (k: string) => (k === WEBGL_PREF_KEY ? val : null),
})

// Default: no key set → WebGL on.
assert.equal(webglEnabled(store(null)), true)

// Explicit opt-out for machines with silent atlas corruption.
assert.equal(webglEnabled(store('off')), false)

// Any other value → on (typos fail safe: WebGL is the default experience).
assert.equal(webglEnabled(store('on')), true)
assert.equal(webglEnabled(store('')), true)

// A throwing store (privacy mode) → on.
assert.equal(
	webglEnabled({
		getItem: () => {
			throw new Error('denied')
		},
	}),
	true
)

console.log('webgl.test.ts: all assertions passed')
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && bun src/terminal/webgl.test.ts
```

Expected: FAIL — `Cannot find module './webgl'`.

- [ ] **Step 3: Write the implementation**

Create `client/src/terminal/webgl.ts`:

```ts
/**
 * Per-machine opt-out for the terminal's WebGL renderer.
 *
 * On at least one Linux/Wayland + Mesa machine the WebGL glyph atlas corrupts
 * silently mid-session (characters render as boxes) WITHOUT a context-loss
 * event, so the addon's own fallback never fires. Machines that exhibit this
 * set localStorage['ensembleworks:webgl'] = 'off' to skip the addon entirely
 * and stay on the DOM renderer. Anything else — unset, other values, or a
 * storage that throws (privacy mode) — leaves WebGL on: it is the default
 * experience, and the flag is a targeted escape hatch, not a setting.
 */

export const WEBGL_PREF_KEY = 'ensembleworks:webgl'

export function webglEnabled(store: Pick<Storage, 'getItem'>): boolean {
	try {
		return store.getItem(WEBGL_PREF_KEY) !== 'off'
	} catch {
		return true
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && bun src/terminal/webgl.test.ts
```

Expected: `webgl.test.ts: all assertions passed`

- [ ] **Step 5: Wire opt-out + auto-heal into TerminalShapeUtil**

In `client/src/terminal/TerminalShapeUtil.tsx`:

Add import:

```ts
import { webglEnabled } from './webgl'
```

Replace the WebGL addon block (`const webgl = new WebglAddon()` through `term.loadAddon(webgl)`) with:

```ts
		// Hardware-accelerated renderer: draws every row into one GL bitmap, which
		// removes the DOM renderer's per-row sub-pixel seams and is cheaper to paint
		// while the tldraw camera pans/zooms. Must load AFTER term.open(). Browsers
		// cap concurrent WebGL contexts (~16 in Chrome); if ours is dropped (many
		// terminals open at once) we dispose the addon so this terminal falls back to
		// the DOM renderer instead of freezing on a stale frame. Machines whose
		// driver corrupts the atlas *silently* (no loss event) opt out via
		// localStorage — see ./webgl.
		if (webglEnabled(localStorage)) {
			const webgl = new WebglAddon()
			webgl.onContextLoss(() => {
				// Degraded but functional: surface it so a silently DOM-rendered
				// terminal isn't invisible to anyone watching the console.
				console.warn('[terminal] WebGL context lost — falling back to DOM renderer')
				webgl.dispose()
			})
			term.loadAddon(webgl)
		}
```

Replace `reconnectWhenVisible`:

```ts
		const reconnectWhenVisible = () => {
			if (document.visibilityState !== 'visible') return
			// Returning to the tab is the cheap moment to discard a possibly-rotten
			// WebGL glyph atlas (silent corruption never fires onContextLoss) —
			// clearTextureAtlas re-rasterises every glyph on the next frame.
			try {
				term.clearTextureAtlas()
			} catch {
				/* renderer variance — a repaint miss is not worth crashing over */
			}
			reconnectNow()
		}
```

In the editing-focus effect (`useEffect(() => { if (isEditing) termRef.current?.focus() ... }, [isEditing])`), replace with:

```ts
	// Editing state drives keyboard focus. Entering edit also heals a possibly
	// corrupted WebGL glyph atlas — the user's "click the terminal" replaces
	// "refresh the page" when tofu appears (see ./webgl for the failure mode).
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		if (isEditing) {
			try {
				term.clearTextureAtlas()
			} catch {
				/* renderer variance */
			}
			term.focus()
		} else {
			term.blur()
		}
	}, [isEditing])
```

- [ ] **Step 6: Typecheck + run all terminal unit tests**

```bash
cd client && bunx tsc --noEmit && bun src/terminal/keys.test.ts && bun src/terminal/webgl.test.ts && bun src/terminal/grid.test.ts && bun src/terminal/wsUrl.test.ts
```

Expected: all pass, clean typecheck.

- [ ] **Step 7: Flag acceptance check (headless or manual)**

With the dev stack up, in the browser devtools console on the canvas page:

```js
localStorage.setItem('ensembleworks:webgl', 'off'); location.reload()
```

Verify the terminal still renders and types (DOM renderer — no `<canvas>` inside `.xterm-screen`, rows are DOM elements). Then:

```js
localStorage.removeItem('ensembleworks:webgl'); location.reload()
```

Verify the WebGL canvas is back. The atlas auto-heal itself is verified opportunistically on the affected Wayland machine (corruption is not reproducible on demand) — note this in the PR.

- [ ] **Step 8: Commit**

```bash
git add client/src/terminal/webgl.ts client/src/terminal/webgl.test.ts client/src/terminal/TerminalShapeUtil.tsx
git commit -m "fix(terminal): heal WebGL glyph-atlas corruption, add opt-out

Silent atlas corruption (Linux/Wayland + Mesa; no context-loss event)
turned characters into boxes until a page refresh. Clear the texture
atlas on tab-return and on entering edit mode, and honour
localStorage ensembleworks:webgl=off to skip the WebGL addon entirely
on machines that exhibit it."
```

---

### Task 4: tmux copy-mode escape hatch

*(Spec item 4.)*

**Files:**
- Modify: `deploy/tmux-ensembleworks.conf` AND `deploy/features/ensembleworks-cli/tmux-ensembleworks.conf` (the "Vi mode for copy" block)

**Why:** Scroll-wheel drops viewers into copy-mode (that *is* the scrollback mechanism and stays); the fix is the "can't get out" half — Escape must cancel.

- [ ] **Step 1: Add the binding (BOTH conf copies)**

In both conf files, in the "Vi mode for copy" block, after `bind -T copy-mode-vi y send -X copy-selection-and-cancel`, add:

```
# ENSEMBLEWORKS: Escape leaves copy-mode. Canvas users land in copy-mode by
# scroll-wheel (mouse on) and read the frozen output as a hang — the
# universal panic key must get them out. (Scrolling back to the bottom
# still auto-exits, and q still cancels; this adds the key people try.)
bind -T copy-mode-vi Escape send -X cancel
```

- [ ] **Step 2: Verify with scripted tmux**

```bash
tmux -L ewplantest -f deploy/tmux-ensembleworks.conf new-session -d -x 80 -y 24 sleep 30
tmux -L ewplantest list-keys -T copy-mode-vi | grep Escape
tmux -L ewplantest kill-server
diff deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf && echo 'confs identical'
```

Expected: a line `bind-key -T copy-mode-vi Escape send-keys -X cancel`, then `confs identical`.

- [ ] **Step 3: Manual interaction check**

In a dev-canvas terminal: scroll up (enters copy-mode, status shows `COPY`), press Escape once → copy-mode exits; then Esc Esc still exits editing back to the canvas. Note in PR.

- [ ] **Step 4: Commit**

```bash
git add deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf
git commit -m "fix(terminal): Escape exits tmux copy-mode

Scroll-wheel puts canvas viewers in copy-mode; without an Escape
binding they read the frozen output as a hang. q and scroll-to-bottom
still work; Escape is the key people actually try."
```

---

### Task 5: Nerd Font symbol coverage

*(Spec item 5.)*

**Files:**
- Create: `client/public/fonts/SymbolsNerdFontMono-Regular.ttf` (downloaded release artifact)
- Modify: `client/src/theme.css` (`@font-face` + `--wm-mono`)
- Modify: `client/src/theme.ts` (`wm.mono`)

**Why:** Google-Fonts JetBrains Mono is not Nerd-Font-patched, so powerline/devicon symbols render as tofu. A symbols-only fallback supplies exactly the missing glyphs; primary font metrics — and therefore the measured cell and the deterministic grid — are untouched.

- [ ] **Step 1: Download the symbols-only font**

```bash
cd /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb
mkdir -p client/public/fonts
curl -fL -o /tmp/claude-1000/-home-mrdavidlaing-Work-lean-software-production-ensembleworks-ghosttyweb/67d72bbb-f0ee-4d5c-8ca4-af8a8334292a/scratchpad/NerdFontsSymbolsOnly.zip \
  https://github.com/ryanoasis/nerd-fonts/releases/latest/download/NerdFontsSymbolsOnly.zip
unzip -o -d client/public/fonts \
  /tmp/claude-1000/-home-mrdavidlaing-Work-lean-software-production-ensembleworks-ghosttyweb/67d72bbb-f0ee-4d5c-8ca4-af8a8334292a/scratchpad/NerdFontsSymbolsOnly.zip \
  SymbolsNerdFontMono-Regular.ttf
ls -la client/public/fonts/
```

Expected: `SymbolsNerdFontMono-Regular.ttf` (~2–3 MB). Licence is SIL OFL — AGPL-compatible; the release zip's `LICENSE` need not be vendored, but note the origin in the @font-face comment.

- [ ] **Step 2: Declare the @font-face**

In `client/src/theme.css`, after the `:root` block, add:

```css
/* Symbols-only Nerd Font fallback for terminal glyphs (powerline, devicons —
   ryanoasis/nerd-fonts NerdFontsSymbolsOnly release, SIL OFL). Listed AFTER
   JetBrains Mono in --wm-mono so the primary font's metrics — and therefore
   the terminal's measured cell and deterministic grid — are untouched.
   unicode-range limits the download to sessions that actually hit the
   private-use symbol codepoints. */
@font-face {
	font-family: 'Symbols Nerd Font Mono';
	src: url('/fonts/SymbolsNerdFontMono-Regular.ttf') format('truetype');
	font-display: swap;
	unicode-range: U+E000-F8FF, U+F0000-FFFFD;
}
```

And update the `--wm-mono` token in `:root`:

```css
	--wm-mono: 'JetBrains Mono', 'Symbols Nerd Font Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

- [ ] **Step 3: Update the TS copy of the token**

In `client/src/theme.ts` (~line 40), replace:

```ts
	mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
```

with:

```ts
	// Keep in sync with --wm-mono in theme.css. Symbols Nerd Font Mono is the
	// self-hosted symbols-only fallback (PUA glyphs); JetBrains Mono stays
	// primary so the terminal's measured cell is unchanged.
	mono: '"JetBrains Mono", "Symbols Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
```

- [ ] **Step 4: Typecheck + build (the build serves public/ verbatim)**

```bash
cd client && bunx tsc --noEmit && cd .. && bun run build
```

Expected: clean; the built output contains `fonts/SymbolsNerdFontMono-Regular.ttf`.

- [ ] **Step 5: Visual acceptance**

In a dev-canvas terminal:

```bash
printf 'powerline: \xee\x82\xb0  git: \xef\x82\x9b  folder: \xef\x81\xbb\n'   # U+E0B0, U+F09B, U+F07B
```

Expected: three symbols render (not tofu boxes). Confirm the terminal grid did not change (same cols/rows before/after — the status bar width is a quick proxy).

- [ ] **Step 6: Commit**

```bash
git add client/public/fonts/SymbolsNerdFontMono-Regular.ttf client/src/theme.css client/src/theme.ts
git commit -m "fix(terminal): self-hosted Nerd Font symbols fallback

Google-Fonts JetBrains Mono is unpatched, so powerline/devicon glyphs
rendered as tofu. Add Symbols Nerd Font Mono (OFL, symbols-only,
unicode-range-limited) after JetBrains Mono in the mono stack — primary
metrics and the deterministic terminal grid are untouched."
```

---

### Task 6: Fractional-font-size artifacts — bounded investigation

*(Spec item 6 — investigation-grade; may end in a written finding instead of a code change.)*

**Files:**
- Create: `client/e2e/terminal-zoom-probe.mjs`
- Possibly modify: `client/src/terminal/TerminalShapeUtil.tsx` (the `editZoom` font effect ~line 494 and host counter-scale ~line 657) — ONLY if the probe confirms the hypothesis and the fix preserves all four `docs/terminal-grid-sizing.md` invariants.

**Why:** `fontSize = 16 × zoom` is fractional at most zooms — prime suspect for box-drawing seams and off-by-one drag-selection. Hard constraint: the grid stays a pure function of shared state + quantised base cell; nothing proposed from live pixels; zoom stays orthogonal to grid; gateway dedup preserved. **If a candidate fix threatens an invariant, stop and write findings instead.**

- [ ] **Step 1: Write the probe**

Create `client/e2e/terminal-zoom-probe.mjs`:

```js
// Probe: box-drawing seams and selection accuracy at fractional zooms.
//
// Prereq: dev stack up, room "probe" with one terminal in view, and inside it
// a box-drawing TUI (run:  printf '┌%.0s' 1; for i in $(seq 40); do printf '─'; done; echo
// or simply run `claude` / `htop` for a full-frame TUI).
// Run from a directory with playwright installed (docs/headless-browser.md):
//   node <repo>/client/e2e/terminal-zoom-probe.mjs 'http://localhost:5173/?room=probe'
import { createRequire } from 'node:module'
const { chromium } = createRequire(process.cwd() + '/')('playwright')

const url = process.argv[2] ?? 'http://localhost:5173/?room=probe'
const ZOOMS = [0.75, 1.1, 1.33]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('dialog', (d) => d.accept('probe-bot').catch(() => {}))
await page.goto(url, { waitUntil: 'domcontentloaded' })
const screen = page.locator('.xterm-screen').first()
await screen.waitFor({ timeout: 15000 })
await screen.dblclick() // enter editing so editZoom tracks the camera

for (const z of ZOOMS) {
	// Set the camera zoom directly through tldraw's editor (exposed for probes
	// via window in dev builds; fall back to Ctrl+wheel if not available).
	const ok = await page.evaluate((zoom) => {
		const ed = window.editor ?? window.app?.editor
		if (!ed) return false
		ed.setCamera({ ...ed.getCamera(), z: zoom })
		return true
	}, z)
	if (!ok) console.warn('window.editor not exposed — set zoom manually and re-run per-zoom')
	await page.waitForTimeout(400)
	await page.screenshot({ path: `zoom-${z}.png`, clip: (await screen.boundingBox()) ?? undefined })

	// Selection accuracy: shift+drag across one row, compare xterm's selection
	// row count (1 expected) — a fractional-cell mismatch selects 2 rows.
	const box = await screen.boundingBox()
	const y = box.y + box.height / 2
	await page.keyboard.down('Shift')
	await page.mouse.move(box.x + 8, y)
	await page.mouse.down()
	await page.mouse.move(box.x + box.width / 2, y, { steps: 8 })
	await page.mouse.up()
	await page.keyboard.up('Shift')
	const sel = await page.evaluate(() => window.getSelection?.()?.toString() ?? '')
	console.log(`zoom ${z}: selection rows = ${sel.split('\n').filter(Boolean).length} (want 1), screenshot zoom-${z}.png`)
}
await browser.close()
```

- [ ] **Step 2: Run the probe, inspect screenshots for seams, record findings**

```bash
cd /tmp/canvas-probe
node /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb/client/e2e/terminal-zoom-probe.mjs 'http://localhost:5173/?room=probe'
```

Record per zoom: seams visible in `zoom-<z>.png`? selection rows = 1? If neither symptom reproduces, **write the findings into the spec's item 6 section (a short "not reproduced under headless Chromium; suspect closed or environment-specific" note), commit, and end the task here.**

- [ ] **Step 3 (conditional): Apply the integer-font-size candidate fix**

Only if step 2 confirmed artifacts. In `TerminalShapeUtil.tsx`, the candidate preserves "net on-screen scale = 1" while giving xterm an integer px font: replace the font effect —

```ts
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		const nextFont = BASE_FONT * editZoom
		if (term.options.fontSize !== nextFont) term.options.fontSize = nextFont
	}, [editZoom])
```

with:

```ts
	// Rendered font is the zoom-scaled base ROUNDED TO WHOLE PIXELS: fractional
	// font sizes make xterm's cell metrics fractional, which is what produced
	// box-drawing seams and off-by-one drag selection. The host counter-scale
	// below uses the same effective factor, so the net on-screen scale stays
	// exactly 1 and mouse→cell math stays exact. Grid unaffected: captureCell
	// normalises by (fontSize / BASE_FONT), which remains the true factor.
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		const nextFont = Math.max(6, Math.round(BASE_FONT * editZoom))
		if (term.options.fontSize !== nextFont) term.options.fontSize = nextFont
	}, [editZoom])
```

And the host div style — replace:

```ts
					style={{
						width: `calc(100% * ${editZoom})`,
						height: `calc(100% * ${editZoom})`,
						transform: `scale(${1 / editZoom})`,
						transformOrigin: 'top left',
					}}
```

with (add `fontFactor` right before the `return`, next to the existing `const { w, h } = shape.props`):

```ts
	// The counter-scale must invert the FONT's actual factor, not the raw zoom:
	// the rendered font is rounded to whole px (see the font effect), so we
	// scale the host by the same effective factor to keep net scale exactly 1.
	const fontFactor = Math.max(6, Math.round(BASE_FONT * editZoom)) / BASE_FONT
```

```ts
					style={{
						width: `calc(100% * ${fontFactor})`,
						height: `calc(100% * ${fontFactor})`,
						transform: `scale(${1 / fontFactor})`,
						transformOrigin: 'top left',
					}}
```

**Invariant check before proceeding:** grid unaffected (captureCell already normalises by `fontSize / BASE_FONT`); nothing new is measured-then-proposed; zoom stays orthogonal (only rendered px changed); gateway untouched. All four hold — this is why the candidate is admissible.

- [ ] **Step 4 (conditional): Re-run probe + full test sweep**

```bash
cd /tmp/canvas-probe && node /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb/client/e2e/terminal-zoom-probe.mjs 'http://localhost:5173/?room=probe'
cd /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb/client
bunx tsc --noEmit && bun src/terminal/grid.test.ts && bun src/terminal/keys.test.ts && bun src/terminal/webgl.test.ts && bun src/terminal/wsUrl.test.ts
```

Expected: seams gone / selection rows = 1 at all three zooms; all tests pass. Also manually verify no shrink-then-snap on activating a terminal at zoom ≠ 1 (the header comment on the font effect explains the historical bug — the transform and font must change in the same render).

- [ ] **Step 5: Commit (fix or findings)**

```bash
git add -A client/e2e/terminal-zoom-probe.mjs client/src/terminal/TerminalShapeUtil.tsx
git commit -m "fix(terminal): integer px font at zoom — kills seams and selection drift"
# — or, if not reproduced / invariant threatened —
git add client/e2e/terminal-zoom-probe.mjs docs/superpowers/specs/2026-07-10-terminal-fixes-bundle-design.md
git commit -m "docs(terminal): zoom-artifact probe findings (item 6 investigation)"
```

---

### Task 7: Final verification & branch finish

- [ ] **Step 1: Full sweep**

```bash
cd /home/mrdavidlaing/Work/lean-software-production/ensembleworks-ghosttyweb
bun run typecheck && bun run build && bun run test
```

Expected: all clean. Also re-run the two probes if the dev stack is up.

- [ ] **Step 2: Finish the branch**

Use the superpowers:finishing-a-development-branch skill — PR to `main` with the per-item acceptance evidence (claude-code Shift+Enter check, probe outputs, tmux list-keys output, glyph screenshot) in the description.

---

# Addendum tasks (2026-07-11) — spec items 7–10 folded in

### Task 8: Hybrid renderer (WebGL view / DOM edit) + remove the webgl flag

**Files:**
- Delete: `client/src/terminal/webgl.ts`, `client/src/terminal/webgl.test.ts`
- Modify: `client/src/terminal/TerminalShapeUtil.tsx`

- [ ] **Step 1: Remove the flag.** `git rm client/src/terminal/webgl.ts client/src/terminal/webgl.test.ts`; remove the `import { webglEnabled } from './webgl'` line.

- [ ] **Step 2: Remove the mount-effect WebGL block.** Delete the whole `if (webglEnabled(() => localStorage)) { const webgl = new WebglAddon() ... term.loadAddon(webgl) }` block (with its comment) from the mount effect — the renderer is now managed by a dedicated effect (Step 4). Keep the `clearTextureAtlas` call inside `reconnectWhenVisible` exactly as is.

- [ ] **Step 3: Simplify the editing-focus effect** back to focus/blur only (the edit-enter atlas heal is moot — edit mode has no atlas):

```ts
	// Editing state drives keyboard focus. (Renderer swap on edit lives in its
	// own effect below.)
	useEffect(() => {
		if (isEditing) termRef.current?.focus()
		else termRef.current?.blur()
	}, [isEditing])
```

- [ ] **Step 4: Add the renderer-strategy effect.** Add `const webglRef = useRef<WebglAddon | null>(null)` beside the other refs. Declare this effect AFTER the mount effect (so the terminal is open when it first runs). In the mount effect's cleanup, add `webglRef.current = null` right after `term.dispose()` (the dispose tears the addon down; the ref must not go stale across a session remount).

```ts
	// Renderer strategy: WebGL while viewing, DOM while editing — everyone,
	// always (no per-machine flag).
	// - View mode can have many terminals compositing while the tldraw camera
	//   pans/zooms; the WebGL renderer is cheap there and glyphs stay at the
	//   base font, inside the atlas's comfort zone.
	// - Edit mode renders at fontSize ≈ base × zoom. Feeding that to an atlas
	//   renderer produced the blur (fractional sizes), drifting side margins
	//   (device-px cell rounding × cols) and square-box glyphs at high
	//   zoom × DPR (atlas overflow) — verified live at DPR 1.1/2.2. The DOM
	//   renderer has no atlas; browser text is crisp at any fractional size.
	// Disposing the addon drops xterm to its DOM renderer; going back needs a
	// fresh instance (disposed addons cannot be reloaded).
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		if (isEditing) {
			webglRef.current?.dispose()
			webglRef.current = null
			return
		}
		const webgl = new WebglAddon()
		webgl.onContextLoss(() => {
			// Degraded but functional: surface it so a silently DOM-rendered
			// terminal isn't invisible to anyone watching the console.
			console.warn('[terminal] WebGL context lost — falling back to DOM renderer')
			webgl.dispose()
			if (webglRef.current === webgl) webglRef.current = null
		})
		term.loadAddon(webgl)
		webglRef.current = webgl
		return () => {
			// Skip if context-loss already disposed it (ref was nulled).
			if (webglRef.current === webgl) {
				webgl.dispose()
				webglRef.current = null
			}
		}
	}, [isEditing, shape.props.sessionId])
```

(`shape.props.sessionId` in the deps re-arms the effect after a session remount recreates the Terminal.)

- [ ] **Step 5: Verify.** `cd client && bunx tsc --noEmit && bun src/terminal/keys.test.ts && bun src/terminal/grid.test.ts && bun src/terminal/wsUrl.test.ts` — clean/pass (webgl.test.ts is gone).

- [ ] **Step 6: Commit.**

```bash
git add -A client/src/terminal/
git commit -m "fix(terminal): WebGL in view, DOM renderer in edit mode

Editing re-renders at base-font x zoom; atlas renderers blur at
fractional sizes, drift the side margins (device-px cell rounding x
cols) and drop glyphs to boxes when zoom x DPR overflows the atlas
(deterministic at 379% on DPR 2.2). The DOM renderer has no atlas and
is crisp at any size — and one focused terminal is its cheap case.
Removes the ensembleworks:webgl escape hatch: same strategy for
everyone. Visibility-return atlas heal stays for view-mode WebGL."
```

### Task 9: Integer-px font while editing

**Files:** Modify `client/src/terminal/TerminalShapeUtil.tsx` (font effect + host counter-scale)

- [ ] **Step 1: Floor the rendered font.** Replace the font effect body: `const nextFont = Math.max(1, Math.floor(BASE_FONT * editZoom))` (comment: fractional font sizes made DOM row heights quantise per row × ~25 rows → bottom-edge drift; flooring is render-only, the grid is untouched because captureCell normalises by fontSize/BASE_FONT). (superseded during review: counter-scale stays on editZoom — net scale must be exactly 1 for xterm selection; font floors so content only under-fills; see spec item 8 as shipped)

- [ ] **Step 2:** (superseded during review: counter-scale stays on editZoom — net scale must be exactly 1 for xterm selection; font floors so content only under-fills; see spec item 8 as shipped)

- [ ] **Step 3: Verify + commit.** Typecheck + unit tests as before.

```bash
git add client/src/terminal/TerminalShapeUtil.tsx
git commit -m "fix(terminal): integer-px font while editing kills bottom-edge drift"
```

### Task 10: Per-terminal base font size (shared prop + Ctrl/Cmd keys)

**Files:**
- Modify: `contracts/src/shapes.ts` (terminalShapeProps), `client/src/terminal/keys.ts`, `client/src/terminal/keys.test.ts`, `client/src/terminal/TerminalShapeUtil.tsx`

- [ ] **Step 1: Failing tests first** — extend `keys.test.ts`:

```ts
import {
	FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN,
	fontSizeActionForKey, nextFontSize,
} from './keys'

// Ctrl/Cmd +/-/0 map to font actions; '=' is unshifted '+', '_' shifted '-'.
assert.equal(fontSizeActionForKey(ev({ key: '+', ctrlKey: true })), 'up')
assert.equal(fontSizeActionForKey(ev({ key: '=', metaKey: true })), 'up')
assert.equal(fontSizeActionForKey(ev({ key: '-', ctrlKey: true })), 'down')
assert.equal(fontSizeActionForKey(ev({ key: '_', ctrlKey: true })), 'down')
assert.equal(fontSizeActionForKey(ev({ key: '0', metaKey: true })), 'reset')
// No modifier / alt combos / keyup: not ours.
assert.equal(fontSizeActionForKey(ev({ key: '+' })), null)
assert.equal(fontSizeActionForKey(ev({ key: '+', ctrlKey: true, altKey: true })), null)
assert.equal(fontSizeActionForKey(ev({ key: '+', ctrlKey: true, type: 'keyup' })), null)
// Clamping and reset.
assert.equal(nextFontSize(16, 'up'), 17)
assert.equal(nextFontSize(FONT_SIZE_MAX, 'up'), FONT_SIZE_MAX)
assert.equal(nextFontSize(FONT_SIZE_MIN, 'down'), FONT_SIZE_MIN)
assert.equal(nextFontSize(23, 'reset'), FONT_SIZE_DEFAULT)
```

(`ev` needs its default `key` overridable — it already is.) Run, expect FAIL (missing exports).

- [ ] **Step 2: Implement in keys.ts:**

```ts
// Shared per-terminal font size: one PTY grid per terminal, so font size is
// a property of the terminal, not the viewer. Clamped so the deterministic
// grid stays sane (MIN keeps cols/rows finite; MAX keeps the WebGL atlas in
// its comfort zone in view mode).
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32
export const FONT_SIZE_DEFAULT = 16

export type FontSizeAction = 'up' | 'down' | 'reset'

// Ctrl/Cmd +/- (and 0 to reset) while editing. '=' is the unshifted '+' key,
// '_' the shifted '-'. Alt combos are left alone (tmux Meta bindings).
export function fontSizeActionForKey(e: EnterKeyEvent): FontSizeAction | null {
	if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return null
	if (e.key === '+' || e.key === '=') return 'up'
	if (e.key === '-' || e.key === '_') return 'down'
	if (e.key === '0') return 'reset'
	return null
}

export function nextFontSize(current: number, action: FontSizeAction): number {
	if (action === 'reset') return FONT_SIZE_DEFAULT
	const next = action === 'up' ? current + 1 : current - 1
	return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, next))
}
```

- [ ] **Step 3: contracts prop.** In `contracts/src/shapes.ts` terminalShapeProps, after `gateway`:

```ts
	// Per-terminal base font size (px) — SHARED: one PTY grid per terminal, so
	// font size belongs to the terminal, not the viewer; changing it re-grids
	// for every client. Optional so existing rooms need no migration (= 16).
	fontSize: T.number.optional(),
```

- [ ] **Step 4: Wire into TerminalShapeUtil.tsx.**
  - `TerminalShapeProps` interface: add `fontSize?: number`.
  - In the component: `const baseFont = shape.props.fontSize ?? FONT_SIZE_DEFAULT` and a render-updated ref `const baseFontRef = useRef(baseFont); baseFontRef.current = baseFont` (captureCell in the mount effect must normalise against the CURRENT base font, not the mount-time closure).
  - Mount effect: `new Terminal({ fontSize: baseFont, ... })`; in `captureCell`, `const scale = (term.options.fontSize ?? baseFontRef.current) / baseFontRef.current`.
  - Font effect becomes deps `[editZoom, baseFont]` with `Math.max(1, Math.floor(baseFont * editZoom))`. (superseded during review: counter-scale stays on editZoom — net scale must be exactly 1 for xterm selection; font floors so content only under-fills; see spec item 8 as shipped)
  - New effect AFTER the font effect — re-capture the cell when the shared base font changes (same quantised value on every client ⇒ same grid):

```ts
	// Shared font-size changes re-measure the cell; the deterministic grid
	// effect then re-derives cols/rows from the same shared inputs everywhere.
	useEffect(() => {
		const term = termRef.current
		if (!term) return
		const cell = xtermCell(term)
		if (!cell) return
		const scale = (term.options.fontSize ?? baseFont) / baseFont
		setCellSize(quantizeCell(cell.width / scale, cell.height / scale))
	}, [baseFont])
```

  - Key handler, after the ptyInput block (before the ctrl/meta copy-paste block):

```ts
			// Ctrl/Cmd +/-/0: shared per-terminal font size (see ./keys). Owned
			// here so the browser's page-zoom never fires while editing. Read the
			// LIVE shape — this closure's `shape` is stale after prop changes.
			const fontAction = fontSizeActionForKey(e)
			if (fontAction) {
				e.preventDefault()
				const live = editor.getShape(shape.id) as TerminalShape | undefined
				const current = live?.props.fontSize ?? FONT_SIZE_DEFAULT
				const next = nextFontSize(current, fontAction)
				if (live && next !== current) {
					editor.updateShape({ id: shape.id, type: shape.type, props: { fontSize: next } })
				}
				return false
			}
```

  - Imports: `fontSizeActionForKey, nextFontSize, FONT_SIZE_DEFAULT` from './keys'.

- [ ] **Step 5: Verify.** `cd client && bun src/terminal/keys.test.ts && bun src/terminal/grid.test.ts && bunx tsc --noEmit && cd .. && bun run typecheck` (contracts + server must also compile — the props object is the single source).

- [ ] **Step 6: Commit.**

```bash
git add contracts/src/shapes.ts client/src/terminal/keys.ts client/src/terminal/keys.test.ts client/src/terminal/TerminalShapeUtil.tsx
git commit -m "feat(terminal): shared per-terminal font size, Ctrl/Cmd +/- while editing

fontSize is a shape prop (optional, no migration; default 16, clamp
8-32): one PTY grid per terminal means font size belongs to the
terminal, not the viewer. Every client re-measures the cell at the
shared base font and re-derives the same grid deterministically."
```

### Task 11: DPR-faithful verification + findings write-back

**Files:** possibly modify `client/e2e/terminal-zoom-probe.mjs`; modify spec addendum (findings)

- [ ] **Step 1:** Bring up the dev stack (`bun run dev`, seeded room "probe" from the Task 6 session), box-drawing content in the tmux session.
- [ ] **Step 2:** Renderer-swap check via the probe or a page.evaluate: `.xterm-screen canvas` exists in view mode, absent while editing (DOM renderer).
- [ ] **Step 3:** Run zoom + editpad probes at `PROBE_DPR=1.1` and `PROBE_DPR=2.2` (the live machine's values), zooms including 0.65 and 3.79. Assert/inspect: no square boxes at 3.79 while editing; bottom gap between `.xterm-screen` bottom and container bottom stable (±2px) across zooms while editing; box-drawing seams screenshot at integer fonts — record verdict (gone / acceptable / needs mitigation).
- [ ] **Step 4:** Font-size keys end-to-end: while editing, dispatch Ctrl+'+' twice via the probe, assert `shape.props.fontSize` becomes 18 (via `window.__ewEditor.getShape(...)`) and the grid re-derives (cols shrink).
- [ ] **Step 5:** Append findings to the spec addendum (item 10 section), commit docs + any probe tweaks:

```bash
git add client/e2e/ docs/superpowers/specs/2026-07-10-terminal-fixes-bundle-design.md
git commit -m "docs(terminal): DPR-faithful verification findings for renderer strategy"
```
