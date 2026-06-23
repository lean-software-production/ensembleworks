# Self-host LiveKit OSS — migration spec

- **Status:** Proposed (pending decision PR, per [ADR-0001](../../decisions/0001-lightweight-decision-process.md))
- **Date:** 2026-06-20
- **Companion docs:**
  - Evaluation & measurements: [`livekit-replacement-plan.md`](./livekit-replacement-plan.md) §"Re-evaluation & measurements"
  - Memory/resource policy this extends: [`memory-resource-policy.md`](./memory-resource-policy.md)
  - VM performance profile: [`architecture-spec.md`](./architecture-spec.md) §6.6
  - Canvas-on-Cloudflare (independent): [`canvas-on-cloudflare-design.md`](./canvas-on-cloudflare-design.md)

## Goal

Replace the hosted **LiveKit Cloud** media plane with a self-hosted **LiveKit OSS
SFU** running on the central VM, with **zero change to the client A/V layer, zero
change to the scribe's transcription logic, and one small server-side URL split.**
Drop the recurring cost from $50/mo (LiveKit Cloud *Ship*) to **$0 incremental
hosting** — the box was already resized to 8 GB (see
[`memory-resource-policy.md`](./memory-resource-policy.md)).

### Non-goals

- No client rewrite. `client/src/av/useLiveKitRoom.ts` (WebAudio gain pipeline,
  spatial audio, active-speaker) and `client/src/av/AvOverlay.tsx` are untouched.
  LiveKit Cloud and LiveKit OSS speak the same protocol, so `livekit-client`
  `Room.connect(url, token)` works against either.
- No scribe rewrite. `transcriber/src/transcriber.ts` keeps its per-participant
  raw-PCM → VAD → Groq Whisper pipeline unchanged; only the signaling URL it
  connects to moves to localhost.
