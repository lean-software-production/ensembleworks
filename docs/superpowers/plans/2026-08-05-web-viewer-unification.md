# Web Viewer Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the dev-server `iframe` control into the file-viewer, rename the result **web-viewer** everywhere (wire type included), and give dev-server sources the full force-follow stack via a new injecting `/dev/{port}` proxy.

**Architecture:** The shape gains a source discriminator (`kind: 'file' | 'dev'` + optional `port`); a store-level tldraw migration retypes existing `file-viewer` records to `web-viewer` and converts `iframe` records to text links. The server terminates `/dev/{port}` traffic (Caddy now routes it to the sync server), injecting the existing rrweb bridge plus a URL-patch script and an error reporter into HTML responses, and passing WebSocket upgrades through to the target port. A Caddy `Referer`-based fallback routes stray root-absolute asset requests back to the right dev server.

**Tech Stack:** TypeScript, Bun (tests: plain `bun <path>` assert scripts), express, tldraw 5.1.0 (`@tldraw/tlschema`, `@tldraw/store` migrations), node:http for proxying, Caddy.

**Spec:** `docs/superpowers/specs/2026-08-05-web-viewer-unification-design.md`

## Global Constraints

- Wire shape type becomes `web-viewer`; a store-scoped migration retypes existing `file-viewer` records. Old `iframe` records migrate to tldraw `text` shapes whose text is the URL, link-formatted (best-effort: if the text-shape conversion fights validation, park it and report — do not block the plan on it).
- HTTP route becomes `POST /api/canvas/web-viewer`; the old `/api/canvas/file-viewer` path (and its `/present-events`, `/present-stop` subroutes) must keep answering as deprecated aliases.
- File sources keep the exact sandbox `allow-scripts allow-forms allow-downloads` (NO `allow-same-origin`). Dev sources get `allow-scripts allow-same-origin allow-forms allow-popups allow-downloads`. The profile is derived from `kind` in exactly one place.
- External URLs are rejected at creation. Local detection rule: hostname in `['localhost', '127.0.0.1', '[::1]']` (same as the old `toProxiedUrl`).
- No new npm dependencies for the proxy — node:http + raw socket piping.
- `client/src/file-viewer/` moves to `client/src/web-viewer/`; presence meta key `fileViewerPresent` → `webViewerPresent`; `hasFileViewerBaton` → `hasWebViewerBaton`. All force-follow behaviour (baton, LWW steal, frozen view, relay retention) is preserved unchanged.
- Tests are plain Bun assert scripts run directly (`bun path/to/x.test.ts`); `bun run typecheck` and `bun run test` must stay green; the client bundle-size gate (`client/scripts/bundle-size-check.ts`) must pass.
- Branch: `feat/web-viewer-unification` off `main`.
- ux-contract: none — legacy v1 tldraw web-viewer UI; not a canvas-editor/canvas-react/canvas-v2 contract surface (goes in the PR body).
- Do not touch `client/src/canvas-v2/` (v2 engine out of scope) except where a comment literally names a moved file path.

---

### Task 1: Contracts — webViewerShapeProps, store migration, tool defs

**Files:**
- Modify: `contracts/src/shapes.ts`
- Create: `contracts/src/canvas-migrations.ts`
- Create: `contracts/src/canvas-migrations.test.ts`
- Modify: `contracts/src/tools/file.ts`
- Modify: `contracts/src/index.ts` (export the new module; follow the existing export style)
- Modify: `contracts/package.json` (add `"@tldraw/store": "5.1.0"` and `"@tldraw/tlschema": "5.1.0"` to dependencies if not present; run `bun install`)

**Interfaces:**
- Produces: `webViewerShapeProps` (replaces `fileViewerShapeProps`; adds `kind`, `port`), `webViewerMigrations: MigrationSequence` (sequence id `com.ensembleworks.web-viewer`), updated `fileOpen`/`fileRefresh` ToolDefs pointing at `/api/canvas/web-viewer`.
- Consumed by: Task 2 (server schema + router), Task 3 (client shape util + useSync).

- [ ] **Step 1: Write the failing migration test**

`contracts/src/canvas-migrations.test.ts`:

```typescript
/** Store migration: file-viewer→web-viewer retype; iframe→text link. Run: bun contracts/src/canvas-migrations.test.ts */
import assert from 'node:assert/strict'
import { webViewerMigrations } from './canvas-migrations.ts'

// The sequence exposes its migrations; apply the store-scoped `up` by hand to
// a serialized-store object, the way tldraw will at snapshot-load time.
const up = webViewerMigrations.sequence[0].up as (store: Record<string, any>) => void

{
	const store: Record<string, any> = {
		'shape:fv1': {
			typeName: 'shape', id: 'shape:fv1', type: 'file-viewer',
			x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
			props: { w: 720, h: 540, path: 'docs/report.html', title: 'report.html', rev: 3 },
		},
	}
	up(store)
	const s = store['shape:fv1']
	assert.equal(s.type, 'web-viewer', 'file-viewer records are retyped')
	assert.equal(s.props.kind, 'file', 'retyped records default to kind file')
	assert.equal(s.props.path, 'docs/report.html', 'path survives')
	assert.equal(s.props.rev, 3, 'rev survives')
}

{
	const store: Record<string, any> = {
		'shape:if1': {
			typeName: 'shape', id: 'shape:if1', type: 'iframe',
			x: 10, y: 20, rotation: 0, index: 'a2', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
			props: { w: 800, h: 600, url: 'http://localhost:3000/', title: 'vite' },
		},
	}
	up(store)
	const s = store['shape:if1']
	assert.equal(s.type, 'text', 'iframe records become text shapes')
	const json = JSON.stringify(s.props.richText)
	assert.ok(json.includes('http://localhost:3000/'), 'URL is the text')
	assert.ok(json.includes('"link"'), 'URL is link-marked')
	assert.equal(s.x, 10, 'position survives')
}

{
	// Untouched records pass through unchanged.
	const rec = { typeName: 'shape', id: 'shape:n1', type: 'note', props: { color: 'yellow' } }
	const store: Record<string, any> = { 'shape:n1': structuredClone(rec) }
	up(store)
	assert.deepEqual(store['shape:n1'], rec, 'other shapes untouched')
}

console.log('canvas-migrations.test.ts OK')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun contracts/src/canvas-migrations.test.ts`
Expected: FAIL — `Cannot find module './canvas-migrations.ts'`

