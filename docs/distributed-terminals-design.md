# Distributed Terminal Gateways — Design and Implementation Plan

## Why

Every keystroke in a canvas terminal round-trips through the public internet
twice (browser → Cloudflare → VM → and back) before the echo appears. A user in
Europe typing on a US-hosted canvas sees 100–200 ms per character — enough to
make `vim` and `claude code` feel sluggish, and enough to make a fast typist
outrun their own screen.

Latency is the problem, but the cure isn't just "move the VM closer." The
real requirement is more general: **terminals should be able to run on any
machine that can reach the canvas, for any reason** — latency, isolation, or
scale. Four concrete scenarios:

1. **Local gateway for latency.** A user runs `ensembleworks-term` on their
   laptop. Keystrokes echo in sub-millisecond because the PTY and tmux are on
   the same machine. Canvas state (cursors, shapes, stickies) still syncs
   through the remote server — that traffic is low-frequency and
   latency-tolerant.

2. **Isolated stereOS terminals.** Each terminal session (or each workshop
   participant) gets its own stereOS VM. The gateway runs inside a gVisor
   sandbox inside that VM, providing the same familiar `tmux` environment with
   kernel-level process and filesystem isolation. A compromised terminal cannot
   reach another participant's work, and the VM's `stereosd` control plane
   gives the canvas server full lifecycle management.

3. **Isolated Docker containers.** For lighter-weight isolation than a full VM,
   each terminal session can run in its own Docker container. Not as hardened
   as gVisor inside a VM (shared host kernel), but simpler to operate and
   lighter on resources.

4. **Worker VM pool for scale.** The VM hosting the canvas runs short on memory
   or CPU under a full workshop. Terminal workloads move to dedicated workers,
   each running its own gateway. The canvas server continues to own shape state
   and A/V; terminals are purely a routing concern.

All four share the same architectural requirement: spin up an isolated gateway
instance, join it to the shared canvas, and route browser traffic to it through
the best available network path — with a "slow but works everywhere" fallback
that routes through the canvas server itself.

The critical insight: **every gateway always uses TmuxBackend internally.**
The place where isolation happens is the *gateway host* — the VM, container, or
laptop — not the PTY backend inside the gateway. The canvas server's job is
routing bytes to and from the right gateway; it never touches a local PTY for
remote terminals.

## Current architecture

```
browser ─HTTPS─► Cloudflare ─[Access]─► tunnel ─► Caddy :8080 ─► Vite :5173
                                                             │
                                                             ├─ /sync/{room} ─► sync server :8788
                                                             ├─ /api, /uploads ─► sync server :8788
                                                             └─ /term ─────────► terminal gateway :8789
                                                                                      │
                                                                                      └─ node-pty ⇄ tmux
```

Every terminal WebSocket goes through the same domain as the canvas. The
gateway is a single process co-located with the sync server, and its PTY
spawns tmux sessions as the shared `ensemble` user on the same host.

Key properties of the current gateway that must be preserved:

- **Session persistence.** `tmux new-session -A` means reconnecting to an
  existing session works; closing all browser tabs does not kill the session.
- **Multi-client fan-out.** One PTY per tmux session, many browser tabs seeing
  identical bytes. The gateway holds a scrollback buffer (256 KB) and replays
  it to new clients on connect.
- **Authoritative resize.** Any client can propose a new grid size; the gateway
  resizes the PTY and broadcasts the authoritative size to all viewers, so they
  converge.
- **Same-origin only.** The browser constructs the WebSocket URL from
  `location.host`, so terminal traffic always follows the page's origin. No
  CORS, no mixed-content, no cross-origin negotiation.

## Proposed architecture

```
┌──────────────────────────────────────────────────────────┐
│                  canvas.leansoftware.ai                    │
│                                                           │
│   sync server :8788                                       │
│   ┌──────────────────────────────────────────────┐        │
│   │  /api/gateway/register  (new)                │       │
│   │  /api/gateway/list      (new)                │       │
│   │  /api/gateway/heartbeat (new)                │       │
│   │  /term/ws?session=X&gateway=Y (relay, new)   │       │
│   │  WS relay splicer ──────────┐                │       │
│   └──────────────────────────────┼───────────────┘        │
│                                   │                       │
│              ┌────────────────────┼──────────────┐        │
│              │                    │               │        │
│    ┌─────────▼───────┐  ┌───────▼────────┐  ┌──▼──────────┐
│    │ gateway A        │  │ gateway B       │  │ gateway C    │
│    │ (canvas VM)      │  │ (stereOS VM)    │  │ (laptop)     │
│    │ TmuxBackend      │  │ TmuxBackend     │  │ TmuxBackend  │
│    │ :8789            │  │ gVisor sandbox  │  │ :8789        │
│    │ same-origin      │  │ relay-only       │  │ direct       │
│    └──────────────────┘  └─────────────────┘  └──────────────┘
│                                                           │
│   ┌─────────────────────────────────────────────┐         │
│   │  Canvas shape state + LiveKit A/V            │         │
│   │  (unchanged — terminals are a separate plane) │         │
│   └─────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────┘
```

Each gateway is the same `terminal-gateway.ts` process. It always uses
`TmuxBackend` internally. What differs between scenarios is **where the
gateway runs and how it got there** — not what it does once it's running.

| Scenario | Gateway host | How it starts | Connection |
|----------|--------------|--------------|------------|
| Same VM | Canvas server | systemd (existing) | Same-origin |
| Laptop | User's machine | User runs `ensembleworks-term` | Direct or relay |
| Docker container | Docker on canvas VM or worker | `DockerOrchestrator.startGateway()` | Relay |
| stereOS VM | QEMU/Apple VZ on canvas VM or worker | `StereosOrchestrator.startGateway()` | Relay |

The canvas server doesn't manage PTYs for remote terminals. It manages
**gateway processes** — launching them, routing bytes to them, and shutting
them down. The orchestrator layer is the new piece that makes this work.

## The three layers

The architecture has three distinct layers, and it's important to understand
which layer owns which responsibility:

### Layer 1 — the terminal gateway process

The same `terminal-gateway.ts` code, running everywhere. It:
- Accepts browser WebSocket connections on `:8789` (direct path)
- Accepts relayed connections from the canvas server (relay path)
- Manages tmux sessions via `TmuxBackend`
- Fans output to all attached WebSockets
- Replays scrollback to new clients
- Broadcasts authoritative resize events

The gateway is location-agnostic. It doesn't know or care whether it's running
on the canvas VM, inside a gVisor sandbox, on Alice's laptop, or in a Docker
container. It gets `CANVAS_URL` and `GATEWAY_ID` from its environment and does
its job.

### Layer 2 — the connection routing plane

This is the canvas server's job. It:
- Maintains a registry of known gateways (`/api/gateway/list`)
- Accepts gateway registration and heartbeat (`/api/gateway/register`,
  `/api/gateway/heartbeat`)
- Relays browser WebSocket connections through to gateways when direct
  connections aren't possible (`/term/ws?gateway=X`)
- Decrypts Cloudflare Access tokens and validates direct-path JWTs

The routing plane never touches a PTY. It's a byte pipe between browsers and
gateways. Terminals on the co-located gateway still work exactly as they do
today (same-origin path through the Vite proxy).

### Layer 3 — the orchestrator layer

