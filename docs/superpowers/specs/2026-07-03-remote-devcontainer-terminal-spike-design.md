# Remote devcontainer terminal spike — design

**Date:** 2026-07-03
**Status:** approved (brainstorming session; hardened after adversarial +
simplification sub-agent reviews)
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
   browser → canvas → outbound-WS → container acceptable? Measured, not
   vibed: scripted echo RTT (p50/p95) through the loopback relay vs direct
   `/term/ws` on the same box (isolates relay overhead), then the same
   measurement over the real WAN topology. Numbers land in the findings
   write-back. Interactive-typing load only — bulk-output behaviour is an
   accepted limitation (see Accepted risks).
3. **Devcontainer packaging**: is the workshop use case ("participants'
   devcontainers attach to a shared canvas") practical? The packaging is a
   devcontainer **feature**, so the test is literally "add one line to
   `devcontainer.json`".

Findings feed back into `distributed-terminals-design.md` — including
**rewriting** its relay-splicer sketch (base64 `relay-data` JSON, UUID
channel ids) where this spike's protocol deliberately supersedes it.

## Decisions (from brainstorming)

1. **In scope:** remote devcontainer attach, Go connector, minimal
   relay/registration plane, toolbar gateway dropdown.
2. **Out of scope:** ghostty-web renderer (own later spike; orthogonal —
   the WS protocol is renderer-agnostic), agent-in-devcontainer `canvas`
   CLI loop (needs the CF service-token attribution story), Docker/stereOS
   orchestrators, direct (non-relay) connection path, `TERM_RUN_AS`
   sandboxing (the container is the sandbox), gateway HTTP routes
   (session list/kill), detached-session discovery, gateway-label title
   chip on the shape (cosmetic; full implementation).
3. **Launch model: manual.** `ssh box && devcontainer up` — the design
   doc's ManualOrchestrator philosophy ("the user started it,
   self-registered"). No orchestration code.
4. **Success bar:** typing round-trip (measured per decision question 2);
   two browsers see identical bytes with authoritative shared resize;
   browser refresh reattaches with scrollback; connector restart
   reattaches to the surviving tmux session.
5. **Approach:** Go connector + minimal Node relay plane (the routing
   plane stays in the sync server per the distributed-terminals design),
   with a **loopback-relay** integration test against the existing Node
   gateway landing first, so the relay is proven with a known-good gateway
   before any Go exists.
6. **Demo environment:** the ash box over the tailnet. The CF Access
   header path stays in the connector (~10 lines) but a prod-canvas demo
   is not an obligation.

## Accepted risks (spike-grade, named deliberately)

- **No connector authentication.** Anyone who can reach
  `/api/gateway/connect` (CF-Access members in prod; anyone on the tailnet
  against ash) can register — or, via replace-on-reconnect, hijack — a
  gateway id, capturing keystrokes for its terminals. Acceptable among
  trusted colleagues for a spike; the full design's `GATEWAY_SECRET`
  registration auth is required before any non-spike use.
- **Head-of-line blocking.** One multiplexed WS per gateway means bulk
  output in one session can stall echo in the gateway's other sessions,
  and the latency measurement is defined as interactive-only for this
  reason. Mitigation in the splicer: a browser socket whose
  `bufferedAmount` exceeds 4 MB is closed (its client reconnects). Full
  flow-control is a full-design concern. If the multiplexed framing
  fights back during implementation, the named fallback is
  one-outbound-WS-per-channel (connector dials
  `/api/gateway/channel?channelId=X` per browser; splicer becomes a pure
  1:1 pipe with zero framing) — less protocol validated in Go, but same
  demo.

## §1 Topology

```
 remote SSH box                                canvas VM
┌─────────────────────────────┐               ┌────────────────────────────────┐
│ devcontainer (workshops     │   outbound    │ sync server :8788              │
│ image + termgw feature)     │   WSS dial    │  /api/gateway/connect ◄─ WS ───┼── connector registers
│ ┌─────────────────────────┐ │ ────────────► │  /api/gateway/list             │
│ │ termgw (Go, static bin) │ │               │  relay splicer                 │
│ │  tmux new -A canvas-<id>│ │               │      ▲                         │
│ └─────────────────────────┘ │               │      │ /api/term/relay?        │
└─────────────────────────────┘               │      │   session=X&gateway=Y   │
   no inbound ports, no tailnet               │      │   &cols=C&rows=R        │
                                              └──────┼─────────────────────────┘
                                                     │
                                              browsers (terminal shape)
```

- **Connect = register.** The connector dials one outbound WSS; id and
  label ride the URL (`/api/gateway/connect?gatewayId=…&label=…`). WS
  ping/pong is the heartbeat; disconnect is deregistration. This
  collapses the design doc's three registry endpoints into one WS plus a
  read-only `GET /api/gateway/list` → `{gateways: [{gatewayId, label,
  relayOnly: true, connectedAt}]}` (field names match the full design's
  envelope so the dropdown code survives the upgrade). A connect with an
  already-registered id replaces the old connection: the splicer closes
  every browser socket riding the old connection (their existing
  backoff-reconnect re-establishes channels on the new one), and
  deregistration-on-close checks **socket identity**, not just id, so the
  old socket's async close event cannot deregister the new connection.
- **Browsers always reach remote terminals same-origin**, at
  `/api/term/relay?session=X&gateway=Y&cols=C&rows=R` (cols/rows feed
  `relay-open`, mirroring today's `/term/ws` query). The path lives under
  `/api` (not `/term`) because prod Caddy routes `/term*` to the existing
  gateway on :8789 — `/api*` already reaches the sync server in both prod
  Caddy and dev Vite, so no proxy config changes (dev Vite needs
  `ws: true` on the `/api` proxy entry). No direct path in the spike.
- **Strictly alongside the existing terminal path.** Shapes with no
  `gateway` prop (all existing shapes) connect same-origin to the
  existing Node gateway exactly as today; it remains the "This canvas"
  default. The relay is parallel plumbing, exercised only by
  remote-gateway shapes. `gateway-go/` is not an npm workspace, so
  `npm run build`/`typecheck` and the deploy pipeline are unaffected.
- **Cloudflare Access:** the connector sends
  `CF-Access-Client-Id`/`-Secret` headers on the dial when targeting a
  prod canvas; a CF Access **Service Auth policy** admitting that token
  pair on the connect path is an operational prerequisite there. Against
  the ash box over the tailnet (the demo environment), no headers.

## §2 Relay protocol (canvas ↔ connector, one WS, multiplexed)

- **`channelId` is a uint32**, allocated monotonically by the splicer per
  relay connection — a JSON number in control frames, a 4-byte big-endian
  prefix in binary frames. (This deliberately supersedes the UUID sketch
  in `distributed-terminals-design.md`.)
- **Control = JSON text frames.**
  Canvas→connector: `{type:'relay-open', channelId, sessionId, cols, rows}`,
  `{type:'relay-close', channelId}`.
  Connector→canvas: `{type:'relay-closed', channelId}`.
  The *inner* protocol's JSON messages (`input`/`resize` up;
  `attached`/`resize`/`exit` down) travel as
  `{type:'relay-msg', channelId, msg}`.
- **Terminal output = binary WS frames with the 4-byte channelId
  prefix.** No base64, no JSON parse on the hot path. The splicer strips
  the prefix and forwards raw bytes to the browser as **binary** frames,
  and forwards unwrapped `relay-msg` payloads as **text** frames — the
  client dispatches on frame type, so the browser-facing protocol is
  preserved exactly. (The splicer is a dumb pipe on the binary hot path;
  control frames are wrapped/unwrapped.)
- **Resize authority (pinned, because the success bar tests it):**
  `attached` carries the **session's current** cols/rows; `relay-open`'s
  cols/rows are used only when creating the session — a second browser
  attaching with its bootstrap 80×24 grid must not resize anyone. A
  `resize` whose clamped size equals the current size is a **no-op with
  no broadcast** (the client's grid logic relies on this dedup, per
  `TerminalShapeUtil.tsx` header comments).
- **Failure semantics:** relay WS drops (or is replaced) → splicer closes
  all browser sockets for that gateway (their existing
  reconnect-with-backoff takes over); the connector never kills tmux on
  disconnect, so sessions survive. Gateway offline at browser-connect
  time → socket destroyed immediately. 20 s ping/pong on both hops kills
  half-open connections, matching the current gateway.
- **Sequencing:** the splicer + registry land first and are proven via
  the loopback-relay integration test (§7.2) before any Go exists.
- **Acceptance bar:** the existing `TerminalShapeUtil` works against a
  relayed session with **no changes to its protocol handling** — only the
  URL builder learns the relay path.

## §3 Go connector (`gateway-go/`, new top-level dir — not an npm workspace)

Single static binary, four small packages:

| Package | Responsibility |
|---|---|
| `protocol` | Types + codec for the relay framing (§2) and inner messages. Pure; table-driven tests. Written carefully — it is the seed of the eventual full Go gateway. |
| `session` | `map[sessionId] → {pty, ringBuffer, channels}`. On `relay-open`: get-or-create via `creack/pty` spawning `tmux new-session -A -s canvas-<id>` (with `-f $TMUX_CONF` when the file exists, matching the Node gateway's existence-check behaviour; `-A` gives connector-restart reattach). Sends `attached` (session's current size, per §2), replays up to 256 KB scrollback from the ring buffer, fans output to all channels, clamps (20–500 cols / 5–200 rows) and broadcasts authoritative resizes with the §2 dedup. **Concurrency invariants** (Node got these free from single-threading): get-or-create holds a mutex so two simultaneous `relay-open`s for a new session cannot spawn two ptys; scrollback replay and channel subscription happen atomically under the session lock so live output cannot interleave into or duplicate after the replay; messages are processed per-channel FIFO so `relay-open` → `relay-msg{resize}` ordering survives demuxing. |
| `relay` | Dials `wss://<CANVAS_URL>/api/gateway/connect` with jittered exponential backoff; optional CF Access headers; demuxes channels to sessions. |
| `main` | Env config: `CANVAS_URL`, `GATEWAY_ID` (default hostname), `GATEWAY_LABEL`, `TMUX_CONF` (default: the conf installed by the feature; omit `-f` if absent), `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`. |

Dependencies: `creack/pty` + `coder/websocket` only.

## §4 Client changes

- Terminal shape gains `gateway?: string` (undefined = same-origin; zero
  migration for existing rooms). Updated in both
  `client/src/terminal/TerminalShapeUtil.tsx` and
  `server/src/schema.ts` — one last "keep in sync" edit, noted as
  motivation for the contracts package.
- The WS URL builder targets
  `/api/term/relay?session=…&gateway=…&cols=…&rows=…` when the prop is
  set (same-origin `/term/ws` otherwise, unchanged). No other
  protocol-handling changes.
- The "New terminal" toolbar button gains a dropdown: "This canvas
  (default)" + entries from `/api/gateway/list`, fetched on open.

## §5 Server changes (Node, sync server)

- `server/src/gateway-registry.ts` — the outbound-WS registry
  (connect/list, ping/pong liveness, socket-identity-checked replacement
  per §1) and the **relay splicer**: pipes matched at
  `/api/term/relay?…&gateway=Y` upgrades to relay channels, dumb on the
  binary hot path, wrapping/unwrapping control frames, enforcing the 4 MB
  `bufferedAmount` limit. Wired into the existing upgrade handler in
  `app.ts` (which already branches cleanly on pathname). Expect a few
  hundred lines in the house's comment-heavy style — small, but not
  "~150 lines" small.
- The routing plane stays in Node deliberately: it is the canvas server's
  job per the distributed-terminals design, and rewriting it buys nothing
  the spike is trying to learn.

## §6 Devcontainer packaging — a devcontainer *feature*

Per the simplification review, the connector ships as a **devcontainer
feature**, not a forked Dockerfile — this makes decision question 3's
answer "any repo adds one line to `devcontainer.json`" rather than
"practical if every repo forks our Dockerfile".

- `gateway-go/termgw-feature/` — `devcontainer-feature.json` +
  `install.sh`: installs tmux, copies the pre-built static `termgw`
  binary (from a `dist/` dir beside the feature for the spike; a release
  artifact URL is the productised path), installs the tmux conf, and
  contributes a `postStartCommand` lifecycle hook running a small
  restart-on-exit supervisor around `termgw`.
- Consumed as a **local feature** — the workshops repo's devcontainer is
  used *unmodified* except for one line:
  `"features": { "./termgw-feature": {} }` (plus `remoteEnv`/secrets for
  `CANVAS_URL`, `GATEWAY_LABEL`, and — prod only — the CF token pair). No
  ghcr publishing pipeline needed for the spike.
- Launch: `ssh box && devcontainer up --workspace-folder …`. The
  connector self-registers within seconds and appears in the dropdown.

## §7 Testing & demo script

1. **Node unit:** splicer channel bookkeeping against a scripted fake
   gateway WS (existing in-process `test-helpers.ts` pattern), including
   the replacement race (old socket's close must not deregister the new
   connection) and the `bufferedAmount` limit.
2. **Node integration (loopback relay):** the existing Node gateway on
   localhost reached through the relay path via a test-only bridging shim
   (dials `/api/gateway/connect`, proxies relay channels to
   `ws://localhost:8789/term/ws` — the existing gateway never dials out
   and stays unmodified); reuse the `smoke-terminal.ts` assertions.
   Proves the plane with a known-good gateway before Go exists. Also the
   harness for the loopback latency measurement (decision question 2).
3. **Go unit:** protocol codec round-trips; session manager against a
   stub pty, covering the §3 concurrency invariants (concurrent
   relay-open, replay/subscribe atomicity, resize dedup).
4. **Go integration:** connector against a scripted mock relay server —
   open channel, send input, assert echo + resize broadcast (and dedup) +
   scrollback replay on a second channel.
5. **Manual demo (the spike's deliverable), against ash over the
   tailnet:** devcontainer on remote box → dropdown shows its label →
   create terminal → typing round-trip (record the WAN RTT numbers);
   second browser sees identical bytes; refresh reattaches with
   scrollback; kill the connector process → tmux survives → connector
   restarts → terminal reattaches.

## Build order

1. Relay splicer + registry in the sync server, with unit + loopback
   integration tests and the loopback latency measurement.
2. Client `gateway` prop + URL builder + dropdown (testable against the
   loopback relay).
3. Go connector packages (`protocol` → `session` → `relay` → `main`)
   with unit + mock-relay integration tests.
4. Devcontainer feature packaging + manual demo on a remote box (WAN
   latency numbers).
5. Write findings back into `distributed-terminals-design.md` — including
   superseding its relay-splicer sketch (base64 JSON data frames, UUID
   channel ids) with this spike's framing where the findings support it.