- [ ] **Step 3: Implement `contracts/src/canvas-migrations.ts`**

```typescript
/**
 * Store-scoped canvas migrations (spec:
 * 2026-08-05-web-viewer-unification-design.md): retype `file-viewer` shapes
 * to `web-viewer` (adding the source discriminator, kind defaulting to
 * 'file'), and convert retired `iframe` shapes into plain text shapes whose
 * text is the URL, link-formatted. Registered on BOTH sides — the server's
 * createTLSchema and the client's useSync — so snapshots and live stores
 * migrate identically.
 */
import { createMigrationSequence } from '@tldraw/store'

/** Minimal tiptap-JSON doc: one paragraph, one link-marked text node. */
function urlRichText(url: string) {
	return {
		type: 'doc',
		content: [
			{
				type: 'paragraph',
				content: [
					{ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', class: null } }] },
				],
			},
		],
	}
}

export const webViewerMigrations = createMigrationSequence({
	sequenceId: 'com.ensembleworks.web-viewer',
	retroactive: true,
	sequence: [
		{
			id: 'com.ensembleworks.web-viewer/1',
			scope: 'store',
			up(store: Record<string, any>) {
				for (const [id, rec] of Object.entries(store)) {
					if (!rec || rec.typeName !== 'shape') continue
					if (rec.type === 'file-viewer') {
						rec.type = 'web-viewer'
						rec.props = { ...rec.props, kind: 'file' }
					} else if (rec.type === 'iframe') {
						const { w, url, title } = rec.props ?? {}
						store[id] = {
							typeName: 'shape',
							id: rec.id,
							type: 'text',
							x: rec.x,
							y: rec.y,
							rotation: rec.rotation ?? 0,
							index: rec.index,
							parentId: rec.parentId,
							isLocked: rec.isLocked ?? false,
							opacity: rec.opacity ?? 1,
							meta: rec.meta ?? {},
							props: {
								color: 'black',
								size: 'm',
								font: 'draw',
								textAlign: 'start',
								w: typeof w === 'number' ? w : 400,
								richText: urlRichText(typeof url === 'string' ? url : String(title ?? '')),
								scale: 1,
								autoSize: false,
							},
						}
					}
				}
			},
		},
	],
})
```

