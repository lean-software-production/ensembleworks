# Terminal device-report fan-in fix — connector plane

**Date:** 2026-07-26
**Status:** approved (brainstormed section-by-section; revised same day after
independent model reviews — see Review provenance)
**Field report:** `docs/2026-07-26-shared-terminal-device-report-fanin.md`
**Scope:** codespaces connector plane only (`cli/src/connector/`), plus the
client suppression backstop it requires. The legacy main gateway
(`server/src/terminal-gateway.ts`) is explicitly out of scope — see Scope
decision.

## Problem

N browser xterm.js emulators attached to one PTY each answer every terminal
device query (DA1/DA2, DSR, DECRPM, OSC 10/11, …). The program that asked
consumes one answer; the surplus N−1 land in the shell as input — visible
garbage (`1;2c0;276;0c`), executed commands (`-bash: 1: command not found`),
and corruption of in-flight typing. Scrollback replay re-triggers it on every
reload/late-join with no typing. Full analysis, captures, and the option
survey live in the field report; this spec records the decisions for this
repo.

The connector (`cli/src/connector/session.ts:100`) writes client input to the
PTY raw and replays its scrollback ring verbatim on attach — both trigger
paths are live.

## Decisions

### 1. Architecture: the connector is the terminal (field report §12, Option 1, hardened)

The connector removes recognised queries from **all** browser-bound output —
live fan-out and the scrollback ring alike — and answers them itself from a
pinned capability profile plus a small tracked mode state. Browsers never see
a query, so they never reply, regardless of client version. Client-side
xterm.js suppression still ships, but as defense-in-depth, not as the
enforcement layer. Same authority shape as the existing (correct) resize
path.

Queries paint no pixels, so scrubbing them from live output costs renderers
nothing. This is the load-bearing hardening from review: enforcement lives
in one process we control (the connector), not in N browsers we hope are
up to date.

- Rejected — reply filtering at PTY-write: wire format is ambiguous (CPR
  collides with modified F3), the sequence set is open-ended, and it
  collapses if tmux is removed. Stopgap, not architecture.
- Rejected — elect one responder client: election/failover machinery for a
  benefit that only matters if you don't ship the client. We do.
- Rejected — gateway reply de-duplication: still parses reply shapes, so the
  ambiguity problem survives. (Also superseded: with live-output scrubbing,
  there are no surplus replies to de-duplicate.)
- Rejected — attach-handshake version gating of clients: unnecessary once
  browsers never see queries; noted as optional future hardening only.
- Rejected — per-session headless-xterm emulator as the authoritative
  terminal state (reviewer proposal): full-fidelity answers (CPR, OSC
  setter state) at the cost of a heavyweight runtime dependency and per-
  session CPU. Mode-bit tracking (below) covers the profiled surface;
  revisit if pty-backend multi-viewer or OSC-setter fidelity becomes a real
  need.

### 2. Scope: connector only; treat as connector work

Connector adoption retires the legacy gateway, so the architecture lands
where the future is. The two planes stay separate code paths.

