# Attribution — stamp who wrote, server-side, from `Whoami` (slice 3c-attribution)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The three mutating canvas content routes (`POST /api/canvas/sticky`,
`POST /api/canvas/shape` create-op, `POST /api/roadmap/doc`) stop trusting the
caller for authorship. The server resolves the real caller with `resolveCaller`
and, through **one shared helper** (`server/src/kernel/attribution.ts`), stamps a
structured `meta.author` (credential only) and renders the visible `🤖 <name>: `
badge on free text (credentialed callers, plus a cosmetic-only pass-through for a
voluntary `body.author` on anonymous "none" instances). The three mutating tool
defs gain an optional `author` field; `bin/canvas` stops client-side prefixing
and sends `body.author` on the wire. After the slice `bun run typecheck`,
`bun run build`, `bun run test` are green and the suite count is **43 → 45** (this
slice adds exactly two suites).

**Spec:** `docs/superpowers/specs/2026-07-06-attribution-design.md` — panel-approved;
implement it exactly. Its attribution table, the three rules, the verbatim
`attribution.ts`, the sticky handler diff, and both test suites are authoritative.
**Charter:** `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`,
§"3c — Attribution (the pinned bundle)" + "Standing conventions".

**Scope boundary (from the spec — do not cross it):** 3c does **not** change any
read/GET surface, does **not** backfill existing records, does **not** touch
`client/`, does **not** add a `must-match` 4xx class (a credentialed caller's
`body.author` is silently ignored, never 4xx'd), does **not** touch the scribe
transcript route, and does **not** touch `createWriteScopeGuard` (attribution
runs *inside* each handler, after the guard). `update`/`delete` shape ops do
**not** re-attribute.

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation: TABS** in all `server/src/*` **and** `contracts/src/*` files
   (both packages are tab-indented). Every verbatim block below is written with
   tabs; preserve them.
3. **Intra-`contracts` imports use the `.js` extension** (nodenext-style;
   resolves to the `.ts` source). Server imports contracts through the package
   name `@ensembleworks/contracts`, and its own modules with `.ts` extensions.
4. **Zod is v4** (`z.toJSONSchema` emits draft-2020-12 natively; an optional
   `z.string().optional()` field projects trivially).
5. **Test convention.** Self-running `bun src/x.test.ts` scripts, discovered by
   `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob, each ending
   `console.log('ok: …')`. The full `bun run test` spawns real tmux and takes a
   few minutes — let it finish.
6. **CRITICAL house convention — `process.exit(0)` after a booted-app suite.**
   Any test that calls `createSyncApp` MUST end with `process.exit(0)` after its
   final `console.log(...)`. The app's background intervals keep the event loop
   alive, so without the explicit exit the suite hangs and the `run-tests.ts`
   runner stalls. (`write-scope-api.test.ts` and `canvas-api.test.ts` both do
   this — the former with a bare `process.exit(0)`, the latter via a
   `.then(…, …)` that exits.) The `attribution-api.test.ts` in Task 2 ends with
   `process.exit(0)`; the pure-helper `attribution.test.ts` in Task 1 boots
   nothing and needs no exit.
7. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper —
   commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Gating policy — which gates apply per task vs at the end

- **Per task (Tasks 1–4): `bun run typecheck` MUST be green, and the specific
  test suite(s) named in that task MUST be at the state the task declares** (RED
  at a written-test checkpoint, GREEN at the task's end). These are the only
  gates run mid-plan; the full tmux-spawning suite is deferred to Task 5.
- **No task is permitted to leave a red suite at its end.** A RED checkpoint is
  an explicit, momentary TDD step within a task, immediately driven to GREEN by
  the same task.
- **End only (Task 5): the full `bun run test` (`all 45 suites passed`),
  `bun run build`, and the manual smoke.**

---

## Task 1 — The shared helper + its unit test (TDD: RED → GREEN)

Write the helper unit test **first** (it fails: no `attribution.ts` module), then
author the verbatim helper to green.

### Step 1 — Write the failing unit test

- [ ] **`server/src/attribution.test.ts`** (create it). Pure `resolveAttribution`
  + `badgeText`, no server boot; builds `Whoami` values by hand:
  ```ts
  // Helper unit test (network-free, no server boot): resolveAttribution's per-
  // caller-class semantics and badgeText's single-badge / empty-text no-op rules.
  // Run with: bun src/attribution.test.ts
  import assert from 'node:assert/strict'
  import type { Whoami } from '@ensembleworks/contracts'
  import { badgeText, resolveAttribution } from './kernel/attribution.ts'

  const bot: Whoami = { identity: '🤖 rw', kind: 'bot', via: 'service-token' }
  const human: Whoami = { identity: 'Alice', kind: 'human', via: 'sso' }
  const anon: Whoami = { identity: null, kind: 'anonymous', via: 'none' }

  // Credential wins, always — body.author is ignored, both sinks use the identity.
  assert.deepEqual(resolveAttribution(bot, 'forged'), { metaAuthor: '🤖 rw', display: '🤖 rw' })
  assert.deepEqual(resolveAttribution(human, undefined), { metaAuthor: 'Alice', display: 'Alice' })

  // Anonymous + voluntary author → cosmetic display only, never structured.
  assert.deepEqual(resolveAttribution(anon, 'dave'), { metaAuthor: null, display: 'dave' })

  // Anonymous, no / empty / whitespace author → stamp nothing.
  for (const empty of [undefined, '', '   ']) {
  	assert.deepEqual(resolveAttribution(anon, empty), { metaAuthor: null, display: null })
  }

  // badgeText: exactly one 🤖 (a display already leading with 🤖 is stripped first).
  assert.equal(badgeText('hi', '🤖 codespace-3'), '🤖 codespace-3: hi')
  assert.equal(badgeText('hi', 'Alice'), '🤖 Alice: hi')
  assert.equal(badgeText('hi', null), 'hi')

  // badgeText: empty / whitespace text is a no-op — no floating 🤖 name: orphan.
  assert.equal(badgeText('', '🤖 rw'), '')
  assert.equal(badgeText('   ', '🤖 rw'), '   ')

  console.log('ok: attribution helper — credential wins, anonymous cosmetic-only, single badge, empty-text no-op')
  ```

- [ ] **RED checkpoint — run it, expect failure (no helper module yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/attribution.test.ts)
  ```
  Expected: **fails** — `Cannot find module './kernel/attribution.ts'`. This is
  the RED state; Step 2 turns it green.

### Step 2 — Write the helper (verbatim from spec)

- [ ] **`server/src/kernel/attribution.ts`** (create it — exactly as the spec's
  "the shared helper — full" block):
  ```ts
  /**
   * Write-time attribution for the canvas content routes (sticky, shape, roadmap).
   * Turns the resolved caller (Whoami) + an optional voluntary body.author into
   * what a write should stamp: a trusted structured `meta.author` (credential only)
   * and a cosmetic display name to badge free text with. See
   * docs/superpowers/specs/2026-07-06-attribution-design.md.
   */
  import type { Whoami } from '@ensembleworks/contracts'

  export interface Attribution {
  	/** Trusted structured author for `meta.author`, or null to stamp none.
  	 *  Set ONLY when the caller is credentialed (identity !== null). */
  	metaAuthor: string | null
  	/** Cosmetic display name to badge free text with, or null for no prefix. */
  	display: string | null
  }

  /**
   * Resolve how to attribute a canvas write.
   *   - Credentialed (human via sso OR bot via service-token): authoritative;
   *     `bodyAuthor` is IGNORED; both structured author and badge use the identity.
   *   - Anonymous ("none"): a non-empty `bodyAuthor` is a COSMETIC badge only —
   *     never structured, never fabricated.
   */
  export function resolveAttribution(caller: Whoami, bodyAuthor: unknown): Attribution {
  	if (caller.identity !== null) {
  		return { metaAuthor: caller.identity, display: caller.identity }
  	}
  	const voluntary =
  		typeof bodyAuthor === 'string' && bodyAuthor.trim() ? bodyAuthor.trim() : null
  	return { metaAuthor: null, display: voluntary }
  }

  /**
   * Prefix free text with a single `🤖 <name>: ` badge. Idempotent on the badge:
   * a `display` that already leads with `🤖` (every configured bot identity does)
   * is stripped first, so the result carries exactly one badge. No-ops on a
   * `null`/empty display AND on empty/whitespace text — a label-less shape
   * (geo/arrow with no text) must not render a floating `🤖 name: ` orphan;
   * `meta.author` still stamps regardless.
   */
  export function badgeText(text: string, display: string | null): string {
  	if (!display || !text.trim()) return text
  	const bare = display.replace(/^🤖\s*/u, '')
  	return `🤖 ${bare}: ${text}`
  }
  ```

### Step 3 — GREEN gate

- [ ] **Run the unit test + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/attribution.test.ts)
  bun run typecheck
  ```
  Expected: the test prints
  `ok: attribution helper — credential wins, anonymous cosmetic-only, single badge, empty-text no-op`
  and exits 0; `bun run typecheck` exits 0.

- [ ] **Commit:**
  ```bash
  git add server/src/kernel/attribution.ts server/src/attribution.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): add the shared write-time attribution helper (slice 3c)

  server/src/kernel/attribution.ts: resolveAttribution turns a resolved Whoami +
  an optional voluntary body.author into { metaAuthor, display } — credential
  wins (both sinks), anonymous body.author is cosmetic-only, never fabricated.
  badgeText renders exactly one 🤖 <name>: badge (strips a leading 🤖 first) and
  no-ops on empty display or empty/whitespace text. Network-free; a unit test
  pins every caller class and both badge no-op rules.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — Handler integrations + the booted-app api test (TDD: RED → GREEN)

