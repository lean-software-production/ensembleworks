# Canvas sync plane on Cloudflare — design & trade-off analysis

- **Status:** Proposed (pending decision)
- **Date:** 2026-06-19
- **Companion docs:**
  - Reference architecture: [`architecture-spec.md`](./architecture-spec.md)
  - Media-plane swap: [`livekit-replacement-plan.md`](./livekit-replacement-plan.md)
  - Terminal federation: [`distributed-terminals-design.md`](./distributed-terminals-design.md)

## Context

The canvas sync plane — the CRDT-replicated spatial document of shapes + presence, the HTTP surface for agents/scribe/uploads, and the transcript-stamping/proximity logic — today runs entirely on the central VM as one Node process (`server/src/app.ts` + `server/src/sync-server.ts`). That process is the **#1 CPU and #1 RAM consumer on the VM**, it's the process the `ensembleworks.slice` `MemoryMax` cap exists to contain, and it shares a single event loop with the most latency-sensitive work in the system: cursor sync (see `architecture-spec.md` §6.6).

Three things make moving it off the VM attractive, and they've each been established in prior turns:

1. **The canvas plane is pure state with no locality requirement** — it carries only references (terminal session ids, iframe URLs), never content bytes. Of the three planes (canvas, terminal, media) it has the *most* to gain from regional placement and the *least* reason to live on any particular machine.
2. **tldraw already has a production Cloudflare backend** — `tldraw/tldraw-sync-cloudflare`, the same system that powers multiplayer on www.tldraw.com for hundreds of thousands of rooms. The current VM server's own docstring calls itself "a self-hosted replacement for the Cloudflare Durable Objects backend of the tldraw multiplayer starter kit" — so this is returning to tldraw's reference deployment target, not a novel fit.
3. **Cost.** The team is already trying to escape LiveKit's $50/month tier (`livekit-replacement-plan.md`). Moving the canvas plane to Cloudflare costs ≈$5/month for a single team (verified, see Cost below) and removes the main reason the VM needs its current RAM/CPU headroom — so it compounds the same cost-reduction goal.

This doc captures the design and — per the team's request — **explicitly outlines the pros and cons**, so the decision can be made with eyes open.

## Proposal

Move the **canvas sync plane and its HTTP surface** off the central VM onto Cloudflare's edge platform. The central VM is demoted from "the canvas authority" to "a host for some terminals, the scribe, and the access tunnel." Terminals federate per `distributed-terminals-design.md`; media moves to RealtimeKit per `livekit-replacement-plan.md`; this doc covers the canvas plane only.

```
                        browser
                          │
            ┌─────────────┼──────────────┐
            │             │              │
        /sync/{room}  /api/*         /uploads/*
            │             │              │
            ▼             ▼              ▼
   ┌────────────────────────────────────────────┐
   │  Cloudflare edge                            │
   │  ┌──────────────────┐   ┌────────────────┐ │
   │  │  Worker          │   │  R2 (assets)   │ │
   │  │  (HTTP /api/*,   │   │  edge-cached,  │ │
   │  │   token mint,    │   │  $0 egress     │ │
   │  │   relay fallback)│   └────────────────┘ │
   │  └────────┬─────────┘                      │
   │           │ one DO per room                │
   │  ┌────────▼─────────────────┐  ┌────────┐  │
   │  │ Durable Object (room)    │  │  D1    │  │
   │  │  • TLSocketRoom          │  │ (trans-│  │
   │  │  • presence + shapes     │  │  cript)│  │
   │  │  • WebSocket Hibernation │  └────────┘  │
   │  │  • SQLite-backed storage │              │
   │  │  • proximity/stamp logic │              │
   │  └──────────────────────────┘              │
   └────────────────────────────────────────────┘

                          │ (scribe POSTs /api/transcript to the Worker)
                          │ (agents hit /api/* on the Worker)
                          │ (terminals federate per distributed-terminals-design.md)
                          ▼
   ┌────────────────────────────────────────────┐
   │  Central VM (demoted)                      │
   │  • co-located terminal gateway (optional)  │
   │  • scribe (on the media plane)             │
   │  • Cloudflare Tunnel / Access (or moved)   │
   └────────────────────────────────────────────┘
```

## Component mapping

