# Codespace Shape + Input ACL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Codespace a first-class canvas citizen: gateway registrations carry `repo`/`branch` metadata and an owner-controlled `inputPolicy` (`locked`/`shared`); the relay drops non-owner `input` frames server-side when locked; the owner flips policy over an authenticated, owner-403'd endpoint; and a new legacy-tldraw `codespace` container shape renders repo@branch, a live status dot, owner, and the lock toggle, spawning child terminal shapes parented into it.

**Architecture:** Sub-project 3 of `docs/superpowers/specs/2026-07-21-ew-codespaces-coexistence-design.md` (§4, §5, §6.3, §7), as amended by the **SP3 design decisions** entry in `docs/superpowers/plans/2026-07-21-ew-codespaces-decision-log.md`, which OVERRIDES the spec where they differ:

- **Live state (status/owner/inputPolicy) is NOT synced shape props.** The gateway registry is the single source of truth; the shape polls `GET /api/terminal/list` (~5s while mounted). Shape props carry identity only: `gatewayId`, `repo`, `branch` (decision 2).
- **Defaults:** a registration carrying `repo` is a codespace → `inputPolicy` defaults `locked`; a plain gateway defaults `shared` — today's behavior exactly. Policy is keyed by gatewayId in the registry, survives reconnects within a server lifetime, resets to default on restart (decision 3).
- **Enforcement at the relay splice:** viewer identity resolved via `resolveGatewayOwner` at relay attach; the channels map carries viewer identity; when locked and viewer ≠ owner, `input` frames are dropped at the relay, `resize` still flows, output always flows. No new wire message types; the client derives read-only state from the list poll and disables stdin locally as decoration (decision 4).
- **Container = `BaseBoxShapeUtil` + explicit `parentId` on child creation** (decision 1). Legacy tldraw engine only; canvas-v2 port is parity backlog.

Two deliberate refinements over the decision log's letter (both server-authority-preserving; flag them in review):