Write the booted-app api test **first** (it fails: handlers don't stamp yet), then
integrate the three handlers + the `RoadmapDoc` type to green. The three handlers
resolve the caller and apply the helper; `update`/`delete` are untouched.

### Step 1 — Write the failing api test

- [ ] **`server/src/attribution-api.test.ts`** (create it). Reuses the
  write-scope-api pattern exactly: header-trust mode, a temp `service-tokens.toml`
  with a `read-write` token `"🤖 rw"`, unsigned `alg:none` JWTs carrying
  `common_name`. After each write it reads the record straight from the room store
  (by the id the POST returned) and asserts `meta.author` +
  `richTextToPlainText(props.richText)`. **Ends with `process.exit(0)` (booted-app
  convention — see Environment note 6).**
  ```ts
  // Booted-app attribution: the sticky/shape/roadmap write routes stamp meta.author
  // (credential only) and badge free text (🤖 <name>: ) from the resolved caller.
  // Reuses the write-scope-api pattern: header-trust mode, a temp service-tokens.toml.
  // Run with: bun src/attribution-api.test.ts
  import assert from 'node:assert/strict'
  import { writeFileSync } from 'node:fs'
  import { mkdtemp } from 'node:fs/promises'
  import os from 'node:os'
  import path from 'node:path'
  import { createSyncApp } from './app.ts'
  import { richTextToPlainText } from './canvas/geometry.ts'
  import { ROADMAP_FIXTURE } from './roadmap-fixture.ts'

  delete process.env.CF_ACCESS_TEAM_DOMAIN
  delete process.env.CF_ACCESS_AUD
  delete process.env.EW_DEV_IDENTITY_EMAIL

  const dir = await mkdtemp(path.join(os.tmpdir(), 'attribution-api-'))
  const mapFile = path.join(dir, 'service-tokens.toml')
  writeFileSync(
  	mapFile,
  	['[tokens."rw.access"]', 'identity = "🤖 rw"', 'scope = "read-write"'].join('\n') + '\n',
  )
  process.env.EW_SERVICE_TOKENS_FILE = mapFile

  const { server, getOrCreateRoom } = createSyncApp({ dataDir: dir })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
  const rwHeader = { 'Cf-Access-Jwt-Assertion': jwt({ common_name: 'rw.access' }) }

  const post = (route: string, body: unknown, extra: Record<string, string> = {}) =>
  	fetch(`${base}${route}`, {
  		method: 'POST',
  		headers: { 'Content-Type': 'application/json', ...extra },
  		body: JSON.stringify(body),
  	})

  // Read a shape record straight from the room store by id.
  const shapeById = (id: string) =>
  	getOrCreateRoom('team')
  		.getCurrentSnapshot()
  		.documents.map((d) => d.state as any)
  		.find((r) => r.id === id)

  // 1. Bot token → structured meta.author + single badge (identity's own 🤖 not doubled).
  {
  	const res = await post('/api/canvas/sticky', { room: 'team', text: 'ship it' }, rwHeader)
  	assert.equal(res.status, 200)
  	const { id } = (await res.json()) as { id: string }
  	const note = shapeById(id)
  	assert.equal(note.meta.author, '🤖 rw', 'bot meta.author is the identity verbatim')
  	assert.equal(richTextToPlainText(note.props.richText), '🤖 rw: ship it', 'single badge')
  	console.log('ok: bot token stamps structured meta.author + a single badge')
  }

  // 2. Bot token IGNORES body.author (credential wins; no 4xx).
  {
  	const res = await post('/api/canvas/sticky', { room: 'team', text: 'x', author: 'somebody-else' }, rwHeader)
  	assert.equal(res.status, 200)
  	const { id } = (await res.json()) as { id: string }
  	const note = shapeById(id)
  	assert.equal(note.meta.author, '🤖 rw', 'credential wins over body.author')
  	assert.equal(richTextToPlainText(note.props.richText), '🤖 rw: x', 'forged author never appears')
  	console.log('ok: a credentialed caller silently ignores body.author')
  }

  // 3. Anonymous + voluntary author → cosmetic badge only, no structured author.
  {
  	const res = await post('/api/canvas/sticky', { room: 'team', text: 'note', author: 'dave' })
  	assert.equal(res.status, 200)
  	const { id } = (await res.json()) as { id: string }
  	const note = shapeById(id)
  	assert.equal(richTextToPlainText(note.props.richText), '🤖 dave: note', 'voluntary badge shows')
  	assert.equal(note.meta.author, undefined, 'no structured meta.author for anonymous')
  	console.log('ok: anonymous body.author is a cosmetic badge, never structured')
  }

  // 4. Anonymous, no author → stamp nothing.
  {
  	const res = await post('/api/canvas/sticky', { room: 'team', text: 'plain' })
  	assert.equal(res.status, 200)
  	const { id } = (await res.json()) as { id: string }
  	const note = shapeById(id)
  	assert.equal(richTextToPlainText(note.props.richText), 'plain', 'no badge')
  	assert.equal(note.meta.author, undefined, 'no meta.author')
  	console.log('ok: anonymous with no author stamps nothing')
  }

  // 5. Label-less geo shape → meta.author only, no orphan badge.
  {
  	const res = await post('/api/canvas/shape', { room: 'team', type: 'geo' }, rwHeader)
  	assert.equal(res.status, 200)
  	const { id } = (await res.json()) as { id: string }
  	const geo = shapeById(id)
  	assert.equal(geo.meta.author, '🤖 rw', 'label-less shape still carries meta.author')
  	assert.equal(richTextToPlainText(geo.props.richText), '', 'no floating 🤖 rw: label')
  	console.log('ok: a label-less shape stamps meta.author with no orphan badge')
  }

  // 6. Roadmap doc-level author (credential-only; anonymous stamps none).
  {
  	const res = await post('/api/roadmap/doc', { room: 'team', name: 'attr-roadmap', ops: [{ op: 'replace', data: ROADMAP_FIXTURE }] }, rwHeader)
  	const body = (await res.json()) as any
  	assert.equal(res.status, 200, `roadmap write should be 200, got ${JSON.stringify(body)}`)
  	const read = await fetch(`${base}/api/roadmap/doc?room=team&name=attr-roadmap`)
  	assert.equal(((await read.json()) as any).data.meta.author, '🤖 rw', 'credentialed roadmap write stamps meta.author')

  	const anon = await post('/api/roadmap/doc', { room: 'team', name: 'anon-roadmap', ops: [{ op: 'replace', data: ROADMAP_FIXTURE }] })
  	assert.equal(anon.status, 200)
  	const readAnon = await fetch(`${base}/api/roadmap/doc?room=team&name=anon-roadmap`)
  	assert.equal(((await readAnon.json()) as any).data.meta.author, undefined, 'anonymous roadmap write stamps no author')
  	console.log('ok: roadmap stamps doc-level meta.author for a credential, nothing for anonymous')
  }

  server.close()
  console.log('ok: attribution-api — sticky/shape/roadmap stamp meta.author + badge from the caller')
  process.exit(0)
  ```

- [ ] **RED checkpoint — run it, expect failure (handlers don't stamp yet):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun src/attribution-api.test.ts)
  ```
  Expected: **fails** at case 1 — the sticky note has no `meta.author` and its
  text is `'ship it'`, not `'🤖 rw: ship it'`. This is the RED state (handlers
  don't attribute); Steps 2–5 make it green.

### Step 2 — Integrate `server/src/features/sticky.ts`

- [ ] **Add the two imports** — after the existing
  `import { schema } from '../schema.ts'` line:
  ```ts
  import { badgeText, resolveAttribution } from '../kernel/attribution.ts'
  import { resolveCaller } from '../whoami.ts'
  ```
  (`canvasSticky` is already imported; `toRichText` is already imported.)

- [ ] **Resolve attribution before the store transaction** — the colour-validation
  block ends with `}` on the line before `let createdId: string | null = null`.
  Replace:
  ```ts
  		if (!NOTE_COLORS.includes(color)) {
  			return void res.status(400).json({ error: `color must be one of ${NOTE_COLORS.join(' | ')}` })
  		}
  		let createdId: string | null = null
  ```
  with:
  ```ts
  		if (!NOTE_COLORS.includes(color)) {
  			return void res.status(400).json({ error: `color must be one of ${NOTE_COLORS.join(' | ')}` })
  		}

  		// Attribution: stamp the real caller (credential wins; anonymous body.author
  		// is a cosmetic badge only). Resolved once, before the store transaction.
  		// The 2000-char check above ran on the pre-badge text — the badge is server
  		// chrome and must not eat the caller's budget.
  		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)
  		const badged = badgeText(text, attribution.display)

  		let createdId: string | null = null
  ```

- [ ] **Stamp `meta` and badge the text on the created note** — replace:
  ```ts
  				x,
  				y,
  				props: {
  					richText: toRichText(text),
  ```
  with:
  ```ts
  				x,
  				y,
  				meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {},
  				props: {
  					richText: toRichText(badged),
  ```
  (The `{ ok, id }` response shape is unchanged, so `canvasSticky.zodOutput`
  needs no edit.)

### Step 3 — Integrate `server/src/features/shape.ts` (create op only)

- [ ] **Add the two imports** — after
  `import type { PluginServerContext } from '../kernel/context.ts'`:
  ```ts
  import { badgeText, resolveAttribution } from '../kernel/attribution.ts'
  import { resolveCaller } from '../whoami.ts'
  ```

- [ ] **Resolve attribution once at the top of the handler** — replace:
  ```ts
  		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

  		// ---- delete -----------------------------------------------------------
  ```
  with:
  ```ts
  		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

  		// Attribution: stamp the real caller (credential wins; anonymous body.author
  		// is a cosmetic badge only). Resolved once; only the create branch consumes
  		// it — update/delete do NOT re-attribute (author is the shape's creator).
  		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)

  		// ---- delete -----------------------------------------------------------
  ```

- [ ] **Compute the badged text in the create branch** — replace:
  ```ts
  		const frameName = typeof body.frame === 'string' ? body.frame : null
  		let createdId: string | null = null
  ```
  with:
  ```ts
  		const frameName = typeof body.frame === 'string' ? body.frame : null
  		const badged = badgeText(text ?? '', attribution.display)
  		let createdId: string | null = null
  ```

- [ ] **Stamp `base.meta`** — the `base` object's `meta: {}` sits directly under
  `opacity: 1,`. Replace:
  ```ts
  					opacity: 1,
  					meta: {},
  				}
  ```
  with:
  ```ts
  					opacity: 1,
  					meta: attribution.metaAuthor ? { author: attribution.metaAuthor } : {},
  				}
  ```
  (There is a second `meta: {}` in the arrow **binding** put — that one is nested
  deeper, `meta: {},\n\t\t\t\t\t\tprops: {` — leave it; the `opacity: 1,` anchor
  above matches only `base`.)

- [ ] **Badge the four create-branch `toRichText` calls.** All four create-branch
  rich-text writes take the badged text; the **update-branch** write does not.
  Two replace-all edits, each hitting exactly the two create-branch occurrences:
  - Replace-all `richText: toRichText(text ?? ''),` → `richText: toRichText(badged),`
    (the **arrow** and **geo** branches — 2 occurrences).
  - Replace-all `richText: toRichText(text),` → `richText: toRichText(badged),`
    (the **text** and **note** branches — 2 occurrences).
  - **Do NOT touch** the update-branch line `props.richText = toRichText(text)`
    (a different string — `props.richText =`, no trailing comma — so neither
    replace-all matches it). Attribution is create-op only.

### Step 4 — Integrate `server/src/features/roadmap.ts` + the `RoadmapDoc` type

- [ ] **`server/src/roadmap-store.ts`** — widen the `RoadmapDoc` `meta` so
  TypeScript accepts the `author` assignment. Replace:
  ```ts
  export interface RoadmapDoc {
  	meta: { title: string; revision?: string; updated?: string }
  	outcomes: RoadmapOutcome[]
  }
  ```
  with:
  ```ts
  export interface RoadmapDoc {
  	meta: { title: string; revision?: string; updated?: string; author?: string }
  	outcomes: RoadmapOutcome[]
  }
  ```
  (`validateRoadmap` only *requires* `meta.title` and ignores unknown `meta`
  keys, so no validator change.)

- [ ] **`server/src/features/roadmap.ts`** — add the two imports. Replace:
  ```ts
  import { OpError, applyOps, type RoadmapOp } from '../roadmap-store.ts'
  ```
  with:
  ```ts
  import { OpError, applyOps, type RoadmapOp } from '../roadmap-store.ts'
  import { resolveAttribution } from '../kernel/attribution.ts'
  import { resolveCaller } from '../whoami.ts'
  ```
  (roadmap has no free-text surface to badge, so `badgeText` is not imported.)

- [ ] **Resolve attribution near the top of the POST handler** — replace:
  ```ts
  		const ifRev = typeof body.ifRev === 'number' && Number.isFinite(body.ifRev) ? body.ifRev : null

  		// The store's lock serializes the whole read-modify-write; POST bodies
  ```
  with:
  ```ts
  		const ifRev = typeof body.ifRev === 'number' && Number.isFinite(body.ifRev) ? body.ifRev : null

  		// Attribution: doc-level last-writer, credential-only — stamped beside the
  		// server-owned `updated`. An anonymous "none" write stamps neither (roadmap
  		// has no cosmetic text surface, so display is unused here).
  		const attribution = resolveAttribution(await resolveCaller(req.headers), body.author)

  		// The store's lock serializes the whole read-modify-write; POST bodies
  ```

- [ ] **Stamp `data.meta.author` beside `data.meta.updated`** — replace:
  ```ts
  			data.meta.updated = updated // server-stamped; client-supplied values are ignored
  			await ctx.storage.roadmaps.write(roomId, id, { name: existing?.name ?? name, rev, updated, data })
  ```
  with:
  ```ts
  			data.meta.updated = updated // server-stamped; client-supplied values are ignored
  			if (attribution.metaAuthor) data.meta.author = attribution.metaAuthor // server-stamped, like `updated`
  			await ctx.storage.roadmaps.write(roomId, id, { name: existing?.name ?? name, rev, updated, data })
  ```

### Step 5 — GREEN gate

- [ ] **Run the api test, the helper unit test, the regression suites, typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd server && bun src/attribution.test.ts)
  (cd server && bun src/attribution-api.test.ts)
  (cd server && bun src/write-scope-api.test.ts)
  (cd server && bun src/canvas-api.test.ts)
  (cd server && bun src/roadmap-api.test.ts)
  ```
  Expected: `bun run typecheck` exits 0; `attribution-api.test.ts` prints its six
  `ok:` lines then
  `ok: attribution-api — sticky/shape/roadmap stamp meta.author + badge from the caller`
  and exits 0; the three regression suites still pass (their assertions are on
  status + `{ ok, id }` / rev, not on badged note text — the one text assertion
  in `canvas-api.test.ts` seeds its note directly via `updateStore`, not through
  the badged POST path).

- [ ] **Commit:**
  ```bash
  git add server/src/features/sticky.ts server/src/features/shape.ts \
    server/src/features/roadmap.ts server/src/roadmap-store.ts \
    server/src/attribution-api.test.ts
  git commit -m "$(cat <<'EOF'
  feat(server): stamp write-time attribution across sticky/shape/roadmap (slice 3c)

  Each mutating content route now resolves the real caller and applies the shared
  attribution helper: sticky and shape (create op only) carry meta.author
  (credential only) and a badged richText; roadmap stamps doc-level meta.author
  beside the server-owned `updated`. Credential wins over body.author (silently
  ignored, no 4xx); an anonymous body.author is a cosmetic badge only; a
  label-less shape gets meta.author with no orphan badge. update/delete do not
  re-attribute. RoadmapDoc.meta gains an optional author. A booted-app api test
  pins every caller class and the label-less/roadmap sinks.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — Tool-def `author` field (the def travels with the route)

Add the optional `author` field to the three mutating tool defs (3b spec R5). The
contracts registry unit test (`tools.test.ts`) and the server completeness test
(`tools-api.test.ts`) must stay green: an optional string projects trivially to
JSON Schema, and no `(method, path)` changes (verb count stays 15).

- [ ] **`contracts/src/tools/canvas.ts`** — add `author` to `canvasSticky.zodInput`.
  Replace:
  ```ts
  		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional().describe('defaults to yellow server-side'),
  	}),
  	zodOutput: okId,
  }
  ```
  with:
  ```ts
  		color: z.enum(NOTE_COLORS as [string, ...string[]]).optional().describe('defaults to yellow server-side'),
  		author: z.string().optional().describe('voluntary display name; honoured only on anonymous/"none" instances — ignored when the caller is credentialed'),
  	}),
  	zodOutput: okId,
  }
  ```

- [ ] **`contracts/src/tools/canvas.ts`** — add the identical `author` line to
  `canvasShape.zodInput`. Replace:
  ```ts
  		props: z.record(z.string(), z.unknown()).optional().describe('raw prop merge (update)'),
  	}),
  ```
  with:
  ```ts
  		props: z.record(z.string(), z.unknown()).optional().describe('raw prop merge (update)'),
  		author: z.string().optional().describe('voluntary display name; honoured only on anonymous/"none" instances — ignored when the caller is credentialed'),
  	}),
  ```

- [ ] **`contracts/src/tools/roadmap.ts`** — add the **inert** `author` to
  `roadmapWrite.zodInput` (the describe string says so, lest the manifest mislead
  a CLI user). Replace:
  ```ts
  		ops: z.array(roadmapOp).min(1).describe('all-or-nothing op batch'),
  	}),
  ```
  with:
  ```ts
  		ops: z.array(roadmapOp).min(1).describe('all-or-nothing op batch'),
  		author: z.string().optional().describe('accepted for wire-shape uniformity but currently inert: ignored when the caller is credentialed, and roadmap has no cosmetic badge surface for anonymous authors'),
  	}),
  ```

- [ ] **GREEN gate — typecheck + both tool suites:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  (cd contracts && bun src/tools/tools.test.ts)
  (cd server && bun src/tools-api.test.ts)
  ```
  Expected: typecheck 0; `tools.test.ts` prints
  `ok: tool registry — 15 defs, unique ids/paths, all schemas serialise`;
  `tools-api.test.ts` prints
  `ok: /api/tools manifest — envelope v1, 15 tools, 15 routes match both directions`.
  (Both stay green: the added field is an optional string; paths/methods/count
  unchanged.)

