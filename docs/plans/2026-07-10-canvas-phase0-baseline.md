# Canvas Rewrite Phase 0: Baseline Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up the Playwright + perf rigs against the *current tldraw app* and capture executable baselines — visual goldens, interaction "feel" numbers, multi-client convergence, and performance metrics — that the new canvas engine will be measured against (see `docs/plans/2026-07-10-canvas-rewrite-design.md`, Phase 0).

**Architecture:** A new `e2e` Bun workspace holding a Playwright rig. The rig boots the real server in-process-style (`createSyncApp` on :8788, fresh temp data dir per run) plus the Vite dev client on :5273 (5173 stays free for the normal dev stack) via Playwright `webServer`. Tests seed rooms through the *agent HTTP API* (dogfooding the surface bots use), read app state through a tiny dev-only `window.__ewEditor` handle, and write baseline artifacts (screenshots, `feel.json`, perf JSONs) that are committed to the repo.

**Tech Stack:** Bun 1.3.14 (workspace + server), Node 22.12.0 (Playwright runner — the CLI shebang uses node), `@playwright/test` + Chromium, the existing Express/tldraw-sync server, Vite dev server.

---

## Context you need (zero-assumption briefing)

- **Run everything from the worktree root** `.worktrees/canvas-phase0/` with bun on PATH:
  `export PATH="$HOME/.bun/bin:$PATH"`. Node comes from asdf (`.tool-versions` pins 22.12.0).
- **The app:** `client/` is a Vite React app embedding tldraw. A room is `http://127.0.0.1:5273/?room=<id>` (`[a-zA-Z0-9_-]{1,64}`, default `team`). Vite proxies `/sync` (ws), `/api`, `/uploads`, `/files` → `http://localhost:8788` (see `client/vite.config.ts`). The terminal gateway (:8789) is NOT needed — we never seed terminal shapes.
- **The server:** `createSyncApp({ dataDir })` from `server/src/app.ts` returns `{ server, getOrCreateRoom }`; `server.listen(port)`. `GET /api/health` is the liveness probe. Room docs persist as `<dataDir>/rooms/<roomId>.sqlite` — a fresh temp `dataDir` per test run = clean, deterministic rooms. Precedent: `cli/src/cli-api.test.ts` boots exactly this way.
- **Seeding API** (`POST http://127.0.0.1:8788/api/canvas/shape`, JSON body — contract in `contracts/src/tools/canvas.ts`): `{ room, op: 'create', type: 'geo'|'text'|'note'|'arrow'|'frame'|'line'|'draw'|'highlight', x, y, w, h, text?, color?, geo?, name? (frame caption), frame? (parent frame by fuzzy name), fromId?/toId? (arrow bindings), points? (line/draw) }` → `{ ok: true, id }`. Also `POST /api/canvas/sticky` `{ room, text, frame? }` and `GET /api/canvas/frames?room=<id>`.
- **Identity:** first load calls `window.prompt` for a name unless localStorage has `ensembleworks.userId` / `ensembleworks.userName` (`client/src/identity.ts`). Tests pre-seed these via Playwright `storageState` — a prompt appearing means the fixture broke; fail loudly.
- **bun test discovery** (`scripts/run-tests.ts`) globs `**/src/**/*.test.ts`. Our specs live in `e2e/tests/*.spec.ts` and `e2e/perf/*.spec.ts` — outside `src/`, `.spec.ts` suffix — so plain `bun test`/CI smoke never tries to run Playwright specs under bun. Do not "fix" this by renaming.
- **Port discipline:** the rig binds :8788 and :5273 with `reuseExistingServer: false`. If `bin/dev` / the devcontainer stack is running, STOP IT first (`bin/dev down` from the main checkout) or Playwright fails at startup — that's intentional (never test against a dirty stack).
- **tldraw DOM anchors** (stable classes): `.tl-container` (root), `.tl-shape` (each shape), `.tl-cursor` (collaborator cursors).

## Task 0: Preflight (no commit)

**Step 1: Verify toolchain**

```bash
cd /home/stag/src/projects/ensembleworks/.worktrees/canvas-phase0
export PATH="$HOME/.bun/bin:$PATH"
bun --version        # expect 1.3.14
node --version       # expect v22.12.0 (asdf; if "No version is set": asdf install nodejs 22.12.0)
```

**Step 2: Verify ports free**

```bash
ss -ltn | grep -E ':(8788|5273) ' || echo PORTS-FREE
```
Expected: `PORTS-FREE`. If not, stop the dev stack (`bin/dev down` in the main checkout).

**Step 3: Verify clean baseline**

```bash
bun run typecheck && bun test
```
Expected: all workspaces pass (verified 2026-07-10 at worktree creation).