1. **The policy endpoint is `POST /api/terminal/input-policy` with `gatewayId` in the body**, not `POST /api/gateway/:id/input-policy`. The tools registry hard-forbids `:param` path segments (`contracts/src/tools/tools.test.ts` — the CLI's generic renderer would ship a literal `:id`), and `server/src/tools-api.test.ts` requires every mounted `/api` route to be a declared tool. Body-addressed POST is also the house pattern (`features/terminal-status.ts`).
2. **`GET /api/terminal/list` stamps `viewerIsOwner` per gateway server-side** instead of the client comparing whoami output. `/api/whoami` returns a *display* identity (`human.name ?? email`) while gateway owners are `sso:<email>` / `token:<common_name>` — a client-side string compare would be wrong for any user with a display name. The list handler resolves the viewer with the same `resolveGatewayOwner` and compares in the one place the owner string exists.

**SP1/SP2 coupling:** SP1's `--backend pty` + `canvasShellSpawnSpec` are already landed in the tree (`cli/src/native/connect.ts` has the flag). SP2 (`ew codespace up`) does NOT exist yet and nothing here depends on it: the server side is loopback-testable with the existing `terminal connect` connector plus the optional `--repo`/`--branch` flags Task 6 adds (SP2 will reuse them).

**Tech Stack:** Bun + TypeScript. Tests are plain `bun <file>` scripts using `node:assert/strict` (no framework; discovered by `scripts/run-tests.ts` glob `**/src/**/*.test.ts`). Client shape/UI components have no DOM-test convention in this repo (client tests are pure-logic only — `grid.test.ts`, `wsUrl.test.ts` style); client component tasks therefore verify via `bun run typecheck` plus a documented manual smoke, stated explicitly per task.

**Branch:** work continues on `docs/ew-codespaces-design` (PR #53) — do NOT create a new branch; commit each task there.

**Interaction contracts:** the codespace shape and lock toggle are legacy-tldraw surfaces, outside both the CI gate's prefixes (`canvas-editor/src/tools/`, `canvas-react/src/`, `client/src/canvas-v2/`) and the contract runners (which drive the canvas-v2 stack). The PR body MUST record, verbatim (decision 5):
`ux-contract: none — legacy tldraw shape; contract runners target the canvas-v2 stack; obligations attach at the v2 port`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `server/src/gateway-registry.ts` | Modify | `GatewayEntry` gains `repo`/`branch`/`inputPolicy`; policy store keyed by gatewayId; channels carry viewer identity; input-drop enforcement in `onBrowserMessage`; connect/relay upgrade wiring parses `repo`/`branch` and resolves viewer; list handler stamps `viewerIsOwner` |
| `server/src/gateway-registry.test.ts` | Modify | Metadata/defaults/persistence + the pure ACL matrix (owner / non-owner / anonymous × locked / shared × input / resize / output) |
| `server/src/gateway-acl.test.ts` | Create | Booted WS integration: real connect with token identities, relay attach per viewer, drop-at-relay proven over the wire |
| `contracts/src/tools/terminal.ts` | Modify | `terminalInputPolicy` tool def; `terminalList` output schema gains the new fields |
| `contracts/src/tools/tools.test.ts` | Modify | Tool count 27 → 28 |
| `server/src/tools-api.test.ts` | Modify | Manifest count 27 → 28 |
| `server/src/features/gateway-input-policy.ts` | Create | `POST /api/terminal/input-policy` — first owner-403 endpoint (`resolveGatewayOwner` on the request headers vs the registry's owner) |
| `server/src/gateway-input-policy.test.ts` | Create | HTTP matrix: 400 / 403 anonymous / 403 non-owner / 404 unknown / 200 owner; live enforcement flip; persistence across reconnect |
| `server/src/app.ts` | Modify | Mount the input-policy router |
| `cli/src/native/connect.ts` | Modify | Optional `--repo` / `--branch` flags on `terminal connect` (default: not sent) |
| `cli/src/native/connect.test.ts` | Modify | Flag default/explicit/wsUrl tests |
| `contracts/src/shapes.ts` | Modify | `codespaceShapeProps` (w, h, gatewayId, repo, branch — identity only) |
| `contracts/src/shapes.test.ts` | Create | Validator smoke for the new props |
| `server/src/schema.ts` | Modify | `codespace` entry in the room schema |
| `client/src/codespace/gatewayView.ts` | Create | Pure list → view derivation + the read-only decision (bun-testable) |
| `client/src/codespace/gatewayPoll.ts` | Create | Refcounted shared ~5s poller of `/api/terminal/list` (factory + app singleton) |
| `client/src/codespace/gatewayView.test.ts` | Create | View derivation + lock decision tests |
| `client/src/codespace/gatewayPoll.test.ts` | Create | Poller lifecycle tests (stubbed fetch, short interval) |
| `client/src/codespace/CodespaceShapeUtil.tsx` | Create | The container shape: header (repo@branch, status dot, owner, lock toggle), `[+ terminal]` child creation with `parentId` |
| `client/src/codespace/createCodespaceShape.ts` | Create | Shape creation from a picked gateway |
| `client/src/codespace/openNewCodespace.tsx` | Create | Gateway-picker dialog (codespace gateways = entries with `repo`) |
| `client/src/codespace/plugin.ts` | Create | Plugin: shape util + icon + overflow bar item |
| `client/src/plugins.ts` | Modify | Register `codespacePlugin` |
| `client/src/terminal/TerminalShapeUtil.tsx` | Modify | Local stdin gate + read-only chip for gateway-backed terminals (decoration; server is authority) |

---

### Task 1: Registry metadata — repo/branch/inputPolicy, defaults, persistence, list()

**Files:**
- Modify: `server/src/gateway-registry.ts` (`GatewayEntry` at lines 39-47, `connect()` at 67-86, `list()` at 104-112)
- Test: `server/src/gateway-registry.test.ts` (append before the final `console.log`)

- [ ] **Step 1: Write the failing test**

Append to `server/src/gateway-registry.test.ts`, inside `main()`, after the `ok: gateway owner binding` block and before the final `console.log`:

```ts
	// --- codespace metadata + input-policy defaults/persistence (SP3) ---
	{
		const reg3 = new GatewayRegistry()
		// A registration carrying repo metadata is a codespace → defaults locked.
		const cs = reg3.connect('cs1', 'CS', fakeSocket(), 'token:a', {
			repo: 'github.com/acme/app',
			branch: 'main',
		})
		assert.ok(cs, 'codespace registers')
		assert.equal(cs.repo, 'github.com/acme/app')
		assert.equal(cs.branch, 'main')
		assert.equal(cs.inputPolicy, 'locked', 'repo metadata → default locked')
		// A plain gateway (no repo) defaults shared — today's behavior exactly.
		const plain = reg3.connect('plain1', 'Box', fakeSocket(), 'token:a')
		assert.ok(plain)
		assert.equal(plain.repo, undefined)
		assert.equal(plain.inputPolicy, 'shared', 'plain gateway → default shared')

		// list() exposes the metadata + the owner identity.
		const listed = Object.fromEntries(reg3.list().map((g) => [g.gatewayId, g]))
		assert.equal(listed.cs1!.repo, 'github.com/acme/app')
		assert.equal(listed.cs1!.branch, 'main')
		assert.equal(listed.cs1!.inputPolicy, 'locked')
		assert.equal(listed.cs1!.owner, 'token:a')
		assert.equal(listed.plain1!.inputPolicy, 'shared')
		assert.equal(listed.plain1!.repo, undefined)

		// setInputPolicy flips a live gateway; unknown id → false.
		assert.equal(reg3.setInputPolicy('cs1', 'shared'), true)
		assert.equal(reg3.get('cs1')!.inputPolicy, 'shared')
		assert.equal(reg3.setInputPolicy('nope', 'locked'), false)

		// Policy survives a same-owner reconnect within the server lifetime —
		// the remembered value beats the repo-derived default (decision log 3).
		const csWs2 = fakeSocket()
		const cs2 = reg3.connect('cs1', 'CS', csWs2, 'token:a', {
			repo: 'github.com/acme/app',
			branch: 'main',
		})
		assert.ok(cs2)
		assert.equal(cs2.inputPolicy, 'shared', 'remembered policy survives reconnect')
		// …and survives a full disconnect + fresh connect too (keyed by gatewayId,
		// not by the live entry).
		reg3.disconnect('cs1', csWs2)
		const cs3 = reg3.connect('cs1', 'CS', fakeSocket(), 'token:a', {
			repo: 'github.com/acme/app',
		})
		assert.ok(cs3)
		assert.equal(cs3.inputPolicy, 'shared', 'policy keyed by gatewayId outlives the entry')
		console.log('ok: codespace metadata + input-policy defaults/persistence')
	}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun server/src/gateway-registry.test.ts`
Expected: FAIL — TypeScript/runtime error: `connect` takes 4 arguments (5 given), `repo`/`inputPolicy`/`setInputPolicy` do not exist.

- [ ] **Step 3: Implement**

In `server/src/gateway-registry.ts`:

Add after the `RelaySocket` interface (before `GatewayEntry`):

```ts
export type GatewayInputPolicy = 'locked' | 'shared'

/** Codespace metadata riding the registration (EW Codespaces spec §4). */
export interface GatewayMeta {
	repo?: string
	branch?: string
}
```

Replace the `GatewayEntry` interface:

```ts
export interface GatewayEntry {
	gatewayId: string
	label: string
	ws: RelaySocket
	ownerIdentity: string
	connectedAt: number
	// Codespace metadata (spec §4): present iff the registration carried it.
	repo?: string
	branch?: string
	// Owner-controlled input ACL. Default: locked for codespaces (repo present),
	// shared for plain gateways — preserving pre-SP3 behavior exactly.
	inputPolicy: GatewayInputPolicy
	channels: Map<number, RelaySocket>
	nextChannelId: number
}
```

(Channels stay `Map<number, RelaySocket>` in this task; Task 2 upgrades them to carry viewer identity.)

In `GatewayRegistry`, add a field under `private gateways`:

```ts
	// Input policy keyed by gatewayId — survives reconnects AND disconnects
	// within a server lifetime; resets to the repo-derived default on restart
	// (safe direction: a codespace resets to locked). Decision log, SP3 item 3.
	private policies = new Map<string, GatewayInputPolicy>()
```

Widen `connect()` (signature + entry construction; the replace/reject logic is unchanged):

```ts
	connect(
		gatewayId: string,
		label: string,
		ws: RelaySocket,
		ownerIdentity: string,
		meta: GatewayMeta = {}
	): GatewayEntry | null {
		const existing = this.gateways.get(gatewayId)
		if (existing && existing.ownerIdentity !== ownerIdentity) return null
		if (existing) {
			for (const browser of existing.channels.values()) browser.close()
			existing.channels.clear()
			existing.ws.close()
		}
		const entry: GatewayEntry = {
			gatewayId,
			label,
			ws,
			ownerIdentity,
			connectedAt: Date.now(),
			repo: meta.repo,
			branch: meta.branch,
			inputPolicy: this.policies.get(gatewayId) ?? (meta.repo ? 'locked' : 'shared'),
			channels: new Map(),
			nextChannelId: 1,
		}
		this.gateways.set(gatewayId, entry)
		return entry
	}
```

Add after `get()`:

```ts
	/** Owner-authorised policy flip (the HTTP endpoint enforces WHO may call
	 * this; the registry just records it). False when the gateway is offline. */
	setInputPolicy(gatewayId: string, policy: GatewayInputPolicy): boolean {
		const entry = this.gateways.get(gatewayId)
		if (!entry) return false
		entry.inputPolicy = policy
		this.policies.set(gatewayId, policy)
		return true
	}
```

Replace `list()`:

```ts
	// Field names match distributed-terminals-design.md's envelope so the
	// dropdown survives the upgrade to the full design. repo/branch/inputPolicy/
	// owner are the SP3 codespace fields — live state deliberately lives HERE,
	// not in synced shape props (decision log, SP3 item 2).
	list(): Array<{
		gatewayId: string
		label: string
		relayOnly: true
		connectedAt: number
		repo?: string
		branch?: string
		inputPolicy: GatewayInputPolicy
		owner: string
	}> {
		return [...this.gateways.values()].map((e) => ({
			gatewayId: e.gatewayId,
			label: e.label,
			relayOnly: true,
			connectedAt: e.connectedAt,
			repo: e.repo,
			branch: e.branch,
			inputPolicy: e.inputPolicy,
			owner: e.ownerIdentity,
		}))
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun server/src/gateway-registry.test.ts`
Expected: PASS — all existing assertions plus `ok: codespace metadata + input-policy defaults/persistence`.

- [ ] **Step 5: Commit**

```bash
git add server/src/gateway-registry.ts server/src/gateway-registry.test.ts
git commit -m "feat(server): gateway registry carries repo/branch + owner input policy (locked default for codespaces)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Channel viewer identity + input-drop enforcement (pure ACL matrix)

The channels map gains the viewer's identity per channel; `onBrowserMessage` drops `input` frames when the gateway is locked and the channel's viewer is not the owner. `resize` (and any other type) still forwards; output (`onGatewayFrame`) is untouched by policy.

**Files:**
- Modify: `server/src/gateway-registry.ts` (channels type, `openChannel`, `onBrowserMessage`, `onGatewayFrame`, `connect`/`disconnect` close loops)
- Test: `server/src/gateway-registry.test.ts` (update existing `openChannel` call sites; append the ACL matrix)

- [ ] **Step 1: Write the failing test**

In `server/src/gateway-registry.test.ts`, first update every existing `openChannel(...)` call to pass the owner as the viewer (behavior-preserving — the existing assertions must keep passing). There are six call sites; each gains a final argument:

```ts
	const ch1 = openChannel(entry1, browser1, 'sess1', 80, 24, 'token:a')
	// …
	const ch2 = openChannel(entry1, fakeSocket(), 'sess1', 80, 24, 'token:a')
	// …
	const ch3 = openChannel(entry1, slow, 'sess1', 80, 24, 'token:a')
	// …
	const ch4 = openChannel(entry1, browser4, 'sess1', 80, 24, 'token:a')
	// …
	openChannel(entry1, browser5, 'sess1', 80, 24, 'token:a')
	// … (inside the owner-binding block)
	openChannel(a, browser, 's1', 80, 24, 'token:a')
```

Then append, after the Task 1 block and before the final `console.log`:

```ts
	// --- input ACL matrix at the relay (SP3, decision log item 4) ---
	// owner / non-owner / anonymous(null) × locked / shared × input / resize,
	// plus: output always flows. Enforcement is HERE, server-side — client
	// badges are decoration.
	{
		const reg4 = new GatewayRegistry()
		const gwSock = fakeSocket()
		const entry = reg4.connect('cs1', 'CS', gwSock, 'sso:owner@acme.dev', {
			repo: 'github.com/acme/app',
		})!
		assert.equal(entry.inputPolicy, 'locked')

		const owner = fakeSocket()
		const guest = fakeSocket()
		const anon = fakeSocket()
		const chOwner = openChannel(entry, owner, 's1', 80, 24, 'sso:owner@acme.dev')
		const chGuest = openChannel(entry, guest, 's1', 80, 24, 'sso:guest@acme.dev')
		const chAnon = openChannel(entry, anon, 's1', 80, 24, null)

		const input = JSON.stringify({ type: 'input', data: 'x' })
		const resize = JSON.stringify({ type: 'resize', cols: 100, rows: 30 })
		const framesTo = (ch: number) =>
			gwSock.sent
				.map((s) => JSON.parse(String(s.data)))
				.filter((m) => m.type === 'relay-msg' && m.channelId === ch)
				.map((m) => m.msg.type)

		// locked: owner input forwarded; non-owner + anonymous input DROPPED;
		// resize forwarded for everyone (grid stays deterministic for viewers).
		onBrowserMessage(entry, chOwner, input)
		onBrowserMessage(entry, chGuest, input)
		onBrowserMessage(entry, chAnon, input)
		onBrowserMessage(entry, chOwner, resize)
		onBrowserMessage(entry, chGuest, resize)
		onBrowserMessage(entry, chAnon, resize)
		assert.deepEqual(framesTo(chOwner), ['input', 'resize'], 'locked: owner input + resize forwarded')
		assert.deepEqual(framesTo(chGuest), ['resize'], 'locked: non-owner input dropped, resize forwarded')
		assert.deepEqual(framesTo(chAnon), ['resize'], 'locked: anonymous input dropped, resize forwarded')

		// Output always flows, policy-independent — non-owner still SEES the pty.
		onGatewayFrame(entry, encodeBinaryFrame(chGuest, Buffer.from('out')), true)
		const guestBin = guest.sent.at(-1)!
		assert.equal(guestBin.binary, true)
		assert.equal(guestBin.data.toString(), 'out', 'locked: output still reaches the non-owner')

		// shared: everyone's input forwarded (legacy behavior — and the ensemble
		// "hand over the keyboard" state).
		reg4.setInputPolicy('cs1', 'shared')
		onBrowserMessage(entry, chGuest, input)
		onBrowserMessage(entry, chAnon, input)
		assert.deepEqual(framesTo(chGuest), ['resize', 'input'], 'shared: non-owner input forwarded')
		assert.deepEqual(framesTo(chAnon), ['resize', 'input'], 'shared: anonymous input forwarded')

		// Unknown channel: dropped silently (no throw, nothing forwarded).
		const before = gwSock.sent.length
		onBrowserMessage(entry, 999, input)
		assert.equal(gwSock.sent.length, before, 'unknown channel is dropped')
		console.log('ok: relay input ACL matrix')
	}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun server/src/gateway-registry.test.ts`
Expected: FAIL — `openChannel` does not accept a 6th argument, and (once it does) the locked-guest `input` frame is still forwarded: `AssertionError` on `framesTo(chGuest)` deep-equal `['resize']` getting `['input', 'resize']`.

- [ ] **Step 3: Implement**

In `server/src/gateway-registry.ts`:

Add after `GatewayMeta`:

```ts
/** A spliced browser channel: the socket plus the viewer identity resolved at
 * relay attach (null = no resolvable identity → treated as non-owner). */
export interface RelayChannel {
	socket: RelaySocket
	viewer: string | null
}
```

In `GatewayEntry`, change the channels field:

```ts
	channels: Map<number, RelayChannel>
```

In `connect()` and `disconnect()`, the close loops become:

```ts
			for (const ch of existing.channels.values()) ch.socket.close()
```

```ts
		for (const ch of entry.channels.values()) ch.socket.close()
```

`openChannel` gains the viewer:

```ts
export function openChannel(
	entry: GatewayEntry,
	browser: RelaySocket,
	sessionId: string,
	cols: number,
	rows: number,
	viewer: string | null
): number {
	const channelId = entry.nextChannelId++
	entry.channels.set(channelId, { socket: browser, viewer })
	entry.ws.send(JSON.stringify({ type: 'relay-open', channelId, sessionId, cols, rows }))
	return channelId
}
```

`onBrowserMessage` becomes the enforcement point:

```ts
/** Browser → gateway: wrap the inner text message (input/resize) as relay-msg.
 * THE input-ACL enforcement point (spec §4): when the gateway is locked and the
 * channel's viewer is not the owner, `input` frames are dropped HERE — output
 * and resize still flow, and client-side read-only badges are decoration only. */
export function onBrowserMessage(entry: GatewayEntry, channelId: number, raw: string): void {
	let msg: unknown
	try {
		msg = JSON.parse(raw)
	} catch {
		return
	}
	const channel = entry.channels.get(channelId)
	if (!channel) return
	if ((msg as { type?: unknown }).type === 'input' && entry.inputPolicy === 'locked') {
		const isOwner = channel.viewer !== null && channel.viewer === entry.ownerIdentity
		if (!isOwner) return // dropped at the relay — the server is the authority
	}
	if (entry.ws.readyState === WS_OPEN) {
		entry.ws.send(JSON.stringify({ type: 'relay-msg', channelId, msg }))
	}
}
```

`onGatewayFrame` reads through the new channel shape (three spots):

```ts
		const channel = entry.channels.get(decoded.channelId)
		if (!channel || channel.socket.readyState !== WS_OPEN) return
		if (channel.socket.bufferedAmount > BROWSER_BUFFER_LIMIT) {
			entry.channels.delete(decoded.channelId)
			channel.socket.close()
			return
		}
		channel.socket.send(decoded.payload, { binary: true })
		return
```

and below:

```ts
	const channel = entry.channels.get(msg.channelId)
	if (msg.type === 'relay-msg') {
		if (channel && channel.socket.readyState === WS_OPEN) channel.socket.send(JSON.stringify(msg.msg))
	} else if (msg.type === 'relay-closed') {
		entry.channels.delete(msg.channelId)
		channel?.socket.close()
	}
```

Finally, `handleUpgrade`'s relay branch has one `openChannel` call site — pass `null` for now (Task 3 resolves the real viewer):

```ts
					const channelId = openChannel(entry, ws, sessionId, cols, rows, null)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun server/src/gateway-registry.test.ts && bun server/src/gateway-identity.test.ts`
Expected: both PASS (identity test proves the WS wiring still compiles/behaves; every browser is `null`-viewer until Task 3, which only matters for locked gateways — none exist in that test).

- [ ] **Step 5: Commit**

```bash
git add server/src/gateway-registry.ts server/src/gateway-registry.test.ts
git commit -m "feat(server): relay channels carry viewer identity; locked gateways drop non-owner input at the splice

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Upgrade + list wiring — repo/branch params, viewer resolution at relay attach, viewerIsOwner

**Files:**
- Modify: `server/src/gateway-registry.ts` (`handleUpgrade` connect + relay branches, `listHandler`)
- Modify: `contracts/src/tools/terminal.ts` (`terminalList` zodOutput gains the new fields)
- Create: `server/src/gateway-acl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/gateway-acl.test.ts`:

```ts
// Booted WS integration for the SP3 input ACL (spec §4 / §7): real
// /api/terminal/connect registrations under service-token identities, real
// /api/terminal/relay attaches per viewer, and proof over the wire that a
// locked gateway drops non-owner input AT THE RELAY while resize and output
// still flow — and that a plain (no-repo) gateway keeps today's shared
// behavior. Also pins GET /api/terminal/list's new fields incl. the
// server-stamped viewerIsOwner. Ordering trick: a ws connection delivers
// frames in order, so "send input, then resize; observe resize arrive" proves
// the input was dropped, not merely late. Network-free of tmux/pty — the
// "connector" is a bare recording ws. Run with: bun src/gateway-acl.test.ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = await mkdtemp(path.join(os.tmpdir(), 'gw-acl-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(
	mapFile,
	[
		'[tokens."a.access"]',
		'identity = "🤖 A"',
		'scope = "read-write"',
		'[tokens."b.access"]',
		'identity = "🤖 B"',
		'scope = "read-write"',
	].join('\n') + '\n',
)
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
const authHeaders = (token?: string) =>
	token ? { 'cf-access-jwt-assertion': jwt({ common_name: token }) } : {}

const openWs = (url: string, token?: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url, { headers: authHeaders(token) })
		ws.once('open', () => resolve(ws))
		ws.on('error', reject)
	})

/** Recording "connector": collects every text frame the relay forwards. */
function recordFrames(ws: WebSocket): Array<{ type: string; channelId?: number; msg?: { type?: string } }> {
	const frames: Array<{ type: string; channelId?: number; msg?: { type?: string } }> = []
	ws.on('message', (data, isBinary) => {
		if (!isBinary) frames.push(JSON.parse(data.toString()))
	})
	return frames
}

const until = async <T>(what: string, poll: () => T | undefined, timeoutMs = 5000): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const v = poll()
		if (v !== undefined) return v
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error(`timeout waiting for ${what}`)
}

const inputsFor = (frames: ReturnType<typeof recordFrames>, ch: number) =>
	frames.filter((f) => f.type === 'relay-msg' && f.channelId === ch && f.msg?.type === 'input')
const resizesFor = (frames: ReturnType<typeof recordFrames>, ch: number) =>
	frames.filter((f) => f.type === 'relay-msg' && f.channelId === ch && f.msg?.type === 'resize')

async function main() {
	const { server } = createSyncApp({ dataDir: dir })
	await new Promise<void>((r) => server.listen(0, r))
	const port = (server.address() as { port: number }).port
	const base = `http://127.0.0.1:${port}`
	const wsBase = `ws://127.0.0.1:${port}`

	// Codespace gateway: owner is bot A, repo metadata → locked by default.
	const repo = encodeURIComponent('github.com/acme/app')
	const gw = await openWs(
		`${wsBase}/api/terminal/connect?gatewayId=cs1&label=CS&repo=${repo}&branch=main`,
		'a.access',
	)
	const gwFrames = recordFrames(gw)

	// Plain gateway (no repo) by the same owner → shared, legacy behavior.
	const plain = await openWs(`${wsBase}/api/terminal/connect?gatewayId=plain1&label=Box`, 'a.access')
	const plainFrames = recordFrames(plain)

	// --- list(): new fields + server-stamped viewerIsOwner -------------------
	const listAs = async (token?: string) => {
		const res = await fetch(`${base}/api/terminal/list`, { headers: authHeaders(token) })
		assert.equal(res.status, 200)
		const body = (await res.json()) as { gateways: Array<Record<string, unknown>> }
		return Object.fromEntries(body.gateways.map((g) => [g.gatewayId as string, g]))
	}
	const anonList = await listAs()
	assert.equal(anonList.cs1!.repo, 'github.com/acme/app')
	assert.equal(anonList.cs1!.branch, 'main')
	assert.equal(anonList.cs1!.inputPolicy, 'locked')
	assert.equal(anonList.cs1!.owner, 'token:a.access')
	assert.equal(anonList.cs1!.viewerIsOwner, false, 'anonymous (dev) viewer is not the owner')
	assert.equal(anonList.plain1!.inputPolicy, 'shared')
	assert.equal(anonList.plain1!.repo, undefined)
	const ownerList = await listAs('a.access')
	assert.equal(ownerList.cs1!.viewerIsOwner, true, 'owner sees viewerIsOwner true')
	assert.equal((await listAs('b.access')).cs1!.viewerIsOwner, false)

	// --- locked codespace: owner types, non-owner is read-only ---------------
	const relay = (gateway: string, session: string) =>
		`${wsBase}/api/terminal/relay?session=${session}&gateway=${gateway}&cols=80&rows=24`

	const ownerB = await openWs(relay('cs1', 's1'), 'a.access')
	const chOwner = (await until('owner relay-open', () =>
		gwFrames.find((f) => f.type === 'relay-open'),
	)).channelId!
	ownerB.send(JSON.stringify({ type: 'input', data: 'owner-types\r' }))
	await until('owner input forwarded', () => inputsFor(gwFrames, chOwner)[0])

	const guestB = await openWs(relay('cs1', 's1'), 'b.access')
	const chGuest = (await until('guest relay-open', () =>
		gwFrames.filter((f) => f.type === 'relay-open')[1],
	)).channelId!
	guestB.send(JSON.stringify({ type: 'input', data: 'guest-types\r' }))
	guestB.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
	await until('guest resize forwarded', () => resizesFor(gwFrames, chGuest)[0])
	// The resize (sent AFTER the input, same ordered ws) arrived — so the input
	// was dropped at the relay, not delayed.
	assert.equal(inputsFor(gwFrames, chGuest).length, 0, 'locked: non-owner input dropped at the relay')

	// Output still flows to the read-only viewer.
	const guestSaw = new Promise<string>((resolve) => {
		guestB.on('message', (data, isBinary) => {
			if (isBinary) resolve((data as Buffer).toString())
		})
	})
	const prefix = Buffer.allocUnsafe(4)
	prefix.writeUInt32BE(chGuest, 0)
	gw.send(Buffer.concat([prefix, Buffer.from('pty-output')]), { binary: true })
	assert.equal(await guestSaw, 'pty-output', 'locked: output still reaches the non-owner')

	// Anonymous viewer (dev identity ≠ token owner): also read-only.
	const anonB = await openWs(relay('cs1', 's1'))
	const chAnon = (await until('anon relay-open', () =>
		gwFrames.filter((f) => f.type === 'relay-open')[2],
	)).channelId!
	anonB.send(JSON.stringify({ type: 'input', data: 'anon-types\r' }))
	anonB.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }))
	await until('anon resize forwarded', () => resizesFor(gwFrames, chAnon)[0])
	assert.equal(inputsFor(gwFrames, chAnon).length, 0, 'locked: anonymous input dropped')

	// --- plain gateway: unchanged — everyone's input flows -------------------
	const plainB = await openWs(relay('plain1', 's2'), 'b.access')
	const chPlain = (await until('plain relay-open', () =>
		plainFrames.find((f) => f.type === 'relay-open'),
	)).channelId!
	plainB.send(JSON.stringify({ type: 'input', data: 'still-shared\r' }))
	await until('plain non-owner input forwarded', () => inputsFor(plainFrames, chPlain)[0])

	for (const ws of [ownerB, guestB, anonB, plainB, gw, plain]) ws.close()
	server.close()
	console.log('gateway-acl.test.ts: all assertions passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun server/src/gateway-acl.test.ts`
Expected: FAIL — first at `anonList.cs1!.repo` being `undefined` (the connect branch does not parse `repo` yet) or at `viewerIsOwner` being `undefined` (list not stamping). If it instead fails on the drop assertion, viewer resolution at relay attach is what's missing.

- [ ] **Step 3: Implement**

In `server/src/gateway-registry.ts`:

Extend the connect branch of `handleUpgrade` — after the `label` line, parse the metadata (empty string → absent; capped like `label`):

```ts
					const label = (url.searchParams.get('label') || gatewayId).slice(0, 64)
					// Codespace metadata (SP3): free-text, capped; absence keeps the
					// gateway on the plain/shared path (decision log item 3).
					const repo = (url.searchParams.get('repo') || '').slice(0, 128) || undefined
					const branch = (url.searchParams.get('branch') || '').slice(0, 128) || undefined
```

and pass them to `connect`:

```ts
							const entry = registry.connect(gatewayId, label, ws, owner, { repo, branch })
```

Rewrite the relay branch to resolve the VIEWER's identity from the same upgrade headers before splicing (the seam recon identified — this branch previously did zero identity resolution). Mirror the connect branch's async IIFE + fail-closed shape:

```ts
				if (url.pathname === '/api/terminal/relay') {
					const sessionId = url.searchParams.get('session') ?? ''
					const gatewayId = url.searchParams.get('gateway') ?? ''
					const cols = Number(url.searchParams.get('cols') ?? 80) || 80
					const rows = Number(url.searchParams.get('rows') ?? 24) || 24
					const entry = registry.get(gatewayId)
					if (!ID_RE.test(sessionId) || !entry || entry.ws.readyState !== WS_OPEN) {
						socket.destroy() // offline gateway → immediate destroy (client backoff handles it)
						return true
					}
					void (async () => {
						try {
							// Viewer identity for the input ACL (spec §4). null is NOT a
							// rejection here — an unidentified viewer attaches read-only on
							// locked gateways; output always flows.
							const viewer = await resolveGatewayOwner(req.headers).catch(() => null)
							const ws = await accept(req, socket, head)
							if (entry.ws.readyState !== WS_OPEN) {
								// Gateway dropped while we resolved identity.
								ws.close()
								return
							}
							const channelId = openChannel(entry, ws, sessionId, cols, rows, viewer)
							ws.on('message', (raw, isBinary) => {
								if (isBinary) return // browsers never send binary (matches terminal-gateway.ts)
								onBrowserMessage(entry, channelId, raw.toString())
							})
							ws.on('close', () => closeChannel(entry, channelId))
						} catch (err) {
							console.warn(`[relay ${gatewayId}] attach failed:`, err)
							socket.destroy()
						}
					})()
					return true
				}
```

Replace `listHandler` (the viewer is resolved once per request and compared against each entry's owner — the ONE place both strings exist in the same format):

```ts
			async listHandler(req: { headers: IncomingHttpHeaders }, res: { json(body: unknown): void }) {
				const viewer = await resolveGatewayOwner(req.headers).catch(() => null)
				res.json({
					gateways: registry.list().map((g) => ({
						...g,
						viewerIsOwner: viewer !== null && viewer === g.owner,
					})),
				})
			},
```

Add the header-type import at the top of the file:

```ts
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
```

(replacing the existing `import type { IncomingMessage } from 'node:http'`).

In `contracts/src/tools/terminal.ts`, update `terminalList`'s zodOutput to declare the new fields:

```ts
export const terminalList: ToolDef = {
	plugin: 'terminal',
	id: 'list',
	http: { method: 'GET', path: '/api/terminal/list' },
	help: 'List registered remote terminal gateways (codespaces carry repo/branch/inputPolicy).',
	zodInput: z.object({}),
	zodOutput: z.object({
		gateways: z.array(z.object({
			gatewayId: z.string(),
			label: z.string(),
			relayOnly: z.literal(true),
			connectedAt: z.number(),
			repo: z.string().optional(),
			branch: z.string().optional(),
			inputPolicy: z.enum(['locked', 'shared']),
			owner: z.string(),
			viewerIsOwner: z.boolean(),
		})),
	}),
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun server/src/gateway-acl.test.ts && bun server/src/gateway-identity.test.ts && bun server/src/gateway-plane.test.ts && bun contracts/src/tools/tools.test.ts`
Expected: all PASS (tool count is still 27 — the new def lands in Task 4).

- [ ] **Step 5: Commit**

```bash
git add server/src/gateway-registry.ts server/src/gateway-acl.test.ts contracts/src/tools/terminal.ts
git commit -m "feat(server): relay attach resolves viewer identity; connect carries repo/branch; list stamps viewerIsOwner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/terminal/input-policy` — the owner-403 endpoint

**Files:**
- Modify: `contracts/src/tools/terminal.ts` (new tool def), `contracts/src/tools/tools.test.ts` (count 27→28), `server/src/tools-api.test.ts` (count 27→28)
- Create: `server/src/features/gateway-input-policy.ts`
- Modify: `server/src/app.ts` (mount)
- Create: `server/src/gateway-input-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/gateway-input-policy.test.ts`:

```ts
// POST /api/terminal/input-policy — the first owner-match-or-403 endpoint
// (spec §4 "Toggle"): the owner flips a gateway's input policy; anyone else
// (including dev-anonymous) is 403'd; unknown gateway 404; bad body 400. The
// flip is live (a previously dropped non-owner input flows after unlock) and
// remembered across a reconnect within the server lifetime (decision log 3).
// Identity via fake CF Access service-token JWTs (gateway-identity.test.ts
// pattern). Run with: bun src/gateway-input-policy.test.ts
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { createSyncApp } from './app.ts'

delete process.env.CF_ACCESS_TEAM_DOMAIN
delete process.env.CF_ACCESS_AUD
delete process.env.EW_DEV_IDENTITY_EMAIL

const dir = await mkdtemp(path.join(os.tmpdir(), 'gw-policy-'))
const mapFile = path.join(dir, 'service-tokens.toml')
writeFileSync(
	mapFile,
	[
		'[tokens."a.access"]',
		'identity = "🤖 A"',
		'scope = "read-write"',
		'[tokens."b.access"]',
		'identity = "🤖 B"',
		'scope = "read-write"',
	].join('\n') + '\n',
)
process.env.EW_SERVICE_TOKENS_FILE = mapFile

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(payload)}.`
const authHeaders = (token?: string): Record<string, string> =>
	token ? { 'cf-access-jwt-assertion': jwt({ common_name: token }) } : {}

const openWs = (url: string, token?: string) =>
	new Promise<WebSocket>((resolve, reject) => {
		const ws = new WebSocket(url, { headers: authHeaders(token) })
		ws.once('open', () => resolve(ws))
		ws.on('error', reject)
	})

const until = async <T>(what: string, poll: () => T | undefined, timeoutMs = 5000): Promise<T> => {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const v = poll()
		if (v !== undefined) return v
		await new Promise((r) => setTimeout(r, 25))
	}
	throw new Error(`timeout waiting for ${what}`)
}

async function main() {
	const { server } = createSyncApp({ dataDir: dir })
	await new Promise<void>((r) => server.listen(0, r))
	const port = (server.address() as { port: number }).port
	const base = `http://127.0.0.1:${port}`
	const wsBase = `ws://127.0.0.1:${port}`

	const post = async (body: unknown, token?: string) =>
		fetch(`${base}/api/terminal/input-policy`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...authHeaders(token) },
			body: JSON.stringify(body),
		})
	const policyOf = async (id: string) => {
		const res = await fetch(`${base}/api/terminal/list`)
		const body = (await res.json()) as { gateways: Array<{ gatewayId: string; inputPolicy: string }> }
		return body.gateways.find((g) => g.gatewayId === id)?.inputPolicy
	}

	// Owner A registers a locked codespace; a recording ws stands in for the connector.
	const repo = encodeURIComponent('github.com/acme/app')
	const gw = await openWs(`${wsBase}/api/terminal/connect?gatewayId=cs1&label=CS&repo=${repo}`, 'a.access')
	const gwFrames: Array<{ type: string; channelId?: number; msg?: { type?: string } }> = []
	gw.on('message', (data, isBinary) => {
		if (!isBinary) gwFrames.push(JSON.parse(data.toString()))
	})
	assert.equal(await policyOf('cs1'), 'locked')

	// Validation + authz matrix.
	assert.equal((await post({ policy: 'shared' }, 'a.access')).status, 400, 'missing gatewayId → 400')
	assert.equal((await post({ gatewayId: 'cs1', policy: 'open' }, 'a.access')).status, 400, 'bad policy → 400')
	assert.equal((await post({ gatewayId: 'nope', policy: 'shared' }, 'a.access')).status, 404, 'unknown gateway → 404')
	assert.equal((await post({ gatewayId: 'cs1', policy: 'shared' })).status, 403, 'anonymous (dev) → 403')
	assert.equal((await post({ gatewayId: 'cs1', policy: 'shared' }, 'b.access')).status, 403, 'non-owner → 403')
	assert.equal(await policyOf('cs1'), 'locked', 'rejected calls change nothing')

	// Owner flips to shared → 200, visible in list, and LIVE at the relay:
	// guest input that was dropped now flows.
	const guest = await openWs(`${wsBase}/api/terminal/relay?session=s1&gateway=cs1&cols=80&rows=24`, 'b.access')
	const chGuest = (await until('relay-open', () => gwFrames.find((f) => f.type === 'relay-open'))).channelId!
	guest.send(JSON.stringify({ type: 'input', data: 'locked-out\r' }))
	guest.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
	await until('resize (drop barrier)', () =>
		gwFrames.find((f) => f.type === 'relay-msg' && f.channelId === chGuest && f.msg?.type === 'resize'),
	)
	assert.equal(
		gwFrames.filter((f) => f.type === 'relay-msg' && f.channelId === chGuest && f.msg?.type === 'input').length,
		0,
		'locked: guest input dropped before the flip',
	)

	const ok = await post({ gatewayId: 'cs1', policy: 'shared' }, 'a.access')
	assert.equal(ok.status, 200, 'owner flip → 200')
	assert.deepEqual(await ok.json(), { ok: true, gatewayId: 'cs1', policy: 'shared' })
	assert.equal(await policyOf('cs1'), 'shared')

	guest.send(JSON.stringify({ type: 'input', data: 'now-shared\r' }))
	await until('guest input flows after unlock', () =>
		gwFrames.find((f) => f.type === 'relay-msg' && f.channelId === chGuest && f.msg?.type === 'input'),
	)

	// Persistence across reconnect: the remembered 'shared' beats the
	// repo-derived 'locked' default when the same owner reconnects.
	gw.close()
	await new Promise((r) => setTimeout(r, 100))
	const gw2 = await openWs(`${wsBase}/api/terminal/connect?gatewayId=cs1&label=CS&repo=${repo}`, 'a.access')
	assert.equal(await policyOf('cs1'), 'shared', 'policy survives reconnect within server lifetime')

	guest.close()
	gw2.close()
	server.close()
	console.log('gateway-input-policy.test.ts: all assertions passed')
	process.exit(0)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun server/src/gateway-input-policy.test.ts`
Expected: FAIL — the first `post(...)` returns **404** (route not mounted), tripping the `missing gatewayId → 400` assertion.

- [ ] **Step 3: Implement**

In `contracts/src/tools/terminal.ts`, add after `terminalList`:

```ts
export const terminalInputPolicy: ToolDef = {
	plugin: 'terminal',
	id: 'input-policy',
	http: { method: 'POST', path: '/api/terminal/input-policy' },
	help: 'Set a gateway input policy (owner only): locked (viewers read-only) or shared.',
	zodInput: z.object({
		gatewayId: z.string().min(1).describe('registered gateway id (required)'),
		policy: z.enum(['locked', 'shared']),
	}),
	zodOutput: z.object({
		ok: z.literal(true),
		gatewayId: z.string(),
		policy: z.enum(['locked', 'shared']),
	}),
}