- [ ] **Commit:**
  ```bash
  git add contracts/src/tools/canvas.ts contracts/src/tools/roadmap.ts
  git commit -m "$(cat <<'EOF'
  feat(contracts): add optional author to the mutating tool defs (slice 3c)

  canvasSticky / canvasShape gain an optional `author` (honoured only on
  anonymous "none" instances; ignored when credentialed); roadmapWrite declares
  it for wire-shape uniformity but marks it inert in its describe string. The
  def travels with the route. Optional string ⇒ tools.test.ts and tools-api.test.ts
  stay green (verb count 15, no path/method change).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — `bin/canvas cmd_sticky`: stop prefixing, send `body.author`

The client-side badge block is removed; `--author` becomes a wire field; the
light-blue default is preserved. `bin/canvas` keeps working end-to-end against the
new server (covered by Task 2's anonymous-with-author api case, which exercises
the exact wire shape this now sends).

- [ ] **Reword the `--help` text** — replace:
  ```
      '      name contains <name> (case-insensitive). --author prefixes the' \
      '      text with "🤖 <name>: " and defaults the colour to light-blue so' \
      '      agent stickies are distinct from teammates'"'"' notes.' \
  ```
  with:
  ```
      '      name contains <name> (case-insensitive). --author sends the author' \
      '      to the server, which stamps the "🤖 <name>: " badge, and defaults' \
      '      the colour to light-blue so agent stickies are distinct from' \
      '      teammates'"'"' notes.' \
  ```

- [ ] **Stop client-side prefixing** — replace:
  ```bash
    # Authorship is convention, not schema: tag the text and, unless the caller
    # picked a colour, default agent stickies to light-blue so they stand out
    # from teammates' notes.
    if [[ -n "$author" ]]; then
      text="🤖 ${author}: ${text}"
      [[ -n "$color" ]] || color='light-blue'
    fi
  ```
  with:
  ```bash
    # Author is now a wire field: the server stamps the 🤖 badge and meta.author
    # from the request's credential. On a "none" instance --author still shows as a
    # cosmetic badge. Keep the light-blue default so agent stickies stand out.
    if [[ -n "$author" ]]; then
      [[ -n "$color" ]] || color='light-blue'
    fi
  ```

- [ ] **Send `author` on the wire** — replace:
  ```bash
    [[ -n "$frame" ]] && payload+="$(printf ',"frame":"%s"' "$(json_escape "$frame")")"
    [[ -n "$color" ]] && payload+="$(printf ',"color":"%s"' "$color")"
    payload+='}'
  ```
  with:
  ```bash
    [[ -n "$frame" ]] && payload+="$(printf ',"frame":"%s"' "$(json_escape "$frame")")"
    [[ -n "$color" ]] && payload+="$(printf ',"color":"%s"' "$color")"
    [[ -n "$author" ]] && payload+="$(printf ',"author":"%s"' "$(json_escape "$author")")"
    payload+='}'
  ```

- [ ] **Gate — syntax check + typecheck (no bash test suite; behaviour is covered
  by Task 2's api anonymous-author case):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bash -n bin/canvas   # exits 0: no bash syntax error
  bun run typecheck
  ```
  Expected: `bash -n` exits 0; `bun run typecheck` exits 0.