- Accepted consequence, stated plainly: **the legacy main gateway keeps the
  fan-in bug (input injection with 2+ viewers) until it is retired.** This
  includes the `team` room, which is pinned to the legacy plane.
  - **CHANGE NOTE (2026-07-27):** partially stale. `main` independently
    landed `server/src/terminal-input-filter.ts` (merged into this branch),
    an input-side filter on the legacy gateway — the field report's
    Approach B: strip browser-generated DA1/DA2/DA3/DSR/DECRPM/XTVERSION/
    kitty replies from `{type:'input'}` frames before the PTY; OSC 10/11
    colour replies deliberately pass through (stripping them caused the
    measured opencode dark-on-white regression, and their surplus copies are
    consumed whole by readline, so they're harmless). Legacy prompt garbage
    is therefore mitigated, with that file's stated accepted limitations
    (split-frame replies can slip through; DECRPM probes get silence and
    apps fall back). The connector plane's scrub-and-answer architecture in
    this spec remains the full fix and is unchanged by it; the two planes
    still share no code.
- Client suppression backstop registers only for connector-backed terminals
  (`shape.props.gateway` set) — in **both** terminal components
  (`client/src/terminal/TerminalShapeUtil.tsx`,
  `client/src/canvas-v2/shapes/TerminalShape.tsx`); the legacy plane is
  byte-for-byte untouched.
- Rejected — both planes at once: wires a responder into a gateway scheduled
  for retirement and couples paths the plan wants separate.
- Rejected — client-wide suppression with connector-only responder: fixes
  legacy garbage but reintroduces the measured OSC-11 theme regression
  (opencode dark-on-white, field report §9) on legacy.

### 3. Module: `terminal-identity` in `contracts/`, split browser-safe / server-only

Follows the `relay-parity` precedent (shared client ↔ connector contract;
the legacy gateway never imports it). All exports derive from a single
sequence table — one edit updates responder, scrubber, and suppression
together. Two entry points so browser bundles never pull server code:

**`@ensembleworks/contracts/terminal-identity`** (browser-safe: strings /
`Uint8Array`, no Node APIs):

| Export | Role |
|---|---|
| `CAPABILITY_PROFILE` | Declared identity: DA1 `\e[?1;2c`, pinned DA2, DSR-ok, DECRPM initial-state table, OSC 10/11 colours |
| `TERMINAL_CANONICAL_COLORS` | The canonical terminal fg/bg (single source; `client/src/theme.ts` imports it — contracts must never import client) |
| `SEQUENCE_TABLE` | The per-sequence disposition matrix (appendix) |
| `registerTerminalIdentityHandlers(term)` | Ready-to-use registration of xterm.js CSI/OSC/DCS handlers with exact matcher objects (e.g. DA1 `{prefix:'?', final:'c'}`, DECRQM `{prefix:'?', intermediates:'$', final:'p'}`). OSC 10/11 handlers match the **query form (`?` payload) only** and return `false` for setter forms — a blanket `true` would swallow colour setters and break rendering |

**`@ensembleworks/contracts/terminal-responder`** (server-only):

| Export | Role |
|---|---|
| `createQueryResponder(profile)` | Stateful per-session streaming transformer (API below) |

- Rejected — home in `cli/`: the client must import the suppression list and
  a client→cli workspace dependency is new; client→contracts already exists.
- Rejected — duplicate tables in client and cli: drift on an open-ended set.

### 4. OSC 10/11 theme queries: pin in the profile

Answer OSC 11 with the canonical terminal background (`#fff`, now owned by
`TERMINAL_CANONICAL_COLORS` in contracts). Keeps app light/dark detection
working (the regression the field report measured with opencode).

Per-viewer theming via OSC is impossible in a shared PTY regardless — the
app paints one theme for all viewers. Pinning makes the single answer
deterministic instead of race-decided. Per-user light/dark viewing, if ever
wanted, is a render-side client feature (palette remap at display time) and
composes with a pinned profile.

Known fidelity gap, accepted: an app that *sets* OSC 10/11 colours and then
queries them back gets the pinned answer, not its own value. Setter
sequences pass through to renderers untouched. Revisit with the headless-
emulator option if this bites.

### 5. DECRPM: initial-state profile plus tracked mode bits

DECRPM reports current *state* (set/reset), not mere capability — a static
table becomes a liar the moment an app sends `CSI ? 2004 h`. The responder
therefore watches the outbound stream (which it already scans) for
DECSET/DECRST (`CSI ? Pm h/l`) and terminal resets (RIS, DECSTR) over the
profiled mode set, and answers DECRQM from tracked state.

Profiled modes, initial state honest per the shipped xterm.js:

| Mode | Initial reply | Note |
|---|---|---|
| 2004 bracketed paste | recognised, reset | tracked |
| 2026 synchronized output | recognised, reset | tracked |
| 1004 focus reporting | **not recognised (0)** | see Decision 6 |
| 1016 SGR-pixel mouse | recognised, reset | tracked |
| 2027, 2031, unknown | not recognised (0) | honest default |

### 6. Focus reporting (1004): declared unsupported and stripped

Shared focus is meaningless, and suppressing the DECRQM *query* is not
enough: `deploy/tmux-ensembleworks.conf:116` sets `focus-events on`, so tmux
actively emits `CSI ? 1004 h` outward, and xterm.js responds to that by
sending `\e[I`/`\e[O` per viewer — N contradictory focus streams into one
PTY.

- DECRQM 1004 answers "not recognised" (0).
- The responder strips `?1004` from outbound DECSET/DECRST sequences,
  preserving any other parameters in the same sequence.
- Follow-up: turn `focus-events` off for connector tmux sessions in the
  conf.

### 7. CPR (cursor position report): backend-dependent

The connector doesn't track cursor position (no screen model — that is what
keeps the responder cheap).

- **tmux backend (default):** tmux answers inner apps' CPR itself; outer CPR
  is essentially never asked. CPR queries reaching the outbound stream are
  scrubbed and unanswered.
- **pty backend (`--backend pty`, `cli/src/connector/index.ts:40` — raw
  shell, no tmux):** apps' CPR queries genuinely need an answer. They pass
  through to renderers untouched — single-viewer pty sessions behave exactly
  as today; multi-viewer pty sessions accept residual CPR fan-in as a
  documented limitation. Revisit (headless emulator or cursor tracking) if
  multi-viewer pty becomes a real usage.

