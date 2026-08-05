# Terminal Fan-In Fix (Connector Plane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The codespaces connector becomes the terminal: it removes device
queries from all browser-bound output (live fan-out and scrollback ring) and
answers them itself from a pinned capability profile plus tracked mode bits;
browser xterm.js suppression ships as defense-in-depth.

**Architecture:** New shared module in `contracts/` with two entry points —
browser-safe `terminal-identity` (profile, colours, sequence table,
registration helper) and server-only `terminal-responder` (streaming
`process`/`flush` transformer). The connector's `pty.onData` loop is the
single integration point. Legacy gateway (`server/src/terminal-gateway.ts`)
untouched.

**Tech Stack:** TypeScript on Bun, bun:test, `@xterm/headless` (contracts
dev-dependency, test oracle), `@xterm/xterm` ^6.0.0 (client, already
present).

**Spec:** `docs/superpowers/specs/2026-07-26-terminal-fanin-design.md` — the
per-sequence disposition matrix in its appendix is the normative behaviour
table for every task below.

## Global Constraints

- `contracts/` must never import from `client/` or `cli/` (workspace layering).
- Browser bundles must never pull `terminal-responder` — it is exported only
  via `@ensembleworks/contracts/terminal-responder`, never from the root
  barrel `contracts/src/index.ts`.
- The legacy plane is byte-for-byte untouched: no changes to
  `server/src/terminal-gateway.ts`, and client handler registration happens
  only when `shape.props.gateway` is set.
- Client suppression handlers return `true` only for exact pure-query forms;
  setter/ambiguous forms return `false` (default handling).
- No `final: 'R'` (CPR-reply-shaped) handler is ever registered client-side.
- Canonical terminal colours: background `#fff`, foreground `#0f172a`
  (values moved from `client/src/theme.ts`; OSC replies use xterm 16-bit
  doubling: `#fff` → `rgb:ffff/ffff/ffff`, `#0f172a` → `rgb:0f0f/1717/2a2a`).
- Pinned DA1 reply `\x1b[?1;2c`; pinned DA2 reply `\x1b[>0;276;0c`; DSR-5
  reply `\x1b[0n`.
- Verify with `bun run typecheck` and `bun run build` before finishing.
- Commits: conventional-commit style, `Co-Authored-By: Claude Fable 5
  <noreply@anthropic.com>` trailer.
- PR body must include: `ux-contract: none — no gesture interaction surface;
  byte-stream plumbing`.

## File Structure

- Create `contracts/src/terminal-identity.ts` — browser-safe constants:
  `TERMINAL_CANONICAL_COLORS`, `CAPABILITY_PROFILE`, `TRACKED_MODES`,
  `oscColorReply()`, `registerTerminalIdentityHandlers()` (structural typing,
  no xterm import).
- Create `contracts/src/terminal-identity.test.ts`.
- Create `contracts/src/terminal-responder.ts` — server-only
  `createQueryResponder()`.
- Create `contracts/src/terminal-responder.test.ts`.
- Create `contracts/src/terminal-honesty.test.ts` — headless-xterm oracle.
- Modify `contracts/package.json` — two new export entries + `@xterm/headless`
  devDependency.
- Modify `client/src/theme.ts` — import canonical colours from contracts.
- Modify `cli/src/connector/session.ts` + `session.test.ts` — wire responder.
- Modify `cli/src/connector/index.ts` — pass `cfg.backend` through.
- Modify `client/src/terminal/TerminalShapeUtil.tsx` and
  `client/src/canvas-v2/shapes/TerminalShape.tsx` — register handlers when
  connector-backed.
- Create `client/src/terminal/identityHandlers.test.ts` — real-xterm
  suppression/survival tests.

---

### Task 1: terminal-identity constants + canonical colours move

**Files:**
- Create: `contracts/src/terminal-identity.ts`
- Create: `contracts/src/terminal-identity.test.ts`
- Modify: `contracts/package.json` (exports map)
- Modify: `client/src/theme.ts` (import the colour constants)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2–8):
  - `TERMINAL_CANONICAL_COLORS: { background: '#fff'; foreground: '#0f172a' }`
  - `CAPABILITY_PROFILE: { da1: string; da2: string; dsrOk: string; modes: Record<number, 0 | 2> }`
  - `TRACKED_MODES: readonly number[]` (`[2004, 2026, 1016]`)
  - `oscColorReply(ps: 10 | 11): string`

- [ ] **Step 1: Write the failing test**

```ts
// contracts/src/terminal-identity.test.ts
import { describe, expect, test } from 'bun:test'
import {
	CAPABILITY_PROFILE,
	oscColorReply,
	TERMINAL_CANONICAL_COLORS,
	TRACKED_MODES,
} from './terminal-identity.ts'

describe('terminal-identity constants', () => {
	test('canonical colours match the paper terminal theme', () => {
		expect(TERMINAL_CANONICAL_COLORS.background).toBe('#fff')
		expect(TERMINAL_CANONICAL_COLORS.foreground).toBe('#0f172a')
	})

	test('pinned identity replies', () => {
		expect(CAPABILITY_PROFILE.da1).toBe('\x1b[?1;2c')
		expect(CAPABILITY_PROFILE.da2).toBe('\x1b[>0;276;0c')
		expect(CAPABILITY_PROFILE.dsrOk).toBe('\x1b[0n')
	})

	test('DECRPM initial states: tracked modes reset, 1004 unsupported', () => {
		expect(CAPABILITY_PROFILE.modes[2004]).toBe(2)
		expect(CAPABILITY_PROFILE.modes[2026]).toBe(2)
		expect(CAPABILITY_PROFILE.modes[1016]).toBe(2)
		expect(CAPABILITY_PROFILE.modes[1004]).toBe(0)
		expect(TRACKED_MODES).toEqual([2004, 2026, 1016])
	})

	test('OSC colour replies use 16-bit doubled rgb with ST terminator', () => {
		expect(oscColorReply(11)).toBe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
		expect(oscColorReply(10)).toBe('\x1b]10;rgb:0f0f/1717/2a2a\x1b\\')
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test contracts/src/terminal-identity.test.ts`
Expected: FAIL — `Cannot find module './terminal-identity.ts'`

- [ ] **Step 3: Write the module**