This is what makes "terminals on different hosts" possible. Each orchestrator
knows how to launch, configure, and shut down a terminal gateway in a
particular hosting environment:

```
GatewayOrchestrator interface
├── LocalOrchestrator      — "it's already running" (systemd, in-process)
├── ManualOrchestrator     — "the user started it" (self-registered)
├── DockerOrchestrator     — "I'll start a Docker container"
└── StereosOrchestrator    — "I'll launch a QEMU VM"
```

The orchestrator is only involved at gateway lifecycle (start, configure, stop).
Once the gateway process is running and registered, the data plane (browser ↔
gateway bytes) is handled entirely by Layer 2. The orchestrator is not in the
hot path.

## The PtyBackend extraction — and why it's not the fleet abstraction

The current `terminal-gateway.ts` has `node-pty` spawning `tmux` directly
inline. Extracting this into a `PtyBackend` interface is still valuable:

```ts
// server/src/pty-backend.ts

export interface PtyBackend {
  spawn(sessionId: string, cols: number, rows: number): PtyProcess
  listSessions(): Promise<string[]>
  killSession(sessionId: string): Promise<void>
}

export interface PtyProcess {
  onData: (handler: (data: string) => void) => void
  onExit: (handler: (code: number) => void) => void
  write(data: string): void
  resize(cols: number, rows: number): void
}
```

But `PtyBackend` is a **per-gateway** concern, not a fleet-level abstraction.
Every gateway — whether it's on the canvas VM, inside a gVisor sandbox, or on
Alice's laptop — uses `TmuxBackend`. The `PtyBackend` extraction enables:

- Testing the gateway without tmux (a `DumbBackend` that echoes input)
- Future local backends (a plain-shell backend, a Docker-exec backend for
  devcontainers on the same host)
- Clean separation of PTY management from WebSocket fan-out

It does **not** enable running terminals on different hosts, because `PtyProcess`
is a local, in-process abstraction (`write()` pushes bytes to a local PTY,
`onData` fires on local PTY output). Remote terminals don't have a local PTY —
their bytes flow through the relay, which is a completely different path.

**The fleet-level abstraction is `GatewayOrchestrator`**, not `PtyBackend`.

## Gateway lifecycle

### Startup (same for all orchestrators)

```
1.  Orchestrator launches the gateway process (or user starts it manually)
2.  terminal-gateway starts (port 8789, same as today)
3.  Reads GATEWAY_ID, GATEWAY_URL, CANVAS_URL, GATEWAY_LABEL from env
4.  Calls POST /api/gateway/register with its identity and capabilities
5.  Opens outbound WS to wss://canvas…/term/relay?gateway={GATEWAY_ID}
6.  Begins heartbeat loop (POST /api/gateway/heartbeat every 15 s)
```

Steps 4–6 are always the same. Steps 1–2 differ by orchestrator:

| Orchestrator | Step 1–2 |
|---|---|
| LocalOrchestrator | Already running (systemd). No action needed. |
| ManualOrchestrator | User runs `ensembleworks-term`. Gateway self-registers. |
| DockerOrchestrator | `docker run -d …` with gateway env vars. Container starts, gateway registers. |
| StereosOrchestrator | Launch QEMU VM → wait for stereosd ready → send jcard.toml + secrets → agentd launches gateway inside gVisor → gateway registers. |

### Steady state

- The gateway accepts terminal WebSocket connections on `:8789` (direct path)
  AND receives relayed connections through the outbound WS to the canvas
  (fallback path).
- Session creation, PTY management, scrollback replay, and multi-client
  fan-out are all unchanged — the gateway doesn't know or care whether a
  given WebSocket arrived directly or through the relay.
- The heartbeat updates the canvas's `/api/gateway/list` with current session
  names and connection counts.

### Shutdown or crash

- The heartbeat stops; the canvas removes the gateway from its registry after
  45 seconds (3 missed heartbeats).
- The outbound relay WS closes; the canvas drops any browser connections that
  were being relayed through it. Browsers see a disconnect and attempt
  reconnection (the existing exponential-backoff logic in `TerminalShapeUtil`).
- tmux sessions on the gateway's host survive the gateway process — they're
  independent. A restarted gateway reattaches to them via `tmux new-session
  -A` just as it does today.
- The orchestrator (if it manages lifecycle) detects the failure and either
  restarts the gateway or tears down its host (VM, container).

## Registration protocol

### `POST /api/gateway/register`

The gateway calls this on startup and after every heartbeat. The canvas stores
the most recent response and prunes gateways whose last heartbeat is older
than 45 seconds.

```json
{
  "gatewayId": "gw-alice-macbook",
  "url": "ws://192.168.1.42:8789",
  "label": "Alice's MacBook",
  "sessions": ["canvas-alice", "canvas-build"]
}
```

| Field | Meaning |
|---|---|
| `gatewayId` | Stable identifier across gateway restarts. Must be unique within the canvas. Default: hostname. |
| `url` | Direct URL where browsers can reach this gateway, or `null` if only reachable via relay. |
| `label` | Human-readable name for the "New terminal" dropdown. |
| `sessions` | Current live `canvas-`-prefixed tmux session names on this gateway. |

Response:

```json
{
  "ok": true,
  "heartbeatIntervalMs": 15000,
  "pruneAfterMs": 45000
}
```

### `GET /api/gateway/list`

Returns all registered gateways and their sessions. The client calls this once
on page load (and refreshes when creating a terminal) to populate the gateway
picker and resolve terminal-to-gateway mappings.

```json
{
  "gateways": [
    {
      "gatewayId": "gw-canvashost",
      "url": null,
      "label": "This canvas",
      "directUrl": "wss://canvas.leansoftware.ai/term/ws",
      "relayOnly": true,
      "sessions": ["canvas-default", "canvas-crew-a"]
    },
    {
      "gatewayId": "gw-alice-macbook",
      "url": "ws://192.168.1.42:8789",
      "label": "Alice's MacBook",
      "directUrl": "ws://192.168.1.42:8789/term/ws",
      "relayOnly": false,
      "sessions": ["canvas-alice"]
    }
  ]
}
```

### `POST /api/gateway/heartbeat`

Same body as register. Sent every `heartbeatIntervalMs` (default 15 s). The
canvas updates the gateway's `sessions` list and refreshes its last-seen
timestamp. Gateways not heard from in `pruneAfterMs` (default 45 s) are
removed.

## Connection routing

### Direct path (fast)

```
browser ──ws://192.168.1.42:8789/term/ws?session=X──► gateway A (local)
```

Sub-millisecond echo for the user on the same machine as the gateway. Other
teammates on the same LAN also get LAN-latency echo.

### Relay path (works everywhere)

```
browser ──wss://canvas…/term/ws?session=X&gateway=gw-alice-macbook──► canvas server
                                                                            │
                 canvas relays WS frames ◄─────────────────────────────────┘
                                                                            │
                                       via outbound WS from gateway A ──────► gateway A
```

The canvas server maintains a map of `gatewayId → outbound WS` (one per
gateway). When a browser connects with `?gateway=gw-alice-macbook`, the canvas
looks up the gateway's outbound relay WS and splices the browser's connection
through it bidirectionally. The relay is a dumb byte pipe — it doesn't parse
the terminal protocol.

### Same-origin path (current behaviour, unchanged)

