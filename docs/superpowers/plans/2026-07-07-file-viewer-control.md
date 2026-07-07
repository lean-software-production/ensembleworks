# file-viewer canvas control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `file-viewer` canvas control that renders a file from the agent user's home in a sandboxed iframe (portal, not push), created/refreshed via `ensembleworks file open|refresh`, with v1 scroll-follow (presenter broadcasts scroll fraction over tldraw presence; followers track).

**Architecture:** A new localhost-only `file-server` (:8791) serves `$HOME` raw and read-only. The sync server's `/files/*` route proxies it, rendering markdown → styled HTML and injecting a postMessage scroll-bridge into every top-level document. A `file-viewer` shape (sibling of the iframe shape) points a sandboxed iframe (no `allow-same-origin`) at `/files/<path>?rev=N`; a synced `rev` prop is the reload nudge, bumped by `POST /api/canvas/file-viewer {op:'refresh'}`. Presenter state rides presence `meta` (already proven: the client stamps `meta.stamp` through `TLSocketRoom` today — verification V1 is **positive**, no LiveKit fallback needed).

**Tech Stack:** Bun + node:http (file-server), express feature routers, `marked` (GFM md→HTML, new server dep), tldraw presence meta, `bun` tests (`node:assert`, house pattern: `bun src/foo.test.ts`, api tests end `process.exit(0)`).

**Source spec:** `docs/superpowers/specs/2026-07-06-file-viewer-control-design.md` (read it before implementing your task).

**Plan-time verifications settled:** V1 presence-meta ✅ (App.tsx `getUserPresence` ships `meta:{stamp}`; server reads it via `getCursorRefs`). R4 port ✅ 8791 free (sync 8788, term 8789, neko 8090, **whisper 8091 — do not confuse**, livekit 7880). The #4 CLI HAS shipped → no `bin/canvas` interim aliases; the `file` verb group goes on `ensembleworks` directly.

**House rules for every task:** tests are plain `bun`-run `node:assert` files (`// Run with: bun src/….test.ts` header, `console.log('ok: …')` at the end); any test that boots `createSyncApp` MUST end with `server.close(); process.exit(0)`. Tabs for indentation (match surrounding files). Run `bun run typecheck` (workspace) before committing. Commit after each task.

---

### Task 1: Contracts — shape props + `file` ToolDefs

**Files:**
- Modify: `contracts/src/shapes.ts` (add `fileViewerShapeProps`)
- Create: `contracts/src/tools/file.ts`
- Modify: `contracts/src/tools/index.ts` (export + add to `allTools`)
- Modify: `contracts/src/tools/tools.test.ts` (15 → 17 count; follow whatever per-tool assertions exist)
- Modify: `server/src/tools-api.test.ts` (15 → 17 in BOTH the assertion line 37 and the log line 77)

- [ ] **Step 1: Add the shape props** to `contracts/src/shapes.ts`, mirroring the style of `roadmapShapeProps` (check how `T` is imported there and match):

```ts
export const fileViewerShapeProps = {
	w: T.number,
	h: T.number,
	// Path relative to the agent user's home, e.g. "my-repo/docs/report.html".
	path: T.string,
	title: T.string,
	// Bumped by POST /api/canvas/file-viewer refresh so every client reloads.
	rev: T.number.optional(),
	// Remote gateway id (future); optional so existing rooms need no migration.
	gateway: T.string.optional(),
}
```

- [ ] **Step 2: Create `contracts/src/tools/file.ts`** (mirror the header/style of `contracts/src/tools/canvas.ts`):

```ts
import { z } from 'zod'
import type { ToolDef } from './types.js'

const room = z.string().default('team')

export const fileOpen: ToolDef = {
	plugin: 'file',
	id: 'open',
	http: { method: 'POST', path: '/api/canvas/file-viewer' },
	help: 'Open a file from the agent home on the canvas in a file-viewer control.',
	zodInput: z.object({
		op: z.literal('open').default('open'),
		room,
		path: z
			.string()
			.min(1)
			.describe('path relative to the agent home, e.g. my-repo/docs/report.html'),
		title: z.string().optional().describe('header title (defaults to the filename)'),
		frame: z.string().optional().describe('fuzzy frame name to place the control in'),
		gateway: z.string().optional().describe('remote gateway id (v1: rejected with 501)'),
	}),
	output: z.object({ ok: z.boolean(), id: z.string() }),
}

export const fileRefresh: ToolDef = {
	plugin: 'file',
	id: 'refresh',
	http: { method: 'POST', path: '/api/canvas/file-viewer' },
	help: 'Reload every open file-viewer showing a path (bumps the synced rev).',
	zodInput: z.object({
		op: z.literal('refresh').default('refresh'),
		room,
		path: z.string().min(1).describe('the path whose viewers should reload'),
		gateway: z.string().optional().describe('remote gateway id (v1: rejected with 501)'),
	}),
	output: z.object({ ok: z.boolean(), updated: z.number() }),
}
```

Check `types.js` vs `types.ts` in the sibling files' imports and `output` field name (open `contracts/src/tools/types.ts` — if the output field is named differently, e.g. `zodOutput`, match it).

- [ ] **Step 3: Register** in `contracts/src/tools/index.ts` — import `fileOpen, fileRefresh`, add to the `allTools` array (after the canvas group), re-export.

- [ ] **Step 4: Update counts.** `contracts/src/tools/tools.test.ts`: `15` → `17` (and read the rest of the test — if it asserts unique `(method,path)` pairs, note both file tools share `POST /api/canvas/file-viewer` deliberately, op-discriminated; adjust any uniqueness assertion to allow it, keeping uniqueness on `(plugin,id)`). `server/src/tools-api.test.ts:37`: `15` → `17`; its Direction-B set comparison already dedupes by `${method} ${path}` so the shared path is fine.

- [ ] **Step 5: Run + commit**

```bash
cd contracts && bun src/tools/tools.test.ts   # expect ok
cd .. && bun run typecheck                    # all workspaces
git add contracts/src/shapes.ts contracts/src/tools/ server/src/tools-api.test.ts
git commit -m "feat(file-viewer): contracts — fileViewerShapeProps + file open/refresh ToolDefs"
```

(`server/src/tools-api.test.ts` will FAIL until Task 5 mounts the route — that is expected; note it in your report and do NOT try to fix it here.)

---

### Task 2: `file-server` — the :8791 home portal (TDD)

**Files:**
- Create: `server/src/file-server.ts`
- Create: `server/src/file-server-core.ts` (the testable request handler)
- Test: `server/src/file-server-core.test.ts`
- Modify: `server/package.json` (scripts `dev:files`, `start:files` — mirror `dev:term`/`start:term`)