## Task 1: Scaffold the `e2e` workspace

**Files:**
- Create: `e2e/package.json`
- Create: `e2e/tsconfig.json`
- Create: `e2e/.gitignore`
- Modify: `package.json` (root — workspaces + typecheck)

**Step 1: Create `e2e/package.json`**

```json
{
  "name": "@ensembleworks/e2e",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "typecheck": "bunx tsc --noEmit",
    "test": "bunx playwright test --project=e2e",
    "perf": "bunx playwright test --project=perf"
  },
  "devDependencies": {
    "@playwright/test": "^1.53.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create `e2e/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["playwright.config.ts", "lib/**/*.ts", "tests/**/*.ts", "perf/**/*.ts", "scripts/**/*.ts"]
}
```

**Step 3: Create `e2e/.gitignore`**

```
test-results/
playwright-report/
.artifacts/
```

**Step 4: Wire into root `package.json`**

Add `"e2e"` to the `workspaces` array (after `"discord"`), and append to the root `typecheck` script:
`&& bun run --filter '@ensembleworks/e2e' typecheck`

**Step 5: Install and verify**

```bash
bun install && bun run --filter '@ensembleworks/e2e' typecheck
```
Expected: install succeeds; typecheck exits 0 (no files yet is fine — tsc with empty include set may warn; if it errors with "No inputs were found", create an empty `e2e/lib/.keep.ts` containing `export {}` and delete it in Task 3).

**Step 6: Commit**

```bash
git add e2e package.json bun.lock
git commit -m "test(e2e): scaffold e2e workspace for canvas baseline rigs"
```

## Task 2: Install Playwright Chromium

**Step 1: Install the browser**

```bash
cd e2e && bunx playwright install chromium && cd ..
```
Expected: downloads Chromium to `~/.cache/ms-playwright/`. If it complains about missing system libs, run `bunx playwright install-deps chromium` (needs sudo) or install the listed packages via pacman.

**Step 2: Verify**

```bash
cd e2e && bunx playwright --version && cd ..
```
Expected: `Version 1.5x.x`.

No commit (no repo changes).

## Task 3: Server boot script

**Files:**
- Create: `e2e/scripts/start-server.ts`

**Step 1: Write the script**

```ts
// Boots the real EnsembleWorks server for the e2e rig: fixed port 8788 (the
// Vite proxy target), data dir from EW_E2E_DATA_DIR (fresh temp dir per run,
// created by playwright.config.ts). Run with: bun scripts/start-server.ts
import { createSyncApp } from '../../server/src/app.ts'

const dataDir = process.env.EW_E2E_DATA_DIR
if (!dataDir) throw new Error('EW_E2E_DATA_DIR not set — run via playwright, not directly')

const { server } = createSyncApp({ dataDir })
server.listen(8788, () => console.log(`[e2e] server on :8788, data in ${dataDir}`))
```

**Step 2: Run it to verify it boots**

```bash
cd e2e
EW_E2E_DATA_DIR=$(mktemp -d) bun scripts/start-server.ts &
sleep 2 && curl -sf http://127.0.0.1:8788/api/health && echo OK
kill %1; cd ..
```
Expected: health JSON then `OK`. If `createSyncApp` needs different options, read `server/src/app.ts` top-of-file docs and `cli/src/cli-api.test.ts:30` — copy that boot pattern exactly.

**Step 3: Typecheck and commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/scripts && git commit -m "test(e2e): server boot script for the playwright rig"
```

## Task 4: Playwright config + identity fixture + smoke spec

**Files:**
- Create: `e2e/playwright.config.ts`
- Create: `e2e/lib/fixtures.ts`
- Create: `e2e/tests/smoke.spec.ts`

**Step 1: Write `e2e/playwright.config.ts`**

```ts
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

// Fresh server data dir per run → deterministic rooms for goldens.
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ew-e2e-'))

export default defineConfig({
	projects: [
		{ name: 'e2e', testDir: './tests' },
		{ name: 'perf', testDir: './perf', timeout: 120_000 },
	],
	fullyParallel: false, // one shared server; room-per-spec gives isolation
	workers: 1,
	retries: 0, // a flaky baseline is a broken baseline — fix, don't retry
	use: {
		baseURL: 'http://127.0.0.1:5273',
		viewport: { width: 1280, height: 720 },
		deviceScaleFactor: 1,
		colorScheme: 'light',
		locale: 'en-US',
		timezoneId: 'UTC',
		trace: 'retain-on-failure',
	},
	expect: {
		toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
	},
	snapshotPathTemplate: '{testDir}/../goldens/visual/{arg}{ext}',
	webServer: [
		{
			command: 'bun scripts/start-server.ts',
			url: 'http://127.0.0.1:8788/api/health',
			reuseExistingServer: false,
			env: { EW_E2E_DATA_DIR: dataDir },
		},
		{
			command: 'bunx vite --host 127.0.0.1 --port 5273 --strictPort',
			cwd: '../client',
			url: 'http://127.0.0.1:5273',
			reuseExistingServer: false,
		},
	],
})
```