```ts
// contracts/src/terminal-identity.ts
/**
 * The product's declared terminal identity for shared (multi-viewer)
 * terminals on the codespaces connector plane. Browser-safe: strings only,
 * no Node APIs, no xterm import (the registration helper uses structural
 * typing). Spec: docs/superpowers/specs/2026-07-26-terminal-fanin-design.md.
 *
 * The legacy gateway (server/src/terminal-gateway.ts) never imports this —
 * plane independence is a spec decision, not an accident.
 */

/** Single source for the terminal's canonical colours. client/src/theme.ts
 *  imports these (contracts must never import client). */
export const TERMINAL_CANONICAL_COLORS = {
	background: '#fff',
	foreground: '#0f172a',
} as const

/** DECRPM states: 0 = not recognised, 1 = set, 2 = reset. */
export const TRACKED_MODES = [2004, 2026, 1016] as const

export const CAPABILITY_PROFILE = {
	da1: '\x1b[?1;2c',
	da2: '\x1b[>0;276;0c',
	dsrOk: '\x1b[0n',
	/** Initial DECRPM state per profiled mode. 1004 is DECLARED unsupported
	 *  (shared focus is meaningless); anything absent answers 0. */
	modes: { 2004: 2, 2026: 2, 1016: 2, 1004: 0 } as Record<number, 0 | 2>,
} as const

/** xterm's OSC colour replies double 8-bit channels to 16-bit (xx → xxxx). */
function rgbSpec(hex: string): string {
	const h = hex.replace('#', '')
	const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
	const [r, g, b] = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)]
	return `rgb:${r}${r}/${g}${g}/${b}${b}`
}

export function oscColorReply(ps: 10 | 11): string {
	const hex = ps === 11 ? TERMINAL_CANONICAL_COLORS.background : TERMINAL_CANONICAL_COLORS.foreground
	return `\x1b]${ps};${rgbSpec(hex)}\x1b\\`
}
```

- [ ] **Step 4: Add the export entry**

In `contracts/package.json`, extend the `exports` map:

```json
"exports": {
	".": "./src/index.ts",
	"./session-manager": "./src/session-manager.ts",
	"./relay-parity": "./src/relay-parity.ts",
	"./terminal-identity": "./src/terminal-identity.ts",
	"./terminal-responder": "./src/terminal-responder.ts"
}
```

(`terminal-responder.ts` lands in Task 2; the entry is added now so the map
is edited once. Do NOT re-export either module from `contracts/src/index.ts`
— the root barrel is browser-bundled.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test contracts/src/terminal-identity.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Point client/src/theme.ts at the constants**

In `client/src/theme.ts`, add the import at the top and replace the two
literals inside `paperTerminalTheme`:

```ts
import { TERMINAL_CANONICAL_COLORS } from '@ensembleworks/contracts/terminal-identity'
```

```ts
export const paperTerminalTheme = {
	// Pure white so terminals match the other frames (iframe/web views),
	// reading as fresh sheets laid over the room's warmer paper.
	background: TERMINAL_CANONICAL_COLORS.background,
	foreground: TERMINAL_CANONICAL_COLORS.foreground,
	...
```

Note: `wm.ink` is `'#0f172a'`, so `foreground` keeps its exact value — this
inverts ownership only. Leave `wm.ink` itself untouched (other UI uses it).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 8: Commit**

```bash
git add contracts/src/terminal-identity.ts contracts/src/terminal-identity.test.ts contracts/package.json client/src/theme.ts
git commit -m "feat(contracts): terminal-identity — canonical colours + pinned capability profile

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: responder core — stateless queries (DA1/DA2/DA3, DSR-5, XTVERSION, kitty)

**Files:**
- Create: `contracts/src/terminal-responder.ts`
- Create: `contracts/src/terminal-responder.test.ts`

**Interfaces:**
- Consumes: `CAPABILITY_PROFILE` from Task 1.
- Produces (used by Tasks 3–7):
  - `createQueryResponder(opts: { backend: 'tmux' | 'pty' }): QueryResponder`
  - `interface QueryResponder { process(chunk: Uint8Array): ResponderResult; flush(reason: 'attach' | 'snapshot' | 'exit'): Uint8Array }`
  - `interface ResponderResult { live: Uint8Array; history: Uint8Array; replies: Uint8Array[] }`
- In this task `flush` may return the raw carry unconditionally and the carry
  buffer may be naive (whole-chunk processing only); Task 5 hardens both.

- [ ] **Step 1: Write the failing tests**

```ts
// contracts/src/terminal-responder.test.ts
import { describe, expect, test } from 'bun:test'
import { createQueryResponder } from './terminal-responder.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const run = (backend: 'tmux' | 'pty', ...chunks: string[]) => {
	const r = createQueryResponder({ backend })
	const out = { live: '', history: '', replies: [] as string[] }
	for (const c of chunks) {
		const res = r.process(enc.encode(c))
		out.live += dec.decode(res.live)
		out.history += dec.decode(res.history)
		out.replies.push(...res.replies.map((b) => dec.decode(b)))
	}
	return { ...out, responder: r }
}

