# Phase 0 (Bun spike battery) + Phase 1 (contracts extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the Bun migration with four recorded spikes, then create the `@ensembleworks/contracts` workspace and move every mechanical "Keep in sync" pair into it (shape props, terminal WS protocol, terminal statuses, spatial stamp, slugify).

**Architecture:** Spikes live in `spikes/phase0/` with results written to `FINDINGS.md` and back to `docs/unified-architecture-design.md` §2.1 — a spike that *fails* still completes its task by recording the failure verbatim. Contracts is a source-only workspace package (`exports` points at `.ts` source; no build step) consumed by server (tsx), client (Vite) and typecheck (tsconfig `paths`).

**Tech Stack:** Bun ≥ 1.3.14 (`~/.local/share/mise/installs/bun/1.3.14/bin/bun` exists on this machine; spike scripts assert the version), npm workspaces, TypeScript, Zod v4, `@tldraw/validate`.

**Scope note (deliberate deferral):** The unified design's Phase 1 also lists API request/response types and tool definitions. Those land in the next plan alongside the CLI — their first consumer — per YAGNI. This plan kills the five mechanical keep-in-sync pairs, which is the highest-value, zero-behaviour-change slice.

---

## Part A — Phase 0 spike battery

### Task 1: Spike scaffolding

**Files:**
- Create: `spikes/phase0/README.md`
- Create: `spikes/phase0/FINDINGS.md`
- Modify: `.gitignore` (add `spikes/phase0/dist/`)

- [ ] **Step 1: Create the spike directory and README**

```bash
mkdir -p spikes/phase0
```

Create `spikes/phase0/README.md`:

```markdown
# Phase 0 spike battery

De-risks the Bun migration (docs/unified-architecture-design.md §7, Phase 0).
Each spike records its result in FINDINGS.md — pass or fail, with the exact
error verbatim on failure. A failed spike is a *completed* spike.

Requires Bun ≥ 1.3.14 (`bun --version`). Compiled outputs go to `dist/`
(git-ignored).

- Spike A: the sync server compiled with `bun build --compile`
- Spike B: the Vite client build driven by Bun
- Spike C: `@livekit/rtc-node` under Bun (import, runtime start, compiled)

(Spike D, Bun.Terminal PTY, already passed on 2026-07-04 — see
docs/unified-architecture-design.md §2.1.)
```

Create `spikes/phase0/FINDINGS.md`:

```markdown
# Phase 0 findings

| Spike | Result | Notes |
|---|---|---|
| A: compiled sync server | _pending_ | |
| B: Vite build under Bun | _pending_ | |
| C: rtc-node under Bun | _pending_ | |
| D: Bun.Terminal PTY | PASS (2026-07-04) | see unified doc §2.1 |
```

- [ ] **Step 2: Git-ignore spike build outputs**

Append to `.gitignore`:

```
spikes/phase0/dist/
```

- [ ] **Step 3: Verify Bun version**

```bash
bun --version
```

Expected: `1.3.14` or later. If the shell finds an older bun first, use
`export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"` for all
spike commands.

- [ ] **Step 4: Commit**

```bash
git add spikes/phase0 .gitignore
git commit -m "chore(spikes): scaffold phase-0 bun spike battery"
```

### Task 2: Spike A — sync server compiled with `bun build --compile`

**Files:**
- Modify: `spikes/phase0/FINDINGS.md`

Tests: express 5, `ws` upgrade path, `node:sqlite`, static client serving —
all from a compiled standalone binary. Uses the existing throwaway smoke
client (`server/src/smoke-client.ts`, which dials `ws://localhost:8788` and
exits 0 on a tlsync `connect` reply).

- [ ] **Step 1: Ensure deps and a client build exist**

```bash
npm ci
npm run build --workspace=client
```

Expected: `client/dist/index.html` exists.

- [ ] **Step 2: Compile the server**

```bash
bun build --compile server/src/sync-server.ts --outfile spikes/phase0/dist/ew-server
```

Expected: `compile spikes/phase0/dist/ew-server` and a ~90–110 MB binary.
If this fails (bundler error on a dependency), record the exact error in
FINDINGS.md — that IS the finding — and skip to Step 6.

