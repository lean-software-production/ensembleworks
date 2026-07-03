# Remote devcontainer terminal spike — design

**Date:** 2026-07-03
**Status:** approved (brainstorming session)
**Companion docs:**
[`docs/distributed-terminals-design.md`](../../distributed-terminals-design.md)
(the full architecture this spike is an increment of),
[`docs/plugin-architecture-design.md`](../../plugin-architecture-design.md)
(§2 recommends Go for the gateway; §5.4 CF Access service tokens).

## Goal

A POC proving that a workshops-style devcontainer
(`lean-software-production/workshops` `.devcontainer` pattern), launched
manually on a remote Docker-capable box, can host a terminal that appears as
a live, multi-viewer terminal shape on the EnsembleWorks canvas — with the
in-container piece (the "connector") written in **Go**, and bytes flowing
over a **relay plane** on the sync server so the remote box needs no inbound
networking, tailnet, or tunnel.

## What the spike decides

1. **Go ergonomics** for the eventual gateway port (plugin doc §2): does a
   fresh Go implementation of the 5-message terminal protocol + tmux
   backend come together cleanly with only `creack/pty` +
   `coder/websocket`?
2. **Relay feel**: is typing latency over
   browser → canvas → outbound-WS → container acceptable?
3. **Devcontainer packaging**: is the workshop use case ("participants'
   devcontainers attach to a shared canvas") practical?

Findings feed back into `distributed-terminals-design.md`.

## Decisions (from brainstorming)

1. **In scope:** remote devcontainer attach, Go connector, minimal
   relay/registration plane, toolbar gateway dropdown.
2. **Out of scope:** ghostty-web renderer (own later spike; orthogonal —
   the WS protocol is renderer-agnostic), agent-in-devcontainer `canvas`
   CLI loop (needs the CF service-token attribution story), Docker/stereOS
   orchestrators, direct (non-relay) connection path, `TERM_RUN_AS`
   sandboxing (the container is the sandbox), gateway HTTP routes
   (session list/kill), detached-session discovery.
3. **Launch model: manual.** `ssh box && devcontainer up` — the design
   doc's ManualOrchestrator philosophy ("the user started it,
   self-registered"). No orchestration code.
4. **Success bar:** typing round-trip; two browsers see identical bytes
   with authoritative shared resize; browser refresh reattaches with
   scrollback; connector restart reattaches to the surviving tmux session.
5. **Approach:** Go connector + minimal Node relay plane (the routing
   plane stays in the sync server per the distributed-terminals design),
   with a **loopback-relay** integration test against the existing Node
   gateway landing first, so the relay is proven with a known-good gateway
   before any Go exists.

## §1 Topology

```
 remote SSH box                                canvas VM
┌─────────────────────────────┐               ┌────────────────────────────────┐
│ devcontainer (workshops-    │   outbound    │ sync server :8788              │
│ style image + tmux)         │   WSS dial    │  /api/gateway/connect ◄─ WS ───┼── connector registers
│ ┌─────────────────────────┐ │ ────────────► │  /api/gateway/list             │
│ │ termgw (Go, static bin) │ │               │  relay splicer                 │
│ │  tmux new -A canvas-<id>│ │               │      ▲                         │
│ └─────────────────────────┘ │               │      │ /term/ws?session=X      │
└─────────────────────────────┘               │      │        &gateway=Y       │
   no inbound ports, no tailnet               └──────┼─────────────────────────┘
                                                     │
                                              browsers (terminal shape)
```

- **Connect = register.** The connector dials one outbound WSS; id and
  label ride the URL (`/api/gateway/connect?id=…&label=…`). WS ping/pong
  is the heartbeat; disconnect is deregistration. This collapses the
  design doc's three registry endpoints into one WS plus a read-only
  `GET /api/gateway/list` (`{id, label, connectedAt}[]`) for the dropdown
  — less spike code, same observable behaviour, upgrades cleanly to the
  full design later. A connect with an already-registered id replaces the
  old connection (the reconnecting connector wins; stale channels are
  closed).
- **Browsers always reach remote terminals same-origin**
  (`/term/ws?session=X&gateway=Y`). No direct path in the spike: no
  client-side URL gymnastics, works from any network the canvas works
  from.
- **Cloudflare Access:** the connector sends
  `CF-Access-Client-Id`/`-Secret` headers on the dial when targeting a
  prod canvas; against the ash box over the tailnet, no headers.

## §2 Relay protocol (canvas ↔ connector, one WS, multiplexed)

- **Control = JSON text frames.**
  Canvas→connector: `{type:'relay-open', channelId, sessionId, cols, rows}`,
  `{type:'relay-close', channelId}`.
  Connector→canvas: `{type:'relay-closed', channelId}`.
  The *inner* protocol's JSON messages (`input`/`resize` up;
  `attached`/`resize`/`exit` down) travel as
  `{type:'relay-msg', channelId, msg}`.