- [ ] **Step 1: Write the failing test** (temp dir as fake home; the core takes `rootDir` so no real `$HOME` in tests):

```ts
// file-server core: path safety (traversal/symlink), content-type, dir 404, headers.
// Run with: bun src/file-server-core.test.ts
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveFile } from './file-server-core.ts'

async function main() {
	const home = await mkdtemp(path.join(os.tmpdir(), 'fshome-'))
	const outside = await mkdtemp(path.join(os.tmpdir(), 'fsout-'))
	await mkdir(path.join(home, 'docs'))
	await writeFile(path.join(home, 'docs', 'r.html'), '<h1>hi</h1>')
	await writeFile(path.join(home, 'docs', 's.css'), 'body{}')
	await writeFile(path.join(outside, 'secret.txt'), 'no')
	await symlink(path.join(outside, 'secret.txt'), path.join(home, 'docs', 'leak.txt'))

	// happy path + content-type + headers
	const ok = await serveFile(home, 'docs/r.html')
	assert.equal(ok.status, 200)
	assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8')
	assert.equal(ok.headers['access-control-allow-origin'], '*')
	assert.equal(ok.headers['cache-control'], 'no-store')
	assert.equal(new TextDecoder().decode(ok.body!), '<h1>hi</h1>')
	assert.equal((await serveFile(home, 'docs/s.css')).headers['content-type'], 'text/css; charset=utf-8')

	// traversal (plain and encoded) → 403
	assert.equal((await serveFile(home, '../etc/passwd')).status, 403)
	assert.equal((await serveFile(home, 'docs/%2e%2e/%2e%2e/etc/passwd')).status, 403)
	// symlink escaping home → 403
	assert.equal((await serveFile(home, 'docs/leak.txt')).status, 403)
	// directory → 404 (no listings in v1)
	assert.equal((await serveFile(home, 'docs')).status, 404)
	// missing → 404
	assert.equal((await serveFile(home, 'docs/nope.html')).status, 404)

	console.log('ok: file-server-core')
}

main()
```

- [ ] **Step 2: Run to verify it fails** — `cd server && bun src/file-server-core.test.ts` → module not found.

- [ ] **Step 3: Implement `server/src/file-server-core.ts`:**

```ts
/**
 * file-server core — serve one file from inside rootDir, raw bytes, read-only.
 * Path safety: decode, resolve, then realpath (symlinks) and require the result
 * stays under rootDir. Directories 404 (no listings in v1). CORS * because
 * documents fetch sibling assets from an opaque-origin iframe; no-store because
 * the file on disk IS the document (no stale caches after a refresh).
 */
import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.markdown': 'text/markdown; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.pdf': 'application/pdf',
	'.map': 'application/json; charset=utf-8',
}

export interface ServedFile {
	status: number
	headers: Record<string, string>
	body: Uint8Array | null
}

const BASE_HEADERS = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }

export async function serveFile(rootDir: string, rawPath: string): Promise<ServedFile> {
	let decoded: string
	try {
		decoded = decodeURIComponent(rawPath)
	} catch {
		return { status: 400, headers: { ...BASE_HEADERS }, body: null }
	}
	const root = await realpath(rootDir)
	const resolved = path.resolve(root, decoded)
	// Cheap reject before touching the fs: the resolved lexical path must stay
	// under root (catches ../ and absolute paths).
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return { status: 403, headers: { ...BASE_HEADERS }, body: null }
	}
	let real: string
	try {
		real = await realpath(resolved) // resolves symlinks; throws if missing
	} catch {
		return { status: 404, headers: { ...BASE_HEADERS }, body: null }
	}
	// Symlink escape: the REAL location must also stay under root.
	if (real !== root && !real.startsWith(root + path.sep)) {
		return { status: 403, headers: { ...BASE_HEADERS }, body: null }
	}
	const st = await stat(real)
	if (st.isDirectory()) return { status: 404, headers: { ...BASE_HEADERS }, body: null }
	const type = TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream'
	const body = new Uint8Array(await readFile(real))
	return { status: 200, headers: { ...BASE_HEADERS, 'content-type': type }, body }
}
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Implement the entry point `server/src/file-server.ts`** (mirror `terminal-gateway.ts`'s env/boot shape — read its top lines first):

```ts
/**
 * file-server — read-only portal onto the invoking user's $HOME (:8791).
 * In prod this runs AS the agent sandbox user (systemd unit; the sync server's
 * app user cannot read that home). Localhost-only; the sync server's /files/*
 * route is the sole consumer. Raw bytes only — markdown rendering and script
 * injection happen at the route, so this stays a dumb byte reader that a future
 * remote connector can reimplement.
 */
import http from 'node:http'
import os from 'node:os'
import { serveFile } from './file-server-core.ts'

const PORT = Number(process.env.PORT ?? 8791)
const ROOT = process.env.ENSEMBLEWORKS_FILES_ROOT ?? os.homedir()

const server = http.createServer(async (req, res) => {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.writeHead(405).end()
		return
	}
	const url = new URL(req.url ?? '/', 'http://internal')
	const served = await serveFile(ROOT, url.pathname.replace(/^\/+/, ''))
	res.writeHead(served.status, served.headers)
	res.end(req.method === 'HEAD' ? undefined : (served.body ?? undefined))
})

server.listen(PORT, '127.0.0.1', () => {
	console.log(`ensembleworks file-server on 127.0.0.1:${PORT} serving ${ROOT} (read-only)`)
})
```

- [ ] **Step 6: package.json scripts.** In `server/package.json`, next to `dev:term`/`start:term`, add `"dev:files": "bun --watch src/file-server.ts"` and `"start:files": "bun src/file-server.ts"` (match the exact form of the term scripts).

- [ ] **Step 7: Typecheck + commit**

```bash
git add server/src/file-server.ts server/src/file-server-core.ts server/src/file-server-core.test.ts server/package.json
git commit -m "feat(file-viewer): file-server — read-only \$HOME portal on :8791 (TDD path safety)"
```

---

### Task 3: Render pipeline — markdown, bridge script, injection, error pages (TDD)

**Files:**
- Create: `server/src/files-render.ts`
- Test: `server/src/files-render.test.ts`
- Modify: `server/package.json` (+ `"marked": "^15.0.0"` dependency; run `bun install`)

- [ ] **Step 1: Write the failing test:**

```ts
// files-render: md→styled HTML (relative refs preserved), bridge injection
// (with and without </body>), error/unsupported pages.
// Run with: bun src/files-render.test.ts
import assert from 'node:assert/strict'
import { BRIDGE_SCRIPT, errorPage, injectBridge, renderMarkdown } from './files-render.ts'