- [ ] **Commit:**
  ```bash
  git add bin/canvas
  git commit -m "$(cat <<'EOF'
  feat(canvas-cli): send --author as a wire field, stop client-side prefixing (slice 3c)

  cmd_sticky no longer bakes "🤖 <name>: " into body.text; it sends body.author
  and lets the server stamp the badge and meta.author from the request's
  credential (on a "none" instance --author still renders as a cosmetic badge).
  The light-blue default for authored stickies is preserved. --help reworded.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — Full gate: typecheck + full suite + build + manual smoke

- [ ] **Step 1: Full gate:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun install
  bun run typecheck
  bun run test    # spawns tmux; takes a few minutes — let it finish
  bun run build
  ```
  Expected: typecheck 0; `bun run test` ends **`all 45 suites passed`** (43 + the
  two new suites: `server/src/attribution.test.ts` and
  `server/src/attribution-api.test.ts`); `bun run build` 0. No existing suite
  changes (response shapes unchanged; the tool suites stay green on the optional
  field).

- [ ] **Step 2: Manual smoke (optional; needs `tmux` + `bin/dev`).** With a
  read-write service token configured, an authored sticky renders a single badge
  and the persisted record carries `meta.author`:
  ```bash
  bin/dev up
  # Credentialed (read-write service token) — server stamps meta.author + badge:
  ENSEMBLEWORKS_TOKEN_ID=… ENSEMBLEWORKS_TOKEN_SECRET=… bin/canvas sticky 'hello' --frame Advice
  bin/canvas read Advice | jq '.notes'    # badged text: "🤖 <bot-identity>: hello"
  # Anonymous "none" instance — --author is a cosmetic badge, no meta.author:
  bin/canvas sticky 'hi' --author dave
  ```
  Expected: the credentialed note reads `🤖 <bot-identity>: hello`; the anonymous
  note reads `🤖 dave: hi` with no `meta.author` in the persisted record.

