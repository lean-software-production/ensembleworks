# Required Database Dirs + storage.env Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A misconfigured box fails to start loudly instead of corrupting data 15 minutes later. The storage path triple (`DATA_DIR`, `DATABASE_DIR`, `DATABASE_BACKUPS_DIR`) becomes required, validated for collision-shaped geometry at both ends (sync startup + every backup run), and lives in exactly one file per box: `~ensembleworks/.config/ensembleworks/storage.env`.

**Architecture:** See `docs/superpowers/specs/2026-07-11-required-database-dirs-design.md`. Backups move from `DATA_DIR/rooms` to a dedicated `DATABASE_BACKUPS_DIR`; `DATA_DIR` renames to `/home/ensembleworks/data`; both the sync unit and the laingville backup units source `storage.env`; unit templates carry no `Environment=` lines for the triple.

**Tech stack:** Bun + TypeScript (`server/`), bash + systemd (`deploy/`, laingville `servers/`).

**Two repos, three phases:**
- **Phase 1 — app repo**, on the repurposed **PR #31** branch `fix/database-dir-in-sync-unit` (rebase onto main first; its original commit `c352ebe` is subsumed — drop it during rebase or let the new unit-file edits supersede it).
- **Phase 2 — laingville** (`~/Work/laingville`). Coordinate with the in-flight `fix/backup-timer-oncalendar` branch: land that first, or branch from it.
- **Phase 3 — migration runbook**, per box (spec §Migration). Downtime sanctioned.

**Decision recorded (spec left it open):** `createSyncApp`'s `databaseDir` opt stays **optional** — ~25 test files construct `createSyncApp({ dataDir })` and the lib fallback (`DATA_DIR/rooms`) is what they exercise; the safety boundary is the prod env edge, so requiredness + geometry validation live in `sync-server.ts` only, via a new pure validator module.

**Validator normalization decision:** lexical `path.resolve()` (+ trailing-sep containment), **not** `realpathSync` — dirs may not exist at validation time and the threat is config typos, not adversarial symlinks. Documented in the module header.

---

## Phase 1 — app repo (PR #31, repurposed)

### Task 1.1: `storage-geometry` validator + tests

**Files:** Create `server/src/kernel/storage-geometry.ts`, `server/src/kernel/storage-geometry.test.ts`.

```typescript
export interface StorageGeometry { dataDir: string; databaseDir: string; databaseBackupsDir: string }
// throws Error with a message naming every violated rule (collect all, not first)
export function resolveStorageGeometry(env: Record<string, string | undefined>): StorageGeometry
```