**Step 2: Write `e2e/lib/fixtures.ts`**

```ts
import { test as base, expect } from '@playwright/test'

export const API = 'http://127.0.0.1:8788'

// Pre-seeded identity so the window.prompt onboarding never fires.
// A prompt appearing = broken fixture; the dialog handler fails the test.
function identityState(name: string, id: string) {
	return {
		cookies: [],
		origins: [
			{
				origin: 'http://127.0.0.1:5273',
				localStorage: [
					{ name: 'ensembleworks.userId', value: id },
					{ name: 'ensembleworks.userName', value: name },
					{ name: 'ensembleworks.userColor', value: 'blue' },
				],
			},
		],
	}
}

export const test = base.extend({
	storageState: async ({}, use) => use(identityState('E2E One', 'e2e-user-0000-0000-0001')),
	page: async ({ page }, use) => {
		page.on('dialog', (d) => {
			throw new Error(`unexpected dialog (identity fixture broken?): ${d.message()}`)
		})
		await use(page)
	},
})
export { expect, identityState }
```

**Step 3: Write `e2e/tests/smoke.spec.ts`**

```ts
import { test, expect } from '../lib/fixtures'

test('room loads with canvas mounted and no onboarding prompt', async ({ page }) => {
	await page.goto('/?room=smoke-basic')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
})
```

**Step 4: Run it**

```bash
cd e2e && bunx playwright test --project=e2e && cd ..
```
Expected: `1 passed`. First run is slow (Vite cold start). If `.tl-container` never appears, open the trace (`bunx playwright show-trace test-results/.../trace.zip`) — most likely the sync WS failed; check the server webServer log output.

**Step 5: Typecheck + commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e && git commit -m "test(e2e): playwright rig — booted stack, identity fixture, smoke spec"
```

## Task 5: Editor handle smoke coverage (uses the existing `__ewEditor` hook)

> **Amended during execution:** the client already exposes the editor as
> `window.__ewEditor` in `client/src/App.tsx` (`handleMount`) — an established
> convention used by `docs/headless-browser.md` and the acceptance docs. No
> client change is needed; the rig uses that hook. All later tasks reference
> `(window as any).__ewEditor` (an `Editor`, NOT wrapped in an object).

**Files:**
- Modify: `e2e/tests/smoke.spec.ts`

**Step 1: Extend the smoke spec**

Append to `smoke.spec.ts`:

```ts
test('editor debug hook is exposed and the fresh room is empty', async ({ page }) => {
	await page.goto('/?room=smoke-handle')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	// waitForFunction polls until truthy — wrap in an object so a legitimate
	// count of 0 (falsy) still resolves.
	const count = await page.waitForFunction(() => {
		const ed = (window as any).__ewEditor
		return ed ? { n: ed.getCurrentPageShapes().length } : null
	})
	expect((await count.jsonValue())!.n).toBe(0)
})
```

**Step 2: Run to verify it passes**

```bash
cd e2e && bunx playwright test --project=e2e && cd ..
```
Expected: `2 passed`.

**Step 3: Typecheck + commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/tests/smoke.spec.ts
git commit -m "test(e2e): editor-hook smoke coverage via existing __ewEditor"
```

## Task 6: Seed library (agent-API dogfooding)

**Files:**
- Create: `e2e/lib/seed.ts`
- Create: `e2e/tests/seed.spec.ts`

**Step 1: Write `e2e/lib/seed.ts`**

