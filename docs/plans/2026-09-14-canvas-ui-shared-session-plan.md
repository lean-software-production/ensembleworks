# Canvas UI Shared Session Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The EnsembleWorks web app's v2 mount and the bb Canvas plugin mount one shared set of canvas controls (tools, shortcuts, toolbar, style panel, text editing), so polish added once appears in both.

**Architecture:** Pure session logic (tool set, keyboard resolver, style axes, undo repair) moves into `canvas-editor/src/session/` and stays clean-room. A new `canvas-ui` React package holds the session hook, `CanvasSurface`, `Toolbar`, `StylePanel` and fonts, styled through `--canvas-ui-*` CSS custom properties. Each host keeps only its transport, theme mapping, pages, presence and host-specific layers, and passes a small `CanvasHost` port.

**Tech Stack:** TypeScript, React 19, Bun workspaces (repo root), npm + vitest (isolated `plugins/canvas` package), Playwright (e2e), `@ensembleworks/interaction-contracts`.

**Spec:** `docs/plans/2026-09-14-canvas-ui-shared-session-design.md` (approved 2026-09-14; acceptance criteria are at its end).

## Global Constraints

- **Repo test runner.** Never run bare `bun test`. Full suite: `bun run test` from the repo root. One file: `bun <path/to/file.test.ts>`. Always `export PATH="$HOME/.bun/bin:$PATH"` first. Runners are fail-fast; judge by exit code, run the suite as its own command, then `echo $?`.
- **Known environmental failures.** `server/src/connector-loopback.test.ts` and `server/src/relay-loopback.test.ts` fail inside the agent sandbox ("error connecting to /tmp/tmux-1000/default (Operation not permitted)"). Treat as pre-existing and run the test files after them individually.
- **Typecheck.** `bun run typecheck` from the repo root must exit 0.
- **Plugin gates** (from `plugins/canvas`): `npm run typecheck`, `npm test`, `npm run audit:quality:compare`, `bb plugin build .`. The quality audit needs to open an IPC pipe; run it with the sandbox disabled if it fails with `listen EPERM`.
- **Playwright.** Run from `e2e/`. The rig starts its own server on ports 8788 and 5273; wrap every run in `flock /tmp/claude-1000/e2e.lock <cmd>`. New specs import `test` from `../lib/fixtures`.
- **Clean-room.** `canvas-model`, `canvas-doc`, `canvas-sync`, `canvas-editor` never import tldraw, react, loro-crdt, ws, or touch `document.`/`window.`/`Date.now(`/`Math.random(`. `canvas-editor/src/boundary.test.ts` scans raw file text including comments.
- **canvas-react stays logic-free.** Editor logic never moves into `canvas-react`.
- **Interaction contracts (CLAUDE.md).** Any change under an interaction-bearing path declares or extends a contract in `interaction-contracts/`, implements any new `Obs` method in both `canvas-editor/src/contracts/fsm-runner.ts` and `e2e/lib/contracts.ts`, and records a verbatim RED run against the unfixed code. A behaviour-preserving move instead records `ux-contract: none — <reason>` in its commit message, and local suite runs export `UX_CONTRACT_PR_BODY='ux-contract: none — <reason>'` so `scripts/ux-contract-presence.test.ts` passes.
- **Styling.** Shared chrome reads only `--canvas-ui-*` custom properties (with fallbacks equal to today's web-app values). Document content colours (`GEO_COLORS`, colour swatch fills) are never themed.
- **Toolbar attribute.** Tool buttons carry `data-canvas-tool="<ToolId>"` in both hosts.
- **Tool order and labels.** Select, Hand, Note, Text, Shape (`geo`), Frame, Arrow, Draw, Line.
- **No new source-text wiring guards.** When a guarded file moves or is deleted, retarget or delete its guard.
- **Commits.** Conventional messages ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. No `git stash`, no push.

---

## File Structure

```
canvas-react/src/overlay/Arrows.tsx          modify: filter arrows by current page
canvas-react/src/Overlay.tsx                 modify: pass currentPageId to Arrows
interaction-contracts/src/contracts/arrow-stays-on-its-page.ts   create

canvas-editor/src/session/                   create (pure, clean-room)
  tool-loop.ts            tool set, dispatch, cancel, fall-back-to-select, delete/prune
  tool-shortcut.ts        tool letters + TOOL_SHORTCUT_LABEL
  clipboard-shortcut.ts   Ctrl/Cmd+C/X/V/D decision
  reorder-shortcut.ts     [ ] { } decision
  keyboard.ts             resolveShortcut: key event -> ShortcutCommand
  style-axes.ts           relevant axes, current value, defaults, buildSetStyleIntent
  history.ts              clampCurrentPageIntents, historyRepairIntents, undo/redoWithRepair
  index.ts                re-exports
  *.test.ts               moved + new tests

canvas-ui/                                   create (React, host-agnostic)
  package.json, tsconfig.json, test.ts
  src/index.ts
  src/theme.ts            UI_VARS: the --canvas-ui-* vocabulary
  src/tool-icons.tsx      ToolIcon (9 inline SVGs)
  src/Toolbar.tsx         icon toolbar
  src/StylePanel.tsx      moved from client/src/canvas-v2
  src/style-icons.tsx     moved from client/src/canvas-v2
  src/fonts.ts            canvasFontFaceCss(baseUrl), CanvasFonts
  src/host.ts             CanvasHost port
  src/use-canvas-session.ts   session hook
  src/CanvasSurface.tsx   Viewport + layers + editors + overlay + style panel
  src/*.test.ts

client/src/canvas-v2/CanvasV2App.tsx         modify: mount canvas-ui
plugins/canvas/canvas/panel/*                modify: mount canvas-ui; delete session-input.ts
plugins/canvas/canvas/tool-loop.ts           delete
plugins/canvas/canvas/theme.ts               modify: map bb tokens to --canvas-ui-*
e2e/scripts/bb-canvas-smoke.mjs              create: live-bb acceptance smoke
```

---

### Task 1: Arrows render only on the current page

A shared-renderer bug found on the live bb instance: `Arrows` draws every arrow in the room on every page. `ShapeLayer` already filters by page with `pageIdOf`; `Arrows` does not.

**Files:**
- Modify: `canvas-react/src/overlay/Arrows.tsx` (`ArrowsProps`, the `allArrows` filter in `Arrows`)
- Modify: `canvas-react/src/Overlay.tsx` (the `<Arrows …/>` element)
- Modify: `canvas-react/src/overlay.test.ts` (append one case)
- Modify: `interaction-contracts/src/types.ts` (add `renderedArrowIds` to `Obs`)
- Create: `interaction-contracts/src/contracts/arrow-stays-on-its-page.ts`
- Modify: `interaction-contracts/src/index.ts` (register the contract)
- Modify: `canvas-editor/src/contracts/fsm-runner.ts` (throw-stub adapter)
- Modify: `e2e/lib/contracts.ts` (real browser adapter)

**Interfaces:**
- Produces: `ArrowsProps.currentPageId?: string`; `Obs.renderedArrowIds(): readonly string[]`.

- [ ] **Step 1: Add the `Obs` method to the shared interface**

In `interaction-contracts/src/types.ts`, append inside `interface Obs` (after `hoveredShapeId`):

```ts
  /** Ids of the arrows currently RENDERED in the overlay — the
   * `data-shape-id` of every `[data-overlay="arrow"]` element, in DOM order.
   * Distinct from `listShapeIds()` (the doc): an arrow can exist in the doc
   * yet must not be drawn when it lives on another page. Browser-only by
   * construction (it reads rendered DOM); the FSM adapter throws
   * 'not observable at fsm level'. */
  renderedArrowIds(): readonly string[]
```

- [ ] **Step 2: Implement the FSM throw-stub**

In `canvas-editor/src/contracts/fsm-runner.ts`, inside the object returned by `makeObs`, after `hoveredShapeId()`:

```ts
    renderedArrowIds() {
      // Rendered DOM is not observable in the headless runner; every contract
      // that calls this is level:'browser'.
      throw new Error('not observable at fsm level')
    },
```

- [ ] **Step 3: Implement the browser adapter**

In `e2e/lib/contracts.ts`:

1. Next to `sampleHoveredId`, add:

```ts
async function sampleRenderedArrowIds(page: Page): Promise<readonly string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-overlay="arrow"]')].map((el) => el.getAttribute('data-shape-id') ?? ''),
  )
}
```

2. Add `readonly renderedArrowIds: readonly string[]` to the sample interface (beside `readonly hoveredId: string | null`).
3. In `sampleActor`, add `const renderedArrowIds = await sampleRenderedArrowIds(page)` and include `renderedArrowIds` in the returned object.
4. In `pageObs`, add `renderedArrowIds: () => sample.renderedArrowIds,`.

- [ ] **Step 4: Write the contract**

Create `interaction-contracts/src/contracts/arrow-stays-on-its-page.ts`:

```ts
// An arrow drawn on one page must not be drawn on another page. Found on a
// live bb instance (2026-09-14): canvas-react's Arrows overlay drew every arrow
// in the room regardless of page, while ShapeLayer filtered shape bodies.
import type { Contract, GestureOp, Obs, Rng } from '../types.js'

const ARROW_TOOL_SELECTOR = '[data-canvas-v2-tool="arrow"]'
const NEW_PAGE_SELECTOR = '[data-canvas-v2-new-page]'

export const arrowStaysOnItsPage: Contract = {
  name: 'arrow-stays-on-its-page',
  level: 'browser',
  when: 'at-end',
  gesture: (_rng: Rng): GestureOp[] => [
    { kind: 'down', at: { ref: 'element', selector: ARROW_TOOL_SELECTOR } },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'point', x: 480, y: 520 } },
    { kind: 'move', at: { ref: 'point', x: 700, y: 560 }, steps: 8 },
    { kind: 'up' },
    { kind: 'down', at: { ref: 'element', selector: NEW_PAGE_SELECTOR } },
    { kind: 'up' },
  ],
  check: (obs: Obs): string | null => {
    const pages = obs.pageCount()
    if (pages !== 2) return `expected 2 pages after clicking "+ new page", got ${pages}`
    const ids = obs.listShapeIds()
    if (ids.length !== 1) return `expected exactly one drawn arrow in the doc, got listShapeIds() ${JSON.stringify(ids)}`
    const rendered = obs.renderedArrowIds()
    if (rendered.length !== 0) {
      return `expected no arrow drawn on the newly created page, got renderedArrowIds() ${JSON.stringify(rendered)}`
    }
    return null
  },
}
```

Register it in `interaction-contracts/src/index.ts`: add `import { arrowStaysOnItsPage } from './contracts/arrow-stays-on-its-page.js'` and append `arrowStaysOnItsPage,` to `CONTRACTS`.

- [ ] **Step 5: Write the failing renderer unit test**

Append to `canvas-react/src/overlay.test.ts` (house style: node:assert script, `renderToStaticMarkup` via `createElement`; reuse the file's existing imports of `Arrows`, `makeDocument`, `buildSpatialIndex`/index helper and camera constants — read the top of the file and match the helper names it already uses):

```ts
// ============================================================================
// Arrows are page-scoped: an arrow parented to another page is not drawn.
// ============================================================================
{
  const pageP = { id: 'page:p', name: 'P' }
  const pageQ = { id: 'page:q', name: 'Q' }
  const onP = { id: 'shape:arrow-p', kind: 'arrow', parentId: 'page:p', index: 'a1', x: 10, y: 10, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: { end: { x: 100, y: 0 } } }
  const onQ = { ...onP, id: 'shape:arrow-q', parentId: 'page:q' }
  const doc = makeDocument({ pages: [pageP, pageQ], shapes: [onP, onQ], bindings: [] } as never)
  const html = renderToStaticMarkup(createElement(Arrows, {
    snapshot: doc,
    camera: { x: 0, y: 0, z: 1 },
    viewportSize: { width: 1024, height: 768 },
    index: buildIndexFor(doc),
    currentPageId: 'page:q',
  }))
  assert.ok(html.includes('data-shape-id="shape:arrow-q"'), 'the arrow on the current page is drawn')
  assert.ok(!html.includes('data-shape-id="shape:arrow-p"'), 'the arrow on another page is not drawn')
  console.log('ok: Arrows draws only arrows on the current page')
}
```

Replace `makeDocument({...} as never)` and `buildIndexFor(doc)` with whatever this test file already uses to build a `CanvasDocument` and its `SpatialIndex` for the existing Arrows cases — do not invent new helpers.

- [ ] **Step 6: Run both REDs and record the verbatim failures**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-react/src/overlay.test.ts; echo $?
cd e2e && flock /tmp/claude-1000/e2e.lock bunx playwright test --project=e2e -g "arrow-stays-on-its-page"; echo $?
```

Expected: the unit test fails on `the arrow on another page is not drawn`; the contract fails with `expected no arrow drawn on the newly created page, got renderedArrowIds() ["shape:…"]`. If either fails for any other reason (load error, locator timeout), fix the wiring until the assertion itself fails. Record both outputs in the commit message.

- [ ] **Step 7: Implement the filter**

In `canvas-react/src/overlay/Arrows.tsx`:

1. Add to the existing `@ensembleworks/canvas-model` import: `pageIdOf`.
2. Add to `ArrowsProps`:

```ts
  /** The page being viewed. When set, only arrows whose parent chain resolves
   * to this page are drawn (same rule as ShapeLayer). Unset draws every arrow,
   * for callers that render a single-page document. */
  readonly currentPageId?: string
```

3. Change the signature to destructure `currentPageId` and replace the first line of the body:

```ts
export function Arrows({ snapshot, camera, viewportSize, index, routeFn, currentPageId }: ArrowsProps) {
  const allArrows = snapshot.shapes.filter(
    (s) => s.kind === 'arrow' && (currentPageId === undefined || pageIdOf(snapshot, s) === currentPageId),
  )
```

In `canvas-react/src/Overlay.tsx`, change the Arrows element to:

```tsx
      <Arrows snapshot={snapshot} camera={camera} viewportSize={viewportSize} index={index} currentPageId={editorState.currentPageId} />
```

- [ ] **Step 8: Run to green**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun canvas-react/src/overlay.test.ts; echo $?
bun canvas-editor/src/contracts/library.test.ts; echo $?
bun run typecheck; echo $?
cd e2e && flock /tmp/claude-1000/e2e.lock bunx playwright test --project=e2e tests/contracts.spec.ts tests/canvas-v2.spec.ts; echo $?
```

Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add canvas-react/src/overlay/Arrows.tsx canvas-react/src/Overlay.tsx canvas-react/src/overlay.test.ts interaction-contracts/src e2e/lib/contracts.ts canvas-editor/src/contracts/fsm-runner.ts
git commit -m "fix(canvas-react): draw arrows only on the current page

RED (unit): <paste>
RED (contract arrow-stays-on-its-page): <paste>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Move pure session logic into `canvas-editor/src/session/`

Behaviour-preserving move of the web app's pure modules, plus the duplicated undo-repair helpers.

**Files:**
- Create (via `git mv`): `canvas-editor/src/session/{tool-loop,tool-shortcut,clipboard-shortcut,reorder-shortcut,style-axes}.ts` and their `.test.ts`
- Create: `canvas-editor/src/session/history.ts`, `canvas-editor/src/session/history.test.ts`, `canvas-editor/src/session/index.ts`
- Modify: `canvas-editor/src/index.ts`
- Modify: `client/src/canvas-v2/CanvasV2App.tsx`, `client/src/canvas-v2/StylePanel.tsx`, `client/src/canvas-v2/StylePanel.test.ts`, `client/src/canvas-v2/StylePanel.position.test.ts`, `client/src/canvas-v2/style-icons.test.ts`, `client/src/canvas-v2/CanvasV2App.test.ts`, `client/src/canvas-v2/page-switcher-dom.ts`, `client/src/canvas-v2/page-switcher-dom.test.ts`, `client/src/canvas-v2/PageSwitcher.tsx` (only if it imports `clampCurrentPageIntents`)
- Delete (via `git mv`): `client/src/canvas-v2/{tool-loop,tool-shortcut,clipboard-dom,reorder-dom,style-axes}.ts` and tests

**Interfaces:**
- Produces (all exported from `@ensembleworks/canvas-editor`):
  - `type ToolId = 'select' | 'hand' | 'note' | 'text' | 'geo' | 'frame' | 'arrow' | 'draw' | 'line'`
  - `interface ToolSet`, `type ToolStates`, `createToolSet(ctx: ToolContext): ToolSet`, `createInitialToolStates(tools: ToolSet): ToolStates`, `currentSnapResult(states: ToolStates, active: ToolId): SnapResult | undefined`, `dispatchToActiveTool(tools, states, active, editor, event): ToolStates`, `shouldFallBackToSelect(active, editingIdBefore, editingIdAfter): boolean`, `deleteSelectionIntents(editor): Intent[]`, `pruneDanglingSelectionIntents(editor): Intent[]`, `cancelActiveTool(tools, states, active, editor): { states: ToolStates; intents: Intent[] }`
  - `interface ToolShortcut { toolId: ToolId; armGeo?: string }`, `toolShortcut(event: KeyInputEvent, editingId: string | null): ToolShortcut | null`, `TOOL_SHORTCUT_LABEL: Partial<Record<ToolId, string>>`
  - `type ClipboardAction = 'copy' | 'cut' | 'paste' | 'duplicate'`, `clipboardShortcut(event, editingId): { action: ClipboardAction } | null`
  - `reorderShortcut(event, editingId): { op: ReorderOp } | null`
  - everything `style-axes.ts` exports today (`STYLE_VALUE_SETS`, `type StyleAxis`, `type StyleValue`, `relevantAxes`, `relevantAxesForTool`, `currentValue`, `kindDefault`, `kindForTool`, …) plus `buildSetStyleIntent(ids: readonly string[], axis: StyleAxis, value: StyleValue): SetStyle`
  - `clampCurrentPageIntents(editor): Intent[]`, `historyRepairIntents(editor): Intent[]`, `undoWithRepair(editor): void`, `redoWithRepair(editor): void`

- [ ] **Step 1: Move the files**

```bash
mkdir -p canvas-editor/src/session
git mv client/src/canvas-v2/tool-loop.ts canvas-editor/src/session/tool-loop.ts
git mv client/src/canvas-v2/tool-loop.test.ts canvas-editor/src/session/tool-loop.test.ts
git mv client/src/canvas-v2/tool-shortcut.ts canvas-editor/src/session/tool-shortcut.ts
git mv client/src/canvas-v2/tool-shortcut.test.ts canvas-editor/src/session/tool-shortcut.test.ts
git mv client/src/canvas-v2/clipboard-dom.ts canvas-editor/src/session/clipboard-shortcut.ts
git mv client/src/canvas-v2/clipboard-dom.test.ts canvas-editor/src/session/clipboard-shortcut.test.ts
git mv client/src/canvas-v2/reorder-dom.ts canvas-editor/src/session/reorder-shortcut.ts
git mv client/src/canvas-v2/reorder-dom.test.ts canvas-editor/src/session/reorder-shortcut.test.ts
git mv client/src/canvas-v2/style-axes.ts canvas-editor/src/session/style-axes.ts
git mv client/src/canvas-v2/style-axes.test.ts canvas-editor/src/session/style-axes.test.ts
```

- [ ] **Step 2: Make the moved modules clean-room**

In every moved `.ts` and `.test.ts` under `canvas-editor/src/session/`:

1. Replace `from '@ensembleworks/canvas-editor'` with relative imports of the defining module (for example `KeyInputEvent` from `'../input.js'`, `ReorderOp` from `'../reorder-intents.js'`, `Editor` from `'../editor.js'`, `Intent`/`SetStyle` from `'../intents.js'`, `ToolContext` from `'../tools/tool-context.js'`, `createSelectAndTransformTool` from `'../tools/select-and-transform.js'`, the create/hand/arrow/draw/line tools from `'../tools/<name>.js'`). Find each symbol's defining file with `grep -rn "export .*<Symbol>" canvas-editor/src`.
2. In `tool-loop.ts`, delete the line `export { createSelectAndTransformTool, type SelectAndTransformState } from '@ensembleworks/canvas-editor'` (the package already exports both).
3. In `clipboard-shortcut.ts`, delete `writeClipboardText` and `readClipboardText` (they touch `navigator.clipboard`; the host port replaces them in Task 5). Keep the two functions for the web app by moving them, unchanged, into a new `client/src/canvas-v2/clipboard-dom.ts` containing only:

```ts
export async function writeClipboardText(text: string): Promise<void> {
	await navigator.clipboard.writeText(text)
}

export async function readClipboardText(): Promise<string> {
	return navigator.clipboard.readText()
}
```

4. In the moved `clipboard-shortcut.test.ts` and `reorder-shortcut.test.ts`, update the `import` paths to `./clipboard-shortcut.js` / `./reorder-shortcut.js`; delete any assertion that exercised `writeClipboardText`/`readClipboardText`.
5. Rewrite comments that mention `window.`, `document.`, `Date.now(` or `Math.random(` literally (the boundary test scans comments).
6. Move `buildSetStyleIntent` from `client/src/canvas-v2/CanvasV2App.tsx` (its whole function with doc comment) to the end of `canvas-editor/src/session/style-axes.ts`, importing `SetStyle` from `'../intents.js'`.

- [ ] **Step 3: Create `history.ts`**

Create `canvas-editor/src/session/history.ts`:

```ts
// Undo/redo plus the repair both hosts need afterwards: history can strand a
// selection on deleted shapes, or leave currentPageId pointing at a page the
// undo removed. Previously duplicated in client/src/canvas-v2 and
// plugins/canvas/canvas/pages.
import { canonicalPageId } from '@ensembleworks/canvas-model'
import type { Editor } from '../editor.js'
import type { Intent } from '../intents.js'
import { pruneDanglingSelectionIntents } from './tool-loop.js'

/** A SetCurrentPage back to the canonical page when currentPageId no longer
 * names a page in the doc; otherwise nothing. */
export function clampCurrentPageIntents(editor: Editor): Intent[] {
  const pages = editor.doc.listPages()
  const current = editor.get().currentPageId
  if (pages.some((p) => p.id === current)) return []
  const canonical = canonicalPageId(pages)
  if (canonical === undefined) return []
  return [{ type: 'SetCurrentPage', pageId: canonical }]
}

/** Everything a history move can strand: dangling selection ids, then a
 * dangling current page. */
export function historyRepairIntents(editor: Editor): Intent[] {
  return [...pruneDanglingSelectionIntents(editor), ...clampCurrentPageIntents(editor)]
}

function applyRepair(editor: Editor): void {
  const repair = historyRepairIntents(editor)
  if (repair.length > 0) editor.applyAll(repair)
}

export function undoWithRepair(editor: Editor): void {
  editor.undo()
  applyRepair(editor)
}

export function redoWithRepair(editor: Editor): void {
  editor.redo()
  applyRepair(editor)
}
```

Create `canvas-editor/src/session/history.test.ts` by porting, as node:assert scripts, the behaviour cases (not the source-text guards) of `plugins/canvas/tests/page-history-repair.test.ts` (`describe("historyRepairIntents — the page half")`, `"— the selection half is still there"`, `"undoWithRepair / redoWithRepair — the move and the repair are one call"`) and the `clampCurrentPageIntents` cases of `client/src/canvas-v2/page-switcher-dom.test.ts`. Build editors the way `canvas-editor/src/undo.test.ts` does (`LoroCanvasDoc.create({ peerId })`, `new Editor({ doc, now, random, pageId })`). End each block with `console.log('ok: …')`.

- [ ] **Step 4: Create `session/index.ts` and export it**

Create `canvas-editor/src/session/index.ts`:

```ts
export * from './tool-loop.js'
export * from './tool-shortcut.js'
export * from './clipboard-shortcut.js'
export * from './reorder-shortcut.js'
export * from './style-axes.js'
export * from './history.js'
```

In `canvas-editor/src/index.ts`, append `export * from './session/index.js'`.

- [ ] **Step 5: Run the moved tests and the boundary test**

```bash
export PATH="$HOME/.bun/bin:$PATH"
for f in canvas-editor/src/session/*.test.ts canvas-editor/src/boundary.test.ts; do bun "$f" || echo "FAIL $f"; done
```

Expected: no `FAIL` lines. A failure here is a move defect; fix imports, not assertions.

- [ ] **Step 6: Point the web app at `canvas-editor`**

1. In `client/src/canvas-v2/CanvasV2App.tsx`, `StylePanel.tsx`, `StylePanel.test.ts`, `StylePanel.position.test.ts`, `style-icons.test.ts`, `CanvasV2App.test.ts`: replace imports from `./tool-loop.js`, `./tool-shortcut.js`, `./reorder-dom.js`, `./style-axes.js` with the same names from `@ensembleworks/canvas-editor`; replace `clipboardShortcut` from `./clipboard-dom.js` with `@ensembleworks/canvas-editor` (keep `readClipboardText`/`writeClipboardText` from `./clipboard-dom.js`).
2. `CanvasV2App.test.ts` reads `buildSetStyleIntent` from `./CanvasV2App.js`; change it to import from `@ensembleworks/canvas-editor`.
3. In `client/src/canvas-v2/page-switcher-dom.ts`, delete the local `clampCurrentPageIntents` and its doc comment, and remove now-unused imports. In `page-switcher-dom.test.ts`, delete the `clampCurrentPageIntents` block (ported in Step 3). Update any remaining importer of `clampCurrentPageIntents` to `@ensembleworks/canvas-editor`.
4. In `CanvasV2App.tsx`'s undo/redo branches, replace the `editor.undo()` + prune + clamp sequence with `undoWithRepair(editor)`, and the redo sequence with `redoWithRepair(editor)`.

- [ ] **Step 7: Verify nothing else imports the old paths**

```bash
grep -rn "canvas-v2/\(tool-loop\|tool-shortcut\|reorder-dom\|style-axes\)\|'\./\(tool-loop\|tool-shortcut\|reorder-dom\|style-axes\)\.js'" client/src e2e interaction-contracts || echo "clean"
```

Expected: `clean`.

- [ ] **Step 8: Full verification**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck; echo $?
export UX_CONTRACT_PR_BODY='ux-contract: none — behaviour-preserving move of pure session logic into canvas-editor'
bun run test; echo $?
cd e2e && flock /tmp/claude-1000/e2e.lock bunx playwright test --project=e2e tests/contracts.spec.ts tests/canvas-v2.spec.ts; echo $?
```

Expected: typecheck 0; `bun run test` fails only on the known loopback files (run the rest individually, all 0); Playwright 0.

- [ ] **Step 9: Commit**

```bash
git add -A canvas-editor/src client/src/canvas-v2
git commit -m "refactor(canvas-editor): move pure session logic out of the web app

ux-contract: none — behaviour-preserving move of pure session logic into canvas-editor

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: One keyboard resolver for every host

**Files:**
- Create: `canvas-editor/src/session/keyboard.ts`, `canvas-editor/src/session/keyboard.test.ts`
- Modify: `canvas-editor/src/session/index.ts`
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`handleGlobalShortcut`)

**Interfaces:**
- Consumes: `toolShortcut`, `clipboardShortcut`, `reorderShortcut`, `ClipboardAction`, `ToolShortcut` (Task 2).
- Produces: `type ShortcutCommand`, `resolveShortcut(event: KeyInputEvent, editingId: string | null): ShortcutCommand | null`.

- [ ] **Step 1: Write the failing test**

Create `canvas-editor/src/session/keyboard.test.ts`:

```ts
// Run: bun src/session/keyboard.test.ts
import assert from 'node:assert/strict'
import type { KeyInputEvent } from '../input.js'
import { resolveShortcut } from './keyboard.js'

const NONE = { shift: false, alt: false, ctrl: false, meta: false }
const key = (k: string, mods: Partial<typeof NONE> = {}): KeyInputEvent => ({ type: 'keydown', key: k, modifiers: { ...NONE, ...mods }, t: 0 })

const cases: ReadonlyArray<readonly [KeyInputEvent, ReturnType<typeof resolveShortcut>]> = [
  [key('Escape'), { type: 'cancel' }],
  [key('Delete'), { type: 'delete' }],
  [key('Backspace'), { type: 'delete' }],
  [key('z', { ctrl: true }), { type: 'undo' }],
  [key('z', { meta: true }), { type: 'undo' }],
  [key('Z', { ctrl: true, shift: true }), { type: 'redo' }],
  [key('y', { ctrl: true }), { type: 'redo' }],
  [key('c', { ctrl: true }), { type: 'clipboard', action: 'copy' }],
  [key('x', { meta: true }), { type: 'clipboard', action: 'cut' }],
  [key('v', { ctrl: true }), { type: 'clipboard', action: 'paste' }],
  [key('d', { ctrl: true }), { type: 'clipboard', action: 'duplicate' }],
  [key(']'), { type: 'reorder', op: 'forward' }],
  [key('{'), { type: 'reorder', op: 'toBack' }],
  [key('a', { ctrl: true }), { type: 'selectAll' }],
  [key('n'), { type: 'tool', shortcut: { toolId: 'note' } }],
  [key('R', { shift: true }), { type: 'tool', shortcut: { toolId: 'geo', armGeo: 'rectangle' } }],
  [key('v'), { type: 'tool', shortcut: { toolId: 'select' } }],
  [key('q'), null],
  [key('ArrowRight'), null],
]
for (const [event, expected] of cases) {
  assert.deepEqual(resolveShortcut(event, null), expected, `${JSON.stringify(event.key)} ${JSON.stringify(event.modifiers)}`)
}
console.log('ok: resolveShortcut maps every host shortcut to one command')

for (const [event] of cases) {
  assert.equal(resolveShortcut(event, 'shape:editing'), null, `no shortcut fires while text-editing: ${event.key}`)
}
console.log('ok: resolveShortcut is silent while a shape is being text-edited')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH"; bun canvas-editor/src/session/keyboard.test.ts; echo $?`
Expected: FAIL with `Cannot find module './keyboard.js'` — a load failure. Create `keyboard.ts` exporting `export function resolveShortcut(): null { return null }` and re-run; expected: `AssertionError` on the `"Escape"` case. Record that assertion failure.

- [ ] **Step 3: Implement**

Replace `canvas-editor/src/session/keyboard.ts` with:

```ts
// The single decision "what does this keydown mean for the canvas?", shared by
// every host. Order matters and matches the web app's original handler:
// cancel, delete, undo, redo, clipboard, z-order, select-all, tool letters.
// Every branch is silent while a shape is being text-edited — the text editor
// owns the keyboard then.
import type { KeyInputEvent } from '../input.js'
import type { ReorderOp } from '../reorder-intents.js'
import { clipboardShortcut, type ClipboardAction } from './clipboard-shortcut.js'
import { reorderShortcut } from './reorder-shortcut.js'
import { toolShortcut, type ToolShortcut } from './tool-shortcut.js'

export type ShortcutCommand =
  | { readonly type: 'cancel' }
  | { readonly type: 'delete' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'clipboard'; readonly action: ClipboardAction }
  | { readonly type: 'reorder'; readonly op: ReorderOp }
  | { readonly type: 'selectAll' }
  | { readonly type: 'tool'; readonly shortcut: ToolShortcut }

export function resolveShortcut(event: KeyInputEvent, editingId: string | null): ShortcutCommand | null {
  if (editingId !== null) return null
  if (event.key === 'Escape') return { type: 'cancel' }
  if (event.key === 'Delete' || event.key === 'Backspace') return { type: 'delete' }
  const key = event.key.toLowerCase()
  const withModifier = event.modifiers.ctrl || event.modifiers.meta
  if (withModifier && key === 'z' && !event.modifiers.shift) return { type: 'undo' }
  if ((withModifier && key === 'z' && event.modifiers.shift) || (event.modifiers.ctrl && key === 'y')) return { type: 'redo' }
  const clip = clipboardShortcut(event, editingId)
  if (clip) return { type: 'clipboard', action: clip.action }
  const reorder = reorderShortcut(event, editingId)
  if (reorder) return { type: 'reorder', op: reorder.op }
  if (withModifier && key === 'a') return { type: 'selectAll' }
  const tool = toolShortcut(event, editingId)
  if (tool) return { type: 'tool', shortcut: tool }
  return null
}
```

Append `export * from './keyboard.js'` to `canvas-editor/src/session/index.ts`.

- [ ] **Step 4: Run to green**

Run: `bun canvas-editor/src/session/keyboard.test.ts; echo $?` and `bun canvas-editor/src/boundary.test.ts; echo $?`
Expected: both 0.

- [ ] **Step 5: Web app uses the resolver**

In `client/src/canvas-v2/CanvasV2App.tsx`, replace the body of `handleGlobalShortcut` with a `switch` over `resolveShortcut(event, editingId)` that performs exactly the actions of today's branches (cancel → `cancelAndReset(); selectTool('select')`; delete; `undoWithRepair`/`redoWithRepair`; the four clipboard actions with their existing `.catch(() => {})`; reorder; select-all; tool switch + `SetNextStyle` for `armGeo`), returning `true` for any non-null command and `false` for `null`. In the document-level keydown listener, replace `clipboardShortcut(keyEvent, editingId)` with `resolveShortcut(keyEvent, editingId)?.type === 'clipboard'`. Remove imports that become unused.

- [ ] **Step 6: Verify and commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck; echo $?
bun client/src/canvas-v2/CanvasV2App.test.ts; echo $?
cd e2e && flock /tmp/claude-1000/e2e.lock bunx playwright test --project=e2e tests/contracts.spec.ts tests/canvas-v2.spec.ts; echo $?
cd .. && git add canvas-editor/src/session client/src/canvas-v2/CanvasV2App.tsx
git commit -m "feat(canvas-editor): one keyboard resolver for canvas shortcuts

RED: <paste the Escape-case AssertionError>
ux-contract: none — web app behaviour unchanged; resolver is pure and unit-tested

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Expected: all three commands exit 0 before committing.

---

### Task 4: Create `canvas-ui` with the themed StylePanel and icon Toolbar

**Files:**
- Create: `canvas-ui/package.json`, `canvas-ui/tsconfig.json`, `canvas-ui/test.ts`, `canvas-ui/src/index.ts`, `canvas-ui/src/theme.ts`, `canvas-ui/src/tool-icons.tsx`, `canvas-ui/src/Toolbar.tsx`, `canvas-ui/src/toolbar.test.ts`
- Move: `client/src/canvas-v2/{StylePanel.tsx,StylePanel.test.ts,StylePanel.position.test.ts,style-icons.tsx,style-icons.test.ts}` → `canvas-ui/src/`
- Modify: `package.json` (root `workspaces`, `typecheck` script), `client/package.json`, `client/tsconfig.json`, `client/src/canvas-v2/CanvasV2App.tsx`, `scripts/ux-contract-presence.test.ts`, `CLAUDE.md`
- Modify (selector rename): every file under `e2e/`, `interaction-contracts/`, `client/src/` containing `data-canvas-v2-tool`

**Interfaces:**
- Consumes: `ToolId`, `TOOL_SHORTCUT_LABEL`, style-axes exports (Task 2).
- Produces: `UI_VARS` (theme.ts), `ToolIcon({ tool }: { tool: ToolId })`, `TOOL_ORDER: readonly { id: ToolId; label: string }[]`, `Toolbar(props: ToolbarProps)` with `ToolbarProps { activeToolId: ToolId; onSelectTool(id: ToolId): void; style?: CSSProperties }`, `StylePanel` and `StylePanelProps` (unchanged props).

- [ ] **Step 1: Scaffold the package**

`canvas-ui/package.json`:

```json
{
  "name": "@ensembleworks/canvas-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "bunx tsc --noEmit",
    "test": "bun test.ts"
  },
  "dependencies": {
    "@ensembleworks/canvas-editor": "*",
    "@ensembleworks/canvas-model": "*",
    "@ensembleworks/canvas-react": "*"
  },
  "peerDependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "bun-types": "1.3.14",
    "happy-dom": "^20.10.6",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^5.7.0"
  }
}
```

Copy `canvas-react/tsconfig.json` to `canvas-ui/tsconfig.json` unchanged, and `canvas-react/test.ts` to `canvas-ui/test.ts` with its header comment's package name changed to canvas-ui.

Root `package.json`: add `"canvas-ui"` to `workspaces` after `"canvas-react"`, and insert `bun run --filter '@ensembleworks/canvas-ui' typecheck && ` after the canvas-react typecheck in the `typecheck` script. `client/package.json`: add `"@ensembleworks/canvas-ui": "*"` to `dependencies`. `client/tsconfig.json`: add `"@ensembleworks/canvas-ui": ["../canvas-ui/src/index.ts"]` to `paths`. Then run `export PATH="$HOME/.bun/bin:$PATH"; bun install`.

- [ ] **Step 2: Define the theme vocabulary**

`canvas-ui/src/theme.ts`:

```ts
// The only styling vocabulary canvas-ui chrome reads. Each host maps its own
// theme onto these custom properties; the fallbacks are the web app's current
// look, so a host that maps nothing renders exactly as before. Document
// content colours (shape colours, colour swatches) are never themed here.
export const UI_VARS = {
  panelBg: 'var(--canvas-ui-panel-bg, #fafaf7)',
  panelFg: 'var(--canvas-ui-panel-fg, #0f172a)',
  panelMuted: 'var(--canvas-ui-panel-muted, #475569)',
  panelBorder: 'var(--canvas-ui-panel-border, rgba(15,23,42,0.14))',
  controlBorder: 'var(--canvas-ui-control-border, rgba(15,23,42,0.22))',
  accent: 'var(--canvas-ui-accent, #004990)',
  accentFg: 'var(--canvas-ui-accent-fg, #fafaf7)',
  accentSoft: 'var(--canvas-ui-accent-soft, #dbe6fb)',
} as const

export type UiVar = keyof typeof UI_VARS
```

- [ ] **Step 3: Move and theme the StylePanel**

```bash
git mv client/src/canvas-v2/StylePanel.tsx canvas-ui/src/StylePanel.tsx
git mv client/src/canvas-v2/StylePanel.test.ts canvas-ui/src/StylePanel.test.ts
git mv client/src/canvas-v2/StylePanel.position.test.ts canvas-ui/src/StylePanel.position.test.ts
git mv client/src/canvas-v2/style-icons.tsx canvas-ui/src/style-icons.tsx
git mv client/src/canvas-v2/style-icons.test.ts canvas-ui/src/style-icons.test.ts
```

In the moved files: point imports of style-axes/tool-loop symbols at `@ensembleworks/canvas-editor`. Then replace every hardcoded chrome colour literal in `StylePanel.tsx` and `style-icons.tsx` with a `UI_VARS` entry whose fallback equals the literal it replaces:

| Literal today | Replace with |
|---|---|
| `'#fafaf7'` (panel background) | `UI_VARS.panelBg` |
| `'#0f172a'` | `UI_VARS.panelFg` |
| `'#475569'` | `UI_VARS.panelMuted` |
| `'#004990'` | `UI_VARS.accent` |
| `'#dbe6fb'` | `UI_VARS.accentSoft` |
| `rgba(15,23,42,0.14)` | `UI_VARS.panelBorder` |
| `rgba(15,23,42,0.22)` | `UI_VARS.controlBorder` |

For each remaining chrome literal (`rgba(15,23,42,0.18)`, `rgba(15,23,42,0.25)`, `rgba(15,23,42,0.4)`, `'#94a3b8'`), read its use site: if it is a shadow, divider or disabled tint, add one new `UI_VARS` entry named for that role (for example `shadow: 'var(--canvas-ui-shadow, 0 … rgba(15,23,42,0.18))'`) whose fallback is exactly the current full value. Swatch fill colours (`COLOR_SWATCH_HEX`, `GEO_COLORS`) stay literal. Where a moved test asserts an exact colour string, update it to the `var(…)` string — the rendered colour is unchanged.

- [ ] **Step 4: Write the failing Toolbar test**

`canvas-ui/src/toolbar.test.ts`:

```ts
// Run: bun src/toolbar.test.ts
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Toolbar, TOOL_ORDER } from './Toolbar.js'

const html = renderToStaticMarkup(createElement(Toolbar, { activeToolId: 'note', onSelectTool: () => {} }))

assert.deepEqual(TOOL_ORDER.map((t) => t.id), ['select', 'hand', 'note', 'text', 'geo', 'frame', 'arrow', 'draw', 'line'])
assert.ok(html.includes('role="toolbar"'), 'the toolbar is an ARIA toolbar')
for (const { id } of TOOL_ORDER) {
  assert.ok(html.includes(`data-canvas-tool="${id}"`), `renders a button for ${id}`)
}
assert.match(html, /data-canvas-tool="note"[^>]*aria-pressed="true"/, 'the active tool is pressed')
assert.match(html, /data-canvas-tool="select"[^>]*aria-pressed="false"/, 'inactive tools are not pressed')
assert.ok(html.includes('title="Note (N)"'), 'tooltip names the shortcut letter')
assert.ok(html.includes('title="Shape (R)"'), 'geo shows its first shortcut letter')
assert.equal((html.match(/<svg/g) ?? []).length, 9, 'every button renders an icon')
assert.ok(!/>\s*Note\s*</.test(html), 'buttons show icons, not text labels')
console.log('ok: Toolbar renders nine icon buttons with pressed state and shortcut tooltips')
```

Run: `export PATH="$HOME/.bun/bin:$PATH"; bun canvas-ui/src/toolbar.test.ts; echo $?`
Expected: FAIL (`Cannot find module './Toolbar.js'`). Create a stub `Toolbar.tsx` exporting `export const TOOL_ORDER = [] as const; export function Toolbar() { return null }`, re-run, and record the resulting `AssertionError`.

- [ ] **Step 5: Implement the icons and Toolbar**

`canvas-ui/src/tool-icons.tsx`:

```tsx
import type { ReactNode } from 'react'
import type { ToolId } from '@ensembleworks/canvas-editor'

const PATHS: Record<ToolId, ReactNode> = {
  select: <path d="M6 3l12 9-5.5 1.2L9.5 19z" />,
  hand: <path d="M8 13V6a1.5 1.5 0 013 0v5m0-6.5a1.5 1.5 0 013 0V11m0-5a1.5 1.5 0 013 0v7.5c0 4-2.5 6.5-6 6.5-3 0-4.5-1.5-6-4l-2-3.5a1.5 1.5 0 012.6-1.5L8 13" />,
  note: <><path d="M5 4h14v10l-5 6H5z" /><path d="M14 20v-6h5" /></>,
  text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  geo: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  frame: <path d="M8 3v18M16 3v18M3 8h18M3 16h18" />,
  arrow: <path d="M5 19L19 5M10 5h9v9" />,
  draw: <path d="M4 17c2.5-5 4.5 1.5 7.5-3.5S15.5 7 20 6" />,
  line: <><path d="M6.5 17.5l11-11" /><circle cx="5.5" cy="18.5" r="1.5" /><circle cx="18.5" cy="5.5" r="1.5" /></>,
}

export function ToolIcon({ tool }: { readonly tool: ToolId }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[tool]}
    </svg>
  )
}
```

`canvas-ui/src/Toolbar.tsx`:

```tsx
import type { CSSProperties } from 'react'
import { TOOL_SHORTCUT_LABEL, type ToolId } from '@ensembleworks/canvas-editor'
import { ToolIcon } from './tool-icons.js'
import { UI_VARS } from './theme.js'

export const TOOL_ORDER: readonly { readonly id: ToolId; readonly label: string }[] = [
  { id: 'select', label: 'Select' },
  { id: 'hand', label: 'Hand' },
  { id: 'note', label: 'Note' },
  { id: 'text', label: 'Text' },
  { id: 'geo', label: 'Shape' },
  { id: 'frame', label: 'Frame' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'draw', label: 'Draw' },
  { id: 'line', label: 'Line' },
]

export interface ToolbarProps {
  readonly activeToolId: ToolId
  readonly onSelectTool: (id: ToolId) => void
  /** Merged over the toolbar's own container style — hosts use it for placement. */
  readonly style?: CSSProperties
}

const containerStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 2,
  padding: 4,
  borderRadius: 8,
  background: UI_VARS.panelBg,
  border: `1px solid ${UI_VARS.panelBorder}`,
}

function buttonStyle(active: boolean): CSSProperties {
  return {
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    background: active ? UI_VARS.accent : 'transparent',
    color: active ? UI_VARS.accentFg : UI_VARS.panelFg,
  }
}

export function Toolbar({ activeToolId, onSelectTool, style }: ToolbarProps) {
  return (
    <div role="toolbar" aria-label="Canvas tools" data-canvas-toolbar style={{ ...containerStyle, ...style }}>
      {TOOL_ORDER.map(({ id, label }) => {
        const shortcut = TOOL_SHORTCUT_LABEL[id]
        const title = shortcut ? `${label} (${shortcut})` : label
        const active = activeToolId === id
        return (
          <button
            key={id}
            type="button"
            data-canvas-tool={id}
            aria-pressed={active}
            aria-label={title}
            title={title}
            onClick={() => onSelectTool(id)}
            style={buttonStyle(active)}
          >
            <ToolIcon tool={id} />
          </button>
        )
      })}
    </div>
  )
}
```

`canvas-ui/src/index.ts`:

```ts
export * from './theme.js'
export * from './tool-icons.js'
export * from './Toolbar.js'
export * from './StylePanel.js'
export * from './style-icons.js'
```

- [ ] **Step 6: Run canvas-ui tests to green**

```bash
export PATH="$HOME/.bun/bin:$PATH"
(cd canvas-ui && bun test.ts); echo $?
```

Expected: 0.

- [ ] **Step 7: Web app mounts the shared Toolbar and StylePanel; rename the tool attribute**

1. In `client/src/canvas-v2/CanvasV2App.tsx`: import `Toolbar` and `StylePanel` (and `StyleAxis`, `StyleValue` types if still referenced) from `@ensembleworks/canvas-ui`; delete `TOOL_BUTTONS` and the inline toolbar `<div>…{TOOL_BUTTONS.map(…)}</div>`, replacing it with:

```tsx
			<div style={{ display: 'flex', padding: 6, borderBottom: '1px solid rgba(15,23,42,0.12)', background: '#fafaf7' }}>
				<Toolbar activeToolId={activeToolId} onSelectTool={selectTool} />
			</div>
```

2. Rename the attribute everywhere else:

```bash
grep -rl 'data-canvas-v2-tool' e2e interaction-contracts client/src canvas-editor/src | xargs sed -i 's/data-canvas-v2-tool/data-canvas-tool/g'
grep -rn 'data-canvas-v2-tool' e2e interaction-contracts client/src canvas-editor/src canvas-ui/src || echo "renamed"
```

Expected: `renamed`. Tests that located a tool button by its visible text label now locate it by `data-canvas-tool` or by `aria-label` (`"Note (N)"`).

- [ ] **Step 8: Gate the new interaction-bearing paths**

In `scripts/ux-contract-presence.test.ts`, change `INTERACTION_BEARING_PREFIXES` to:

```ts
const INTERACTION_BEARING_PREFIXES = ['canvas-editor/src/tools/', 'canvas-editor/src/session/', 'canvas-react/src/', 'canvas-ui/src/', 'client/src/canvas-v2/'] as const
```

Add one test case in that file, following the existing pattern, asserting `checkPresence(['canvas-ui/src/Toolbar.tsx'], '')` returns a violation naming the file.

In `CLAUDE.md`: add `canvas-ui` to the workspace list, add one sentence after the canvas-react description — "`canvas-ui` (host-agnostic React canvas chrome: session hook, surface, toolbar, style panel) is mounted by both the web app's v2 mount and the bb Canvas plugin; it holds no transport or host code." — and add `canvas-editor/src/session/` and `canvas-ui/src/` to the interaction-bearing paths listed under "Interaction contracts".

- [ ] **Step 9: Full verification and commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck; echo $?
export UX_CONTRACT_PR_BODY='ux-contract: none — StylePanel moved unchanged; toolbar swaps text labels for icons with identical behaviour'
bun run test; echo $?
cd e2e && flock /tmp/claude-1000/e2e.lock bunx playwright test --project=e2e; echo $?
cd .. && git add -A canvas-ui package.json bun.lock client e2e interaction-contracts canvas-editor/src scripts/ux-contract-presence.test.ts CLAUDE.md
git commit -m "feat(canvas-ui): shared themed StylePanel and icon Toolbar

RED: <paste the Toolbar AssertionError>
ux-contract: none — StylePanel moved unchanged; toolbar swaps text labels for icons with identical behaviour

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Expected before committing: typecheck 0; unit suite green apart from the known loopback files; full Playwright lane 0 (visual goldens and parity included). If the lock file is named `bun.lockb` in this repo, add that name instead.

---

### Task 5: Shared session hook, `CanvasSurface`, host port and fonts; web app adopts them

**Files:**
- Create: `canvas-ui/src/host.ts`, `canvas-ui/src/use-canvas-session.ts`, `canvas-ui/src/CanvasSurface.tsx`, `canvas-ui/src/fonts.ts`, `canvas-ui/src/canvas-surface.test.ts`, `canvas-ui/src/fonts.test.ts`
- Modify: `canvas-ui/src/index.ts`
- Modify: `client/src/canvas-v2/CanvasV2App.tsx` (`CanvasV2Session`)
- Delete: `client/src/canvas-v2/fonts.css` (after `goldens/GoldenHarness.tsx` switches to `CanvasFonts`)

**Interfaces:**
- Consumes: everything Task 2–4 produce.
- Produces:

```ts
// host.ts
export interface CanvasHost {
  readonly clipboard: { read(): Promise<string>; write(text: string): Promise<void> }
  readonly notify: (message: string) => void
  readonly onCursorScreen: (point: { readonly x: number; readonly y: number }) => void
}

// use-canvas-session.ts
export interface UseCanvasSessionOptions {
  readonly editor: Editor
  readonly toolContext: ToolContext
  readonly tools: ToolSet
  readonly host: CanvasHost
  readonly keyboardScopeRef: RefObject<HTMLElement | null>
  readonly viewportContainerRef: RefObject<HTMLElement | null>
}
export interface CanvasSession {
  readonly editor: Editor
  readonly toolContext: ToolContext
  readonly activeToolId: ToolId
  readonly toolStates: ToolStates
  readonly isGesturing: boolean
  readonly selectTool: (id: ToolId) => void
  readonly cancelAndReset: () => void
  readonly handleInput: (event: InputEvent) => boolean | void
  readonly dispatch: (intents: Intent[]) => void
  readonly onStyleChange: StylePanelProps['onStyleChange']
  readonly onArmStyle: StylePanelProps['onArmStyle']
}
export function useCanvasSession(options: UseCanvasSessionOptions): CanvasSession

// CanvasSurface.tsx
export interface CanvasSurfaceProps {
  readonly session: CanvasSession
  readonly editorState: EditorState
  readonly snapshot: CanvasDocument
  readonly viewportSize: ViewportSize
  readonly worldLayers?: ReactNode
  readonly overlays?: ReactNode
}
export function CanvasSurface(props: CanvasSurfaceProps): ReactNode

// fonts.ts
export function canvasFontFaceCss(baseUrl: string): string
export function CanvasFonts(props: { readonly baseUrl: string }): ReactNode
```

- [ ] **Step 1: Write the host port**

`canvas-ui/src/host.ts`:

```ts
// What a host gives the shared canvas session. Deliberately small: anything a
// host already owns (transport, presence stores, pages, embeds) stays with it.
export interface CanvasHost {
  /** System clipboard access for copy, cut and paste. */
  readonly clipboard: {
    read(): Promise<string>
    write(text: string): Promise<void>
  }
  /** Show a short user-visible message (a toast, or a console line). */
  readonly notify: (message: string) => void
  /** The pointer moved over the viewport, in viewport-local screen pixels.
   * Hosts forward it to their presence publisher. */
  readonly onCursorScreen: (point: { readonly x: number; readonly y: number }) => void
}
```

- [ ] **Step 2: Write the failing fonts test, then the fonts module**

`canvas-ui/src/fonts.test.ts`:

```ts
// Run: bun src/fonts.test.ts
import assert from 'node:assert/strict'
import { canvasFontFaceCss } from './fonts.js'

const css = canvasFontFaceCss('/fonts/tldraw')
for (const family of ['tldraw_draw', 'tldraw_sans', 'tldraw_serif', 'tldraw_mono']) {
  assert.ok(css.includes(`font-family: '${family}'`), `declares ${family}`)
}
assert.ok(css.includes("url('/fonts/tldraw/Shantell_Sans-Informal_Regular.woff2')"), 'draw font resolves under the base url')
assert.ok(!canvasFontFaceCss('/x/').includes('/x//'), 'a trailing slash on the base url is not doubled')
console.log('ok: canvasFontFaceCss declares the four canvas families under the host base url')
```

Run it: expected FAIL on the missing module; stub `export function canvasFontFaceCss(_: string) { return '' }`, re-run, record the `AssertionError`.

Implement `canvas-ui/src/fonts.ts` by porting every `@font-face` rule from `client/src/canvas-v2/fonts.css` (read it; keep each `font-family`, `font-weight`, `font-style`, `font-display` exactly) into a template string whose `url('/fonts/tldraw/<file>')` becomes `url('${base}/<file>')`:

```tsx
import { createElement } from 'react'

export function canvasFontFaceCss(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `
@font-face { font-family: 'tldraw_draw'; src: url('${base}/Shantell_Sans-Informal_Regular.woff2') format('woff2'); /* …port remaining descriptors verbatim… */ }
/* …the other three families, ported verbatim from client/src/canvas-v2/fonts.css… */
`
}

/** Renders the @font-face rules. Hosts mount it once near the canvas. */
export function CanvasFonts({ baseUrl }: { readonly baseUrl: string }) {
  return createElement('style', { 'data-canvas-fonts': '' }, canvasFontFaceCss(baseUrl))
}
```

The two `/* …port… */` comments above mark exactly what to copy from `fonts.css`; the finished file must contain four complete `@font-face` rules and no comment placeholders. Run the test to green.

- [ ] **Step 3: Write the session hook**

`canvas-ui/src/use-canvas-session.ts` — a port of the web app's `CanvasV2Session` input logic (read `client/src/canvas-v2/CanvasV2App.tsx` from `const [activeToolId` to the end of the document-level keydown `useEffect`; behaviour must match it except where noted):

```ts
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  applyWheel,
  buildSetStyleIntent,
  cancelActiveTool,
  createInitialToolStates,
  deleteSelectionIntents,
  dispatchToActiveTool,
  duplicateSelectionIntents,
  pasteIntents,
  redoWithRepair,
  reorderSelectionIntents,
  resolveShortcut,
  selectAllIntents,
  shouldFallBackToSelect,
  undoWithRepair,
  type Editor,
  type InputEvent,
  type Intent,
  type KeyInputEvent,
  type ShortcutCommand,
  type StyleAxis,
  type StyleValue,
  type ToolContext,
  type ToolId,
  type ToolSet,
  type ToolStates,
} from '@ensembleworks/canvas-editor'
import { encodeClipboard, serializeSelection } from '@ensembleworks/canvas-model'
import type { CanvasHost } from './host.js'
import type { StylePanelProps } from './StylePanel.js'

export interface UseCanvasSessionOptions {
  readonly editor: Editor
  readonly toolContext: ToolContext
  readonly tools: ToolSet
  readonly host: CanvasHost
  /** Keydowns targeting this element's descendants, or the document body,
   * are canvas shortcuts. The body counts because focus falls back to it when
   * a text edit ends; without it every shortcut dies until the user clicks. */
  readonly keyboardScopeRef: RefObject<HTMLElement | null>
  /** The element wrapping the Viewport. Keydowns inside it already arrive via
   * the Viewport's own onKeyDown, so the document listener skips them. */
  readonly viewportContainerRef: RefObject<HTMLElement | null>
}

export interface CanvasSession {
  readonly editor: Editor
  readonly toolContext: ToolContext
  readonly activeToolId: ToolId
  readonly toolStates: ToolStates
  readonly isGesturing: boolean
  readonly selectTool: (id: ToolId) => void
  readonly cancelAndReset: () => void
  readonly handleInput: (event: InputEvent) => boolean | void
  readonly dispatch: (intents: Intent[]) => void
  readonly onStyleChange: StylePanelProps['onStyleChange']
  readonly onArmStyle: StylePanelProps['onArmStyle']
}

export function isEditableTarget(node: EventTarget | null): boolean {
  const el = node as { tagName?: unknown; isContentEditable?: unknown } | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true
}

export function useCanvasSession(options: UseCanvasSessionOptions): CanvasSession {
  const { editor, toolContext, tools, host, keyboardScopeRef, viewportContainerRef } = options

  const [activeToolId, setActiveToolId] = useState<ToolId>('select')
  const activeToolIdRef = useRef(activeToolId)
  activeToolIdRef.current = activeToolId
  const [isGesturing, setIsGesturing] = useState(false)
  const [toolStates, setToolStates] = useState<ToolStates>(() => createInitialToolStates(tools))
  const toolStatesRef = useRef(toolStates)
  toolStatesRef.current = toolStates
  const hostRef = useRef(host)
  hostRef.current = host

  const dispatch = useCallback((intents: Intent[]) => editor.applyAll(intents), [editor])

  const cancelAndReset = useCallback(() => {
    const { states, intents } = cancelActiveTool(tools, toolStatesRef.current, activeToolIdRef.current, editor)
    if (intents.length > 0) editor.applyAll(intents)
    toolStatesRef.current = states
    setToolStates(states)
    setIsGesturing(false)
  }, [editor, tools])

  const selectTool = useCallback(
    (id: ToolId) => {
      cancelAndReset()
      if (activeToolIdRef.current === 'select' && id !== 'select') editor.apply({ type: 'SetHover', id: null })
      setActiveToolId(id)
    },
    [cancelAndReset, editor],
  )

  const runCommand = useCallback(
    (command: ShortcutCommand): void => {
      const apply = (intents: Intent[]) => {
        if (intents.length > 0) editor.applyAll(intents)
      }
      const clipboardFailed = () => hostRef.current.notify('Clipboard is not available')
      switch (command.type) {
        case 'cancel':
          cancelAndReset()
          selectTool('select')
          return
        case 'delete':
          apply(deleteSelectionIntents(editor))
          return
        case 'undo':
          undoWithRepair(editor)
          return
        case 'redo':
          redoWithRepair(editor)
          return
        case 'reorder':
          apply(reorderSelectionIntents(editor, command.op))
          return
        case 'selectAll':
          apply(selectAllIntents(editor))
          return
        case 'tool':
          selectTool(command.shortcut.toolId)
          if (command.shortcut.armGeo) apply([{ type: 'SetNextStyle', props: { geo: command.shortcut.armGeo } }])
          return
        case 'clipboard': {
          const selection = [...editor.get().selection]
          if (command.action === 'duplicate') {
            apply(duplicateSelectionIntents(editor))
          } else if (command.action === 'paste') {
            hostRef.current.clipboard.read().then((text) => apply(pasteIntents(editor, text)), clipboardFailed)
          } else if (selection.length > 0) {
            const payload = encodeClipboard(serializeSelection(editor.doc.listShapes(), editor.doc.listBindings(), selection))
            const deleteAfter = command.action === 'cut' ? deleteSelectionIntents(editor) : []
            hostRef.current.clipboard.write(payload).then(() => apply(deleteAfter), clipboardFailed)
          }
          return
        }
      }
    },
    [editor, cancelAndReset, selectTool],
  )

  const handleShortcut = useCallback(
    (event: KeyInputEvent): boolean => {
      const command = resolveShortcut(event, editor.get().editingId)
      if (!command) return false
      runCommand(command)
      return true
    },
    [editor, runCommand],
  )

  const dispatchToTool = useCallback(
    (event: InputEvent): void => {
      const activeBefore = activeToolIdRef.current
      const editingBefore = editor.get().editingId
      const next = dispatchToActiveTool(tools, toolStatesRef.current, activeBefore, editor, event)
      toolStatesRef.current = next
      setToolStates(next)
      if (shouldFallBackToSelect(activeBefore, editingBefore, editor.get().editingId)) setActiveToolId('select')
    },
    [editor, tools],
  )

  const handleInput = useCallback(
    (event: InputEvent): boolean | void => {
      if (event.type === 'pointerdown') setIsGesturing(true)
      if (event.type === 'pointerup') setIsGesturing(false)
      if (event.type === 'pointermove') hostRef.current.onCursorScreen({ x: event.x, y: event.y })
      if (event.type === 'wheel') {
        editor.apply({ type: 'SetCamera', ...applyWheel(editor.get().camera, event) })
        return
      }
      if (event.type === 'keydown' && handleShortcut(event)) return
      const editingBefore = editor.get().editingId
      dispatchToTool(event)
      return event.type === 'keydown' && event.key === 'Enter' && editingBefore === null && editor.get().editingId !== null
    },
    [editor, handleShortcut, dispatchToTool],
  )

  useEffect(() => {
    function onKeydown(e: KeyboardEvent): void {
      const target = e.target as Node | null
      if (isEditableTarget(target)) return
      const scope = keyboardScopeRef.current
      const body = scope?.ownerDocument.body
      const inScope = target === null || target === body || (scope !== null && scope.contains(target))
      if (!inScope) return
      const container = viewportContainerRef.current
      const keyEvent: KeyInputEvent = {
        type: 'keydown',
        key: e.key,
        modifiers: { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
        t: e.timeStamp,
      }
      const command = resolveShortcut(keyEvent, editor.get().editingId)
      if (command && (command.type === 'selectAll' || command.type === 'clipboard')) e.preventDefault()
      if (target && container && container.contains(target)) return
      if (command) runCommand(command)
      else dispatchToTool(keyEvent)
    }
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  }, [editor, runCommand, dispatchToTool, keyboardScopeRef, viewportContainerRef])

  const onStyleChange = useCallback<StylePanelProps['onStyleChange']>(
    (axis: StyleAxis, value: StyleValue, opts) => {
      const ids = Array.from(editor.get().selection)
      if (ids.length === 0) return
      const intents: Intent[] = [buildSetStyleIntent(ids, axis, value)]
      if (!opts?.onlySelection) intents.push({ type: 'SetNextStyle', props: { [axis]: value } })
      dispatch(intents)
    },
    [editor, dispatch],
  )

  const onArmStyle = useCallback<StylePanelProps['onArmStyle']>(
    (axis: StyleAxis, value: StyleValue) => dispatch([{ type: 'SetNextStyle', props: { [axis]: value } }]),
    [dispatch],
  )

  return { editor, toolContext, activeToolId, toolStates, isGesturing, selectTool, cancelAndReset, handleInput, dispatch, onStyleChange, onArmStyle }
}
```

Verify every imported name exists in `@ensembleworks/canvas-editor` / `@ensembleworks/canvas-model` (`grep -rn "export function applyWheel" canvas-editor/src`, etc.) and adjust the import source to wherever it is really exported; do not add new exports to `canvas-model` or `canvas-react`.

Two deliberate differences from the web app, both from the approved design: clipboard failures now call `host.notify` (the web app swallowed them silently), and keydowns whose target is the document body count as canvas shortcuts.

- [ ] **Step 4: Write `CanvasSurface`**

`canvas-ui/src/CanvasSurface.tsx`:

```tsx
import { useCallback, type ReactNode } from 'react'
import type { EditorState } from '@ensembleworks/canvas-editor'
import { currentSnapResult } from '@ensembleworks/canvas-editor'
import type { CanvasDocument } from '@ensembleworks/canvas-model'
import { FrameNameEditor, Grid, Overlay, ShapeLayer, TextEditor, Viewport, WorldLayer, type ViewportSize } from '@ensembleworks/canvas-react'
import type { CanvasSession } from './use-canvas-session.js'
import { StylePanel } from './StylePanel.js'

export interface CanvasSurfaceProps {
  readonly session: CanvasSession
  readonly editorState: EditorState
  readonly snapshot: CanvasDocument
  readonly viewportSize: ViewportSize
  /** Rendered inside the world layer after shape bodies (e.g. the web app's embeds). */
  readonly worldLayers?: ReactNode
  /** Rendered in screen space after the selection overlay, before the style panel
   * (e.g. collaborator cursors, editing indicators). */
  readonly overlays?: ReactNode
}

export function CanvasSurface({ session, editorState, snapshot, viewportSize, worldLayers, overlays }: CanvasSurfaceProps) {
  const { editor, toolContext } = session
  const onTextChange = useCallback((id: string, text: string) => editor.apply({ type: 'SetText', id, text }), [editor])
  const onEndEdit = useCallback(() => editor.apply({ type: 'EndEdit' }), [editor])
  const onAutosize = useCallback((id: string, props: Record<string, unknown>) => editor.apply({ type: 'UpdateProps', id, props }), [editor])
  const onNameChange = useCallback((id: string, name: string) => editor.apply({ type: 'UpdateProps', id, props: { name } }), [editor])

  return (
    <Viewport onInput={session.handleInput} onViewportBlur={session.cancelAndReset} onPointerCancel={session.cancelAndReset} style={{ position: 'absolute', inset: 0 }}>
      <Grid camera={editorState.camera} />
      <WorldLayer camera={editorState.camera}>
        <ShapeLayer toolContext={toolContext} camera={editorState.camera} viewportSize={viewportSize} dispatch={session.dispatch} />
        {worldLayers}
        <TextEditor toolContext={toolContext} onTextChange={onTextChange} onEndEdit={onEndEdit} onAutosize={onAutosize} />
        <FrameNameEditor toolContext={toolContext} onNameChange={onNameChange} onEndEdit={onEndEdit} />
      </WorldLayer>
      <Overlay
        editorState={editorState}
        snapshot={snapshot}
        camera={editorState.camera}
        viewportSize={viewportSize}
        index={toolContext.index()}
        snapResult={currentSnapResult(session.toolStates, session.activeToolId)}
      />
      {overlays}
      <StylePanel
        selection={editorState.selection}
        snapshot={snapshot}
        camera={editorState.camera}
        viewportSize={viewportSize}
        isGesturing={session.isGesturing}
        activeToolId={session.activeToolId}
        nextShapeStyle={editorState.nextShapeStyle}
        onStyleChange={session.onStyleChange}
        onArmStyle={session.onArmStyle}
      />
    </Viewport>
  )
}
```

Append to `canvas-ui/src/index.ts`:

```ts
export * from './host.js'
export * from './fonts.js'
export * from './use-canvas-session.js'
export * from './CanvasSurface.js'
```

- [ ] **Step 5: Write the surface render test**

`canvas-ui/src/canvas-surface.test.ts` — renders `CanvasSurface` with a real editor and a selected note, and a fake host:

```ts
// Run: bun src/canvas-surface.test.ts
import assert from 'node:assert/strict'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LoroCanvasDoc } from '@ensembleworks/canvas-doc'
import { createToolContext, createToolSet, createInitialToolStates, Editor } from '@ensembleworks/canvas-editor'
import { CanvasSurface } from './CanvasSurface.js'
import type { CanvasSession } from './use-canvas-session.js'

const doc = LoroCanvasDoc.create({ peerId: 1n })
doc.putPage({ id: 'page:p', name: 'P' })
doc.putShape({ id: 'shape:n', kind: 'note', parentId: 'page:p', index: 'a1', x: 100, y: 100, rotation: 0, isLocked: false, opacity: 1, meta: {}, props: {} } as never)
doc.commit()
const editor = new Editor({ doc, now: () => 0, random: () => 0.5, pageId: 'page:p' })
editor.apply({ type: 'SetSelection', ids: ['shape:n'] })
const toolContext = createToolContext(editor)
const tools = createToolSet(toolContext)

const session: CanvasSession = {
  editor,
  toolContext,
  activeToolId: 'select',
  toolStates: createInitialToolStates(tools),
  isGesturing: false,
  selectTool: () => {},
  cancelAndReset: () => {},
  handleInput: () => {},
  dispatch: (intents) => editor.applyAll(intents),
  onStyleChange: () => {},
  onArmStyle: () => {},
}

const html = renderToStaticMarkup(
  createElement(CanvasSurface, {
    session,
    editorState: editor.get(),
    snapshot: toolContext.snapshot(),
    viewportSize: { width: 1024, height: 768 },
    overlays: createElement('div', { 'data-host-overlay': '' }) as ReactNode,
  }),
)

assert.ok(html.includes('data-shape-kind="note"'), 'renders shape bodies')
assert.ok(html.includes('data-style-panel-mode="selection"'), 'renders the style panel for the selection')
assert.ok(html.includes('data-host-overlay'), 'renders the host overlay slot')
assert.ok(html.indexOf('data-host-overlay') < html.indexOf('data-style-panel-mode'), 'host overlays paint below the style panel')
console.log('ok: CanvasSurface renders shapes, host overlays and the style panel')
```

Run: `export PATH="$HOME/.bun/bin:$PATH"; (cd canvas-ui && bun test.ts); echo $?`
Expected: 0. If `createToolContext` is exported under another name, use the real name (`grep -n "export function create" canvas-editor/src/tools/tool-context.ts`).

- [ ] **Step 6: Web app adopts the hook and surface**

In `client/src/canvas-v2/CanvasV2App.tsx`, inside `CanvasV2Session`:

1. Delete the local `activeToolId`, `isGesturing`, `toolStates` state and refs; `cancelAndReset`; `selectTool`; `handleGlobalShortcut`; `handleInput`; `handleViewportBlur`; `handleTextChange`; `handleEndEdit`; `handleTextAutosize`; `handleFrameNameChange`; `dispatch`; `onStyleChange`; `onArmStyle`; the document-level keydown `useEffect`.
2. Add a root ref and the host, then the hook:

```tsx
	const rootRef = useRef<HTMLDivElement | null>(null)
	const host = useMemo<CanvasHost>(
		() => ({
			clipboard: { read: readClipboardText, write: writeClipboardText },
			notify: (message) => console.warn(`[canvas-v2] ${message}`),
			onCursorScreen: (point) => presencePublisher.setCursorFromScreen(point, editor.get().camera),
		}),
		[editor, presencePublisher],
	)
	const session = useCanvasSession({ editor, toolContext, tools, host, keyboardScopeRef: rootRef, viewportContainerRef: containerRef })
```

3. Replace every remaining use of the deleted names with `session.<name>` (`session.dispatch` for the image-drop path's shape creation is not needed; it calls `createImageFromBlob` directly).
4. Replace the JSX: attach `ref={rootRef}` to the outermost `<div>`; the toolbar becomes `<Toolbar activeToolId={session.activeToolId} onSelectTool={session.selectTool} />`; replace the whole `<Viewport>…</Viewport>` with:

```tsx
					<CanvasSurface
						session={session}
						editorState={editorState}
						snapshot={snapshot}
						viewportSize={viewportSize}
						worldLayers={
							<EmbedLayer
								toolContext={toolContext}
								camera={editorState.camera}
								viewportSize={viewportSize}
								tick={tick}
								suspendAfterTicks={SUSPEND_AFTER_TICKS}
								lifecycleFor={canvasV2EmbedLifecycles.lifecycleFor}
								dispatch={session.dispatch}
							/>
						}
						overlays={
							<>
								<Cursors presence={adaptPresence(presenceStore.all())} selfKey={selfKey} camera={editorState.camera} viewportSize={viewportSize} />
								<EditingIndicators presence={presenceStore.all()} selfKey={selfKey} snapshot={snapshot} camera={editorState.camera} viewportSize={viewportSize} />
							</>
						}
					/>
```

5. Replace `import './fonts.css'` with rendering `<CanvasFonts baseUrl="/fonts/tldraw" />` as the first child of the outer `<div>`. In `client/src/canvas-v2/goldens/GoldenHarness.tsx`, replace `import '../fonts.css'` with rendering `<CanvasFonts baseUrl="/fonts/tldraw" />` at the top of its root element. Then `git rm client/src/canvas-v2/fonts.css`. Keep `import './canvas-v2.css'` (it maps `--canvas-*` renderer vars to brand tokens and is host-specific).
6. Remove imports that are now unused; add imports of `CanvasSurface`, `CanvasFonts`, `Toolbar`, `useCanvasSession`, `type CanvasHost` from `@ensembleworks/canvas-ui`.

- [ ] **Step 7: Full verification**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck; echo $?
export UX_CONTRACT_PR_BODY='ux-contract: none — web app session logic moved into canvas-ui; every existing interaction contract still passes unchanged'
bun run test; echo $?
cd e2e && flock /tmp/claude-1000/e2e.lock bunx playwright test --project=e2e; echo $?
```

Expected: typecheck 0; unit suite green apart from the known loopback files; full Playwright lane 0, including every interaction contract, the canvas-v2 spec, component goldens and the parity gate.

- [ ] **Step 8: Commit**

```bash
git add -A canvas-ui client/src/canvas-v2
git commit -m "feat(canvas-ui): shared session hook and CanvasSurface; web app mounts them

RED (fonts): <paste>
ux-contract: none — web app session logic moved into canvas-ui; every existing interaction contract still passes unchanged

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The bb plugin mounts `canvas-ui` and drops its duplicate session layer

**Files:**
- Modify: `plugins/canvas/package.json` (add `"@ensembleworks/canvas-ui": "file:../../canvas-ui"`), `plugins/canvas/package-lock.json` (via `npm install`)
- Modify: `plugins/canvas/canvas/panel/session.tsx`, `panel/session-view.tsx`, `panel/shared.ts`, `panel/connection-boot.ts`, `panel/session-debug.ts` (if it types `handleInput`), `canvas/pages/history-repair.ts`, `canvas/pages/page-intents.ts`, `canvas/agents-view.ts` (comment only)
- Delete: `plugins/canvas/canvas/tool-loop.ts`, `plugins/canvas/canvas/panel/session-input.ts`
- Modify tests: `plugins/canvas/tests/chrome-dock.test.ts`, `page-history-repair.test.ts`, `page-switcher-layering.test.ts`, `page-presence.test.ts`, `agent-affordance-wiring.test.ts`, `page-intents.test.ts`, and any other test that reads a deleted file
- Create: `plugins/canvas/tests/shared-surface.test.ts`
- Modify: `plugins/canvas/README.md`

**Interfaces:**
- Consumes: `useCanvasSession`, `CanvasSurface`, `Toolbar`, `CanvasHost` (canvas-ui); `createToolSet`, `ToolId`, `ToolSet`, `ToolStates`, `currentSnapResult`, `pruneDanglingSelectionIntents`, `clampCurrentPageIntents`, `historyRepairIntents`, `undoWithRepair`, `redoWithRepair` (canvas-editor).
- Produces: nothing new for later tasks except the plugin mounting `[data-canvas-toolbar]` and `[data-style-panel-mode]`.

- [ ] **Step 1: Add the dependency and prove the build still bundles**

```bash
cd plugins/canvas
node -e "const p=require('./package.json'); p.dependencies['@ensembleworks/canvas-ui']='file:../../canvas-ui'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)+'\n')"
npm install
ls -la node_modules/@ensembleworks/canvas-ui
```

Expected: a symlink to `../../../../canvas-ui`. `canvas-ui` ships no `.css` imports (fonts are a JS string), so no CSS-bundling question arises.

- [ ] **Step 2: Replace plugin-local pure logic with canvas-editor's**

1. `git rm canvas/tool-loop.ts`.
2. `canvas/panel/connection-boot.ts`: import `createToolSet` from `@ensembleworks/canvas-editor`.
3. `canvas/panel/shared.ts`: import `ToolId`, `ToolSet`, `ToolStates` from `@ensembleworks/canvas-editor`; delete the local `currentSnapResult`, `isEditableTarget`, `TOOL_BUTTONS` and `chromeToolStyle` exports.
4. `canvas/pages/page-intents.ts`: delete the local `clampCurrentPageIntents` and add `export { clampCurrentPageIntents } from "@ensembleworks/canvas-editor";`.
5. `canvas/pages/history-repair.ts`: replace the file body with `export { historyRepairIntents, undoWithRepair, redoWithRepair } from "@ensembleworks/canvas-editor";` keeping a two-line header comment saying the helpers now live in canvas-editor's session module.

- [ ] **Step 3: Write the failing plugin surface test**

`plugins/canvas/tests/shared-surface.test.ts` (vitest, no DOM — server rendering only):

```ts
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toolbar } from "@ensembleworks/canvas-ui";
import { canvasThemeStyle } from "../canvas/theme.js";

describe("the plugin mounts the shared canvas chrome", () => {
  it("renders the shared nine-tool icon toolbar", () => {
    const html = renderToStaticMarkup(createElement(Toolbar, { activeToolId: "select", onSelectTool: () => {} }));
    for (const id of ["select", "hand", "note", "text", "geo", "frame", "arrow", "draw", "line"]) {
      expect(html).toContain(`data-canvas-tool="${id}"`);
    }
  });

  it("has no plugin-local copy of the session layer", () => {
    expect(existsSync(new URL("../canvas/tool-loop.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../canvas/panel/session-input.ts", import.meta.url))).toBe(false);
  });

  it("keeps the bb theme as the paper colour", () => {
    expect((canvasThemeStyle as Record<string, string>)["--canvas-paper"]).toBe("var(--background)");
  });
});
```

Run: `npx vitest run tests/shared-surface.test.ts`
Expected: FAIL — the second case, because `canvas/panel/session-input.ts` still exists (Step 2 already removed `tool-loop.ts`). Record the output.

- [ ] **Step 4: Rewire the session**

1. `git rm canvas/panel/session-input.ts`.
2. `canvas/panel/session.tsx`: replace `useSessionInput(...)` with:

```tsx
  const host = useMemo<CanvasHost>(
    () => ({
      clipboard: {
        read: () => navigator.clipboard.readText(),
        write: (text) => navigator.clipboard.writeText(text),
      },
      notify: (message) => toast.error(message),
      onCursorScreen: (point) => presencePublisher.setCursorFromScreen(point, editor.get().camera),
    }),
    [editor, presencePublisher],
  );
  const canvas = useCanvasSession({
    editor,
    toolContext,
    tools,
    host,
    keyboardScopeRef: viewport.panelRef,
    viewportContainerRef: viewport.viewportRef,
  });
```

Pass `canvas.cancelAndReset` to `useThreadReturn`, and replace the props `activeToolId`, `toolStates`, `handleInput`, `cancelAndReset`, `dispatch`, `handleTextChange`, `handleEndEdit`, `selectTool` given to `SessionView` with a single `canvas={canvas}` prop. Keep `useSessionDebug` working by calling `useSessionDebug({ editor, toolContext, presenceStore, handleInput: canvas.handleInput })` here (it was called from the deleted `session-input.ts`).

3. `canvas/panel/session-view.tsx`: in `SessionViewProps`, replace those eight props with `readonly canvas: CanvasSession`. In the local `CanvasSurface` component (rename it `CanvasViewport` to avoid a name clash), replace the whole `<Viewport>…</Viewport>` with:

```tsx
      <CanvasSurface
        session={canvas}
        editorState={editorState}
        snapshot={snapshot}
        viewportSize={viewportSize}
        overlays={
          <Cursors
            presence={remotePresence}
            selfKey={selfKey}
            camera={editorState.camera}
            viewportSize={viewportSize}
            currentPageId={editorState.currentPageId}
          />
        }
      />
```

Keep `AgentLayer` and `SpeakerRings` as siblings after it. In `CanvasChrome`, replace the `TOOL_BUTTONS.map(...)` block inside `<div style={chromeToolbarStyle}>` with `<Toolbar activeToolId={canvas.activeToolId} onSelectTool={canvas.selectTool} style={{ background: "transparent", border: "none", padding: 0 }} />`. Import `CanvasSurface`, `Toolbar`, `type CanvasSession` from `@ensembleworks/canvas-ui` and drop now-unused canvas-react imports.

- [ ] **Step 5: Retarget or delete source-text guards on moved code**

Run `npx vitest run` and work through each failure:

- A guard reading `panel/session-input.ts` or `tool-loop.ts` (for example `page-history-repair.test.ts`'s "wires the undo branch to undoWithRepair" block): delete the guard block. The behaviour it pinned is covered by `canvas-editor/src/session/history.test.ts` and `keyboard.test.ts`.
- A guard counting `TOOL_BUTTONS.map(` in `chrome-dock.test.ts`: change it to count `<Toolbar` in the panel source, expecting 1.
- Behaviour tests importing a deleted module: import the same symbol from `@ensembleworks/canvas-editor`.
- Guards reading `session-view.tsx` for `Cursors`, `AgentLayer`, `SpeakerRings`, page tabs or overlays: keep them; they should still pass. If one fails, the rewire dropped something — restore the behaviour, do not weaken the guard.

- [ ] **Step 6: Plugin gates to green**

```bash
cd plugins/canvas
npx vitest run tests/shared-surface.test.ts; echo $?
npm run typecheck; echo $?
npm test; echo $?
npm run audit:quality:compare; echo $?
bb plugin build .; echo $?
```

Expected: all 0. If `audit:quality:compare` reports a regression, it is from new code in `session.tsx`/`session-view.tsx`; simplify those, do not edit the baseline.

- [ ] **Step 7: Update the plugin README**

In `plugins/canvas/README.md`, in the file-map bullet for `canvas/`, replace the mention of the plugin's tool loop with: "the canvas controls (tools, shortcuts, toolbar, style panel, text editing) come from the shared `@ensembleworks/canvas-ui` package, the same one the EnsembleWorks web app mounts; this plugin supplies the bb transport, theme mapping, page tabs, agent layer and dock." Add `canvas-ui/` to the list of sibling workspaces a deploy must sync.

- [ ] **Step 8: Repo-level verification and commit**

```bash
cd ../..
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck; echo $?
git add -A plugins/canvas
git commit -m "feat(canvas-plugin): mount shared canvas-ui; delete duplicate tool loop and input handling

RED: <paste the shared-surface.test.ts failure>
ux-contract: none — plugin-only change (plugins/canvas is outside the gated paths); verified by plugin tests and the live-bb smoke in Task 8

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Map bb's theme onto the shared chrome

**Files:**
- Modify: `plugins/canvas/canvas/theme.ts`
- Modify: `plugins/canvas/tests/shared-surface.test.ts`

**Interfaces:**
- Consumes: the `--canvas-ui-*` names in `canvas-ui/src/theme.ts` (Task 4, including any role vars added in its Step 3).

- [ ] **Step 1: Write the failing test**

Append to `plugins/canvas/tests/shared-surface.test.ts`:

```ts
import { UI_VARS } from "@ensembleworks/canvas-ui";

describe("bb theme mapping for the shared chrome", () => {
  it("maps every --canvas-ui-* variable onto a bb theme token", () => {
    const style = canvasThemeStyle as Record<string, string>;
    for (const value of Object.values(UI_VARS)) {
      const name = /var\((--canvas-ui-[a-z-]+)/.exec(value)?.[1];
      expect(name, `UI_VARS entry ${value} names a --canvas-ui-* variable`).toBeDefined();
      expect(style[name!], `${name} is mapped`).toMatch(/var\(--/);
    }
  });
});
```

Run: `cd plugins/canvas && npx vitest run tests/shared-surface.test.ts; echo $?`
Expected: FAIL with `--canvas-ui-panel-bg is mapped` (undefined). Record it.

- [ ] **Step 2: Implement the mapping**

In `plugins/canvas/canvas/theme.ts`, add to `canvasThemeStyle` (before `color:`):

```ts
  "--canvas-ui-panel-bg": "var(--popover)",
  "--canvas-ui-panel-fg": "var(--popover-foreground)",
  "--canvas-ui-panel-muted": "var(--muted-foreground)",
  "--canvas-ui-panel-border": "var(--border)",
  "--canvas-ui-control-border": "var(--input)",
  "--canvas-ui-accent": "var(--primary)",
  "--canvas-ui-accent-fg": "var(--primary-foreground)",
  "--canvas-ui-accent-soft": "var(--accent)",
```

For each extra role var Task 4 added to `UI_VARS` (for example `--canvas-ui-shadow`), add a mapping built from bb tokens, such as `"--canvas-ui-shadow": "0 4px 16px color-mix(in srgb, var(--foreground) 18%, transparent)"`. Every mapped value must contain `var(--`.

- [ ] **Step 3: Gates and commit**

```bash
npx vitest run tests/shared-surface.test.ts; echo $?
npm run typecheck && npm test && npm run audit:quality:compare && bb plugin build .; echo $?
cd ../.. && git add plugins/canvas/canvas/theme.ts plugins/canvas/tests/shared-surface.test.ts
git commit -m "feat(canvas-plugin): theme the shared toolbar and style panel from bb tokens

RED: <paste>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Expected: both commands exit 0 before committing.

---

### Task 8: Live-bb acceptance smoke

Automates acceptance criteria 1–7 against the running bb instance, which has the Canvas plugin installed from this worktree (`bb plugin list` shows `source: path:…/plugins/canvas`).

**Files:**
- Create: `e2e/scripts/bb-canvas-smoke.mjs`
- Modify: `docs/plans/2026-09-14-canvas-ui-shared-session-design.md` (append a "Verification" section)

- [ ] **Step 1: Write the smoke script**

`e2e/scripts/bb-canvas-smoke.mjs`:

```js
// Live acceptance smoke for the bb Canvas plugin (docs/plans/2026-09-14-canvas-ui-shared-session-design.md).
// Run from e2e/ against a running bb:  BB_SERVER_URL=http://127.0.0.1:38886 node scripts/bb-canvas-smoke.mjs
// It works on a scratch page it creates and deletes; existing pages are not touched.
import { chromium } from '@playwright/test'

const BASE = process.env.BB_SERVER_URL ?? 'http://127.0.0.1:38886'
const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
let acceptDialogs = false
page.on('dialog', (d) => (acceptDialogs ? d.accept() : d.dismiss()))
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

const bodies = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-shape-kind]')].map((e) => {
      const r = e.getBoundingClientRect()
      return { id: e.getAttribute('data-shape-id'), kind: e.getAttribute('data-shape-kind'), w: Math.round(r.width), h: Math.round(r.height) }
    }),
  )
const pressedTool = () => page.evaluate(() => document.querySelector('[data-canvas-tool][aria-pressed="true"]')?.getAttribute('data-canvas-tool'))

try {
  await page.goto(`${BASE}/`)
  await page.waitForTimeout(3000)
  const closeRef = page.getByRole('button', { name: 'Close UI reference' })
  if (await closeRef.count()) await closeRef.first().click()
  await page.getByRole('button', { name: 'Canvas', exact: true }).first().click()
  await page.waitForSelector('[data-canvas-viewport]', { timeout: 15000 })
  await page.locator('[data-canvas-new-page-tab]').click()
  await page.waitForTimeout(1500)
  const vp = await page.locator('[data-canvas-viewport]').boundingBox()
  const at = (x, y) => ({ x: vp.x + x, y: vp.y + y })

  // AC1 — polished toolbar
  const tools = await page.evaluate(() =>
    [...document.querySelectorAll('[data-canvas-tool]')].map((b) => ({ id: b.getAttribute('data-canvas-tool'), title: b.getAttribute('title'), icon: !!b.querySelector('svg') })),
  )
  check('AC1 nine icon tools with shortcut tooltips', tools.length === 9 && tools.every((t) => t.icon && /\([A-Z]\)$/.test(t.title ?? '')), JSON.stringify(tools))

  // AC3 — note tool returns to Select after typing
  await page.locator('[data-canvas-tool="note"]').click()
  let p = at(300, 220)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  await page.keyboard.type('hello')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const toolAfterType = await pressedTool()
  p = at(900, 600)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(400)
  const notesAfterClick = (await bodies()).filter((b) => b.kind === 'note').length
  check('AC3 note tool returns to Select; next click creates nothing', toolAfterType === 'select' && notesAfterClick === 1, `tool=${toolAfterType} notes=${notesAfterClick}`)

  // AC2 — colour and font
  const note = (await bodies()).find((b) => b.kind === 'note')
  const noteBox = await page.locator(`[data-shape-id="${note.id}"][data-shape-kind]`).boundingBox()
  await page.mouse.click(noteBox.x + noteBox.width / 2, noteBox.y + 20)
  await page.waitForTimeout(300)
  const readNoteStyle = () =>
    page.evaluate((id) => {
      const body = document.querySelector(`[data-shape-id="${id}"] [data-shape-body]`) ?? document.querySelector(`[data-shape-id="${id}"][data-shape-kind]`)
      const cs = getComputedStyle(body)
      return { background: cs.backgroundColor, font: cs.fontFamily }
    }, note.id)
  const styleBefore = await readNoteStyle()
  await page.locator('[data-style-control="color"] [data-style-value="blue"]').click()
  await page.locator('[data-style-control="font"] [data-style-value="serif"]').click()
  await page.waitForTimeout(400)
  const styleAfter = await readNoteStyle()
  const docProps = await page.evaluate(async (id) => {
    const res = await fetch('/api/v1/plugins/canvas/rpc/canvas_debug', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' })
    return res.ok ? (await res.json()).result?.shapes?.[id]?.props ?? null : null
  }, note.id)
  check(
    'AC2 colour and font change',
    styleAfter.background !== styleBefore.background && styleAfter.font !== styleBefore.font && /serif/i.test(styleAfter.font),
    JSON.stringify({ styleBefore, styleAfter, docProps }),
  )

  // AC7 — theme follows bb
  const panelBg = await page.evaluate(() => {
    const panel = document.querySelector('[data-style-panel-mode]')
    return panel ? getComputedStyle(panel).backgroundColor : null
  })
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const isDark = (rgb) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(rgb ?? ''); return m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 < 128 : null }
  check('AC7 style panel matches bb light/dark appearance', panelBg !== null && isDark(panelBg) === isDark(bodyBg), `panel=${panelBg} body=${bodyBg}`)

  // AC6 — long text grows the note
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.press('End')
  await page.keyboard.type(' This is a much longer paragraph. It keeps going so the sticky has to grow downward. Nothing should be cut off at the bottom edge.')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  const grown = await page.evaluate((id) => {
    const root = document.querySelector(`[data-shape-id="${id}"][data-shape-kind]`)
    const box = root.querySelector('[data-shape-body]') ?? root
    const r = root.getBoundingClientRect()
    return { w: r.width, h: r.height, scroll: box.scrollHeight, client: box.clientHeight }
  }, note.id)
  check('AC6 long note text grows the note', grown.h > grown.w && grown.scroll <= grown.client + 1, JSON.stringify(grown))

  // AC4 — shortcuts keep working after editing text
  await page.locator('[data-canvas-tool="note"]').click()
  p = at(700, 250)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(300)
  await page.keyboard.type('undo me')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const before = (await bodies()).length
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(250)
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(400)
  const after = (await bodies()).length
  check('AC4 Ctrl+Z works after editing without clicking', after === before - 1, `before=${before} after=${after}`)

  // AC5 — arrows stay on their page
  await page.locator('[data-canvas-tool="arrow"]').click()
  p = at(300, 650)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 250, p.y + 40, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const arrowsHere = await page.evaluate(() => document.querySelectorAll('[data-overlay="arrow"]').length)
  await page.locator('[data-canvas-new-page-tab]').click()
  await page.waitForTimeout(1500)
  const arrowsOnFresh = await page.evaluate(() => document.querySelectorAll('[data-overlay="arrow"]').length)
  check('AC5 arrow drawn on its page only', arrowsHere >= 1 && arrowsOnFresh === 0, `here=${arrowsHere} freshPage=${arrowsOnFresh}`)

  check('no page errors', errors.length === 0, JSON.stringify(errors))
} finally {
  // Delete the two scratch pages this run created (the last two tabs).
  acceptDialogs = true
  for (let i = 0; i < 2; i++) {
    const tab = page.locator('[data-canvas-page-tab]').last()
    if (!(await tab.count())) break
    await tab.click({ button: 'right' })
    await page.waitForTimeout(300)
    const del = page.locator('[data-canvas-page-tab-menu-item="delete"]')
    if (await del.count()) {
      await del.click()
      await page.waitForTimeout(1200)
    }
  }
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-canvas-page-tab]')].map((t) => t.textContent.trim()))
  console.log('tabs after cleanup:', JSON.stringify(tabs))
  await browser.close()
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ?? ''}`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
```

Before running, record the page tabs that exist (`bb canvas status`, or open the canvas and read them); the run must leave exactly those tabs.

- [ ] **Step 2: Reload the plugin and run the smoke**

The bb server and the browser need the host network, so run these with the sandbox disabled:

```bash
export BB_NO_COLOR=1
bb plugin reload canvas; echo $?
cd e2e && BB_SERVER_URL=http://127.0.0.1:38886 node scripts/bb-canvas-smoke.mjs; echo $?
```

Expected: `bb plugin reload` exits 0; the smoke prints `PASS` for every line and exits 0, and `tabs after cleanup` lists exactly the tabs recorded before the run. A `FAIL` is a defect in Tasks 1–7: report it with the printed detail; do not loosen the check.

- [ ] **Step 3: Record the verification and commit**

Append to `docs/plans/2026-09-14-canvas-ui-shared-session-design.md`:

```markdown
## Verification (<date>)

Live bb smoke (`e2e/scripts/bb-canvas-smoke.mjs` against bb <`bb --version`>), plugin reloaded from this branch:

<paste the PASS/FAIL lines>

Web app: full Playwright lane <N>/<N>; repo typecheck 0; plugin typecheck, tests, quality audit and build 0.
```

Replace every `<…>` with the real values from this run.

```bash
git add e2e/scripts/bb-canvas-smoke.mjs docs/plans/2026-09-14-canvas-ui-shared-session-design.md
git commit -m "test(e2e): live-bb acceptance smoke for the shared canvas chrome

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec requirement | Task |
|---|---|
| Pure session logic in canvas-editor | 2, 3 |
| canvas-ui: session hook, surface, toolbar, style panel, fonts | 4, 5 |
| `--canvas-ui-*` CSS variables with web-app fallbacks | 4 |
| `CanvasHost` port (clipboard, notify, cursor) | 5 |
| Keyboard listener counts body as in scope | 5 |
| Web app adopts, goldens unchanged | 4, 5 |
| Plugin adopts and deletes `tool-loop.ts`, `session-input.ts`, toolbar markup | 6 |
| Plugin maps bb tokens (light/dark), keeps dock placement | 6, 7 |
| Cross-page arrow fix in shared renderer | 1 |
| Live-bb browser check | 8 |
| Plugin test mounting canvas-ui | 6 |
| AC 1–7 | 8 (automated), 1–7 (implemented) |
| AC 8 web app unchanged | 4, 5 (full Playwright lane) |
| AC 9 one copy | 2, 4, 6 |
| AC 10 gates | every task |

Out of scope, per the spec: loading the canvas webfonts inside the plugin (the plugin has no static asset route today; `CanvasFonts` is ready for a host that can serve the files), page switcher and presence unification, image upload and embeds in the plugin.