Structural note, scoped precisely: the *connector-side* responder parses
queries only, never replies, so the CPR-vs-modified-F3 keystroke collision
(field report §8) cannot occur *in the responder*. Client-side, no `final:
'R'` handler is registered at all — browsers never see CPR queries on the
tmux backend, and on the pty backend the reply must flow. The collision is
avoided by never filtering replies anywhere.

### 8. Enforcement backstop layering

Primary: connector scrubs recognised queries from live fan-out and the ring
(one process, always current). Backstop: client xterm.js handler
suppression, for any query that reaches a browser via a path the responder
missed. Truly unknown sequence families are caught by neither — they remain
a residual compatibility risk, accepted as the status quo (they are the
status quo today for every terminal).

The ring stores scrubbed bytes, so replay to new attachers and the
`snapshotLayout`/`preseedLayout` tails are query-free by construction; seed
history written by an older connector is scrubbed once when consumed in
`getOrCreate`.

## Connector integration

One hook point — the `pty.onData` read-loop (`cli/src/connector/session.ts`),
which every PTY byte already passes:

```
pty.onData(data)
  └─► responder.process(data): { live, history, replies }
        ├─ replies  ──► s.pty.write(reply)   // connector answers as the terminal
        ├─ live     ──► live sinks           // recognised queries removed
        └─ history  ──► scrollback ring      // recognised queries removed
```

Streaming API (reviewer-hardened):

```ts
interface QueryResponder {
  process(chunk: Uint8Array): { live: Uint8Array; history: Uint8Array; replies: Uint8Array[] }
  flush(reason: 'attach' | 'snapshot' | 'exit'): Uint8Array // pending carry, if any
}
```

- Responder lives on `SessionState`, created in `getOrCreate`, dies with the
  session.
- Carry buffer bounded (~64 bytes) for sequences split across chunks. No
  valid terminator within the bound ⇒ not a query: emitted as ordinary
  output. `flush` defines the incomplete-prefix lifecycle: `attach` flushes
  pending carry into both streams before replay; `snapshot` flushes into
  history; `exit` discards. Both BEL and ST terminators recognised for
  OSC/DCS.
- `live` and `history` are currently identical streams; they are distinct in
  the API so a future divergence (e.g. answering CPR live but not storing
  it) needs no signature change. `scrubQueries` is internal to the
  responder — nothing else parses these bytes, so the scan happens exactly
  once.
- Replies write through the same `s.pty.write` as user input.
- Client backstop: `registerTerminalIdentityHandlers(term)` called in both
  terminal components when the shape is connector-backed.

## Error handling

- Detection never delays painting: `process` returns synchronously per
  chunk; only bytes that might be a query prefix (≤64) are ever held, and
  only until the next chunk or `flush`.
- Unknown queries pass through untouched (can't scrub what we don't
  recognise); the client backstop's finite table won't catch them either —
  residual risk, accepted (status quo for every terminal).
- Malformed sequences at the bound are flushed as ordinary output; the
  responder never stalls and never buffers unbounded.

## Testing

- **Unit (contracts, responder):** each sequence-table entry answered /
  scrubbed / passed per its disposition; every split point of every query;
  BEL and ST variants; malformed prefixes crossing the carry bound;
  multiple queries plus ordinary bytes in one chunk; DECSET → DECRQM →
  DECRST → DECRQM → reset transition answers; `?1004h` stripped with other
  parameters in the sequence preserved; `flush` lifecycle per reason.
- **Unit (contracts, profile honesty):** headless xterm.js is the oracle for
  the CSI family only (DA/DSR/DECRPM initial state + transitions) — it has
  no browser colour manager, so it cannot validate OSC 10/11. OSC answers
  are asserted against `TERMINAL_CANONICAL_COLORS` in a browser-level client
  test with the real theme instead. The headless dev-dependency is pinned to
  the client's xterm.js version (single workspace resolution; CI fails on
  drift).
- **Connector** (`session.test.ts` pattern, fake sinks): a query in `onData`
  produces exactly one `pty.write` reply; live sinks receive query-free
  bytes; the ring stays clean; a **two-sink attach** replays no queries —
  the field report's "test with two clients from day one" made mechanical.
  A "stale client" sink that echoes replies verifies nothing reaches it to
  echo.
- **Client:** handlers register only when the `gateway` prop is set, in both
  components; OSC setter forms still alter rendering (handler returns
  `false`); regression coverage that modified F3, mouse reports, and
  bracketed paste survive suppression untouched.
