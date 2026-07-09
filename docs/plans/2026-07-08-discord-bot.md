# Discord Bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Discord integration that pushes a room's summaries/action-items/decisions/frame-links into Discord on an explicit action, and pulls messages from a bound Discord channel back onto the canvas as stickies — extensible to other handlers via a router.

**Architecture:** A standalone `discord` Bun workspace holds the one bot token and the Discord gateway websocket. It owns no room state: inbound messages are routed to handlers that call the sync server's existing HTTP API (`POST /api/canvas/sticky`); outbound posts originate in the client, go to the sync server (`POST /api/discord/post`), which resolves bindings and forwards to the bot's loopback-only `POST /post`. Bindings are per-room, UI-editable records persisted server-side, mirroring the existing **roadmap** feature (not tldraw shapes). Discord itself sits behind a thin adapter so everything is testable without a network.

**Tech Stack:** Bun 1.3.14, Express 5, `@tldraw/sync-core`, `discord.js` (new dep), `bun:test`-style standalone test scripts (`node:assert/strict`), React/Vite client, tmux dev stack via `bin/dev`.

**Companion design doc:** `docs/discord-bot-design.md`. **Load-bearing assumption:** single-org per deployment (one bot token, room participants mutually trusted) — see that doc's "Assumptions that will hurt if violated" and agent memory `discord-bot-single-org-assumption`. If multi-tenancy ever appears, stop and revisit the binding + authorization layers.

---

## Milestones (each independently shippable, in order)

- **A — Frame deep-link** (client only). `?room=&frame=` opens+zooms a frame; "copy link" affordance. No Discord.
- **B — Bindings store, API, and UI** (server + client). The mapping backbone, mirroring roadmap. No Discord process.
- **C — Bot service skeleton: adapter seam + router + registry** (new workspace). Unit-tested with a fake gateway.
- **D — Inbound `frame-sticky` handler**. Fake Discord message → sticky on the bound frame.
- **E — Outbound path**. Client trigger → server `/api/discord/post` → bot `/post` → embed. Four payload formatters.
- **F — Dev-stack + deploy wiring**. `bin/dev` service, ports, root scripts, systemd, docs.

Commit after every task. Run `bun run typecheck` before each milestone's final commit.

---

# Milestone A — Frame deep-link

Standalone and shippable on its own. All logic is extracted into pure functions so it can be tested under the repo's logic-only `bun` test harness (no DOM). Wiring into React (`App.tsx` effect, `focus.ts`, plugin button) is done after the pure core is proven.

### Task A1: Pure `parseFrameId` + `buildFrameLink` helpers

**Files:**
- Create: `client/src/chrome/frameLink.ts`
- Test: `client/src/chrome/frameLink.test.ts`

**Step 1: Write the failing test**

```ts
// client/src/chrome/frameLink.test.ts
import assert from 'node:assert/strict'
import { parseFrameId, buildFrameLink } from './frameLink.ts'

// parseFrameId validates a tldraw shape id from a raw query value.
assert.equal(parseFrameId(null), null, 'absent ⇒ null')
assert.equal(parseFrameId(''), null, 'empty ⇒ null')
assert.equal(parseFrameId('not-a-shape'), null, 'missing shape: prefix ⇒ null')
assert.equal(parseFrameId('shape:abc123'), 'shape:abc123', 'valid passes through')
assert.equal(parseFrameId('shape:bad id!'), null, 'illegal chars ⇒ null')
assert.equal(parseFrameId('shape:' + 'x'.repeat(200)), null, 'over-long ⇒ null')

// buildFrameLink composes an absolute URL from origin + room + frame id.
assert.equal(
  buildFrameLink('https://ew.example', 'planning', 'shape:abc123'),
  'https://ew.example/?room=planning&frame=shape%3Aabc123',
)

console.log('ok: frameLink helpers')
```

**Step 2: Run to verify it fails**

Run: `bun client/src/chrome/frameLink.test.ts`
Expected: FAIL — `Cannot find module './frameLink.ts'`.

**Step 3: Write the implementation**

```ts
// client/src/chrome/frameLink.ts
// Deep-link helpers for focusing a specific frame from a URL.
// Kept pure (no tldraw/DOM) so they run under the logic-only bun test harness.

// tldraw shape ids look like `shape:<base62-ish>`; validate conservatively.
const SHAPE_ID_RE = /^shape:[A-Za-z0-9_-]{1,100}$/

export function parseFrameId(raw: string | null | undefined): string | null {
  if (!raw) return null
  return SHAPE_ID_RE.test(raw) ? raw : null
}

export function buildFrameLink(origin: string, room: string, frameId: string): string {
  const params = new URLSearchParams({ room, frame: frameId })
  return `${origin}/?${params.toString()}`
}
```

**Step 4: Run to verify it passes**

Run: `bun client/src/chrome/frameLink.test.ts`
Expected: `ok: frameLink helpers`.

**Step 5: Commit**

```bash
git add client/src/chrome/frameLink.ts client/src/chrome/frameLink.test.ts
git commit -m "feat(client): pure frame deep-link helpers"
```