- [ ] **Step 3: Boot the binary with scratch state**

```bash
DATA_DIR=$(mktemp -d) ./spikes/phase0/dist/ew-server &
sleep 2
curl -fsS http://localhost:8788/api/health
```

Expected: HTTP 200 with a JSON body. (The server defaults to port 8788; if
`sync-server.ts` requires other env, its startup error will say so — record
and satisfy it.)

- [ ] **Step 4: Exercise the WS sync path (the tlsync connect handshake)**

```bash
cd server && npx tsx src/smoke-client.ts; cd ..
```

Expected: `server replied: connect …` and exit 0. This proves the `ws`
upgrade path and `node:sqlite` room persistence work inside the compiled
bundle.

- [ ] **Step 5: Check static serving from the compiled binary**

```bash
curl -fsS http://localhost:8788/ | head -c 100
kill %1
```

Expected: HTML starting `<!doctype html`. If instead this 404s because the
compiled binary resolves the client-dist path relative to the bundle rather
than the repo, record that — the fix (an explicit `CLIENT_DIST` env or
cwd-relative path) becomes a Phase-3 work item, and the spike still passes
if Steps 3–4 passed.

- [ ] **Step 6: Record the result**

Update the Spike A row in `spikes/phase0/FINDINGS.md` with PASS/FAIL per
sub-check (compile, health, ws-sync, static) and any errors verbatim.

- [ ] **Step 7: Commit**

```bash
git add spikes/phase0/FINDINGS.md
git commit -m "chore(spikes): record spike A — compiled sync server under bun"
```

### Task 3: Spike B — Vite client build driven by Bun

**Files:**
- Modify: `spikes/phase0/FINDINGS.md`

- [ ] **Step 1: Clean and build with Bun as the runtime**

```bash
rm -rf client/dist
cd client && bun --bun run build; cd ..
```