When a terminal shape has no `gateway` prop (or it's the default gateway), the
browser connects to the same origin it loaded the page from, and the canvas
Vite proxy routes it to the co-located gateway port. This is the path that
existing deployments use, and it stays exactly as-is.

### Fallback strategy

The browser tries paths in order, with a connect timeout on the direct path:

1. **Direct** (if a `directUrl` is available and the gateway's `relayOnly` is
   false): try the direct WS with a 2-second connect timeout. If it opens,
   use it.
2. **Relay**: fall back to `wss://canvas…/term/ws?session=X&gateway=Y`. Always
   works because the browser loaded the page from this origin.

## The relay splicer

```
browser WS ◄──────────────────► canvas server ◄──────────────────► gateway WS
             (Vite proxy)           (relay splicer)        (outbound WS)
```

Implementation sketch in `app.ts`:

```typescript
// On browser upgrade with ?gateway=:
const gatewayId = url.searchParams.get('gateway')
const relayWs = relayConnections.get(gatewayId)
if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
  socket.destroy()  // gateway offline
  return
}

// Allocate a relay channel so the gateway can route bytes to the right session
const channelId = crypto.randomUUID()
relayWs.send(JSON.stringify({
  type: 'relay-open',
  channelId,
  sessionId: url.searchParams.get('session'),
  cols: url.searchParams.get('cols'),
  rows: url.searchParams.get('rows'),
}))

browserWs.on('message', (data) => {
  relayWs.send(JSON.stringify({ type: 'relay-data', channelId, data }))
})
relayWs.on('message', (data) => {
  const msg = JSON.parse(data)
  if (msg.type === 'relay-data' && msg.channelId === channelId) {
    browserWs.send(msg.data)
  }
})
// ... close handlers tear down the channel
```

## The orchestrator layer

### GatewayOrchestrator interface

```typescript
// server/src/gateway-orchestrator.ts

export interface GatewayOrchestrator {
  /** Start a gateway process and return its connection info. */
  startGateway(opts: {
    gatewayId: string
    label: string
    canvasUrl: string
    canvasSecret: string
    // Backend-specific options (memory, CPUs, etc.)
    backendOpts?: Record<string, unknown>
  }): Promise<GatewayConnectionInfo>

  /** Stop a running gateway. */
  stopGateway(gatewayId: string): Promise<void>

  /** List gateway IDs this orchestrator is managing. */
  listGateways(): Promise<string[]>
}

export interface GatewayConnectionInfo {
  gatewayId: string
  url: string | null     // Direct URL if reachable, null for relay-only
  relayOnly: boolean
  label: string
}
```

### LocalOrchestrator

The co-located gateway. Already running (systemd or in-process). No start/
stop action needed — it self-registers.

```typescript
export class LocalOrchestrator implements GatewayOrchestrator {
  async startGateway() {
    // Already running via systemd. Return its connection info.
    return { gatewayId: 'gw-canvashost', url: null, relayOnly: true, label: 'This canvas' }
  }
  async stopGateway() { /* no-op — systemd manages this */ }
  async listGateways() { return ['gw-canvashost'] }
}
```

### ManualOrchestrator

For gateways that users start themselves (laptops, remote workers). The
gateway self-registers via `POST /api/gateway/register`. The orchestrator
doesn't start or stop anything — it just tracks registrations in the gateway
registry.

```typescript
export class ManualOrchestrator implements GatewayOrchestrator {
  // startGateway is a no-op — the user starts the gateway process manually
  async startGateway(opts) {
    return { gatewayId: opts.gatewayId, url: null, relayOnly: true, label: opts.label }
  }
  async stopGateway() {
    // Could send a shutdown signal via the gateway's outbound WS
    // but in practice the user manages this gateway themselves
  }
  async listGateways() { return [] /* tracked by GatewayRegistry, not here */ }
}
```

### DockerOrchestrator

For lightweight containerized isolation. Each terminal session gets its own
Docker container running `ensembleworks-term`.

```typescript
export class DockerOrchestrator implements GatewayOrchestrator {
  async startGateway(opts) {
    const containerId = await execFileP('docker', [
      'run', '-d',
      '--name', `ew-term-${opts.gatewayId}`,
      '--memory', opts.backendOpts?.memory ?? '512m',
      '--cpus', opts.backendOpts?.cpus ?? '0.5',
      '-e', `CANVAS_URL=${opts.canvasUrl}`,
      '-e', `GATEWAY_ID=${opts.gatewayId}`,
      '-e', `GATEWAY_URL=null`,
      '-e', `GATEWAY_LABEL=${opts.label}`,
      '-e', `GATEWAY_SECRET=${opts.canvasSecret}`,
      'ensembleworks-term:latest'
    ])
    // Wait for the container's gateway to register with the canvas
    // (poll /api/gateway/list until it appears)
    await this.waitForRegistration(opts.gatewayId, 30_000)
    const gateway = await this.registry.get(opts.gatewayId)
    return {
      gatewayId: opts.gatewayId,
      url: gateway.url,
      relayOnly: !gateway.url,
      label: opts.label,
    }
  }

  async stopGateway(gatewayId) {
    await execFileP('docker', ['stop', `ew-term-${gatewayId}`])
    await execFileP('docker', ['rm', `ew-term-${gatewayId}`])
  }

  async listGateways() {
    const { stdout } = await execFileP('docker',
      ['ps', '--filter', 'name=ew-term-', '--format', '{{.Names}}'])
    return stdout.trim().split('\n').filter(Boolean)
      .map(name => name.replace('ew-term-', ''))
  }
}
```

Docker containers share the host kernel. They provide namespace and cgroup
isolation (process, network, filesystem) but not kernel-level isolation. A
container escape via a kernel exploit is possible. For workloads requiring
stronger isolation, use `StereosOrchestrator`.

### StereosOrchestrator

For VM-level isolation with gVisor sandboxing inside the VM. Each terminal
session gets its own stereOS VM, and inside that VM, the gateway runs inside a
gVisor sandbox managed by agentd.

See the "stereOS as a gateway host" section below for the full details.

## Gateway auth and security

### Current model

Cloudflare Access sits in front of the canvas. Authenticated users get a
session cookie that gates all routes including `/term`. The terminal gateway
itself has no auth — it trusts the canvas's Cloudflare Access boundary.

### Distributed model

**Direct path.** A gateway with a public URL needs its own auth. When the
client requests gateway info from `GET /api/gateway/list`, the canvas mints a
short-lived JWT (15 minutes) and includes it in the gateway entry. The browser
passes this token as a query param on the direct WS connection. The gateway
validates the token against the canvas's public key (fetched once on startup).

```json
{
  "gatewayId": "gw-alice-macbook",
  "directUrl": "ws://192.168.1.42:8789/term/ws?token=eyJ...",
  "relayOnly": false
}
```

**Relay path.** The canvas server already sits behind Cloudflare Access. Browser
connections to the relay are authenticated by the same session. The relay just
pipes bytes.

**Container/VM gateways.** Gateways behind NAT or inside container networks have
`GATEWAY_URL=null` and are reachable only via relay. No additional auth is
needed because the canvas server's Access policy gates all browser connections.

**Shared secret for gateway registration.** Gateways prove their identity to the
canvas with a `GATEWAY_SECRET` env var, included in the `Authorization` header
on registration and heartbeat requests.

## Terminal shape changes

```typescript
// client/src/terminal/TerminalShapeUtil.tsx

export interface TerminalShapeProps {
  w: number
  h: number
  sessionId: string
  title: string
  status?: string
  gateway?: string   // gateway ID; undefined = same-origin (backward compat)
}
```

`gateway` defaults to `undefined` in existing shapes, which means "same-origin
gateway" — zero migration for current rooms.

The `termWsUrl` function resolves the gateway:

```typescript
function termWsUrl(sessionId: string, cols: number, rows: number, gateway?: string) {
  if (!gateway) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/term/ws?session=${sessionId}&cols=${cols}&rows=${rows}`
  }
  const info = gatewayRegistry[gateway]
  if (!info) return relayUrl(sessionId, gateway)
  return info.directUrl
    ? `${info.directUrl}?session=${sessionId}&cols=${cols}&rows=${rows}`
    : relayUrl(sessionId, gateway)
}
```

The "New terminal" toolbar button shows a gateway dropdown populated from
`/api/gateway/list`:

```
┌──────────────────────────────┐
│ New terminal            ▾     │
│ ─────────────────────────── │
│ ✓ This canvas (default)      │  ← undefined, same-origin
│   Alice's MacBook             │  ← gw-alice-macbook, direct
│   Sandbox #42                 │  ← gw-sandbox-42, relay-only
│   Worker us-east-1            │  ← gw-worker-east, direct
└──────────────────────────────┘
```

## Gateway environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8789` | Gateway HTTP/WS listen port |
| `TMUX_CONF` | `deploy/tmux-ensembleworks.conf` | tmux configuration file |
| `CANVAS_URL` | `http://localhost:8788` | Canvas server for registration and relay |
| `GATEWAY_ID` | OS hostname | Stable gateway identifier |
| `GATEWAY_URL` | `null` | Direct URL browsers can reach this gateway at. `null` = relay-only |
| `GATEWAY_LABEL` | `"Local terminal"` | Human-readable name for the gateway picker |
| `GATEWAY_SECRET` | (none) | Shared secret for registration auth |
| `GATEWAY_BACKEND` | `"tmux"` | Which PtyBackend to use (`"tmux"` for now) |