// markdown: GFM table + relative image + link survive
const md = '# T\n\n|a|b|\n|-|-|\n|1|2|\n\n![d](./diagram.svg) [s](sib.html)'
const html = renderMarkdown(md, 'notes.md')
assert.ok(html.includes('<table>'), 'GFM table rendered')
assert.ok(html.includes('src="./diagram.svg"'), 'relative img preserved')
assert.ok(html.includes('href="sib.html"'), 'relative link preserved')
assert.ok(html.includes('<title>notes.md</title>'), 'title from filename')
assert.ok(html.includes('prefers-color-scheme'), 'dark mode styles present')
assert.ok(html.includes(BRIDGE_SCRIPT), 'rendered markdown ships the bridge')

// injection: before </body> when present…
const withBody = injectBridge('<html><body><p>x</p></body></html>')
assert.ok(withBody.indexOf(BRIDGE_SCRIPT) < withBody.indexOf('</body>'), 'injected before </body>')
// …appended when absent; document content untouched
const noBody = injectBridge('<p>bare</p>')
assert.ok(noBody.startsWith('<p>bare</p>'), 'original content leads')
assert.ok(noBody.includes(BRIDGE_SCRIPT), 'bridge appended')

// bridge contract strings (the client + injected script must agree)
assert.ok(BRIDGE_SCRIPT.includes('ew-file-viewer-ready'))
assert.ok(BRIDGE_SCRIPT.includes('ew-scroll'))
assert.ok(BRIDGE_SCRIPT.includes('ew-scroll-set'))

// error pages: styled, status text present
assert.ok(errorPage('Not found', 'nope.html does not exist').includes('Not found'))

console.log('ok: files-render')
```

- [ ] **Step 2: Run to verify it fails.** Then `cd server && bun add marked` (pins into workspace deps; repo root `bun install` after).

- [ ] **Step 3: Implement `server/src/files-render.ts`:**

```ts
/**
 * /files/* render pipeline: markdown → styled standalone HTML, scroll-bridge
 * injection, and the styled error/unsupported pages. Kept apart from the route
 * so every piece is unit-testable and the file-server stays a dumb byte reader.
 */
import { marked } from 'marked'

/**
 * The scroll-follow bridge, injected into every top-level document. One IIFE,
 * ew-prefixed message types, no globals (spec R6): posts ready + throttled
 * scroll fractions to the parent; applies ew-scroll-set without re-broadcast
 * (echo suppression at the source).
 */
export const BRIDGE_SCRIPT = `<script>(function () {
	var applying = false
	var last = 0
	function fraction() {
		var max = document.documentElement.scrollHeight - window.innerHeight
		return max > 0 ? window.scrollY / max : 0
	}
	window.addEventListener('scroll', function () {
		if (applying) { applying = false; return }
		var now = Date.now()
		if (now - last < 100) return
		last = now
		parent.postMessage({ type: 'ew-scroll', fraction: fraction() }, '*')
	}, { passive: true })
	window.addEventListener('message', function (e) {
		var d = e && e.data
		if (!d || d.type !== 'ew-scroll-set' || typeof d.fraction !== 'number') return
		var max = document.documentElement.scrollHeight - window.innerHeight
		if (max <= 0) return
		applying = true
		window.scrollTo(0, d.fraction * max)
	})
	parent.postMessage({ type: 'ew-file-viewer-ready' }, '*')
})()</script>`

/** Inject the bridge before </body> (last occurrence, case-insensitive), else append. */
export function injectBridge(html: string): string {
	const m = /<\/body\s*>/i.exec(html)
	if (!m) return html + BRIDGE_SCRIPT
	const idx = html.toLowerCase().lastIndexOf('</body')
	return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx)
}

const PAGE_CSS = `<style>
	:root { color-scheme: light dark; }
	body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #1a1a1a; background: #fdfcf9; }
	@media (prefers-color-scheme: dark) { body { color: #e8e6e1; background: #191919; } a { color: #8ab4f8; } }
	pre { background: rgba(127,127,127,.12); padding: .75rem 1rem; border-radius: 6px; overflow-x: auto; }
	code { font-family: ui-monospace, monospace; font-size: .92em; }
	table { border-collapse: collapse; } th, td { border: 1px solid rgba(127,127,127,.4); padding: .3rem .6rem; }
	img { max-width: 100%; }
	blockquote { border-left: 3px solid rgba(127,127,127,.4); margin-left: 0; padding-left: 1rem; opacity: .85; }
</style>`

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** GFM markdown → standalone styled HTML with the bridge already injected. */
export function renderMarkdown(md: string, filename: string): string {
	const body = marked.parse(md, { gfm: true, async: false }) as string
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(filename)}</title>${PAGE_CSS}</head><body>${body}${BRIDGE_SCRIPT}</body></html>`
}

/** Small styled page for 404/502/unsupported/501 — shown inside the control. */
export function errorPage(title: string, message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${PAGE_CSS}</head><body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`
}
```

- [ ] **Step 4: Run to verify it passes.** Also `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add server/src/files-render.ts server/src/files-render.test.ts server/package.json ../bun.lock
git commit -m "feat(file-viewer): render pipeline — marked GFM, scroll bridge, injection, error pages"
```

---

### Task 4: `/files/*` route on the sync server (TDD)

**Files:**
- Create: `server/src/features/files.ts`
- Modify: `server/src/app.ts` (mount — OUTSIDE the `/api` json parser, like uploads; keep the static catch-all last)
- Test: `server/src/files-route.test.ts`

- [ ] **Step 1: Write the failing test.** Boot a real file-server core via a scratch `node:http` server on an ephemeral port (reuse `serveFile` with a temp home), point the route at it via env, boot `createSyncApp`, and assert. House pattern: `process.exit(0)` at the end.

```ts
// /files/* route: md render+inject, html inject, asset passthrough, gateway 501,
// styled 404/502, unsupported type page.
// Run with: bun src/files-route.test.ts
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { serveFile } from './file-server-core.ts'

async function main() {
	// fake agent home + real file-server on an ephemeral port
	const home = await mkdtemp(path.join(os.tmpdir(), 'files-'))
	await mkdir(path.join(home, 'docs'))
	await writeFile(path.join(home, 'docs', 'r.html'), '<html><body><h1>R</h1></body></html>')
	await writeFile(path.join(home, 'docs', 'n.md'), '# Notes')
	await writeFile(path.join(home, 'docs', 's.css'), 'body{color:red}')
	await writeFile(path.join(home, 'docs', 'x.bin'), 'xx')
	const fs = http.createServer(async (req, res) => {
		const u = new URL(req.url ?? '/', 'http://i')
		const served = await serveFile(home, u.pathname.replace(/^\/+/, ''))
		res.writeHead(served.status, served.headers)
		res.end(served.body ?? undefined)
	})
	await new Promise<void>((r) => fs.listen(0, '127.0.0.1', () => r()))
	const fsPort = (fs.address() as { port: number }).port
	process.env.ENSEMBLEWORKS_FILES_PORT = String(fsPort)

	const { createSyncApp } = await import('./app.ts')
	const dataDir = await mkdtemp(path.join(os.tmpdir(), 'files-app-'))
	const { server } = createSyncApp({ dataDir })
	await new Promise<void>((r) => server.listen(0, () => r()))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

	// html: passes through WITH the bridge injected, no-store
	const rHtml = await fetch(`${base}/files/docs/r.html`)
	assert.equal(rHtml.status, 200)
	assert.equal(rHtml.headers.get('cache-control'), 'no-store')
	const htmlText = await rHtml.text()
	assert.ok(htmlText.includes('<h1>R</h1>') && htmlText.includes('ew-file-viewer-ready'), 'html + bridge')

	// markdown: rendered to styled html with bridge
	const rMd = await fetch(`${base}/files/docs/n.md`)
	const mdText = await rMd.text()
	assert.ok(mdText.includes('<h1>Notes</h1>') && mdText.includes('ew-scroll'), 'md rendered + bridge')

	// asset: raw passthrough, upstream content-type
	const rCss = await fetch(`${base}/files/docs/s.css`)
	assert.equal(await rCss.text(), 'body{color:red}')
	assert.ok((rCss.headers.get('content-type') ?? '').includes('text/css'))

	// unsupported top-level type → styled page (200 with explanation is fine; assert content)
	const rBin = await fetch(`${base}/files/docs/x.bin`)
	assert.ok((await rBin.text()).toLowerCase().includes('unsupported'), 'unsupported page')

	// missing file → styled 404 page
	const r404 = await fetch(`${base}/files/docs/nope.html`)
	assert.equal(r404.status, 404)
	assert.ok((await r404.text()).includes('<h1>'), 'styled, not bare')

	// gateway param → 501
	const rGw = await fetch(`${base}/files/docs/r.html?gateway=vm-1`)
	assert.equal(rGw.status, 501)

	// file-server down → styled 502
	fs.close()
	await new Promise((r) => setTimeout(r, 50))
	const r502 = await fetch(`${base}/files/docs/r.html`)
	assert.equal(r502.status, 502)

	console.log('ok: files-route')
	server.close()
	process.exit(0)
}

main()
```

- [ ] **Step 2: Run to verify it fails** (route 404s → html assertion fails).

- [ ] **Step 3: Implement `server/src/features/files.ts`:**

```ts
/**
 * /files/* — the single routing layer the file-viewer iframe talks to.
 * Proxies the local file-server (:8791), rendering markdown to styled HTML and
 * injecting the scroll bridge into every top-level document HERE, so the
 * file-server (and the future remote connector) stay dumb byte readers.
 * `gateway` is the remote seam: v1 rejects it with 501; later a relay arm
 * forwards to the named gateway instead of localhost.
 */
