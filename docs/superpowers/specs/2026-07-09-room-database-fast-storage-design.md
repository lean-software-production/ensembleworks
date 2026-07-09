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
uses SQLite's Online Backup API (`sqlite3 <room>.sqlite ".backup <tmp>"` +
atomic `mv`) — safe to run against a live, actively-written WAL-mode
database — to copy each room file from the boot disk into the existing
`rooms/` location on `/home`.

**Why reuse the existing `rooms/` path on `/home` rather than a new
directory name:** `deploy/cutover.sh`'s existing backup step (`cp -a` of the
whole `DATA_DIR` during version cutovers) and `deploy/cutover-dataload-check.sh`
(which boots a test server against a copy of `DATA_DIR` to verify every room
loads under new app code) both need zero changes — they already look for
room data at `DATA_DIR/rooms/`, and the fallback described below means that's
exactly where the backup lands by default.

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
- This is the entire app-repo footprint of this design. The app has no
  knowledge of, and no code path related to, how `DATABASE_DIR` gets backed
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
entirely in the ops repo — and keeps backup and restore, which share the
same path conventions and file-set assumptions, from drifting out of sync
the way splitting them across two repos would risk.

Both scripts are driven by the same small, explicit, hardcoded list of
subdirectory names that are database-backed (today: just `rooms`) —
duplicated between the two scripts (they can't share a sourced variable
across the repo boundary that separates their invocations from the app
repo's conventions) with a comment in each pointing at the other as a
"keep these in sync" reminder. This is deliberate: it's what makes it safe
for these scripts to never touch `uploads/`, `transcripts/`, `roadmaps/`, or
`telemetry/` — they only ever act on directory names in the list, not "the
whole tree."

**`database-backup.sh`:** for each name in the list, walks
`DATABASE_DIR/<name>` for `*.sqlite` files, backs each up via
`sqlite3 <src> ".backup <src>.tmp"` then atomic `mv` into `DATA_DIR/<name>/`
on `/home`.

**`restore-database.sh`:** the reverse — for each name in the list, copies
`DATA_DIR/<name>/*.sqlite` into `DATABASE_DIR/<name>/`, fixing ownership.
Refuses to run if the `DATABASE_DIR` target directory is non-empty, unless
passed `--force` — this is a deliberately manual, deliberately-invoked
recovery step (not auto-triggered during provisioning), to guarantee it can
never silently overwrite live data with a stale backup. Prints a summary of
what was restored and how stale it is, and reminds the operator to start
`ensembleworks-sync` afterward.

### Host provisioning (`bootstrap.sh`, all four hosts)

- Create `/var/lib/ensembleworks/databases` —
  `install -d -m700 -o ensembleworks -g ensembleworks`, matching the existing
  pattern used for the current data directory. No nodatacow/`chattr +C`
  needed — the boot disk is plain ext4, so the btrfs COW-fragmentation
  problem this whole incident traced back to doesn't apply there at all.
- Add `sqlite3` to the apt package list (needed by `database-backup.sh` /
  `restore-database.sh`; confirmed not currently installed on `ew-lsp-001`).
- Install `database-backup.sh` and `restore-database.sh` to a fixed path
  (e.g. `/usr/local/bin/`).
- Install and enable `ensembleworks-database-backup.timer` (15 min) +
  `.service` (`ExecStart=/usr/local/bin/ensembleworks-database-backup.sh`),
  matching the existing `home-snapshot.timer` pattern.

Rather than re-running the full multi-hundred-line `bootstrap.sh` against an
already-live host (riskier — the script does far more than this feature),
apply these specific new pieces by hand per host, the same way the
nodatacow fix was applied live during incident #18 — while updating each
`bootstrap.sh`'s source so future rebuilds provision it automatically from
a clean boot.

## Rollout

1. App-repo code change (PR, tests, review, merge), release cut via the
   normal `release.sh`/`deploy.sh` pipeline (same pattern as v0.13.1).
2. Apply the new `bootstrap.sh` pieces to `ew-staging-001` only (directory,
   `sqlite3` package, both scripts, the timer unit).
3. Deploy the new app version to staging.
4. Verify on staging: `DATABASE_DIR` populated on first room open, the timer
   fires and a backup lands at the existing `DATA_DIR/rooms/` path,
   `cutover.sh` and `cutover-dataload-check.sh` are unaffected, and
   `restore-database.sh` works end-to-end (deliberately simulate boot-disk
   loss: stop sync, empty the `DATABASE_DIR`, run the restore script,
   restart sync, confirm the room loads).
5. Roll to `ew-lsp-001`, `ew-donkeyred-001`, `ew-rink-001` one at a time, in
   a quiet window on each (no live incident forcing urgency this time).

### Testing (ops repo)

Script-level tests for `database-backup.sh` and `restore-database.sh`
following the existing `deploy/test/fake-release.sh` harness style in this
repo: a fake WAL-mode SQLite file, verifying the atomic-backup behavior and
that the restore script's non-empty-target safety check actually refuses to
run without `--force`.

## Out of scope

- Renaming `.local/share/ensembleworks` to `data` (separate, deferred
  follow-up — see Context).
- Anything beyond room SQLite files (uploads/transcripts/roadmaps/telemetry
  stay on `/home`, untouched).
- Issue #18's other open follow-ups (fleet-wide nodatacow audit, idle-session
  reaping, on-demand shared-browser, client-side LiveKit reconnect handling)
  — tracked separately.