Running a local gateway on a laptop:

```bash
CANVAS_URL=https://canvas.leansoftware.ai \
GATEWAY_ID=gw-alice-macbook \
GATEWAY_URL=ws://192.168.1.42:8789 \
GATEWAY_LABEL="Alice's MacBook" \
GATEWAY_SECRET=s3cret \
npm run start:term
```

Running an isolated gateway inside Docker:

```bash
docker run -d --name ew-term-session-42 \
  -e CANVAS_URL=https://canvas.leansoftware.ai \
  -e GATEWAY_ID=gw-docker-42 \
  -e GATEWAY_URL=null \
  -e GATEWAY_LABEL="Sandbox #42" \
  -e GATEWAY_SECRET=s3cret \
  ensembleworks-term:latest
```

Running the co-located gateway (unchanged from today):

```bash
# No new env vars needed — GATEWAY_ID defaults to hostname,
# GATEWAY_URL defaults to null, CANVAS_URL defaults to localhost:8788.
npm run dev:term
```

## File changes and new files

| File | Change |
|---|---|
| `server/src/terminal-gateway.ts` | Add registration heartbeat, outbound relay WS, `GATEWAY_*` env vars. Extract PTY spawning into a pluggable `PtyBackend` (with `TmuxBackend` as default). |
| `server/src/app.ts` | Add `/api/gateway/register`, `/api/gateway/list`, `/api/gateway/heartbeat` endpoints; add WS relay splicer for `?gateway=` connections. |
| `server/src/gateway-registry.ts` | **New file.** In-memory gateway registry: registration, heartbeat pruning, session enumeration. |
| `server/src/relay.ts` | **New file.** Bidirectional WS-to-WS relay splicer: channel multiplexing over a single outbound gateway connection. |
| `server/src/gateway-orchestrator.ts` | **New file.** `GatewayOrchestrator` interface, `LocalOrchestrator`, `ManualOrchestrator`. |
| `server/src/docker-orchestrator.ts` | **New file.** `DockerOrchestrator` implementation. |
| `server/src/stereos-orchestrator.ts` | **New file.** `StereosOrchestrator` implementation. |
| `server/src/pty-backend.ts` | **New file.** `PtyBackend` interface, `TmuxBackend` implementation. |
| `server/src/schema.ts` | Add `gateway?: string` to the terminal shape definition. |
| `client/src/terminal/TerminalShapeUtil.tsx` | Add `gateway?: string` prop; resolve gateway URL from registry; connect-direct-or-fall-back-to-relay logic. |
| `client/src/terminals/gateway-registry.ts` | **New file.** Fetch and cache `/api/gateway/list`; resolve `termWsUrl` with direct + relay fallback. |
| `client/src/App.tsx` | Add "New terminal" toolbar entry with gateway picker dropdown. |
| `stereos/mixtapes/ensembleworks/package.nix` | **New file.** Custom stereOS mixtape adding `ensembleworks-term` to the agent PATH. |
| `deploy/bootstrap-debian-ash.sh` | Add `GATEWAY_ID`/`GATEWAY_SECRET` to `~/.config/ensembleworks/term.env`. |
| `deploy/systemd/ensembleworks-term.service` | Add `EnvironmentFile=…/term.env` for gateway configuration. |

## Implementation order

Red/green/refactor. A test writer writes failing tests against the contracts
below; an implementer makes them pass without modifying the tests; a refactor
pass cleans up with tests staying green.

Existing test conventions: plain `tsx` scripts using `node:assert/strict`
(server tests), shellspec from the repo root (shell tests).

### Cycle 0 — pluggable PTY backend

**Goal:** Extract the tmux-spawning code from `terminal-gateway.ts` into a
swappable interface, with the current tmux implementation as the default. No
behaviour change.

**Contract:** `server/src/pty-backend.ts`

```ts
export interface PtyBackend {
  spawn(sessionId: string, cols: number, rows: number): PtyProcess
  listSessions(): Promise<string[]>
  killSession(sessionId: string): Promise<void>
}

export interface PtyProcess {
  onData: (handler: (data: string) => void) => void
  onExit: (handler: (code: number) => void) => void
  write(data: string): void
  resize(cols: number, rows: number): void
}

export class TmuxBackend implements PtyBackend {
  // Current tmux new-session -A logic, extracted verbatim
  constructor(opts: { tmuxConf?: string, cwd?: string, env?: Record<string, string> })
}
```

`terminal-gateway.ts` accepts a `PtyBackend` in its options (defaulting to
`TmuxBackend`). All session creation, listing, and killing go through the
interface. The smoke test (`smoke-terminal.ts`) passes unchanged.

**Why this is per-gateway, not per-fleet:** every gateway always uses TmuxBackend
internally. The `PtyBackend` extraction enables testing and future local
backends (plain shell, Docker-exec on same host) — it is not the abstraction
that makes terminals run on different hosts. That's the orchestrator's job.

**Tests:**
- `server/src/pty-backend.test.ts`: create two sessions, list them, kill one,
  verify the other survives. Exercise the full `TmuxBackend` with real tmux
  (same pattern as the existing smoke test).

### Cycle 1 — gateway registry