import express from 'express'
import path from 'node:path'
import { errorPage, injectBridge, renderMarkdown } from '../files-render.ts'

const DOC_HTML = new Set(['.html', '.htm'])
const DOC_MD = new Set(['.md', '.markdown'])
// Subresources documents legitimately request; anything else asked for as the
// top-level document gets the unsupported page.
const ASSETS = new Set([
	'.css', '.js', '.mjs', '.json', '.map', '.txt', '.csv',
	'.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
	'.woff', '.woff2', '.ttf', '.otf', '.pdf',
])

const filesPort = () => Number(process.env.ENSEMBLEWORKS_FILES_PORT ?? 8791)

export function createFilesRouter(): express.Router {
	const router = express.Router()

	router.get(/^\/files\/(.+)/, async (req, res) => {
		const rel = (req.params as unknown as string[])[0] ?? ''
		const gateway = String(req.query.gateway ?? '')
		const sendPage = (status: number, title: string, msg: string) =>
			res.status(status).set('cache-control', 'no-store').type('html').send(errorPage(title, msg))

		if (gateway) {
			return void sendPage(501, 'Remote files not yet supported', `gateway "${gateway}" — the remote file transport lands with the connector engine.`)
		}

		let upstream: Response
		try {
			upstream = await fetch(`http://127.0.0.1:${filesPort()}/${rel}`)
		} catch {
			return void sendPage(502, 'File server unavailable', 'The file-server (:8791) is not responding. Is the stack service running?')
		}
		if (upstream.status === 403) return void sendPage(403, 'Forbidden', 'That path escapes the served home directory.')
		if (upstream.status !== 200) return void sendPage(404, 'Not found', `${rel} does not exist (or is a directory).`)

		const ext = path.extname(rel).toLowerCase()
		res.set('cache-control', 'no-store')
		if (DOC_MD.has(ext)) {
			const md = await upstream.text()
			return void res.type('html').send(renderMarkdown(md, path.basename(rel)))
		}
		if (DOC_HTML.has(ext)) {
			const html = await upstream.text()
			return void res.type('html').send(injectBridge(html))
		}
		if (ASSETS.has(ext)) {
			const type = upstream.headers.get('content-type')
			if (type) res.set('content-type', type)
			return void res.send(Buffer.from(await upstream.arrayBuffer()))
		}
		return void sendPage(200, 'Unsupported type', `"${ext || '(no extension)'}" cannot be shown as a document. v1 renders HTML and Markdown.`)
	})

	return router
}
```

(Express 5 route-regex note: if `router.get(/^\/files\/(.+)/, …)` capture access differs, use the string pattern `'/files/*splat'` / `req.params` per the express version in use — check how `uploads.ts`/`app.ts` handle params and adapt; the test is the arbiter.)

- [ ] **Step 4: Mount in `app.ts`** next to the uploads router (both live outside the `/api` json parser; `/files` must stay ABOVE the static catch-all):

```ts
	app.use(createFilesRouter())          // GET /files/* — file portal (proxies :8791)