- **Terminal output = binary WS frames with a 4-byte big-endian
  `channelId` prefix.** No base64, no JSON parse on the hot path. The
  splicer strips the prefix and forwards raw bytes to the right browser
  socket — the browser-facing protocol is preserved **exactly**.
- **Failure semantics:** relay WS drops → splicer closes all browser
  sockets for that gateway (their existing reconnect-with-backoff takes
  over); the connector never kills tmux on disconnect, so sessions
  survive. Gateway offline at browser-connect time → socket destroyed
  immediately. 20 s ping/pong on both hops kills half-open connections,
  matching the current gateway.
- **Acceptance bar:** the existing `TerminalShapeUtil` works against a
  relayed session with **no changes to its protocol handling** — only the
  URL builder learns the `gateway` param.

## §3 Go connector (`gateway-go/`, new top-level dir — not an npm workspace)

Single static binary, four small packages:

| Package | Responsibility |
|---|---|
| `protocol` | Types + codec for the relay framing (§2) and inner messages. Pure; table-driven tests. Written carefully — it is the seed of the eventual full Go gateway. |
| `session` | `map[sessionId] → {pty, ringBuffer, channels}`. On `relay-open`: get-or-create via `creack/pty` spawning `tmux -f <conf> new-session -A -s canvas-<id>` (`-A` gives connector-restart reattach). Sends `attached`, replays up to 256 KB scrollback from the ring buffer, fans output to all channels, clamps (20–500 cols / 5–200 rows) and broadcasts authoritative resizes. |
| `relay` | Dials `wss://<CANVAS_URL>/api/gateway/connect` with jittered exponential backoff; optional CF Access headers; demuxes channels to sessions. |
| `main` | Env config: `CANVAS_URL`, `GATEWAY_ID` (default hostname), `GATEWAY_LABEL`, `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`. |

Dependencies: `creack/pty` + `coder/websocket` only.

## §4 Client changes

- Terminal shape gains `gateway?: string` (undefined = same-origin; zero
  migration for existing rooms). Updated in both
  `client/src/terminal/TerminalShapeUtil.tsx` and
  `server/src/schema.ts` — one last "keep in sync" edit, noted as
  motivation for the contracts package.
- The WS URL builder appends `&gateway=<id>` when set. No other
  protocol-handling changes.
- The "New terminal" toolbar button gains a dropdown: "This canvas
  (default)" + entries from `/api/gateway/list`, fetched on open.
  Remote-gateway shapes show the gateway label in their title chip so
  it's visible where a terminal lives.

## §5 Server changes (Node, sync server)

- `server/src/gateway-registry.ts` — the outbound-WS registry
  (connect/list, ping/pong liveness) and the **relay splicer**: a dumb
  byte pipe matching browser upgrades at `/term/ws?…&gateway=Y` to relay
  channels (~150 lines). Wired into the existing upgrade handler in
  `app.ts`.
- The routing plane stays in Node deliberately: it is the canvas server's
  job per the distributed-terminals design, and rewriting it buys nothing
  the spike is trying to learn.

## §6 Devcontainer packaging

- `gateway-go/devcontainer/` — a workshops-style example: `Dockerfile`
  (workshops base pattern + `tmux` + multi-stage Go build of `termgw`),
  `devcontainer.json` with a `postStartCommand` supervisor script
  (`termgw` with restart-on-exit), and `remoteEnv`/secrets for
  `CANVAS_URL`, `GATEWAY_LABEL`, and the CF token pair.
- Launch: `ssh box && devcontainer up --workspace-folder …`. The
  connector self-registers within seconds and appears in the dropdown.

## §7 Testing & demo script

1. **Node unit:** splicer channel bookkeeping against a scripted fake
   gateway WS (existing in-process `test-helpers.ts` pattern).
2. **Node integration (loopback relay):** the existing Node gateway on
   localhost forced through the relay path; reuse the
   `smoke-terminal.ts` assertions. Proves the plane before Go exists.
3. **Go unit:** protocol codec round-trips; session manager against a
   stub pty.
4. **Go integration:** connector against a scripted mock relay server —
   open channel, send input, assert echo + resize broadcast + scrollback
   replay on a second channel.
5. **Manual demo (the spike's deliverable):** devcontainer on remote box
   → dropdown shows its label → create terminal → typing round-trip;
   second browser sees identical bytes; refresh reattaches with
   scrollback; kill the connector process → tmux survives → connector
   restarts → terminal reattaches.

## Build order

1. Relay splicer + registry in the sync server, with unit + loopback
   integration tests.
2. Client `gateway` prop + URL builder + dropdown (testable against the
   loopback relay).
3. Go connector packages (`protocol` → `session` → `relay` → `main`)
   with unit + mock-relay integration tests.
4. Devcontainer packaging + manual demo on a remote box.
5. Write findings back into `distributed-terminals-design.md`.