(`bun --bun run build` runs the package's `build` script — `tsc --noEmit &&
vite build` — forcing Bun as the JS runtime for both tools instead of Node.)

Expected: exit 0.

- [ ] **Step 2: Verify the output is a usable build**

```bash
test -f client/dist/index.html && ls client/dist/assets | head -5
```

Expected: `index.html` plus hashed JS/CSS assets.

- [ ] **Step 3: Record the result**

Update the Spike B row in `spikes/phase0/FINDINGS.md` (PASS, or the exact
tsc/vite error verbatim).

- [ ] **Step 4: Commit**

```bash
git add spikes/phase0/FINDINGS.md
git commit -m "chore(spikes): record spike B — vite build under bun"
```

### Task 4: Spike C — `@livekit/rtc-node` under Bun

**Files:**
- Modify: `spikes/phase0/FINDINGS.md`

Three escalating checks: module import, runtime start, compiled binary.
The transcriber (`transcriber/src/transcriber.ts`) reads `CANVAS_URL` /
`CANVAS_ROOM` env and joins LiveKit — for the spike we only need it to get
*past native-module load* and fail at the network layer.

- [ ] **Step 1: Import check under the Bun runtime**

```bash
cd transcriber && bun -e 'const m = await import("@livekit/rtc-node"); console.log("Room:", typeof m.Room)'; cd ..
```

Expected: `Room: function`. A napi/dlopen error here = FAIL for this check;
record it verbatim.

- [ ] **Step 2: Runtime start check**

```bash
cd transcriber && CANVAS_URL=http://localhost:1 CANVAS_ROOM=spike timeout 15 bun src/transcriber.ts; cd ..
```

Expected: the process starts, imports rtc-node, and fails with a
*connection/fetch* error against the bogus URL (or idles until timeout) —
NOT a module-load error. The distinction is the finding.

- [ ] **Step 3: Compiled-binary check (the hard one — embedded `.node` addon)**

```bash
bun build --compile transcriber/src/transcriber.ts --outfile spikes/phase0/dist/ew-transcriber
CANVAS_URL=http://localhost:1 CANVAS_ROOM=spike timeout 15 ./spikes/phase0/dist/ew-transcriber
```

Expected (PASS): compiles, and the binary reaches the same
connection-refused point as Step 2. Expected failure modes to record
verbatim: `bun build` unable to bundle the platform package
(`@livekit/rtc-node-linux-x64-gnu`), or the binary failing to dlopen the
embedded addon. A Step-3 failure with Steps 1–2 passing means: transcriber
runs under Bun *runtime* but ships as source + Bun rather than a compiled
artifact — record that nuance, it changes §6.5's asset list, not the
end state.

- [ ] **Step 4: Record the result**

Update the Spike C row in `spikes/phase0/FINDINGS.md` with per-check
results.

- [ ] **Step 5: Commit**

```bash
git add spikes/phase0/FINDINGS.md
git commit -m "chore(spikes): record spike C — rtc-node under bun"
```

### Task 5: Write findings back to the unified design

**Files:**
- Modify: `docs/unified-architecture-design.md` (§2.1)

- [ ] **Step 1: Append a results block to §2.1**

Under the existing spike-results bullets in §2.1, add (with the real
results from `spikes/phase0/FINDINGS.md`):

```markdown
Phase-0 battery results (2026-07-XX, see `spikes/phase0/FINDINGS.md`):

- Spike A (compiled sync server): <PASS/FAIL + one-line note>
- Spike B (Vite build under Bun): <PASS/FAIL + one-line note>
- Spike C (rtc-node under Bun): <import/runtime/compiled results + one-line note>
```

Replace the placeholders with actual results — and if any spike failed,
add one sentence to the affected component row in §2.2 stating the chosen
fallback (per the failure modes named in Tasks 2–4).

- [ ] **Step 2: Commit**

```bash
git add docs/unified-architecture-design.md
git commit -m "docs: write phase-0 spike results back to unified design"
```

---

## Part B — Phase 1: `@ensembleworks/contracts`

### Task 6: Scaffold the contracts workspace

**Files:**
- Create: `contracts/package.json`
- Create: `contracts/tsconfig.json`
- Create: `contracts/src/index.ts`
- Modify: `package.json` (root: workspaces + typecheck script)
- Modify: `server/tsconfig.json`, `client/tsconfig.json`, `transcriber/tsconfig.json` (paths mapping)

- [ ] **Step 1: Create `contracts/package.json`**

```json
{
  "name": "@ensembleworks/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tldraw/validate": "^5.1.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

(Source-only package: `exports` points at `.ts` — tsx, Bun and Vite all
resolve and transpile it; there is no build step, matching the repo's
tsx-run-the-source style.)

- [ ] **Step 2: Create `contracts/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `contracts/src/index.ts`**

```ts
// @ensembleworks/contracts — the single source of truth for shapes, wire
// protocols and shared conventions. See docs/unified-architecture-design.md §1.5.
export {}
```

(Exports fill in over Tasks 7–11.)

- [ ] **Step 4: Register the workspace and root typecheck**

In root `package.json`, change the workspaces array to:

```json
  "workspaces": [
    "contracts",
    "client",
    "server",
    "transcriber"
  ],
```

and prepend contracts to the root `typecheck` script:

```json
    "typecheck": "npm run typecheck --workspace=contracts && npm run typecheck --workspace=client && npm run typecheck --workspace=server && npm run typecheck --workspace=transcriber && tsc -p bin/tsconfig.json"
```

- [ ] **Step 5: Add a tsconfig `paths` mapping in each consumer**

So each workspace's `tsc --noEmit` typechecks the contracts *source*. In
`server/tsconfig.json`, `client/tsconfig.json` and
`transcriber/tsconfig.json`, add inside `compilerOptions`:

```json
    "paths": {
      "@ensembleworks/contracts": ["../contracts/src/index.ts"]
    }
```

(If a config has no `baseUrl`, `paths` with relative entries still works in
TS ≥ 5.0. If `tsc` later reports TS6059 "not under rootDir", delete the
`rootDir` option from that config — `noEmit` configs don't need it.)

- [ ] **Step 6: Install and verify**

```bash
npm install
npm run typecheck
```

Expected: all workspaces pass (contracts is empty but valid).

- [ ] **Step 7: Commit**

```bash
git add contracts package.json package-lock.json server/tsconfig.json client/tsconfig.json transcriber/tsconfig.json
git commit -m "feat(contracts): scaffold @ensembleworks/contracts workspace"
```

### Task 7: Move shape prop schemas into contracts

**Files:**
- Create: `contracts/src/shapes.ts`
- Modify: `contracts/src/index.ts`
- Modify: `server/src/schema.ts`
- Modify: `client/src/terminal/TerminalShapeUtil.tsx`, `client/src/iframe/IframeShapeUtil.tsx`, `client/src/neko/NekoShapeUtil.tsx`, `client/src/roadmap/RoadmapShapeUtil.tsx`, `client/src/screenshare/ScreenShareShapeUtil.tsx`

- [ ] **Step 1: Create `contracts/src/shapes.ts`** (content moved verbatim from
`server/src/schema.ts`, comments included):

```ts
/**
 * Custom-shape prop validators — the ONE definition. The server assembles
 * its tlschema from these; each client ShapeUtil uses the same object as
 * its static props. (Formerly duplicated between server/src/schema.ts and
 * five client ShapeUtils, held together by "Keep in sync" comments.)
 */
import { T } from '@tldraw/validate'

export const terminalShapeProps = {
	w: T.number,
	h: T.number,
	sessionId: T.string,
	title: T.string,
	// Optional status light set via POST /api/terminal-status; optional so
	// existing rooms need no migration.
	status: T.string.optional(),
	// Remote gateway id (spike); optional so existing rooms need no migration.
	gateway: T.string.optional(),
}

export const iframeShapeProps = {
	w: T.number,
	h: T.number,
	url: T.string,
	title: T.string,
}

export const nekoShapeProps = {
	w: T.number,
	h: T.number,
	base: T.string,
	title: T.string,
}

export const roadmapShapeProps = {
	w: T.number,
	h: T.number,
	// Slug id of the roadmap document this shape renders (see roadmap-store.ts).
	roadmapId: T.string,
	// Bumped by POST /api/roadmap on every write so clients refetch; optional
	// so existing rooms need no migration.
	rev: T.number.optional(),
}

export const screenshareShapeProps = {
	w: T.number,
	h: T.number,
	// LiveKit identity of the sharer + their published track name — the join
	// key between the canvas shape and the media plane.
	participantId: T.string,
	trackName: T.string,
	title: T.string,
	// Captured surface aspect (width/height); updated by the sharer's client
	// when the shared window is resized.
	aspect: T.number,
	// /uploads URL of the final frame, stamped by the sharer when the share
	// ends; optional so live shares and existing rooms need no migration.
	stillUrl: T.string.optional(),
	// Hex of the sharer's identity colour, stamped at creation so every viewer
	// sees the same owner-coloured border; optional so existing tiles need no
	// migration (border falls back to the neutral rule colour).
	ownerColor: T.string.optional(),
}
```

- [ ] **Step 2: Export from `contracts/src/index.ts`**

```ts
export * from './shapes.ts'
```

(Replace the placeholder `export {}`.)

- [ ] **Step 3: Rewrite `server/src/schema.ts` to consume contracts**

Replace the five local `…ShapeProps` consts (and their "Keep in sync"
comments) with one import, keeping everything else identical:

```ts
/**
 * The store schema shared by every room. Shape prop validators live in
 * @ensembleworks/contracts — the same objects each client ShapeUtil uses.
 */
import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas } from '@tldraw/tlschema'
import {
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
	},
	bindings: defaultBindingSchemas,
	// …keep the remainder of the existing file (lines after the createTLSchema
	// call) exactly as it is today.
})
```

(Diff-check before committing: `git diff server/src/schema.ts` must show
only the const removals and the import — no prop changed. Keel 1 of the
unified design depends on prop shapes staying byte-identical.)

- [ ] **Step 4: Point each client ShapeUtil at the shared props**

Same mechanical edit in all five files. In
`client/src/terminal/TerminalShapeUtil.tsx`: add
`import { terminalShapeProps } from '@ensembleworks/contracts'` and replace

```ts
	static override props = {
		w: T.number,
		h: T.number,
		sessionId: T.string,
		title: T.string,
		status: T.string.optional(),
		gateway: T.string.optional(),
	}