### Task A2: `getFrameId()` URL reader

**Files:**
- Modify: `client/src/identity.ts` (mirror `getRoomId` at `identity.ts:60-63`)
- Test: `client/src/chrome/frameLink.test.ts` (extend)

**Step 1: Add a failing test** — append to `frameLink.test.ts`, driving a reader that takes an explicit search string (so it stays DOM-free and testable):

```ts
import { readFrameId } from './frameLink.ts'
assert.equal(readFrameId('?room=team&frame=shape:abc123'), 'shape:abc123')
assert.equal(readFrameId('?room=team'), null, 'no frame param ⇒ null')
assert.equal(readFrameId('?frame=garbage'), null, 'invalid ⇒ null')
console.log('ok: readFrameId')
```

**Step 2: Run — FAIL** (`readFrameId` not exported). `bun client/src/chrome/frameLink.test.ts`

**Step 3: Implement `readFrameId` in `frameLink.ts`:**

```ts
export function readFrameId(search: string): string | null {
  return parseFrameId(new URLSearchParams(search).get('frame'))
}
```

Then add the thin DOM wrapper to `client/src/identity.ts` (next to `getRoomId`):

```ts
import { readFrameId } from './chrome/frameLink.ts'
// Returns the deep-link target frame id from the current URL, or null.
export function getFrameId(): string | null {
  return readFrameId(location.search)
}
```

**Step 4: Run — PASS.** `bun client/src/chrome/frameLink.test.ts`

**Step 5: Commit**

```bash
git add client/src/chrome/frameLink.ts client/src/identity.ts client/src/chrome/frameLink.test.ts
git commit -m "feat(client): read ?frame= deep-link target from URL"
```

### Task A3: Allow frames to be focus targets

**Files:**
- Modify: `client/src/chrome/focus.ts:32`

**Step 1:** No unit test (tldraw editor behavior; covered by manual verification in A5). Change the set:

```ts
// client/src/chrome/focus.ts:32
export const FOCUSABLE_SHAPE_TYPES = new Set(['terminal', 'frame'])
```

**Step 2:** `bun run --filter '@ensembleworks/client' typecheck` → expect clean.

**Step 3: Commit**

```bash
git add client/src/chrome/focus.ts
git commit -m "feat(client): allow frames as focus targets"
```

> **Decision baked in:** the deep-link uses a plain, *pan-able* `zoomToBounds` landing (see A4), NOT `enterFocus`'s camera-locked matte — a recipient following a shared link should not be trapped in a locked letterbox. `enterFocus`/`FOCUSABLE_SHAPE_TYPES` is widened only so the manual ⛶ affordance also works on frames; the deep-link effect calls `zoomToBounds` directly.

### Task A4: Deep-link effect in `App.tsx`

**Files:**
- Modify: `client/src/App.tsx` (add a `useEffect`, alongside the effects at `App.tsx:124-161`; editor state at `:68`, store at `:69`)

**Step 1:** No pure unit test (React + tldraw runtime). Add the effect. It waits for both the editor and the target shape to hydrate over sync, then zooms once (guarded by a ref):

```tsx
// near the other imports
import { getFrameId } from './identity.ts'
// inside the App component body, after `const [editor, setEditor] = useState<Editor | null>(null)`
const didDeepLink = useRef(false)
useEffect(() => {
  if (!editor || didDeepLink.current) return
  const frameId = getFrameId()
  if (!frameId) return
  // The shape may not have synced in yet; poll reactively until it exists.
  const dispose = react('deep-link frame', () => {
    if (didDeepLink.current) return
    const shape = editor.getShape(frameId as TLShapeId)
    if (!shape) return
    const bounds = editor.getShapePageBounds(frameId as TLShapeId)
    if (!bounds) return
    didDeepLink.current = true
    editor.zoomToBounds(bounds, { inset: 16, animation: { duration: 220 } })
  })
  return dispose
}, [editor])
```

Import `react` from `@tldraw/state` (or `tldraw`) and `TLShapeId`/`Editor` from `tldraw` — match how `focus.ts` and `FocusOverlay.tsx` already import them.

**Step 2:** `bun run --filter '@ensembleworks/client' typecheck` → clean.

**Step 3: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(client): zoom to ?frame= target once it hydrates"
```

### Task A5: "Copy link to this frame" plugin bar item

**Files:**
- Create: `client/src/framelink/plugin.tsx` (mirror `client/src/iframe/plugin.tsx:13-21`)
- Modify: wherever plugins are registered (find the registry that consumes `iframe/plugin.tsx`; grep `barItems` / the plugin registry import site)

**Step 1:** No unit test for the wiring (uses `navigator.clipboard`, `editor` selection). The pure URL build is already tested (A1). Implement:

```tsx
// client/src/framelink/plugin.tsx
import type { Editor } from 'tldraw'
import { getRoomId } from '../identity.ts'
import { buildFrameLink } from '../chrome/frameLink.ts'