```

with the import alongside the other feature imports.

- [ ] **Step 5: Run the test until green.** Also rerun `bun src/tools-api.test.ts` — `/files` is not under `/api` so the manifest test is unaffected.

- [ ] **Step 6: Commit**

```bash
git add server/src/features/files.ts server/src/app.ts server/src/files-route.test.ts
git commit -m "feat(file-viewer): /files/* route — proxy, md render, bridge injection, error pages, gateway 501 seam"
```

---

### Task 5: `POST /api/canvas/file-viewer` endpoint (TDD)

**Files:**
- Create: `server/src/features/file-viewer.ts`
- Modify: `server/src/app.ts` (mount with the other `/api` feature routers)
- Modify: `server/src/schema.ts` (register the `file-viewer` shape type with `fileViewerShapeProps` — mirror how roadmap/iframe shapes are registered; READ the file first)
- Test: `server/src/file-viewer-api.test.ts`

- [ ] **Step 1: READ `server/src/features/sticky.ts` end-to-end and `server/src/features/roadmap.ts` (the rev fan-out around line 93-103) and `server/src/schema.ts`.** The endpoint follows sticky for open (placement, attribution, store txn) and roadmap for refresh (updateStore rev bump).

- [ ] **Step 2: Write the failing test** (mirror an existing `*-api.test.ts` — boot on temp dir, POST, then inspect the room store via `getOrCreateRoom(room).getCurrentSnapshot()` or however existing feature tests read shapes back — copy their access pattern; `process.exit(0)` at the end):

Assertions:
1. `open {path:'docs/r.html'}` → 200 `{ok:true, id}`; a `file-viewer` shape exists with `props.path==='docs/r.html'`, `props.rev===0`, `props.title==='r.html'`.
2. `open {path:'~/docs/r2.html'}` → path stored as `docs/r2.html` (tilde stripped).
3. `open {path:'../../etc/passwd'}` → 400. `open {path:'/etc/passwd'}` → 400. `open` with an absolute path under the agent home (`${AGENT_HOME}/x.html` where the test sets `process.env.ENSEMBLEWORKS_AGENT_HOME`) → stored home-relative.
4. `open {gateway:'vm-1'}` → 501.
5. `refresh {path:'docs/r.html'}` → `{ok:true, updated:1}` and the shape's `rev` is now 1; a second refresh → rev 2. `refresh {path:'docs/absent.html'}` → `{ok:true, updated:0}`.
6. `op:'nonsense'` → 400.

- [ ] **Step 3: Implement.** Key logic (adapt to the exact store API you found in Step 1 — sticky's transaction shape wins where they differ):

```ts
/**
 * file-viewer feature — POST /api/canvas/file-viewer.
 *   op:open     create a file-viewer shape pointing at a home-relative path
 *               (placement + attribution modelled on sticky).
 *   op:refresh  bump rev on every file-viewer shape matching the path — the
 *               "everyone look again" nudge (roadmap rev fan-out pattern).
 * v1 rejects `gateway` with 501 (the remote seam lands with the connector).
 */
```

Path normalisation helper (exported for reuse by tests):

```ts
const AGENT_HOME = () => process.env.ENSEMBLEWORKS_AGENT_HOME ?? os.homedir()

/** Home-relativise + validate. Returns the clean relative path or null. */
export function normalizeHomePath(raw: string): string | null {
	let p = raw.trim()
	if (!p) return null
	if (p.startsWith('~/')) p = p.slice(2)
	const home = AGENT_HOME()
	if (p.startsWith('/')) {
		if (p === home || p.startsWith(home + '/')) p = p.slice(home.length + 1)
		else return null // absolute outside home
	}
	// reject traversal anywhere (also catches encoded forms post-decode)
	if (p.split('/').some((seg) => seg === '..' || seg === '')) return null
	return p
}
```

open: `createShapeId()`, shape `{ id, type: 'file-viewer', x, y, props: { w: 720, h: 540, path, title: title ?? basename(path), rev: 0 } }` — placement: reuse sticky's frame-or-grid placement helpers as found in Step 1; attribution: `resolveAttribution`/`meta.author` exactly as sticky does. refresh: `ctx.rooms.getOrCreateRoom(roomId).updateStore((store) => { …for each matching file-viewer shape: store.put with rev+1… })`, counting matches (roadmap.ts:93-103 is the template).

- [ ] **Step 4: Register the shape type in `server/src/schema.ts`** so the server-side store accepts `file-viewer` records (mirror the existing custom-shape registrations — this is REQUIRED before `open` can put the shape).

- [ ] **Step 5: Mount** in `app.ts` with the other feature routers (order: near sticky/roadmap). Run the test until green. Then run `bun src/tools-api.test.ts` — it should NOW pass with 17 (the Task-1 count bump + this mount close the loop). Run the whole server suite dir if quick: `for t in src/*.test.ts; do bun $t || break; done` (or at minimum: canvas-api, tools-api, write-scope-related tests — `POST /api/canvas/file-viewer` sits behind the write-scope guard automatically because the guard is `app.use`'d on `/api`; confirm no write-scope test enumerates POST routes and needs the new one added).

- [ ] **Step 6: Commit**

```bash
git add server/src/features/file-viewer.ts server/src/app.ts server/src/schema.ts server/src/file-viewer-api.test.ts
git commit -m "feat(file-viewer): open/refresh endpoint — path normalisation, placement, rev fan-out"
```

---

### Task 6: Client shape — `file-viewer` plugin

**Files:**
- Create: `client/src/file-viewer/plugin.tsx`, `client/src/file-viewer/FileViewerShapeUtil.tsx`, `client/src/file-viewer/createFileViewerShape.ts`
- Modify: `client/src/plugins.ts` (register after `roadmapPlugin`)

- [ ] **Step 1: READ `client/src/iframe/` (all four files) and `client/src/roadmap/plugin.tsx` + `RoadmapShapeUtil.tsx`.** The file-viewer is their sibling: same plugin shape (shape util + toolbar item + icon), same interaction gating (double-click to edit, `pointerEvents` on `isEditing`, wheel/pointer `stopPropagation` while editing).

- [ ] **Step 2: `FileViewerShapeUtil.tsx`** — `BaseBoxShapeUtil<FileViewerShape>` with:
- `static override type = 'file-viewer' as const`; `static override props = fileViewerShapeProps` (import from `@ensembleworks/contracts`).
- `getDefaultProps(): { w: 720, h: 540, path: '', title: '', rev: 0 }`.
- Component: header bar (title/filename, a ↻ refresh button, a Present toggle placeholder — Task 7 wires it) + `<iframe src={`/files/${props.path}?rev=${props.rev ?? 0}`} sandbox="allow-scripts allow-forms allow-downloads" …/>`. **No `allow-same-origin`. Never add it.**
- Refresh button: `editor.updateShape({ id, type: 'file-viewer', props: { rev: (props.rev ?? 0) + 1 } })` — shared "look again", same semantics as the endpoint refresh.
- Copy the iframe/roadmap editing-gate JSX/handlers verbatim-in-spirit (double-click to interact; while not editing the iframe gets `pointerEvents: 'none'`).

- [ ] **Step 3: `createFileViewerShape.ts`** — toolbar action prompting for a path (mirror `createDevServerShape.ts`), creating the shape centred on the viewport with `rev: 0`, `title` = basename.

- [ ] **Step 4: `plugin.tsx`** — mirror `iframe/plugin.tsx` (shape util + toolbar item labelled "File viewer" + icon; reuse an existing icon the way the sibling plugins do). Register in `client/src/plugins.ts` after `roadmapPlugin`.

- [ ] **Step 5: Verify** — `cd client && bun run typecheck`. Manual check happens in Task 9/12 (needs the stack).

- [ ] **Step 6: Commit**

```bash
git add client/src/file-viewer/ client/src/plugins.ts
git commit -m "feat(file-viewer): client shape — sandboxed iframe portal with header + refresh"
```

---

### Task 7: Scroll-follow — presence bridge (TDD the pure logic)

**Files:**
- Create: `client/src/file-viewer/presentStore.ts` (module store: what I am presenting)
- Create: `client/src/file-viewer/followLogic.ts` (pure: who is presenting a shape, should I follow)
- Test: `client/src/file-viewer/followLogic.test.ts`
- Modify: `client/src/App.tsx` (merge presenter state into presence `meta` next to `stamp`)
- Modify: `client/src/file-viewer/FileViewerShapeUtil.tsx` (wire Present toggle + follower behaviour)

- [ ] **Step 1: `presentStore.ts`** — a tiny module singleton (the pattern App.tsx can read synchronously from `getUserPresence`):

```ts
/**
 * What THIS client is presenting: shapeId + latest scroll fraction, or null.
 * Read synchronously by App.tsx's getUserPresence (merged into presence meta —
 * presence dies with the session, so presentation can never fossilise in the
 * document). Setting state nudges tldraw to re-read presence via the provided
 * poke callback (registered by App).
 */