```

with

```ts
	static override props = terminalShapeProps
```

Repeat in the other four files with their prop sets:
`IframeShapeUtil.tsx` → `iframeShapeProps`, `NekoShapeUtil.tsx` →
`nekoShapeProps`, `RoadmapShapeUtil.tsx` → `roadmapShapeProps`,
`ScreenShareShapeUtil.tsx` → `screenshareShapeProps`. In each file, delete
the now-unused `T` import if nothing else in the file uses `T`, and delete
any "Keep in sync with server/src/schema.ts" comments.

- [ ] **Step 5: Typecheck and build**

```bash
npm run typecheck && npm run build
```

Expected: PASS. (The tldraw type for each shape's props is inferred from
the shared object, so a drifted prop would fail right here.)

- [ ] **Step 6: Behavioural smoke — existing room still loads**

```bash
DATA_DIR=$(mktemp -d) npx tsx server/src/sync-server.ts &
sleep 2
(cd server && npx tsx src/smoke-client.ts)
kill %1
```

Expected: `server replied: connect …`, exit 0 (schema serialisation
round-trips).

- [ ] **Step 7: Commit**

```bash
git add contracts/src client/src server/src/schema.ts
git commit -m "feat(contracts): single-source custom shape props"
```

### Task 8: Terminal WS protocol into contracts

**Files:**
- Create: `contracts/src/terminal-protocol.ts`
- Modify: `contracts/src/index.ts`
- Modify: `server/src/terminal-gateway.ts`
- Modify: the client terminal component that sends `input`/`resize` (locate in Step 1)

- [ ] **Step 1: Extract the exact message shapes from both ends**

```bash
grep -n "JSON.stringify({\|JSON.parse(" server/src/terminal-gateway.ts
grep -rn "type: *'input'\|type: *'resize'\|'attached'\|'exit'" client/src/terminal/*.ts client/src/terminal/*.tsx
```

Note every literal message constructed or parsed — the Zod schemas in Step
2 must match these fields exactly (the protocol comment in
`terminal-gateway.ts:16-19` documents: client→server
`{type:'input',data} | {type:'resize',cols,rows}`; server→client control
`{type:'resize'|'exit'|'attached', …}`; adjust the Step-2 field lists to
whatever the grep shows as the real payloads).

- [ ] **Step 2: Create `contracts/src/terminal-protocol.ts`**

```ts
/**
 * The terminal WS wire protocol (browser ⇄ gateway/connector), formerly a
 * comment in server/src/terminal-gateway.ts. Terminal output travels as
 * BINARY frames (raw utf-8 bytes); everything below is the TEXT-frame
 * control channel. The remote connector (unified-architecture-design.md §6)
 * speaks exactly this protocol.
 */