> **Verification note for the implementer:** the text-shape props above must satisfy tldraw 5.1.0's `textShapeProps` validator exactly. Check `node_modules/@tldraw/tlschema/dist-esm/index.d.mts` (search `textShapeProps`) and adjust field names/values if they differ (e.g. `autoSize` vs `autosize`). If the validator cannot be satisfied without editor-only helpers, this iframe branch is the spec's declared best-effort: delete the `else if (rec.type === 'iframe')` branch AND its test block, leave iframe records untouched (they'll render as unknown shapes), and record the parking in your report. The `file-viewer` retype branch is NOT optional.

- [ ] **Step 4: Update `contracts/src/shapes.ts`**

Replace the `fileViewerShapeProps` export (keep the surrounding comment style) and delete `iframeShapeProps` entirely:

```typescript
export const webViewerShapeProps = {
	w: T.number,
	h: T.number,
	// Source discriminator (spec: web-viewer unification): 'file' renders a
	// home-relative path via /files/*; 'dev' renders a VM dev server via the
	// injecting /dev/{port} proxy. Optional so migrated records validate
	// before the migration stamps kind (treat missing as 'file').
	kind: T.literalEnum('file', 'dev').optional(),
	// kind 'file': path relative to the agent user's home. kind 'dev': the
	// in-app path under the dev server root (default '/').
	path: T.string,
	title: T.string,
	// kind 'dev' only: the localhost port the dev server listens on.
	port: T.number.optional(),
	// Bumped by POST /api/canvas/web-viewer refresh so every client reloads.
	rev: T.number.optional(),
	// Remote gateway id (future); optional so existing rooms need no migration.
	gateway: T.string.optional(),
}
```

- [ ] **Step 5: Update `contracts/src/tools/file.ts`**

Change both `http.path` values to `'/api/canvas/web-viewer'`. Update `fileOpen`'s help text to `'Open a file or local dev server on the canvas in a web-viewer control.'` and add to its `zodInput`:

```typescript
		port: z.number().int().min(1).max(65535).optional()
			.describe('local dev server port — creates a dev-source web viewer instead of a file'),
```

Make `path` optional-when-port: change `path: z.string().min(1)` to `path: z.string().optional()` on `fileOpen` only (the server enforces path-XOR-port; `fileRefresh` keeps `path` required).

- [ ] **Step 6: Export + install + run tests**

Add `canvas-migrations.ts` exports to `contracts/src/index.ts`. Run `bun install` (new contracts deps), then:

Run: `bun contracts/src/canvas-migrations.test.ts` — expected PASS.
Run: `bun run typecheck` — expect failures ONLY in server/client files still importing `fileViewerShapeProps`/`iframeShapeProps` (Tasks 2–3 fix those). If contracts itself fails, fix here.

- [ ] **Step 7: Commit**

```bash
git add contracts/ && git commit -m "feat(contracts): web-viewer props + store migration, retire iframe props"
```

---

### Task 2: Server — schema, feature rename, route aliases

**Files:**
- Modify: `server/src/schema.ts`
- Rename: `server/src/features/file-viewer.ts` → `server/src/features/web-viewer.ts` (git mv)
- Rename: `server/src/features/file-viewer.test.ts` → `web-viewer.test.ts` if it exists (check `ls server/src/features/`)
- Modify: `server/src/app.ts` (import, mount, and the express.json skip-path for present-events)
- Test: existing `server/src/present-relay-api.test.ts` + whichever server tests reference `/api/canvas/file-viewer` (grep and update)

**Interfaces:**
- Consumes: `webViewerShapeProps`, `webViewerMigrations` from Task 1.
- Produces: routes `POST /api/canvas/web-viewer`, `POST|GET /api/canvas/web-viewer/present-events`, `POST /api/canvas/web-viewer/present-stop`, PLUS the same three under `/api/canvas/file-viewer` as aliases. Shape records created with `type: 'web-viewer'`, `props.kind: 'file'`.

- [ ] **Step 1: Update `server/src/schema.ts`**

```typescript
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import {
	nekoShapeProps,
	roadmapShapeProps,
	screenshareShapeProps,
	terminalShapeProps,
	webViewerMigrations,
	webViewerShapeProps,
} from '@ensembleworks/contracts'

export const schema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		terminal: { props: terminalShapeProps },
		neko: { props: nekoShapeProps },
		roadmap: { props: roadmapShapeProps },
		screenshare: { props: screenshareShapeProps },
		'web-viewer': { props: webViewerShapeProps },
	},
	bindings: defaultBindingSchemas,
	migrations: [webViewerMigrations],
})
```

(`iframe` is gone on purpose — the Task 1 migration retypes those records before validation. Verify `createTLSchema` accepts `migrations` in 5.1.0; if the option lives elsewhere — e.g. only `createTLSchemaFromUtils` — adapt and note it.)

- [ ] **Step 2: Write the failing round-trip test**

Append to a new file `server/src/schema-migration.test.ts`:

```typescript
/** Snapshot with legacy file-viewer + iframe records loads and migrates. Run: bun server/src/schema-migration.test.ts */
import assert from 'node:assert/strict'
import { schema } from './schema.ts'

const snapshot = {
	'document:document': { typeName: 'document', id: 'document:document', gridSize: 10, name: '', meta: {} },
	'page:page': { typeName: 'page', id: 'page:page', name: 'Page 1', index: 'a1', meta: {} },
	'shape:fv': {
		typeName: 'shape', id: 'shape:fv', type: 'file-viewer',
		x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
		props: { w: 720, h: 540, path: 'a/b.html', title: 'b.html', rev: 1 },
	},
}
const result = schema.migrateStoreSnapshot({
	schema: { schemaVersion: 2, sequences: {} }, // ancient empty schema → all retroactive sequences apply
	store: structuredClone(snapshot) as any,
})
assert.equal(result.type, 'success', `migration succeeds (got ${JSON.stringify((result as any).reason ?? '')})`)
const store = (result as any).value
assert.equal(store['shape:fv'].type, 'web-viewer', 'file-viewer retyped on snapshot load')
console.log('schema-migration.test.ts OK')
```

Run: `bun server/src/schema-migration.test.ts` — iterate until PASS (the `schema:` input shape for "old client" may need tweaking; `migrateStoreSnapshot` accepts a serialized schema — use `schema.serialize()` from a temporary script against the PREVIOUS git revision if needed, or the minimal literal above if tldraw accepts it).

- [ ] **Step 3: Rename + rework the feature router**

`git mv server/src/features/file-viewer.ts server/src/features/web-viewer.ts`, then inside:

- Rename `createFileViewerRouter` → `createWebViewerRouter`; update the header comment.
- All created/queried shape records: `type: 'web-viewer'` (three occurrences: refresh filter, both `count` filters, `create`).
- The open handler gains dev-source support. After the `gateway` rejection block, replace the path-validation block with:

```typescript
		const rawPort = body.port
		const port = typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : null
		const rawPath = typeof body.path === 'string' ? body.path : ''
		let cleanPath: string | null = null
		if (port === null) {
			cleanPath = normalizeHomePath(rawPath)
			if (!cleanPath) {
				return void res
					.status(400)
					.json({ error: 'path must be a non-empty path within the agent home (no ../ traversal), or pass port for a dev server' })
			}
		} else if (op === 'refresh') {
			return void res.status(400).json({ error: 'refresh is by path; dev viewers reload via their own refresh button' })
		}
```

- In the open branch, title default becomes `port !== null ? \`:${port}\` : path.basename(cleanPath!)` (guarded by the block above), and props become:

```typescript
				props: port !== null
					? { w: 960, h: 640, kind: 'dev', port, path: typeof body.path === 'string' && body.path.startsWith('/') ? body.path : '/', title, rev: 0 }
					: { w: 720, h: 540, kind: 'file', path: cleanPath!, title, rev: 0 },
```

- The refresh filter keeps matching on `props?.path === cleanPath` — dev shapes are never matched because refresh with a port 400s above.
- Route paths: the main handler currently mounts at `fileOpen.http.path` — after Task 1 that IS `/api/canvas/web-viewer`, so it moves automatically. Change the three literal relay paths to `/api/canvas/web-viewer/present-events` (POST + GET) and `/api/canvas/web-viewer/present-stop`.
- Add aliases at the bottom of `createWebViewerRouter`, before `return router` (thin re-mounts, same handlers — express lets one handler serve two paths by passing an array; refactor each `router.post(path, handler)` to `router.post([newPath, oldPath], handler)` instead of duplicating logic):
  - `['/api/canvas/web-viewer', '/api/canvas/file-viewer']`
  - `['/api/canvas/web-viewer/present-events', '/api/canvas/file-viewer/present-events']` (POST and GET)
  - `['/api/canvas/web-viewer/present-stop', '/api/canvas/file-viewer/present-stop']`

- [ ] **Step 4: Fix `server/src/app.ts`**

- Import/mount rename: `createFileViewerRouter` → `createWebViewerRouter` from `./features/web-viewer.ts`.
- Grep `app.ts` for `present-events` — the express.json default-parser skip currently names `/api/canvas/file-viewer/present-events`; make it skip BOTH the new and old paths (the route's own 6mb parser must stay the only body parse for each).

- [ ] **Step 5: Update server tests that name the old route/type**

`grep -rln "api/canvas/file-viewer\|'file-viewer'" server/src` — update each test to the new route/type, and ADD one alias assertion in the API test (POST to `/api/canvas/file-viewer/present-events` still 200s and lands in the same relay log as the new path).

- [ ] **Step 6: Run the server suite**

Run: `bun server/src/schema-migration.test.ts && bun server/src/present-relay-api.test.ts && bun run typecheck`
Expected: server green; client typecheck failures remain (Task 3).

- [ ] **Step 7: Commit**

```bash
git add -A server contracts && git commit -m "feat(server): web-viewer schema + routes with file-viewer aliases, dev-source open op"
```

---

### Task 3: Client — rename to web-viewer, retire the iframe plugin

**Files:**
- Rename (git mv, whole directory): `client/src/file-viewer/` → `client/src/web-viewer/`, and inside it `FileViewerShapeUtil.tsx` → `WebViewerShapeUtil.tsx`, `createFileViewerShape.ts` → `createWebViewerShape.ts`, `fileViewerBaton.ts`/`.test.ts` → `webViewerBaton.ts`/`.test.ts`
- Delete: `client/src/iframe/` (whole directory)
- Modify: `client/src/plugins.ts`, `client/src/App.tsx`, `client/src/theme.ts` comment if it names iframe (comment-only, optional)
- Test: every moved `.test.ts` keeps passing after mechanical renames

**Interfaces:**
- Consumes: `webViewerShapeProps`, `webViewerMigrations` (Task 1).
- Produces: `WebViewerShapeUtil` (`static type = 'web-viewer'`), `webViewerPlugin`, `createWebViewerShape(editor)`, presence meta key `webViewerPresent`, `hasWebViewerBaton(collaborator)`. Task 5 modifies `WebViewerShapeUtil.tsx` further — keep this task purely mechanical (rename + retire), no behaviour change.

- [ ] **Step 1: Mechanical renames**

Across the moved directory + its importers, apply exactly:

| old | new |
|---|---|
| `'file-viewer'` (shape type literal, incl. `declare module` key and `static type`) | `'web-viewer'` |
| `FileViewerShapeUtil` / `FileViewerShape` / `FileViewerShapeProps` / `FileViewerShapeComponent` | `WebViewerShapeUtil` / `WebViewerShape` / `WebViewerShapeProps` / `WebViewerShapeComponent` |
| `fileViewerShapeProps` (import) | `webViewerShapeProps` |
| `createFileViewerShape` | `createWebViewerShape` |
| `fileViewerPlugin` (plugin id `'file-viewer'`, bar item label `'file viewer'`) | `webViewerPlugin` (id `'web-viewer'`, label `'web viewer'`) |
| `hasFileViewerBaton` | `hasWebViewerBaton` |
| `fileViewerPresent` (presence meta key in `App.tsx` AND wherever `hideControllerCursor.ts`/`followLogic.ts` read it) | `webViewerPresent` |
| `/api/canvas/file-viewer/present-events` + `/present-stop` (in `presentBroadcast.ts`, `rrwebFollow.ts`/`RrwebMirror.tsx` backlog fetch) | `/api/canvas/web-viewer/present-events` + `/present-stop` |
| `ew-file-viewer-ready` message type | **unchanged** — it is the wire protocol with already-deployed server bridge scripts; leave every occurrence alone |
| useValue keys `fv…` (`fvPresenting`, `fvPresenterKey`, …) | optional cosmetic; leave as-is to keep the diff mechanical |

Also in `client/src/App.tsx`: remove the `iframePlugin` import/registration (`client/src/plugins.ts`), delete `client/src/iframe/`, and pass migrations to sync:

```typescript
	const store = useSync({
		// …existing options…
		migrations: [webViewerMigrations],
	})
```

(import `webViewerMigrations` from `@ensembleworks/contracts`). The old `declare module '@tldraw/tlschema'` augmentation for `iframe` dies with the directory.

- [ ] **Step 2: Sweep for stragglers**

Run: `grep -rn "file-viewer\|fileViewer\|FileViewer\|iframePlugin\|src/iframe" client/src --include="*.ts*" | grep -v canvas-v2`
Expected: only comments referencing history/specs (fine) and `canvas-v2` (out of scope). Fix any live-code hit.

- [ ] **Step 3: Run the moved tests + typecheck**

Run: `bun client/src/web-viewer/followLogic.test.ts && bun client/src/web-viewer/webViewerBaton.test.ts && bun client/src/web-viewer/presentBroadcast.test.ts && bun client/src/web-viewer/rrwebFollow.test.ts && bun client/src/web-viewer/RrwebMirror.test.ts && bun client/src/web-viewer/pinchForward.test.ts`
Then: `bun run typecheck` — must be fully green now.
Then: `bun run build` and `bun client/scripts/bundle-size-check.ts` (mode/args: see how CI invokes it in `.github/workflows/`) — the lazy RrwebMirror split must survive the rename.

- [ ] **Step 4: Commit**

```bash
git add -A client && git commit -m "feat(client): rename file-viewer to web-viewer, retire the iframe plugin"
```

---

### Task 4: Injecting /dev proxy (server) + Caddy routing

**Files:**
- Create: `server/src/dev-inject.ts`
- Create: `server/src/dev-inject.test.ts`
- Create: `server/src/features/dev-proxy.ts`
- Create: `server/src/features/dev-proxy.test.ts`
- Modify: `server/src/app.ts` (mount router; add `/dev` WS upgrade branch)
- Modify: `deploy/Caddyfile` and `deploy/Caddyfile.prod` (route `/dev/*` to the sync server; add Referer fallback)

**Interfaces:**
- Consumes: `BRIDGE_SCRIPT`, `RRWEB_TAG`, `injectBridge` pattern from `server/src/files-render.ts` (reuse the exports, don't copy the strings).
- Produces: `injectDevPage(html: string, port: number): string`; `urlPatchScript(port: number): string`; `errorReporterScript(): string`; `createDevProxyRouter(): express.Router` handling `GET|POST|… /dev/:port/*`; `handleDevUpgrade(req, socket, head): boolean` for app.ts's `server.on('upgrade')`.

- [ ] **Step 1: Write the failing inject tests**

`server/src/dev-inject.test.ts`:

```typescript
/** Dev-page injection: recorder bridge + URL patch + error reporter into HTML only. Run: bun server/src/dev-inject.test.ts */
import assert from 'node:assert/strict'
import { injectDevPage, urlPatchScript } from './dev-inject.ts'

{
	const out = injectDevPage('<!doctype html><html><head></head><body><div id=app></div></body></html>', 3000)
	assert.ok(out.includes('/files-assets/rrweb.js'), 'rrweb asset tag injected')
	assert.ok(out.includes('ew-present-start'), 'recorder bridge injected')
	assert.ok(out.includes('/dev/3000'), 'URL patch carries the port prefix')
	assert.ok(out.includes('ew-dev-error'), 'error reporter injected')
	assert.ok(out.indexOf('</body>') > out.indexOf('ew-present-start'), 'injected before closing body')
}
{
	// No </body>: append (same contract as injectBridge).
	const out = injectDevPage('<p>bare fragment', 3000)
	assert.ok(out.startsWith('<p>bare fragment'), 'original content first')
	assert.ok(out.includes('ew-dev-error'), 'still injected')
}
{
	const script = urlPatchScript(5173)
	assert.ok(script.includes("'/dev/5173'"), 'patch is port-specific')
}
console.log('dev-inject.test.ts OK')
```

Run: `bun server/src/dev-inject.test.ts` — expected FAIL (module missing).

- [ ] **Step 2: Implement `server/src/dev-inject.ts`**

```typescript
/**
 * /dev/{port} HTML injection (spec: web-viewer unification §1–§3): the same
 * rrweb recorder bridge file documents get (files-render.ts), plus two
 * dev-only scripts — a URL patch that rewrites root-absolute fetch/XHR/
 * WebSocket URLs to the /dev/{port} prefix (deterministic fix for JS-initiated
 * traffic incl. HMR), and an error reporter that surfaces JS errors, failed
 * subresources, and failed requests to the parent shape via postMessage
 * (type 'ew-dev-error').
 */
import { BRIDGE_SCRIPT, RRWEB_TAG } from '../files-render.ts'

export function urlPatchScript(port: number): string {
	// Serialized into the page; keep it ES5-ish and self-contained.
	return `<script>(function () {
	var prefix = '/dev/${port}'
	function patch(u) {
		if (typeof u !== 'string') return u
		if (u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf(prefix + '/') !== 0 && u !== prefix) return prefix + u
		return u
	}
	var origFetch = window.fetch
	if (origFetch) window.fetch = function (input, init) {
		if (typeof input === 'string') input = patch(input)
		else if (input && typeof input.url === 'string' && input.url.charAt(0) === '/') input = new Request(patch(input.url), input)
		return origFetch.call(this, input, init)
	}
	var origOpen = XMLHttpRequest.prototype.open
	XMLHttpRequest.prototype.open = function (method, url) {
		arguments[1] = patch(url)
		return origOpen.apply(this, arguments)
	}
	var OrigWS = window.WebSocket
	window.WebSocket = function (url, protocols) {
		try {
			var u = new URL(url, location.href)
			if (u.host === location.host) { u.pathname = patch(u.pathname); url = u.toString() }
		} catch (e) {}
		return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols)
	}
	window.WebSocket.prototype = OrigWS.prototype
	Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OrigWS.CONNECTING })
	Object.defineProperty(window.WebSocket, 'OPEN', { value: OrigWS.OPEN })
	Object.defineProperty(window.WebSocket, 'CLOSING', { value: OrigWS.CLOSING })
	Object.defineProperty(window.WebSocket, 'CLOSED', { value: OrigWS.CLOSED })
})()</script>`
}

export function errorReporterScript(): string {
	return `<script>(function () {
	function report(kind, detail) {
		try { parent.postMessage({ type: 'ew-dev-error', kind: kind, detail: String(detail).slice(0, 500) }, '*') } catch (e) {}
	}
	window.addEventListener('error', function (e) {
		if (e && e.target && (e.target.src || e.target.href) && e.target !== window) {
			report('resource', (e.target.src || e.target.href))
		} else {
			report('js', e && e.message ? e.message : 'script error')
		}
	}, true)
	window.addEventListener('unhandledrejection', function (e) { report('js', e && e.reason ? e.reason : 'unhandled rejection') })
	var origFetch = window.fetch
	if (origFetch) window.fetch = function () {
		return origFetch.apply(this, arguments).then(function (res) {
			if (!res.ok && res.status >= 400) report('request', res.status + ' ' + res.url)
			return res
		})
	}
})()</script>`
}

/** rrweb asset + shared recorder bridge + dev-only scripts, before last </body>. */
export function injectDevPage(html: string, port: number): string {
	// Error reporter FIRST so its fetch wrapper composes under the URL patch
	// (patch runs the underlying request; reporter observes the patched result).
	const injected = RRWEB_TAG + urlPatchScript(port) + errorReporterScript() + BRIDGE_SCRIPT
	const re = /<\/body\s*>/gi
	let idx = -1
	for (let m = re.exec(html); m; m = re.exec(html)) idx = m.index
	if (idx < 0) return html + injected
	return html.slice(0, idx) + injected + html.slice(idx)
}
```