export const frameLinkPlugin = {
  barItems: [
    {
      id: 'copy-frame-link',
      label: 'copy frame link',
      icon: 'link',
      placement: 'overflow' as const,
      onSelect: (editor: Editor) => {
        const ids = editor.getSelectedShapeIds()
        if (ids.length !== 1) return
        const shape = editor.getShape(ids[0])
        if (!shape || shape.type !== 'frame') return
        const url = buildFrameLink(location.origin, getRoomId(), shape.id)
        navigator.clipboard?.writeText(url).catch(() => {})
      },
      useAvailable: () => true, // optional: gate on a single frame being selected
    },
  ],
}
```

Match the exact `BarItemDescriptor` interface at `client/src/kernel/plugin.ts:43-56` and register it exactly like the iframe plugin is registered.

**Step 2:** `bun run --filter '@ensembleworks/client' typecheck` → clean.

**Step 3: Manual verification (record result in the execution log):**
1. `bin/dev up` (or the client dev server); open a room, add a frame, select it.
2. Overflow menu → "copy frame link"; paste — confirm `…/?room=<room>&frame=shape:…`.
3. Open that URL in a fresh tab → the canvas loads and animates to the frame.

**Step 4: Commit**

```bash
git add client/src/framelink/plugin.tsx <registry-file>
git commit -m "feat(client): copy-frame-link overflow action"
```

**Milestone A gate:** `bun run --filter '@ensembleworks/client' typecheck` clean; manual deep-link round-trip verified.

---

# Milestone B — Bindings store, API, and UI

Bindings are per-room, UI-editable, persisted records. **We mirror the roadmap feature** (`server/src/roadmap-store.ts` + a feature router + client refetch), NOT the tldraw schema (tldraw has no arbitrary-record type; see the design doc). The store also serves an inbound reverse lookup (channelId → binding) for the bot.

**Binding shape** (shared type, add to `contracts/src/tools/` next to `canvas.ts`):

```ts
export interface DiscordBinding {
  id: string
  room: string
  guildId: string
  channelId: string
  direction: 'in' | 'out'
  route: { handler: string; params: Record<string, unknown> }
  createdBy: string
  createdAt: number
}
```

### Task B1: `discord-store.ts` (persistence)

**Files:**
- Create: `server/src/discord-store.ts` (template: `server/src/roadmap-store.ts:1-13` — one JSON file, whole-file read/write, `withLock` per-key serializer)
- Test: `server/src/discord-store.test.ts`

**Step 1: Write the failing test**

```ts
// server/src/discord-store.test.ts
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDiscordStore } from './discord-store.ts'

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'discord-store-'))
  const store = createDiscordStore(dir)

  const b = await store.create({
    room: 'planning', guildId: 'g1', channelId: 'c1', direction: 'in',
    route: { handler: 'frame-sticky', params: { frameId: 'shape:f1' } },
    createdBy: 'alice',
  })
  assert.ok(b.id, 'create returns an id')
  assert.equal((await store.listByRoom('planning')).length, 1)
  assert.equal((await store.listByRoom('other')).length, 0, 'scoped by room')

  // reverse lookup used by the inbound router: channelId → inbound bindings
  const hits = await store.listInboundByChannel('c1')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].route.handler, 'frame-sticky')

  await store.remove(b.id)
  assert.equal((await store.listByRoom('planning')).length, 0, 'remove works')

  // persistence across instances
  await store.create({ room: 'r', guildId: 'g', channelId: 'c2', direction: 'out',
    route: { handler: 'summary', params: {} }, createdBy: 'bob' })
  const reopened = createDiscordStore(dir)
  assert.equal((await reopened.listByRoom('r')).length, 1, 'persists to disk')

  console.log('ok: discord-store')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

**Step 2: Run — FAIL** (`Cannot find module './discord-store.ts'`). `bun server/src/discord-store.test.ts`

**Step 3: Implement** (adapt `roadmap-store.ts`; a single JSON file `<dataDir>/discord/bindings.json`, `withLock` around writes; generate ids with `crypto.randomUUID()`):

```ts
// server/src/discord-store.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DiscordBinding } from '@ensembleworks/contracts'

type NewBinding = Omit<DiscordBinding, 'id' | 'createdAt'>

export function createDiscordStore(dataDir: string) {
  const dir = path.join(dataDir, 'discord')
  const file = path.join(dir, 'bindings.json')
  mkdirSync(dir, { recursive: true })

  const load = (): DiscordBinding[] =>
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const save = (all: DiscordBinding[]) =>
    writeFileSync(file, JSON.stringify(all, null, 2))

  // NOTE: single-process store; the roadmap `withLock` serializer is the model
  // if concurrent writers appear. v1 is called only from the sync server.
  return {
    async create(input: NewBinding): Promise<DiscordBinding> {
      const all = load()
      const binding: DiscordBinding = { ...input, id: randomUUID(), createdAt: Date.now() }
      all.push(binding)
      save(all)
      return binding
    },
    async listByRoom(room: string): Promise<DiscordBinding[]> {
      return load().filter((b) => b.room === room)
    },
    async listInboundByChannel(channelId: string): Promise<DiscordBinding[]> {
      return load().filter((b) => b.direction === 'in' && b.channelId === channelId)
    },
    async listOutbound(room: string): Promise<DiscordBinding[]> {
      return load().filter((b) => b.direction === 'out' && b.room === room)
    },
    async remove(id: string): Promise<void> {
      save(load().filter((b) => b.id !== id))
    },
  }
}
```