import { z } from 'zod'

export const termClientMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('input'), data: z.string() }),
	z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
])
export type TermClientMessage = z.infer<typeof termClientMessage>

export const termServerMessage = z.discriminatedUnion('type', [
	z.object({ type: z.literal('resize'), cols: z.number().int().positive(), rows: z.number().int().positive() }),
	z.object({ type: z.literal('exit') }),
	z.object({ type: z.literal('attached') }),
])
export type TermServerMessage = z.infer<typeof termServerMessage>
```

Add any extra fields Step 1 revealed (e.g. an exit code on `exit`) so the
schemas match reality — the gateway's existing behaviour is the spec.

- [ ] **Step 3: Export from `contracts/src/index.ts`**

```ts
export * from './shapes.ts'
export * from './terminal-protocol.ts'
```

- [ ] **Step 4: Adopt in the gateway**

In `server/src/terminal-gateway.ts`: import
`termClientMessage, type TermServerMessage` from
`'@ensembleworks/contracts'`; where incoming text frames are
`JSON.parse`d, parse with `termClientMessage.safeParse(...)` and ignore
frames where `!result.success` (preserving today's behaviour for unknown
messages — check what the current code does with them first and keep it);
type the outgoing control-message constructors as `TermServerMessage`.
Delete the wire-protocol comment block (lines 16–19) — the contract is now
code — leaving a pointer: `// Wire protocol: see @ensembleworks/contracts terminal-protocol`.