describe('stateless queries (spec matrix rows DA1/DA2/DA3/DSR/XTVERSION/kitty)', () => {
	test('DA1 bare and with param 0: scrubbed from both streams, answered from profile', () => {
		for (const q of ['\x1b[c', '\x1b[0c']) {
			const out = run('tmux', `before${q}after`)
			expect(out.live).toBe('beforeafter')
			expect(out.history).toBe('beforeafter')
			expect(out.replies).toEqual(['\x1b[?1;2c'])
		}
	})

	test('DA2 scrubbed + answered; DA3 and XTVERSION and kitty scrubbed, unanswered', () => {
		const out = run('tmux', 'a\x1b[>cb\x1b[=cc\x1b[>0qd\x1b[?ue')
		expect(out.live).toBe('abcde')
		expect(out.replies).toEqual(['\x1b[>0;276;0c'])
	})

	test('DSR-5 answered ok; ordinary output and SGR sequences untouched', () => {
		const out = run('tmux', '\x1b[31mred\x1b[0m\x1b[5n')
		expect(out.live).toBe('\x1b[31mred\x1b[0m')
		expect(out.replies).toEqual(['\x1b[0n'])
	})

	test('multiple queries in one chunk each get one reply, in stream order', () => {
		const out = run('tmux', '\x1b[c mid \x1b[5n')
		expect(out.live).toBe(' mid ')
		expect(out.replies).toEqual(['\x1b[?1;2c', '\x1b[0n'])
	})

	test('DA-reply-shaped bytes are NOT treated as queries (we parse queries only)', () => {
		// A reply travelling outbound would only occur if tmux echoed one; the
		// responder must not answer replies. \x1b[?1;2c has prefix ? — no query
		// matcher covers it.
		const out = run('tmux', '\x1b[?1;2c')
		expect(out.replies).toEqual([])
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: FAIL — `Cannot find module './terminal-responder.ts'`

- [ ] **Step 3: Write the module**

```ts
// contracts/src/terminal-responder.ts
/**
 * Server-only streaming transformer: the connector-side half of the
 * terminal-identity contract. Scans OUTBOUND pty bytes (app → renderers)
 * for device queries, removes them from browser-bound output, and produces
 * the profile's replies for the connector to write back into the pty.
 *
 * Parses QUERIES only, never replies — so the CPR-vs-modified-F3 reply
 * ambiguity (field report §8) cannot occur here by construction.
 *
 * NEVER export through contracts' root barrel (browser bundles).
 * Spec: docs/superpowers/specs/2026-07-26-terminal-fanin-design.md.
 */
import { CAPABILITY_PROFILE, oscColorReply, TRACKED_MODES } from './terminal-identity.ts'

export interface ResponderResult {
	live: Uint8Array
	history: Uint8Array
	replies: Uint8Array[]
}

export interface QueryResponder {
	process(chunk: Uint8Array): ResponderResult
	flush(reason: 'attach' | 'snapshot' | 'exit'): Uint8Array
}

// Internally we work on latin1 strings: escape sequences are pure ASCII and
// latin1 round-trips every byte value, so UTF-8 payload bytes pass through
// bit-identical.
const toLatin1 = (b: Uint8Array): string => {
	let s = ''
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
	return s
}
const fromLatin1 = (s: string): Uint8Array => {
	const b = new Uint8Array(s.length)
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
	return b
}

// One alternation of every sequence the matrix gives a disposition for.
// Groups: [1] CSI body for queries/DECSET/DECRST/DECSTR, [2] OSC 10/11 body.
// RIS (\x1bc) matches via the bare alternative.
const SEQ_RE =
	// biome-ignore lint: deliberate control chars — this is a terminal protocol scanner
	/\x1b\[(0?c|>[0-9;]*c|=[0-9;]*c|5n|6n|\?[0-9;]+\$p|>0?q|\?u|\?[0-9;]+[hl]|!p)|\x1b\](1[01];[^\x07\x1b]*)(?:\x07|\x1b\\)|\x1bc/g

interface Sink {
	live: string
	history: string
	replies: string[]
}

/** Dispositions for one matched sequence. Tasks 3–5 extend this switch. */
function handle(body: string | undefined, osc: string | undefined, whole: string, out: Sink, backend: 'tmux' | 'pty'): void {
	if (osc !== undefined) {
		out.live += whole // Task 4 replaces this branch
		out.history += whole
		return
	}
	if (body === undefined) {
		// bare \x1bc = RIS; Task 3 resets tracked modes. Pass through (it must
		// still reset the renderers).
		out.live += whole
		out.history += whole
		return
	}
	if (body === 'c' || body === '0c') {
		out.replies.push(CAPABILITY_PROFILE.da1)
		return // scrubbed
	}
	if (body.startsWith('>') && body.endsWith('c')) {
		out.replies.push(CAPABILITY_PROFILE.da2)
		return
	}
	if (body.startsWith('=') && body.endsWith('c')) return // DA3: scrub, no answer
	if (body === '5n') {
		out.replies.push(CAPABILITY_PROFILE.dsrOk)
		return
	}
	if (body === '6n') {
		// CPR — Task 5 makes this backend-dependent; until then scrub.
		if (backend === 'pty') {
			out.live += whole
			out.history += whole
		}
		return
	}
	if (body.endsWith('q')) return // XTVERSION: scrub, no answer
	if (body === '?u') return // kitty keyboard probe: scrub, no answer
	// DECRQM / DECSET / DECRST / DECSTR — Task 3 implements; pass through.
	out.live += whole
	out.history += whole
}

export function createQueryResponder(opts: { backend: 'tmux' | 'pty' }): QueryResponder {
	let carry = ''
	return {
		process(chunk: Uint8Array): ResponderResult {
			const s = carry + toLatin1(chunk)
			carry = '' // Task 5 implements real carry splitting
			const out: Sink = { live: '', history: '', replies: [] }
			let last = 0
			SEQ_RE.lastIndex = 0
			for (let m = SEQ_RE.exec(s); m !== null; m = SEQ_RE.exec(s)) {
				const plain = s.slice(last, m.index)
				out.live += plain
				out.history += plain
				handle(m[1], m[2], m[0], out, opts.backend)
				last = SEQ_RE.lastIndex
			}
			const tail = s.slice(last)
			out.live += tail
			out.history += tail
			return {
				live: fromLatin1(out.live),
				history: fromLatin1(out.history),
				replies: out.replies.map(fromLatin1),
			}
		},
		flush(): Uint8Array {
			const pending = carry
			carry = ''
			return fromLatin1(pending)
		},
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add contracts/src/terminal-responder.ts contracts/src/terminal-responder.test.ts
git commit -m "feat(contracts): terminal-responder — stateless device-query scrub + profile answers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: responder — DECRQM from tracked mode bits; 1004 stripped; resets

**Files:**
- Modify: `contracts/src/terminal-responder.ts`
- Modify: `contracts/src/terminal-responder.test.ts` (append describe block)

**Interfaces:**
- Consumes: Task 2's module internals (`handle`, `Sink`), Task 1's
  `CAPABILITY_PROFILE.modes`, `TRACKED_MODES`.
- Produces: DECRQM answers reflect DECSET/DECRST history; `?1004` stripped
  from outbound mode sequences. No signature changes.

- [ ] **Step 1: Write the failing tests** (append to `terminal-responder.test.ts`)

```ts
describe('DECRQM tracked state + 1004 stripping (spec decisions 5 and 6)', () => {
	test('initial states: tracked modes reset(2), 1004 and unknown not recognised(0)', () => {
		const out = run('tmux', '\x1b[?2004$p\x1b[?1004$p\x1b[?2027$p')
		expect(out.replies).toEqual(['\x1b[?2004;2$y', '\x1b[?1004;0$y', '\x1b[?2027;0$y'])
		expect(out.live).toBe('')
	})

	test('DECSET flips tracked mode to set(1); DECRST back to reset(2); sequences pass through', () => {
		const out = run('tmux', '\x1b[?2004h\x1b[?2004$p\x1b[?2004l\x1b[?2004$p')
		expect(out.replies).toEqual(['\x1b[?2004;1$y', '\x1b[?2004;2$y'])
		expect(out.live).toBe('\x1b[?2004h\x1b[?2004l')
	})

	test('RIS and DECSTR reset tracked modes to initial', () => {
		const out = run('tmux', '\x1b[?2026h\x1bc\x1b[?2026$p')
		expect(out.replies).toEqual(['\x1b[?2026;2$y'])
		const out2 = run('tmux', '\x1b[?2026h\x1b[!p\x1b[?2026$p')
		expect(out2.replies).toEqual(['\x1b[?2026;2$y'])
	})

	test('?1004 stripped from DECSET, other params in the same sequence preserved', () => {
		const out = run('tmux', '\x1b[?1004h\x1b[?1004;2004h\x1b[?2004;1004;2026h')
		expect(out.live).toBe('\x1b[?2004h\x1b[?2004;2026h')
	})

	test('DECSET of an untracked mode passes through and does not change answers', () => {
		const out = run('tmux', '\x1b[?25h\x1b[?2027$p')
		expect(out.live).toBe('\x1b[?25h')
		expect(out.replies).toEqual(['\x1b[?2027;0$y'])
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: the new describe block FAILS (DECRQM currently passes through
unanswered; 1004 not stripped)

- [ ] **Step 3: Implement**

In `terminal-responder.ts`, make `handle` a method over per-responder state.
Replace the `handle` free function and the factory body with:

```ts
class ResponderState {
	modes: Map<number, 0 | 1 | 2>
	constructor() {
		this.modes = new Map(Object.entries(CAPABILITY_PROFILE.modes).map(([k, v]) => [Number(k), v]))
	}
	reset(): void {
		for (const m of TRACKED_MODES) this.modes.set(m, 2)
	}
	decrqmReply(mode: number): string {
		const state = this.modes.get(mode) ?? 0
		return `\x1b[?${mode};${state}$y`
	}
	/** DECSET/DECRST: update tracked bits; return the sequence to forward
	 *  with ?1004 removed (empty string when 1004 was the only mode). */
	modeSequence(body: string): string {
		const set = body.endsWith('h')
		const params = body.slice(1, -1).split(';').map(Number)
		for (const p of params) {
			if ((TRACKED_MODES as readonly number[]).includes(p)) this.modes.set(p, set ? 1 : 2)
		}
		const kept = params.filter((p) => p !== 1004)
		if (kept.length === 0) return ''
		return `\x1b[?${kept.join(';')}${set ? 'h' : 'l'}`
	}
}
```

Inside `handle` (now taking `state: ResponderState` as an extra argument;
`createQueryResponder` constructs one `ResponderState` per responder and
passes it through), replace the final pass-through branch:

```ts
	if (body.startsWith('?') && body.endsWith('$p')) {
		out.replies.push(state.decrqmReply(Number(body.slice(1, -2))))
		return // scrubbed
	}
	if (body.startsWith('?') && (body.endsWith('h') || body.endsWith('l'))) {
		const fwd = state.modeSequence(body)
		out.live += fwd
		out.history += fwd
		return
	}
	if (body === '!p') {
		state.reset() // DECSTR
		out.live += whole
		out.history += whole
		return
	}
	// unreachable for matched bodies; keep pass-through as safety
	out.live += whole
	out.history += whole
```

And in the RIS branch (`body === undefined`, bare `\x1bc`), call
`state.reset()` before passing the bytes through.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: PASS (all describe blocks)

- [ ] **Step 5: Commit**

```bash
git add contracts/src/terminal-responder.ts contracts/src/terminal-responder.test.ts
git commit -m "feat(contracts): DECRQM answered from tracked mode bits; 1004 declared unsupported + stripped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: responder — OSC 10/11 queries answered, setters pass through

**Files:**
- Modify: `contracts/src/terminal-responder.ts`
- Modify: `contracts/src/terminal-responder.test.ts` (append)

**Interfaces:**
- Consumes: `oscColorReply` from Task 1.
- Produces: OSC 10/11 `?`-form scrubbed + answered; setter forms untouched.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe('OSC 10/11 (spec decision 4: pin queries, pass setters)', () => {
	test('query form answered with canonical colours, both BEL and ST terminators', () => {
		const st = run('tmux', '\x1b]11;?\x1b\\')
		expect(st.replies).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
		expect(st.live).toBe('')
		const bel = run('tmux', '\x1b]10;?\x07')
		expect(bel.replies).toEqual(['\x1b]10;rgb:0f0f/1717/2a2a\x1b\\'])
		expect(bel.live).toBe('')
	})

	test('setter form passes through untouched and is not answered', () => {
		const out = run('tmux', '\x1b]11;#1a1a2e\x07plain')
		expect(out.live).toBe('\x1b]11;#1a1a2e\x07plain')
		expect(out.replies).toEqual([])
	})

	test('OSC 4 passes through entirely (phase 2, not handled)', () => {
		const out = run('tmux', '\x1b]4;0;?\x07')
		expect(out.live).toBe('\x1b]4;0;?\x07')
		expect(out.replies).toEqual([])
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: new block FAILS (OSC branch currently passes queries through)

- [ ] **Step 3: Implement**

Replace the OSC branch in `handle`:

```ts
	if (osc !== undefined) {
		// osc = "10;<payload>" or "11;<payload>" (regex group excludes terminator)
		const ps = Number(osc.slice(0, 2)) as 10 | 11
		const payload = osc.slice(3)
		if (payload === '?') {
			out.replies.push(oscColorReply(ps))
			return // scrubbed
		}
		out.live += whole // setter: renderers must apply it
		out.history += whole
		return
	}
```

(OSC 4 never matches `SEQ_RE` — its `1[01];` prefix excludes it — so it
passes through in the plain-text path; the test above locks that in.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add contracts/src/terminal-responder.ts contracts/src/terminal-responder.test.ts
git commit -m "feat(contracts): OSC 10/11 queries answered from canonical colours; setters pass through

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: responder — carry buffer for split sequences, flush lifecycle, CPR per backend

**Files:**
- Modify: `contracts/src/terminal-responder.ts`
- Modify: `contracts/src/terminal-responder.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 2–4 internals.
- Produces: the final `QueryResponder` contract Task 7 wires in — split
  queries recognised across chunks; `flush('attach' | 'snapshot' | 'exit')`
  semantics; CPR scrubbed on tmux, passed through on pty.

- [ ] **Step 1: Write the failing tests** (append)

```ts
describe('carry buffer + flush lifecycle (spec: connector integration)', () => {
	test('a query split at EVERY byte boundary is still recognised once', () => {
		const q = '\x1b[?2004$p'
		for (let cut = 1; cut < q.length; cut++) {
			const out = run('tmux', 'a' + q.slice(0, cut), q.slice(cut) + 'b')
			expect(out.live).toBe('ab')
			expect(out.replies).toEqual(['\x1b[?2004;2$y'])
		}
	})

	test('a split OSC query spanning three chunks is recognised', () => {
		const out = run('tmux', 'x\x1b]1', '1;', '?\x1b\\y')
		expect(out.live).toBe('xy')
		expect(out.replies).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
	})

	test('incomplete prefix with no further output is returned by flush, not lost', () => {
		const r = createQueryResponder({ backend: 'tmux' })
		const res = r.process(enc.encode('tail\x1b[?20'))
		expect(dec.decode(res.live)).toBe('tail')
		expect(dec.decode(r.flush('attach'))).toBe('\x1b[?20')
		// after flush the carry is gone
		expect(dec.decode(r.flush('exit'))).toBe('')
	})

	test('lone ESC then plain text is not swallowed', () => {
		const out = run('tmux', 'a\x1b', 'plain')
		expect(out.live).toBe('a\x1bplain')
	})

	test('malformed over-long candidate is flushed as ordinary output at the 64-byte bound', () => {
		const junk = '\x1b]11;' + 'x'.repeat(80) // no terminator
		const out = run('tmux', junk, 'end\x07')
		expect(out.live).toBe(junk + 'end\x07')
		expect(out.replies).toEqual([])
	})

	test('CPR: scrubbed unanswered on tmux backend, passes through on pty backend', () => {
		expect(run('tmux', 'a\x1b[6nb').live).toBe('ab')
		expect(run('pty', 'a\x1b[6nb').live).toBe('a\x1b[6nb')
		expect(run('pty', 'a\x1b[6nb').replies).toEqual([])
	})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: split-boundary and flush tests FAIL (carry currently naive)

- [ ] **Step 3: Implement carry splitting**

In `terminal-responder.ts` add:

```ts
const MAX_CARRY = 64

/** Longest tail of s that could be the prefix of a recognisable sequence.
 *  Empty string when the tail is definitely ordinary output. */
function pendingPrefix(s: string): string {
	const esc = s.lastIndexOf('\x1b')
	if (esc === -1) return ''
	const tail = s.slice(esc)
	if (tail.length > MAX_CARRY) return ''
	// Could this still grow into a match? Candidate prefixes:
	//   \x1b            (could become CSI or OSC or RIS — but bare \x1bc
	//                    already matched; a lone trailing ESC must be held)
	//   \x1b[ + params  (no final byte yet)
	//   \x1b]1, \x1b]10, \x1b]11;payload (no BEL/ST yet), incl. trailing \x1b
	//   of an unfinished ST
	// biome-ignore lint: control chars deliberate
	const partial = /^\x1b$|^\x1b\[[0-9;?>=!$]*$|^\x1b\](?:1[01]?)?$|^\x1b\]1[01];[^\x07\x1b]*\x1b?$/
	return partial.test(tail) ? tail : ''
}
```

In `process`, replace the naive carry handling:

```ts
		process(chunk: Uint8Array): ResponderResult {
			const s = carry + toLatin1(chunk)
			const hold = pendingPrefix(s)
			carry = hold
			const scan = hold ? s.slice(0, s.length - hold.length) : s
			const out: Sink = { live: '', history: '', replies: [] }
			// ... existing SEQ_RE loop over `scan` unchanged ...
		}
```

`flush` keeps its Task 2 body (return carry, clear it) — the lifecycle
semantics live at the call sites Task 7 wires: `attach` and `snapshot`
append the returned bytes to the ring, `exit` discards them.

- [ ] **Step 4: Run the full responder suite**

Run: `bun test contracts/src/terminal-responder.test.ts`
Expected: PASS — including every earlier describe block (no regressions)

- [ ] **Step 5: Commit**

```bash
git add contracts/src/terminal-responder.ts contracts/src/terminal-responder.test.ts
git commit -m "feat(contracts): responder carry buffer, flush lifecycle, backend-scoped CPR

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: profile honesty — headless xterm oracle + version pin

**Files:**
- Create: `contracts/src/terminal-honesty.test.ts`
- Modify: `contracts/package.json` (add devDependency `@xterm/headless`
  pinned to the client's `@xterm/xterm` range: `^6.0.0`)

**Interfaces:**
- Consumes: `CAPABILITY_PROFILE`, `createQueryResponder`.
- Produces: CI gate only.

- [ ] **Step 1: Add the dependency**

In `contracts/package.json` devDependencies add `"@xterm/headless": "^6.0.0"`,
then run: `bun install`
Expected: lockfile updated, install clean.

- [ ] **Step 2: Write the test**

```ts
// contracts/src/terminal-honesty.test.ts
/**
 * The profile must stay honest against the real emulator we ship. Headless
 * xterm is the oracle for the CSI family ONLY — it has no browser colour
 * manager, so OSC 10/11 are asserted in the client suite instead
 * (client/src/terminal/identityHandlers.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { readFileSync } from 'node:fs'
import { CAPABILITY_PROFILE } from './terminal-identity.ts'

function ask(term: Terminal, query: string): Promise<string> {
	return new Promise((resolve) => {
		let acc = ''
		const d = term.onData((data) => {
			acc += data
			d.dispose()
			resolve(acc)
		})
		term.write(query)
		// a query xterm ignores produces no data; settle after the write flushes
		term.write('', () => setTimeout(() => { d.dispose(); resolve(acc) }, 20))
	})
}

describe('capability profile honesty vs headless xterm (CSI family)', () => {
	test('DA1 reply matches the profile', async () => {
		expect(await ask(new Terminal(), '\x1b[c')).toBe(CAPABILITY_PROFILE.da1)
	})

	test('DECRPM initial states match for tracked modes', async () => {
		for (const mode of [2004, 2026, 1016]) {
			const reply = await ask(new Terminal(), `\x1b[?${mode}$p`)
			expect(reply).toBe(`\x1b[?${mode};${CAPABILITY_PROFILE.modes[mode]}$y`)
		}
	})

	test('DECSET transition: xterm reports set(1) after ?2004h, matching tracked answers', async () => {
		const term = new Terminal()
		term.write('\x1b[?2004h')
		expect(await ask(term, '\x1b[?2004$p')).toBe('\x1b[?2004;1$y')
	})

	test('headless xterm version matches the client xterm version range', () => {
		const contracts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
		const client = JSON.parse(readFileSync(new URL('../../client/package.json', import.meta.url), 'utf8'))
		expect(contracts.devDependencies['@xterm/headless']).toBe(client.dependencies['@xterm/xterm'])
	})
})
```

- [ ] **Step 3: Run and reconcile**

Run: `bun test contracts/src/terminal-honesty.test.ts`
Expected: PASS. If a CSI assertion fails, the emulator's truth wins: update
`CAPABILITY_PROFILE` (and the corresponding responder test expectations) to
what xterm actually replies, then re-run the full contracts suite. Note the
DA2 pinned reply (`\x1b[>0;276;0c`) is deliberately NOT asserted against
headless xterm — it is a product identity choice, not an emulator echo.

- [ ] **Step 4: Commit**

```bash
git add contracts/src/terminal-honesty.test.ts contracts/package.json bun.lock
git commit -m "test(contracts): headless-xterm honesty oracle for the CSI profile + version pin

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: connector wiring — session.ts onData/attach/snapshot + backend plumb

**Files:**
- Modify: `cli/src/connector/session.ts`
- Modify: `cli/src/connector/index.ts` (pass `cfg.backend`)
- Modify: `cli/src/connector/session.test.ts` (append)

**Interfaces:**
- Consumes: `createQueryResponder`, `QueryResponder` from
  `@ensembleworks/contracts/terminal-responder`.
- Produces: `ConnectorSessionManager` constructor gains an optional second
  argument `opts?: { backend?: 'tmux' | 'pty' }` (default `'tmux'`).
  `SessionState` gains `responder: QueryResponder`. No other public change.

- [ ] **Step 1: Write the failing tests** (append to `session.test.ts`,
  following its existing fake-`TmuxSession`/fake-sink pattern — reuse the
  file's existing helpers for spawning fakes; the snippets below assume a
  fake pty whose `write` calls are recorded in `writes: string[]` and sinks
  whose `sendOutput` payloads are recorded per sink)

```ts
describe('device-query fan-in (spec: connector integration)', () => {
	test('a DA1 query in pty output is answered exactly once and never reaches sinks', () => {
		const { mgr, pty } = makeManager() // existing helper pattern
		const a = makeSink()
		const b = makeSink()
		mgr.attach('s1', 1, 80, 24, a)
		mgr.attach('s1', 2, 80, 24, b)
		pty.emitData('before\x1b[cafter')
		expect(pty.writes).toEqual(['\x1b[?1;2c']) // one reply, written to the pty
		expect(a.output.join('')).toBe('beforeafter') // scrubbed for every sink
		expect(b.output.join('')).toBe('beforeafter')
	})

	test('the ring never stores queries: a late attacher replays clean bytes', () => {
		const { mgr, pty } = makeManager()
		mgr.attach('s1', 1, 80, 24, makeSink())
		pty.emitData('history\x1b[?2004$pmore')
		const late = makeSink()
		mgr.attach('s1', 2, 80, 24, late)
		expect(late.output.join('')).toBe('historymore')
	})

	test('a stale client that echoes whatever it receives has nothing to echo', () => {
		const { mgr, pty } = makeManager()
		const stale = makeSink()
		// simulate a stale client: echo every received byte back as input
		stale.onOutput = (bytes) => mgr.input('s1', 3, bytes)
		mgr.attach('s1', 3, 80, 24, stale)
		pty.emitData('\x1b[c\x1b[>c')
		// pty received ONLY the responder's replies — no echoed queries
		expect(pty.writes).toEqual(['\x1b[?1;2c', '\x1b[>0;276;0c'])
	})

	test('preseeded history from an older connector is scrubbed when consumed', () => {
		const { mgr } = makeManager()
		mgr.preseedLayout({
			version: 1,
			sessions: [{ id: 's1', scrollbackTail: Buffer.from('old\x1b[cbytes').toString('base64') }],
		})
		const sink = makeSink()
		mgr.attach('s1', 1, 80, 24, sink)
		expect(sink.output.join('')).toBe('oldbytes')
	})

	test('pty backend: CPR passes through to sinks and is not answered', () => {
		const { mgr, pty } = makeManager({ backend: 'pty' })
		const sink = makeSink()
		mgr.attach('s1', 1, 80, 24, sink)
		pty.emitData('a\x1b[6nb')
		expect(sink.output.join('')).toBe('a\x1b[6nb')
		expect(pty.writes).toEqual([])
	})
})
```

Adapt `makeManager` to accept `{ backend }` and pass it as the manager's
second constructor argument. If the existing file names its helpers
differently, follow the file — the behaviours above are what is being
locked in, and the existing tests must keep passing unmodified.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test cli/src/connector/session.test.ts`
Expected: new block FAILS (queries currently fan out raw; no replies)

- [ ] **Step 3: Implement**

In `cli/src/connector/session.ts`:

```ts
import { createQueryResponder, type QueryResponder } from '@ensembleworks/contracts/terminal-responder'
```

`SessionState` gains `responder: QueryResponder`. Constructor:

```ts
	constructor(
		private readonly spawn: SpawnFactory,
		private readonly opts: { backend: 'tmux' | 'pty' } = { backend: 'tmux' },
	) {}
```

In `getOrCreate`, scrub any preseed history once and create the responder:

```ts
		const seed = this.seeded.get(id)
		this.seeded.delete(id)
		const responder = createQueryResponder({ backend: this.opts.backend })
		let seedHistory = seed?.history ?? Buffer.alloc(0)
		if (seedHistory.byteLength > 0) {
			// seed may predate scrubbing (older connector): clean it once
			const scrubber = createQueryResponder({ backend: this.opts.backend })
			const res = scrubber.process(seedHistory)
			seedHistory = Buffer.concat([Buffer.from(res.history), Buffer.from(scrubber.flush('snapshot'))])
		}
		const pty = this.spawn(id, grid.cols, grid.rows, seed?.cwd)
		const s: SessionState = {
			pty,
			responder,
			ring: seedHistory.byteLength > 0 ? [seedHistory] : [],
			ringBytes: seedHistory.byteLength,
			channels: new Map(),
			gone: false,
		}
```

Replace the `onData` body:

```ts
		pty.onData((data) => {
			const { live, history, replies } = s.responder.process(Buffer.from(data, 'utf8'))
			for (const reply of replies) s.pty.write(Buffer.from(reply).toString('latin1'))
			if (history.byteLength > 0) {
				const buf = Buffer.from(history)
				s.ring.push(buf)
				s.ringBytes += buf.byteLength
				while (s.ringBytes > SCROLLBACK_LIMIT && s.ring.length > 1) s.ringBytes -= s.ring.shift()!.byteLength
			}
			if (live.byteLength > 0) {
				const out = Buffer.from(live)
				for (const sink of s.channels.values()) sink.sendOutput(out)
			}
		})
```

In `attach`, flush pending carry into the ring before replay (so a held
prefix is not withheld from a newcomer's screen):

```ts
		const pending = Buffer.from(s.responder.flush('attach'))
		if (pending.byteLength > 0) {
			s.ring.push(pending)
			s.ringBytes += pending.byteLength
			for (const sink of s.channels.values()) sink.sendOutput(pending)
		}
		sink.sendMsg({ type: 'attached', cols: s.pty.cols, rows: s.pty.rows })
		for (const chunk of s.ring) sink.sendOutput(chunk)
```

In `snapshotLayout`, flush before capping the tail:

```ts
				const pending = Buffer.from(s.responder.flush('snapshot'))
				if (pending.byteLength > 0) {
					s.ring.push(pending)
					s.ringBytes += pending.byteLength
				}
				const scrollbackTail = capTail(s.ring).toString('base64')
```

(`exit`/`onExit` needs no flush call — the carry dies with the session,
which IS the 'exit' semantics.)

In `cli/src/connector/index.ts`, pass the backend through where the manager
is constructed (around line 50):

```ts
	const mgr = new ConnectorSessionManager(
		(id, cols, rows, cwd) => openTmuxSession(spawnSpecFor(cfg.backend, id, env, cwd), cols, rows),
		{ backend: cfg.backend },
	)
```

- [ ] **Step 4: Run the connector suite**

Run: `bun test cli/src/connector/`
Expected: PASS — new block green, ALL pre-existing tests still green
(replay-atomicity and exit-broadcast tests must not regress)

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add cli/src/connector/session.ts cli/src/connector/index.ts cli/src/connector/session.test.ts
git commit -m "feat(cli): connector answers device queries as the terminal; browsers never see them

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: client backstop — registration helper + both terminal components

**Files:**
- Modify: `contracts/src/terminal-identity.ts` (add
  `registerTerminalIdentityHandlers`)
- Create: `client/src/terminal/identityHandlers.test.ts`
- Modify: `client/src/terminal/TerminalShapeUtil.tsx` (register when
  `shape.props.gateway` set)
- Modify: `client/src/canvas-v2/shapes/TerminalShape.tsx` (register when
  `gateway` set)

**Interfaces:**
- Consumes: `oscColorReply` internals — no; only matcher knowledge from the
  spec matrix.
- Produces: `registerTerminalIdentityHandlers(term: IdentityTerminal): void`
  where `IdentityTerminal` is a structural type (no xterm import in
  contracts):

```ts
export interface IdentityTerminal {
	parser: {
		registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, cb: (params: (number | number[])[]) => boolean): unknown
		registerOscHandler(ident: number, cb: (data: string) => boolean): unknown
	}
}
```

- [ ] **Step 1: Write the failing test** (client suite has real `@xterm/xterm`)

```ts
// client/src/terminal/identityHandlers.test.ts
/**
 * Backstop suppression: if a query somehow reaches a browser (responder
 * missed it / stale connector), xterm must not auto-reply. Also the OSC
 * colour oracle the headless honesty test cannot provide (headless xterm
 * has no colour manager).
 */
import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/xterm'
import { registerTerminalIdentityHandlers } from '@ensembleworks/contracts/terminal-identity'

function collect(term: Terminal): string[] {
	const out: string[] = []
	term.onData((d) => out.push(d))
	return out
}
const write = (term: Terminal, s: string) => new Promise<void>((r) => term.write(s, r))

describe('registerTerminalIdentityHandlers', () => {
	test('suppresses DA1/DA2/DECRQM/kitty queries — no auto-reply', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b[c\x1b[>c\x1b[?2004$p\x1b[?u')
		await new Promise((r) => setTimeout(r, 20))
		expect(out).toEqual([])
	})

	test('unregistered terminal DOES auto-reply to DA1 (sanity: the suppression is doing something)', async () => {
		const term = new Terminal()
		const out = collect(term)
		await write(term, '\x1b[c')
		await new Promise((r) => setTimeout(r, 20))
		expect(out.join('')).not.toBe('')
	})

	test('DSR-5 suppressed but CPR (6n) still auto-replies — no final-R ambiguity introduced', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b[5n')
		await new Promise((r) => setTimeout(r, 20))
		expect(out).toEqual([])
		await write(term, '\x1b[6n')
		await new Promise((r) => setTimeout(r, 20))
		expect(out.join('')).toMatch(/^\x1b\[\d+;\d+R$/) // pty-backend CPR must flow
	})

	test('OSC 11 query suppressed; OSC 11 setter still applies (handler returns false)', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b]11;?\x1b\\') // query: suppressed
		await write(term, '\x1b]11;#1a1a2e\x1b\\') // setter: default handling
		await new Promise((r) => setTimeout(r, 20))
		expect(out).toEqual([])
	})

	test('bracketed paste survives: enabling 2004 and pasting still brackets', async () => {
		const term = new Terminal()
		registerTerminalIdentityHandlers(term)
		const out = collect(term)
		await write(term, '\x1b[?2004h')
		term.paste('hello')
		expect(out.join('')).toBe('\x1b[200~hello\x1b[201~')
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test client/src/terminal/identityHandlers.test.ts`
Expected: FAIL — `registerTerminalIdentityHandlers` not exported

- [ ] **Step 3: Implement the helper** (append to
  `contracts/src/terminal-identity.ts`)

```ts
/** Structural slice of xterm.js Terminal — contracts must not depend on
 *  @xterm/xterm; the client passes its real Terminal instance. */
export interface IdentityTerminal {
	parser: {
		registerCsiHandler(
			id: { prefix?: string; intermediates?: string; final: string },
			cb: (params: (number | number[])[]) => boolean,
		): unknown
		registerOscHandler(ident: number, cb: (data: string) => boolean): unknown
	}
}

/**
 * Defense-in-depth for connector-backed terminals: the connector's responder
 * normally removes every query before fan-out; these handlers make a browser
 * that sees one anyway stay silent. Return true = handled (no auto-reply);
 * return false = default xterm behaviour (used for setter/ambiguous forms).
 *
 * NEVER registers a final:'R' handler (CPR-reply shape = modified F3 shape,
 * field report §8) and never suppresses CSI 6n (pty-backend CPR must flow).
 */
export function registerTerminalIdentityHandlers(term: IdentityTerminal): void {
	const p = term.parser
	p.registerCsiHandler({ final: 'c' }, () => true) // DA1
	p.registerCsiHandler({ prefix: '>', final: 'c' }, () => true) // DA2
	p.registerCsiHandler({ prefix: '=', final: 'c' }, () => true) // DA3
	p.registerCsiHandler({ final: 'n' }, (params) => params[0] === 5) // DSR-5 only; 6n → false
	p.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => true) // DECRQM
	p.registerCsiHandler({ prefix: '>', final: 'q' }, () => true) // XTVERSION
	p.registerCsiHandler({ prefix: '?', final: 'u' }, () => true) // kitty probe
	for (const ident of [10, 11] as const) {
		p.registerOscHandler(ident, (data) => data === '?') // query form only
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test client/src/terminal/identityHandlers.test.ts`
Expected: PASS (6 tests). If the `{ final: 'n' }` handler signature differs
in xterm 6 (params array shape), consult
`node_modules/@xterm/xterm/typings/xterm.d.ts` and adjust the structural
type to match — the type is ours, the runtime contract is xterm's.

- [ ] **Step 5: Register in both components, gated on the gateway prop**

`client/src/terminal/TerminalShapeUtil.tsx` — immediately after the
`new Terminal({...})` construction (~line 283):

```ts
		if (shape.props.gateway) registerTerminalIdentityHandlers(term)
```

`client/src/canvas-v2/shapes/TerminalShape.tsx` — immediately after the
`new Terminal({...})` construction (~line 241), using the component's
existing `gateway` value (the one already passed to `termWsUrl` at ~line
305):

```ts
		if (gateway) registerTerminalIdentityHandlers(term)
```

Both files import:

```ts
import { registerTerminalIdentityHandlers } from '@ensembleworks/contracts/terminal-identity'
```

Legacy-plane terminals (`gateway` unset) get NO registration — byte-for-byte
untouched, per the scope decision.

- [ ] **Step 6: Typecheck + client suite**

Run: `bun run typecheck && bun test client/src/terminal/ client/src/canvas-v2/shapes/`
Expected: clean / PASS

- [ ] **Step 7: Commit**

```bash
git add contracts/src/terminal-identity.ts client/src/terminal/identityHandlers.test.ts client/src/terminal/TerminalShapeUtil.tsx client/src/canvas-v2/shapes/TerminalShape.tsx
git commit -m "feat(client): xterm identity-handler backstop on connector-backed terminals only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: full gates + manual verification notes

**Files:**
- No new files. Verification + PR prep.

**Interfaces:**
- Consumes: everything above.
- Produces: green build, PR-ready branch.

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all suites pass, including every pre-existing suite

- [ ] **Step 2: Typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: clean. The build step also proves the browser bundle resolves
`terminal-identity` without dragging in `terminal-responder` (a Node-API
import error here means the export split leaked).

- [ ] **Step 3: Manual two-client verification (record results in the PR body)**

Field report §15 recipe against a dev stack with a connector-backed
codespace terminal:

1. Open the same codespace terminal in TWO browser tabs.
2. Hard-reload one tab — prompt must stay clean (no `1;2c…` garbage).
3. In the terminal: `for i in $(seq 1 10); do printf '\033Ptmux;\033\033[c\033\\'; printf '\033Ptmux;\033\033[>c\033\\'; done`
   — prompt must stay clean; `tmux capture-pane -p` shows no reply bytes.
4. Run `opencode` (or any theme-adaptive TUI) — must render its LIGHT
   variant on the white terminal (OSC 11 answered `#fff`).
5. Focus/blur both windows — `tmux capture-pane -p` shows no `[I`/`[O`
   input.

- [ ] **Step 4: PR**

PR body must include:
- `ux-contract: none — no gesture interaction surface; byte-stream plumbing`
- The manual verification transcript from Step 3.
- Link to spec: `docs/superpowers/specs/2026-07-26-terminal-fanin-design.md`.

```bash
git push -u origin HEAD
```

(Branch/PR mechanics per the repo's normal flow; do not merge without the
manual verification recorded.)

---

## Self-Review Notes

- Spec coverage: Decision 1 (Tasks 2–5, 7), Decision 2 scope gating (Task 8
  step 5; no server/ changes anywhere), Decision 3 module split (Tasks 1–2,
  export map in Task 1; build proof in Task 9), Decision 4 OSC (Task 4 +
  client oracle in Task 8), Decision 5 DECRPM tracking (Task 3, honesty in
  Task 6), Decision 6 focus stripping (Task 3), Decision 7 CPR backends
  (Tasks 5, 7, and the never-register-R constraint in Task 8), Decision 8
  layering (Tasks 7–8), streaming API + flush lifecycle (Tasks 5, 7),
  disposition matrix rows (spread across Tasks 2–5 tests; OSC 4 pass-through
  locked in Task 4), two-client test obligation (Task 7), stale-client echo
  test (Task 7), paste/F3-survival regressions (Task 8), manual recipe
  (Task 9). Deferred follow-ups (session-manager fork, focus-events conf,
  OSC 4 answers) are deliberately absent per the spec.
- The `focus-events off` tmux-conf change is a spec deferred follow-up, NOT
  in this plan — the responder's 1004 stripping covers the connector plane
  regardless of conf.
- Type consistency: `QueryResponder`/`ResponderResult`/`createQueryResponder`
  named identically in Tasks 2, 5, 7; `registerTerminalIdentityHandlers` in
  Tasks 8's helper, test, and both component wirings;
  `TERMINAL_CANONICAL_COLORS` in Tasks 1 and 8's test comment.