export const terminalTools: ToolDef[] = [terminalStatus, terminalList, terminalInputPolicy]
```

(the `terminalTools` line REPLACES the existing one.)

In `contracts/src/tools/tools.test.ts`, bump both counts and comments:

- `assert.equal(allTools.length, 27, 'expected 27 tool defs (17 base + 5 canvas-v2 + 5 discord)')` → `assert.equal(allTools.length, 28, 'expected 28 tool defs (18 base + 5 canvas-v2 + 5 discord)')`
- `assert.equal(manifest.tools.length, 27, 'manifest.tools length')` → `assert.equal(manifest.tools.length, 28, 'manifest.tools length')`
- final `console.log('ok: tool registry — 27 defs, …')` → `console.log('ok: tool registry — 28 defs, unique ids/paths, all schemas serialise')`

In `server/src/tools-api.test.ts`:

- `assert.equal(manifest.tools.length, 27, 'manifest declares 27 tools (17 base + 5 canvas-v2 + 5 discord)')` → `assert.equal(manifest.tools.length, 28, 'manifest declares 28 tools (18 base + 5 canvas-v2 + 5 discord)')`

Create `server/src/features/gateway-input-policy.ts`:

```ts
/**
 * Owner-controlled input-policy toggle — POST /api/terminal/input-policy flips
 * a registered gateway between 'locked' (non-owner input dropped at the relay)
 * and 'shared' (the ensemble "hand over the keyboard" move). The FIRST
 * owner-match-or-403 endpoint: the caller's identity is resolved with the same
 * resolveGatewayOwner used at gateway registration, so the two strings compare
 * in the same sso:<email> / token:<common_name> format. Pure relay-plane
 * state — the connector is not involved (spec §4). Unlike the ctx-taking
 * feature routers, this one closes over the gateway registry (the policy's
 * single source of truth), which lives on the gateway plane, not in
 * PluginServerContext.
 */
