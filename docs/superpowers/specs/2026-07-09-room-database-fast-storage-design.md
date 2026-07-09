# Room database fast storage design

## Context

Incident #18 (2026-07-08, `ew-lsp-001`) traced AV/canvas dropouts to the sync
server's room SQLite files sitting on a slow data volume: measured average
write latency ~12.5ms/op and flush (fsync) latency ~9.85ms/op on `/home`
(`/dev/sdb`), versus ~0.37ms/op and ~0.14ms/op on the boot disk (`/dev/sda`,
`/`) — a 30-90x gap. All four production hosts (`ew-lsp-001`,
`ew-staging-001`, `ew-donkeyred-001`, `ew-rink-001`) share this same
fast-boot-disk / slow-data-volume split, by original design: the boot disk is
meant to be disposable and rebuildable without data loss, so all durable
state was deliberately placed on the data volume.

PR #19 (shipped as v0.13.1) mitigated the immediate crisis by switching room
databases to WAL mode, cutting fsync frequency. This design addresses the
underlying storage mismatch directly: move room databases onto the fast boot
disk, and periodically back them up to the durable data volume so the
"boot disk is disposable" property is preserved.

This is scoped to **room SQLite files only** — `uploads/`, `transcripts/`,
`roadmaps/`, and `telemetry/` stay exactly where they are on `/home`. They
don't have the fsync-heavy small-write pattern that caused the incident, and
moving them would put unbounded-growth content on a disk meant to stay small.

Renaming `~ensembleworks/.local/share/ensembleworks` to
`~ensembleworks/data` is a related but separate, deferred follow-up — it's
orthogonal to this fix and has its own blast radius (hardcoded path
references in `deploy/cutover-dataload-check.sh` and all four hosts'
`bootstrap.sh`), so it's out of scope here.

## Goals / done when

- Room SQLite writes hit fast (boot-disk) storage, not the slow `/home`
  volume — eliminating the fsync-latency source behind incident #18.
- The "boot disk is disposable / rebuildable without data loss" property is
  preserved: a durable copy of every room DB lands on `/home` at least every
  15 minutes.
- A boot-disk rebuild is recoverable via a single documented, manually-run
  restore step.
- A failed or silently-stopped backup is surfaced loudly in the journal (no
  silent DR-copy rot) and checked before deploy/rebuild — closing the same
  silent-drift failure class that caused incident #18.
- No change to where uploads/transcripts/roadmaps/telemetry live, and — the
  hard constraint — no data loss during the migration itself.

## Architecture

```
Boot disk (fast — ~0.37ms write, ~0.14ms flush; ext4, no COW concerns)
  /var/lib/ensembleworks/databases/rooms/
    team.sqlite, team.sqlite-wal, team.sqlite-shm, ...

/home data volume (slow — ~12.5ms write, ~9.85ms flush; btrfs)
  <APP_HOME>/.local/share/ensembleworks/
    uploads/, transcripts/, roadmaps/, telemetry/   ← unchanged
    rooms/                                          ← same path rooms/ has
                                                        always lived at; now
                                                        populated by periodic
                                                        backup instead of live
                                                        writes
  .snapshots/                                       ← existing daily btrfs
                                                        snapshot timer, unchanged
                                                        — captures rooms/'s
                                                        generational history
                                                        for free
```

Every 15 minutes, `ensembleworks-database-backup.timer` runs a script that
uses SQLite's Online Backup API (safe to run against a live,
actively-written WAL-mode database) to copy each room file from the boot
disk into the existing `rooms/` location on `/home`. The temp-file-then-mv
mechanics that make this crash-safe across the two filesystems are detailed
under Backup and restore below.

**Why reuse the existing `rooms/` path on `/home` rather than a new
directory name:** it keeps `deploy/cutover.sh`'s backup step (`cp -a` of the
whole `DATA_DIR` during version cutovers) and `deploy/cutover-dataload-check.sh`
(which boots a test server against a copy of `DATA_DIR` to verify every room
loads under new app code) working essentially as-is — they already look for
room data at `DATA_DIR/rooms/`, and that is exactly where the backup lands.
Two caveats follow. Both bite only at the next era-crossing `cutover.sh` run —
a rare, one-time, hand-supervised event, **not** the normal `deploy.sh` path
this feature ships through (`deploy.sh` never touches `DATA_DIR` at all). They
are forward-looking notes for whoever next runs an era cutover, not blockers
for this rollout:

- **Freshness of the cutover safety backup.** `cutover.sh`'s `cp -a` of
  `DATA_DIR` previously captured *live* room state; post-migration
  `DATA_DIR/rooms/` is only as fresh as the last 15-minute backup, so the
  pre-cutover rollback snapshot is up to ~15 minutes stale for room data.
  Acceptable (cutovers are planned, and the live data is still safe on the
  boot disk), but should be understood rather than assumed away.
- **`cutover-dataload-check.sh` must set `DATABASE_DIR` to its scratch copy.**
  Today it boots the server with only `DATA_DIR="$work"` set, so it relies on
  the `DATABASE_DIR`-unset fallback to find rooms under `$work/rooms` — which
  works only because the ssh shell running the check has no ambient
  `DATABASE_DIR`. To be robust and to exercise the *same* resolution path
  production uses, the check should explicitly set `DATABASE_DIR="$work"` when
  booting the test server. This is the one change the cutover scripts do need.

**Recovery model:** if the boot disk is lost, at most 15 minutes of edits
since the last periodic backup are gone. Nothing else is at risk — uploads,
transcripts, telemetry, and roadmaps never left `/home`.

**No `ExecStop=`/stop-time backup hook.** Considered and rejected: a graceful
`systemctl stop`/`restart` (what a normal deploy or reboot does) never
touches the boot disk's contents — the files just sit there unaffected while
the process restarts. There's no real risk for a stop-time backup to
mitigate; the 15-minute timer is the only mechanism that protects against
something real (unplanned boot-disk loss). Adding a stop hook would be
complexity with no corresponding risk reduction.

## App code change (this repo)

- New optional env var `DATABASE_DIR`, read in `server/src/sync-server.ts`
  alongside the existing `DATA_DIR`. It's a fixed absolute path
  (`/var/lib/ensembleworks/databases`) on every host, not per-user, so unlike
  `DATA_DIR` it needs no `@APP_HOME@`-style templating in the systemd unit.
- `createSyncApp` (`server/src/app.ts`) accepts an optional `databaseDir` and
  computes `const roomsDir = opts.databaseDir ? path.join(opts.databaseDir, 'rooms') : path.join(opts.dataDir, 'rooms')`
  — preserving today's behavior (rooms nested directly under `DATA_DIR`) for
  any environment that doesn't set `DATABASE_DIR` (local dev, tests, a host
  mid-rollout that hasn't been migrated yet).
- `createRoomHost` (`server/src/kernel/rooms.ts`) changes to accept the
  resolved rooms directory directly, rather than deriving `rooms/` from a
  `dataDir` parameter itself.
- This is the entire *server-code* footprint of this design. The only other
  app-repo touch is a small, non-blocking freshness warning in `deploy.sh`'s
  preflight (see "Detecting a failed or stale backup"). The running server has
  no knowledge of, and no code path related to, how `DATABASE_DIR` gets backed
  up or restored — that's entirely an ops-repo concern (see below).

### Testing (this repo)

Extend the existing room-host / sync-app tests to cover:
- `DATABASE_DIR` unset → rooms resolve under `DATA_DIR/rooms/` (today's
  behavior, unchanged).
- `DATABASE_DIR` set → rooms resolve under `<DATABASE_DIR>/rooms/` instead.

## Backup and restore (ops repo — `laingville/servers/`)

Both scripts live together in the ops repo (likely
`laingville/servers/shared/scripts/`, alongside the existing small
cross-host helper scripts, since neither has host-specific logic — both are
parameterized only by `APP_HOME`). This mirrors where the closest existing
analog, the daily `home-snapshot` btrfs-snapshot logic, already lives
entirely in the ops repo, and keeps the backup/restore pair — which share
the same path conventions and file-set assumptions — together in one place.

Both scripts act only on an explicit list of database-backed subdirectory
names (today: just `rooms`). Because both scripts live in the same ops repo,
that list lives in a single shared file (e.g. `database-backed-dirs.sh`) that
both `source` — one definition, no drift.

This allowlist is the safety mechanism, and it stands on its own: the scripts
only ever touch directory names in the list, so `uploads/`, `transcripts/`,
`roadmaps/`, and `telemetry/` are structurally impossible to touch — the
scripts never walk "the whole tree." Adding a future database-backed
subsystem is a one-line edit to the shared list.