**Goal:** The canvas server can register gateways, list them, and prune stale
ones.

**Contract:** `server/src/gateway-registry.ts`

```ts
export interface GatewayInfo {
  gatewayId: string
  url: string | null
  label: string
  sessions: string[]
  lastHeartbeat: number
}

export class GatewayRegistry {
  register(info: GatewayInfo): void
  heartbeat(gatewayId: string, sessions: string[]): void
  list(): GatewayInfo[]
  get(gatewayId: string): GatewayInfo | undefined
  prune(maxAgeMs: number): number
}
```

**Endpoints in `app.ts`:**

- `POST /api/gateway/register`
- `POST /api/gateway/heartbeat`
- `GET /api/gateway/list`

**Tests:**
- `server/src/gateway-registry.test.ts`: register, list, heartbeat, prune.

### Cycle 2 — relay splicer

**Goal:** The canvas server can relay a browser's terminal connection through
to a remote gateway's outbound WS, with multiplexed channels for multiple
sessions.

**Contract:** `server/src/relay.ts`

```ts
export class RelaySplicer {
  handleBrowserConnection(browserWs: WebSocket, gatewayOutboundWs: WebSocket,
    sessionId: string, cols: number, rows: number): void
  addOutbound(gatewayId: string, ws: WebSocket): void
  removeOutbound(gatewayId: string): void
  getOutbound(gatewayId: string): WebSocket | undefined
}
```

The relay protocol is a thin JSON envelope over the gateway's outbound WS:

```
→ gateway (from canvas relay):
  { type: 'relay-open', channelId, sessionId, cols, rows }
  { type: 'relay-data', channelId, data }    // data is base64 for binary
  { type: 'relay-close', channelId }

← gateway (to canvas relay):
  { type: 'relay-data', channelId, data }    // base64 binary
  { type: 'relay-close', channelId, code }
  { type: 'relay-heartbeat' }                 // keepalive on the outbound WS
```

**Tests:**
- `server/src/relay.test.ts`: two browser WS connections through a single relay,
  verifying both receive identical output. Verify close of one browser WS
  doesn't close the other. Verify close of the gateway outbound WS closes all
  riding browser connections.

### Cycle 3 — gateway outbound connection and registration

**Goal:** A standalone `terminal-gateway.ts` can register with the canvas,
maintain an outbound relay WS, and serve both direct and relayed browser
connections.

**Changes to `terminal-gateway.ts`:**

1. On startup, read `CANVAS_URL` and `GATEWAY_*` env vars.
2. `POST /api/gateway/register` with identity and session list.
3. Open outbound WS to `wss://canvas…/term/relay?gateway={GATEWAY_ID}`.
4. Begin heartbeat loop (`POST /api/gateway/heartbeat` every 15 s).
5. Accept incoming relay-open messages from the canvas, create virtual PTY
   connections for each channelId, and pipe bytes.

**Tests:**
- Extend `server/src/smoke-terminal.ts` with a scenario that connects through
  a mock relay, verifying session creation, input round-trip, scrollback
  replay, and session survival after disconnect.

### Cycle 4 — client gateway awareness

**Goal:** The browser can create terminals on different gateways and connect to
them via direct or relay paths.

**Changes:**
- Add `gateway?: string` to `TerminalShapeProps`.
- Replace `termWsUrl` with the gateway-registry-aware version.
- Add direct-path connect timeout (2 seconds) with relay fallback.
- Fetch `/api/gateway/list` on component mount; cache it.
- Add "New terminal" dropdown showing available gateways.
- Add `gateway?: string` to the server shape schema.

**Tests:**
- `client/src/terminals/gateway-registry.test.ts`: verify URL resolution for
  same-origin, direct, and relay paths. Test fallback from failed direct to
  relay. Test unknown gateway falls back to same-origin.

### Cycle 5 — devcontainer integration

**Goal:** Launching a Codespace or devcontainer automatically starts a terminal
gateway that registers with the co-located canvas.

**Changes to `.devcontainer/workspace-up.bash`:**

```bash
GATEWAY_ID="gw-devcontainer" \
GATEWAY_URL=null \
GATEWAY_LABEL="This Codespace" \
npm run dev:term --workspace=server
```

Since the gateway is co-located, `GATEWAY_URL=null` means relay-only, but the
relay path is just the existing Vite proxy. This cycle validates the
registration and listing flow without changing throughput.

### Cycle 6 — Docker orchestrator

**Goal:** The canvas server can launch a Docker container per terminal session
that runs `ensembleworks-term`, with namespace isolation and resource limits.

**Contract:** `server/src/docker-orchestrator.ts`

```ts
export class DockerOrchestrator implements GatewayOrchestrator {
  constructor(opts: { image: string, network?: string })
  async startGateway(opts: StartGatewayOpts): Promise<GatewayConnectionInfo>
  async stopGateway(gatewayId: string): Promise<void>
  async listGateways(): Promise<string[]>
}
```

The orchestrator:
1. `docker run -d` with `--memory`, `--cpus`, env vars for `CANVAS_URL`,
   `GATEWAY_ID`, etc.
2. Polls `/api/gateway/list` until the container's gateway registers.
3. On stop: `docker stop && docker rm`.

The `ensembleworks-term` Docker image is built from the existing devcontainer
Dockerfile (a subset — Node.js, tmux, the gateway package). The gateway inside
the container uses `TmuxBackend` (tmux in the container) just like everywhere
else. It registers with the canvas via the relay (since `GATEWAY_URL=null` for
containers behind Docker networking).

**Tests:**
- `server/src/docker-orchestrator.test.ts`: start a container, verify it
  registers with the canvas gateway list, create a terminal session through it,
  verify bytes flow, stop the container.

### Cycle 7 — stereOS orchestrator

**Goal:** The canvas server can launch a stereOS VM per terminal session
with gVisor sandbox isolation and full control-plane integration.

This is the most feature-rich orchestrator, leveraging stereOS's built-in
`stereosd` and `agentd` daemons for configuration, secret injection, and
agent lifecycle management.

See the "stereOS as a gateway host" section below for the full stereOS
architecture and how this orchestrator works.

## stereOS as a gateway host