import { terminalInputPolicy } from '@ensembleworks/contracts'
import express from 'express'
import type { GatewayRegistry } from '../gateway-registry.ts'
import { resolveGatewayOwner } from '../whoami.ts'

export function createGatewayInputPolicyRouter(registry: GatewayRegistry): express.Router {
	const router = express.Router()

	router.post(terminalInputPolicy.http.path, async (req, res) => {
		const body = (req.body ?? {}) as Record<string, unknown>
		const gatewayId = typeof body.gatewayId === 'string' && body.gatewayId ? body.gatewayId : null
		const policy = body.policy === 'locked' || body.policy === 'shared' ? body.policy : null
		if (!gatewayId) return void res.status(400).json({ error: 'gatewayId is required' })
		if (!policy) return void res.status(400).json({ error: 'policy must be locked | shared' })
		const entry = registry.get(gatewayId)
		if (!entry) return void res.status(404).json({ error: `unknown gateway: ${gatewayId}` })
		const caller = await resolveGatewayOwner(req.headers).catch(() => null)
		if (caller === null || caller !== entry.ownerIdentity) {
			return void res.status(403).json({ error: 'only the gateway owner may change its input policy' })
		}
		registry.setInputPolicy(gatewayId, policy)
		res.json({ ok: true, gatewayId, policy })
	})

	return router
}
```

In `server/src/app.ts`:

Add the import next to the other feature-router imports:

```ts
import { createGatewayInputPolicyRouter } from './features/gateway-input-policy.ts'
```

Mount it directly under the existing gateway-plane lines (after `app.get(terminalList.http.path, gatewayPlane.listHandler)`):

```ts
	// Owner-controlled input ACL toggle (SP3): closes over the gateway plane's
	// registry — the policy's single source of truth.
	app.use(createGatewayInputPolicyRouter(gatewayPlane.registry))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun server/src/gateway-input-policy.test.ts && bun contracts/src/tools/tools.test.ts && bun server/src/tools-api.test.ts && bun server/src/gateway-acl.test.ts`
Expected: all PASS — the new endpoint is declared AND mounted (tools-api's bidirectional check), count 28.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/tools/terminal.ts contracts/src/tools/tools.test.ts server/src/tools-api.test.ts server/src/features/gateway-input-policy.ts server/src/app.ts server/src/gateway-input-policy.test.ts
git commit -m "feat(server): POST /api/terminal/input-policy — owner-403 toggle over the gateway registry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `codespaceShapeProps` in contracts + server schema entry

Identity-only props (decision log item 2): `w, h, gatewayId, repo, branch`. No status/owner/inputPolicy props — live state is polled, never synced.

**Files:**
- Modify: `contracts/src/shapes.ts` (append), `server/src/schema.ts`
- Create: `contracts/src/shapes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `contracts/src/shapes.test.ts`:

```ts
// Validator smoke for codespaceShapeProps (SP3): identity-only — gatewayId/
// repo/branch; live state (status/owner/inputPolicy) is DELIBERATELY absent
// (polled from /api/terminal/list, never synced — decision log SP3 item 2).
// Run with: bun src/shapes.test.ts
import assert from 'node:assert/strict'
import { codespaceShapeProps } from './shapes.js'

assert.equal(codespaceShapeProps.w.validate(960), 960)
assert.equal(codespaceShapeProps.h.validate(600), 600)
assert.equal(codespaceShapeProps.gatewayId.validate('codespace-abc'), 'codespace-abc')
assert.equal(codespaceShapeProps.repo.validate('github.com/acme/app'), 'github.com/acme/app')
assert.equal(codespaceShapeProps.branch.validate('main'), 'main')
assert.throws(() => codespaceShapeProps.gatewayId.validate(42), 'gatewayId must be a string')
assert.throws(() => codespaceShapeProps.w.validate('wide'), 'w must be a number')

// Live state must never creep into the synced props.
const keys = Object.keys(codespaceShapeProps).sort()
assert.deepEqual(keys, ['branch', 'gatewayId', 'h', 'repo', 'w'], 'identity-only props')

console.log('ok: codespaceShapeProps — identity-only validators')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun contracts/src/shapes.test.ts`
Expected: FAIL — `codespaceShapeProps` is not exported from `./shapes.js`.

- [ ] **Step 3: Implement**

Append to `contracts/src/shapes.ts`:

```ts
export const codespaceShapeProps = {
	w: T.number,
	h: T.number,
	// The relay gateway id this codespace's connector registered under —
	// child terminal shapes are created with props.gateway = this.
	gatewayId: T.string,
	// Repo/branch identity stamped at creation (from GET /api/terminal/list).
	// Live state (status/owner/inputPolicy) is DELIBERATELY not a synced prop:
	// the gateway registry is the single source of truth and clients poll the
	// list endpoint (~5s while mounted). Decision log 2026-07-21, SP3 item 2.
	repo: T.string,
	branch: T.string,
}
```

In `server/src/schema.ts`, add `codespaceShapeProps` to the contracts import list and register it:

```ts
import {
	codespaceShapeProps,
	fileViewerShapeProps,
	iframeShapeProps,
	nekoShapeProps,
	roadmapShapeProps,
	screenshareShapeProps,
	terminalShapeProps,
} from '@ensembleworks/contracts'

export const schema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		terminal: { props: terminalShapeProps },
		iframe: { props: iframeShapeProps },
		neko: { props: nekoShapeProps },
		roadmap: { props: roadmapShapeProps },
		screenshare: { props: screenshareShapeProps },
		'file-viewer': { props: fileViewerShapeProps },
		codespace: { props: codespaceShapeProps },
	},
	bindings: defaultBindingSchemas,
})
```

(The barrel `contracts/src/index.ts` does `export * from './shapes.js'` — no barrel change needed. A whole-new-shape entry is additive; the established idiom for zero-migration applies to new *props* on existing shapes — a new shape type needs no migration at all. The `schema.ts` change has no bespoke runnable seam; it is verified by `bun run typecheck` plus every booted server test in the suite.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun contracts/src/shapes.test.ts && cd server && bun run typecheck && cd ..`
Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/shapes.ts contracts/src/shapes.test.ts server/src/schema.ts
git commit -m "feat(contracts): codespaceShapeProps (identity-only) + server schema entry

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CLI — optional `--repo` / `--branch` on `terminal connect`

Default: not sent (plain gateway, shared policy — today's behavior byte-identical). SP2's `ew codespace up` will reuse these flags.

**Files:**
- Modify: `cli/src/native/connect.ts`
- Test: `cli/src/native/connect.test.ts`

- [ ] **Step 1: Write the failing tests**

In `cli/src/native/connect.test.ts`:

In the first block (config resolution + defaults), after the `backend defaults to tmux` assertion, add:

```ts
	assert.ok(!cfg.wsUrl.includes('repo='), 'no repo param by default (plain gateway, shared policy)')
	assert.ok(!cfg.wsUrl.includes('branch='), 'no branch param by default')
	assert.equal(cfg.repo, undefined)
	assert.equal(cfg.branch, undefined)
```

In the "Explicit flags win" block, replace the object literal and extend the assertions:

```ts
// Explicit flags win.
{
	const cfg = resolveConnectConfig(
		conn,
		{ label: 'my-box', gatewayId: 'fixed-id', backend: 'pty', repo: 'github.com/acme/app', branch: 'main' },
		process.env,
	)
	assert.equal(cfg.label, 'my-box')
	assert.equal(cfg.gatewayId, 'fixed-id')
	assert.equal(cfg.backend, 'pty', 'explicit --backend pty wins')
	assert.equal(cfg.repo, 'github.com/acme/app')
	assert.equal(cfg.branch, 'main')
	assert.ok(
		cfg.wsUrl.includes(`repo=${encodeURIComponent('github.com/acme/app')}`),
		'--repo rides the connect query (registry defaults the gateway to locked)',
	)
	assert.ok(cfg.wsUrl.includes('branch=main'), '--branch rides the connect query')
}
```

Update the final `console.log` line to:

```ts
console.log('ok: connect — ws url + stable-gateway-id/hostname defaults, flags win, --backend default/validation, --repo/--branch optional, --dry-run config')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun cli/src/native/connect.test.ts`
Expected: FAIL — `repo` is not on the flags type / `cfg.repo` is `undefined` where `'github.com/acme/app'` is expected.

- [ ] **Step 3: Implement**

In `cli/src/native/connect.ts`:

`ConnectConfig` gains two optional fields:

```ts
export interface ConnectConfig {
	url: string
	wsUrl: string
	room: string
	gatewayId: string
	label: string
	authMethod: 'service-token' | 'none'
	backend: 'tmux' | 'pty'
	// Codespace metadata (SP3): sent as connect query params when present —
	// a repo-carrying registration defaults to inputPolicy 'locked' server-side.
	// Plain `terminal connect` sends neither (shared, today's behavior).
	repo?: string
	branch?: string
}
```

`resolveConnectConfig` — widen the flags param and append the params:

```ts
export function resolveConnectConfig(
	conn: Conn,
	flags: { label?: string; gatewayId?: string; backend?: 'tmux' | 'pty'; repo?: string; branch?: string },
	env: NodeJS.ProcessEnv,
): ConnectConfig {
	const label = flags.label ?? hostname()
	const gatewayId = flags.gatewayId ?? stableGatewayId(env)
	const backend = flags.backend ?? 'tmux' // legacy default — coexistence spec §3: tmux path unchanged
	const wsBase = conn.url.replace(/^http/, 'ws') // http→ws, https→wss
	const ws = new URL('/api/terminal/connect', wsBase.endsWith('/') ? wsBase : `${wsBase}/`)
	ws.searchParams.set('gatewayId', gatewayId)
	ws.searchParams.set('label', label)
	if (flags.repo) ws.searchParams.set('repo', flags.repo)
	if (flags.branch) ws.searchParams.set('branch', flags.branch)
	return {
		url: conn.url,
		wsUrl: ws.toString(),
		room: conn.room,
		gatewayId,
		label,
		authMethod: conn.auth.method,
		backend,
		repo: flags.repo,
		branch: flags.branch,
	}
}
```

`parseConnectFlags` — two new cases + widened return type:

```ts
function parseConnectFlags(args: string[]): {
	label?: string
	gatewayId?: string
	backend?: 'tmux' | 'pty'
	repo?: string
	branch?: string
} {
	const flags: { label?: string; gatewayId?: string; backend?: 'tmux' | 'pty'; repo?: string; branch?: string } = {}
	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case '--label':
				flags.label = args[++i]
				break
			case '--gateway-id':
				flags.gatewayId = args[++i]
				break
			case '--backend': {
				const v = args[++i]
				if (v !== 'tmux' && v !== 'pty') throw new CliError(`--backend must be tmux or pty, got: ${v}`, 2)
				flags.backend = v
				break
			}
			case '--repo':
				flags.repo = args[++i]
				break
			case '--branch':
				flags.branch = args[++i]
				break
			default:
				throw new CliError(`unknown terminal connect flag: ${args[i]}`, 2)
		}
	}
	return flags
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun cli/src/native/connect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/native/connect.ts cli/src/native/connect.test.ts
git commit -m "feat(cli): --repo/--branch flags on terminal connect ride the registration query

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Client pure logic — gateway view derivation + shared list poller

