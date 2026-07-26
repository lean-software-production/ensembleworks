# Terminal device-report fan-in fix — connector plane

**Date:** 2026-07-26
**Status:** approved (brainstormed section-by-section)
**Field report:** `docs/2026-07-26-shared-terminal-device-report-fanin.md`
**Scope:** codespaces connector plane only (`cli/src/connector/`), plus the
client suppression it requires. The legacy main gateway
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

### 1. Architecture: gateway-is-the-terminal (field report §12, Option 1)

The connector answers queries from a pinned capability profile; browsers
never reply. Same authority shape as the existing (correct) resize path.

- Rejected — reply filtering at PTY-write: wire format is ambiguous (CPR
  collides with modified F3), the sequence set is open-ended, and it
  collapses if tmux is removed. Stopgap, not architecture.
- Rejected — elect one responder client: election/failover machinery for a
  benefit that only matters if you don't ship the client. We do.
- Rejected — gateway reply de-duplication: still parses reply shapes, so the
  ambiguity problem survives.

### 2. Scope: connector only; treat as connector work

Connector adoption retires the legacy gateway, so the architecture lands
where the future is. The two planes stay separate code paths.

- Accepted consequence, stated plainly: **the legacy main gateway keeps the
  fan-in bug (input injection with 2+ viewers) until it is retired.**
- Client suppression registers only for connector-backed terminals
  (`shape.props.gateway` set); the legacy plane is byte-for-byte untouched.
- Rejected — both planes at once: wires a responder into a gateway scheduled
  for retirement and couples paths the plan wants separate.
- Rejected — client-wide suppression with connector-only responder: fixes
  legacy garbage but reintroduces the measured OSC-11 theme regression
  (opencode dark-on-white, field report §9) on legacy.

### 3. Module: one shared `terminal-identity` in `contracts/`

`contracts/src/terminal-identity.ts`, following the `relay-parity` precedent
(shared client ↔ connector contract; the legacy gateway never imports it, so
it adds zero legacy coupling). All exports derive from a single sequence
table — one edit updates responder, scrubber, and suppression together.

Exports:

| Export | Role |
|---|---|
| `CAPABILITY_PROFILE` | The product's declared terminal identity: DA1 `\e[?1;2c`, pinned DA2, DSR-ok, DECRPM mode table, OSC 10/11 colours from the canonical theme |
| `createQueryResponder()` | Stateful per-session scanner over outbound PTY chunks; returns profile replies for the connector to write into the PTY. Bounded carry buffer for queries split across chunk boundaries |
| `scrubQueries(buf)` | Removes query sequences from bytes headed for the scrollback ring |
| `SUPPRESSED_QUERIES` | Declarative list the client walks to register xterm.js CSI/OSC/DCS handlers returning `true` (reply suppressed at source) |

- Rejected — home in `cli/`: the client must import the suppression list and
  a client→cli workspace dependency is new; client→contracts already exists.
- Rejected — duplicate tables in client and cli: drift on an open-ended set.

### 4. OSC 10/11 theme queries: pin in the profile

Answer OSC 11 with the product's canonical terminal background (`#fff`,
shared `client/src/theme.ts`, both engines). Keeps app light/dark detection
working (the regression the field report measured with opencode).

Per-viewer theming via OSC is impossible in a shared PTY regardless — the
app paints one theme for all viewers. Pinning makes the single answer
deterministic instead of race-decided. If per-user light/dark viewing is
ever wanted, it is a render-side client feature (palette remap at display
time) and composes with a pinned profile.

### 5. Backstop: scrub queries from the scrollback ring

Queries have no keystroke ambiguity, so filtering them is safe in a way
reply-filtering never is. The ring stores scrubbed bytes; replay to new
attachers is clean by construction, killing the no-typing retrigger path
even for a stale cached client that missed suppression.

- Rejected — additional inbound reply filter: re-imports the §8 ambiguity.
- Rejected — no backstop: stale-client deploy window re-introduces garbage.

### 6. CPR (cursor position report): not answered

The connector doesn't know the cursor position; tmux answers inner apps'
CPR itself; outer CPR is essentially never asked. Documented gap — revisit
if a real consumer appears. (Tracking screen state server-side or answering
a fixed lie were both rejected.)

## Connector integration

One hook point — the `pty.onData` read-loop (`cli/src/connector/session.ts`),
which every PTY byte already passes:

```
pty.onData(data)
  └─► responder.process(data)      // per-session, created in getOrCreate
        ├─ replies[]  ──► s.pty.write(reply)   // connector answers as the terminal
        ├─ raw chunk  ──► live sinks           // live viewers paint identical bytes
        └─ scrubbed   ──► scrollback ring      // ring never stores queries
```

- Responder lives on `SessionState`, dies with the session.
- Live fan-out stays raw; only the ring is scrubbed. Replay (`attach`) needs
  no change. `snapshotLayout`/`preseedLayout` tails are automatically
  query-free, so restored sessions can't re-ask across connector restarts;
  seed history written by an older connector is scrubbed once when consumed
  in `getOrCreate`.
- Replies write through the same `s.pty.write` as user input.
- Client: suppression handlers register on the xterm.js instance only when
  the terminal shape is connector-backed; focus reporting is never enabled
  (`\e[I`/`\e[O` is meaningless when shared).
- Stale-client story: a live stale client can still double-answer (2, not N —
  bounded); the replay retrigger is dead for everyone.

## Capability profile: DECRPM table

Honest per the shipped xterm.js:

| Mode | Reply | Note |
|---|---|---|
| 2004 bracketed paste | recognised | protects multi-line paste semantics |
| 2026 synchronized output | recognised | atomic frame paints |
| 1004 focus reporting | recognised, off | never enabled |
| 1016 SGR-pixel mouse | recognised | |
| 2027, 2031, unknown | not recognised (0) | honest default |

**Honesty mechanism:** a test instantiates headless xterm.js, fires every
query in the table at it, and asserts the real replies match the profile. An
xterm.js upgrade that changes capabilities fails CI.

## Error handling

- Carry buffer bounded (~64 bytes). No valid terminator within the bound
  means "not a query": flush, no reply, never stall.
- Raw bytes reach live sinks immediately regardless — detection never delays
  painting.
- Unknown queries pass through untouched (can't scrub what we don't
  recognise); client suppression is the layer that catches those.
- Structural win: the responder parses *queries* only, never replies — the
  CPR-vs-modified-F3 keystroke collision (field report §8) cannot occur by
  construction.

## Testing

- **Unit (contracts):** each query class answered; queries split across
  chunks; scrubber removes queries only; the headless-xterm profile
  assertion.
- **Connector** (`session.test.ts` pattern, fake sinks): a query arriving in
  `onData` produces exactly one `pty.write` reply; the ring stays clean; a
  **two-sink attach** replays no queries — the field report's "test with two
  clients from day one" made mechanical.
- **Client:** suppression registers only when the `gateway` prop is set;
  each listed handler returns `true`.
- **Interaction contract:** `ux-contract: none — no gesture interaction
  surface; byte-stream plumbing` in the PR body.
- **Manual verify:** field report §15 recipe — two browsers, DA burst via
  tmux passthrough, `tmux capture-pane` shows a clean prompt.

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
- Legacy main gateway keeps the fan-in bug until retirement (accepted).
- Per-viewer light/dark terminal theming as render-side palette remap.
- OSC 4 palette-entry answers (profile phase 2) and CPR, should a real
  consumer appear.