> `Date.now()`/`randomUUID()` are fine in **server** runtime code — the "no Date.now/Math.random" restriction applies only to Workflow scripts, not to the app.

**Step 4: Run — PASS.** `bun server/src/discord-store.test.ts`

**Step 5: Commit**

```bash
git add server/src/discord-store.ts server/src/discord-store.test.ts contracts/src/... 
git commit -m "feat(server): per-room Discord bindings store"
```

### Task B2: `/api/discord/bindings` router

**Files:**
- Create: `server/src/features/discord.ts` (mirror the roadmap router; mount in `app.ts` next to roadmap at `app.ts:151`)
- Modify: `server/src/kernel/context.ts` (expose `ctx.storage.discord`, mirror `ctx.storage.roadmaps` at `context.ts:14-24`), `server/src/app.ts:66` (construct the store), `app.ts` router mount list (`app.ts:127-159`)
- Test: `server/src/discord-api.test.ts` (boot in-process, mirror `canvas-api.test.ts:19-38`)

**Step 1: Write the failing contract test**

```ts
// server/src/discord-api.test.ts (abridged — full boot per canvas-api.test.ts)
const created = await postJson('/api/discord/bindings', {
  room: 'test', guildId: 'g1', channelId: 'c1', direction: 'in',
  route: { handler: 'frame-sticky', params: { frameId: 'shape:f1' } },
})
assert.equal(created.status, 200)
assert.ok(created.body.id)

const list = await getJson('/api/discord/bindings?room=test')
assert.equal(list.status, 200)
assert.equal(list.body.bindings.length, 1)

const del = await (await fetch(`${base}/api/discord/bindings/${created.body.id}`,
  { method: 'DELETE' })).status
assert.equal(del, 200)
const empty = await getJson('/api/discord/bindings?room=test')
assert.equal(empty.body.bindings.length, 0)
```

**Step 2: Run — FAIL** (404, no route). `bun server/src/discord-api.test.ts`

**Step 3: Implement the router** (`createDiscordRouter(ctx)`), routes:
- `GET  /api/discord/bindings?room=` → `{ bindings: await ctx.storage.discord.listByRoom(room) }`
- `POST /api/discord/bindings` → validate body, `createdBy` from `resolveCaller(req.headers)` (see `whoami.ts:42`), return the binding.
- `DELETE /api/discord/bindings/:id` → `remove`, `{ ok: true }`.

Wire it: construct the store at `app.ts:66` (`const discord = createDiscordStore(dataDir)`), add to context storage (`context.ts`), `app.use(createDiscordRouter(ctx))` in the mount list. This route is under `/api` so it inherits `express.json()` (`app.ts:112`) and the write-scope guard (`app.ts:115`).

**Step 4: Run — PASS.** `bun server/src/discord-api.test.ts`

**Step 5: Commit**

```bash
git add server/src/features/discord.ts server/src/discord-api.test.ts server/src/app.ts server/src/kernel/context.ts
git commit -m "feat(server): Discord bindings HTTP API"
```

### Task B3: Client bindings panel

**Files:**
- Create: `client/src/discord/BindingsPanel.tsx` and a small `client/src/discord/api.ts` (fetch wrappers to `/api/discord/bindings`, mirror how `RoadmapShapeUtil.tsx:135` calls its API + refetch-on-rev)
- Modify: the side panel / settings surface where such controls live (grep where `SidePanel.tsx` composes sections)
- Test: `client/src/discord/api.test.ts` (pure: URL/param building + response mapping only — no DOM, per the logic-only harness)

**Step 1:** Test the pure request-builder (mirror the `frameLink` test style). **Step 2:** run-fail. **Step 3:** implement `listBindings(room)`, `createBinding(input)`, `deleteBinding(id)` as thin `fetch` wrappers; the panel lists a room's bindings, offers create (channelId + direction + handler + params) and delete. Getting the room slug: `getRoomId()`. **Step 4:** run-pass + `typecheck`. **Step 5:** commit.

> **Ergonomics is an open question** (design doc): keep the panel minimal — a plain list + add/remove form is enough for v1. The outbound *trigger* UI (chip vs widget) is decided in Milestone E.

**Milestone B gate:** `bun server/src/discord-api.test.ts` + `bun server/src/discord-store.test.ts` pass; `bun run typecheck` clean; manually create/delete a binding from the UI and confirm it round-trips.

---

# Milestone C — Bot service skeleton: adapter seam + router + registry

New `discord` workspace. **Discord stays behind an adapter** so the router and handlers are tested with a fake — no token, no network.

### Task C1: Scaffold the `discord` workspace

