# A/V resilience & connection observability

Make the LiveKit session self-heal the way the canvas already does, and make
connection failures diagnosable after the fact. Today a single terminal
LiveKit disconnect leaves A/V dead until the user reloads the page, and when a
multi-user session degrades, neither the server journal nor any client record
can say which participant's connection failed, when, or why. This spec covers
the client reconnect state machine, a connection-event telemetry beacon, and a
small set of sync-server hardening items surfaced by the 2026-07-06 incident
investigation.

## Background — the 2026-07-06 incident

Five people, some on high-latency connections, ~17:00–19:30 UTC. Symptoms:
LiveKit audio/video dropped out, and "everyone else vanished from the canvas";
waiting brought canvas presence back, but A/V needed a full page refresh. With
two well-connected users the problem never appears.

What the investigation established (journals on `ew-lsp-001` + code reading):

- **No server-wide event.** The sync server never restarted (NRestarts=0
  across the window), no OOM kills, no cloudflared tunnel restarts. There is
  also no code path by which one participant's disconnect removes others:
  canvas presence is pure tldraw sync — the LiveKit participant list never
  touches the tldraw store, and the server has no LiveKit webhooks.
- **"Everyone vanished" is the tldraw client's own health check.** If a
  client hears nothing on its `/sync` socket for >10 s, sync-core's
  `resetConnection()` deletes *every* remote presence record from the local
  store, then reconnects (`TLSyncClient` — `PING_INTERVAL` 5 s,
  reset threshold 10 s). Waiting fixes the canvas because sync-core
  auto-reconnects.
- **A/V never comes back because the hook has no recovery path.** On terminal
  `Disconnected`, `useLiveKitRoom.ts` sets `status('error')` and stops
  (`client/src/av/useLiveKitRoom.ts:174`). No `Reconnecting`/`Reconnected`
  handlers, no re-fetch of the (12 h TTL) token, no retry. Only a remount —
  i.e. a reload — reconnects.
- **The trigger correlates with one constrained client.** The sync journal
  shows 507 session-churn warnings on Jul 6 (zero on every other day),
  spiking at 17:50 UTC, dominated by a single userId whose pruned session
  kept receiving dozens-per-second message backlog flushes; LiveKit logged
  transport errors + participant closes at 17:10/17:38/17:59/19:29/19:54 and
  bandwidth-estimator congestion at 17:22.
- **Leading theory for the shared dropouts:** on a marginal downlink, 4
  remote A/V streams saturate the pipe and the `/sync` WebSocket starves
  alongside the media — both fail together, which is exactly the observed
  pairing. Scales with participant count; invisible at N=2. Unconfirmed
  because no client-side connection events were recorded — hence the
  telemetry half of this spec.

(Resolved separately, same investigation: the `ensembleworks-term` EADDRINUSE
crash loop — orphaned gateway held :8789 across deploys. Fixed via
`ExecStartPre` port guard in the term units, 2026-07-07.)

## Decisions

- **A/V self-heals; reload is never the recovery procedure.** The livekit
  SDK's built-in reconnect handles transient blips; the hook adds the missing
  layer — full re-join with a *fresh token* on terminal disconnect,
  indefinitely, with backoff. A canvas session is long-lived (hours); the
  12 h token TTL means a cached token is not safe to retry with.
- **Show the degradation.** A `reconnecting` status is user-visible state,
  not a hidden retry: the faces rail dims rather than vanishing, so users
  learn "my link is bad", not "everyone left".
- **Telemetry before tuning.** The downlink-saturation theory stays a theory
  until a degraded session is recorded from every participant's viewpoint at
  once. Client connection events ship to the server and land in one JSONL
  per room, so the next bad session is diagnosable without asking anyone to
  open devtools.
- **Sync hardening rides along but is secondary.** The buffer cap, the
  upgrade-handler try/catch, and `/sync` connection logging close real gaps
  found in the investigation, but none of them explains the incident; they
  must not gate the client work.
- **TURN / ICE-TCP stays deferred** (consistent with
  `docs/livekit-self-host-spec.md`). Revisit only if telemetry shows clients
  failing to establish/keep media where the sync socket stays healthy —
  that signature is a media-path problem, not downlink saturation.

## Design

### 1. LiveKit reconnect state machine (`client/src/av/useLiveKitRoom.ts`)

Status gains two values:

```
status: 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'retrying' | 'error'
```

- `reconnecting` — the SDK's own recovery is in flight
  (`RoomEvent.Reconnecting` / `SignalReconnecting`); media objects are still
  live, peers are kept.
- `retrying` — the room reached terminal `Disconnected` and the hook is
  re-joining from scratch (new token, new `Room`).
- `error` — remains only for non-retryable ends (see below).

Wiring:

- `RoomEvent.Reconnecting` / `SignalReconnecting` → `setStatus('reconnecting')`.
- `RoomEvent.Reconnected` → `setStatus('connected')`; `rebuildPeers` (track
  subscriptions may have churned while away).