Run: `bun server/src/dev-inject.test.ts` — PASS. (If script-ordering vs the test's index assertion argues, trust the test intent: everything lands before the final `</body>`.)

- [ ] **Step 3: Write the failing proxy test**

`server/src/features/dev-proxy.test.ts` — boots a tiny in-process "dev server" and asserts through a real express app:

```typescript
/** /dev/{port} injecting proxy: HTML injected, other types streamed, headers preserved. Run: bun server/src/features/dev-proxy.test.ts */
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import { createDevProxyRouter } from './dev-proxy.ts'

// Fake dev server.
const dev = http.createServer((req, res) => {
	if (req.url === '/') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
		res.end('<!doctype html><html><body><h1>hi</h1></body></html>')
	} else if (req.url === '/app.js') {
		res.writeHead(200, { 'content-type': 'application/javascript' })
		res.end('console.log("</body> not html")')
	} else {
		res.writeHead(404); res.end('nope')
	}
})
await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r))
const devPort = (dev.address() as { port: number }).port

const app = express()
app.use(createDevProxyRouter())
const proxy = http.createServer(app)
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`

{
	const res = await fetch(`${base}/dev/${devPort}/`)
	const body = await res.text()
	assert.equal(res.status, 200)
	assert.ok(body.includes('<h1>hi</h1>'), 'original HTML present')
	assert.ok(body.includes('ew-dev-error'), 'dev injection applied to HTML')
	assert.ok(body.includes(`/dev/${devPort}`), 'URL patch is per-port')
}
{
	const res = await fetch(`${base}/dev/${devPort}/app.js`)
	const body = await res.text()
	assert.equal(res.headers.get('content-type'), 'application/javascript')
	assert.ok(!body.includes('ew-dev-error'), 'non-HTML untouched')
	assert.ok(body.includes('</body> not html'), 'byte-identical passthrough')
}
{
	const res = await fetch(`${base}/dev/${devPort}/missing`)
	assert.equal(res.status, 404, 'upstream status preserved')
}
{
	// Dev server down → 502-style error page, not a hang.
	const res = await fetch(`${base}/dev/1/`)
	assert.equal(res.status, 502)
}
dev.close(); proxy.close()
console.log('dev-proxy.test.ts OK')
```

Run: `bun server/src/features/dev-proxy.test.ts` — FAIL (module missing).

- [ ] **Step 4: Implement `server/src/features/dev-proxy.ts`**

```typescript
/**
 * Injecting /dev/{port} proxy (spec: web-viewer unification). Caddy now sends
 * /dev/* to the sync server instead of straight to the target port; this
 * router strips the prefix, proxies to localhost:{port}, and injects the
 * recorder bridge + URL patch + error reporter into top-level HTML. Non-HTML
 * responses stream through untouched. WebSocket upgrades (HMR) are handled by
 * handleDevUpgrade, wired into app.ts's existing server 'upgrade' listener.
 * Compression: the upstream request advertises identity-only so HTML arrives
 * un-gzipped and injectable; asset responses keep whatever bytes upstream
 * sends (we simply never re-negotiate encoding for them either — acceptable:
 * LAN/loopback hop, and Caddy/Cloudflare re-compress toward the browser).
 */
import express from 'express'
import http from 'node:http'
import net from 'node:net'
import type { Socket } from 'node:net'
import { errorPage } from '../files-render.ts'
import { injectDevPage } from '../dev-inject.ts'

const DEV_PATH = /^\/dev\/(\d{1,5})(\/.*)?$/

export function createDevProxyRouter(): express.Router {
	const router = express.Router()
	router.all(/^\/dev\/\d+(\/.*)?$/, (req, res) => {
		const m = DEV_PATH.exec(req.originalUrl)
		if (!m) return void res.status(400).send('bad dev path')
		const port = Number(m[1])
		const upstreamPath = m[2] || '/'
		const headers: http.OutgoingHttpHeaders = {
			...req.headers,
			host: `localhost:${port}`,
			'accept-encoding': 'identity',
		}
		delete headers.connection
		const upstream = http.request(
			{ host: '127.0.0.1', port, method: req.method, path: upstreamPath, headers },
			(ur) => {
				const type = String(ur.headers['content-type'] ?? '')
				if (type.includes('text/html')) {
					const chunks: Buffer[] = []
					ur.on('data', (c) => chunks.push(c))
					ur.on('end', () => {
						const html = injectDevPage(Buffer.concat(chunks).toString('utf8'), port)
						const out = { ...ur.headers }
						delete out['content-length']
						delete out['content-encoding']
						res.writeHead(ur.statusCode ?? 200, out)
						res.end(html)
					})
				} else {
					res.writeHead(ur.statusCode ?? 200, ur.headers)
					ur.pipe(res)
				}
			}
		)
		upstream.on('error', () => {
			if (!res.headersSent) {
				res.status(502).type('html').send(errorPage('dev server unreachable', `Nothing is listening on localhost:${port}.`))
			} else res.end()
		})
		req.pipe(upstream)
	})
	return router
}

/** WS upgrade passthrough for /dev/{port}: raw TCP splice. Returns true if handled. */
export function handleDevUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): boolean {
	const m = DEV_PATH.exec(req.url ?? '')
	if (!m) return false
	const port = Number(m[1])
	const upstream = net.connect(port, '127.0.0.1', () => {
		const path = m[2] || '/'
		const lines = [`${req.method} ${path} HTTP/1.1`]
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			const k = req.rawHeaders[i]
			if (k.toLowerCase() === 'host') lines.push(`Host: localhost:${port}`)
			else lines.push(`${k}: ${req.rawHeaders[i + 1]}`)
		}
		upstream.write(lines.join('\r\n') + '\r\n\r\n')
		if (head.length) upstream.write(head)
		socket.pipe(upstream)
		upstream.pipe(socket)
	})
	const kill = () => { socket.destroy(); upstream.destroy() }
	upstream.on('error', kill)
	socket.on('error', kill)
	return true
}
```

Run: `bun server/src/features/dev-proxy.test.ts` — PASS.

- [ ] **Step 5: Wire into `server/src/app.ts`**

- Mount `createDevProxyRouter()` alongside the other feature routers (BEFORE any static/catch-all handler; `/dev` must not be shadowed).
- In the existing `server.on('upgrade', …)` handler, before the `/sync` branches, add:

```typescript
		if (handleDevUpgrade(req, socket as Socket, head)) return