[stereOS](https://github.com/papercomputeco/stereOS) is a NixOS-based VM image
purpose-built for AI agent workloads. It provides exactly what we need for
strongly isolated terminal sessions — and significantly more than a plain
Docker container can offer.

### What stereOS provides

stereOS produces bootable VM images called **mixtapes** that bundle a minimal,
hardened Linux system with specific agent harnesses. The key components:

**Operating system (NixOS, hardened):**
- Kernel hardening: ptrace scope 2, kptr_restrict, dmesg_restrict, no core
  dumps, no ICMP redirects
- Ephemeral `/tmp` (tmpfs), volatile journal, sub-3-second boot target
- Firewall: SSH only (port 22), no unnecessary services

**Two users:**
- `admin` (wheel group, passwordless sudo, access to daemon sockets)
- `agent` (restricted shell, `~/workspace`, no sudo, no `nix` access)

The `agent` user's PATH is curated — only approved packages from
`stereos.agent.basePackages` and `stereos.agent.extraPackages`.

**stereosd (control plane daemon):**
- Runs inside the VM, listens on AF_VSOCK (CID 3, port 1024) or TCP fallback
- Receives NDJSON messages from the host orchestrator:
  - `inject_secret` — writes API keys to tmpfs
  - `inject_ssh_key` — ephemeral SSH key injection
  - `set_config` — delivers `jcard.toml` for agentd
  - `mount` — mounts host-shared directories (virtio-fs or 9p)
  - `shutdown` — graceful poweroff
- Reports lifecycle state: `booting` → `ready` → `healthy` → `shutdown`
- HTTP API on `/run/stereos/stereosd.sock` (admin group accessible)

**agentd (agent management daemon):**
- Reconciliation loop: reads `jcard.toml` + `/run/stereos/secrets/` every 5s
- Two execution modes per agent:
  - **Native** (`type = "native"`): runs the harness in a tmux session as the
    `agent` user
  - **Sandboxed** (`type = "sandboxed"`, default): runs the harness inside a
    gVisor container with read-only `/nix/store` bind mounts, tmpfs overlays
    for `/home/agent` and `/tmp`, memory limits, PID limits, and a userspace
    kernel that prevents container escape
- Support for `replicas` (launch swarms of identical agents)
- Health API on `/run/stereos/agentd.sock`

### How stereOS replaces the Docker isolation model

| Concern | Docker container | stereOS VM |
|---------|-----------------|------------|
| Kernel isolation | Shares host kernel; container escape possible | gVisor userspace kernel + separate VM kernel |
| User restriction | Container root may exist; env vars visible in `/proc` | `agent` user: no sudo, restricted PATH shell, secrets on tmpfs only |
| Resource limits | Docker cgroups (`--memory`, `--cpus`) | gVisor OCI spec memory + PID limits |
| Control plane | Must be built | stereosd vsock + HTTP API for config, secrets, lifecycle |
| Agent lifecycle | Must be built | agentd reconciliation with restart policies, timeout, grace period |
| Secret hygiene | `docker run -e` visible in `/proc/<pid>/environ` | stereosd injects to tmpfs, zeros from memory, `admin` can't read |
| Boot time | Docker start ~1s | Direct-kernel boot ~3s, total ~5s with agentd |
| Reproducibility | Dockerfile layers, mutable tags | Nix flake lock, deterministic closure manifest |
| SSH debugging | Ad-hoc or `docker exec` (requires host access) | stereosd injects ephemeral SSH keys per session |
| Filesystem mutability | Union filesystem, mutable layers | `/tmp` and `/home/agent` are tmpfs; `/nix/store` read-only bind mounts |

### The StereosOrchestrator

```typescript
// server/src/stereos-orchestrator.ts

export class StereosOrchestrator implements GatewayOrchestrator {
  constructor(opts: {
    image: string                    // Path to stereOS QCOW2 or kernel artifacts
    qemuBin?: string                 // Path to QEMU binary
    memory?: string                  // VM memory (default: '4G')
    smp?: number                     // VM CPUs (default: 2)
    network?: string                 // QEMU network config (default: SLIRP)
  })

  async startGateway(opts: StartGatewayOpts): Promise<GatewayConnectionInfo> {
    // 1. Render jcard.toml with the terminal gateway as an agentd agent
    const jcard = renderJcard({
      name: `terminal-${opts.gatewayId}`,
      harness: 'custom',
      agent: '/home/agent/workspace/ensembleworks-term',
      type: 'sandboxed',                         // gVisor sandbox
      memory: opts.backendOpts?.memory ?? '2GiB',
      pidLimit: opts.backendOpts?.pidLimit ?? 512,
      env: {
        CANVAS_URL: opts.canvasUrl,
        GATEWAY_ID: opts.gatewayId,
        GATEWAY_URL: 'null',
        GATEWAY_LABEL: opts.label,
        GATEWAY_SECRET: opts.canvasSecret,
        PORT: '8789',
      },
    })

    // 2. Launch QEMU with the stereOS image
    const vm = await this.launchVM(opts)

    // 3. Wait for stereosd readiness (vsock or TCP polling)
    await this.waitForStereosd(vm)

    // 4. Configure the VM via stereosd
    await this.configureVM(vm, jcard, { GATEWAY_SECRET: opts.canvasSecret })

    // 5. Wait for agentd to report the gateway as 'running'
    //    (The gateway process inside the gVisor sandbox connects to the canvas)

    // 6. The gateway self-registers via POST /api/gateway/register
    //    So we just wait for it to appear in the gateway registry.
    await this.waitForRegistration(opts.gatewayId, 30_000)

    const gateway = this.registry.get(opts.gatewayId)
    return {
      gatewayId: opts.gatewayId,
      url: gateway.url,          // null for relay-only
      relayOnly: !gateway.url,
      label: opts.label,
    }
  }

  async stopGateway(gatewayId: string): Promise<void> {
    // 1. Send graceful shutdown to stereosd via TCP
    //    POST /v1/shutdown to the VM's stereosd HTTP API
    // 2. Wait for QEMU to exit (up to 30 seconds)
    // 3. Kill QEMU if it doesn't exit
  }

  async listGateways(): Promise<string[]> {
    // Return gateway IDs we're managing
  }
}
```

**Key design point:** the gateway process runs inside the stereOS VM, inside a
gVisor sandbox, managed by agentd. It uses `TmuxBackend` — tmux inside the
sandbox. The `StereosOrchestrator` never touches a PTY. It manages VM
lifecycle, and the data plane (browser ↔ gateway bytes) uses the existing
relay splicer from Cycle 2.

### stereOS VM lifecycle per terminal session

```
User creates "New terminal" → "Isolated sandbox"
│
├─ 1. Canvas server: StereosOrchestrator.startGateway()
│     - Generate gateway ID: gw-stereos-{sessionId}
│     - Generate GATEWAY_SECRET
│     - Render jcard.toml with ensembleworks-term as sandboxed agent
│
├─ 2. Launch QEMU with stereOS image
│     - Memory: 4GiB default, configurable
│     - CPUs: 2 default, configurable
│     - Network: SLIRP for development, tap/bridge for production
│     - vsock: CID 3 for stereosd control plane
│
├─ 3. Wait for stereosd readiness (~3s boot)
│     - Poll GET /v1/ping on stereosd's TCP socket (port 1024)
│     - Or listen for vsock lifecycle message: {"type": "lifecycle", "payload": {"state": "ready"}}
│
├─ 4. Configure the VM via stereosd (vsock or TCP)
│     - Send jcard.toml:
│       {"type": "set_config", "payload": {"content": "..."}}
│     - Inject GATEWAY_SECRET:
│       {"type": "inject_secret", "payload": {"name": "GATEWAY_SECRET", "value": "s3cret"}}
│     - Optionally inject SSH key for admin access
│
├─ 5. agentd reconciliation loop detects new config
│     - agentd reads /etc/stereos/jcard.toml
│     - agentd reads /run/stereos/secrets/
│     - agentd launches ensembleworks-term inside a gVisor sandbox
│     - gVisor provides:
│       • Read-only /nix/store bind mounts (including the gateway binary)
│       • Writable tmpfs for /home/agent and /tmp
│       • Memory limit (default 2GiB) and PID limit (default 512)
│       • Network namespace isolation (host network within the VM)
│       • Userspace kernel (no host kernel vulnerabilities exploitable)
│
├─ 6. ensembleworks-term starts inside the sandbox
│     - Reads CANVAS_URL, GATEWAY_ID from environment (set by agentd from secrets)
│     - POSTs to /api/gateway/register on the canvas server
│     - Opens outbound WS to wss://canvas…/term/relay?gateway=gw-stereos-{sessionId}
│     - Begins heartbeat loop
│
├─ 7. Browser connects to the terminal
│     - TerminalShapeUtil resolves the gateway ID from the shape's gateway field
│     - Falls back to relay path (since GATEWAY_URL=null)
│     - Canvas relay splicer routes bytes through the VM's outbound WS
│
├─ 8. User interacts with the terminal
│     - Keystrokes → canvas relay → VM outbound WS → gVisor sandbox → tmux
│     - Output flows back the same path in reverse
│
└─ 9. Session ends / user closes terminal
      - Canvas server calls StereosOrchestrator.stopGateway()
      - POST /v1/shutdown to stereosd → graceful shutdown
      - QEMU process exits
```

### jcard.toml for a terminal session

```toml
[[agents]]
name = "terminal-session-alice"
type = "sandboxed"
harness = "custom"
agent = "/home/agent/workspace/ensembleworks-term"
workdir = "/home/agent/workspace"
restart = "on-failure"
max_restarts = 5
memory = "2GiB"
pid_limit = 512

[agents.env]
CANVAS_URL = "https://canvas.leansoftware.ai"
GATEWAY_ID = "gw-stereos-alice"
GATEWAY_URL = "null"
GATEWAY_LABEL = "Alice's sandbox"
GATEWAY_SECRET = "s3cret"
PORT = "8789"
```

### stereOS mixtape for EnsembleWorks

```nix
# stereos/mixtapes/ensembleworks/package.nix
#
# EnsembleWorks terminal gateway mixtape.
# Adds the terminal gateway binary to the agent's restricted PATH
# so agentd can launch it inside a gVisor sandbox.

{ config, lib, pkgs, ... }:

let
  # The ensembleworks terminal gateway package.
  # Built as a Nix derivation from the TypeScript source.
  ew-term = pkgs.callPackage ../../../pkgs/ew-term { };
in
{
  stereos.agent.extraPackages = [ ew-term ];
  environment.systemPackages = [ ew-term ];
  networking.firewall.allowedTCPPorts = [ 8789 ];
}
```

### Authentication and secrets flow

The stereOS approach solves a problem that Docker leaves open: how to securely
deliver the `GATEWAY_SECRET` and API keys to the isolated terminal environment.

1. The canvas server generates a `GATEWAY_SECRET` for each session.
2. When launching a stereOS VM, the orchestrator sends the secret via
   `stereosd`'s vsock `inject_secret` message.
3. `stereosd` writes the secret to `/run/stereos/secrets/GATEWAY_SECRET` on
   tmpfs (never touched to persistent disk, zeroed from memory after writing).
4. `agentd`'s reconciliation loop reads `/run/stereos/secrets/` and merges
   secrets into the agent's environment.
5. The gateway agent uses `GATEWAY_SECRET` in its `Authorization` header when
   calling `POST /api/gateway/register` and `POST /api/gateway/heartbeat`.

### Resource sizing

- **Boot time:** sub-3 seconds with direct-kernel boot; total to gateway-ready
  ~5–10 seconds including agentd, gVisor sandbox startup, and gateway
  registration.
- **Memory:** 4 GB default per VM (QEMU `-m 4G`), with 2 GiB gVisor limit
  inside. Can be reduced to 2 GB for lighter sessions.
- **CPU:** configurable via QEMU `-smp` (default 2).
- **Per-session overhead:** one QEMU process (~10 MB host memory), one VM
  kernel, one NixOS userspace, one gVisor sandbox.
- **Pre-warming:** keep a pool of "ready" stereOS VMs. When a user requests a
  terminal, inject config and start the agent (~2 seconds for agentd
  reconciliation). The VM boot latency is amortized by pool pre-warming.

### Binary packaging options

The `ensembleworks-term` binary needs to reach the VM's Nix store. Three
approaches:

1. **Nix derivation (reproducible).** Build `ensembleworks-term` as a Nix
   package. The mixtape's `package.nix` adds it to
   `stereos.agent.extraPackages`. The stereOS build produces an image with the
   binary pre-installed. Best for reproducibility.

2. **virtio-fs shared directory (pragmatic).** Use `stereosd`'s `mount` message
   to mount a host directory containing the binary. The `custom` harness in
   agentd supports any binary path. Avoids needing Nix in the EnsembleWorks
   build pipeline.

3. **Secret injection hack (quick start).** Abuse `stereosd`'s `inject_secret`
   to write the binary to `/home/agent/workspace/`. Fastest to prototype but
   least robust.

## Definition of done

- `npm run typecheck` and `npm run build` pass in `ensembleworks`.
- All existing smoke tests pass:
  - `npx tsx server/src/smoke-terminal.ts`
  - `npx tsx server/src/smoke-client.ts`
  - `npx tsx server/src/canvas-api.test.ts`
  - `shellspec spec/canvas_cli_spec.sh`
- New server tests pass:
  - `npx tsx server/src/pty-backend.test.ts`
  - `npx tsx server/src/gateway-registry.test.ts`
  - `npx tsx server/src/relay.test.ts`
  - `npx tsx server/src/docker-orchestrator.test.ts`
  - `npx tsx server/src/stereos-orchestrator.test.ts`
- New client tests pass:
  - `npx tsx client/src/terminals/gateway-registry.test.ts`
- A standalone gateway process can:
  1. Start with `CANVAS_URL` pointing at a running canvas.
  2. Register and begin heartbeating.
  3. Accept terminal connections directly on its own port.
  4. Accept terminal connections through the canvas relay.
  5. Create, list, and kill tmux sessions, visible in the canvas gateway list.
- The existing co-located deployment (Codespace and Debian VM) works unchanged:
  all terminals default to `gateway: undefined` and route through the Vite
  proxy to the co-located gateway.
- The `deploy/bootstrap-debian-ash.sh` setup creates `term.env` with `GATEWAY_ID`
  and `GATEWAY_SECRET` placeholders alongside the existing `sync.env` and
  `scribe.env`.
- A Docker container launched by `DockerOrchestrator` can:
  1. Start with `CANVAS_URL` and `GATEWAY_SECRET` env vars.
  2. Register with the canvas and accept relayed terminal sessions.
  3. Be stopped and cleaned up by `DockerOrchestrator.stopGateway()`.
- A stereOS VM launched by `StereosOrchestrator` can:
  1. Boot, receive jcard.toml and secrets via `stereosd`, and start the
     gateway agent inside a gVisor sandbox.
  2. Register with the canvas and accept relayed terminal sessions.
  3. Be gracefully shut down by `StereosOrchestrator.stopGateway()`.

## Out of scope for the initial implementation

- **Docker and stereOS orchestrators** (Cycles 6–7): documented above for
  design coherence; not implemented until cycles 0–5 ship. The `LocalOrchestrator`
  and `ManualOrchestrator` are sufficient for cycles 0–5.
- **Gateway auto-discovery** (mDNS, Consul, etc.): registration is explicit
  via `POST /api/gateway/register`. Dynamic discovery is a future enhancement.
- **Gateway-to-gateway terminal migration**: moving a live tmux session from
  one gateway to another. tmux doesn't support this natively; it would require
  session serialization or rebuilding the session on the new host.
- **Per-user OS accounts on shared gateways**: the current model uses a single
  OS user per gateway. In stereOS, each session gets its own VM with its own
  `agent` user — so this concern doesn't apply. On shared-host gateways
  (LocalOrchestrator), isolation is at the container level, not user accounts.
- **Load balancing across gateways**: the client explicitly chooses which
  gateway a terminal runs on. Automatic placement based on capacity or latency
  is a future enhancement.
- **LiveKit gateway federation**: A/V always goes directly to LiveKit Cloud.
  There's no plan to relay video through the canvas server.
- **VM pool pre-warming**: keeping a pool of stereOS VMs in "ready" state to
  amortize boot latency. A natural future optimization once Cycle 7 ships.
- **Multi-agent stereOS VMs**: running `claude-code` alongside
  `ensembleworks-term` in the same VM. agentd supports this natively via
  multiple `[[agents]]` entries, but the UX and gateway routing for multiple
  agents per VM needs further design.
---

## Spike findings (2026-07-03)

A spike validated the remote-gateway path end to end: a devcontainer on a
separate box (`candace`) hosting a **Go** connector, dialling the canvas on
`baljeet` over the tailnet, with its terminal rendered as a live shape. Branch
`worktree-remote-terminal-spike` (PR #11). Spec + plan:
[`docs/superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md`](./superpowers/specs/2026-07-03-remote-devcontainer-terminal-spike-design.md),
[`docs/superpowers/plans/2026-07-03-remote-devcontainer-terminal-spike.md`](./superpowers/plans/2026-07-03-remote-devcontainer-terminal-spike.md).

The spike deliberately scoped **narrower** than this document's full design —
one relay-only gateway, no orchestrator, no direct path — to answer three
questions. Verdicts:

### 1. Go for the gateway — confirmed, do it

The connector is ~600 lines of Go across three packages (`protocol`,
`session`, `relay`) plus `main`, with only two dependencies (`creack/pty`,
`coder/websocket`). It reimplements the terminal protocol (tmux `new-session
-A`, 256 KB scrollback replay, authoritative resize with dedup, per-viewer
fan-out) and ran **race-clean** under `go test -race`. A cross-plane smoke
(real Go connector ↔ real Node sync server ↔ real tmux) found **zero interop
bugs** — the wire contract held because the Go `protocol` tests assert the
exact JSON byte strings the Node splicer emits. This is strong evidence the
eventual full-fleet gateway (Layer 1) should be the Go rewrite this document
anticipates, not a ported `terminal-gateway.ts`.

### 2. Relay latency — acceptable

Loopback (browser → sync server → connector, all on `baljeet`) measured
**relay p50 1.3–4.2 ms / p95 3.9–8 ms vs direct `/term/ws` p50 0.9–2.8 ms** —
a relay overhead of ~0.5–1.5 ms at p50, dominated by the extra in-process WS
hop. Over the real `candace → baljeet` tailnet hop the terminal was
subjectively indistinguishable from a local one for interactive use. The
splicer's single multiplexed WS per gateway means bulk output in one session
can head-of-line-block others on that gateway; the spike accepts this and caps
per-browser buffering at 4 MB (see accepted risks in the spec). The
second-attach in the loopback harness biases the *direct* number slightly high
— treat the gap as an upper bound on relay cost, not a precise delta.

### 3. Devcontainer packaging — works, but the lifecycle is the hard part

Packaged as a devcontainer **feature** so a repo adopts it with one line in
`devcontainer.json`. Three packaging bugs only surfaced on a real remote box,
each worth recording for the Cycle 5/6 implementation:

- **A `postStartCommand` daemon does not survive.** The devcontainer CLI
  reaps the hook's `docker exec` process tree when it returns; `nohup` and
  `setsid` both left an empty log and no process. **Fix: a feature
  `entrypoint`** (the mechanism the official `sshd` feature uses), which the
  CLI chains into the container's persistent init. This is the load-bearing
  lesson — any Cycle-5 devcontainer integration must launch the gateway from
  an entrypoint, not a lifecycle command.
- **`remoteEnv` does not reliably reach a backgrounded daemon.** Config
  (`CANVAS_URL`, label) must be **baked at build time** — the spike takes it
  as feature *options* and writes `/etc/termgw.env`, which the supervisor
  sources. No runtime env propagation to fight.
- **Env-file values must be quoted.** A label with a space
  (`GATEWAY_LABEL=workshops box`) written unquoted made the sourcing shell run
  the tail as a command and leave the var unset — the connector then fell back
  to `GATEWAY_ID` → container hostname, which showed up as the gateway's label
  in the picker. Emit single-quoted, metachar-safe `KEY='value'` lines.

### 4. Client toolbar — nested dropdown dies in the overflow popover

The gateway picker was first built as a Radix dropdown on the toolbar button.
At common widths tldraw pushes custom tools into the "More" overflow popover,
where a **nested dropdown trigger silently closes the popover instead of
opening** (found via headless probe). Fix: render the picker as a plain
`TldrawUiMenuItem` whose `onSelect` opens a tldraw **dialog** — which works
identically whether the item is on the main bar or in the overflow. With zero
remote gateways registered the dialog is skipped and a local terminal is
created immediately (one fewer click for the common case).

### Protocol note — supersedes the relay-splicer sketch above

The spike's wire framing replaces the sketch in **The relay splicer** and
**The relay protocol** sections above. Instead of `{type:'relay-data', data}`
with **base64** payloads and **`crypto.randomUUID()`** channel ids, the spike
uses:

- **`channelId` as a monotonic `uint32`**, allocated by the splicer per
  gateway connection;
- **terminal output as binary WS frames with a 4-byte big-endian channelId
  prefix** (no base64, no JSON parse on the hot path) — the splicer strips the
  prefix and forwards raw bytes;
- inner control messages (`input`/`resize`/`attached`/`exit`) wrapped as
  `{type:'relay-msg', channelId, msg}` text frames.

This preserves the browser-facing protocol byte-for-byte (the existing
`TerminalShapeUtil` needed no protocol-handling changes, only a URL builder
that targets `/api/term/relay?gateway=…`). Adopt this framing when
implementing the real relay; the base64/UUID sketch above is retained only for
historical context.

### Still unproven by the spike

Direct (non-relay) LAN path; the registration/heartbeat REST protocol (the
spike collapses it into "connect = register" over the outbound WS, which
forward-ports cleanly but was not exercised); `GATEWAY_SECRET` auth (the spike
runs unauthenticated behind the tailnet/CF-Access boundary — a named accepted
risk); and the orchestrator layer (launch was manual `devcontainer up`).

**CF Access dialing is currently unwired in the devcontainer feature.** The
connector still reads `CF_ACCESS_CLIENT_ID`/`_SECRET` (main.go), but the feature
bakes only `CANVAS_URL`/`GATEWAY_LABEL`/`GATEWAY_ID` from its options — so
pointing `canvasUrl` at a CF-Access-protected prod URL would fail with an opaque
403 loop. Wiring it means either CF Access **service-token** options baked into
`/etc/termgw.env` (note: that file is world-readable 0644 in an image layer — a
secret-handling decision to make explicitly, not by accident) or a runtime
secret mount. Deferred; the spike demo targets a tailnet URL with no CF Access.