**Files:**
- Create: `discord/package.json` (clone `transcriber/package.json`; sole dep `discord.js`, plus `@ensembleworks/contracts`), `discord/tsconfig.json` (clone `transcriber/tsconfig.json`), `discord/src/main.ts` (empty entry that logs and stays alive)
- Modify: root `package.json` — add `"discord"` to `workspaces`; **append** `&& bun run --filter '@ensembleworks/discord' typecheck` to the root `typecheck` script and `&& … build` to the root `build` script (the enumeration is manual — a new workspace is otherwise silently skipped by CI/`release.sh`).

**Step 1:** `bun install` (picks up the workspace). **Step 2:** `bun run --filter '@ensembleworks/discord' typecheck` → clean. **Step 3:** `bun run typecheck` (root) → confirms the new workspace is now in the chain. **Step 4: Commit**

```bash
git add discord/package.json discord/tsconfig.json discord/src/main.ts package.json bun.lock*
git commit -m "chore(discord): scaffold discord workspace"
```

### Task C2: The gateway adapter interface

**Files:**
- Create: `discord/src/adapter.ts` (the seam), `discord/src/adapter.fake.ts` (test double)
- Test: `discord/src/adapter.fake.test.ts`

**Step 1: Write the failing test** — the fake lets a test inject a message and capture sends:

```ts
// discord/src/adapter.fake.test.ts
import assert from 'node:assert/strict'
import { FakeGateway } from './adapter.fake.ts'

const gw = new FakeGateway()
const seen: any[] = []
gw.onMessage((m) => { seen.push(m) })
gw.emit({ channelId: 'c1', guildId: 'g1', authorId: 'u1', authorName: 'alice', isBot: false, content: 'hi' })
assert.equal(seen.length, 1)
assert.equal(seen[0].content, 'hi')

await gw.send('c1', { title: 'T', description: 'D' })
assert.deepEqual(gw.sent[0], { channelId: 'c1', embed: { title: 'T', description: 'D' } })
console.log('ok: fake gateway')
```

**Step 2: Run — FAIL.** `bun discord/src/adapter.fake.test.ts`

**Step 3: Implement** the interface + fake:

```ts
// discord/src/adapter.ts
export interface InboundMessage {
  channelId: string
  guildId: string
  authorId: string
  authorName: string
  isBot: boolean
  content: string
}
export interface Embed { title?: string; description?: string; url?: string }
export interface Gateway {
  onMessage(handler: (m: InboundMessage) => void): void
  send(channelId: string, embed: Embed): Promise<void>
}
```

```ts
// discord/src/adapter.fake.ts
import type { Gateway, InboundMessage, Embed } from './adapter.ts'
export class FakeGateway implements Gateway {
  private handlers: ((m: InboundMessage) => void)[] = []
  sent: { channelId: string; embed: Embed }[] = []
  onMessage(h: (m: InboundMessage) => void) { this.handlers.push(h) }
  emit(m: InboundMessage) { for (const h of this.handlers) h(m) }
  async send(channelId: string, embed: Embed) { this.sent.push({ channelId, embed }) }
}
```

**Step 4: Run — PASS.** **Step 5: Commit** `feat(discord): gateway adapter seam + fake`.

### Task C3: Handler registry + router (pure, the extensibility seam)

**Files:**
- Create: `discord/src/router.ts`, `discord/src/registry.ts`
- Test: `discord/src/router.test.ts`

**Step 1: Write the failing test** — covers dispatch, echo-drop, unbound-channel, unknown-handler:

```ts
// discord/src/router.test.ts
import assert from 'node:assert/strict'
import { Router } from './router.ts'

const calls: any[] = []
const registry = { 'frame-sticky': { handle: async (m: any, params: any) => { calls.push({ m, params }) } } }
// resolveBinding: channelId → inbound bindings (stub for the server lookup)
const resolve = async (channelId: string) =>
  channelId === 'c1' ? [{ route: { handler: 'frame-sticky', params: { frameId: 'shape:f1' } }, room: 'planning' }] : []

const router = new Router({ registry, resolveBinding: resolve })

await router.handle({ channelId: 'c1', guildId: 'g', authorId: 'u', authorName: 'a', isBot: false, content: 'hello' })
assert.equal(calls.length, 1, 'bound channel dispatches')
assert.equal(calls[0].params.frameId, 'shape:f1')
assert.equal(calls[0].m.room, 'planning', 'router injects room into context')

await router.handle({ channelId: 'c1', guildId: 'g', authorId: 'u', authorName: 'a', isBot: true, content: 'echo' })
assert.equal(calls.length, 1, 'bot messages are dropped (echo/loop guard)')

await router.handle({ channelId: 'nope', guildId: 'g', authorId: 'u', authorName: 'a', isBot: false, content: 'x' })
assert.equal(calls.length, 1, 'unbound channel reaches nothing (security gate)')

console.log('ok: router')
```

**Step 2: Run — FAIL.** **Step 3: Implement:**

