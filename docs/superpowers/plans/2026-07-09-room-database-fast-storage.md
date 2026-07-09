# Room Database Fast Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move room SQLite databases off the slow `/home` data volume onto the fast boot disk (`DATABASE_DIR`), with a 15-minute backup to `/home` that preserves the "boot disk is disposable" property.

**Architecture:** The sync server gains an optional `DATABASE_DIR` env var; when set, room `*.sqlite` files live at `DATABASE_DIR/rooms/` (fast boot-disk ext4) instead of `DATA_DIR/rooms/` (slow btrfs `/home`). A systemd timer runs an ops-repo backup script every 15 min that uses SQLite's Online Backup API to copy each room DB back into the existing `DATA_DIR/rooms/` path on `/home` (atomic temp-then-rename on the destination filesystem). A restore script seeds/recovers in the reverse direction. Native systemd (`OnFailure` + an hourly freshness check) surfaces a failed or silently-stopped backup loudly in the journal.

**Tech Stack:** Bun + TypeScript (`server/`), bash + systemd (ops repo `laingville/servers/`), `sqlite3` CLI (`.backup`).

**Two repos:**
- **App repo** (this repo, `lean-software-production/ensembleworks`) — Phase 1. Ships through the normal `release.sh` / `deploy.sh` pipeline (same pattern as v0.13.1). Must land *first*: the systemd units in Phase 2 set `DATABASE_DIR`, and the server must understand it before any host is migrated.
- **Ops repo** (`/home/mrdavidlaing/Work/laingville`, `servers/`) — Phase 2. Backup/restore/freshness scripts, systemd units, `bootstrap.sh` provisioning.
- **Phase 3** is an operational rollout runbook (no code), executed per host.

**Spec:** `docs/superpowers/specs/2026-07-09-room-database-fast-storage-design.md`

---

## File Structure

### App repo (this repo)
- Modify: `server/src/kernel/rooms.ts` — `createRoomHost` takes a resolved rooms directory instead of deriving `rooms/` from `dataDir`.
- Modify: `server/src/app.ts` — `createSyncApp` accepts optional `databaseDir`, resolves `roomsDir` once, reuses it for both the room host and the `EW_WARM_ROOMS` warm loop.
- Modify: `server/src/sync-server.ts` — read `DATABASE_DIR` from the environment and pass it through.
- Create: `server/src/database-dir.test.ts` — proves `DATABASE_DIR` routing (unset → `DATA_DIR/rooms/`; set → `DATABASE_DIR/rooms/`).
- Modify: `deploy/cutover-dataload-check.sh:26` — set `DATABASE_DIR="$work"` when booting the test server (spec L3, the one required cutover change).
- Modify: `deploy/deploy.sh` — non-blocking backup-freshness warning in the remote preflight heredoc.

### Ops repo (`laingville/servers/`)
- Create: `servers/shared/scripts/database-backed-dirs.sh` — shared allowlist (`DATABASE_BACKED_DIRS=(rooms)`), sourced by all three scripts.
- Create: `servers/shared/scripts/database-backup.sh` — 15-min backup (boot disk → `/home`).
- Create: `servers/shared/scripts/restore-database.sh` — seed / DR restore (`/home` → boot disk), non-empty guard.
- Create: `servers/shared/scripts/check-database-backup-fresh.sh` — outcome freshness check.
- Create: `servers/shared/scripts/units/` — the five systemd unit files (backup service+timer, failure handler, freshness service+timer).
- Create: `servers/shared/scripts/test/database-backup-test.sh` — bash assert harness (fake-release.sh style).
- Modify: `servers/ew-staging-001/bootstrap.sh`, `servers/ew-lsp-001/bootstrap.sh`, `servers/ew-donkeyred-001/bootstrap.sh`, `servers/ew-rink-001/bootstrap.sh` — provisioning block (create `DATABASE_DIR`, install `sqlite3`, install scripts + units, enable timers).

**Naming note (resolves a spec inconsistency):** the spec's provisioning section once writes `ExecStart=/usr/local/bin/ensembleworks-database-backup.sh` while its backup section names the file `database-backup.sh`. This plan standardizes on the plain names (`database-backup.sh`, `restore-database.sh`, `check-database-backup-fresh.sh`, `database-backed-dirs.sh`), all installed together into `/usr/local/bin/`. They must sit in the same directory because each sources the allowlist via `. "$(dirname "$0")/database-backed-dirs.sh"`.

---

## Phase 1 — App repo: thread `DATABASE_DIR` through the server

### Task 1: Route rooms through an optional `DATABASE_DIR`

**Files:**
- Create: `server/src/database-dir.test.ts`
- Modify: `server/src/kernel/rooms.ts:17-19`
- Modify: `server/src/app.ts:62-90` (the `createSyncApp` signature, `roomsDir` derivation, and the `EW_WARM_ROOMS` block)

- [ ] **Step 1: Write the failing test**

Create `server/src/database-dir.test.ts` (auto-discovered by `scripts/run-tests.ts` via the `**/src/**/*.test.ts` glob; standalone `main()` style, like `warm-rooms.test.ts`):