| Current (on VM) | On Cloudflare | Notes |
|---|---|---|
| One `TLSocketRoom` per room + WS fan-out + presence | **Durable Object** (one per room) | `TldrawDurableObject` from `tldraw-sync-cloudflare`, using WebSocket Hibernation (confirmed). |
| `rooms/<room>.sqlite` | **Durable Object SQLite storage** | Built-in, transactional, survives hibernation. |
| Express `/api/*` routes (sticky, shape, frames, transcript, pulse, kick, terminal-status) | **Worker** | Same route contracts; served from the edge. |
| `transcripts/<room>.jsonl` | **D1** (one table) | Gives `since=`-style queries cheaply; JSONL→rows migration. |
| `uploads/<id>` asset bytes | **R2** | Edge-cached, $0 egress (matters for agent `pull-images`). |
| Proximity-sorted reads + transcript spatial stamping | **Inside the room DO** | It already holds presence + shapes in-process — the natural home. |
| LiveKit token minting + kick | **Worker** | Same identity coupling (presence userId == media identity). |
| Terminal relay splicer (fallback path) | **Worker + DO** (optional) | Direct path stays browser→gateway; only relay fallback touches CF. See caveat. |

## What stays on the VM

- **Co-located terminal gateway + tmux** for terminals you choose to keep on the VM (terminals federate per the existing design; the VM is just one possible host).
- **The scribe** — it must be on the media plane as a subscribe-only client; its VAD is light CPU and STT is offloaded. It now POSTs `/api/transcript` to the edge Worker instead of localhost.
- **Cloudflare Tunnel + Access** (the auth boundary) — unless auth is consolidated into CF Access fronting the Worker, in which case this can leave the VM too.
- **VM-pressure monitor** — but with the sync server gone, the thing that most often blew `memory.max` is gone, so this becomes less load-bearing.

## Pros

1. **Cost drops sharply.** ≈$5/month on Workers Paid vs. the $50/month LiveKit Ship tier being escaped — and that $5 *also* covers the canvas backend that today costs VM RAM/CPU/hosting. Compounds the `livekit-replacement-plan.md` goal.
2. **Cursor latency improves for far-region users at zero ops cost.** DOs run on the edge near the user; today every cursor move round-trips to the one VM. Cursor sync is the single most latency-sensitive stream (§6.6) and the one with the most to gain from regional placement.
3. **Horizontal scale becomes Cloudflare's problem.** Today the sync server holds every room in memory and is the OOM-kill target. One DO per room = each room is an isolated mini-server; tldraw.com runs hundreds of thousands of rooms this way (~50 collaborators/room). You stop sizing one process for "worst room × all rooms."
4. **The canvas doc outlives the VM.** A VM reboot/OOM is no longer a canvas outage — connections stay alive at the CF layer via Hibernation; the DO reattaches. Resilience improves for free.
5. **The sync-server CPU scaling cliff disappears.** The proximity/stamp math (O(shapes)–O(shapes×frames), §6.6) moves into a DO whose only job is that one room — it can no longer starve *other* rooms' cursor sync because rooms no longer share an event loop.
6. **Verified Hibernation economics.** Idle rooms cost ~$0 duration; ping keep-alive is free at the platform layer (`setWebSocketAutoResponse` confirmed in `tldraw-sync-cloudflare` source). "Always-on team room, mostly idle" maps to the cheapest possible cost shape.
7. **Transcript-stamping + proximity logic gets a natural home.** That logic needs live presence + the shape doc at the point of computation; in a DO both are in-process — no cross-process view to maintain. Cleaner than today's "it happens to share a process with cursors."
8. **Data durability/residency improves.** Canvas docs + transcripts in CF's replicated storage (DO SQLite + D1) vs. one SQLite file on one VM disk. Assets in R2 get edge caching.
9. **Egress becomes free.** R2 and Workers both have $0 egress. Today agent `pull-images` and asset serving consume the VM's bounded uplink (which terminal fan-out already competes for).
10. **Load-bearing invariants preserved.** The two-planes separation (§2.1) holds — bytes still don't traverse sync. The identity coupling (presence userId == media identity == transcript speaker, §8 non-seam) holds — the Worker still mints tokens with that identity. The agent Canvas API contract holds — same routes, served from the edge.

## What the VM saves