export interface Presenting {
	shapeId: string
	fraction: number
}

let current: Presenting | null = null
let poke: (() => void) | null = null

export const presentStore = {
	get: (): Presenting | null => current,
	set(next: Presenting | null) {
		current = next
		poke?.()
	},
	registerPoke(fn: () => void) {
		poke = fn
	},
}
```

- [ ] **Step 2: TDD `followLogic.ts`.** Failing test first:

```ts
// followLogic: pick the presenter for a shape from collaborator presence meta.
// Run with: bun src/file-viewer/followLogic.test.ts
import assert from 'node:assert/strict'
import { presenterFor } from './followLogic'

const peer = (userId: string, meta: unknown) => ({ userId, userName: userId, meta }) as never

// no presenters
assert.equal(presenterFor([peer('a', {})], 'shape:1'), null)
// one presenter for our shape
const p = presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.5 } })], 'shape:1')
assert.equal(p?.userId, 'a')
assert.equal(p?.fraction, 0.5)
// presenting a DIFFERENT shape → not ours
assert.equal(presenterFor([peer('a', { fileViewerPresent: { shapeId: 'shape:2', fraction: 0.5 } })], 'shape:1'), null)
// malformed meta ignored
assert.equal(presenterFor([peer('a', { fileViewerPresent: { shapeId: 42 } })], 'shape:1'), null)
// two presenters → first wins deterministically (last-writer-wins is enforced at the source; the reader just needs stability)
const two = [
	peer('a', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.1 } }),
	peer('b', { fileViewerPresent: { shapeId: 'shape:1', fraction: 0.9 } }),
]
assert.equal(presenterFor(two, 'shape:1')?.userId, 'a')

console.log('ok: followLogic')
```

Implementation:

```ts
/** Extract the presenter (if any) of a given shape from collaborator presence. */
export interface PresenceLike {
	userId: string
	userName: string
	meta?: unknown
}

export interface PresenterInfo {
	userId: string
	userName: string
	fraction: number
}

export function presenterFor(peers: readonly PresenceLike[], shapeId: string): PresenterInfo | null {
	for (const p of peers) {
		const m = (p.meta as { fileViewerPresent?: { shapeId?: unknown; fraction?: unknown } } | undefined)
			?.fileViewerPresent
		if (!m || m.shapeId !== shapeId || typeof m.fraction !== 'number') continue
		return { userId: p.userId, userName: p.userName, fraction: m.fraction }
	}
	return null
}
```

- [ ] **Step 3: App.tsx presence merge.** In `getUserPresence` (client/src/App.tsx:76-92), merge the presenter state next to the stamp:

```ts
			return { ...defaults, meta: { stamp, fileViewerPresent: presentStore.get() } }
```

(import `presentStore`; tldraw meta values must be JSON-serialisable — `null` is fine). Also register the poke so toggling Present refreshes presence promptly: tldraw recomputes presence reactively on store/pointer changes; if a dedicated poke hook isn't obvious from the `useSync` API, note it and rely on the ~continuous presence updates from cursor movement — the presenter is actively scrolling when it matters. Do not over-engineer.

- [ ] **Step 4: Wire the ShapeUtil.** In the component (React state only, never props):
- `postMessage` plumbing: `useEffect` window `message` listener; accept only events where `e.source === iframeRef.current?.contentWindow`; handle `ew-file-viewer-ready` (if presenting, re-send last fraction — covers the refresh/rev reload) and `ew-scroll` (if presenting, `presentStore.set({ shapeId: shape.id, fraction })`).
- Present toggle: on → `presentStore.set({ shapeId: shape.id, fraction: 0 })`; off → `presentStore.set(null)`. Turning it on when someone else presents simply overwrites your own state (last-writer-wins by design).
- Follower: `const collaborators = useValue('collaborators', () => editor.getCollaborators(), [editor])`, `const presenter = presenterFor(collaborators, shape.id)`; when `presenter` exists, isn't me, and I haven't opted out → `iframeRef.current?.contentWindow?.postMessage({ type: 'ew-scroll-set', fraction: presenter.fraction }, '*')` (in a `useEffect` keyed on `presenter?.fraction`). Header shows `Following <name> — stop`; stop sets a local `optOut` React state, cleared when the presentation ends (`presenter == null`).
- While presenting, header shows the toggle active ("Presenting — stop").

- [ ] **Step 5: Run** `bun src/file-viewer/followLogic.test.ts` + `bun run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add client/src/file-viewer/ client/src/App.tsx
git commit -m "feat(file-viewer): scroll-follow — presence-meta presenter, follower bridge, opt-out"
```

---

### Task 8: CLI — native `file` verb group

**Files:**
- Create: `cli/src/native/file.ts`
- Test: `cli/src/native/file.test.ts` (pure path-resolution logic)
- Modify: `cli/src/dispatch.ts` (native pairs — BEFORE the manifest layer, mirroring `terminal connect` / `canvas pull-images` at lines ~80-81; also add `file open|refresh` to the top-help text where the other groups are listed)

- [ ] **Step 1: READ `cli/src/native/pull-images.ts`** (closest sibling: a native verb that POSTs to a canvas endpoint via the resolved connection) **and `cli/src/http.ts` / `cli/src/resolve.ts`** for the request + connection helpers. Match their conventions exactly (errors via `CliError`, output via `emitLine`, `--json` support).

- [ ] **Step 2: TDD the path logic** — `resolveFileArg(raw, cwd, home)`:

```ts
// resolveFileArg: PWD-relative → home-relative; ~ and abs-under-home accepted;
// abs-outside-home and traversal rejected.
// Run with: bun src/native/file.test.ts
import assert from 'node:assert/strict'
import { resolveFileArg } from './file.ts'