The bun-testable half of the client work (house convention: client tests are pure-logic scripts — `grid.test.ts` / `wsUrl.test.ts` style). Components consume these in Tasks 8–9.

**Files:**
- Create: `client/src/codespace/gatewayView.ts`, `client/src/codespace/gatewayPoll.ts`
- Create: `client/src/codespace/gatewayView.test.ts`, `client/src/codespace/gatewayPoll.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `client/src/codespace/gatewayView.test.ts`:

```ts
// Pure view derivation for codespace gateways (SP3): list poll → status dot /
// owner / policy / read-only decision. Server-side enforcement is the
// authority; this drives DECORATION (badge, local stdin gate).
// Run with: bun src/codespace/gatewayView.test.ts
import assert from 'node:assert/strict'
import { codespaceViewFor, inputLockedForViewer, type GatewayListEntry } from './gatewayView'

const cs: GatewayListEntry = {
	gatewayId: 'cs1',
	label: 'CS',
	connectedAt: 1,
	repo: 'github.com/acme/app',
	branch: 'main',
	inputPolicy: 'locked',
	owner: 'sso:owner@acme.dev',
	viewerIsOwner: false,
}

// Poll not landed yet → unknown; never locks the keyboard on a guess.
{
	const view = codespaceViewFor(null, 'cs1')
	assert.equal(view.status, 'unknown')
	assert.equal(inputLockedForViewer(view), false, 'unknown status never gates input')
}

// Gateway absent from the list → offline; input goes nowhere anyway, not gated.
{
	const view = codespaceViewFor([], 'cs1')
	assert.equal(view.status, 'offline')
	assert.equal(view.owner, null)
	assert.equal(inputLockedForViewer(view), false, 'offline gateway not gated (ws is down regardless)')
}

// Connected + locked + non-owner → read-only.
{
	const view = codespaceViewFor([cs], 'cs1')
	assert.equal(view.status, 'connected')
	assert.equal(view.owner, 'sso:owner@acme.dev')
	assert.equal(view.inputPolicy, 'locked')
	assert.equal(view.viewerIsOwner, false)
	assert.equal(inputLockedForViewer(view), true, 'locked + non-owner → read-only')
}

// Owner is never gated; shared is never gated.
assert.equal(inputLockedForViewer(codespaceViewFor([{ ...cs, viewerIsOwner: true }], 'cs1')), false)
assert.equal(inputLockedForViewer(codespaceViewFor([{ ...cs, inputPolicy: 'shared' }], 'cs1')), false)

// Pre-SP3 servers (fields absent): default policy reads locked — the safe
// direction — but the connected+locked gate still needs an explicit policy
// only; owner/viewerIsOwner default falsy.
{
	const bare: GatewayListEntry = { gatewayId: 'plain1', label: 'Box', connectedAt: 1 }
	const view = codespaceViewFor([bare], 'plain1')
	assert.equal(view.status, 'connected')
	assert.equal(view.inputPolicy, 'locked', 'absent policy defaults locked (safe direction)')
	assert.equal(view.viewerIsOwner, false)
}

console.log('ok: codespaceViewFor + inputLockedForViewer — status/policy/read-only matrix')
```

Create `client/src/codespace/gatewayPoll.test.ts`:

```ts
// Refcounted shared poller of GET /api/terminal/list (SP3, decision log item
// 2: ~5s while mounted). Factory-injected fetch + interval so this tests with
// a stub and real (short) timers — no DOM, no network.
// Run with: bun src/codespace/gatewayPoll.test.ts
import assert from 'node:assert/strict'
import { createGatewayPoller } from './gatewayPoll'
import type { GatewayListEntry } from './gatewayView'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Subscribe → immediate cached value (null before first fetch), then data;
// interval refreshes; last unsubscribe stops polling; errors keep last value.
{
	let calls = 0
	let fail = false
	const entry: GatewayListEntry = { gatewayId: 'cs1', label: 'CS', connectedAt: 1 }
	const poller = createGatewayPoller(async () => {
		calls++
		if (fail) throw new Error('boom')
		return [entry]
	}, 20)

	const seen: Array<GatewayListEntry[] | null> = []
	const unsub = poller.subscribe((list) => seen.push(list))
	assert.equal(seen[0], null, 'subscriber gets the cache immediately (null pre-fetch)')
	await poller.refresh()
	assert.ok(calls >= 1, 'first fetch fired on subscribe')
	assert.deepEqual(seen.at(-1), [entry], 'data delivered')

	await sleep(70)
	assert.ok(calls >= 3, `interval keeps polling while subscribed (got ${calls})`)

	// A failing fetch keeps the last good value (no flicker to offline).
	fail = true
	await poller.refresh()
	assert.deepEqual(seen.at(-1), [entry], 'error keeps last good value')
	fail = false

	// Second subscriber shares the one interval and gets the cache at once.
	const seen2: Array<GatewayListEntry[] | null> = []
	const unsub2 = poller.subscribe((list) => seen2.push(list))
	assert.deepEqual(seen2[0], [entry], 'late subscriber gets cached data immediately')

	unsub()
	unsub2()
	const callsAtStop = calls
	await sleep(70)
	assert.equal(calls, callsAtStop, 'no fetches after the last unsubscribe')
}

console.log('ok: createGatewayPoller — cache, interval, refcount, error resilience')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun client/src/codespace/gatewayView.test.ts; bun client/src/codespace/gatewayPoll.test.ts`
Expected: both FAIL — modules do not exist (`Cannot find module`).

- [ ] **Step 3: Implement**

Create `client/src/codespace/gatewayView.ts`:

```ts
/**
 * Pure view derivation for codespace gateways (SP3). Live state (status/
 * owner/inputPolicy) is NEVER stored in synced shape props — the gateway
 * registry is the single source of truth and clients poll
 * GET /api/terminal/list (decision log 2026-07-21, SP3 item 2). This module
 * is the pure half: bun-testable, no DOM, no fetch. The relay drops locked
 * non-owner input server-side regardless — everything here is decoration.
 */

/** One entry of GET /api/terminal/list. repo/branch/inputPolicy/owner/
 * viewerIsOwner are the SP3 fields; optional so a client deployed ahead of
 * the server degrades gracefully. */
export interface GatewayListEntry {
	gatewayId: string
	label: string
	connectedAt: number
	repo?: string
	branch?: string
	inputPolicy?: 'locked' | 'shared'
	owner?: string
	viewerIsOwner?: boolean
}

export interface CodespaceView {
	/** 'unknown' until the first poll lands; then connected/offline. */
	status: 'unknown' | 'connected' | 'offline'
	owner: string | null
	/** Absent policy reads locked — the safe direction. */
	inputPolicy: 'locked' | 'shared'
	viewerIsOwner: boolean
}

export function codespaceViewFor(
	gateways: GatewayListEntry[] | null,
	gatewayId: string
): CodespaceView {
	if (gateways === null) {
		return { status: 'unknown', owner: null, inputPolicy: 'locked', viewerIsOwner: false }
	}
	const gw = gateways.find((g) => g.gatewayId === gatewayId)
	if (!gw) return { status: 'offline', owner: null, inputPolicy: 'locked', viewerIsOwner: false }
	return {
		status: 'connected',
		owner: gw.owner ?? null,
		inputPolicy: gw.inputPolicy ?? 'locked',
		viewerIsOwner: gw.viewerIsOwner === true,
	}
}

/** Local stdin gate + read-only badge decision. Only a CONNECTED locked
 * gateway gates: 'unknown' must not lock the keyboard on a guess, and an
 * offline gateway's input goes nowhere anyway (the ws is down). The server
 * remains the authority either way. */
export function inputLockedForViewer(view: CodespaceView): boolean {
	return view.status === 'connected' && view.inputPolicy === 'locked' && !view.viewerIsOwner
}
```

Create `client/src/codespace/gatewayPoll.ts`:

```ts
/**
 * Refcounted shared poller of GET /api/terminal/list (~5s while any codespace
 * or gateway-backed terminal is mounted — decision log SP3 item 2). One
 * interval for the whole app regardless of subscriber count; stops when the
 * last subscriber unmounts. Factory-injected fetch + interval keep the core
 * bun-testable; the app singleton is at the bottom.
 */
import type { GatewayListEntry } from './gatewayView'

export type GatewayListListener = (gateways: GatewayListEntry[] | null) => void

export interface GatewayPoller {
	/** Starts polling on the first subscriber; the listener is called
	 * immediately with the cached list (null before the first fetch lands).
	 * Returns unsubscribe. */
	subscribe(listener: GatewayListListener): () => void
	/** Force an immediate refresh (e.g. right after a policy POST). */
	refresh(): Promise<void>
}

export function createGatewayPoller(
	fetchList: () => Promise<GatewayListEntry[]>,
	intervalMs: number
): GatewayPoller {
	const listeners = new Set<GatewayListListener>()
	let last: GatewayListEntry[] | null = null
	let timer: ReturnType<typeof setInterval> | null = null
	let inFlight: Promise<void> | null = null

	const refresh = (): Promise<void> => {
		if (inFlight) return inFlight
		inFlight = fetchList()
			.then((list) => {
				last = list
				for (const listener of listeners) listener(last)
			})
			.catch(() => {
				// Transient failure keeps the last good value — no flicker to
				// offline on one dropped poll.
			})
			.finally(() => {
				inFlight = null
			})
		return inFlight
	}

	return {
		subscribe(listener) {
			listeners.add(listener)
			listener(last)
			if (listeners.size === 1) {
				timer = setInterval(() => void refresh(), intervalMs)
				void refresh()
			}
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0 && timer) {
					clearInterval(timer)
					timer = null
				}
			}
		},
		refresh,
	}
}

async function fetchGatewayList(): Promise<GatewayListEntry[]> {
	const res = await fetch('/api/terminal/list')
	if (!res.ok) throw new Error(`list ${res.status}`)
	const body = (await res.json()) as { gateways?: GatewayListEntry[] }
	return body.gateways ?? []
}