- `RoomEvent.Disconnected (reason)` → classify:
  - **Non-retryable:** `DUPLICATE_IDENTITY`, `PARTICIPANT_REMOVED` (the
    `/api/av/kick` path — re-joining would fight the kick), `ROOM_DELETED`.
    → `setStatus('error')`, stop.
  - **Everything else** (network failure, signal timeout, server restart,
    token-expiry rejections) → schedule a re-join.
- Re-join loop: tear down the old `Room`'s listeners and audio pipelines
  (reuse the existing `detachAudio` path), then rerun `connect()` — which
  already fetches a fresh token, so TTL expiry is a non-issue. Backoff:
  exponential with jitter, 1 s → 30 s cap, retry forever (a canvas tab left
  open overnight should re-join by itself in the morning). The effect's
  `cancelled` flag guards the loop on unmount exactly as it guards the
  initial connect.
- Republish state: after a successful re-join, re-apply `micEnabled` /
  `camEnabled` so a user who was live comes back live (today those are
  React-state only; the new `Room` starts with nothing published).

UI (`client/src/av/AvOverlay.tsx` + status pill):

- `reconnecting`/`retrying` → keep the local self-bubble, dim the rail, show
  a small "reconnecting…" indicator where the mic controls live. Do **not**
  clear `peers` — frozen dimmed faces communicate "link degraded" honestly.
- `error` → today's treatment, now reserved for genuinely dead ends.

### 2. Connection telemetry beacon

A small client module (`client/src/av/connectionLog.ts`) that records
connection-lifecycle events from **both planes** and ships them to the server:

- LiveKit: `Reconnecting`, `SignalReconnecting`, `Reconnected`,
  `Disconnected(reason)`, `ConnectionQualityChanged(participant, quality)`,
  plus each re-join attempt/outcome from the new state machine.
- tldraw sync: status transitions from `useSync`'s connection status
  (online/offline), which bound the moments presence was wiped.

Event shape: `{ ts, roomId, userId, plane: 'livekit'|'sync', event, detail }`.
Buffered and flushed with `navigator.sendBeacon` (POST
`/api/telemetry/connection`, batched, ~5 s debounce, fire-and-forget — the
beacon must never make a bad connection worse; drop on failure). Also mirrored
to `console.debug` for live devtools reading.

Server side (`server/src/features/telemetry.ts`): validate + append to
`<data-dir>/telemetry/<roomId>-connection.jsonl` via the async-append pattern
used by `server/src/transcript-store.ts`, and emit one journal line per batch
so `journalctl -u ensembleworks-sync` can cross-reference client-perceived
drops against server-side session churn. Cap file size (rotate at ~10 MB);
no read API in v1 — operators read the file.

### 3. Sync-plane hardening (secondary, same PR series)

- **Per-connection `/sync` logging** in the upgrade/close handlers
  (`server/src/app.ts:194-213`): one line each for open/close/error with
  userId + sessionId — the incident analysis had to infer connection
  lifetimes from sync-core warning side-effects.
- **Backpressure guard**: sample each `/sync` socket's `bufferedAmount` on a
  ~10 s interval; log when it crosses 1 MB, close the socket at 4 MB —
  mirroring the terminal relay's `BROWSER_BUFFER_LIMIT`
  (`server/src/gateway-registry.ts:29,155-159`). A closed slow client
  reconnects and gets a fresh snapshot; an unbounded buffer grows until the
  slice OOM-kills the sync process for everyone
  (`prod/ensembleworks-sync.service` has no own `MemoryMax`).
- **Crash surface**: wrap the synchronous `getOrCreateRoom(...)` call in the
  WS upgrade handler (`server/src/app.ts:211`) in try/catch → destroy that
  socket and log, instead of an uncaught throw killing the process (a room
  whose SQLite fails to load currently crash-loops the whole sync server on
  every reconnect).
- **Event-loop lag monitor**: a 1 s interval that logs when observed drift
  exceeds 1 s — direct evidence for/against event-loop starvation next time.

## Deferred

- TURN relay / ICE-TCP fallback (per the decision above; spec'd in
  `docs/livekit-self-host-spec.md` future steps).
- Any UI for browsing telemetry; adaptive stream-count reduction on poor
  connections ("audio-only mode"); moving the sync connect-snapshot
  serialization off the hot path. All wait for telemetry evidence.

## Verification

- **Reconnect machine**: with the stack up and two browsers joined — kill
  `livekit-server` (`bin/dev restart livekit`) and confirm both clients show
  `retrying` then self-heal with mic/cam state restored; use Chrome devtools
  offline/Slow-3G throttling to exercise `reconnecting` vs terminal paths;
  kick a user via `/api/av/kick` and confirm they land in `error`, not a
  re-join fight.
- **Telemetry**: throttle one client, confirm events land in the room's
  JSONL with sensible ordering across both planes, and that beacon failures
  are silent.
- **The real test**: next 5-person session, pull
  `telemetry/<room>-connection.jsonl` and the sync journal; the
  downlink-saturation theory predicts affected users show LiveKit quality
  degradation and sync offline transitions *together*, while unaffected
  users show neither.
