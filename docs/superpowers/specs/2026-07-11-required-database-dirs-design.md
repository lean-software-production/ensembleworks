# Required database dirs + explicit backup destination design

## Context

The 2026-07-10 `ew-lsp-001` outage (sync crash-loop on `SQLITE_CORRUPT`, edge
502) happened because `DATABASE_DIR` was silently unset in the prod sync unit:
the server fell back to writing live room DBs to `DATA_DIR/rooms` — the exact
directory the 15-minute backup timer `mv -f`s its DR snapshots into. Live DB
and backup destination coincided, and the timer stamped a stale snapshot over
the live, open database.

PR #31 fixes the immediate template gap (sets `DATABASE_DIR` in the prod sync
unit, ensures the dir in deploy.sh). The adversarial review of #31 found the
deeper design defects this spec closes:

- **Silent fallback**: `DATABASE_DIR` unset is a *supported* code path
  (`app.ts` ternary → `DATA_DIR/rooms`), logged but unalarming. On a
  timer-armed prod host it is the prelude to corruption.
- **Overloaded directory**: `DATA_DIR/rooms` is simultaneously the legacy live
  location (the fallback) and the backup destination. Nothing anywhere asserts
  the two path sets are disjoint.
- **Shadow config**: the config has lived in three homes (a systemd drop-in —
  which deploy.sh's drop-in purge deletes on every deploy, the likely original
  drift mechanism — then hand-patched `sync.env`, now the #31 unit line), with
  `EnvironmentFile=` silently outranking `Environment=`.
- **Duplicated paths**: `/var/lib/ensembleworks/databases` is written in ~6
  places across two repos, including baked-in `${VAR:-default}` fallbacks in
  the laingville scripts — the same silent-fallback disease in a second
  location.

Also in scope: the `~ensembleworks/.local/share/ensembleworks` →
`~ensembleworks/data` rename, explicitly deferred by the 2026-07-09
room-database-fast-storage spec. Decided 2026-07-11: nobody is using the
servers, downtime is acceptable, do it now as part of the same migration
window.

Decisions locked in (2026-07-11):

- `DATABASE_DIR` becomes **required** — sync refuses to start when unset.
- New **`DATABASE_BACKUPS_DIR`** replaces `DATA_DIR/rooms` as the backup
  destination (a name that has never been and can never be a live-write
  location).
- The `rooms/` subfolder is **kept** under both dirs (config-only change for
  live data; preserves the laingville multi-dir structure).
- `DATA_DIR` moves to `/home/ensembleworks/data`.
- All three vars live in one dedicated **`storage.env`**, consumed by both
  the sync unit and the backup unit — single source of truth.
- No rollback/version floor needed: no pre-v0.14.0 instance exists or ever
  will (review finding F1 declared not-an-issue).
- **PR #31 is repurposed** to carry the app-repo half of this implementation
  (same branch, `fix/database-dir-in-sync-unit` — its incident narrative is
  the right context; its original 19-line diff is subsumed by this design).
- The file is named `storage.env` — it states the contract (storage geometry),
  not the audience; audience-named files (`common.env`, `shared.env`) grow
  into dumping grounds.

## Goals / done when

- A misconfigured box **fails to start, loudly**, instead of corrupting data
  15 minutes later. Both sides enforce independently: the sync server refuses
  to boot, and the backup script refuses to run, on missing or
  collision-shaped configuration.
- The backup destination is structurally incapable of coinciding with a live
  write location — different variable, different directory, checked at both
  ends.
- One file (`storage.env`) is the single source of truth for the path
  triple on every box; no baked-in defaults anywhere; no shadow copies in
  `sync.env`, drop-ins, or unit `Environment=` lines.
- `DATA_DIR` is `/home/ensembleworks/data` on all four boxes; the old
  `.local/share/ensembleworks` path exists nowhere in either repo except
  historical docs.
- Whole-fleet migration completes with zero data loss (downtime acceptable;
  seed-first runbook discipline anyway).

## Architecture

### The env triple (prod values)

```
# ~ensembleworks/.config/ensembleworks/storage.env  (mode 600, app-owned)
# Storage geometry contract — sourced by BOTH ensembleworks-sync.service (app
# repo) and ensembleworks-database-backup/restore (laingville). These three
# paths are validated for mutual consistency at sync startup AND before every
# backup run; a box where the two units read different values of these is a
# box that can corrupt a live database. One file, one truth.
DATA_DIR=/home/ensembleworks/data
DATABASE_DIR=/var/lib/ensembleworks/databases
DATABASE_BACKUPS_DIR=/home/ensembleworks/data/database-backups
```

```
Boot disk (fast, sacrificial)
  /var/lib/ensembleworks/databases/rooms/     ← live SQLite (unchanged path)

/home data volume (durable)
  /home/ensembleworks/data/                   ← renamed from .local/share/ensembleworks
    uploads/ transcripts/ roadmaps/ telemetry/ discord…   ← unchanged contents
    database-backups/rooms/                   ← NEW backup destination
    rooms/                                    ← GONE (archived during migration;
                                                 must not linger as a stale copy)
```

`DATA_DIR` stays in `storage.env` alongside the other two so the sync unit
has one `EnvironmentFile` for the whole triple and the validation can reason
about all three paths. `sync.env` keeps only its secrets/identity keys — its
`DATABASE_DIR` line is deleted during migration.

Both `ensembleworks-sync.service` and the laingville
`ensembleworks-database-backup.service` gain
`EnvironmentFile=<APP_HOME>/.config/ensembleworks/storage.env`. The unit
templates carry **no** `Environment=DATA_DIR/DATABASE_DIR` lines for these
(supersedes that part of PR #31 — a lone `Environment=` line under an
`EnvironmentFile=` that outranks it is shadow config, the review's F3).

### Validation — two-sided, fail-closed

Server startup (`sync-server.ts`, the env-reading edge — `createSyncApp` keeps
taking explicit opts so tests and the cutover data-load check are unaffected):

1. `DATA_DIR`, `DATABASE_DIR`, `DATABASE_BACKUPS_DIR` unset or empty → print
   which, exit 1. (`DATABASE_BACKUPS_DIR` is required here even though the
   server never writes to it: the sync server is the loud failure point — a
   dead oneshot backup unit is exactly what went unnoticed historically.)
2. Resolve realpaths (create-if-missing only for dirs the server owns:
   `DATABASE_DIR/rooms`). Fail when:
   - `DATABASE_DIR` == `DATABASE_BACKUPS_DIR`, or either contains the other;
   - `DATABASE_DIR` is inside `DATA_DIR` or `DATA_DIR` inside `DATABASE_DIR`
     (live DBs must never sit in the general data root — that was the
     incident's geometry).
   `DATABASE_BACKUPS_DIR` inside `DATA_DIR` is fine and expected.
3. Only the `sync` subcommand enforces this; `term`/`files` don't read these.

Backup script (`database-backup.sh`, laingville):

1. `DATABASE_DIR` / `DATABASE_BACKUPS_DIR` unset → fail (OnFailure fires).
   **Delete the `${VAR:-/var/lib/…}` defaults** — defaults mask a broken env
   file. The unit's `EnvironmentFile=` is the only supply.
2. realpath src == dst, or containment either way → fail.
3. Source dir missing → fail; do **not** create it — its absence means the
   box is not in the state you think it is.
4. Same rules in `restore-database.sh` (direction inverted) and
   `check-database-backup-fresh.sh`.

### Dev / test / CI

- `bin/dev` and the dev unit set the triple explicitly under the dev state
  root as **siblings** (so the containment rule passes):
  `DATA_DIR=$STATE/data`, `DATABASE_DIR=$STATE/databases`,
  `DATABASE_BACKUPS_DIR=$STATE/database-backups`.
- `ew_boot_check` (deploy/lib.sh) currently boots sync with scratch
  `DATA_DIR`/`CLIENT_DIST` only — it must export scratch values for all three
  vars **in the same PR**, or every future deploy fails its own pre-swap gate.
- `cutover-dataload-check.sh` already sets `DATABASE_DIR="$work"`; extend to
  the triple.
- Unit tests exercise the validator directly (unset each var; equal paths;
  each containment direction; the happy triple).

## Blast radius (grep-verified 2026-07-11)

App repo — files containing `.local/share/ensembleworks` and/or the fallback:

- `server/src/sync-server.ts` (require + validate), `server/src/app.ts`
  (delete the `?: DATA_DIR/rooms` fallback branch — `databaseDir` becomes a
  required opt or stays optional with the requirement at the edge; decide in
  the plan), `deploy/systemd/prod/ensembleworks-sync.service`,
  `deploy/systemd/ensembleworks-sync.service` (dev),
  `deploy/deploy.sh` (dir-ensure gains database-backups; drops nothing),
  `deploy/lib.sh` (`ew_boot_check`), `deploy/cutover-dataload-check.sh`,
  `deploy/cutover.sh`, `deploy/bootstrap-debian-ash.sh`,
  `bin/dev-main.mjs` + `bin/dev.test.ts`, `.devcontainer/post-create.bash`,
  `AGENTS.md`, `README.md`.

Laingville — `servers/shared/scripts/{database-backup.sh,
restore-database.sh, check-database-backup-fresh.sh, install-room-db.sh,
test/database-backup-test.sh}` (+ retire the `database-dir.conf` drop-in from
`install-room-db.sh` — deploy.sh deletes drop-ins on every deploy anyway),
backup/restore units gain the `EnvironmentFile=`, and all four
`servers/ew-*/bootstrap.sh` for the renamed `DATA_DIR` + `storage.env`
provisioning. Coordinate with the in-flight `fix/backup-timer-oncalendar`
branch (review finding F6) — land that first or rebase onto it.

## Migration runbook (per box; fleet-wide, downtime OK)

Order: laingville PR merged → app PR merged → release cut (next minor) → then
per box:

1. `systemctl stop ensembleworks-sync; systemctl disable --now
   ensembleworks-database-backup.timer`.
2. Run `database-backup.sh` once by hand (old paths) — final pre-migration DR
   copy.
3. `mv ~ensembleworks/.local/share/ensembleworks ~ensembleworks/data`
   (same-filesystem rename, instant).
4. Write `storage.env` (the triple, 600, app-owned). Delete the
   `DATABASE_DIR` line from `sync.env`.
5. `mv ~ensembleworks/data/rooms ~ensembleworks/data/rooms.pre-backups-dir`
   (archive — the old backup copies must not linger at a path nothing writes
   to; prune after the fleet is verified).
6. Re-run the laingville install (updated `install-room-db.sh`) to refresh
   backup units/scripts; `deploy/deploy.sh <box> <new-version>` installs the
   new sync unit + creates `database-backups/`.
7. Start; verify: edge 200, boot log shows the resolved triple, run the
   backup service once, `check-database-backup-fresh.sh` passes,
   `systemctl list-timers` shows the backup timer armed.

Rollback across this boundary is **unsupported** without reversing step 3 —
older units point at the old `DATA_DIR`. Acceptable: no users, and the
pre-migration DR copy from step 2 survives under the renamed root.

## Out of scope

- Version floor for pre-v0.14.0 rollbacks (review F1) — declared moot: no
  such instance exists or ever will.
- Flattening `rooms/` out of `DATABASE_DIR` — considered, rejected for now:
  it is the only variant that moves live files and it buys no safety.
- The backup timer's `OnCalendar` fix — already in flight in laingville
  (`fix/backup-timer-oncalendar`).
- Any change to uploads/transcripts/roadmaps/telemetry storage beyond the
  root rename.