/** The app-wide shared poller. */
export const gatewayPoller = createGatewayPoller(fetchGatewayList, 5000)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun client/src/codespace/gatewayView.test.ts && bun client/src/codespace/gatewayPoll.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/codespace/gatewayView.ts client/src/codespace/gatewayView.test.ts client/src/codespace/gatewayPoll.ts client/src/codespace/gatewayPoll.test.ts
git commit -m "feat(client): pure codespace gateway view derivation + refcounted list poller

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `CodespaceShapeUtil` + plugin + creation flow

The container shape (legacy tldraw): header with repo@branch, status dot, owner, lock toggle, `[+ terminal]`; child terminals are ordinary terminal shapes created with `parentId` (decision 1 — `BaseBoxShapeUtil`, no frame-like drop-reparenting). **Verification: `bun run typecheck` + the documented manual smoke — this repo has no DOM-component test convention (client tests are pure-logic only), and the pure logic behind this component was tested in Task 7. State this explicitly in the task's commit/PR notes.**

**Files:**
- Create: `client/src/codespace/CodespaceShapeUtil.tsx`, `client/src/codespace/createCodespaceShape.ts`, `client/src/codespace/openNewCodespace.tsx`, `client/src/codespace/plugin.ts`
- Modify: `client/src/plugins.ts`

- [ ] **Step 1: Implement**

Create `client/src/codespace/CodespaceShapeUtil.tsx`:

```tsx
/**
 * A Codespace as a tldraw container shape (EW Codespaces coexistence spec §5).
 *
 * - Synced props are IDENTITY ONLY (gatewayId/repo/branch — decision log SP3
 *   item 2). Everything live — status dot, owner, input policy — comes from
 *   the shared gatewayPoller (~5s poll of GET /api/terminal/list) and is
 *   rendered locally, never written to the store.
 * - It is a container: child terminals are the EXISTING terminal shape,
 *   created with parentId = this shape (children transform with the parent
 *   natively — seedSessionCanvas.ts frame precedent) and
 *   props.gateway = gatewayId, so the existing client fork routes them to
 *   the relay with no new code path.
 * - The lock toggle POSTs /api/terminal/input-policy. It is VISIBLE to all
 *   and actionable only by the owner — the server 403s everyone else and the
 *   next poll re-asserts truth; the badge is decoration, never enforcement.
 * - Lifecycle stays in the CLI for v1: no stop/rebuild controls (spec §5).
 */
import { codespaceShapeProps } from '@ensembleworks/contracts'
import { useEffect, useState } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	TLBaseShape,
	TLResizeInfo,
	createShapeId,
	resizeBox,
	useEditor,
} from 'tldraw'
import { wm } from '../theme'
import { gatewayPoller } from './gatewayPoll'
import { codespaceViewFor, type CodespaceView } from './gatewayView'

export interface CodespaceShapeProps {
	w: number
	h: number
	gatewayId: string
	repo: string
	branch: string
}

// Register the shape in tldraw's global shape union (tldraw v5 pattern), so
// editor.createShape({ type: 'codespace', ... }) is fully typed.
declare module '@tldraw/tlschema' {
	interface TLGlobalShapePropsMap {
		codespace: CodespaceShapeProps
	}
}

export type CodespaceShape = TLBaseShape<'codespace', CodespaceShapeProps>

const MIN_W = 480
const MIN_H = 320
const HEADER_H = 40

export class CodespaceShapeUtil extends BaseBoxShapeUtil<CodespaceShape> {
	static override type = 'codespace' as const
	static override props = codespaceShapeProps

	override getDefaultProps(): CodespaceShape['props'] {
		return { w: 960, h: 600, gatewayId: '', repo: '', branch: '' }
	}

	override hideRotateHandle() {
		return true
	}
	override canEdit() {
		return false
	}

	override onResize(shape: CodespaceShape, info: TLResizeInfo<CodespaceShape>) {
		return resizeBox(shape, info, { minWidth: MIN_W, minHeight: MIN_H })
	}

	override component(shape: CodespaceShape) {
		return <CodespaceShapeComponent shape={shape} />
	}

	override getIndicatorPath(shape: CodespaceShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function CodespaceShapeComponent({ shape }: { shape: CodespaceShape }) {
	const editor = useEditor()
	const [view, setView] = useState<CodespaceView>(() =>
		codespaceViewFor(null, shape.props.gatewayId)
	)
	useEffect(
		() =>
			gatewayPoller.subscribe((list) =>
				setView(codespaceViewFor(list, shape.props.gatewayId))
			),
		[shape.props.gatewayId]
	)

	const locked = view.inputPolicy === 'locked'
	const dotColor =
		view.status === 'connected' ? '#2e7d32' : view.status === 'offline' ? '#c62828' : '#9e9e9e'
	// Display 'sso:alice@acme.dev' as 'alice@acme.dev' (prefix is an authz
	// namespace, not a name).
	const ownerLabel = view.owner ? view.owner.replace(/^(sso|token):/, '') : null

	const addTerminal = () => {
		// Stack new children with a small cascade; child x/y are PARENT-relative.
		const childCount = editor.getSortedChildIdsForParent(shape.id).length
		const sessionId = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
		const id = createShapeId()
		editor.createShape({
			id,
			type: 'terminal',
			parentId: shape.id,
			x: 24 + childCount * 32,
			y: HEADER_H + 24 + childCount * 32,
			props: {
				w: 720,
				h: 440,
				sessionId,
				title: `${shape.props.repo.split('/').pop() || 'codespace'} terminal`,
				gateway: shape.props.gatewayId,
			},
		})
		editor.setSelectedShapes([id])
	}

	const togglePolicy = () => {
		// Optimism-free: POST, then re-poll. Non-owners get a server 403 and the
		// poll simply re-asserts the current truth (server is the authority).
		void fetch('/api/terminal/input-policy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				gatewayId: shape.props.gatewayId,
				policy: locked ? 'shared' : 'locked',
			}),
		})
			.catch(() => {})
			.then(() => gatewayPoller.refresh())
	}

	const { w, h } = shape.props
	return (
		<HTMLContainer
			style={{
				width: w,
				height: h,
				position: 'relative',
				// The body is inert: pointer events fall through to tldraw so the
				// container selects/drags/resizes like any shape; only the header's
				// controls take the pointer.
				pointerEvents: 'none',
			}}
		>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					borderRadius: 6,
					border: `1.5px solid ${wm.ink}`,
					background: 'rgba(249,250,251,0.6)',
					boxShadow: wm.shadowPaper,
				}}
			/>
			{/* Header: repo@branch · status dot · owner · lock toggle · + terminal */}
			<div
				onPointerDown={(e) => e.stopPropagation()}
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					right: 0,
					height: HEADER_H,
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					padding: '0 12px',
					borderBottom: `1px solid ${wm.ink}`,
					background: '#f9fafb',
					borderRadius: '6px 6px 0 0',
					fontFamily: wm.mono,
					fontSize: 12,
					color: wm.sealBlue,
					pointerEvents: 'all',
				}}
			>
				<span
					title={`gateway ${shape.props.gatewayId}: ${view.status}`}
					style={{
						width: 9,
						height: 9,
						borderRadius: '50%',
						background: dotColor,
						flex: '0 0 auto',
					}}
				/>
				<span
					style={{
						fontWeight: 700,
						textTransform: 'none',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'pre',
					}}
				>
					{shape.props.repo}
					{shape.props.branch ? `@${shape.props.branch}` : ''}
				</span>
				{ownerLabel && (
					<span style={{ color: wm.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
						{ownerLabel}
					</span>
				)}
				<span style={{ flex: 1 }} />
				<button
					type="button"
					onClick={togglePolicy}
					title={
						view.viewerIsOwner
							? locked
								? 'Input locked to you — click to share the keyboard'
								: 'Input shared — click to lock to you'
							: locked
								? 'Input locked to the owner (read-only for you)'
								: 'Input shared'
					}
					style={{
						font: 'inherit',
						border: `1px solid ${wm.ink}`,
						borderRadius: 4,
						padding: '2px 8px',
						background: locked ? '#fff' : '#e8f5e9',
						cursor: view.viewerIsOwner ? 'pointer' : 'default',
						color: 'inherit',
					}}
				>
					{locked ? '🔒 locked' : '🔓 shared'}
				</button>
				<button
					type="button"
					onClick={addTerminal}
					title="New terminal in this codespace"
					style={{
						font: 'inherit',
						border: `1px solid ${wm.ink}`,
						borderRadius: 4,
						padding: '2px 8px',
						background: '#fff',
						cursor: 'pointer',
						color: 'inherit',
					}}
				>
					+ terminal
				</button>
			</div>
		</HTMLContainer>
	)
}
```

Create `client/src/codespace/createCodespaceShape.ts`:

```ts
import { createShapeId, type Editor } from 'tldraw'
import type { GatewayListEntry } from './gatewayView'

export function createCodespaceShape(editor: Editor, gw: GatewayListEntry) {
	const { x, y } = editor.getViewportPageBounds().center
	const id = createShapeId()
	editor.createShape({
		id,
		type: 'codespace',
		x: x - 480,
		y: y - 300,
		props: { w: 960, h: 600, gatewayId: gw.gatewayId, repo: gw.repo ?? '', branch: gw.branch ?? '' },
	})
	editor.setSelectedShapes([id])
}
```

Create `client/src/codespace/openNewCodespace.tsx`:

```tsx
/**
 * The "new codespace" flow (openNewTerminal.tsx pattern — a tldraw *dialog*,
 * not a nested dropdown; nested Radix dropdowns silently fail inside tldraw's
 * toolbar). A codespace gateway is a list entry carrying repo metadata; plain
 * gateways stay in the terminal picker. Lifecycle is CLI-side for v1, so an
 * empty list points at `ew codespace up`.
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
import { createCodespaceShape } from './createCodespaceShape'
import type { GatewayListEntry } from './gatewayView'

async function fetchCodespaceGateways(): Promise<GatewayListEntry[]> {
	try {
		const res = await fetch('/api/terminal/list')
		if (!res.ok) return []
		const body = (await res.json()) as { gateways?: GatewayListEntry[] }
		return (body.gateways ?? []).filter((g) => g.repo)
	} catch {
		return []
	}
}

function CodespacePickerDialog({
	onClose,
	editor,
	gateways,
}: TLUiDialogProps & { editor: Editor; gateways: GatewayListEntry[] }) {
	const pick = (gw: GatewayListEntry) => {
		createCodespaceShape(editor, gw)
		onClose()
	}
	return (
		<>
			<TldrawUiDialogHeader>
				<TldrawUiDialogTitle>New codespace</TldrawUiDialogTitle>
				<TldrawUiDialogCloseButton />
			</TldrawUiDialogHeader>
			<TldrawUiDialogBody style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
				{gateways.length === 0 ? (
					<div style={{ maxWidth: 320 }}>
						No codespace gateways are connected. Start one from a checkout with{' '}
						<code>ew codespace up</code> (or <code>ew terminal connect --repo …</code>), then
						reopen this dialog.
					</div>
				) : (
					gateways.map((gw) => (
						<TldrawUiButton key={gw.gatewayId} type="normal" onClick={() => pick(gw)}>
							{gw.repo}
							{gw.branch ? `@${gw.branch}` : ''} ({gw.label})
						</TldrawUiButton>
					))
				)}
			</TldrawUiDialogBody>
		</>
	)
}

export function openNewCodespace(editor: Editor, helpers: BarItemHelpers): void {
	void fetchCodespaceGateways().then((gateways) => {
		helpers.addDialog({
			id: 'codespace-gateway-picker', // dedupe: double-activation reuses the one dialog
			component: (props: TLUiDialogProps) => (
				<CodespacePickerDialog {...props} editor={editor} gateways={gateways} />
			),
		})
	})
}
```