- [ ] **Step 5: Adopt in the client**

In the file(s) Step 1 located: import the two types and annotate the
send/receive sites (`const msg: TermClientMessage = { type: 'input', data }`
etc.). No behaviour change — types only on the client (the browser doesn't
need runtime Zod validation of its own outgoing frames).

- [ ] **Step 6: Typecheck + gateway tests**

```bash
npm run typecheck
cd server && npx tsx --test src/gateway-plane.test.ts src/relay-loopback.test.ts; cd ..
```

Expected: PASS. (If `tsx --test` isn't how these run, the test files'
headers say how — the repo convention is a "Run with:" comment.)

- [ ] **Step 7: Commit**

```bash
git add contracts/src server/src/terminal-gateway.ts client/src/terminal
git commit -m "feat(contracts): terminal WS protocol as zod schemas"
```

### Task 9: Terminal statuses + tmux prefix into contracts

**Files:**
- Create: `contracts/src/constants.ts`
- Modify: `contracts/src/index.ts`
- Modify: `server/src/app.ts` (line ~69: `TERMINAL_STATUSES`)
- Modify: `server/src/terminal-gateway.ts` (line ~31: `TMUX_PREFIX`)

- [ ] **Step 1: Create `contracts/src/constants.ts`**

```ts
/**
 * Conventions that were previously protocol-by-naming across app.ts,
 * terminal-gateway.ts and bin/canvas.
 */

/** Valid values of the terminal shape's status light (POST /api/terminal-status). */
export const TERMINAL_STATUSES = ['working', 'needs-you', 'done', 'idle'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

/** tmux sessions backing canvas terminals are named `canvas-<sessionId>`. */
export const TMUX_SESSION_PREFIX = 'canvas-'
```

- [ ] **Step 2: Export from `contracts/src/index.ts`** (append `export * from './constants.ts'`)

- [ ] **Step 3: Replace the server copies**

In `server/src/app.ts`: delete
`const TERMINAL_STATUSES = ['working', 'needs-you', 'done', 'idle']` and
import `TERMINAL_STATUSES` from `'@ensembleworks/contracts'`. The
`.includes(status)` check at ~line 507 needs a readonly-array-friendly
form: `(TERMINAL_STATUSES as readonly string[]).includes(status)`.

In `server/src/terminal-gateway.ts`: delete
`const TMUX_PREFIX = 'canvas-'` and import
`TMUX_SESSION_PREFIX` from `'@ensembleworks/contracts'`, renaming usages
(`grep -n "TMUX_PREFIX" server/src/terminal-gateway.ts` to find them all).

- [ ] **Step 4: Check for a client-side status list**

```bash
grep -rn "needs-you" client/src bin/dev-lib.mjs
```