- No TURN relay (deferred — see [Out of scope](#out-of-scope)). Direct ICE over
  the opened UDP range is the primary media path.
- No simulcast / SVC tuning, no recording, no e2ee. Parity with today's
  LiveKit Cloud usage only.

## Why this is now viable (summary of the re-evaluation)

The original `livekit-replacement-plan.md` killed self-hosting on **RAM** ("the
current box would OOM under an SFU"). That premise is gone: the VM is now 8 GB
(7.6 GiB usable, 5.9 GiB free) with percentage-based cgroup limits. Two further
gates the original plan never measured were checked on 2026-06-20 and both pass:

- **Uplink:** measured ≈ 770 Mbps up / ≈ 560 Mbps down vs. ~78 Mbps SFU egress
  for a 6-camera mob (~10× headroom).
- **CPU:** 2 vCPU at 92–98% idle, load 0.25; a LiveKit SFU (Go, **no
  transcoding** — it forwards RTP) for one 6-person room is <0.3 core. The real
  thing to manage is **CPU isolation**, not capacity (see
  [Resource isolation](#resource-isolation-cpu--memory)).

The one genuine trade accepted by this spec is **single-region latency**: every
participant now terminates media on one box instead of a global edge SFU. For a
mob that is near the box this is a non-issue (often better than a far edge POP);
for any far-region regular it's full RTT. That trade — versus paying $50/mo for
LiveKit Cloud's global edge — is the actual decision for the team.

## Design

```
                         browser (authed via CF Access)
                           │
            ┌──────────────┼─────────────────┐
            │ signaling WS │ media (WebRTC)  │
            │ wss://…/livekit│ UDP 50000-50300│
            ▼              ▼                 │
   ┌─────────────────────────────┐           │
   │  Cloudflare Tunnel + Access │           │
   │  (canvas.leansoftware.ai)   │           │
   └─────────────┬───────────────┘           │
                 │ :8080 (Caddy)             │
                 ▼  /livekit → localhost:7880│
   ┌──────────────────────────────┐          │
   │  VM                          │◄─────────┘
   │  Caddy :8080 ── /livekit ──► livekit-server :7880 (signaling WS)
   │                              livekit-server :7880 ← scribe (ws://localhost)
   │                              livekit-server UDP 50000-50300 (media, public)
   │  ensembleworks-sync ─ RoomService → http://localhost:7880 (kick)
   │  ensembleworks-scribe ─ Room.connect(ws://localhost:7880, token)
   └──────────────────────────────┘
```

**Signaling** stays on the existing no-inbound-TCP posture: the LiveKit
signaling WebSocket is proxied through the **Cloudflare Tunnel → Caddy →
localhost:7880** at `wss://canvas.leansoftware.ai/livekit`, so browsers reach it
on the same origin and auth boundary (CF Access) they already use. **Media** is
the one posture change: a **UDP range (50000–50300, narrowed) is opened to the
box's public IP** for direct ICE. No new inbound TCP port (the default ICE-TCP
7881 listener is disabled via `rtc.tcp_port: 0`). (A direct-7880-TCP
alternative is noted under
[Signaling routing — alternative](#signaling-routing--alternative).)

The scribe and the sync server's `RoomServiceClient` are **co-located on the VM**,
so they connect/sign to `localhost:7880` directly — they do **not** round-trip
through Cloudflare (which would also fail CF Access, since neither carries
browser cookies). This is the one small code change (see below).

## Application code changes

The application is almost untouched because `livekit-server-sdk` (token mint +
room service) and `livekit-client` / `@livekit/rtc-node` speak the same protocol
to LiveKit OSS as to LiveKit Cloud. The only change is splitting the **public
signaling URL** (browsers) from the **internal signaling URL** (scribe +
RoomService).

### `server/src/app.ts` — RoomServiceClient uses an internal URL

Today (lines 49–53):

```ts
const LIVEKIT_URL = process.env.LIVEKIT_URL // e.g. wss://canvas-vm.tail1234.ts.net/livekit
const liveKitRoomService =
	LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_URL
		? new RoomServiceClient(LIVEKIT_URL.replace(/^ws/, 'http'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
		: null
```

`LIVEKIT_URL` is the public `wss://…/livekit` returned to browsers at the token
endpoint (line 395). Deriving the RoomService HTTP base from it would route the
server's own kick call out to Cloudflare and into CF Access, where it has no
cookies. Change to a dedicated internal env var:

```ts
// Public signaling URL returned to browser clients (wss://…/livekit via tunnel).
const LIVEKIT_URL = process.env.LIVEKIT_URL
// Internal HTTP base for the server's own RoomService calls (kick). The sync
// server is co-located with livekit-server, so hit it on localhost and skip the
// Cloudflare Tunnel + Access round-trip. Defaults to the public URL's HTTP form
// for LiveKit Cloud (where there is no separate internal endpoint).
const LIVEKIT_API_URL = process.env.LIVEKIT_API_URL ?? LIVEKIT_URL?.replace(/^ws/, 'http')
const liveKitRoomService =
	LIVEKIT_API_KEY && LIVEKIT_API_SECRET && LIVEKIT_API_URL
		? new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
		: null
```

The token endpoint (lines 365–395) is **unchanged** — it still returns
`{ enabled, token, url: LIVEKIT_URL }`, and `url` is the public `wss://…/livekit`
that browsers need. No other server change.

### `transcriber/src/transcriber.ts` — scribe connects on localhost

Today `fetchToken()` returns `{ url: info.url, token }` and `main()` does
`room.connect(info.url, info.token)`. The `info.url` is the sync server's public
`LIVEKIT_URL`, which routes the scribe into CF Access (no cookies → blocked).
The scribe is co-located with the SFU, so it should connect on localhost. Minimal
change: prefer a scribe-local `LIVEKIT_URL` env over the endpoint's `url`:

```ts
// Co-located with the SFU: connect signaling to localhost, not the public
// tunneled URL the token endpoint returns (which is behind CF Access).
const LIVEKIT_URL = process.env.LIVEKIT_URL // ws://localhost:7880
```

and in `fetchToken`/`main`, use `LIVEKIT_URL ?? info.url` for the connect target
(keep `info.token` from the endpoint — the JWT is the same either way):

```ts
return { url: LIVEKIT_URL ?? info.url, token: info.token }
```

(If `LIVEKIT_URL` is unset in `scribe.env`, behavior is unchanged — the fallback
to `info.url` keeps LiveKit Cloud working, so this is a safe, reversible change
that lands before the cutover.)

### What is **not** changed

- `client/src/av/useLiveKitRoom.ts` — none.
- `client/src/av/AvOverlay.tsx` — none.
- `server/src/app.ts` token mint (`AccessToken`, `addGrant`, `canPublish`/scribe
  role) — none. LiveKit OSS accepts the same JWT grants.
- `server/src/scribe-api.test.ts` — none (it sets `LIVEKIT_URL=wss://example.test/livekit`
  and no `LIVEKIT_API_URL`; the `??` default preserves the old derived URL, so
  the test stays green). Add one new test asserting `LIVEKIT_API_URL` is honored
  when set.

## `livekit-server` install + config

Install the `livekit-server` binary (Go, single static binary) from the official
GitHub releases into `/usr/local/bin`. Add to `deploy/bootstrap-debian.sh` as a
new install step (idempotent, like the Caddy/cloudflared steps):

```sh
LIVEKIT_VERSION="1.x" # pin to a concrete release
if ! command -v livekit-server >/dev/null 2>&1; then
  log "Installing livekit-server ${LIVEKIT_VERSION}"
  curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit-server_${LIVEKIT_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin livekit-server
fi
```

Config at `/etc/livekit/livekit.yaml` (written by bootstrap, owned by
root:`ensemble-livekit`, `chmod 0640`; the API secret is sensitive but the
`ensemble-livekit` service user must read it):

```yaml
port: 7880                 # signaling WS (proxied via Caddy /livekit)
bind_addresses: ["127.0.0.1"]  # loopback only — Caddy/RoomService/scribe hit localhost
rtc:
  tcp_port: 0              # CRITICAL: disables the default *:7881 ICE-TCP listener
                           # (bind_addresses does NOT govern it); see Out of scope
  port_range_start: 50000  # UDP media range — OPEN in the firewall (narrowed)
  port_range_end: 50300
  node_ip: <PUBLIC_IP>     # pin the box's stable public IP (deterministic, not STUN)
  use_external_ip: false   # pin node_ip instead; flip to true only behind NAT/unknown
  interfaces:              # bind ICE UDP sockets only on lo + the public interface;
    includes:               # excludes docker0 / docker bridges, which would inflate
      - lo                  # per-peer port usage ~2x and cut the 300-port ceiling.
      - eth0
keys:
  # MUST match LIVEKIT_API_KEY / LIVEKIT_API_SECRET in sync.env + scribe.env.
  # Secret must be >=32 chars (openssl rand -hex 32 = 64 chars).
  <APIKEY>: <SECRET>
logging:
  level: info
```

`rtc.node_ip` pins the box's stable public IPv4 for ICE candidate advertising
(deterministic — avoids a class of "boots with no/wrong ICE candidate" failures
that `use_external_ip: true`'s boot-time STUN lookup can hit). Hetzner IPs are
stable, so pinning is more robust. `bind_addresses: ["127.0.0.1"]` binds
signaling to loopback so a firewall misconfig can't expose it. `rtc.tcp_port: 0`
is load-bearing: the default `7881` ICE-TCP listener binds to `*` (all
interfaces) and would break the no-inbound-TCP posture, and `bind_addresses` does
NOT govern it (verified against livekit-server v1.13.1). `rtc.interfaces.includes:
[lo, eth0]` restricts ICE host-candidate UDP sockets to loopback + the public
interface, excluding the box's `docker0` and docker bridges (which carry no
media). Empirically measured on the production VM: without the filter the SFU
binds a UDP socket per interface per peer (~10 ports/peer across 4 interfaces,
capping the 300-port range at ~25-30 concurrent peers); with `includes:[lo,eth0]`
it binds 2 interfaces (~5-6 ports/peer), raising the ceiling to ~45-50 peers. If
the VM's public interface is named differently (e.g. `ens3`), update the list.
If the box has both
public IPv4 and IPv6, confirm which families browsers actually reach (see
[Prerequisites to confirm](#prerequisites-to-confirm)).

Generate the key/secret once (`openssl rand -hex 32` for the secret) and place
the **same** `APIKEY:SECRET` in three spots: `livekit.yaml`, `sync.env`, and
`scribe.env`. `livekit-server-sdk`'s `AccessToken` signs JWTs with this secret;
LiveKit OSS validates them with the same secret — no protocol change.

## Network / firewall / ports

This is the **one real change to the box's posture**, previously "no inbound
ports, tunnel dials out":

| Port | Proto | Direction | Purpose | New? |
|---|---|---|---|---|
| 7880 | TCP | loopback only | signaling WS (Caddy proxies /livekit → :7880) | no (loopback) |
| 50000–50300 | UDP | **inbound, public** | WebRTC media (direct ICE) | **yes — open (narrowed)** |
| 7881 | TCP | disabled (`tcp_port: 0`) | ICE-TCP fallback | off by default; see Out of scope |
| 443 / 8080 | TCP | via tunnel (unchanged) | app + /livekit signaling | no |

Open the UDP range in the host firewall (add to `deploy/bootstrap-debian.sh`):

```sh
if command -v ufw >/dev/null 2>&1; then
  ufw allow 50000:50300/udp comment 'livekit-media-UDP'
  # ufw allow 7881/tcp  # ICE-TCP fallback — off by default (tcp_port: 0); enable only if needed
fi
```

The Cloudflare Tunnel public hostname (`canvas.leansoftware.ai`) already maps to
Caddy `:8080`. Add a `/livekit` route to `deploy/Caddyfile` so signaling is
reverse-proxied to the SFU (before the Vite catch-all):

```caddyfile
@livekit path /livekit /livekit/*
handle @livekit {
	reverse_proxy localhost:7880
}
```

CF Access already covers the whole `canvas.leansoftware.ai` application domain,
so `/livekit` inherits browser-cookie auth for free — only authed browsers can
upgrade the signaling WS. (The LiveKit JWT itself is a second layer: the SFU
rejects any connection without a validly-signed token, so even a leaked
signaling URL isn't exploitable without a minted token — same model as LiveKit
Cloud.)

## Signaling routing — alternative

An alternative is to **not** proxy signaling through the tunnel and instead
expose `livekit-server`'s 7880 directly on a subdomain (e.g.
`livekit.leansoftware.ai`) with a DNS record pointing at the box's public IP and
Caddy auto-provisioning TLS. Pros: no signaling round-trip through Cloudflare
(lower signaling latency), and the scribe/RoomService internal-URL split becomes
optional (they'd still prefer localhost for efficiency, but would work via the
public host). Cons: opens one inbound TCP port, requires a DNS record, and
removes CF Access from the signaling path (relying solely on the LiveKit JWT for
auth — which is fine, but is a different posture).

This spec picks the **tunneled** path to preserve the no-inbound-TCP posture and
the existing auth boundary, accepting the small internal-URL split. The
direct-7880 path is a one-line `Caddyfile` + DNS change away if signaling
latency or the split proves annoying.

## Resource isolation (CPU & memory)

This is the design point the §6.6 concern ("SFU spike stutters cursors") makes
load-bearing, and it's a direct extension of
[`memory-resource-policy.md`](./memory-resource-policy.md). Run `livekit-server`
in **its own slice**, separate from `ensembleworks.slice`, with:

- **`CPUWeight` below the sync/term services** so an SFU spike is throttled
  before the latency-critical cursor/terminal path. The dev services keep their
  implicit weight (100); the SFU gets `CPUWeight=50`. The SFU is the
  "spiky, low-blast-radius" tenant — the same role `term` plays for memory —
  except here it's *CPU* contention that threatens the interactive feel, so the
  SFU is the throttled-first CPU tenant.
- **Its own `MemoryMax`** outside `ensembleworks.slice` so the dev-services cap
  and the SFU cap are independent and both leave OS headroom. Starting point:
  `MemoryMax=1.5G` (an SFU for 6 people is well under 1 G even with cameras on;
  1.5 G gives headroom without starving the box).
- Because the dev slice ceiling is a percentage (88% of 7.6 G ≈ 6.7 G) and the
  SFU adds up to 1.5 G, the combined ceiling (8.2 G) can exceed RAM if both are
  pinned simultaneously. To keep combined headroom, **lower the dev slice
  ceiling when the SFU is added**: `MemoryHigh=60% / MemoryMax=70%` (≈4.6/5.3 G)
  for `ensembleworks.slice`, plus `MemoryMax=1.5G` for the media slice. That
  leaves ~0.8 G OS headroom under simultaneous maxima — the same posture the
  memory policy targets. These are starting points; tune against real RSS.

New unit `deploy/systemd/ensembleworks-livekit.service`:

```ini
[Unit]
Description=LiveKit OSS SFU (self-hosted media plane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ensemble
# Own slice — see ensembleworks-media.slice. The SFU is the throttled-first
# CPU tenant (CPUWeight below sync/term) so a media spike can't stutter
# cursor sync (architecture-spec.md §6.6).
Slice=ensembleworks-media.slice
MemoryAccounting=yes
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=on-failure
RestartSec=2
# No EnvironmentFile — config (incl. API secret) lives in /etc/livekit/livekit.yaml,
# chmod 0640 root:ensemble-livekit (the service user must read it).

[Install]
WantedBy=multi-user.target
```

New slice `deploy/systemd/ensembleworks-media.slice`:

```ini
[Slice]
Description=EnsembleWorks media plane (LiveKit SFU) — own cap, throttled-first CPU
MemoryAccounting=yes
MemoryHigh=1G
MemoryMax=1500M
CPUWeight=50
```

`deploy/bootstrap-debian.sh` writes both, installs them, and adjusts the dev
slice down: `systemctl set-property ensembleworks.slice MemoryHigh=60% MemoryMax=70%`
(the memory policy doc already documents `set-property` for live changes).

## Env var mapping

| File | Var | Self-host value | Notes |
|---|---|---|---|
| `/etc/livekit/livekit.yaml` | `keys.<APIKEY>` | the shared secret | SFU validates JWTs against this |
| `~/.config/ensembleworks/sync.env` | `LIVEKIT_URL` | `wss://canvas.leansoftware.ai/livekit` | returned to browsers |
| `~/.config/ensembleworks/sync.env` | `LIVEKIT_API_URL` | `http://localhost:7880` | **NEW** — RoomService kick (internal) |
| `~/.config/ensembleworks/sync.env` | `LIVEKIT_API_KEY` / `_SECRET` | the shared key/secret | match `livekit.yaml` |
| `~/.config/ensembleworks/scribe.env` | `LIVEKIT_URL` | `ws://localhost:7880` | scribe is co-located |
| `~/.config/ensembleworks/scribe.env` | `LIVEKIT_API_KEY` / `_SECRET` | same | |
| `~/.config/ensembleworks/scribe.env` | `STT_*` | unchanged | Groq Whisper still offloaded |

`bootstrap-debian.sh` writes these as placeholders only if absent (its existing
policy), so re-runs never clobber real secrets. The placeholder comments should
be updated to point at self-host values rather than `YOUR-PROJECT.livekit.cloud`.

## Migration / cutover

The cutover is a config + env flip, not a code migration. It is **fully
reversible** — to roll back, restore the LiveKit Cloud env values and restart
two units.

1. **Land the code changes** (the `LIVEKIT_API_URL` split + scribe localhost
   fallback) behind the existing env defaults. With no `LIVEKIT_API_URL` set and
   no scribe `LIVEKIT_URL`, behavior is identical to today (LiveKit Cloud). CI
   green.
2. **Install livekit-server** (bootstrap step) + write `/etc/livekit/livekit.yaml`
   with a freshly generated key/secret. Do not enable the unit yet.
3. **Open the UDP range** in the firewall. Confirm reachability from an external
   host (see [Prerequisites to confirm](#prerequisites-to-confirm)).
4. **Add the `/livekit` route** to `Caddyfile` and `caddy reload`.
5. **Set the env values** in `sync.env` / `scribe.env` to the self-host values
   above (same key/secret as `livekit.yaml`).
6. **Enable + start** `ensembleworks-livekit.service`. Confirm
   `livekit-server` boots and logs "ready" with the discovered external IP.
7. **Restart** `ensembleworks-sync` (picks up new env, mints tokens for the OSS
   SFU) and `ensembleworks-scribe` (connects on localhost).
8. **Verify** with two browsers (see below).

### Rollback

```sh
# Restore LiveKit Cloud values in sync.env + scribe.env, then:
sudo systemctl stop ensembleworks-livekit.service
sudo systemctl restart ensembleworks-sync ensembleworks-scribe
```
The client and scribe reconnect to LiveKit Cloud on next token fetch. The UDP
range can stay open (harmless) or be closed with `ufw delete allow 50000:50300/udp`.

## Verification (acceptance)

- [ ] `ensembleworks-livekit.service` is `active (running)`; logs show the SFU
  discovered the box's public IP for ICE.
- [ ] **Two browsers** in the same canvas room see and hear each other; remote
  audio is a real `MediaStreamTrack` driven through the existing WebAudio gain
  pipeline (spatial loudness tracks canvas distance — unchanged from LiveKit
  Cloud).
- [ ] Active-speaker events still drive the faces-rail "speaker pop".
- [ ] **Scribe** joins as `📝 scribe` (subscribe-only, `readOnly`), transcribes
      a spoken utterance, and `POST /api/transcript` lands stamped with the
      speaker's cursor position (unchanged pipeline).
- [ ] **`POST /api/kick`** removes a participant from the media room via
      `RoomServiceClient` against `http://localhost:7880` (the `LIVEKIT_API_URL`
      path).
- [ ] Under a deliberate SFU load spike (e.g. 6 cameras + a loud build in a
      terminal), cursor sync does not stutter — the `CPUWeight=50` isolation
      holds.
- [ ] `npm run build` (tsc --noEmit) passes in `server` and `transcriber`; the
      new `LIVEKIT_API_URL` test passes.

## Prerequisites to confirm (before or during step 3)

1. **Public IP family.** Confirm the box has a **public IPv4** (and IPv6) and
   that the UDP range is reachable on it from the open internet. Earlier
   `curl ifconfig.me` returned only IPv6 (`2a01:4ff:f0:95fc::1`); verify IPv4
   exists (Hetzner VMs usually have both) and pick the family browsers will
   use. If only IPv6, ensure the SFU advertises IPv6 candidates and clients
   have IPv6 connectivity.
2. **UDP reachability.** From an external host, confirm a test UDP packet to
   the range reaches the box (e.g. `nc -u` both ends, or a quick `nmap -sU -p
   50000-50010`). Cloudflare Tunnel does **not** carry this — it must be direct.
3. **Hetzner firewall.** Hetzner has a cloud firewall *in addition to* host
   `ufw`. If it's enabled, open the UDP range in the Hetzner console too — use
   the rule name `livekit-media-UDP` (matching the host `ufw` comment, for a
   single cross-verifiable token) — or the host `ufw` rule alone won't suffice.
4. **`livekit-server` release.** Pinned to `1.13.1` (latest stable at
   implementation time, verified via the GitHub releases API). Config field
   names (`bind_addresses`, `rtc.node_ip`, `rtc.tcp_port`, `rtc.interfaces`)
   verified against `pkg/config/config.go` and empirical binary testing.

## Out of scope (deferred)

- **TURN relay** (for browsers behind symmetric NAT / restrictive corp
  networks). LiveKit has a built-in TURN (TCP 7881, TLS 5349); enabling it is a
  config + port flip if a participant can't establish direct ICE. Start without
  it; add per-participant need.
- **ICE-TCP (7881)** fallback — disabled by default via `rtc.tcp_port: 0`
  (the default 7881 listener binds to `*` and would break the no-inbound-TCP
  posture; `bind_addresses` does not govern it). Re-enable (set `tcp_port: 7881`
  and open it in the firewall) only if UDP is blocked somewhere.
- **Simulcast / SVC / bandwidth tuning** — LiveKit OSS supports it; not needed
  for parity with today's 720p mob.
- **Recording, e2ee, room service beyond kick** — not used today.
- **Monitoring/alerting for the SFU** — reuse the existing VM-pressure monitor;
  add an SFU-health check in a follow-up if it proves load-bearing.

## Relationship to the other plans

- **[`livekit-replacement-plan.md`](./livekit-replacement-plan.md)** — this spec
  is its outcome: the re-evaluation made self-host OSS the preferred path, so
  the RealtimeKit spike is skipped.
- **[`canvas-on-cloudflare-design.md`](./canvas-on-cloudflare-design.md)** —
  independent. Moving the canvas plane to Cloudflare and moving the media plane
  to self-hosted LiveKit OSS are orthogonal; doing both maximizes cost savings
  and removes the reasons the VM needs its current size, while keeping the media
  plane OSS/portable (a deliberate counterweight to the canvas plane's deepening
  Cloudflare concentration).
- **[`memory-resource-policy.md`](./memory-resource-policy.md)** — this spec
  extends that policy with a second slice (media) and the CPU-weight dimension.
  Update that doc's "Resizing the VM" section to mention the media slice once
  landed.