```ts
// discord/src/registry.ts
import type { InboundMessage } from './adapter.ts'
export interface HandlerContext { room: string; message: InboundMessage }
export interface InboundHandler {
  handle(ctx: HandlerContext, params: Record<string, unknown>): Promise<void>
}
export type Registry = Record<string, InboundHandler>
```

```ts
// discord/src/router.ts
import type { InboundMessage } from './adapter.ts'
import type { Registry } from './registry.ts'

interface ResolvedBinding { room: string; route: { handler: string; params: Record<string, unknown> } }
interface RouterOpts {
  registry: Registry
  resolveBinding: (channelId: string) => Promise<ResolvedBinding[]>
}

export class Router {
  constructor(private opts: RouterOpts) {}
  async handle(m: InboundMessage): Promise<void> {
    if (m.isBot) return // echo/loop guard — never re-ingest our own posts
    const bindings = await this.opts.resolveBinding(m.channelId)
    for (const b of bindings) {
      const handler = this.opts.registry[b.route.handler]
      if (!handler) continue // unknown handler ignored safely
      await handler.handle({ room: b.room, message: m }, b.route.params)
    }
  }
}
```

**Step 4: Run — PASS.** **Step 5: Commit** `feat(discord): handler registry + inbound router`.

**Milestone C gate:** all `discord/src/*.test.ts` pass; root `bun run typecheck` clean (workspace is in the chain).

---

# Milestone D — Inbound `frame-sticky` handler

Turns a Discord message into a note on the bound frame by calling the sync server's existing `POST /api/canvas/sticky` (`features/sticky.ts`; body `{ room, frame, text, author, color? }` → `{ ok, id }`).

### Task D1: A `SyncServerClient` (bot → server)

**Files:**
- Create: `discord/src/syncClient.ts`, test `discord/src/syncClient.test.ts`

**Step 1: Failing test** — spin a tiny stub `Bun.serve` that records the POST body, assert the client posts the right shape:

```ts
// discord/src/syncClient.test.ts (abridged)
const received: any[] = []
const srv = Bun.serve({ port: 0, async fetch(req) {
  received.push({ url: new URL(req.url).pathname, body: await req.json() })
  return Response.json({ ok: true, id: 'shape:new' })
}})
const client = new SyncServerClient(`http://127.0.0.1:${srv.port}`)
const id = await client.createSticky({ room: 'planning', frame: 'shape:f1', text: 'hi', author: 'alice (Discord)' })
assert.equal(id, 'shape:new')
assert.equal(received[0].url, '/api/canvas/sticky')
assert.equal(received[0].body.frame, 'shape:f1')
srv.stop()
```

**Step 2: Run — FAIL.** **Step 3: Implement** a `fetch` wrapper. In prod it also attaches CF Access service-token headers (`CF-Access-Client-Id`/`-Secret` from env — the established bot→server pattern, `cli/src/resolve.ts:71`); in dev/tests those envs are absent and the call is a plain loopback POST. **Step 4: Run — PASS.** **Step 5: Commit** `feat(discord): sync-server client`.

### Task D2: `frame-sticky` handler

**Files:**
- Create: `discord/src/handlers/frameSticky.ts`, test `discord/src/handlers/frameSticky.test.ts`

**Step 1: Failing test** — handler + fake sync client, assert it calls `createSticky` with author-attribution and the frame from params:

```ts
const calls: any[] = []
const fakeClient = { createSticky: async (a: any) => { calls.push(a); return 'shape:x' } }
const handler = makeFrameStickyHandler(fakeClient as any)
await handler.handle(
  { room: 'planning', message: { authorName: 'alice', content: 'ship it', isBot: false, channelId: 'c1', guildId: 'g', authorId: 'u' } },
  { frameId: 'shape:f1' },
)
assert.equal(calls[0].room, 'planning')
assert.equal(calls[0].frame, 'shape:f1')
assert.equal(calls[0].text, 'ship it')
assert.match(calls[0].author, /alice.*Discord/i)
```

**Step 2: Run — FAIL.** **Step 3: Implement:**

```ts
// discord/src/handlers/frameSticky.ts
import type { InboundHandler } from '../registry.ts'
import type { SyncServerClient } from '../syncClient.ts'