```ts
// Seeds rooms through the real agent HTTP API — the same surface the Discord
// bot and skills use — so the rig doubles as an API smoke suite.
import { API } from './fixtures'

type Json = Record<string, unknown>

async function post(path: string, body: Json): Promise<Json> {
	const res = await fetch(`${API}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`)
	return (await res.json()) as Json
}

export const shape = (room: string, body: Json) => post('/api/canvas/shape', { room, ...body })
export const sticky = (room: string, body: Json) => post('/api/canvas/sticky', { room, ...body })

/** Deterministic board exercising every seedable shape kind. Returns created ids. */
export async function seedGoldenBoard(room: string): Promise<string[]> {
	const ids: string[] = []
	const keep = async (p: Promise<Json>) => ids.push(String((await p).id))

	await keep(shape(room, { type: 'text', x: 100, y: 40, text: 'Golden Board' }))
	await keep(shape(room, { type: 'frame', x: 100, y: 120, w: 640, h: 480, name: 'Planning' }))
	// A sticky cluster inside the frame (frame-local coords), plus one outlier.
	for (const [i, txt] of ['alpha', 'beta', 'gamma'].entries())
		await keep(shape(room, { type: 'note', frame: 'Planning', x: 40, y: 40 + i * 110, text: txt, color: 'yellow' }))
	await keep(shape(room, { type: 'note', frame: 'Planning', x: 420, y: 320, text: 'outlier', color: 'blue' }))
	// Two geos joined by a bound arrow (page coords).
	await keep(shape(room, { type: 'geo', geo: 'rectangle', x: 820, y: 160, w: 160, h: 100, text: 'A' }))
	await keep(shape(room, { type: 'geo', geo: 'ellipse', x: 820, y: 420, w: 160, h: 100, text: 'B' }))
	await keep(shape(room, { type: 'arrow', fromId: ids[6], toId: ids[7] }))
	// A deterministic ink stroke.
	await keep(
		shape(room, {
			type: 'draw',
			points: [[1040, 200], [1080, 240], [1060, 300], [1120, 340], [1100, 400]],
		}),
	)
	return ids
}
export const GOLDEN_BOARD_SHAPE_COUNT = 10
```

**Step 2: Write `e2e/tests/seed.spec.ts`**

```ts
import { test, expect } from '../lib/fixtures'
import { API, seedGoldenBoard, GOLDEN_BOARD_SHAPE_COUNT } from '../lib/seed'

test('seeded board renders every shape and registers its frame', async ({ page }) => {
	await seedGoldenBoard('seed-check')
	await page.goto('/?room=seed-check')
	await expect(page.locator('.tl-shape')).toHaveCount(GOLDEN_BOARD_SHAPE_COUNT, { timeout: 15_000 })

	const frames = await (await fetch(`${API}/api/canvas/frames?room=seed-check`)).json()
	expect(JSON.stringify(frames)).toContain('Planning')
})
```

Note the import of `API` moved to `seed.ts`'s re-export — if that import feels circular, import `API` from `../lib/fixtures` directly. Adjust `GOLDEN_BOARD_SHAPE_COUNT` only if the API legitimately creates a different number (e.g. arrows may not carry a `.tl-shape` count of 1 — inspect with the trace viewer and set the true number; document why in a comment).

**Step 3: Run, fix contract mismatches, re-run until green**

```bash
cd e2e && bunx playwright test --project=e2e -g "seeded board" && cd ..
```
Expected: PASS. If a `post` throws 400, the field contract drifted — recheck `contracts/src/tools/canvas.ts` zodInput and fix `seed.ts` (never the server).