- **Interaction contract:** `ux-contract: none — no gesture interaction
  surface; byte-stream plumbing` in the PR body; the survival regressions
  above are the compensating evidence that real input is unaffected.
- **Manual verify:** field report §15 recipe — two browsers, DA burst via
  tmux passthrough, `tmux capture-pane` shows a clean prompt; plus
  focus/blur both windows and assert zero PTY input.

## Appendix: per-sequence disposition matrix

| Sequence (query) | Matcher | Answered? | Live fan-out | Ring | Client backstop |
|---|---|---|---|---|---|
| DA1 `CSI c` / `CSI 0 c` | `{final:'c'}` params ∅/0 | yes, profile | scrubbed | scrubbed | suppress |
| DA2 `CSI > c` | `{prefix:'>', final:'c'}` | yes, profile | scrubbed | scrubbed | suppress |
| DA3 `CSI = c` | `{prefix:'=', final:'c'}` | no (xterm.js has none) | scrubbed | scrubbed | suppress |
| DSR 5 `CSI 5 n` | `{final:'n'}` param 5 | yes, `CSI 0 n` | scrubbed | scrubbed | suppress |
| CPR `CSI 6 n` | `{final:'n'}` param 6 | no — tmux: scrub; pty: pass through | backend-dependent | backend-dependent | none (never registered) |
| DECRQM `CSI ? Ps $ p` | `{prefix:'?', intermediates:'$', final:'p'}` | yes, tracked state | scrubbed | scrubbed | suppress |
| XTVERSION `CSI > 0 q` | `{prefix:'>', final:'q'}` | no | scrubbed | scrubbed | suppress |
| OSC 10/11 `?` form | OSC 10, 11 payload `?` | yes, canonical colours | scrubbed | scrubbed | suppress query form only |
| OSC 10/11 setter form | OSC 10, 11 colour payload | n/a (not a query) | pass through | pass through | `false` (default handling) |
| OSC 4 `?` form | OSC 4 | no (phase 2) | pass through | pass through | none |
| Kitty keyboard `CSI ? u` | `{prefix:'?', final:'u'}` | no | scrubbed | scrubbed | suppress |
| DECSET/DECRST `CSI ? Pm h/l` | — | n/a (tracked, not answered) | `?1004` stripped, rest pass | same | none |

## What the planes share today (survey)

Recorded because plane independence drove the scope decision:

| Shared | Used by | Separable? |
|---|---|---|
| `contracts/terminal-protocol.ts` | both gateways + client | Trivial mechanically, no practically — one client speaks to both planes |
| `contracts/session-manager.ts` (+ `pty.ts`, `constants.ts`) | server gateway + connector | Yes (~150 pure lines) — deferred follow-up below |
| `contracts/relay-parity.ts` | connector + server splicer | No — the connector's own transport contract, not legacy coupling |
| Client terminal UI (`TerminalShapeUtil.tsx`, v2 `TerminalShape.tsx`, `termWsUrl`) | both planes via optional `shape.props.gateway` | Not easily — separate shape types mean client churn + room-data migration for a dying plane. Independence here is discipline, not file separation |
| Server relay splicer (`gateway-registry.ts`) | connector traffic transit | No, by architecture — browsers can't reach a codespace directly |

## Deferred follow-ups

- Fork `contracts/session-manager.ts` into `cli/` so the connector owns its
  tmux spawn primitive (independence chore, zero interaction with this work).
- Legacy main gateway keeps the fan-in bug until retirement (accepted;
  includes the `team` room).
- Turn `focus-events` off for connector tmux sessions in
  `deploy/tmux-ensembleworks.conf`.
- Per-viewer light/dark terminal theming as render-side palette remap.
- OSC 4 palette-entry answers (profile phase 2), OSC 10/11 setter-state
  tracking, and CPR on the pty backend — the headless-emulator option
  becomes attractive if two or more of these turn real.

## Review provenance

Independent reviews of the first approved draft were taken on 2026-07-26
from `opencode/gpt-5.6-sol` and `opencode/kimi-k2.7-code` (via the pi CLI),
then verified against the repo before adoption. Adopted: live fan-out
scrubbing (the enforcement inversion), DECRPM mode-bit tracking, 1004
declared-unsupported + DECSET stripping (conf line verified), canonical
colours moved into contracts (layer violation verified), pty-backend CPR
scoping (backend verified at `cli/src/connector/index.ts:40`), OSC
query-form-only handlers, unified `process`/`flush` streaming API,
browser-safe/server-only export split, registration helper, disposition
matrix, and the two-layer test oracle. Rejected: per-session headless
emulator, attach version gating, gateway reply de-dup, reopening the
legacy-plane scope decision.