**`database-backup.sh`:** for each name in the list, walks
`DATABASE_DIR/<name>` for `*.sqlite` files, and for each one runs
`sqlite3 <src> ".backup DATA_DIR/<name>/<db>.tmp"` — writing the temp file
onto `/home`, the *same* filesystem as the final destination — then an atomic
`mv` within `/home` to `DATA_DIR/<name>/<db>`. Writing the temp on the
destination filesystem is what makes the `mv` a real `rename(2)`; a temp next
to the source (on the boot disk, a *different* filesystem — `/dev/sda1` vs
`/dev/sdb`) would make the `mv` a cross-filesystem copy, which is not atomic
and could expose a half-written file to a concurrent reader such as
`cutover.sh`'s `cp -a`. The `.backup` API is safe to run against the live
WAL-mode database, and produces a single checkpointed `.sqlite` file — no
`-wal`/`-shm` sidecars accompany it into `/home`.

**`restore-database.sh`:** the reverse — for each name in the list, copies
`DATA_DIR/<name>/*.sqlite` into `DATABASE_DIR/<name>/`, fixing ownership.
Refuses to run if the `DATABASE_DIR` target directory is non-empty, unless
passed `--force` — this is a deliberately manual, deliberately-invoked
recovery step (not auto-triggered during provisioning), to guarantee it can
never silently overwrite live data with a stale backup. Prints a summary of
what was restored and how stale it is, and reminds the operator to start
`ensembleworks-sync` afterward.

### Detecting a failed or stale backup

There is no dedicated monitoring yet, so detection uses only native systemd
features and must be loud in the journal. This matters because the failure it
guards against is *silent*: a backup that stops running leaves everything
looking healthy until a boot-disk rebuild reaches for a DR copy that turns out
to be stale — the same silent-drift class as the nodatacow gap behind incident
#18. Three pieces:

1. **Fail loudly at the source.** `database-backup.sh` runs under
   `set -euo pipefail` and exits non-zero if any room's `.backup` fails, so a
   bad run marks `ensembleworks-database-backup.service` failed — queryable
   with zero infrastructure via `systemctl --failed` /
   `systemctl is-failed ensembleworks-database-backup.service`. The service
   carries `OnFailure=ensembleworks-database-backup-failed.service`, a oneshot
   that logs at error priority (`logger -p daemon.err "database backup FAILED —
   DR copy on /home is stale; investigate before any boot-disk rebuild"`), so
   failures surface under `journalctl -p err`.
2. **A shared freshness check.** `check-database-backup-fresh.sh` (ops repo,
   driven by the same shared allowlist as backup/restore) finds the newest
   `*.sqlite` mtime under each listed dir in `DATA_DIR/` and exits non-zero
   with a loud message if it is older than **2× the interval (30 minutes)**.
   Unlike the OnFailure path this is an *outcome* check — it asserts a fresh
   backup actually exists, so it also catches the mode OnFailure cannot: a
   timer that silently stopped firing (disabled, wedged, or never enabled).
3. **A passive freshness timer.**
   `ensembleworks-database-backup-freshness.timer` runs the check hourly and
   logs loudly at error priority when stale, so a silently-stopped backup is
   noticed on its own within the hour rather than only when someone next
   deploys or rebuilds.

The check is also wired into the two moments where staleness has consequences:

- **Boot-disk rebuild / restore runbook:** run `check-database-backup-fresh.sh`
  and require an explicit operator acknowledgement before wiping the boot disk
  — this is where a stale backup actually costs data.