```typescript
// Proves DATABASE_DIR routing in createSyncApp/createRoomHost:
//   - DATABASE_DIR unset  -> rooms resolve under DATA_DIR/rooms/     (today's behavior)
//   - DATABASE_DIR set     -> rooms resolve under DATABASE_DIR/rooms/ (and NOT DATA_DIR/rooms/)
// Run with: bun src/database-dir.test.ts
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSyncApp } from './app.ts'

const ROOM_ID = 'dbdirroom'

async function main() {
	// 1. DATABASE_DIR unset: opening a room writes DATA_DIR/rooms/<id>.sqlite.
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dbdir-data-'))
		const { server, getOrCreateRoom } = createSyncApp({ dataDir })
		getOrCreateRoom(ROOM_ID).close()
		assert.ok(
			existsSync(path.join(dataDir, 'rooms', `${ROOM_ID}.sqlite`)),
			'unset DATABASE_DIR: room sqlite should live under DATA_DIR/rooms/'
		)
		server.close()
		console.log('ok: DATABASE_DIR unset -> DATA_DIR/rooms/')
	}

	// 2. DATABASE_DIR set: room sqlite lands under DATABASE_DIR/rooms/, NOT DATA_DIR/rooms/.
	{
		const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dbdir-data-'))
		const databaseDir = await mkdtemp(path.join(os.tmpdir(), 'dbdir-db-'))
		const { server, getOrCreateRoom } = createSyncApp({ dataDir, databaseDir })
		getOrCreateRoom(ROOM_ID).close()
		assert.ok(
			existsSync(path.join(databaseDir, 'rooms', `${ROOM_ID}.sqlite`)),
			'set DATABASE_DIR: room sqlite should live under DATABASE_DIR/rooms/'
		)
		assert.ok(
			!existsSync(path.join(dataDir, 'rooms', `${ROOM_ID}.sqlite`)),
			'set DATABASE_DIR: room sqlite must NOT be written under DATA_DIR/rooms/'
		)
		server.close()
		console.log('ok: DATABASE_DIR set -> DATABASE_DIR/rooms/ (not DATA_DIR/rooms/)')
	}
}

main().then(
	() => {
		console.log('ok: database-dir.test.ts: all tests passed')
		process.exit(0)
	},
	(err) => {
		console.error(err)
		process.exit(1)
	}
)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && bun src/database-dir.test.ts`
Expected: FAIL — the second block fails (with `databaseDir` currently ignored, the room lands under `DATA_DIR/rooms/`, so the `databaseDir/rooms` assertion fails). It may also fail typecheck because `createSyncApp` doesn't yet accept `databaseDir`.

- [ ] **Step 3: Change `createRoomHost` to accept a resolved rooms directory**

In `server/src/kernel/rooms.ts`, change the function to take the rooms directory directly instead of deriving it:

```typescript
export function createRoomHost(roomsDir: string): RoomHost {
	mkdirSync(roomsDir, { recursive: true })
```

(Remove the old `const roomsDir = path.join(dataDir, 'rooms')` line — `roomsDir` is now the parameter. The `path` import is no longer used for that derivation but is still used by `path.join(roomsDir, \`${roomId}.sqlite\`)` below, so leave the import.)

- [ ] **Step 4: Resolve `roomsDir` once in `createSyncApp` and reuse it**

In `server/src/app.ts`, update the signature and derivation:

```typescript
export function createSyncApp(opts: { dataDir: string; databaseDir?: string; clientDist?: string }): SyncApp {
	const uploadsDir = path.join(opts.dataDir, 'uploads')
	mkdirSync(uploadsDir, { recursive: true })
	const transcripts = createTranscriptStore(path.join(opts.dataDir, 'transcripts'))
	const roadmaps = createRoadmapStore(path.join(opts.dataDir, 'roadmaps'))
	const telemetry = createTelemetryStore(path.join(opts.dataDir, 'telemetry'))

	// Room DBs live on the fast boot disk when DATABASE_DIR is set (see the
	// room-database-fast-storage spec); otherwise they stay nested under DATA_DIR
	// (local dev, tests, a host mid-rollout that hasn't been migrated yet).
	const roomsDir = opts.databaseDir
		? path.join(opts.databaseDir, 'rooms')
		: path.join(opts.dataDir, 'rooms')

	const roomHost = createRoomHost(roomsDir)
```

Then update the `EW_WARM_ROOMS` block to reuse the same `roomsDir` (delete its local recompute so warm-load can never diverge from where rooms actually live):

```typescript
	if (process.env.EW_WARM_ROOMS === '1') {
		if (existsSync(roomsDir)) {
			for (const entry of readdirSync(roomsDir)) {
```