- [ ] **Step 3: Commit — nothing new to commit (the gate is verification):**
  ```bash
  git status   # expect clean
  ```

---

## Execution notes

_(Executors: record the final `bun run test` suite count — it must read
`all 45 suites passed` — and any deviation from the verbatim blocks above.)_

### Self-review — coverage of the spec (done while writing this plan)

- **Every spec component appears in a task.**
  - `server/src/kernel/attribution.ts` (`resolveAttribution` + `badgeText` with
    the empty-text no-op) — Task 1, verbatim from the spec's helper block.
  - `features/sticky.ts` full integration (two imports, resolve-before-txn,
    `meta` + `badgeText`) — Task 2 Step 2, transcribed against the live handler;
    length check stays on the pre-badge text.
  - `features/shape.ts` create-op integration — Task 2 Step 3: attribution
    resolved once at handler top; `base.meta` stamped; all four **create-branch**
    `toRichText` calls badged; the update-branch `props.richText = toRichText(text)`
    left untouched (verified a different string, so the replace-alls can't hit it);
    label-less geo/arrow ⇒ `meta.author` only (badge no-ops on empty text).
  - `features/roadmap.ts` doc-level author + `roadmap-store.ts` `RoadmapDoc.meta`
    widening — Task 2 Step 4, beside the existing `updated` server-stamp.
  - The three tool-def `author` additions (canvasSticky, canvasShape, and the
    **inert** roadmapWrite with its describe string) — Task 3.
  - `bin/canvas cmd_sticky` (stop prefixing, send `body.author`, keep light-blue
    default, reword `--help`) — Task 4.
  - Both test suites: the pure helper unit test (Task 1, RED→GREEN) and the
    booted-app api test (Task 2, RED→GREEN). Suite count 43 → 45.
- **TDD ordering honoured.** Helper unit test written first and shown RED (module
  missing), then helper to green (Task 1). Api test written and shown RED (no
  stamping), then the three handler integrations to green (Task 2).
- **Booted-app convention enforced.** `attribution-api.test.ts` ends with
  `process.exit(0)` after its final `console.log` (Environment note 6) — without
  it the app's intervals keep the loop alive and the suite runner hangs. The pure
  `attribution.test.ts` boots nothing and needs no exit.
- **Placeholder scan:** no "as per spec"/"similar to sticky" hand-waving — every
  handler edit is an exact old→new block anchored to the live source, every gate
  names its command + expected output.
- **Type consistency:** `Whoami` (imported from `@ensembleworks/contracts`) is the
  `resolveCaller` return the helper consumes; `resolveCaller` / `resolveAttribution`
  / `badgeText` / `richTextToPlainText` / `ROADMAP_FIXTURE` / `createSyncApp` are
  the exact exports the tests and handlers import; `RoadmapDoc.meta.author?` makes
  the roadmap assignment typecheck; the tool suites stay green on the optional
  string field.
```