Rules (each with its own test):
- [ ] unset/empty `DATA_DIR` | `DATABASE_DIR` | `DATABASE_BACKUPS_DIR` → throw, message names which (all missing ones at once)
- [ ] `DATABASE_DIR` == `DATABASE_BACKUPS_DIR`, or either contains the other → throw
- [ ] `DATABASE_DIR` inside `DATA_DIR`, or `DATA_DIR` inside `DATABASE_DIR` → throw (the incident's geometry)
- [ ] `DATABASE_BACKUPS_DIR` inside `DATA_DIR` → **allowed** (expected prod shape)
- [ ] happy triple (prod values) and sibling scratch dirs (boot-check shape) → resolves
- [ ] containment is path-segment aware (`/a/bc` is NOT inside `/a/b`)

### Task 1.2: enforce at the env edge

**Files:** Modify `server/src/sync-server.ts` (drop the `?? cwd/data` and optional-`DATABASE_DIR` fallbacks; call `resolveStorageGeometry(process.env)`, exit 1 with the thrown message on failure; boot log prints the resolved triple). Modify `server/src/app.ts:72-77` comment only (fallback is now test/lib-only — say so). Keep `server/src/database-dir.test.ts` as-is (both lib branches remain valid).

- [ ] `sync-server.ts` refuses to start with a clear multi-line error when the triple is missing/invalid
- [ ] `term`/`files` subcommands unaffected (they never read these vars)

### Task 1.3: prod + dev unit templates

**Files:** Modify `deploy/systemd/prod/ensembleworks-sync.service`, `deploy/systemd/ensembleworks-sync.service`.

- [ ] Prod: delete `Environment=DATA_DIR=…` (and the branch's `Environment=DATABASE_DIR=…`); after the existing `EnvironmentFile=…/sync.env` add `EnvironmentFile=@APP_HOME@/.config/ensembleworks/storage.env` with the contract comment (sourced by sync AND the laingville backup units; validated both ends; missing file = unit fails to start = deliberate fail-closed)
- [ ] Dev unit: set the triple explicitly (`/home/ensemble/data`, `…/databases`, `…/data/database-backups` shape) — it must satisfy the validator or the dogfood box won't boot

### Task 1.4: deploy machinery

**Files:** Modify `deploy/deploy.sh` (preflight + keep the `install -d /var/lib/ensembleworks{,/databases}` block), `deploy/lib.sh` (`ew_boot_check`), `deploy/cutover-dataload-check.sh`, `deploy/cutover.sh:28`, `deploy/bootstrap-debian-ash.sh:174`.

- [ ] deploy.sh preflight: `storage.env` must exist and contain all three keys, else fail with a runbook pointer (before any fetch/swap):
```bash
STORAGE_ENV="\${APP_HOME}/.config/ensembleworks/storage.env"
sudo test -f "\$STORAGE_ENV" || { echo "PREFLIGHT FAILED: \$STORAGE_ENV missing — see the required-database-dirs migration runbook" >&2; exit 1; }
for k in DATA_DIR DATABASE_DIR DATABASE_BACKUPS_DIR; do
  sudo grep -q "^\${k}=" "\$STORAGE_ENV" || { echo "PREFLIGHT FAILED: \$k missing from \$STORAGE_ENV" >&2; exit 1; }
done
```
- [ ] `ew_boot_check`: sync boot gains scratch `DATABASE_DIR` + `DATABASE_BACKUPS_DIR` (+ two `mktemp -d`s, cleaned up) — siblings under /tmp pass the validator
- [ ] `cutover-dataload-check.sh`: source the box's `storage.env` for live paths; copy live `DATABASE_DIR/rooms` into a second scratch dir; boot with a valid scratch triple (`DATA_DIR="$work" DATABASE_DIR="$work_db" DATABASE_BACKUPS_DIR="$work_bk"`)
- [ ] `cutover.sh` + `bootstrap-debian-ash.sh`: `.local/share/ensembleworks` → `data`; ash bootstrap also writes `storage.env`

### Task 1.5: dev stack (`bin/dev`)

**Files:** Modify `bin/dev-main.mjs` (103-104, 131, 213), `bin/dev-lib.mjs` (208, 254), `bin/dev.test.ts` (23, 92).

- [ ] Dev state root stays `~/.local/share/ensembleworks` (dev-only name, orthogonal to the prod rename); the triple nests under it as siblings: `data/`, `databases/`, `database-backups/`
- [ ] `makeCtx` carries the triple; the sync service env line becomes the three assignments; `mkdirSync` all three
- [ ] `dev.test.ts` asserts all three inline env assignments
- [ ] `.devcontainer/post-create.bash` unchanged (root symlink still valid) — verify only

### Task 1.6: docs

- [ ] `AGENTS.md:34` + `README.md:128,444`: state-path and env-var docs reflect the triple + `storage.env` (dev note: existing dev state at the root level is disposable; `mv` uploads/transcripts into `data/` to keep it)

### Task 1.7: verify + ship

- [ ] `bun run typecheck`; full test suite (`scripts/run-tests.ts` glob picks up the new kernel test); `bash -n deploy/deploy.sh`; `deploy/test/lib_test.sh` ALL PASS
- [ ] `deploy/deploy.sh <anything> 0.16.0 --dry-run` still passes (boot-check with the scratch triple)
- [ ] Push branch; retitle PR #31 (`fix(storage): required, validated storage geometry via storage.env`), rewrite body (keep incident context; link spec; note supersession of the original diff)

## Phase 2 — laingville

### Task 2.1: scripts — fail-closed, no defaults

**Files:** Modify `servers/shared/scripts/{database-backup.sh,restore-database.sh,check-database-backup-fresh.sh}` + `test/database-backup-test.sh`.

- [ ] Delete every `${VAR:-default}` for the triple; add a shared guard (in `database-backed-dirs.sh` or a new `storage-guard.sh`): all vars set; realpath src != dst; no containment either way; **src dir must exist** (backup: `DATABASE_DIR`; restore: `DATABASE_BACKUPS_DIR`) — never create it
- [ ] Backup dst becomes `${DATABASE_BACKUPS_DIR}/rooms` (dst `install -d` stays); freshness check reads the same pair
- [ ] Test harness: new cases — unset var fails, equal dirs fail, containment fails, missing src fails, happy path unchanged

### Task 2.2: units + installer

- [ ] `ensembleworks-database-backup.service` + restore/freshness units gain `EnvironmentFile=/home/ensembleworks/.config/ensembleworks/storage.env`
- [ ] `install-room-db.sh`: STOP installing the `database-dir.conf` drop-in (deploy.sh deletes drop-ins every deploy — it's the original drift mechanism); install the updated units/scripts
- [ ] Rebase onto / land after `fix/backup-timer-oncalendar`

### Task 2.3: bootstraps ×4

- [ ] `servers/ew-{lsp,staging,donkeyred,rink}-001/bootstrap.sh`: `DATA_DIR` path → `/home/ensembleworks/data`; provision `storage.env` (600, app-owned, the contract header + triple) if absent; home-snapshot paths updated

## Phase 3 — fleet migration (runbook in spec, per box, in order: staging → donkeyred → rink → lsp)

- [ ] laingville PR merged, app PR #31 merged, release cut (next minor)
- [ ] Per box: stop sync + disable backup timer → final manual backup (old paths) → `mv ~/.local/share/ensembleworks ~/data` → write `storage.env`, delete `DATABASE_DIR` from `sync.env` → archive `~/data/rooms` → re-run laingville install → `deploy.sh <box> <ver>` → start; verify edge 200, boot-log triple, one backup run, freshness pass, timer armed
- [ ] Update memory notes (fleet version + geometry) when done