export function makeFrameStickyHandler(client: SyncServerClient): InboundHandler {
  return {
    async handle(ctx, params) {
      const frame = String(params.frameId ?? '')
      if (!frame) return
      await client.createSticky({
        room: ctx.room,
        frame,
        text: ctx.message.content,
        author: `${ctx.message.authorName} (Discord)`,
      })
    },
  }
}
```

**Step 4: Run — PASS.** **Step 5: Commit** `feat(discord): frame-sticky inbound handler`.

### Task D3: End-to-end contract test (fake gateway → real sync server → sticky on frame)

**Files:**
- Create: `discord/src/inbound.e2e.test.ts` (imports `createSyncApp` from the server workspace, boots it in-process like `canvas-api.test.ts:19-38`, seeds a frame, wires `FakeGateway → Router → frame-sticky → SyncServerClient(base)`, emits a message, asserts a `note` shape lands in the frame)

**Step 1: Write it (failing).** Emit `{ channelId:'c1', isBot:false, content:'from discord', authorName:'alice' }` with a binding `c1 → { handler:'frame-sticky', params:{ frameId } }`; then read `room.getCurrentSnapshot().documents` and assert a `type==='note'` whose `props.richText` includes `from discord` and whose `parentId` is the frame. **Step 2: Run — FAIL** (before wiring). **Step 3: Wire** the pieces in the test (they already exist from C/D). **Step 4: Run — PASS.** **Step 5: Commit** `test(discord): inbound end-to-end (message → sticky)`.

**Milestone D gate:** the e2e test proves a Discord message becomes a canvas sticky, entirely without a real Discord connection.

---

# Milestone E — Outbound path

Client trigger → `POST /api/discord/post` (sync server) → resolve outbound bindings → `POST /post` (bot, loopback + shared secret) → formatter → `gateway.send`.

### Task E1: Payload formatters (pure)

**Files:**
- Create: `discord/src/formatters.ts`, test `discord/src/formatters.test.ts`

**Step 1: Failing test** — one case per `kind`:

```ts
import { formatPayload } from './formatters.ts'
assert.match(formatPayload({ kind: 'decision', room: 'r', data: { text: 'use bun' } }).title!, /decision/i)
const items = formatPayload({ kind: 'action-items', room: 'r', data: { items: [{ text: 'do x', owner: 'al' }] } })
assert.match(items.description!, /do x/)
const link = formatPayload({ kind: 'frame-link', room: 'r', data: { url: 'https://e/x', title: 'Sketch' } })
assert.equal(link.url, 'https://e/x')
assert.ok(formatPayload({ kind: 'summary', room: 'r', data: { text: 'we met' } }).description)
```

**Step 2: Run — FAIL.** **Step 3: Implement** `formatPayload(payload): Embed` with a switch over the four kinds (content is composed room-side; this only shapes the embed). **Step 4: Run — PASS.** **Step 5: Commit** `feat(discord): outbound payload formatters`.

### Task E2: Bot `POST /post` internal endpoint (shared secret)

**Files:**
- Create: `discord/src/httpFace.ts` (a `Bun.serve` bound to `127.0.0.1:PORTS.discord`), test `discord/src/httpFace.test.ts`

**Step 1: Failing test** — a request without the shared secret is rejected 401; with it, the formatter runs and `gateway.send` is called on the target channel:

```ts
const gw = new FakeGateway()
const stop = startHttpFace({ gateway: gw, secret: 's3cret', port: 0 /* returns chosen port */ })
// missing secret → 401
let res = await fetch(`${base}/post`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelId: 'c1', payload: { kind: 'summary', room: 'r', data: { text: 'x' } } }) })
assert.equal(res.status, 401)
// with secret → 200 and a send happened
res = await fetch(`${base}/post`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-secret': 's3cret' },
  body: JSON.stringify({ channelId: 'c1', payload: { kind: 'summary', room: 'r', data: { text: 'x' } } }) })
assert.equal(res.status, 200)
assert.equal(gw.sent[0].channelId, 'c1')
```

**Step 2: Run — FAIL.** **Step 3: Implement** `startHttpFace({ gateway, secret, port })`: bind `127.0.0.1` only; check `x-internal-secret` header (constant-time compare) → 401 on mismatch; otherwise `gateway.send(channelId, formatPayload(payload))`. **Step 4: Run — PASS.** **Step 5: Commit** `feat(discord): loopback /post endpoint with shared secret`.

### Task E3: Sync-server `POST /api/discord/post` (mediator)

**Files:**
- Modify: `server/src/features/discord.ts` — add the route; it resolves outbound bindings (`ctx.storage.discord.listOutbound(room)`) and forwards to the bot at `http://127.0.0.1:${DISCORD_PORT}/post` with the `x-internal-secret` header (`process.env.DISCORD_INTERNAL_SECRET`).
- Test: extend `server/src/discord-api.test.ts` — stub the bot with a tiny `Bun.serve`, set `DISCORD_PORT`/`DISCORD_INTERNAL_SECRET` env to point at it, create an outbound binding, POST `/api/discord/post`, assert the stub received the forwarded payload + secret header.

**Steps:** failing test → run-fail → implement forwarding (fail-soft if the bot is unreachable: log + return `{ ok:false }`, never 500 the caller) → run-pass → commit `feat(server): /api/discord/post mediator → bot`.

### Task E4: Client outbound trigger

**Files:**
- Create: `client/src/discord/postAction.ts` (pure request builder + a thin `fetch`), test the builder; plus a minimal trigger surface.
- **Open ergonomics question (design doc):** chip on the frame vs. widget vs. page control. For v1 implement the **least-committal** option — an overflow bar item "post summary to Discord" mirroring A5's plugin — and leave a `TODO(ergonomics)` pointing at the design doc. Revisit after dogfooding.

**Steps:** test the pure `buildPostBody({ kind, room, data })` → implement → wire a bar item whose `onSelect` gathers the current room + (for `frame-link`) the selected frame's `buildFrameLink(...)` and POSTs `/api/discord/post` → typecheck → manual check → commit `feat(client): outbound "post to Discord" action`.