- **`deploy.sh` preflight:** run the check as a *non-blocking warning* (and
  skip gracefully if the script isn't installed, for hosts not yet migrated).
  A deploy does not endanger data — the live copy is on the boot disk — so a
  stale DR copy is a heads-up to investigate, not a reason to block shipping.

### Host provisioning (`bootstrap.sh`, all four hosts)

- Create `/var/lib/ensembleworks/databases` —
  `install -d -m700 -o ensembleworks -g ensembleworks`, matching the existing
  pattern used for the current data directory. No nodatacow/`chattr +C`
  needed — the boot disk is plain ext4, so the btrfs COW-fragmentation
  problem this whole incident traced back to doesn't apply there at all.
- Add `sqlite3` to the apt package list (needed by `database-backup.sh` /
  `restore-database.sh`; confirmed not currently installed on `ew-lsp-001`).
- Install `database-backup.sh`, `restore-database.sh`,
  `check-database-backup-fresh.sh`, and the shared allowlist to a fixed path
  (e.g. `/usr/local/bin/`).
- Install and enable `ensembleworks-database-backup.timer` (15 min) +
  `.service` (`ExecStart=/usr/local/bin/ensembleworks-database-backup.sh`),
  matching the existing `home-snapshot.timer` pattern.
- Install the `ensembleworks-database-backup-failed.service` OnFailure handler
  and the `ensembleworks-database-backup-freshness.timer` (hourly) + `.service`
  (see "Detecting a failed or stale backup").

Rather than re-running the full multi-hundred-line `bootstrap.sh` against an
already-live host (riskier — the script does far more than this feature),
apply these specific new pieces by hand per host, the same way the
nodatacow fix was applied live during incident #18 — while updating each
`bootstrap.sh`'s source so future rebuilds provision it automatically from
a clean boot.

## Rollout

The migration must **seed the boot disk from the live data before the new
server starts.** Today the authoritative room data lives at `DATA_DIR/rooms/`
on `/home`. If the new server (with `DATABASE_DIR` set) starts against an
empty `DATABASE_DIR/rooms/`, it creates fresh *empty* room databases on the
boot disk — and worse, the first 15-minute backup then copies those empty
databases over the authoritative copy on `/home`, destroying it. The restore
guard protects `DATABASE_DIR` from being clobbered, but nothing protects
`DATA_DIR`; the only defense is doing the seed first. `restore-database.sh` is
the seed tool — its `DATA_DIR → DATABASE_DIR` copy direction and its
non-empty-target guard are exactly what a clean initial seed needs.

1. App-repo code change (PR, tests, review, merge), release cut via the
   normal `release.sh`/`deploy.sh` pipeline (same pattern as v0.13.1).
2. Apply the new `bootstrap.sh` pieces to `ew-staging-001` only: create the
   empty `DATABASE_DIR`, install the `sqlite3` package, both scripts + the
   shared allowlist, and the timer unit — **but do not enable the timer yet.**
3. **Seed, then start** (this ordering is what prevents data loss):
   1. Stop `ensembleworks-sync` so `DATA_DIR/rooms/` on `/home` is quiescent
      and current.
   2. Run `restore-database.sh` to copy the live `DATA_DIR/rooms/*.sqlite`
      into the empty `DATABASE_DIR/rooms/`; its non-empty guard confirms this
      is a clean first seed.
   3. Deploy the new app version (the systemd unit now sets `DATABASE_DIR`)
      and start `ensembleworks-sync`. Confirm it opens the *seeded* databases
      on the boot disk and every room loads with its data intact.
   4. Only now enable `ensembleworks-database-backup.timer` and
      `ensembleworks-database-backup-freshness.timer`.
4. Verify on staging: live writes land in `DATABASE_DIR/rooms/` on the boot
   disk, the timer fires and a backup lands *atomically* at the existing
   `DATA_DIR/rooms/` path, `check-database-backup-fresh.sh` passes while
   backups are current and fails loudly when they are made stale (e.g. stop
   the backup timer and wait out the threshold), `cutover.sh` /
   `cutover-dataload-check.sh` still pass (with the `DATABASE_DIR="$work"` fix
   applied to the latter), and a full DR cycle works end-to-end (stop sync,
   empty `DATABASE_DIR`, run `restore-database.sh`, restart sync, confirm the
   room loads with data intact).
5. Roll to `ew-lsp-001`, `ew-donkeyred-001`, `ew-rink-001` one at a time, each
   following the same stop → seed → start → enable-timer order, in a quiet
   window (no live incident forcing urgency this time).

### Testing (ops repo)

Script-level tests for `database-backup.sh` and `restore-database.sh` (living
in the ops repo alongside the scripts), modelled on the app repo's
`deploy/test/fake-release.sh` harness style: a fake WAL-mode SQLite file,
verifying (a) the backup writes its temp
onto the destination directory and completes with an atomic rename, (b) the
shared allowlist is honoured — a non-listed sibling directory placed beside
`rooms/` is never touched, (c) the restore/seed script's non-empty-target
guard actually refuses to run without `--force`, and (d)
`check-database-backup-fresh.sh` passes for a recent backup and exits
non-zero (loudly) once the newest backup is older than the threshold.

## Out of scope

- Renaming `.local/share/ensembleworks` to `data` (separate, deferred
  follow-up — see Context).
- Anything beyond room SQLite files (uploads/transcripts/roadmaps/telemetry
  stay on `/home`, untouched).
- Issue #18's other open follow-ups (fleet-wide nodatacow audit, idle-session
  reaping, on-demand shared-browser, client-side LiveKit reconnect handling)
  — tracked separately.