Create `client/src/codespace/plugin.ts`:

```ts
/**
 * Codespace plugin: the container shape util + the "new codespace" overflow
 * command-bar entry (terminal/plugin.ts pattern).
 */
import type { ClientPlugin } from '../kernel/plugin'
import { CodespaceShapeUtil } from './CodespaceShapeUtil'
import { openNewCodespace } from './openNewCodespace'

// Command-bar icon: a container box holding a `>` prompt — the codespace is a
// box of terminals. Single-colour silhouette rendered by tldraw as a CSS mask
// (terminal plugin's pattern).
const CODESPACE_ICON_NAME = 'codespace'
const CODESPACE_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
	'fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
	'<rect x="2" y="3" width="20" height="18" rx="2"/>' +
	'<path d="M2 8h20"/>' +
	'<path d="M7 13l3 2.5-3 2.5"/></svg>'
const CODESPACE_TOOLBAR_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(CODESPACE_ICON_SVG)}`

export const codespacePlugin: ClientPlugin = {
	id: 'codespace',
	shapeUtils: [CodespaceShapeUtil],
	icons: { [CODESPACE_ICON_NAME]: CODESPACE_TOOLBAR_ICON },
	barItems: [
		{
			id: 'codespace',
			label: 'codespace',
			icon: CODESPACE_ICON_NAME,
			placement: 'overflow',
			onSelect: openNewCodespace,
		},
	],
}
```

(No `accelerator` — the priority letters are contended and the item lives in overflow.)

In `client/src/plugins.ts`, add the import (alphabetical position, after `avPlugin`/`demoPlugin` imports as the sort dictates):

```ts
import { codespacePlugin } from './codespace/plugin'
```

and register it directly after `terminalPlugin` in the array (shape-util registration order — codespace sits with its terminal children):

```ts
export const plugins: readonly ClientPlugin[] = [
	terminalPlugin,
	codespacePlugin,
	iframePlugin,
	nekoPlugin,
	roadmapPlugin,
	fileViewerPlugin,
	screensharePlugin,
	frameLinkPlugin,
	discordPlugin,
	avPlugin,
	demoPlugin,
	sessionPlugin,
]
```

Also update the file's header comment's shape-util line to `terminal, codespace, iframe, neko, roadmap, screenshare`.

- [ ] **Step 2: Verify**

Run: `bun run typecheck`
Expected: clean across all workspaces. (Explicitly: no component test — the repo's client test convention is pure-logic scripts only, and this component's logic lives in the Task 7 modules already under test. Rendering is covered by the Task 10 manual smoke.)

- [ ] **Step 3: Commit**

```bash
git add client/src/codespace/CodespaceShapeUtil.tsx client/src/codespace/createCodespaceShape.ts client/src/codespace/openNewCodespace.tsx client/src/codespace/plugin.ts client/src/plugins.ts
git commit -m "feat(client): codespace container shape — polled status/owner/lock header, child terminals via parentId

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Terminal read-only decoration for locked gateways

Gateway-backed terminals subscribe to the same poller; when the gateway is connected+locked and the viewer is not the owner, the client stops sending `input` frames and shows a read-only chip. Pure decoration — Task 2's relay drop is the enforcement; this only spares the user typing into a void. Legacy (`props.gateway` unset) terminals are untouched: the effect early-returns and no chip can render. **Verification: the gating decision is already unit-tested (Task 7's `inputLockedForViewer`); the wiring is `bun run typecheck` + the Task 10 manual smoke — stated explicitly, per the client test convention.**

**Files:**
- Modify: `client/src/terminal/TerminalShapeUtil.tsx`

- [ ] **Step 1: Implement**

In `client/src/terminal/TerminalShapeUtil.tsx`:

Add the imports (after the `./wsUrl` import):

```ts
import { gatewayPoller } from '../codespace/gatewayPoll'
import { codespaceViewFor, inputLockedForViewer } from '../codespace/gatewayView'
```

In `TerminalShapeComponent`, add state + the poll subscription. Place this block right after the `const [retryAttempt, setRetryAttempt] = useState(0)` line:

```ts
	// SP3 read-only decoration: for gateway-backed terminals, poll the registry
	// view and stop SENDING input when the gateway is locked to someone else.
	// The relay drops those frames server-side regardless (gateway-registry.ts
	// onBrowserMessage) — this only spares the user typing into a void, and a
	// stale poll can never grant access. Legacy terminals (no gateway) skip it.
	const [inputLocked, setInputLocked] = useState(false)
	const inputLockedRef = useRef(false)
	useEffect(() => {
		const gatewayId = shape.props.gateway
		if (!gatewayId) return
		return gatewayPoller.subscribe((list) => {
			const locked = inputLockedForViewer(codespaceViewFor(list, gatewayId))
			inputLockedRef.current = locked
			setInputLocked(locked)
		})
	}, [shape.props.gateway])
```

Gate the two input-send paths inside the mount effect (both read the ref — the closures are created once per session mount):

In the `term.onData` handler, add the guard as the first line:

```ts
		term.onData((data) => {
			if (inputLockedRef.current) return // read-only viewer — relay drops it anyway
			const ws = wsRef.current
			if (ws?.readyState === WebSocket.OPEN) {
				const msg: TermClientMessage = { type: 'input', data }
				ws.send(JSON.stringify(msg))
			}
		})
```

In `attachCustomKeyEventHandler`, the `ptyInput` branch gains the same guard (keep the `preventDefault` so the keystroke doesn't leak to tldraw):

```ts
			const ptyInput = ptyInputForKey(e)
			if (ptyInput) {
				e.preventDefault()
				if (!inputLockedRef.current) {
					const ws = wsRef.current
					if (ws?.readyState === WebSocket.OPEN) {
						const msg: TermClientMessage = { type: 'input', data: ptyInput }
						ws.send(JSON.stringify(msg))
					}
				}
				return false
			}
```

(`resize` sends are deliberately NOT gated — the deterministic grid stays shared, matching the relay's resize pass-through.)

Add the chip in the title row — directly after the closing of the `{renaming ? (…) : (…)}` ternary block (i.e. as a sibling right before the title-row `</div>`):

```tsx
				{inputLocked && (
					<div
						title="This codespace's input is locked to its owner — you can watch, not type"
						style={{
							marginLeft: 6,
							padding: '2px 9px',
							borderRadius: 'var(--tl-radius-1)',
							background: '#f9fafb',
							color: wm.inkMuted,
							whiteSpace: 'pre',
							userSelect: 'none',
						}}
					>
						🔒 read-only
					</div>
				)}
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun client/src/terminal/grid.test.ts && bun client/src/terminal/keys.test.ts && bun client/src/terminal/wsUrl.test.ts`
Expected: clean typecheck; the existing terminal pure-logic tests untouched and passing. (Explicitly: no component test, per the repo's client convention; the lock decision itself is Task 7-tested and the enforcement is Task 2/3-tested server-side.)

- [ ] **Step 3: Commit**

```bash
git add client/src/terminal/TerminalShapeUtil.tsx
git commit -m "feat(client): read-only chip + local stdin gate for locked gateway terminals (decoration; relay enforces)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification + manual smoke

- [ ] **Step 1: Typecheck everything**

Run: `bun run typecheck`
Expected: exit 0 across all workspaces.

- [ ] **Step 2: Full test suite**

Run: `bun run test`
Expected: `all N suites passed` — the glob (`**/src/**/*.test.ts`) picks up the five new test files (gateway-acl, gateway-input-policy, shapes, gatewayView, gatewayPoll) automatically. Pre-existing suites — especially `gateway-identity`, `gateway-owner`, `gateway-plane`, `connector-loopback`, `connector-pty-loopback`, `relay-loopback`, `tools-api` — must pass unchanged (coexistence: the legacy path is frozen).

- [ ] **Step 3: Manual smoke (required for the client tasks — this is their stated verification)**

Against a running dev stack (`bin/dev up`), with a second browser profile (or incognito window) as the "teammate":

```bash
# A fake codespace gateway from any checkout (no devcontainer needed — SP2 is
# not built yet; this is exactly the loopback-testability the plan promises):
bun cli/src/main.ts terminal connect --url http://localhost:8788 \
  --gateway-id cs-smoke --backend pty --repo github.com/acme/app --branch main
```

Then on the canvas:

1. ⋯ menu → **codespace** → picker lists `github.com/acme/app@main (…)` → pick it. A codespace container appears: green dot, repo@branch, owner, `🔒 locked`.
2. **[+ terminal]** → a terminal appears INSIDE the container, live shell via the relay. Drag the container — the child moves with it (parentId containment).
3. In dev mode every browser is the same `dev` identity as an anonymous connector would be — but the connector above registered under YOUR auth. If running truly authless, both windows are owner; the meaningful check is the *server* matrix already pinned by `gateway-acl.test.ts`. What the smoke verifies here: the toggle round-trips (click `🔒 locked` → becomes `🔓 shared` within a poll; click again → back), and the status dot flips red within ~5s of Ctrl-C'ing the connector, green again on restart.
4. On a deployment with real CF Access identities (or by registering the connector with a service token while browsing over SSO): the second identity's window shows `🔒 read-only` on the child terminal, typing does nothing, output still streams; after the owner clicks share, the second identity can type within one poll.

- [ ] **Step 4: Clean tree, hand off**

```bash
git status --short   # should be clean
```

Done. Hand off per superpowers:finishing-a-development-branch — the PR body MUST include, verbatim:
`ux-contract: none — legacy tldraw shape; contract runners target the canvas-v2 stack; obligations attach at the v2 port`

---

## Out of scope for this plan (spec §8 + decision log)

- `ew codespace up` / devcontainer anything (SP2 — its registrations will reuse `--repo`/`--branch`).
- Any change to the legacy `:8789` tmux gateway, `server/src/terminal-gateway.ts`, or terminals with `props.gateway` unset (frozen path; Task 9's decoration early-returns for them).
- Canvas-v2 codespace shape (parity backlog; `codespaceShapeProps` in contracts is the porting seam).
- Canvas-initiated lifecycle (`stop`/`rebuild` from the shape).
- Per-terminal input ACL granularity (per-Codespace only in v1).
- Drag-to-reparent-by-drop into the container (`BaseFrameLikeShapeUtil` — YAGNI per decision 1).
- Registry→store push for status (polling chosen deliberately; connect/disconnect events still only log).