**Milestone E gate:** formatter + httpFace + mediator tests pass; manual round-trip (click action → embed appears in a bound Discord channel) recorded in the execution log.

---

# Milestone F — Dev-stack + deploy wiring

Now make it run under `bin/dev` and deploy.

### Task F1: Register the service in the dev stack

**Files:**
- Modify: `bin/dev-lib.mjs` — add `discord: 8790` to `PORTS` (`dev-lib.mjs:9-17`; 8790 is free between term 8789 and files 8791) and push a service in `buildServices` (`dev-lib.mjs:236-410`), gated on the token (mirror the livekit gating at `dev-lib.mjs:242-245`):

```js
services.push({
  name: 'discord',
  enabled: Boolean(ctx.env.DISCORD_BOT_TOKEN),
  reason: ctx.env.DISCORD_BOT_TOKEN ? 'token present' : 'no DISCORD_BOT_TOKEN — skipped',
  cmd: "bun run --filter '@ensembleworks/discord' dev",
  health: { kind: 'port', port: PORTS.discord },
})
```

**Do NOT add a Caddy entry** — the bot's `/post` is loopback-only by design; Caddy is the public edge (`deploy/Caddyfile`). The Discord gateway connection is outbound-only.

- Add `discord/package.json` scripts `dev: "bun --watch src/main.ts"` and `start: "bun src/main.ts"`; `main.ts` reads `DISCORD_BOT_TOKEN`, `DISCORD_INTERNAL_SECRET`, `PORT` (default 8790), `SYNC_BASE` (default `http://127.0.0.1:8788`), constructs the real `discord.js`-backed gateway, wires the router + registry (`frame-sticky`) + `startHttpFace`, and connects.

**Step:** `bin/dev status --json 2>/dev/null` shows the `discord` service (disabled without a token). With a token in `~/.config/ensembleworks/dev.env`, `bin/dev up` starts it and `bin/dev logs discord` shows the gateway connect. Commit `feat(dev): register discord service in bin/dev`.

### Task F2: The real `discord.js` gateway adapter

**Files:**
- Create: `discord/src/adapter.discordjs.ts` — implements `Gateway` over `discord.js` `Client` with `GatewayIntentBits.Guilds | GuildMessages | MessageContent`; maps `messageCreate` → `InboundMessage` (`isBot: msg.author.bot`), `send` → `channel.send({ embeds: [embed] })`.

> **Not unit-tested** (it's the network boundary the adapter exists to isolate). Verified manually in F4. Requires the **privileged `MESSAGE_CONTENT` intent** toggled on in the Discord Developer Portal — document this in the README (F3).

**Step:** typecheck; commit `feat(discord): discord.js gateway adapter`.

### Task F3: Deploy units + docs

**Files:**
- Create: `deploy/systemd/ensembleworks-discord.service` and `deploy/systemd/prod/…` (clone the scribe unit; `EnvironmentFile=…/discord.env` holding `DISCORD_BOT_TOKEN` + `DISCORD_INTERNAL_SECRET`).
- Modify: `deploy/deploy.sh` restart list; add `&& … '@ensembleworks/discord' build` to the binary/build path if the bot ships as a compiled artifact (mirror `transcriber` `build:binary`).
- Modify: `README.md` "Development & Deploy" — the Discord app setup (create app, enable `MESSAGE_CONTENT` intent, invite URL with least-privilege scopes), the two secrets, and that `DISCORD_INTERNAL_SECRET` must match between `sync.env` and `discord.env`.
- Modify: `CLAUDE.md` — note the new `discord` workspace (and, while here, fix the stale "three workspaces" line → contracts/client/server/transcriber/cli/discord).

**Step:** `bun run typecheck && bun run build` (root) both green **with** the discord workspace in the chain. Commit `chore(deploy): discord service units + docs`.

### Task F4: Full manual verification (record in execution log)

1. Discord app created, `MESSAGE_CONTENT` intent on, bot invited to a test guild.
2. `dev.env` has `DISCORD_BOT_TOKEN` + `DISCORD_INTERNAL_SECRET`; sync server sees the same `DISCORD_INTERNAL_SECRET` + `DISCORD_PORT`.
3. `bin/dev up`; `bin/dev logs discord` shows a clean gateway connect.
4. **Inbound:** bind `#test` → a frame (UI); post in `#test`; a sticky appears on that frame attributed to the author.
5. **Outbound:** bind the room → `#test` (out); trigger "post summary"; an embed appears in `#test`.
6. **Echo:** confirm the outbound embed does NOT create a sticky (bot-message guard).

---

## Final gate

- `bun run typecheck` and `bun run build` green (all 6 workspaces).
- `bun scripts/run-tests.ts` green (new tests included via the `**/src/**/*.test.ts` glob).
- Manual inbound + outbound + echo round-trips verified (F4).
- Design-doc assumption still holds (single-org); if anything forced multi-tenancy, STOP and revisit.

Use superpowers:requesting-code-review before merging.
```