const home = '/home/agent'
// relative to a cwd inside home
assert.equal(resolveFileArg('docs/r.html', '/home/agent/my-repo', home), 'my-repo/docs/r.html')
// already home-rooted forms
assert.equal(resolveFileArg('~/docs/r.html', '/anywhere', home), 'docs/r.html')
assert.equal(resolveFileArg('/home/agent/docs/r.html', '/anywhere', home), 'docs/r.html')
// cwd at home root
assert.equal(resolveFileArg('r.html', '/home/agent', home), 'r.html')
// .. that stays inside home is fine after resolution
assert.equal(resolveFileArg('../docs/r.html', '/home/agent/my-repo', home), 'docs/r.html')
// escapes
assert.equal(resolveFileArg('/etc/passwd', '/home/agent', home), null)
assert.equal(resolveFileArg('../../etc/passwd', '/home/agent', home), null)

console.log('ok: cli file resolveFileArg')
```

Implementation (in `file.ts`):

```ts
/** Resolve a user-supplied path against cwd, then home-relativise. null = outside home. */
export function resolveFileArg(raw: string, cwd: string, home: string): string | null {
	const expanded = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
	const abs = path.resolve(cwd, expanded)
	if (abs === home) return null // home itself is a directory
	if (!abs.startsWith(home + path.sep)) return null
	return abs.slice(home.length + 1)
}
```

- [ ] **Step 3: The verbs.** `fileOpen(args, globals, env)` parses `<path> [--frame <name>] [--title <t>]`; `fileRefresh(args, globals, env)` parses `<path>`. Both: `resolveFileArg(arg, process.cwd(), os.homedir())` (error exit 2 with a clear message when null), then POST `/api/canvas/file-viewer` with `{ op, room, path, …, ...(env.ENSEMBLEWORKS_GATEWAY_ID ? { gateway: env.ENSEMBLEWORKS_GATEWAY_ID } : {}) }` through the same conn/http helpers pull-images uses. Print the result (`opened <path> → <id>` / `refreshed <path> — <n> viewer(s)`), `--json` passthrough.

- [ ] **Step 4: Dispatch registration** (dispatch.ts, next to the existing pairs):

```ts
	if (group === 'file' && verb === 'open') return fileOpen(rest.slice(2), globals, env)
	if (group === 'file' && verb === 'refresh') return fileRefresh(rest.slice(2), globals, env)
```

Native pairs win over the manifest layer, so these shadow the (blunter) manifest-rendered `file open/refresh` — exactly the intent: same endpoint, better ergonomics.

- [ ] **Step 5: Run** the new test + any existing cli tests (`cd cli && for t in src/**/*.test.ts src/*.test.ts; do bun $t || break; done`) + typecheck. If `cli-api.test.ts` or help-text tests enumerate verb groups, add `file` where they expect it.

- [ ] **Step 6: Commit**

```bash
git add cli/src/native/file.ts cli/src/native/file.test.ts cli/src/dispatch.ts
git commit -m "feat(file-viewer): ensembleworks file open/refresh — PWD-aware paths, gateway env passthrough"
```

---

### Task 9: Stack + deploy wiring

**Files:**
- Modify: `bin/dev-lib.mjs` (PORTS + `files` service entry)
- Modify: `client/vite.config.ts` (proxy `/files` → :8788)
- Modify: `deploy/Caddyfile` (dev: add `/files /files/*` to the `@backend` matcher)
- Create: `deploy/systemd/prod/ensembleworks-files.service`
- Modify: `deploy/deploy.sh` (install/restart the new unit wherever ensembleworks-term.service is handled)
- Modify: `bin/dev.test.ts` if it asserts the service list (check!)

- [ ] **Step 1: dev-lib.** Add `files: 8791` to the `PORTS` map (bin/dev-lib.mjs:~12). Add the service after `term` (mirror its shape exactly):

```js
	services.push({
		name: 'files',
		enabled: true,
		reason: 'file portal on :8791',
		cmd: "bun run --filter '@ensembleworks/server' dev:files",
		health: { kind: 'port', port: PORTS.files },
	})
```

- [ ] **Step 2: Vite proxy** (client/vite.config.ts, in `server.proxy`, before the `/api` catch-all is irrelevant — `/files` doesn't collide, add alongside `/uploads`):

```ts
			'/files': 'http://localhost:8788',
```

- [ ] **Step 3: Dev Caddyfile.** Extend the `@backend` matcher line to include the new path (Caddy routes backends DIRECTLY to :8788 — Vite's WS-proxy limitation forced that split; /files rides the same route):

```
	@backend path /sync /sync/* /api /api/* /uploads /uploads/* /files /files/*
```

(Prod Caddyfile needs nothing: its catch-all already proxies to :8788.)

- [ ] **Step 4: Prod unit.** READ `deploy/systemd/prod/ensembleworks-term.service` first; model `ensembleworks-files.service` on it:
- runs `@APP_HOME@/current/ensembleworks-server files` **if** the compiled server dispatcher supports a `files` subcommand — CHECK `server/src/main.ts` (the literal-dynamic-import dispatcher from the Bun migration): add a `files` arm mirroring `term` → `./file-server.ts` if it exists, and keep the unit's ExecStart consistent with how term does it;
- `User=` the agent sandbox user via the same launcher pattern the term unit uses (READ the unit; if terminals use a sudo launcher rather than `User=`, mirror THAT and add the one-line launcher note; R2: fixed binary path, no args from the app user);
- no `ExecStartPre` port guard needed (single binary, no wrapper — but if the term unit's KillMode/guard comments say otherwise, follow the local wisdom);
- `Environment=PORT=8791`.

- [ ] **Step 5: deploy.sh** — grep for `ensembleworks-term.service` and add `ensembleworks-files.service` to every list it appears in (install, enable, restart).

- [ ] **Step 6: bin/dev tests.** `bun bin/dev.test.ts` (or however `bin/dev.test.ts` runs — check its header). If it asserts the service list/count, add `files`.

- [ ] **Step 7: Typecheck + commit**

```bash
git add bin/dev-lib.mjs client/vite.config.ts deploy/Caddyfile deploy/systemd/prod/ensembleworks-files.service deploy/deploy.sh server/src/main.ts bin/dev.test.ts
git commit -m "feat(file-viewer): stack + deploy wiring — :8791 service, /files routing, prod unit"
```

---

### Task 10: `publish-doc` agent skill

**Files:**
- Create: `deploy/agent-home/.claude/skills/publish-doc/SKILL.md`
- Modify: `deploy/deploy.sh` ONLY if the sandbox seed enumerates files (check how AGENTS.md/.claude/CLAUDE.md are shipped; if it copies the whole `agent-home/` tree, nothing to do)

- [ ] **Step 1: Write the skill** (frontmatter style: copy the header shape from an existing `.claude/skills/*/SKILL.md` in the repo):

```markdown
---
name: publish-doc
description: Show a rich document (report, plan, storyboard, mockup) on the canvas — write it to a file and open a file-viewer; never publish team documents to public URLs.
---