| VM resource | Removed | Why it mattered |
|---|---|---|
| CPU — sync server process | Entire `app.ts` + `sync-server.ts`: CRDT merge, `/api/*`, proximity/stamp math | #1 VM CPU consumer; shared an event loop with cursor sync |
| CPU — cursor serving | All WS cursor fan-out + presence broadcast | Most latency-sensitive CPU on the VM |
| RAM — all rooms in memory | Every room's full document + presence/identity/latency maps | #1 VM RAM consumer; the OOM-kill target the `MemoryMax` cap exists for |
| RAM — per-room SQLite handles | One `DatabaseSync` per room | Modest per room, adds up across side rooms |
| RAM — transcript/uploads buffers | JSONL + asset read/write buffers | Moves to D1 + R2 |
| Bandwidth — canvas sync traffic | All cursor-move + edit frames | High message-rate; competed with terminal echo on the uplink |
| Bandwidth — asset serving | `GET /uploads`, agent `pull-images` | Moves to R2 (edge-cached, $0 egress) |
| Bandwidth — agent + scribe HTTP | `/api/*` bodies | Now terminate at the edge Worker |
| Disk — canvas state | `rooms/*.sqlite` | Moves to DO SQLite |
| Disk — transcripts | `transcripts/*.jsonl` | Moves to D1 |
| Disk — uploads | `uploads/*` | Moves to R2 |
| A whole systemd unit | `ensembleworks-sync` | One fewer process to supervise |
| The cgroup cap's raison d'être | `MemoryMax=1400M` was largely to stop the sync server OOM-killing the box | Cap can come down or be shared with scribe/term only |

## Cons (the honest trade-offs)

1. **The "one backup of `/home/ensemble`" unity breaks for the canvas plane.** Today canvas docs, transcripts, and uploads all live under `DATA_DIR` and are captured by a single backup of the home directory (§4.5, §6.5). After the move, that state lives in CF's storage (DO SQLite, D1, R2). You trade single-backup simplicity for CF-managed redundancy + a separate export/backup story for the CF-resident data. Terminals that stay on the VM still back up via `/home/ensemble`; only the canvas plane leaves.
2. **A hosted dependency on the core interactive path.** If Cloudflare has an incident, the canvas goes down even if the VM is fine. Today the VM is the single dependency; afterwards it's Cloudflare. The team is already accepting this implicitly for media (RealtimeKit) and access (CF Access) — adding canvas makes the VM non-critical for the interactive experience, which is either liberating or concerning depending on stance on single-vendor concentration.
3. **Terminal relay fallback on CF must be cost-checked.** The cheap estimate holds because the canvas plane is tiny. Terminal output is the VM's biggest bandwidth item and multiplies by viewer count (§6.6). Workers *don't* bill per WS message routed, but a high-volume relay Worker pays on CPU time. Mitigation: keep the distributed-terminals **direct path as primary** (browser→gateway, bypassing CF), relay only as fallback. This must be quantified before putting relay bytes through a Worker.
4. **Migration is real work.** The transcript store (JSONL→D1), the asset store (filesystem→R2), the `/api/*` routes (Express→Worker), the proximity/stamp logic (move into the DO), the scribe's POST target (localhost→edge), and the agent CLI's `CANVAS_URL` default all change. `tldraw-sync-cloudflare` is copy-paste, not `npm install` (not on the registry), so it's fork/adapt, not a turnkey package. The custom `terminal`/`iframe` shape schemas must be registered in the DO's schema (same as today on the VM server).
5. **Latency for the scribe and on-VM agents now crosses the internet.** Today the scribe POSTs `/api/transcript` to localhost; agents hit `/api/*` on localhost. After the move they hit the edge Worker — fine (both are latency-tolerant, §6.6) but it's a change, and the scribe's per-utterance POST adds a hop. For on-VM agents specifically: if the VM is far from the CF colo serving the room, agent reads gain latency. Mitigation: CF Access/Tunnel already routes VM→CF over Cloudflare's backbone, not the open internet.
6. **Single-vendor concentration deepens.** Media (RealtimeKit), access (CF Access), and now the canvas plane would all sit on Cloudflare. Operationally simpler; strategically a stronger lock-in. The escape hatch is that `tldraw-sync-cloudflare` is open and the DO shape is portable (could self-host the same DO code on a different Workers-compatible runtime, or fall back to the current VM server) — but that's theoretical until exercised.
7. **DO SQLite storage billing just turned on.** DO SQLite storage billing was enabled January 2026 (per the docs). For one team it's nowhere near the 5 GB-month included, but it's a new meter that didn't exist a year ago — worth knowing the clock is running.

## Cost (verified from Cloudflare docs, May 2026)

Workers Paid: **$5/month base**, then:

| Service | Included / month | Overage |
|---|---|---|
| Workers requests | 10M | +$0.30/M |
| Workers CPU time | 30M CPU-ms | +$0.02/M CPU-ms |
| DO requests (HTTP, RPC, **WS msgs @ 20:1**, alarms) | 1M | +$0.15/M |
| DO duration (only while active & non-hibernatable) | 400,000 GB-s | +$12.50/M GB-s |
| DO SQLite rows read / written | 25B / 50M | +$0.001/M read · +$1.00/M written |
| DO SQLite storage | 5 GB-month | +$0.20/GB-month |
| D1 rows read / written | 25B / 50M | +$0.001/M · +$1.00/M |
| D1 storage | 5 GB | +$0.75/GB-month |
| R2 storage / Class A / Class B | — | $0.015/GB-mo · $4.50/M · $0.36/M |
| R2 + Workers egress | — | **Free** |

**Estimate for a single mobbing team** (6 people, ~80 active hrs/month, plus idle time + scribe + agents):

- **DO duration:** 80 active hrs × 128 MB = ~37,000 GB-s, *inside* the 400,000 included — **$0** even with zero hibernation; idle periods free on top via Hibernation.
- **DO requests:** ~6 cursors × ~10 moves/s = 60 incoming WS msgs/s, billed at 20:1 = 3 billed/s; over 80 hrs ≈ 865k billed + agent/scribe traffic ≈ **~1M, at the included line** — a dollar or two over in a heavy month.
- **DO SQLite / D1 rows + storage:** canvas mutations and a session's transcript are thousands of rows / a few MB — **$0** (well under included).
- **R2:** a few hundred MB assets, few ops, free egress — **$0**.
- **Workers:** agent/scribe/pulse request volume well under 10M — **$0**.

**≈ $5/month**, rising to ~$5–7 in a heavy month. vs. **$50/month** LiveKit Ship tier being escaped.

The single assumption this rests on — **WebSocket Hibernation makes idle rooms ~$0 duration** — is confirmed in the `tldraw-sync-cloudflare` source (`ctx.acceptWebSocket`, `setWebSocketAutoResponse` for ping/pong, `webSocketMessage/Close/Error` overrides, `handleSocketResume` on wake).

## Open questions / risks to de-risk before committing

1. **Custom shapes in the DO schema.** The `terminal` and `iframe` custom shape types must be registered in the DO's `createTLSchema` exactly as in `server/src/schema.ts`, or existing rooms' records fail validation on load. Mechanical, but a migration gate.
2. **Transcript JSONL → D1 migration.** Existing `transcripts/*.jsonl` files need a one-time import into D1, and the `since=`/`limit=` semantics must be preserved (the `transcript-store` returns oldest-first with `now` for chaining polls).
3. **Asset URL stability.** Image shapes reference assets by `assetId` resolved to `/uploads/<id>` today. Moving to R2 changes the URL scheme; the read endpoints and `pull-images` must still surface resolvable URLs (signed R2 URLs or a Worker route in front of R2).
4. **Relay-through-Worker cost.** Quantify CPU-time cost of the terminal relay fallback path on a Worker before relying on it (Cons #3). Keep direct path primary.
5. **DO `updateStore` equivalent for the agent write endpoints.** `/api/sticky`, `/api/shape`, `/api/terminal-status` today call `room.updateStore(...)`. The DO exposes the same `TLSocketRoom`, so this maps directly — but the Worker→DO call is now an RPC (billed as a DO request) rather than an in-process call. Request volume is low (agent-paced), so cost is negligible; worth confirming the RPC shape.
6. **Access identity flow.** Today the VM server captures `Cf-Access-*` headers at WS upgrade. With the Worker on the edge, the headers are available to the Worker directly — and CF Access in front of the Worker is the natural consolidation. Confirm the verified-JWT mode (`access-identity.ts`) ports cleanly into the Worker.
7. **Scribe + on-VM agent latency.** Measure the added hop from VM→edge Worker for `/api/transcript` and agent reads over the Cloudflare backbone (Cons #5).

## Relationship to the other plans

- **`livekit-replacement-plan.md`** (media): independent but complementary — both move planes off the VM to Cloudflare; doing both maximizes cost savings and removes the reasons the VM needs its current size. Either can proceed without the other.
- **`distributed-terminals-design.md`** (terminals): independent. Terminal federation is unaffected by where the canvas plane lives; the relay fallback path is the only shared surface, and it's where Cons #3 bites.
- **`architecture-spec.md`**: this design instantiates the **canvas spatial store** seam (§8) with "Cloudflare Durable Objects" as the concrete choice, and demotes the VM in the topology (§2) from "canvas authority" to "terminal/scribe/tunnel host."

## Decision

Pending. This doc exists to make the pros/cons legible so the team can decide via its lightweight decision process. If taken forward, the next step is an implementation plan (cycles: schema port → DO room + Worker routes → D1 transcript → R2 assets → scribe repoint → agent CLI default → cutover), scoped separately.