(Delete the line `const roomsDir = path.join(opts.dataDir, 'rooms')` inside that block — it now shadows nothing because the outer `roomsDir` is in scope.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && bun src/database-dir.test.ts`
Expected: PASS — both blocks print `ok:` and the final `all tests passed`.

- [ ] **Step 6: Typecheck the whole workspace**

Run: `bun run typecheck`
Expected: PASS (no errors across all workspaces). This also confirms every existing `createSyncApp({ dataDir })` caller still compiles — `databaseDir` is optional.

- [ ] **Step 7: Commit**

```bash
git add server/src/kernel/rooms.ts server/src/app.ts server/src/database-dir.test.ts
git commit -m "feat(sync): route room DBs through optional DATABASE_DIR"
```

### Task 2: Wire `DATABASE_DIR` into the server entry point

**Files:**
- Modify: `server/src/sync-server.ts:15-24`

`sync-server.ts` is the thin, intentionally untested entry point (it only parses env and starts listening — Task 1's test boots `createSyncApp` directly). Verification here is typecheck + a local boot, matching how the rest of this file is covered.

- [ ] **Step 1: Read `DATABASE_DIR` and pass it through**

In `server/src/sync-server.ts`, add the env read after the `DATA_DIR` line and pass it to `createSyncApp`, and log it:

```typescript
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const DATABASE_DIR = process.env.DATABASE_DIR // optional: fast boot-disk path for room DBs
const CLIENT_DIST = process.env.CLIENT_DIST ?? path.join(import.meta.dirname, '../../client/dist')

const { server } = createSyncApp({ dataDir: DATA_DIR, databaseDir: DATABASE_DIR, clientDist: CLIENT_DIST })

server.listen(PORT, () => {
	console.log(`ensembleworks sync server listening on :${PORT}`)
	console.log(`  data dir: ${DATA_DIR}`)
	console.log(`  database dir: ${DATABASE_DIR ?? '(unset — room DBs under data dir)'}`)
	console.log(`  client build: ${existsSync(CLIENT_DIST) ? CLIENT_DIST : '(not built — dev mode)'}`)
```

(Leave the two remaining `console.log` lines — auth posture — unchanged.)

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Verify it boots and logs the new line**

Run: `cd server && DATABASE_DIR=/tmp/ew-dbdir-smoke PORT=8799 bun src/sync-server.ts`
Expected: stdout includes `database dir: /tmp/ew-dbdir-smoke`; the process listens on `:8799`. Ctrl-C to stop. Then confirm `/tmp/ew-dbdir-smoke/rooms/` was created (proves the resolved path is live). `rm -rf /tmp/ew-dbdir-smoke`.

- [ ] **Step 4: Commit**

```bash
git add server/src/sync-server.ts
git commit -m "feat(sync): read DATABASE_DIR env in server entry point"
```

### Task 3: Fix `cutover-dataload-check.sh` to exercise the production resolution path

**Files:**
- Modify: `deploy/cutover-dataload-check.sh:26`

Spec L3: today the check boots with only `DATA_DIR="$work"` and relies on the `DATABASE_DIR`-unset fallback. Setting `DATABASE_DIR="$work"` makes it resolve `rooms/` the exact same way production does. Because `$work` is a full copy of `DATA_DIR` (which contains `rooms/`), `DATABASE_DIR="$work"` resolves rooms to `$work/rooms` — the same directory the copy already holds, so warm-load still finds every room.

- [ ] **Step 1: Add `DATABASE_DIR="$work"` to the boot env**

In `deploy/cutover-dataload-check.sh`, change the server-boot line:

```bash
${RUN} env PORT="$port" DATA_DIR="$work" DATABASE_DIR="$work" CLIENT_DIST="$cdir" EW_WARM_ROOMS=1 \
  "${fetchdir}/ensembleworks-server" sync >/tmp/ew-dataload.log 2>&1 & pid=$!
```

- [ ] **Step 2: Lint the script**

Run: `shellcheck deploy/cutover-dataload-check.sh`
Expected: no new warnings introduced by this line (pre-existing warnings, if any, unchanged).

- [ ] **Step 3: Commit**

```bash
git add deploy/cutover-dataload-check.sh
git commit -m "fix(cutover): set DATABASE_DIR in dataload check to match prod resolution"
```

### Task 4: Non-blocking backup-freshness warning in `deploy.sh` preflight

**Files:**
- Modify: `deploy/deploy.sh` (the remote `$REMOTE` heredoc preflight, near `deploy/deploy.sh:150-151`)

This is the only *server-repo* touch beyond the code change. It runs on the target host inside the ssh'd preflight heredoc. Non-blocking (a stale DR copy never endangers a deploy — the live copy is on the boot disk) and skips silently on hosts not yet migrated (script absent). Note the heredoc escapes shell vars as `\${VAR}`.

- [ ] **Step 1: Add the freshness note before `preflight ok`**

In `deploy/deploy.sh`, immediately before the `echo "    preflight ok"` line (currently `deploy/deploy.sh:151`), insert:

```bash
# Room-database backup freshness — non-blocking heads-up (room-db-fast-storage spec).
# Skips silently on hosts not yet migrated (script absent). A stale DR copy never
# blocks a deploy: the live room data is on the boot disk, not this backup.
if test -x /usr/local/bin/check-database-backup-fresh.sh; then
  sudo -u "\${APP_USER}" /usr/local/bin/check-database-backup-fresh.sh >/dev/null 2>&1 \
    || echo "    note: room-database backup on /home is STALE — investigate (deploy not blocked)" >&2
fi
```

- [ ] **Step 2: Lint**

Run: `shellcheck deploy/deploy.sh`
Expected: no new warnings from this block (the heredoc body is already `shellcheck disable`-scoped where relevant; match surrounding style).

- [ ] **Step 3: Commit**

```bash
git add deploy/deploy.sh
git commit -m "feat(deploy): warn (non-blocking) when room-db backup is stale"
```

### Task 5: Open the app-repo PR

- [ ] **Step 1: Push the branch and open the PR**

The branch `feat/room-database-fast-storage` already carries the spec commits. Push and open a PR describing: the new optional `DATABASE_DIR`, backward-compatible fallback, the cutover-check fix, and the deploy.sh warning. Link the spec and issue #18.

```bash
git push -u origin feat/room-database-fast-storage
gh pr create --title "feat: room databases on fast boot disk (DATABASE_DIR)" \
  --body "Implements docs/superpowers/specs/2026-07-09-room-database-fast-storage-design.md (follow-up to #18). Adds optional DATABASE_DIR so room *.sqlite live on the fast boot disk; fully backward-compatible fallback to DATA_DIR/rooms when unset. Ops-repo backup/restore/systemd lands separately. See spec Rollout for the seed-first migration order."
```

- [ ] **Step 2: After review + merge, cut the release**

Per CLAUDE.md, releases are cut only with the script from a clean `main`:

```bash
deploy/release.sh patch
```

Expected: tags and pushes the next patch version (e.g. `v0.13.2`). This version string is what Phase 3 deploys.

---

## Phase 2 — Ops repo: backup/restore scripts, systemd units, provisioning

All paths below are under `/home/mrdavidlaing/Work/laingville`. Work on a branch in that repo. These scripts have no unit-test harness in the app repo; they get a dedicated bash assert harness (Task 10) modelled on `deploy/test/fake-release.sh`.

### Task 6: Shared allowlist + backup script

**Files:**
- Create: `servers/shared/scripts/database-backed-dirs.sh`
- Create: `servers/shared/scripts/database-backup.sh`

- [ ] **Step 1: Create the shared allowlist**

`servers/shared/scripts/database-backed-dirs.sh`:

```bash
# Shared allowlist of DATABASE_DIR subdirectories that hold SQLite databases and
# are backed up to /home. Sourced by database-backup.sh, restore-database.sh, and
# check-database-backup-fresh.sh. This is the safety mechanism: the scripts only
# ever touch names in this list, so uploads/transcripts/roadmaps/telemetry are
# structurally impossible to touch. Add a new DB-backed subsystem here in ONE place.
# shellcheck disable=SC2034  # consumed by sourcing scripts
DATABASE_BACKED_DIRS=(rooms)
```

- [ ] **Step 2: Create the backup script**

`servers/shared/scripts/database-backup.sh`. Runs as the `ensembleworks` user (set in the unit), so it can read the mode-700 `DATABASE_DIR` and owns everything it writes on `/home` — no chown needed. The temp file is written onto the **destination** filesystem (`/home`) so the final `mv` is a real atomic `rename(2)`, not a cross-filesystem copy.

```bash
#!/usr/bin/env bash
# Back up SQLite databases from the fast boot disk (DATABASE_DIR) to the durable
# /home data volume (DATA_DIR). Run every 15 min by ensembleworks-database-backup.timer.
# Uses SQLite's Online Backup API (safe against a live WAL-mode database) and an
# atomic temp-then-rename on the destination filesystem.
# See docs/superpowers/specs/2026-07-09-room-database-fast-storage-design.md.
set -euo pipefail

APP_USER="${APP_USER:-ensembleworks}"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
DATABASE_DIR="${DATABASE_DIR:-/var/lib/ensembleworks/databases}"
DATA_DIR="${DATA_DIR:-${APP_HOME}/.local/share/ensembleworks}"

# shellcheck source=/dev/null
. "$(dirname "$0")/database-backed-dirs.sh"

shopt -s nullglob
for name in "${DATABASE_BACKED_DIRS[@]}"; do
	src_dir="${DATABASE_DIR}/${name}"
	dst_dir="${DATA_DIR}/${name}"
	[ -d "$src_dir" ] || continue
	install -d -m700 "$dst_dir"
	for src in "$src_dir"/*.sqlite; do
		db="$(basename "$src")"
		tmp="${dst_dir}/${db}.tmp"    # temp on the DEST fs (/home) => mv is atomic rename(2)
		rm -f "$tmp"
		sqlite3 "$src" ".backup '$tmp'"
		mv -f "$tmp" "${dst_dir}/${db}"
	done
done
```

- [ ] **Step 3: Make executable and lint**

```bash
chmod +x servers/shared/scripts/database-backup.sh
shellcheck servers/shared/scripts/database-backup.sh servers/shared/scripts/database-backed-dirs.sh
```

Expected: no warnings.

- [ ] **Step 4: Commit**

```bash
git add servers/shared/scripts/database-backed-dirs.sh servers/shared/scripts/database-backup.sh
git commit -m "feat: room-database backup script + shared allowlist"
```

### Task 7: Restore/seed script

**Files:**
- Create: `servers/shared/scripts/restore-database.sh`

- [ ] **Step 1: Create the restore script**

`servers/shared/scripts/restore-database.sh`. Reverse direction (`/home` → boot disk). Refuses a non-empty target unless `--force`, so it can never silently clobber live boot-disk data with a stale backup. Used both as the initial migration **seed** and for **disaster recovery**.

```bash
#!/usr/bin/env bash
# Seed / restore SQLite databases from the durable /home backup (DATA_DIR) onto
# the fast boot disk (DATABASE_DIR). Two uses:
#   - initial migration seed: copy live data onto the boot disk before first start
#   - disaster recovery: rebuild the boot disk from the /home backup
# Refuses to overwrite a non-empty DATABASE_DIR/<name> unless --force is given, so
# it can never silently clobber live boot-disk data with a stale backup.
# See docs/superpowers/specs/2026-07-09-room-database-fast-storage-design.md.
set -euo pipefail

FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

APP_USER="${APP_USER:-ensembleworks}"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
DATABASE_DIR="${DATABASE_DIR:-/var/lib/ensembleworks/databases}"
DATA_DIR="${DATA_DIR:-${APP_HOME}/.local/share/ensembleworks}"

# shellcheck source=/dev/null
. "$(dirname "$0")/database-backed-dirs.sh"

now="$(date +%s)"
restored=0
shopt -s nullglob
for name in "${DATABASE_BACKED_DIRS[@]}"; do
	src_dir="${DATA_DIR}/${name}"
	dst_dir="${DATABASE_DIR}/${name}"
	install -d -m700 "$dst_dir"
	if [ "$FORCE" -ne 1 ] && [ -n "$(ls -A "$dst_dir" 2>/dev/null)" ]; then
		echo "REFUSING: ${dst_dir} is not empty — pass --force to overwrite live boot-disk data" >&2
		exit 1
	fi
	for src in "$src_dir"/*.sqlite; do
		db="$(basename "$src")"
		cp -f "$src" "${dst_dir}/${db}"
		age_min="$(( (now - $(stat -c %Y "$src")) / 60 ))"
		echo "restored ${name}/${db} (backup was ${age_min} min old)"
		restored=$((restored + 1))
	done
done
echo "restore complete: ${restored} database(s). Now start ensembleworks-sync."
```

- [ ] **Step 2: Make executable and lint**

```bash
chmod +x servers/shared/scripts/restore-database.sh
shellcheck servers/shared/scripts/restore-database.sh
```

Expected: no warnings.

- [ ] **Step 3: Commit**

```bash
git add servers/shared/scripts/restore-database.sh
git commit -m "feat: room-database restore/seed script with non-empty guard"
```

### Task 8: Freshness check script

**Files:**
- Create: `servers/shared/scripts/check-database-backup-fresh.sh`

- [ ] **Step 1: Create the freshness check**

`servers/shared/scripts/check-database-backup-fresh.sh`. Outcome check: asserts a fresh backup actually exists on `/home`, so it catches both a failed backup run and a silently-stopped timer. Threshold is 2× the 15-min interval.

```bash
#!/usr/bin/env bash
# Freshness check for the /home DR backup of the room databases. Exits 0 if the
# newest *.sqlite backup under every listed dir is younger than the threshold;
# exits non-zero and logs loudly (daemon.err) otherwise. Catches BOTH a failed
# backup run and a silently-stopped timer (an OUTCOME check, unlike OnFailure).
# See docs/superpowers/specs/2026-07-09-room-database-fast-storage-design.md.
set -euo pipefail

APP_USER="${APP_USER:-ensembleworks}"
APP_HOME="${APP_HOME:-/home/${APP_USER}}"
DATA_DIR="${DATA_DIR:-${APP_HOME}/.local/share/ensembleworks}"
THRESHOLD_MIN="${THRESHOLD_MIN:-30}"   # 2x the 15-min backup interval

# shellcheck source=/dev/null
. "$(dirname "$0")/database-backed-dirs.sh"

now="$(date +%s)"
stale=0
for name in "${DATABASE_BACKED_DIRS[@]}"; do
	dir="${DATA_DIR}/${name}"
	newest="$(find "$dir" -maxdepth 1 -name '*.sqlite' -printf '%T@\n' 2>/dev/null | sort -n | tail -1)"
	if [ -z "$newest" ]; then
		echo "STALE: no *.sqlite backup found under ${dir}" >&2
		stale=1; continue
	fi
	age_min="$(( (now - ${newest%.*}) / 60 ))"
	if [ "$age_min" -gt "$THRESHOLD_MIN" ]; then
		echo "STALE: newest backup under ${dir} is ${age_min} min old (> ${THRESHOLD_MIN} min)" >&2
		stale=1
	fi
done

if [ "$stale" -ne 0 ]; then
	logger -p daemon.err "ensembleworks database backup STALE — DR copy on /home is out of date; investigate before any boot-disk rebuild"
	exit 1
fi
echo "database backups fresh (newest <= ${THRESHOLD_MIN} min old)"
```

- [ ] **Step 2: Make executable and lint**

```bash
chmod +x servers/shared/scripts/check-database-backup-fresh.sh
shellcheck servers/shared/scripts/check-database-backup-fresh.sh
```

Expected: no warnings.

- [ ] **Step 3: Commit**

```bash
git add servers/shared/scripts/check-database-backup-fresh.sh
git commit -m "feat: room-database backup freshness check"
```

### Task 9: systemd units

**Files:**
- Create: `servers/shared/scripts/units/ensembleworks-database-backup.service`
- Create: `servers/shared/scripts/units/ensembleworks-database-backup.timer`
- Create: `servers/shared/scripts/units/ensembleworks-database-backup-failed.service`
- Create: `servers/shared/scripts/units/ensembleworks-database-backup-freshness.service`
- Create: `servers/shared/scripts/units/ensembleworks-database-backup-freshness.timer`

- [ ] **Step 1: Backup service (with OnFailure)**

`ensembleworks-database-backup.service`:

```ini
[Unit]
Description=Back up EnsembleWorks room databases from boot disk to /home
OnFailure=ensembleworks-database-backup-failed.service

[Service]
Type=oneshot
User=ensembleworks
Group=ensembleworks
ExecStart=/usr/local/bin/database-backup.sh
```

- [ ] **Step 2: Backup timer (every 15 min)**

`ensembleworks-database-backup.timer`:

```ini
[Unit]
Description=Run EnsembleWorks room-database backup every 15 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: OnFailure handler**

`ensembleworks-database-backup-failed.service`:

```ini
[Unit]
Description=Log a loud error when EnsembleWorks database backup fails

[Service]
Type=oneshot
ExecStart=/usr/bin/logger -p daemon.err "ensembleworks database backup FAILED — DR copy on /home is stale; investigate before any boot-disk rebuild"
```

- [ ] **Step 4: Freshness service**

`ensembleworks-database-backup-freshness.service`:

```ini
[Unit]
Description=Check EnsembleWorks database backups on /home are fresh

[Service]
Type=oneshot
User=ensembleworks
Group=ensembleworks
ExecStart=/usr/local/bin/check-database-backup-fresh.sh
```

- [ ] **Step 5: Freshness timer (hourly)**

`ensembleworks-database-backup-freshness.timer`:

```ini
[Unit]
Description=Hourly freshness check of EnsembleWorks database backups

[Timer]
OnBootSec=20min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 6: Commit**

```bash
git add servers/shared/scripts/units/
git commit -m "feat: systemd units for room-database backup + freshness check"
```

### Task 10: Ops-repo test harness

**Files:**
- Create: `servers/shared/scripts/test/database-backup-test.sh`

Modelled on `deploy/test/fake-release.sh`'s `ok()`/`bad()` assert idiom. Runs entirely in temp dirs on the local machine (requires `sqlite3` present locally). Covers spec §Testing (ops repo): (a) atomic temp-then-rename, (b) allowlist honoured, (c) restore non-empty guard, (d) freshness pass/fail.

- [ ] **Step 1: Write the harness**

`servers/shared/scripts/test/database-backup-test.sh`:

```bash
#!/usr/bin/env bash
# Tests for database-backup.sh / restore-database.sh / check-database-backup-fresh.sh.
# Runs in throwaway temp dirs; requires sqlite3. No systemd, no ssh.
#   Run from repo root: servers/shared/scripts/test/database-backup-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"   # servers/shared/scripts

fail=0
ok()  { echo "ok  : $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export DATABASE_DIR="$work/db"       # fake "boot disk"
export DATA_DIR="$work/home"         # fake "/home"
mkdir -p "$DATABASE_DIR/rooms" "$DATA_DIR"

# A fake WAL-mode room database on the "boot disk".
sqlite3 "$DATABASE_DIR/rooms/team.sqlite" \
  "PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);" >/dev/null

# A non-listed sibling directory that must NEVER be touched.
mkdir -p "$DATABASE_DIR/secrets"
sqlite3 "$DATABASE_DIR/secrets/keys.sqlite" "CREATE TABLE k(x);" >/dev/null

# --- (a) backup writes an atomic .sqlite on /home and leaves no .tmp ------------
"$here/database-backup.sh"
[ -f "$DATA_DIR/rooms/team.sqlite" ] && ok "backup produced /home rooms/team.sqlite" \
  || bad "backup did not produce /home rooms/team.sqlite"
[ -z "$(find "$DATA_DIR" -name '*.tmp')" ] && ok "no leftover .tmp after backup" \
  || bad "leftover .tmp file after backup"
# backup is a real, readable sqlite with the row.
[ "$(sqlite3 "$DATA_DIR/rooms/team.sqlite" 'SELECT x FROM t')" = "1" ] \
  && ok "backup is a valid checkpointed sqlite" || bad "backup sqlite unreadable/empty"

# --- (b) allowlist honoured: secrets/ never copied -----------------------------
[ ! -e "$DATA_DIR/secrets" ] && ok "non-listed secrets/ dir untouched by backup" \
  || bad "backup touched non-listed secrets/ dir"

# --- (c) restore non-empty guard -----------------------------------------------
# DATABASE_DIR/rooms is non-empty (holds the live db) -> restore must refuse.
if "$here/restore-database.sh" >/dev/null 2>&1; then
  bad "restore overwrote a non-empty DATABASE_DIR without --force"
else
  ok "restore refused non-empty DATABASE_DIR without --force"
fi
# Empty the target -> seed must succeed.
rm -f "$DATABASE_DIR/rooms/"*.sqlite
"$here/restore-database.sh" >/dev/null
[ -f "$DATABASE_DIR/rooms/team.sqlite" ] && ok "restore seeds an empty DATABASE_DIR" \
  || bad "restore failed to seed an empty DATABASE_DIR"

# --- (d) freshness: fresh passes, stale fails ----------------------------------
if THRESHOLD_MIN=30 "$here/check-database-backup-fresh.sh" >/dev/null 2>&1; then
  ok "freshness check passes for a recent backup"
else
  bad "freshness check failed for a recent backup"
fi
# Age the backup past the threshold.
touch -d '2 hours ago' "$DATA_DIR/rooms/team.sqlite"
if THRESHOLD_MIN=30 "$here/check-database-backup-fresh.sh" >/dev/null 2>&1; then
  bad "freshness check passed for a stale (2h-old) backup"
else
  ok "freshness check fails loudly for a stale backup"
fi

[ "$fail" -eq 0 ] && echo "ALL OK" || { echo "SOME FAILED" >&2; exit 1; }
```

- [ ] **Step 2: Make executable and run**

```bash
chmod +x servers/shared/scripts/test/database-backup-test.sh
servers/shared/scripts/test/database-backup-test.sh
```

Expected: every line prints `ok  :` and the final line is `ALL OK` (exit 0).

- [ ] **Step 3: Commit**

```bash
git add servers/shared/scripts/test/database-backup-test.sh
git commit -m "test: ops-repo harness for room-database backup/restore/freshness"
```

### Task 11: Provisioning block in each host's `bootstrap.sh`

**Files:**
- Modify: `servers/ew-staging-001/bootstrap.sh`
- Modify: `servers/ew-lsp-001/bootstrap.sh`
- Modify: `servers/ew-donkeyred-001/bootstrap.sh`
- Modify: `servers/ew-rink-001/bootstrap.sh`

The four `bootstrap.sh` files are near-identical per-host copies. Add the same block to each, anchored **after** the existing `home-snapshot` timer install section (the closest existing analog). Keep host-specific values (tenant, hostnames) untouched — this block has none.

- [ ] **Step 1: Add the provisioning block to `ew-staging-001/bootstrap.sh` first**

Locate the home-snapshot timer install section (`grep -n home-snapshot servers/ew-staging-001/bootstrap.sh`). Immediately after it, insert:

```bash
# --- Room databases on the fast boot disk (room-db-fast-storage spec) ----------
# Room *.sqlite live on the boot disk (fast ext4, no btrfs COW); a 15-min timer
# backs them up to /home for durability. No chattr +C needed — plain ext4.
apt-get install -y sqlite3
install -d -m700 -o ensembleworks -g ensembleworks /var/lib/ensembleworks/databases

# Scripts (installed together; each sources database-backed-dirs.sh via dirname).
install -m755 /opt/laingville/servers/shared/scripts/database-backup.sh          /usr/local/bin/database-backup.sh
install -m755 /opt/laingville/servers/shared/scripts/restore-database.sh          /usr/local/bin/restore-database.sh
install -m755 /opt/laingville/servers/shared/scripts/check-database-backup-fresh.sh /usr/local/bin/check-database-backup-fresh.sh
install -m644 /opt/laingville/servers/shared/scripts/database-backed-dirs.sh      /usr/local/bin/database-backed-dirs.sh

# systemd units.
install -m644 /opt/laingville/servers/shared/scripts/units/ensembleworks-database-backup.service            /etc/systemd/system/
install -m644 /opt/laingville/servers/shared/scripts/units/ensembleworks-database-backup.timer              /etc/systemd/system/
install -m644 /opt/laingville/servers/shared/scripts/units/ensembleworks-database-backup-failed.service     /etc/systemd/system/
install -m644 /opt/laingville/servers/shared/scripts/units/ensembleworks-database-backup-freshness.service  /etc/systemd/system/
install -m644 /opt/laingville/servers/shared/scripts/units/ensembleworks-database-backup-freshness.timer    /etc/systemd/system/
systemctl daemon-reload
# NOTE: on a fresh bootstrap the timers are enabled here. During the live rollout
# (Phase 3) the backup timer is enabled only AFTER the seed step, to avoid an
# empty-DB backup clobbering the authoritative /home copy — see the spec Rollout.
systemctl enable --now ensembleworks-database-backup.timer
systemctl enable --now ensembleworks-database-backup-freshness.timer
```

Adjust the source path (`/opt/laingville/servers/shared/scripts/...`) to wherever this repo is checked out on the host — match the path the existing `home-snapshot` install lines use for their source files.

- [ ] **Step 2: Point the sync service at `DATABASE_DIR`**

The running server only uses the boot disk if its unit exports `DATABASE_DIR`. In the same `bootstrap.sh`, find where the `ensembleworks-sync.service` definition sets `DATA_DIR` (`grep -n 'Environment=DATA_DIR\|DATA_DIR=' servers/ew-staging-001/bootstrap.sh`) and add, right beside it, a fixed absolute value (no `@APP_HOME@` templating — it's the same path on every host):

```ini
Environment=DATABASE_DIR=/var/lib/ensembleworks/databases
```

- [ ] **Step 3: Add the rebuild-runbook acknowledgement**

Where each host documents a boot-disk rebuild / DR restore (e.g. `servers/<host>/DEPLOYING.md`, next to the restore guidance), add a required step: run `check-database-backup-fresh.sh` and require an explicit operator acknowledgement of the reported backup age **before** wiping the boot disk — this is the one place a stale backup actually costs data. Then restore with `restore-database.sh` (use `--force` only after acknowledging staleness).

```markdown
### Before wiping the boot disk (DR)
1. `sudo -n -u ensembleworks /usr/local/bin/check-database-backup-fresh.sh` — note the reported age.
2. Acknowledge: the boot disk holds up to ~15 min of edits newer than the /home backup; wiping loses them. Proceed only if that's acceptable (or recover the newer boot-disk copy first).
3. After rebuild: `sudo -n -u ensembleworks /usr/local/bin/restore-database.sh` to seed the boot disk, then start `ensembleworks-sync`.
```

- [ ] **Step 4: Copy the identical block into the other three hosts**

Add the same block **and** the `Environment=DATABASE_DIR=...` sync-unit line, at the same anchors, to `ew-lsp-001/bootstrap.sh`, `ew-donkeyred-001/bootstrap.sh`, and `ew-rink-001/bootstrap.sh`. Verify with:

```bash
for h in ew-staging-001 ew-lsp-001 ew-donkeyred-001 ew-rink-001; do
  echo "== $h =="; grep -c "install -d -m700 -o ensembleworks -g ensembleworks /var/lib/ensembleworks/databases" "servers/$h/bootstrap.sh"
done
```

Expected: each prints `1`.

- [ ] **Step 5: Lint the four scripts**

```bash
for h in ew-staging-001 ew-lsp-001 ew-donkeyred-001 ew-rink-001; do shellcheck "servers/$h/bootstrap.sh" || true; done
```

Expected: no *new* warnings from the added block (these large scripts may carry pre-existing warnings; confirm none reference the new lines).

- [ ] **Step 6: Commit**

```bash
git add servers/ew-staging-001/bootstrap.sh servers/ew-lsp-001/bootstrap.sh servers/ew-donkeyred-001/bootstrap.sh servers/ew-rink-001/bootstrap.sh
git commit -m "feat: provision room-database fast storage + backup timers (all hosts)"
```

---

## Phase 3 — Rollout runbook (operational, per host)

No code. Executed per host **after** the app-repo release (Phase 1 Task 5) exists and the ops-repo changes (Phase 2) are merged. The migration must **seed the boot disk from live data before the new server starts** — otherwise the server creates empty room DBs and the first backup destroys the authoritative `/home` copy. `restore-database.sh` is the seed tool; its non-empty guard confirms a clean first seed.

For each host, `<HOST>` is the tailnet target (e.g. `mrdavidlaing@ew-staging-001-tailnet`) and `<VER>` is the Phase 1 release (e.g. `0.13.2`). Commands run over ssh; the box grants passwordless `sudo -n`.

### Task 12: Migrate `ew-staging-001` (canary)

- [ ] **Step 1: Provision the new pieces by hand (do NOT enable the backup timer yet)**

Per the spec, apply the specific new pieces live rather than re-running full `bootstrap.sh`. On the host: `apt-get install -y sqlite3`; create `/var/lib/ensembleworks/databases` (`install -d -m700 -o ensembleworks -g ensembleworks`); install the four scripts + shared allowlist into `/usr/local/bin/`; install all five units into `/etc/systemd/system/`; `systemctl daemon-reload`. **Enable the freshness timer now, but leave the backup timer disabled until after the seed:**

```bash
sudo -n systemctl enable --now ensembleworks-database-backup-freshness.timer
```

- [ ] **Step 2: Stop sync so `/home` room data is quiescent**

```bash
sudo -n systemctl stop ensembleworks-sync
```

- [ ] **Step 3: Seed the boot disk from live `/home` data**

```bash
sudo -n -u ensembleworks /usr/local/bin/restore-database.sh
```

Expected: prints `restored rooms/<room>.sqlite ...` for each room and `restore complete: N database(s).` The non-empty guard confirms `DATABASE_DIR/rooms/` started empty (clean first seed). If it instead prints `REFUSING`, stop — `DATABASE_DIR` unexpectedly already held data; investigate before proceeding.

- [ ] **Step 4: Deploy the new version and start sync**

From the app repo working copy (the systemd unit must now export `DATABASE_DIR=/var/lib/ensembleworks/databases` — confirm the deployed `ensembleworks-sync.service` sets it; add it in the unit if the deploy tooling doesn't):

```bash
deploy/deploy.sh <HOST> <VER>
```

Then confirm sync opened the **seeded** databases on the boot disk:

```bash
ssh <HOST> "sudo -n journalctl -u ensembleworks-sync -n 30 --no-pager | grep -E 'database dir|room .* opened'"
ssh <HOST> "sudo -n ls -la /var/lib/ensembleworks/databases/rooms/"
```

Expected: log shows `database dir: /var/lib/ensembleworks/databases`; each room reports `opened`; the `.sqlite` files (with fresh `-wal`/`-shm` sidecars once written) are on the boot disk with data intact.

- [ ] **Step 5: Now enable the backup timer**

```bash
sudo -n systemctl enable --now ensembleworks-database-backup.timer
```

- [ ] **Step 6: Verify the full loop on staging**

- Live writes land on the boot disk: edit a room, confirm `/var/lib/ensembleworks/databases/rooms/<room>.sqlite` mtime advances.
- The timer fires and lands an atomic backup at the existing `/home` path:
  ```bash
  ssh <HOST> "sudo -n systemctl start ensembleworks-database-backup.service && sudo -n ls -la ~ensembleworks/.local/share/ensembleworks/rooms/"
  ```
  Expected: fresh `<room>.sqlite`, no `.tmp` left behind.
- Freshness check passes while current, fails when made stale:
  ```bash
  ssh <HOST> "sudo -n -u ensembleworks /usr/local/bin/check-database-backup-fresh.sh"   # -> fresh
  ssh <HOST> "sudo -n systemctl stop ensembleworks-database-backup.timer"
  # wait out the 30-min threshold, then:
  ssh <HOST> "sudo -n -u ensembleworks /usr/local/bin/check-database-backup-fresh.sh; sudo -n journalctl -p err -n 5 --no-pager"
  # -> exits non-zero, logs the loud daemon.err line. Re-enable the timer afterward.
  ```
- `cutover.sh` / `cutover-dataload-check.sh` still pass (with the Task 3 `DATABASE_DIR="$work"` fix deployed).
- Full DR cycle: `stop sync → empty DATABASE_DIR/rooms → restore-database.sh → start sync → room loads with data intact`.

- [ ] **Step 7: Confirm health**

```bash
ssh <HOST> "curl -sf http://localhost:8080/ -o /dev/null -w '%{http_code}\n'; sudo -n systemctl is-failed ensembleworks-database-backup.service"
```

Expected: `200`; backup service not `failed`.

### Task 13: Roll to production hosts one at a time

- [ ] **Step 1: Migrate `ew-lsp-001`**

Repeat Task 12 Steps 1-7 for `mrdavidlaing@ew-lsp-001-tailnet` in a quiet window (no live incident this time). Same stop → seed → deploy/start → enable-timer → verify order.

- [ ] **Step 2: Migrate `ew-donkeyred-001`**

Repeat for `mrdavidlaing@ew-donkeyred-001-tailnet`.

- [ ] **Step 3: Migrate `ew-rink-001`**

Repeat for `mrdavidlaing@ew-rink-001-tailnet`.

- [ ] **Step 4: Fleet confirmation**

For all four hosts, confirm: `database dir:` log line present, backup timer active, freshness timer active, `systemctl is-failed ensembleworks-database-backup.service` is not `failed`, edge `http://localhost:8080/` → `200`.

- [ ] **Step 5: Update #18 and close out**

Post a comment on issue #18 recording the fleet migration (room DBs now on fast boot disk with 15-min `/home` backups), linking the spec and the merged PRs. Note the two forward-looking cutover caveats (spec L3) for whoever next runs an era cutover.