```

- Also grep app.ts for any body-parser applied to all routes: `/dev/*` must bypass express.json (proxied bodies are piped raw) — add `/dev/` to the same skip-list used for present-events, or mount the dev router before the json middleware.

- [ ] **Step 6: Caddy routing (both files)**

In `deploy/Caddyfile` AND `deploy/Caddyfile.prod`, replace the `@dev` handler body — the server now terminates /dev:

```
	@dev path_regexp dev ^/dev/(\d+)(/.*)?$
	handle @dev {
		reverse_proxy 127.0.0.1:{$ENSEMBLEWORKS_PORT_SYNC:8788}
	}
```

(Caddyfile.prod uses its own upstream variable/port for the sync server — mirror whatever `@backend` uses there.) Then, immediately AFTER every named handler (`@livekit`, `@dev`, `@shared-browser`, `@term_local`, `@backend`) and BEFORE the final catch-all `handle`, add the Referer fallback:

```
	# Referer fallback (spec: web-viewer unification §2): a dev app's root-
	# absolute asset request (/assets/x.js) misses every canvas route; if the
	# page it came from is under /dev/{port}/, send it to that dev server via
	# the injecting proxy. Canvas-owned prefixes never reach here — every
	# earlier handle wins first, and Caddy handle blocks are mutually
	# exclusive in file order.
	@devref header_regexp ref Referer /dev/(\d+)/
	handle @devref {
		rewrite * /dev/{re.ref.1}{uri}
		reverse_proxy 127.0.0.1:{$ENSEMBLEWORKS_PORT_SYNC:8788}
	}
```

Validate: `caddy validate --adapter caddyfile --config deploy/Caddyfile` (and `.prod`; if the caddy binary is unavailable in the container, note it in the report and rely on review).

**Ordering caveat (verify while editing):** Caddy `handle` blocks match in file order — `@devref` must sit after all canvas handlers so `/api`, `/sync`, `/files`, `/files-assets`, `/uploads`, `/livekit`, `/shared-browser` always win even when the Referer is a dev page. The dev Caddyfile's final `handle` (Vite) and prod's final handler must come after `@devref`.

- [ ] **Step 7: Full server suite + commit**

Run: `bun run typecheck` and the server tests (`bun server/src/features/dev-proxy.test.ts`, `bun server/src/dev-inject.test.ts`, plus the suite entry `bun run test` if time-reasonable at this point).

```bash
git add -A server deploy && git commit -m "feat(server): injecting /dev proxy with URL patch, error reporter, WS passthrough, Referer fallback"
```

---

### Task 5: Client — dev sources in WebViewerShapeUtil (sandbox, src, error badge, creation)

**Files:**
- Modify: `client/src/web-viewer/WebViewerShapeUtil.tsx`
- Modify: `client/src/web-viewer/createWebViewerShape.ts`
- Create: `client/src/web-viewer/devSource.ts`
- Create: `client/src/web-viewer/devSource.test.ts`

**Interfaces:**
- Consumes: `webViewerShapeProps` (`kind`, `port`, `path` semantics from Task 1); `ew-dev-error` postMessage shape from Task 4 (`{ type: 'ew-dev-error', kind: 'js' | 'resource' | 'request', detail: string }`).
- Produces: `parseDevInput(raw: string): { port: number, path: string } | null`; `sandboxFor(kind: 'file' | 'dev'): string`; `srcFor(props): string` — all in `devSource.ts` so they're testable without tldraw.

- [ ] **Step 1: Write the failing pure-logic tests**

`client/src/web-viewer/devSource.test.ts`:

```typescript
/** Dev-source helpers: input parsing, sandbox profile, iframe src. Run: bun client/src/web-viewer/devSource.test.ts */
import assert from 'node:assert/strict'
import { parseDevInput, sandboxFor, srcFor } from './devSource.ts'