If a client file hardcodes the same list (e.g. status-light colours), point
it at `TERMINAL_STATUSES` too; colour *values* stay client-side. `bin/canvas`
keeps its bash copy — it dies at Phase 3.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add contracts/src server/src client/src
git commit -m "feat(contracts): shared terminal statuses + tmux prefix"
```

### Task 10: Spatial stamp into contracts

**Files:**
- Rename: `client/src/presence/stamp.ts` → `contracts/src/stamp.ts`
- Rename: `client/src/presence/stamp.test.ts` → `contracts/src/stamp.test.ts`
- Create: shim at `client/src/presence/stamp.ts`
- Modify: `server/src/app.ts` (`SpatialStamp` ~line 160, `parseStamp` ~line 168)
- Modify: `contracts/src/index.ts`

- [ ] **Step 1: Move the pure module and its tests**

```bash
git mv client/src/presence/stamp.ts contracts/src/stamp.ts
git mv client/src/presence/stamp.test.ts contracts/src/stamp.test.ts
```

In `contracts/src/stamp.test.ts`, fix the relative import if needed (it is
`from './stamp'` — change to `from './stamp.ts'` to satisfy nodenext) and
update its header comment to `Run with: npx tsx contracts/src/stamp.test.ts`.

- [ ] **Step 2: Move the server-side trust boundary in beside it**

Cut `interface SpatialStamp` and `function parseStamp` out of
`server/src/app.ts` (lines ~160–186) and append them to
`contracts/src/stamp.ts` (exported, JSDoc preserved: parseStamp is the
server's trust boundary for client-asserted presence — it must stay
paranoid). In `app.ts`, import them from `'@ensembleworks/contracts'` and
**keep a re-export** so the existing test import keeps working:

```ts
export { parseStamp, type SpatialStamp } from '@ensembleworks/contracts'
```

(`server/src/scribe-api.test.ts` imports `parseStamp` from `./app.ts`.)

- [ ] **Step 3: Shim the old client path**

Create `client/src/presence/stamp.ts`:

```ts
// Moved to @ensembleworks/contracts (shared with the server's transcript
// stamping). This shim keeps client-internal imports stable.
export * from '@ensembleworks/contracts'
```

(Client importers like `getUserPresence` keep their `'./stamp'` imports;
the update-stamp comment in stamp.ts's header pointing at "server/src/app.ts"
should now point at contracts.)

- [ ] **Step 4: Run the moved tests + the server tests that exercise parseStamp**

```bash
npx tsx contracts/src/stamp.test.ts
cd server && npx tsx --test src/scribe-api.test.ts; cd ..
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add contracts/src client/src/presence server/src/app.ts
git commit -m "feat(contracts): spatial stamp shared by client + server"
```

### Task 11: slugify into contracts

**Files:**
- Create: `contracts/src/slug.ts`
- Modify: `contracts/src/index.ts`
- Modify: `client/src/roadmap/model.ts` (~line 99), `server/src/roadmap-store.ts` (~line 75)

- [ ] **Step 1: Create `contracts/src/slug.ts`** (the function is char-identical
in both current copies):

```ts
/**
 * Roadmap-name slugification — the id under which a roadmap is stored and
 * fuzzily matched. Client (model.ts) and server (roadmap-store.ts) must
 * agree or pushes create duplicates.
 */
export function slugify(name: string): string | null {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return /^[a-z0-9][a-z0-9_-]*$/.test(slug) ? slug : null
}
```

- [ ] **Step 2: Export from index, delete both copies**

Append `export * from './slug.ts'` to `contracts/src/index.ts`. In
`client/src/roadmap/model.ts` and `server/src/roadmap-store.ts`: delete the
local `slugify` + its "Keep in sync" comment, add
`import { slugify } from '@ensembleworks/contracts'` — but note
`model.ts` currently *exports* slugify, so make it a re-export there:
`export { slugify } from '@ensembleworks/contracts'`.

- [ ] **Step 3: Run the roadmap tests**

```bash
cd server && npx tsx --test src/roadmap-store.test.ts src/roadmap-api.test.ts; cd ..
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add contracts/src client/src/roadmap/model.ts server/src/roadmap-store.ts
git commit -m "feat(contracts): single slugify for roadmap ids"
```

### Task 12: Final sweep and full verification

**Files:**
- Possibly modify: stragglers found by the sweep

- [ ] **Step 1: Sweep for surviving keep-in-sync markers**

```bash
grep -rn "Keep in sync" server/src client/src contracts/src bin/canvas
```

Expected survivors, each with a reason: `client/src/theme.ts` (CSS custom
properties — client-internal, not a contract), anything inside `bin/canvas`
(dies at Phase 3). Any *other* survivor pointing across the client/server
boundary: either extract it the same way as Tasks 9–11 (if mechanical) or
list it in the plan-completion report as deferred with a reason.

- [ ] **Step 2: Full check battery**

```bash
npm run typecheck && npm run build
DATA_DIR=$(mktemp -d) npx tsx server/src/sync-server.ts &
sleep 2
(cd server && npx tsx src/smoke-client.ts)
kill %1
```

Expected: everything green.

- [ ] **Step 3: Commit any sweep fixes**

```bash
git add -A && git commit -m "feat(contracts): finish keep-in-sync extraction sweep"
```

(Skip the commit if the sweep changed nothing.)
