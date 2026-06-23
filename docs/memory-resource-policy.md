# Memory resource policy for the dev services

How the four EnsembleWorks dev services (`sync`, `client`, `scribe`, `term`)
share the VM's memory, why the policy is "reserve for the core, give `term` the
rest", and what you have to touch when the box is resized. The policy lives in
`deploy/systemd/ensembleworks.slice` plus a per-service
`ensembleworks-<svc>.service.d/10-memory.conf` drop-in (so all the cgroup/memory
config is in one obvious place rather than inline in each unit body), and is also
written by `deploy/bootstrap-debian.sh`.

## The problem

All four services run inside one cgroup slice, `ensembleworks.slice`, so a memory
runaway is contained and OOM-killed *inside the slice* instead of taking down the
whole VM (an unconstrained spike previously forced a hard reboot). The original
caps were tuned for a tiny box (`MemoryHigh=1000M` / `MemoryMax=1400M`), and live
inspection showed the slice pinned at its `MemoryHigh` — every service was being
continuously throttled. The VM was then resized to 8 GB (7.6 GiB usable), which
is what prompted revisiting the numbers.

Two facts shaped the new policy:

1. **The services are not equal.** `term` (the node-pty + tmux gateway) is by far
   the spikiest — ~700 MB at rest vs. ~330 MB combined for the other three — and
   the lowest blast radius: its workload is interactive panes (builds, dev
   servers, the Claude agent itself), and killing one runaway pane loses almost
   nothing. The cgroup tree confirms the tmux server and all panes live *inside*
   `ensembleworks-term.service`, so a limit there genuinely contains the spikes;
   and systemd does not set `memory.oom.group`, so an OOM kills only the single
   largest process (the runaway), not the whole group.

2. **Nothing in the slice holds precious in-memory state.** `sync` commits every
   canvas change transactionally to per-room SQLite (`@tldraw/sync-core`
   `SQLiteSyncStorage`), so a restart reloads from disk and clients
   auto-reconnect — the only loss is ephemeral presence/cursors. All four
   services have `Restart=on-failure`.

## The policy: reserve for the core, give `term` the rest

Rather than hardcoding per-service caps on `term` (which then have to be
re-tuned by hand on every resize), the policy is **inverted**:

- The three core services reserve a protected working set with **`MemoryLow`**
  (soft protection — reclaimed/killed *last*): `sync=512M`, `client=512M`,
  `scribe=256M`.
- `ensembleworks.slice` carries **`MemoryLow=1280M`**, the sum of the children's
  reservations. This is required: cgroup v2 clamps a child's effective low to its
  ancestors', so without it the per-service protection would not propagate.
- The slice ceiling is a **percentage of RAM**: `MemoryHigh=78%`,
  `MemoryMax=88%` (≈5.9 G / ≈6.7 G on this box).
- **`term` carries no memory directives** — it gets "the rest". When it spikes,
  the slice crosses `MemoryHigh` and the kernel reclaims `term` first (the core
  is `Low`-protected); if it keeps climbing the slice hits `MemoryMax` and the
  OOM kill lands on the largest process — the runaway `term` pane — leaving the
  gateway, sibling panes, and the whole core alive.

## CPU priority: the SFU wins, the dev slice yields

The same slice split carries a CPU policy, and it is **inverted** relative to
what the original `CPUWeight=50` on the media slice implied. The lesson was
learned empirically during the self-host LiveKit cutover: with two peers in a
room, load average spiked past 100% on a 2-vCPU box, and per-unit
`CPUUsageNSec` showed the scribe burning **2.4× the SFU's CPU** (per-frame Opus
decode + RMS VAD on every subscriber's audio is genuinely expensive).

The original `CPUWeight=50` on `ensembleworks-media.slice` made the SFU
**lose** CPU contention — the opposite of correct. A delayed SFU does not slow
down gracefully: it backs up RTP packets (nacks, bigger jitter buffers) and
works *harder*, which is self-defeating. The scribe, by contrast, is fully
asynchronous — a 200 ms STT lag is invisible to users (transcripts are polled),
while a 200 ms SFU lag is a media stall.

The fix inverts the weights:

- **`ensembleworks-media.slice`: `CPUWeight=200`** — the SFU keeps ~80% of CPU
  under contention.
- **`ensembleworks.slice`: `CPUWeight=50`** — dev procs (scribe, vite, esbuild,
  sync) share ~20%, which is enough for the scribe to keep up with real-time
  VAD.

`CPUWeight` only governs *contention* — with idle CPU, every slice runs
unrestricted, so this is a no-op under light load and only bites when the box is
actually full.

## Resizing the VM

Resizing needs **no edits**: `MemoryHigh`/`MemoryMax` are percentages and
auto-scale with physical RAM, and the core's `MemoryLow` numbers are an absolute
working set that stays fixed.

The one trade-off to keep in mind: because the ceiling is a percentage, OS
headroom scales with box size rather than staying a fixed ~1 GB (88% of 7.6 GiB
leaves ~0.9 GB). If the box ever moves far from the ~8 GB range, revisit the
percentages.

## Applying changes to a running box

The live units are generated by `deploy/bootstrap-debian.sh` with the VM's real
paths, so don't `cp` the standalone `deploy/systemd/*.service` files over them.
Either re-run the (idempotent) bootstrap, or apply the resource settings
directly, which takes effect immediately and persists via drop-ins without a
restart:

```sh
sudo systemctl set-property ensembleworks.slice \
  MemoryLow=1280M MemoryHigh=60% MemoryMax=70% CPUWeight=50
sudo systemctl set-property ensembleworks-media.slice \
  MemoryHigh=1G MemoryMax=1500M CPUWeight=200
sudo systemctl set-property ensembleworks-sync.service   MemoryLow=512M
sudo systemctl set-property ensembleworks-client.service MemoryLow=512M
sudo systemctl set-property ensembleworks-scribe.service MemoryLow=256M
```

`set-property` writes drop-ins under `/etc/systemd/system/<unit>.d/`, which
*override* the unit files. They match the committed values today, but if you ever
change the numbers in the repo, clear the stale drop-ins so the unit files win:

```sh
sudo rm -f /etc/systemd/system/ensembleworks*.service.d/50-Memory*.conf \
           /etc/systemd/system/ensembleworks.slice.d/50-Memory*.conf
sudo systemctl daemon-reload
```

Verify what's live with `systemctl show ensembleworks.slice -p MemoryLow -p
MemoryHigh -p MemoryMax -p CPUWeight` (and the same per service / for
`ensembleworks-media.slice`).