// parseDevInput: URL forms, bare port, rejection of non-local.
assert.deepEqual(parseDevInput('http://localhost:3000'), { port: 3000, path: '/' })
assert.deepEqual(parseDevInput('http://localhost:3000/admin?x=1'), { port: 3000, path: '/admin?x=1' })
assert.deepEqual(parseDevInput('http://127.0.0.1:5173/'), { port: 5173, path: '/' })
assert.deepEqual(parseDevInput('3000'), { port: 3000, path: '/' })
assert.deepEqual(parseDevInput(':8080'), { port: 8080, path: '/' })
assert.equal(parseDevInput('https://example.com'), null, 'external URL rejected')
assert.equal(parseDevInput('http://localhost/'), null, 'no port rejected')
assert.equal(parseDevInput('not a url'), null)

// sandboxFor: exact strings (Global Constraints).
assert.equal(sandboxFor('file'), 'allow-scripts allow-forms allow-downloads')
assert.equal(sandboxFor('dev'), 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads')

// srcFor: file uses /files with per-segment encoding; dev uses /dev/{port}{path}.
assert.equal(srcFor({ kind: 'file', path: 'a/b c.html', rev: 2 }), '/files/a/b%20c.html?rev=2')
assert.equal(srcFor({ kind: 'dev', port: 3000, path: '/', rev: 0 }), '/dev/3000/?rev=0')
assert.equal(srcFor({ kind: 'dev', port: 3000, path: '/admin?x=1', rev: 1 }), '/dev/3000/admin?x=1&rev=1')
assert.equal(srcFor({ path: 'a.html', rev: 0 }), '/files/a.html?rev=0', 'missing kind = file (pre-migration records)')
console.log('devSource.test.ts OK')
```

Run: `bun client/src/web-viewer/devSource.test.ts` — FAIL.

- [ ] **Step 2: Implement `client/src/web-viewer/devSource.ts`**

```typescript
/**
 * Dev-source helpers for the web viewer (spec: web-viewer unification).
 * Pure — no tldraw imports — so `bun` can run the tests bare.
 */
export type WebViewerKind = 'file' | 'dev'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** "http://localhost:3000/x", "3000", ":3000" → {port, path}; non-local → null. */
export function parseDevInput(raw: string): { port: number; path: string } | null {
	const t = raw.trim()
	const bare = /^:?(\d{1,5})$/.exec(t)
	if (bare) {
		const port = Number(bare[1])
		return port > 0 && port < 65536 ? { port, path: '/' } : null
	}
	try {
		const url = new URL(t)
		if (!LOCAL_HOSTS.includes(url.hostname) || !url.port) return null
		return { port: Number(url.port), path: `${url.pathname}${url.search}` || '/' }
	} catch {
		return null
	}
}

/** SECURITY: file content is arbitrary disk bytes — never allow-same-origin.
 * Dev content is the team's own running code — same-origin matches the
 * retired iframe control's grant. Derived here and ONLY here. */
export function sandboxFor(kind: WebViewerKind): string {
	return kind === 'dev'
		? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
		: 'allow-scripts allow-forms allow-downloads'
}

/** iframe src for a shape's props; missing kind = 'file' (pre-migration records). */
export function srcFor(props: { kind?: WebViewerKind; path: string; port?: number; rev?: number }): string {
	const rev = props.rev ?? 0
	if (props.kind === 'dev' && typeof props.port === 'number') {
		const path = props.path.startsWith('/') ? props.path : `/${props.path || ''}`
		return `/dev/${props.port}${path}${path.includes('?') ? '&' : '?'}rev=${rev}`
	}
	return `/files/${props.path.split('/').map(encodeURIComponent).join('/')}?rev=${rev}`
}
```

Run: `bun client/src/web-viewer/devSource.test.ts` — PASS.

- [ ] **Step 3: Use them in `WebViewerShapeUtil.tsx`**

- Replace the inline iframe `src` template with `srcFor(shape.props)` and the literal `sandbox` with `sandboxFor(shape.props.kind ?? 'file')` (move the existing SECURITY comment to `devSource.ts` — done above — and leave a pointer comment at the usage).
- Header second `<span>` (the path echo) shows `kind === 'dev' ? \`localhost:${port}${path}\` : path`.
- `displayTitle` fallback becomes `shape.props.title || (kind === 'dev' ? \`:${port}\` : path) || 'web viewer'`.
- Empty-state guard `path ? … : 'no file'` becomes `kind === 'dev' ? port != null : Boolean(path)` with empty-state text `'no source'`.
- Error badge: add to the component

```typescript
	const [devErrors, setDevErrors] = useState<{ kind: string; detail: string }[]>([])
	useEffect(() => { setDevErrors([]) }, [rev]) // refresh clears the slate
```

  In the existing bridge `onMessage` listener (it already source-checks `iframeRef`), add before the pinch branch:

```typescript
				if (d.type === 'ew-dev-error' && typeof (d as any).detail === 'string') {
					setDevErrors((prev) => (prev.length >= 50 ? prev : [...prev, { kind: String((d as any).kind), detail: (d as any).detail }]))
					return
				}
```

  In the header button row, before the refresh button:

```tsx
					{devErrors.length > 0 && (
						<span
							title={devErrors
								.slice(-10)
								.map((e) => `${e.kind === 'resource' || e.kind === 'request' ? 'proxy/asset' : 'app'}: ${e.detail}`)
								.join('\n')}
							style={{ color: '#b91c1c', fontWeight: 700, pointerEvents: 'all', cursor: 'help' }}
						>
							⚠ {devErrors.length}
						</span>
					)}
```

  (Title-attr tooltip is the v1 detail view — the spec's "detail list" — keep it this simple.)

- [ ] **Step 4: Creation UX in `createWebViewerShape.ts`**

```typescript
import { Editor, createShapeId } from 'tldraw'
import { parseDevInput } from './devSource'

export function createWebViewerShape(editor: Editor) {
	const input = window.prompt('File path (relative to agent home) — or a local dev server URL / port (e.g. localhost:3000):')?.trim()
	if (!input) return
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	const dev = parseDevInput(input)
	if (!dev && /^https?:\/\//.test(input)) {
		window.alert('Only local (localhost:<port>) URLs are supported — external URLs cannot be shared or followed.')
		return
	}
	editor.createShape({
		id,
		type: 'web-viewer',
		x: x - 360,
		y: y - 270,
		props: dev
			? { w: 960, h: 640, kind: 'dev', port: dev.port, path: dev.path, title: `:${dev.port}`, rev: 0 }
			: { w: 720, h: 540, kind: 'file', path: input, title: input.split('/').pop() ?? input, rev: 0 },
	})
	editor.setSelectedShapes([id])
}
```

- [ ] **Step 5: Run everything + commit**

Run: `bun client/src/web-viewer/devSource.test.ts && bun run typecheck && bun run build && bun client/scripts/bundle-size-check.ts` (same invocation caveat as Task 3).

```bash
git add -A client && git commit -m "feat(client): dev-server sources in the web viewer — sandbox profile, /dev src, error badge, creation"
```

---

### Task 6: Verify end-to-end, docs, PR

**Files:**
- Modify: `CLAUDE.md` / `README.md` only where they literally name the file-viewer control or `/api/canvas/file-viewer` (grep; keep edits minimal)
- No new source files — this is the verification gate.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full suite**

Run: `bun install && bun run typecheck && bun run test && bun run build`
Expected: all green. Fix anything that isn't before proceeding.

- [ ] **Step 2: Live smoke against a real dev server**

Start the dev stack (`bin/dev up` from the host, or engine mode inside the container). Then, inside the container, boot a real Vite app as the guinea pig:

```bash
cd "$(mktemp -d)" && bun create vite smoke-app --template react-ts && cd smoke-app && bun install && bun run dev --port 3123 &
```

Smoke checklist (browser, two contexts):
1. Create a web viewer via the command bar with input `localhost:3123` — the Vite app renders with styles/logo intact (absolute assets survived the proxy).
2. Edit `src/App.tsx` in the smoke app — HMR applies live inside the viewer (patched WebSocket works).
3. Double-click to take control in browser A; browser B mirrors the dev app (rrweb via injected recorder), cursor + click ring visible.
4. Click away in A — B keeps the frozen last view.
5. Rename a Vite asset import to a bogus path — error badge appears with a proxy/asset-classified entry.
6. `POST /api/canvas/file-viewer` (old path) with a file path still creates a working viewer (alias + file kind regression).
7. A room that previously held file-viewer shapes (any existing dev room) still shows them after upgrade (migration smoke).

Record pass/fail per item in the task report. If browser automation is unavailable, run what's runnable via curl (items 6 is curl-able; item 1 partially via `curl http://localhost:8080/dev/3123/ | grep ew-dev-error`) and flag the rest for the human.

- [ ] **Step 3: Docs sweep**

`grep -rn "file-viewer\|file viewer" README.md CLAUDE.md docs/*.md | grep -v superpowers` — update live references (control name, API path) to web-viewer/new path, noting the alias. Do not rewrite historical spec/plan docs.

- [ ] **Step 4: Commit + PR**

```bash
git add -A && git commit -m "docs: web-viewer rename sweep + smoke fixes"
git push -u origin feat/web-viewer-unification
```

Open a PR to `main` titled `feat: web viewer — unify file-viewer and dev-server controls`. Body must include: summary, the migration/reload-gating note (clients prompted to reload after deploy), the smoke checklist results, and the line:
`ux-contract: none — legacy v1 tldraw web-viewer UI; not a canvas-editor/canvas-react/canvas-v2 contract surface`