**Step 4: Typecheck + commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/lib/seed.ts e2e/tests/seed.spec.ts
git commit -m "test(e2e): deterministic golden-board seeding via the agent HTTP API"
```

## Task 7: Visual goldens

**Files:**
- Create: `e2e/tests/visual.spec.ts`
- Create (generated): `e2e/goldens/visual/*.png`

**Step 1: Write `e2e/tests/visual.spec.ts`**

```ts
import { test, expect } from '../lib/fixtures'
import { seedGoldenBoard, GOLDEN_BOARD_SHAPE_COUNT } from '../lib/seed'

// Deterministic camera: fit all content with no animation, then screenshot.
async function settle(page: import('@playwright/test').Page, count: number) {
	await expect(page.locator('.tl-shape')).toHaveCount(count, { timeout: 15_000 })
	await page.evaluate(() => {
		const editor = (window as any).__ewEditor
		editor.zoomToFit({ animation: { duration: 0 } })
	})
	await page.waitForTimeout(500) // let fonts/last paint settle
}

test('golden board matches baseline', async ({ page }) => {
	await seedGoldenBoard('golden-board')
	await page.goto('/?room=golden-board')
	await settle(page, GOLDEN_BOARD_SHAPE_COUNT)
	await expect(page).toHaveScreenshot('golden-board.png')
})

test('empty room chrome matches baseline', async ({ page }) => {
	await page.goto('/?room=golden-empty')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })
	await page.waitForTimeout(500)
	await expect(page).toHaveScreenshot('empty-room.png')
})
```

**Step 2: Capture the goldens**

```bash
cd e2e && bunx playwright test --project=e2e -g "baseline" --update-snapshots && cd ..
```
Expected: `2 passed`, PNGs written under `e2e/goldens/visual/`.

**Step 3: Verify stability — run twice more without update**

```bash
cd e2e && bunx playwright test --project=e2e -g "baseline" && bunx playwright test --project=e2e -g "baseline" && cd ..
```
Expected: PASS both times. If flaky, find the nondeterminism (version badge? timestamps? presence artifacts?) and `mask: [page.locator(...)]` ONLY that element in the `toHaveScreenshot` call — masks are documented exceptions, not a reflex.

**Step 4: Commit (including PNGs)**

```bash
git add e2e/tests/visual.spec.ts e2e/goldens
git commit -m "test(e2e): visual goldens for golden-board and empty-room chrome"
```

## Task 8: Interaction "feel" goldens

**Files:**
- Create: `e2e/lib/feel.ts`
- Create: `e2e/tests/feel.spec.ts`
- Create (generated): `e2e/goldens/feel.json`

**Step 1: Write `e2e/lib/feel.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export interface FeelNumbers {
	dragThresholdPx: number // min pointer travel before a shape actually moves
	nudgePx: number // ArrowRight on a selected shape
	shiftNudgePx: number // Shift+ArrowRight
	wheelZoomRatio: number // zoom multiplier for one ctrl+wheel tick (deltaY -100)
}

const FILE = path.join(import.meta.dirname, '../goldens/feel.json')
export const capturing = process.env.EW_CAPTURE === '1'
export const saveFeel = (f: FeelNumbers) => {
	mkdirSync(path.dirname(FILE), { recursive: true })
	writeFileSync(FILE, JSON.stringify(f, null, 2) + '\n')
}
export const loadFeel = (): FeelNumbers => JSON.parse(readFileSync(FILE, 'utf8'))
```

**Step 2: Write `e2e/tests/feel.spec.ts`**

```ts
// Captures tldraw's interaction "feel" as numbers. These goldens are the
// executable spec the new engine's tools must reproduce (design §editor).
// Capture mode: EW_CAPTURE=1 bunx playwright test -g "feel"
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { capturing, loadFeel, saveFeel, type FeelNumbers } from '../lib/feel'

async function setup(page: import('@playwright/test').Page, room: string) {
	const { id } = await shape(room, { type: 'note', x: 400, y: 300, text: 'probe' })
	await page.goto(`/?room=${room}`)
	await expect(page.locator('.tl-shape')).toHaveCount(1, { timeout: 15_000 })
	await page.evaluate(() => {
		const editor = (window as any).__ewEditor
		editor.setCamera({ x: 0, y: 0, z: 1 }, { animation: { duration: 0 } })
	})
	return String(id)
}

const shapeX = (page: import('@playwright/test').Page, id: string) =>
	page.evaluate((sid) => (window as any).__ewEditor.editor.getShape(sid).x, id)

// Screen point of the note's center at camera {0,0,z:1}: page coords == screen
// coords offset by the canvas origin; read the true center from the editor.
async function centerOnScreen(page: import('@playwright/test').Page, id: string) {
	return page.evaluate((sid) => {
		const editor = (window as any).__ewEditor
		const b = editor.getShapePageBounds(sid)
		const p = editor.pageToViewport({ x: b.midX, y: b.midY })
		const r = editor.getContainer().getBoundingClientRect()
		return { x: r.x + p.x, y: r.y + p.y }
	}, id)
}

test('feel numbers match golden', async ({ page }) => {
	// drag threshold: smallest horizontal travel that translates the shape
	let dragThresholdPx = -1
	for (let px = 1; px <= 12; px++) {
		const room = `feel-drag-${px}`
		const id = await setup(page, room)
		const x0 = await shapeX(page, id)
		const c = await centerOnScreen(page, id)
		await page.mouse.move(c.x, c.y)
		await page.mouse.down()
		await page.mouse.move(c.x + px, c.y, { steps: 1 })
		await page.mouse.up()
		if ((await shapeX(page, id)) !== x0) { dragThresholdPx = px; break }
	}

	// nudges + wheel zoom on one more room
	const id = await setup(page, 'feel-keys')
	const c = await centerOnScreen(page, id)
	await page.mouse.click(c.x, c.y) // select
	const x0 = await shapeX(page, id)
	await page.keyboard.press('ArrowRight')
	const nudgePx = (await shapeX(page, id)) - x0
	await page.keyboard.press('Shift+ArrowRight')
	const shiftNudgePx = (await shapeX(page, id)) - x0 - nudgePx
	await page.keyboard.press('Escape')

	const z0 = await page.evaluate(() => (window as any).__ewEditor.editor.getZoomLevel())
	await page.keyboard.down('Control')
	await page.mouse.wheel(0, -100)
	await page.keyboard.up('Control')
	await page.waitForTimeout(300)
	const z1 = await page.evaluate(() => (window as any).__ewEditor.editor.getZoomLevel())

	const observed: FeelNumbers = {
		dragThresholdPx,
		nudgePx,
		shiftNudgePx,
		wheelZoomRatio: Number((z1 / z0).toFixed(4)),
	}

	if (capturing) {
		saveFeel(observed)
		console.log('[feel] captured', observed)
	} else {
		expect(observed).toEqual(loadFeel())
	}
})
```

**Step 3: Capture, then verify determinism**

```bash
cd e2e
EW_CAPTURE=1 bunx playwright test --project=e2e -g "feel"
bunx playwright test --project=e2e -g "feel"
bunx playwright test --project=e2e -g "feel"
cd ..
```
Expected: capture prints plausible numbers (tldraw defaults: threshold ~4px, nudge 1, shift-nudge 10, zoom ratio > 1); the two verify runs PASS. If `wheelZoomRatio` is unstable across runs (smooth-zoom easing), round further or read the zoom after `editor.getCameraOptions()`-driven settle — determinism wins over precision; note what you did in a comment.

**Step 4: Typecheck + commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/lib/feel.ts e2e/tests/feel.spec.ts e2e/goldens/feel.json
git commit -m "test(e2e): interaction feel goldens (drag threshold, nudges, wheel zoom)"
```

## Task 9: Multi-client convergence smoke

**Files:**
- Create: `e2e/tests/multiplayer.spec.ts`

**Step 1: Write the spec**

```ts
import { test, expect, identityState } from '../lib/fixtures'

test('two clients converge: shapes and presence', async ({ page, browser }) => {
	await page.goto('/?room=mp-smoke')
	await expect(page.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

	const ctxB = await browser.newContext({
		storageState: identityState('E2E Two', 'e2e-user-0000-0000-0002'),
		viewport: { width: 1280, height: 720 },
	})
	const pageB = await ctxB.newPage()
	await pageB.goto('/?room=mp-smoke')
	await expect(pageB.locator('.tl-container')).toBeVisible({ timeout: 15_000 })

	// A creates a note through the real editor (flows through real sync).
	await page.evaluate(() => {
		const editor = (window as any).__ewEditor
		editor.createShape({ type: 'note', x: 200, y: 200, props: {} })
	})
	await expect(pageB.locator('.tl-shape')).toHaveCount(1, { timeout: 10_000 })

	// B moves the mouse over the canvas; A sees B's presence cursor.
	await pageB.mouse.move(640, 360)
	await pageB.mouse.move(660, 380)
	await expect(page.locator('.tl-cursor')).toHaveCount(1, { timeout: 10_000 })

	await ctxB.close()
})
```

**Step 2: Run**

```bash
cd e2e && bunx playwright test --project=e2e -g "converge" && cd ..
```
Expected: PASS. If the cursor locator finds 0 or 2+, inspect the DOM in the trace and adjust the selector to the collaborator-cursor element tldraw actually renders (it may be `.tl-collaborator-cursor` in this version) — pin whichever is real.

**Step 3: Commit**

```bash
git add e2e/tests/multiplayer.spec.ts
git commit -m "test(e2e): two-client convergence + presence smoke"
```

## Task 10: Perf rig and baselines

**Files:**
- Create: `e2e/lib/perf.ts`
- Create: `e2e/perf/perf.spec.ts`
- Create (generated): `e2e/baselines/tldraw-perf.json`

**Step 1: Write `e2e/lib/perf.ts`**

```ts
// rAF-based frame sampler + metrics. Portable (works in Electron later),
// no CDP dependency. Inject BEFORE page load; measure around a scenario.
import type { Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export const installSampler = (page: Page) =>
	page.addInitScript(() => {
		const w = window as any
		w.__frames = [] as number[]
		const loop = (t: number) => {
			w.__frames.push(t)
			requestAnimationFrame(loop)
		}
		requestAnimationFrame(loop)
	})

export interface FrameStats {
	frames: number
	p50ms: number
	p95ms: number
	maxms: number
	droppedOver25ms: number
}

export async function measure(page: Page, scenario: () => Promise<void>): Promise<FrameStats> {
	const start = await page.evaluate(() => performance.now())
	await scenario()
	const end = await page.evaluate(() => performance.now())
	const deltas = await page.evaluate(
		([s, e]) => {
			const f = (window as any).__frames.filter((t: number) => t >= s && t <= e)
			return f.slice(1).map((t: number, i: number) => t - f[i])
		},
		[start, end],
	)
	const sorted = [...deltas].sort((a, b) => a - b)
	const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
	return {
		frames: deltas.length,
		p50ms: Number(pick(0.5).toFixed(2)),
		p95ms: Number(pick(0.95).toFixed(2)),
		maxms: Number((sorted[sorted.length - 1] ?? 0).toFixed(2)),
		droppedOver25ms: deltas.filter((d: number) => d > 25).length,
	}
}

const FILE = path.join(import.meta.dirname, '../baselines/tldraw-perf.json')
export const capturing = process.env.EW_CAPTURE === '1'
export function record(key: string, value: unknown) {
	mkdirSync(path.dirname(FILE), { recursive: true })
	const all = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
	all[key] = value
	all._meta = { engine: 'tldraw@5.1.0', capturedAt: '2026-07-10', host: 'dev-linux' }
	writeFileSync(FILE, JSON.stringify(all, null, 2) + '\n')
}
```

**Step 2: Write `e2e/perf/perf.spec.ts`**

```ts
// Baseline scenarios against tldraw. Phase 0 CAPTURES numbers; it does not
// gate on them (budgets arrive when the new engine exists to compare).
// Capture: cd e2e && EW_CAPTURE=1 bunx playwright test --project=perf
import { test, expect } from '../lib/fixtures'
import { shape } from '../lib/seed'
import { installSampler, measure, record, capturing } from '../lib/perf'

async function seedGrid(room: string, n: number) {
	const cols = Math.ceil(Math.sqrt(n))
	const batch: Promise<unknown>[] = []
	for (let i = 0; i < n; i++)
		batch.push(
			shape(room, {
				type: 'note',
				x: (i % cols) * 260,
				y: Math.floor(i / cols) * 260,
				text: `n${i}`,
				color: 'yellow',
			}),
		)
	await Promise.all(batch)
}

for (const n of [100, 1000]) {
	test(`perf @ ${n} shapes: load, pan, zoom`, async ({ page }) => {
		const room = `perf-${n}`
		await seedGrid(room, n)
		await installSampler(page)

		const t0 = Date.now()
		await page.goto(`/?room=${room}`)
		await expect(page.locator('.tl-shape').first()).toBeVisible({ timeout: 60_000 })
		const loadMs = Date.now() - t0
		await page.evaluate(() => {
			const editor = (window as any).__ewEditor
			editor.zoomToFit({ animation: { duration: 0 } })
		})

		const pan = await measure(page, async () => {
			for (let i = 0; i < 60; i++) await page.mouse.wheel(40, 40)
		})
		const zoom = await measure(page, async () => {
			await page.keyboard.down('Control')
			for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -60)
			for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 60)
			await page.keyboard.up('Control')
		})

		const heapMB = await page.evaluate(() =>
			Number((((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6).toFixed(1)),
		)

		const result = { loadMs, pan, zoom, heapMB }
		console.log(`[perf ${n}]`, JSON.stringify(result))
		if (capturing) record(`shapes-${n}`, result)

		// Sanity floor only — real budgets come with the new engine.
		expect(pan.frames).toBeGreaterThan(30)
		expect(zoom.frames).toBeGreaterThan(30)
	})
}
```

**Step 3: Capture baselines**

```bash
cd e2e && EW_CAPTURE=1 bunx playwright test --project=perf && cd ..
```
Expected: both tests PASS, console lines show per-scenario stats, `e2e/baselines/tldraw-perf.json` has `shapes-100` and `shapes-1000` entries with non-zero frame counts. The 1000-shape seed takes a minute (1000 HTTP posts) — if it times out, raise that spec's timeout, don't shrink the room.

**Step 4: Run once more without capture (sanity assertions hold)**

```bash
cd e2e && bunx playwright test --project=perf && cd ..
```
Expected: PASS.

**Step 5: Typecheck + commit**

```bash
bun run --filter '@ensembleworks/e2e' typecheck
git add e2e/lib/perf.ts e2e/perf e2e/baselines
git commit -m "test(e2e): perf rig + tldraw baselines at 100/1k shapes"
```

## Task 11: CI wiring

**Files:**
- Create: `.github/workflows/e2e.yml`
- First: `ls .github/workflows/` and mirror the existing workflows' conventions (bun setup steps, secret handling) — copy their setup blocks rather than inventing new ones.

**Step 1: Write the workflow**

```yaml
name: e2e
on:
  pull_request:
  workflow_dispatch:
  schedule:
    - cron: '17 4 * * *' # nightly perf capture

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
      - run: bun install
      - run: cd e2e && bunx playwright install --with-deps chromium
      - run: cd e2e && bunx playwright test --project=e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: e2e-failures
          path: |
            e2e/test-results/
            e2e/playwright-report/

  perf-nightly:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
      - uses: actions/setup-node@v4
        with:
          node-version: 22.12.0
      - run: bun install
      - run: cd e2e && bunx playwright install --with-deps chromium
      - run: cd e2e && EW_CAPTURE=1 bunx playwright test --project=perf
      - uses: actions/upload-artifact@v4
        with:
          name: perf-baseline-${{ github.run_id }}
          path: e2e/baselines/
```

**Step 2: Known risk — font rendering.** Goldens captured on this Arch host may pixel-diff on `ubuntu-latest`. The 0.02 `maxDiffPixelRatio` usually absorbs it. If the CI run fails only on screenshots: download the `e2e-failures` artifact, inspect the diffs; if they're pure font antialiasing, regenerate the goldens FROM CI (add a temporary `workflow_dispatch` step running `--update-snapshots` and uploading `e2e/goldens/`, commit those). Record the choice in `e2e/README.md`. Do NOT loosen the ratio past 0.02 without seeing an actual diff image.

**Step 3: Validate + commit + verify on GitHub**

```bash
bunx yaml-lint .github/workflows/e2e.yml 2>/dev/null || bun -e "const y=await Bun.file('.github/workflows/e2e.yml').text(); (await import('js-yaml')).load(y); console.log('yaml OK')" 2>/dev/null || echo "lint locally unavailable — rely on GitHub's parser"
git add .github/workflows/e2e.yml
git commit -m "ci: e2e job on PRs + nightly perf baseline capture"
```
After the branch is pushed (end of plan), confirm the workflow runs green on the PR.

## Task 12: README + final verification

**Files:**
- Create: `e2e/README.md`

**Step 1: Write `e2e/README.md`**

```markdown
# e2e — canvas baseline rigs (Phase 0)

Playwright rigs capturing how the **current tldraw app** behaves. These
baselines are the executable spec for the canvas rewrite
(`docs/plans/2026-07-10-canvas-rewrite-design.md`).

## Prereqs
- bun 1.3.14 (`export PATH="$HOME/.bun/bin:$PATH"`), node 22.12.0 (asdf)
- Ports 8788/5273 free — stop `bin/dev` first
- `cd e2e && bunx playwright install chromium` once

## Commands (from `e2e/`)
- `bunx playwright test --project=e2e` — functional + visual + feel + multiplayer
- `bunx playwright test --project=perf` — perf scenarios (sanity asserts only)
- `EW_CAPTURE=1 bunx playwright test --project=perf` — rewrite `baselines/tldraw-perf.json`
- `EW_CAPTURE=1 bunx playwright test --project=e2e -g feel` — rewrite `goldens/feel.json`
- `bunx playwright test --update-snapshots` — rewrite visual goldens (only when a
  deliberate UI change lands; review the diff like code)
- `bunx playwright show-trace test-results/**/trace.zip` — debug a failure

## What lives where
- `goldens/visual/` — screenshot baselines (committed)
- `goldens/feel.json` — interaction feel numbers: drag threshold, nudges, wheel
  zoom (committed; the new engine must reproduce these)
- `baselines/tldraw-perf.json` — frame stats/load/heap at 100/1k shapes (committed)
- `lib/` — fixtures (identity storageState), agent-API seeding, samplers
- The stack boots via `playwright.config.ts` webServer: real server (:8788,
  fresh temp data dir per run) + Vite dev client (:5273; 5173 is left to the normal dev stack)

## Rules
- Seed rooms ONLY through the agent HTTP API (`lib/seed.ts`) — the rig doubles
  as an API smoke suite.
- Deterministic by construction: fixed identity, viewport, camera, room names;
  fresh data dir. A flaky baseline is a bug — fix the cause, never add retries.
- Goldens update ONLY with `--update-snapshots` / `EW_CAPTURE=1`, in a commit
  that explains why.
```