# Publishing a document to the canvas

When the user wants to SEE a document — a report, plan, storyboard, dashboard,
mockup — write it to a file under your home directory and put it on the canvas:

    ensembleworks file open my-repo/docs/report.html
    # iterate: edit the file, then make every open viewer reload
    ensembleworks file refresh my-repo/docs/report.html

The canvas control is a portal onto the file on disk — nothing is uploaded.
Relative references (CSS, images, sibling JSON) resolve against the real
directory and just work.

## Authoring guidance

- **Standalone HTML with inline CSS** is the sweet spot. Relative-path assets
  also work (the portal serves siblings).
- Support **light and dark** via `@media (prefers-color-scheme: dark)`.
- **No unguarded `localStorage`/`document.cookie`** — the document runs in an
  opaque-origin sandbox and unguarded access THROWS. Wrap in try/catch if you
  must feature-detect.
- Prefer **SVG charts** over `<canvas>` (renders identically, and mirrors
  better when richer shared-viewing lands).
- **Markdown is fine for prose** — `.md` files render as styled HTML (GFM).
- Anything else (images, PDFs, source files as the top document) shows an
  "unsupported type" page in v1.

## Presenting

- Tell the humans about the header's **Present** toggle — everyone else's
  viewer follows the presenter's scroll position.
- After each significant edit, run `ensembleworks file refresh <path>` so every
  open viewer reloads.

## What NOT to do

- **Do not publish team documents to public URLs** (Cloudflare Pages, gists,
  etc.) — that route is retired. The one alternative: a claude.ai Artifact,
  only when the audience is a private Claude workspace rather than the canvas
  room.
- Do not hand-run a web server for this; the file-viewer replaces that.
```

- [ ] **Step 2: Verify the seed ships it** (deploy.sh reading from Step 2 of Task 9 — whole-tree copy vs enumerated list) and commit:

```bash
git add deploy/agent-home/.claude/skills/publish-doc/SKILL.md deploy/deploy.sh
git commit -m "feat(file-viewer): publish-doc agent skill — the adoption surface"
```

---

### Task 11: Server-level smoke test (scripted, headless)

**Files:**
- Create: `server/src/file-viewer-smoke.test.ts`

- [ ] **Step 1: Write the smoke** (the spec's §Testing smoke, minus the browser): temp home with `report.md` + `report.html` + `style.css`; boot the real file-server entry logic (reuse `serveFile` via a scratch http server on an ephemeral port, set `ENSEMBLEWORKS_FILES_PORT`); boot `createSyncApp`; then in one flow:
1. `POST /api/canvas/file-viewer {op:'open', path:'report.html'}` → shape exists with expected props (`rev:0`).
2. `GET /files/report.html` → 200, contains the document content AND `ew-file-viewer-ready` (bridge injected).
3. `GET /files/report.md` → rendered HTML with bridge.
4. `GET /files/style.css` → raw passthrough.
5. `POST {op:'refresh', path:'report.html'}` → `updated:1`, shape `rev:1`.
`console.log('ok: file-viewer smoke')`, `process.exit(0)`.

- [ ] **Step 2: Run it + the full repo suite + build:**

```bash
bun run typecheck && bun run test && bun run build
```

All three must pass (build exercises the client shape through `vite build`).

- [ ] **Step 3: Commit**

```bash
git add server/src/file-viewer-smoke.test.ts
git commit -m "test(file-viewer): end-to-end server smoke — open, serve+inject, render, refresh"
```

---

### Task 12: Browser interaction gate (orchestrator-driven, post-merge)

Not a subagent task. After the final code review and merge to `unified-architecture-migration`, the orchestrator (with live browser control on the running dev stack):
1. Write a scrollable HTML doc into the dev home; `ensembleworks file open` it (or via the endpoint).
2. Confirm the shape renders the document on the canvas; refresh button reloads.
3. Two clients (two tabs): Present in one, verify the other tracks scroll fraction; "stop" opts out; closing the presenter tab ends following.
4. `file refresh` → both iframes reload.

This is the spec's v1 gate for scroll-follow ("can't be meaningfully verified below the browser level").

---

## Self-review notes

- **Spec coverage:** file-server §1 ✓ T2 (+prod unit T9); /files route §2 ✓ T4 (md at route, injection, error pages, gateway 501, no-store); shape §3 ✓ T6 (props in contracts T1); CLI+endpoint §4 ✓ T5+T8 (ToolDefs T1; write-scope rides the existing `/api` guard); scroll bridge §5 ✓ T3 (script) + T7 (presence + component) — V1 verified positive at plan time; publish-doc skill §6 ✓ T10; error table ✓ T2/T4/T5; testing section ✓ T2/T3/T4/T5/T7/T8 units, T11 smoke, T12 browser gate; security posture ✓ (sandbox attr T6, opaque-origin note in skill T10, localhost bind T2).
- **Deliberate deviations from spec text:** none of substance; `canvas file …` interim aliases dropped because the #4 CLI shipped first (spec explicitly planned for this: "the ToolDef + endpoint are the stable part either way").
- **Placeholder scan:** every code step has concrete code or an explicit READ-this-file-first instruction with the exact pattern named; no TBDs.
- **Type consistency:** `fileViewerShapeProps` names (`path`,`title`,`rev`,`gateway`) match across contracts (T1), server schema + endpoint (T5), client shape (T6), iframe URL (T6), CLI payloads (T8). Bridge message types (`ew-file-viewer-ready`/`ew-scroll`/`ew-scroll-set`) pinned by the T3 test and consumed in T7. Port 8791/`ENSEMBLEWORKS_FILES_PORT` consistent T2/T4/T9/T11.
- **Known integration risks for reviewers:** express route-pattern syntax for `/files/*` (Task 4 note); tldraw presence-meta re-read cadence for the Present toggle (Task 7 Step 3 note — acceptable because a presenter is actively scrolling); tools tests count bump ordering (T1 leaves tools-api red until T5 — flagged in both tasks).