**Step 2: Full verification suite**

```bash
bun run typecheck
bun test
cd e2e && bunx playwright test --project=e2e && bunx playwright test --project=perf && cd ..
```
Expected: everything green. Fix anything red before proceeding — @superpowers:verification-before-completion.

**Step 3: Commit**

```bash
git add e2e/README.md
git commit -m "docs(e2e): baseline rig runbook"
```

## Done criteria (Phase 0 exit)

- [ ] `bunx playwright test --project=e2e` green twice consecutively (determinism)
- [ ] Visual goldens committed: `golden-board.png`, `empty-room.png`
- [ ] `goldens/feel.json` committed with plausible tldraw numbers
- [ ] `baselines/tldraw-perf.json` committed with `shapes-100` + `shapes-1000`
- [ ] Multi-client convergence + presence smoke green
- [ ] CI `e2e` job green on the PR; nightly perf job dispatchable
- [ ] `bun run typecheck` and `bun test` still green (no regressions)

Out of scope for Phase 0 (design doc phases 1+): any new packages (`canvas-model` etc.), budgets/gates on perf numbers, soak/chaos rigs, snap-distance and rotation feel goldens (add when the select-tool work starts in Phase 3), goldens for terminal/iframe/screenshare shapes (need live backends; covered by Phase 3 dogfooding).
