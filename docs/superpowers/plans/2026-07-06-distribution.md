# Distribution & artifact deploy — CI-compiled binaries, fetch-verify-swap `deploy.sh`, the cutover choreography (slice #7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the machinery that turns every `v*` tag into standalone Bun binaries and swaps them onto a box without building there. One CI workflow (`.github/workflows/release-cli.yml`, retiring `release-termgw.yml`) cross-compiles the `ensembleworks` CLI, the `ensembleworks-server`, and the `ensembleworks-transcriber`, builds `client-dist.tar.gz`, and uploads them + `install.sh` + `ensembleworks-checksums.txt` to the release. A rewritten `deploy/deploy.sh` **fetches** those assets, **verifies** them (checksum + a hermetic pre-swap boot-check), stamps a posture-era marker, then does the atomic `current` swap + `systemctl restart` it does today. The three prod units re-point from `npm run …` to absolute binary paths. A one-shot `deploy/cutover.sh` carries the one-time data-load-check + `DATA_DIR` backup + env/SKILL reseed. After the slice `bun run typecheck`, `bun run test`, and `bun run build` are green and the suite count is **unchanged at 58** (this slice is scripts + CI + units + a 5-line dispatcher + a `--check` guard — no `bun`-runner `*.test.ts` is added).

**Spec:** `docs/superpowers/specs/2026-07-06-distribution-design.md` — panel r1 blocker fixed + r2 pass; implement it exactly. Its decisions table (§2), the compile entries (§3), the CI workflow (§4), `install.sh` (§5), the `deploy.sh` rewrite (§6), the three unit diffs (§7), `cutover.sh` (§8), the posture-era guard (§9), and the testing plan (§10) are authoritative.
**Charter:** `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`, §"#7 — Distribution / #8 — Cutover" + "Standing conventions".

**Scope boundary (spec §1 — do not cross it):** #7 delivers *machinery* + a *dry-run proof*. #7 does **NOT**: run the production cutover (that is #8, the user's operation); delete `gateway-go/`, `connect.sh`, `bin/canvas`, node-pty, or Node on hosts (all #8 — `release-termgw.yml` is the one retirement #7 makes); rewrite the devcontainer feature (#8); move any route/schema/Caddyfile; add auth/gateway-id/connector behaviour (#4/#5 pinned those — #7 only compiles them); or ship musl/Alpine targets.

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun`/`bun run` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **Indentation.** `server/src/*` and `contracts/src/*` are **TAB**-indented; `transcriber/src/*` is **TAB**-indented. Shell scripts under `deploy/` use **TAB** indentation (see the existing `deploy/lib.sh` / `deploy.sh`). The fenced blocks below are shown indented two spaces for markdown; strip that two-space prefix and the body is tabs. Preserve them. JSON (`package.json`) in this repo is 2-space; match each file's existing style (server/transcriber/root are 2-space, `cli/package.json` is tabs).
3. **`shellcheck` gate.** Every shipped script is `shellcheck`-clean. The host's system `shellcheck` binary is currently broken (missing shared lib); use the nix-provided one, which is the working invocation on this box:
   ```bash
   nix run nixpkgs#shellcheck -- deploy/deploy.sh   # substitute plain `shellcheck` if the host's is healthy
   ```
   `bash -n <script>` is a fast parse-only companion check.
4. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper — commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Gating policy — which gates apply per task

Deploy scripts are not `bun`-runner unit tests, so the suite budget is **58 → 58** (spec D9). The gates are compile/boot/`--dry-run`/`fake-release`/`shellcheck` proofs, **not** a `bun run test` delta — but `bun run test` (58 pass), `bun run typecheck`, and `bun run build` MUST stay green at every task end, because `server/src/main.ts` is new server code and the transcriber `--check` guard is new transcriber code.

Each task states plainly whether its gate is a **real runnable proof** or **inspection-only**:

| Task | Deliverable | Gate class |
|---|---|---|
| 1 | server `main.ts` dispatcher + 3× `build:binary` + transcriber `--check` | **RUNNABLE** — compile all three, boot-check server sync + term + transcriber `--check` (reproduces spec §10.4) |
| 2 | `deploy/lib.sh` fetch/boot/era/prune functions + `deploy/posture-era` | **RUNNABLE** — source lib.sh, unit-test each function in isolation + `shellcheck` |
| 3 | `deploy/install.sh` | Partly runnable — `shellcheck` + `bash -n` + host arch-detect self-run; the real curl-a-release path is inspection-only (needs a published release) |
| 4 | `deploy/deploy.sh` rewrite | **RUNNABLE** — `shellcheck` + `bash -n` + `--dry-run` against a locally-built release dir (real fetch/verify/boot/swap-plan, no ssh) |
| 5 | three systemd unit rewrites | **Inspection-mostly** — runnable proxy is `systemd-analyze verify` on a rendered copy + grep asserts on the preserved/renamed lines |
| 6 | `deploy/cutover.sh` + two helpers | Partly runnable — `shellcheck` + `bash -n` all three; `cutover-reseed.sh` runnable against a fake env dir; the ssh choreography is inspection-only |
| 7 | `.github/workflows/release-cli.yml` (+ delete `release-termgw.yml`) | **Inspection-only for CI** — runnable proxies: YAML parse, `shellcheck` of extracted `run:` blocks, and the compile commands it invokes already dry-run in Task 1 |
| 8 | `deploy/test/fake-release.sh` + README note | **RUNNABLE — the integration proof** — end-to-end fetch→verify→boot→era→prune with negative cases, no box, no licence key |

No task may leave a red suite or a `shellcheck` finding at its end.

---

## Task 1 — The three compile entries: `server/src/main.ts` dispatcher, `build:binary` scripts, transcriber `--check`

Create the single-binary server dispatcher, add/parameterise the three `build:binary` scripts, and add the transcriber's hermetic `--check` flag. **RUNNABLE gate:** compile all three host binaries and boot-check each (reproduces the spec §10.4 sync probe, extends it to term + `--check`).

### Step 1 — `server/src/main.ts` (the `ensembleworks-server` compile entry)

- [ ] **Create `server/src/main.ts`** (spec §3.1, verbatim — literal-specifier dynamic imports, **do NOT** "fix" these to static top-level `import` statements; see the callout below):
  ```ts
  // server/src/main.ts — the ensembleworks-server compile entry.
  // `ensembleworks-server sync` (default) runs the sync/kernel server; `… term`
  // runs the terminal gateway. Literal-specifier dynamic import() means bun bundles
  // BOTH entrypoints into the binary but only the selected one's top-level executes
  // (ES modules evaluate on first import) — so exactly one server.listen() fires.
  //
  // DELIBERATE exception to the connector spec's "static imports only" compile rule
  // (#5 §8) — do NOT rewrite these to top-level `import` statements. The specifiers
  // are string LITERALS, so `bun build --compile` resolves and embeds BOTH modules
  // at bundle time (the 561-module count includes both entrypoints) — there is no
  // runtime path resolution, which is what #5 §8 guards against. What the dynamic
  // form buys is DEFERRED EVALUATION: a top-level `import './sync-server.ts'` +
  // `import './terminal-gateway.ts'` would evaluate both modules and fire both
  // server.listen() calls (double-bind, instant crash). Awaiting exactly one runs
  // exactly one listener. Proven (spec §10.4) and load-bearing.
  const mode = process.argv[2] ?? 'sync'
  if (mode === 'term') await import('./terminal-gateway.ts')
  else if (mode === 'sync') await import('./sync-server.ts')
  else {
  	console.error(`ensembleworks-server: unknown mode '${mode}' (expected sync|term)`)
  	process.exit(2)
  }
  ```
  `sync-server.ts` and `terminal-gateway.ts` are **not modified** — they keep their top-level `server.listen(PORT, …)` and their env reads.

### Step 2 — The three `build:binary` scripts

- [ ] **`server/package.json`** — add a `build:binary` script (2-space JSON). Insert it after the existing `"start:term"` line so `scripts` reads:
  ```json
      "start:term": "bun src/terminal-gateway.ts",
      "build:binary": "bun build --compile --sourcemap --target=${EW_TARGET:-bun-linux-x64} src/main.ts --outfile dist/ensembleworks-server",
  ```

- [ ] **`cli/package.json`** — add a `build:binary` script (TAB-indented JSON). Insert it in `scripts` (which currently has only `build`/`typecheck`) so it reads:
  ```json
  		"build:binary": "bun build --compile --sourcemap --target=${EW_TARGET:-bun-linux-x64} src/main.ts --outfile dist/ensembleworks",
  		"build": "bunx tsc --noEmit",
  ```

- [ ] **`transcriber/package.json`** — generalise the existing `build:binary` (it lacks `--target`). Replace:
  ```json
      "build:binary": "bun build --compile --sourcemap src/transcriber.ts --outfile dist/ensembleworks-transcriber",
  ```
  with:
  ```json
      "build:binary": "bun build --compile --sourcemap --target=${EW_TARGET:-bun-linux-x64} src/transcriber.ts --outfile dist/ensembleworks-transcriber",
  ```
  (`bun run` executes scripts via a shell that expands `${EW_TARGET:-…}`; default = the host, so a dev `bun run build:binary` just works. The CI matrix sets `EW_TARGET` per arch — Task 7.)

### Step 3 — The transcriber `--check` flag

- [ ] **`transcriber/src/transcriber.ts`** — add the hermetic boot-check guard **immediately after the `SCRIBE_NAME` const** (line 45, i.e. after the `readScribeEndpoint(...)` + `STT_*` reads and before the `SAMPLE_RATE` const). The top-level `@livekit/rtc-node` import (lines 25–32) has already linked the native addon by the time this line runs, so reaching it proves arch integrity. Insert (spec §3.3, verbatim):
  ```ts
  if (process.argv.includes('--check')) {
  	// The rtc-node import above has loaded the embedded native addon; the config
  	// reads above have parsed the env. Reaching here == the binary is intact for
  	// this arch. No room.connect() — pipeline correctness is the #6 e2e-gate's job.
  	console.log(`scribe --check ok (${SYNC_ROOM} @ ${SYNC_URL})`)
  	process.exit(0)
  }
  ```
  Nothing else in `transcriber.ts` changes — `main()` is still called at the bottom, but `--check` `process.exit(0)`s at module scope before it runs.

### Step 4 — RUNNABLE gate: compile + boot-check all three (reproduce spec §10.4)

- [ ] **Compile the three host binaries:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  (cd server && bun run build:binary)        # dist/ensembleworks-server
  (cd cli && bun run build:binary)           # dist/ensembleworks
  (cd transcriber && bun run build:binary)   # dist/ensembleworks-transcriber
  ```
  Expected: each prints a `bun build --compile` summary (server ~561 modules) and writes the binary. No error.

- [ ] **Boot-check server `sync` (reproduces the spec §10.4 green probe):**
  ```bash
  ddir="$(mktemp -d)"; cdir="$(mktemp -d)"; port=8790
  PORT=$port DATA_DIR="$ddir" CLIENT_DIST="$cdir" server/dist/ensembleworks-server sync & pid=$!
  for _ in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/health" || true)"
    [ "$code" = 200 ] && break; sleep 0.25
  done
  curl -s "http://127.0.0.1:$port/api/health"; echo
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -rf "$ddir" "$cdir"
  ```
  Expected: `200 {"ok":true,"rooms":[]}` (matches spec §10.4).

- [ ] **Boot-check server `term` (new — spec §3.1/§10.4 "specified, not yet probed"):**
  ```bash
  port=8791
  PORT=$port server/dist/ensembleworks-server term & pid=$!
  for _ in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/api/terminal/health" || true)"
    [ "$code" = 200 ] && break; sleep 0.25
  done
  curl -s "http://127.0.0.1:$port/api/terminal/health"; echo
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  ```
  Expected: `200 {"ok":true,"sessions":0}` (no `TERM_RUN_AS` — the health handler never spawns tmux, so it is side-effect-free). Precondition: `tmux` on PATH.

- [ ] **Boot-check transcriber `--check` (new — spec §3.3):**
  ```bash
  transcriber/dist/ensembleworks-transcriber --check; echo "exit=$?"
  ```
  Expected: `scribe --check ok (team @ http://localhost:8788)` then `exit=0`.

- [ ] **Full green gate:**
  ```bash
  bun run typecheck && bun run test && bun run build
  ```
  Expected: typecheck 0; `bun run test` prints `all 58 suites passed` (unchanged); build 0.

- [ ] **Commit** (`server/dist/`, `cli/dist/`, `transcriber/dist/` are build byproducts — add a `dist/` ignore if not already ignored; do **not** commit binaries):
  ```bash
  git add server/src/main.ts server/package.json cli/package.json \
    transcriber/package.json transcriber/src/transcriber.ts
  git commit -m "$(cat <<'EOF'
  feat(build): ensembleworks-server dispatcher + per-workspace build:binary + transcriber --check (slice #7)

  server/src/main.ts is the single ensembleworks-server compile entry: a 5-line
  process.argv[2] -> sync|term dispatcher using literal-specifier dynamic import()
  so bun embeds BOTH entrypoints but only the selected one's top-level (server.listen)
  evaluates. sync-server.ts / terminal-gateway.ts bodies are untouched. server, cli
  and transcriber each get a --target-parameterised build:binary (EW_TARGET, default
  the host) for the CI matrix. transcriber gains a --check flag: the rtc-node addon
  links + config parses -> exit 0, the hermetic per-arch boot-check a fetched binary
  can be gated on. Compiles + boots green for sync/term/--check; 58 suites unchanged.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — `deploy/lib.sh` fetch/boot/era/prune functions + `deploy/posture-era`

Add the shell-native (no-JS-runtime) helpers `deploy.sh`, `--dry-run`, and `fake-release.sh` all share, plus the committed era marker. **RUNNABLE gate:** source lib.sh and unit-test each function in isolation against Task 1's binaries + a throwaway tree; `shellcheck` the file.

### Step 1 — `deploy/posture-era` (the committed era token)

- [ ] **Create `deploy/posture-era`** — a single line, no trailing narration:
  ```
  unified-1
  ```
  (spec D7/§9: the post-cutover era token. Absent `.ew-era` in a release dir reads as the implicit `legacy` era.)

### Step 2 — Append the functions to `deploy/lib.sh`

- [ ] **`deploy/lib.sh`** — append after the existing `check_constraint` function (keep the file's TAB indentation; these are sourced on the box AND locally by `--dry-run`/`fake-release.sh`). The header note "Pure functions only … Do not run system commands here" applies to the preflight helpers above; add a second banner for the release helpers, which DO shell out but remain side-effect-scoped to their argument dirs:
  ```bash

  # ---- release fetch / boot-check / era-gate / prune ---------------------------
  # Sourced on the box (as /tmp/ew-lib.sh) AND locally by deploy.sh --dry-run and
  # deploy/test/fake-release.sh. Prod hosts carry NO JS runtime (the point of
  # artifact deploys), so every helper here is shell-native (ss/iproute2 + curl +
  # coreutils, present on the glibc boxes). Each takes an optional trailing "run"
  # launcher prefix: "" = the current user (local/tests), "sudo -u ensembleworks"
  # on the box. All effects are confined to the directories passed in.

  # ew_fetch_release <version> <dest-dir> <repo-slug> [run]
  # Populate <dest-dir> with the tag's release assets, verify checksums, re-home the
  # per-arch binaries to their generic names, and extract client-dist alongside.
  # Honors DEPLOY_FETCH_DIR (a local dir of assets) so --dry-run / fake-release.sh
  # run with no `gh` and no network.
  ew_fetch_release() {
  	local ver="$1" dest="$2" slug="$3" run="${4:-}" arch a
  	$run mkdir -p "$dest"
  	if [ -n "${DEPLOY_FETCH_DIR:-}" ]; then
  		$run cp "$DEPLOY_FETCH_DIR"/ensembleworks-* "$DEPLOY_FETCH_DIR"/client-dist.tar.gz "$dest"/
  	else
  		$run gh release download "v${ver}" -R "$slug" -D "$dest" --clobber \
  			-p 'ensembleworks-*' -p 'client-dist.tar.gz' -p 'ensembleworks-checksums.txt'
  	fi
  	$run bash -c "cd '$dest' && sha256sum -c ensembleworks-checksums.txt --ignore-missing"
  	arch="$($run uname -m)"
  	case "$arch" in
  	x86_64) a=linux-x64 ;;
  	aarch64) a=linux-arm64 ;;
  	*) echo "ew_fetch_release: unsupported arch '$arch'" >&2; return 1 ;;
  	esac
  	$run mv "$dest/ensembleworks-server-$a" "$dest/ensembleworks-server"
  	$run mv "$dest/ensembleworks-transcriber-$a" "$dest/ensembleworks-transcriber"
  	$run mv "$dest/ensembleworks-$a" "$dest/ensembleworks"
  	$run chmod +x "$dest"/ensembleworks*
  	$run mkdir -p "$dest/client-dist"
  	$run tar xzf "$dest/client-dist.tar.gz" -C "$dest/client-dist"
  }

  # ew_free_port -> the first high port with no listener (fail-closed if none free).
  ew_free_port() {
  	local p
  	for p in $(seq 8790 8890); do
  		ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || { echo "$p"; return 0; }
  	done
  	echo 8798 # exhausted: the bind then loses -> ew_poll_health fails closed
  }

  # ew_poll_health <url> <pid> -> 0 iff <url> goes 200 before <pid> dies / times out.
  ew_poll_health() {
  	local url="$1" pid="$2" code=000 _
  	for _ in $(seq 1 40); do
  		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
  		[ "$code" = 200 ] && return 0
  		kill -0 "$pid" 2>/dev/null || return 1
  		sleep 0.25
  	done
  	return 1
  }

  # ew_boot_check <release-dir> [run] -> 0 iff the fetched server (sync + term) and
  # transcriber (--check) all boot on scratch dirs/ephemeral ports. Hermetic: fresh
  # DATA_DIR/CLIENT_DIST, no TERM_RUN_AS, no room.connect(). Fail-closed.
  ew_boot_check() {
  	local NEW="$1" run="${2:-}" ddir cdir port pid ok=1
  	ddir="$($run mktemp -d)"; cdir="$($run mktemp -d)"
  	# --- server sync: /api/health -> 200 ---
  	port="$(ew_free_port)"
  	$run env PORT="$port" DATA_DIR="$ddir" CLIENT_DIST="$cdir" \
  		"${NEW}/ensembleworks-server" sync >/tmp/ew-bootcheck-sync.log 2>&1 & pid=$!
  	ew_poll_health "http://127.0.0.1:$port/api/health" "$pid" || { echo "boot-check FAILED: server sync" >&2; ok=0; }
  	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  	# --- server term: /api/terminal/health -> 200 (NO TERM_RUN_AS -> no tmux spawn) ---
  	port="$(ew_free_port)"
  	$run env PORT="$port" "${NEW}/ensembleworks-server" term >/tmp/ew-bootcheck-term.log 2>&1 & pid=$!
  	ew_poll_health "http://127.0.0.1:$port/api/terminal/health" "$pid" || { echo "boot-check FAILED: server term" >&2; ok=0; }
  	kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  	# --- transcriber: addon links + config parses (arch integrity), exit 0 ---
  	$run timeout 15 "${NEW}/ensembleworks-transcriber" --check >/tmp/ew-bootcheck-scribe.log 2>&1 \
  		|| { echo "boot-check FAILED: transcriber --check nonzero" >&2; ok=0; }
  	$run rm -rf "$ddir" "$cdir"
  	[ "$ok" = 1 ]
  }

  # ew_era_gate <new-era-file> <live-current-symlink> [run] -> 0 = allow the swap,
  # 1 = refuse (a real mismatch between two PRESENT eras, no EW_ALLOW_ERA_CROSS=1).
  # A fresh box (no `current`) is not a crossing -> allowed (spec §9).
  ew_era_gate() {
  	local new_era_file="$1" live_link="$2" run="${3:-}" new_era live_target live_era
  	new_era="$($run cat "$new_era_file" 2>/dev/null || echo legacy)"
  	live_target="$($run readlink -f "$live_link" 2>/dev/null || true)"
  	[ -z "$live_target" ] && return 0 # first deploy — era gate not applicable
  	live_era="$($run cat "${live_target}/.ew-era" 2>/dev/null || echo legacy)"
  	[ "$new_era" = "$live_era" ] && return 0 # within an era — rollback/redeploy allowed
  	[ "${EW_ALLOW_ERA_CROSS:-0}" = 1 ] && return 0 # the one sanctioned crossing (cutover.sh)
  	return 1
  }

  # ew_prune_releases <releases-dir> <keep> <live-dir> [run]
  # Remove all but the <keep> newest release dirs, never the live one. Walks
  # <releases-dir> ONLY — ~/backups/pre-cutover-* is structurally exempt (spec D8).
  ew_prune_releases() {
  	local rel="$1" keep="$2" live="$3" run="${4:-}"
  	# shellcheck disable=SC2012
  	$run bash -c '
  		rel="$1"; keep="$2"; live="$3"
  		ls -1dt "$rel"/*/ 2>/dev/null | tail -n +$((keep + 1)) | while read -r d; do
  			d="${d%/}"; [ "$d" = "$live" ] && continue; rm -rf "$d"
  		done
  	' _ "$rel" "$keep" "$live"
  }
  ```

### Step 3 — RUNNABLE gate: `shellcheck` + isolated function unit-tests

- [ ] **`shellcheck` the file:**
  ```bash
  nix run nixpkgs#shellcheck -- deploy/lib.sh && bash -n deploy/lib.sh && echo "lib.sh clean"
  ```
  Expected: no findings; `lib.sh clean`.

- [ ] **Unit-test the functions in isolation** (uses Task 1's binaries; run from repo root after Task 1 compiled them):
  ```bash
  set -e
  . deploy/lib.sh
  # ew_free_port returns an integer with no listener on it:
  p="$(ew_free_port)"; ss -ltnH "sport = :$p" | grep -q . && echo "FAIL: $p busy" || echo "ok: ew_free_port -> $p"
  # ew_boot_check against a fetched-shaped dir (reuse Task 1 binaries under generic names):
  d="$(mktemp -d)/0.0.0"; mkdir -p "$d/client-dist"
  cp server/dist/ensembleworks-server transcriber/dist/ensembleworks-transcriber "$d/"
  ew_boot_check "$d" "" && echo "ok: ew_boot_check pass"
  # ew_era_gate: fresh (no current) allowed; same-era allowed; cross-era blocked; override unblocks:
  root="$(mktemp -d)"; echo unified-1 > "$d/.ew-era"
  ew_era_gate "$d/.ew-era" "$root/current" "" && echo "ok: fresh allowed"
  ln -sfn "$d" "$root/current"; ew_era_gate "$d/.ew-era" "$root/current" "" && echo "ok: same-era allowed"
  legacy="$(mktemp -d)"; ln -sfn "$legacy" "$root/current"  # legacy dir has no .ew-era
  ew_era_gate "$d/.ew-era" "$root/current" "" && echo "FAIL: cross not blocked" || echo "ok: cross-era blocked"
  EW_ALLOW_ERA_CROSS=1 ew_era_gate "$d/.ew-era" "$root/current" "" && echo "ok: override unblocks"
  # ew_prune_releases: keep 1 of 3, backups untouched:
  rel="$(mktemp -d)"; mkdir -p "$rel"/a "$rel"/b "$rel"/c "$(dirname "$rel")/backups/pre-cutover-x"
  touch -d '3 days ago' "$rel"/a; touch -d '2 days ago' "$rel"/b; touch -d '1 day ago' "$rel"/c
  ew_prune_releases "$rel" 1 "$rel/c" ""
  ls "$rel"; [ -d "$rel/c" ] && [ ! -d "$rel/a" ] && echo "ok: prune kept newest" || echo "FAIL: prune"
  ```
  Expected: every line prints `ok:` (no `FAIL`).

- [ ] **Commit:**
  ```bash
  git add deploy/lib.sh deploy/posture-era
  git commit -m "$(cat <<'EOF'
  feat(deploy): lib.sh release fetch/boot-check/era-gate/prune helpers + posture-era (slice #7)

  Shell-native (ss/curl/coreutils, no JS runtime) helpers sourced by deploy.sh on the
  box AND locally by --dry-run / fake-release.sh: ew_fetch_release (gh download or a
  local DEPLOY_FETCH_DIR, checksum-verify, per-arch re-home, client-dist extract),
  ew_free_port / ew_poll_health, ew_boot_check (fetched server sync+term + transcriber
  --check, hermetic + fail-closed), ew_era_gate (fresh/same-era allow, cross-era refuse
  unless EW_ALLOW_ERA_CROSS=1), ew_prune_releases (releases/ only — backups/ exempt).
  deploy/posture-era holds the `unified-1` token stamped into each release as .ew-era.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — `deploy/install.sh` (remote-box CLI bootstrap asset)

The committed asset the design §6.5 one-liner curls: arch-detect, checksum-verify, `~/.local/bin` install + the `ew` hardlink. **Gate class:** `shellcheck` + `bash -n` + a host arch-detect self-run are runnable; the real curl-a-release path is inspection-only (needs a published release with assets).

- [ ] **Create `deploy/install.sh`** (spec §5, verbatim; TAB-indented; `chmod +x` after writing):
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  REPO="lean-software-production/ensembleworks"
  VER="${ENSEMBLEWORKS_VERSION:-latest}"
  case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) A=linux-x64 ;;
  Linux-aarch64) A=linux-arm64 ;;
  Darwin-arm64) A=darwin-arm64 ;;
  *) echo "unsupported platform $(uname -sm)" >&2; exit 1 ;;
  esac
  base="https://github.com/$REPO/releases/latest/download"
  [ "$VER" = latest ] || base="https://github.com/$REPO/releases/download/v$VER"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/ensembleworks-$A" -o "$tmp/ew"
  curl -fsSL "$base/ensembleworks-checksums.txt" -o "$tmp/sums"
  (cd "$tmp" && grep " ensembleworks-$A\$" sums | sed "s/ensembleworks-$A/ew/" | sha256sum -c -)
  install -D -m0755 "$tmp/ew" "$HOME/.local/bin/ensembleworks"
  ln -f "$HOME/.local/bin/ensembleworks" "$HOME/.local/bin/ew"
  echo "installed ensembleworks ($A) -> ~/.local/bin (ew hardlink). Next: ensembleworks auth login"
  ```
  (Note: the spec's one-liner `base=` used a `${VER/latest/…}` substitution then unconditionally overrode it; this equivalent form resolves `latest` directly and is `shellcheck`-clean. Behaviour is identical: `latest` → `releases/latest/download`, a pinned `v$VER` → `releases/download/v$VER`.)

- [ ] **`chmod +x deploy/install.sh`.**

- [ ] **RUNNABLE part of the gate:**
  ```bash
  nix run nixpkgs#shellcheck -- deploy/install.sh && bash -n deploy/install.sh && echo "install.sh clean"
  # arch-detect self-run (asserts the case arm resolves for this host; then stop before curl):
  bash -c 'case "$(uname -s)-$(uname -m)" in Linux-x86_64) echo "A=linux-x64 ok";; Linux-aarch64) echo linux-arm64;; Darwin-arm64) echo darwin-arm64;; *) echo FAIL; exit 1;; esac'
  ```
  Expected: `install.sh clean`; `A=linux-x64 ok`.
- [ ] **Inspection-only note:** the curl/checksum/install path cannot be exercised without a published release carrying `ensembleworks-<arch>` + `ensembleworks-checksums.txt` — it is proven end-to-end only by a real CI release (Task 7) or manually post-cutover. State this in the task's completion report.

- [ ] **Commit:**
  ```bash
  git add deploy/install.sh
  git commit -m "$(cat <<'EOF'
  feat(deploy): install.sh — remote-box CLI bootstrap asset (slice #7)

  The committed asset design §6.5's one-liner curls: arch-detect (linux-x64/arm64,
  darwin-arm64), ENSEMBLEWORKS_VERSION pin (default latest), checksum-verify against
  ensembleworks-checksums.txt, install to ~/.local/bin/ensembleworks + the `ew`
  hardlink. CLI-only (a box that connects a terminal needs only the CLI). shellcheck
  clean; arch-detect self-runs green. Uploaded verbatim by release-cli.yml (Task 7).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — `deploy/deploy.sh` rewrite (fetch → verify → swap)

Rewrite the release stage from build-on-box (worktree + `npm ci` + `npm run build`) to fetch-verify-swap, add the pre-swap boot-check + era stamp + era gate, re-home every worktree-sourced file the artifact layout no longer carries, grow the scp manifest, and add a local `--dry-run`. The preflight / sandbox-seed / Caddy / `current`-swap / prune / readiness-poll skeleton is preserved. **RUNNABLE gate:** `shellcheck` + `bash -n` + a real `--dry-run` against a locally-built release dir.

### Step 1 — Replace `deploy/deploy.sh` in full

- [ ] **Overwrite `deploy/deploy.sh`** with the complete rewrite below (TAB-indented). It is the existing script with: (a) a new header + flags; (b) a `--dry-run` local branch; (c) `REPO_SLUG` + `BUILD_FROM_SOURCE` vars; (d) the scp file-check list grown per spec §6.4; (e) the worktree/build block replaced by `ew_fetch_release` (or a `build_from_source` escape hatch); (f) boot-check + era stamp; (g) the sandbox-seed sources re-homed from `${NEW}/…` to the scp'd `/tmp/ew-…` paths and the CLI install re-pointed to the `ensembleworks` artifact; (h) the era gate before the swap; (i) prune via `ew_prune_releases`; (j) the two `${CANVAS_URL}`-is-literal comments refreshed to `${ENSEMBLEWORKS_URL}`.
  ```bash
  #!/usr/bin/env bash
  # Install/update EnsembleWorks to a tagged version on a server (fetch-verify-swap).
  #
  #   deploy/deploy.sh <ssh-target> <version> [--dry-run]
  #   e.g. deploy/deploy.sh mrdavidlaing@ew-donkeyred-001-tailnet 0.11.0
  #
  # Downloads the tag's CI-compiled binaries (ensembleworks, ensembleworks-server,
  # ensembleworks-transcriber) + client-dist.tar.gz from the GitHub release into
  # ~APP_USER/releases/<version>, verifies checksums, runs a hermetic pre-swap
  # boot-check of the fetched server + transcriber, stamps the posture-era marker,
  # installs prod units + Caddyfile, swaps the `current` symlink, restarts, and
  # prunes to KEEP releases. Rollback = re-run with an older version (its fetched
  # dir is still present -> instant symlink swap) — WITHIN a posture era.
  #
  # Flags / env:
  #   --dry-run             local verify half only (no box): fetch to a scratch dir,
  #                         checksum, ew_boot_check, print the swap plan. No ssh/swap.
  #   BUILD_FROM_SOURCE=1   escape hatch: build the artifacts from source at TAG on the
  #                         box instead of fetching (unpushed branch / offline; needs bun).
  #   DEPLOY_FETCH_DIR=dir  read release assets from a local dir instead of gh (tests/dry-run).
  #   EW_ALLOW_ERA_CROSS=1  permit the one sanctioned cross-era swap (cutover.sh sets it).
  set -euo pipefail
  cd "$(git rev-parse --show-toplevel)"

  SSH_TARGET="${1:?usage: deploy.sh <ssh-target> <version> [--dry-run]}"
  VERSION="${2:?usage: deploy.sh <ssh-target> <version> [--dry-run]}"
  VERSION="${VERSION#v}" # accept 0.2.0 or v0.2.0
  TAG="v${VERSION}"
  DRY_RUN=0; [ "${3:-}" = "--dry-run" ] && DRY_RUN=1
  APP_USER="${APP_USER:-ensembleworks}"
  REPO_URL="${REPO_URL:-https://github.com/lean-software-production/ensembleworks.git}"
  REPO_SLUG="${REPO_SLUG:-lean-software-production/ensembleworks}"
  KEEP="${KEEP:-3}"
  EDGE_PORT="8080"
  SHARED_BROWSER="${SHARED_BROWSER:-0}"
  BUILD_FROM_SOURCE="${BUILD_FROM_SOURCE:-0}"
  AGENT_USER="${AGENT_USER:-ensembleworks-agent}"

  # ---- --dry-run: the local verify half (no box, no licence key — spec §10.2) ---
  # Sources lib.sh, fetches into a scratch release dir, verifies checksums, runs the
  # real ew_boot_check against the fetched server + transcriber (launcher prefix "" =
  # current user, no sudo), stamps .ew-era, prints the resolved swap plan, exits.
  # Never scps, sshs, swaps, or restarts. Does NOT validate the client bundle — no
  # tldraw licence key exists off-CI (spec §4.3), so client-dist is machinery-only.
  if [ "$DRY_RUN" = 1 ]; then
  	. deploy/lib.sh
  	scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
  	NEW="${scratch}/${VERSION}"
  	echo "==> [dry-run] fetching v${VERSION} into ${NEW}"
  	ew_fetch_release "${VERSION}" "${NEW}" "${REPO_SLUG}" ""
  	cp deploy/posture-era "${NEW}/.ew-era"
  	echo "==> [dry-run] boot-check"
  	ew_boot_check "${NEW}" "" && echo "    boot-check OK" || { echo "    boot-check FAILED" >&2; exit 1; }
  	echo "==> [dry-run] swap plan:"
  	echo "    release dir : ~${APP_USER}/releases/${VERSION}"
  	echo "    new era     : $(cat "${NEW}/.ew-era")"
  	echo "    units       : ensembleworks-sync ensembleworks-term (+ scribe if enabled)"
  	echo "    keep        : ${KEEP} newest (prune walks releases/ only; backups/ exempt)"
  	echo "==> [dry-run] done (no box touched)."
  	exit 0
  fi

  # Ship the requirements manifest + lib + the re-homed support files to the box.
  REQ_FILE="deploy/runtime-requirements"
  LIB_FILE="deploy/lib.sh"
  CADDY_PROD="deploy/Caddyfile.prod"
  PROD_UNITS="deploy/systemd/prod" # committed unit templates (@APP_USER@/@APP_HOME@)
  for f in "$REQ_FILE" "$LIB_FILE" "$CADDY_PROD" \
  	"$PROD_UNITS"/ensembleworks-sync.service \
  	"$PROD_UNITS"/ensembleworks-term.service \
  	"$PROD_UNITS"/ensembleworks-scribe.service \
  	"$PROD_UNITS"/ensembleworks-shared-browser.service \
  	"$PROD_UNITS"/ensembleworks-shared-browser.slice \
  	deploy/posture-era \
  	deploy/tmux-ensembleworks.conf \
  	deploy/ensembleworks-gh-token \
  	bin/gh-app-token.bash \
  	deploy/agent-home/AGENTS.md \
  	deploy/agent-home/.claude/CLAUDE.md \
  	deploy/agent-home/term.env.example \
  	deploy/agent-home/term-env.bashrc \
  	deploy/agent-home/gh-helper.bashrc; do
  	[ -f "$f" ] || {
  		echo "missing $f — run from the repo root" >&2
  		exit 1
  	}
  done

  echo "==> deploying ${TAG} to ${SSH_TARGET} (app user: ${APP_USER})"

  # The remote script. Variables are expanded locally where marked (heredoc without
  # quotes); $-on-box vars are escaped as \$.
  REMOTE="$(
  	cat <<REMOTE_EOF
  set -euo pipefail
  APP_USER='${APP_USER}'
  VERSION='${VERSION}'
  TAG='${TAG}'
  REPO_URL='${REPO_URL}'
  REPO_SLUG='${REPO_SLUG}'
  KEEP='${KEEP}'
  EDGE_PORT='${EDGE_PORT}'
  SHARED_BROWSER='${SHARED_BROWSER}'
  BUILD_FROM_SOURCE='${BUILD_FROM_SOURCE}'
  AGENT_USER='${AGENT_USER}'
  APP_HOME="\$(getent passwd "\${APP_USER}" | cut -d: -f6)"
  SRC="\${APP_HOME}/src"
  RELEASES="\${APP_HOME}/releases"
  NEW="\${RELEASES}/\${VERSION}"
  RUN="sudo -u \${APP_USER}"
  asapp() { sudo -u "\${APP_USER}" "\$@"; }

  # ---- preflight: validate host deps against the shipped manifest --------------
  . /tmp/ew-lib.sh
  echo "==> preflight"
  problems=""
  while read -r name constraint required probe; do
    case "\$name" in ''|\#*) continue;; esac
    found="\$(extract_version "\$(eval "\$probe" 2>/dev/null || true)")"
    if ! msg="\$(check_constraint "\$name" "\$constraint" "\$required" "\$found")"; then
      problems="\${problems}  - \${msg}
  "
    fi
  done < /tmp/ew-runtime-requirements
  if [ -n "\$problems" ]; then
    echo "PREFLIGHT FAILED — host is behind. Re-run the laingville servers/<host>/bootstrap.sh for ${SSH_TARGET}:" >&2
    printf '%s' "\$problems" >&2
    exit 1
  fi
  id -u "\${APP_USER}" >/dev/null 2>&1 || { echo "app user \${APP_USER} missing" >&2; exit 1; }
  systemctl cat ensembleworks.slice >/dev/null 2>&1 || { echo "ensembleworks.slice missing (host envelope) — run bootstrap.sh" >&2; exit 1; }
  id -u "\${AGENT_USER}" >/dev/null 2>&1 || { echo "sandbox user \${AGENT_USER} missing — run the laingville bootstrap (terminals run as it; TERM_RUN_AS is set in the prod term unit)" >&2; exit 1; }
  test -x /usr/local/bin/ensembleworks-term-launch || { echo "/usr/local/bin/ensembleworks-term-launch missing/not executable — host-provisioned by the laingville bootstrap" >&2; exit 1; }
  sudo -u "\${APP_USER}" sudo -n -u "\${AGENT_USER}" true 2>/dev/null || { echo "sudo grant missing: \${APP_USER} -> \${AGENT_USER} (NOPASSWD ensembleworks-term-launch + /usr/bin/true) — run the laingville bootstrap" >&2; exit 1; }
  sudo test -f "\${APP_HOME}/.config/ensembleworks/github-app.env" 2>/dev/null || echo "    note: \${APP_HOME}/.config/ensembleworks/github-app.env absent — GitHub token minting not provisioned (optional; deploy/github-app-runbook.md)" >&2
  echo "    preflight ok"

  # ---- fetch (or build-from-source) the tag's artifacts into \${NEW} -----------
  # Was: git worktree + npm ci + npm run build. Now: gh release download + checksum
  # verify + client-dist extract (ew_fetch_release). .ew-verified marks a release dir
  # that already passed fetch+boot-check, so a rollback re-swap skips re-fetching.
  PREV="\$(asapp readlink -f "\${APP_HOME}/current" 2>/dev/null || true)"
  if asapp test -f "\${NEW}/.ew-verified"; then
    echo "==> \${VERSION} already fetched+verified — swapping (rollback path)"
  else
    if [ "\${BUILD_FROM_SOURCE}" = 1 ]; then
      echo "==> BUILD_FROM_SOURCE=1 — building artifacts at \${TAG} on the box (needs bun)"
      command -v bun >/dev/null 2>&1 || { echo "bun not on PATH — BUILD_FROM_SOURCE needs it" >&2; exit 1; }
      asapp test -d "\${SRC}/.git" || asapp git clone "\${REPO_URL}" "\${SRC}"
      asapp git -C "\${SRC}" fetch --tags --prune origin
      asapp git -C "\${SRC}" rev-parse "\${TAG}" >/dev/null 2>&1 || { echo "tag \${TAG} not found" >&2; exit 1; }
      asapp mkdir -p "\${NEW}/client-dist"
      TMPB="\$(asapp mktemp -d)"
      asapp bash -c "cd '\${SRC}' && git archive '\${TAG}' | tar -x -C '\${TMPB}'"
      A="\$(uname -m | sed 's/x86_64/linux-x64/;s/aarch64/linux-arm64/')"
      asapp env PATH="/usr/local/bin:\${PATH}" EW_TARGET="bun-\${A}" bash -c "cd '\${TMPB}' && bun install --frozen-lockfile \
        && bun --cwd server run build:binary && bun --cwd cli run build:binary && bun --cwd transcriber run build:binary \
        && bun run --filter @ensembleworks/client build"
      asapp cp "\${TMPB}/server/dist/ensembleworks-server" "\${NEW}/ensembleworks-server"
      asapp cp "\${TMPB}/cli/dist/ensembleworks" "\${NEW}/ensembleworks"
      asapp cp "\${TMPB}/transcriber/dist/ensembleworks-transcriber" "\${NEW}/ensembleworks-transcriber"
      asapp chmod +x "\${NEW}"/ensembleworks*
      asapp cp -a "\${TMPB}/client/dist/." "\${NEW}/client-dist/"
      asapp rm -rf "\${TMPB}"
    else
      echo "==> fetching v\${VERSION} artifacts"
      ew_fetch_release "\${VERSION}" "\${NEW}" "\${REPO_SLUG}" "\${RUN}"
    fi
    # stamp the posture-era marker BEFORE the swap (spec §6.2/§9).
    asapp cp /tmp/ew-posture-era "\${NEW}/.ew-era"
    # ---- pre-swap boot-check (spec §6.3) — refuse the swap if it fails ----------
    echo "==> boot-check v\${VERSION}"
    if ! ew_boot_check "\${NEW}" "\${RUN}"; then
      echo "==> refusing to swap: boot-check failed on v\${VERSION}" >&2; exit 1
    fi
    asapp touch "\${NEW}/.ew-verified"
  fi

  # ---- install prod systemd units -----------------------------------------------
  # Units are committed templates in deploy/systemd/prod/ (scp'd to /tmp); sed fills
  # in @APP_USER@ / @APP_HOME@. \${ENSEMBLEWORKS_URL} in the scribe unit stays literal
  # for systemd to expand — sed only touches @TOKENS@.
  echo "==> installing prod systemd units"
  sudo rm -rf /etc/systemd/system/ensembleworks-sync.service.d /etc/systemd/system/ensembleworks-term.service.d /etc/systemd/system/ensembleworks-scribe.service.d
  for u in ensembleworks-sync ensembleworks-term ensembleworks-scribe; do
    sed -e "s|@APP_USER@|\${APP_USER}|g" -e "s|@APP_HOME@|\${APP_HOME}|g" "/tmp/\${u}.service" | sudo tee "/etc/systemd/system/\${u}.service" >/dev/null
  done

  # ---- install the OPTIONAL shared browser (neko) ------------------------------
  SHARED_BROWSER_INSTALLED=0
  if [ "\$SHARED_BROWSER" = 1 ]; then
    if ! command -v docker >/dev/null 2>&1; then
      echo "    SHARED_BROWSER=1 but docker is missing — skipping (provision it via the laingville bootstrap)" >&2
    elif ! asapp test -f "\${APP_HOME}/.config/ensembleworks/shared-browser.env"; then
      echo "    SHARED_BROWSER=1 but \${APP_HOME}/.config/ensembleworks/shared-browser.env is missing — skipping (copy deploy/shared-browser.env.example there)" >&2
    else
      echo "==> installing shared-browser unit + slice"
      sudo install -m0644 /tmp/ensembleworks-shared-browser.slice /etc/systemd/system/ensembleworks-shared-browser.slice
      sed -e "s|@APP_HOME@|\${APP_HOME}|g" /tmp/ensembleworks-shared-browser.service | sudo tee /etc/systemd/system/ensembleworks-shared-browser.service >/dev/null
      SHARED_BROWSER_INSTALLED=1
    fi
  fi

  # ---- seed the terminal sandbox user ------------------------------------------
  # The artifact release dir carries NO worktree, so every file the old deploy.sh
  # installed from \${NEW}/bin or \${NEW}/deploy is re-homed: the canvas CLI is now the
  # ensembleworks ARTIFACT in \${NEW}; the rest ride from this operator checkout as
  # /tmp/ew-* (scp'd below). Install targets/modes/owners + marker-gated appends are
  # unchanged (spec §6.4). Generated docs, so overwrite on every deploy.
  if id -u "\${AGENT_USER}" >/dev/null 2>&1; then
    echo "==> seeding \${AGENT_USER} sandbox (ensembleworks CLI + agent guidance)"
    AGENT_HOME="\$(getent passwd "\${AGENT_USER}" | cut -d: -f6)"
    sudo install -m0755 "\${NEW}/ensembleworks" /usr/local/bin/ensembleworks
    sudo ln -f /usr/local/bin/ensembleworks /usr/local/bin/ew
    sudo -u "\${AGENT_USER}" /usr/local/bin/ensembleworks version >/dev/null 2>&1 || \
      echo "    warn: installed CLI failed 'version' self-check" >&2
    sudo install -m0755 /tmp/ew-gh-app-token.bash /usr/local/bin/gh-app-token.bash
    sudo install -m0755 /tmp/ew-ensembleworks-gh-token /usr/local/bin/ensembleworks-gh-token
    sudo install -D -m0644 /tmp/ew-tmux.conf /etc/ensembleworks/tmux.conf
    if [ -d /tmp/ew-agent-home ]; then
      sudo install -d -o "\${AGENT_USER}" -m0755 "\${AGENT_HOME}/.claude"
      sudo install -o "\${AGENT_USER}" -m0644 /tmp/ew-agent-home/AGENTS.md "\${AGENT_HOME}/AGENTS.md"
      sudo install -o "\${AGENT_USER}" -m0644 /tmp/ew-agent-home/.claude/CLAUDE.md "\${AGENT_HOME}/.claude/CLAUDE.md"
    fi
    if ! sudo -u "\${AGENT_USER}" test -f "\${AGENT_HOME}/.config/ensembleworks/term.env"; then
      sudo install -d -o "\${AGENT_USER}" -m0700 "\${AGENT_HOME}/.config" "\${AGENT_HOME}/.config/ensembleworks"
      sudo install -o "\${AGENT_USER}" -m0600 /tmp/ew-agent-home/term.env.example "\${AGENT_HOME}/.config/ensembleworks/term.env"
      echo "    seeded \${AGENT_HOME}/.config/ensembleworks/term.env (fill in OPENCODE_API_KEY)"
    fi
    if ! sudo -u "\${AGENT_USER}" grep -q __ew_term_env_file "\${AGENT_HOME}/.bashrc" 2>/dev/null; then
      sudo cat /tmp/ew-agent-home/term-env.bashrc | sudo -u "\${AGENT_USER}" tee -a "\${AGENT_HOME}/.bashrc" >/dev/null
    fi
    if ! sudo -u "\${AGENT_USER}" grep -q __ew_gh_helper "\${AGENT_HOME}/.bashrc" 2>/dev/null; then
      sudo cat /tmp/ew-agent-home/gh-helper.bashrc | sudo -u "\${AGENT_USER}" tee -a "\${AGENT_HOME}/.bashrc" >/dev/null
    fi
  else
    echo "    sandbox user \${AGENT_USER} not present — skipping CLI + agent-home seed"
    echo "    (provision it via the laingville bootstrap; the term gateway fails closed until then)" >&2
  fi

  # ---- install prod Caddyfile --------------------------------------------------
  sudo install -m0644 /tmp/ew-Caddyfile.prod /etc/caddy/Caddyfile

  # ---- era gate + swap current -> new, reload ----------------------------------
  # Refuse a swap that would cross the Phase-3 posture-era boundary (spec §9). A
  # fresh box (no current) is not a crossing; the one sanctioned forward crossing is
  # cutover.sh (EW_ALLOW_ERA_CROSS=1).
  if ! ew_era_gate "\${NEW}/.ew-era" "\${APP_HOME}/current" "\${RUN}"; then
    live_target="\$(asapp readlink -f "\${APP_HOME}/current" 2>/dev/null || true)"
    live_era="\$(asapp cat "\${live_target}/.ew-era" 2>/dev/null || echo legacy)"
    new_era="\$(asapp cat "\${NEW}/.ew-era" 2>/dev/null || echo legacy)"
    echo "REFUSING era-crossing swap: live='\${live_era}' new='\${new_era}'." >&2
    echo "  Rollback across the Phase-3 boundary is unsupported (keel 3)." >&2
    echo "  The one-time forward crossing is deploy/cutover.sh (sets EW_ALLOW_ERA_CROSS=1)." >&2
    exit 1
  fi
  echo "==> swapping current -> \${VERSION}"
  asapp ln -sfn "\${NEW}" "\${APP_HOME}/current"
  sudo systemctl daemon-reload
  sudo systemctl enable ensembleworks-sync ensembleworks-term >/dev/null 2>&1 || true
  sudo systemctl restart ensembleworks-sync ensembleworks-term
  sudo systemctl is-active --quiet ensembleworks-scribe && sudo systemctl restart ensembleworks-scribe || true
  if [ "\${SHARED_BROWSER_INSTALLED}" = 1 ]; then
    sudo systemctl enable ensembleworks-shared-browser >/dev/null 2>&1 || true
    sudo systemctl is-active --quiet ensembleworks-shared-browser || sudo systemctl start ensembleworks-shared-browser
  fi
  sudo systemctl reload-or-restart caddy

  # ---- prune old releases (keep newest \$KEEP, never the live one) -------------
  # Walks \${RELEASES} ONLY — ~/backups/pre-cutover-* is structurally exempt (spec D8).
  echo "==> pruning releases (keep \${KEEP})"
  ew_prune_releases "\${RELEASES}" "\${KEEP}" "\${NEW}" "\${RUN}"

  # ---- verify ------------------------------------------------------------------
  echo "==> deployed: v\${VERSION} (era \$(asapp cat "\${NEW}/.ew-era"))"
  code=000
  for _ in \$(seq 1 30); do
    code="\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:\${EDGE_PORT}/" || true)"
    [ "\$code" = "200" ] && break
    sleep 1
  done
  echo "==> edge http://localhost:\${EDGE_PORT}/ -> \${code}"
  [ "\$code" = "200" ] || echo "    (warning: edge not 200 after 30s — check 'systemctl status ensembleworks-sync')"
  REMOTE_EOF
  )"

  # Copy the small support files + the prod unit templates + the re-homed sandbox
  # sources, then run the remote script. The units land at /tmp/ensembleworks-*.service
  # (the remote sed loop reads /tmp/\${u}.service); \${ENSEMBLEWORKS_URL} inside the
  # scribe unit stays literal for systemd (committed file, no escaping).
  scp -q "$LIB_FILE" "${SSH_TARGET}:/tmp/ew-lib.sh"
  scp -q "$REQ_FILE" "${SSH_TARGET}:/tmp/ew-runtime-requirements"
  scp -q "$CADDY_PROD" "${SSH_TARGET}:/tmp/ew-Caddyfile.prod"
  scp -q "$PROD_UNITS"/*.service "${SSH_TARGET}:/tmp/"
  scp -q "$PROD_UNITS"/ensembleworks-shared-browser.slice "${SSH_TARGET}:/tmp/"
  scp -q deploy/posture-era "${SSH_TARGET}:/tmp/ew-posture-era"
  scp -q deploy/tmux-ensembleworks.conf "${SSH_TARGET}:/tmp/ew-tmux.conf"
  scp -q deploy/ensembleworks-gh-token "${SSH_TARGET}:/tmp/ew-ensembleworks-gh-token"
  scp -q bin/gh-app-token.bash "${SSH_TARGET}:/tmp/ew-gh-app-token.bash"
  scp -qr deploy/agent-home "${SSH_TARGET}:/tmp/ew-agent-home"
  ssh "$SSH_TARGET" "bash -s" <<<"$REMOTE"

  echo "==> done."
  ```

### Step 2 — RUNNABLE gate: `shellcheck` + `bash -n` + `--dry-run` against a local release dir

- [ ] **`shellcheck` + parse:**
  ```bash
  nix run nixpkgs#shellcheck -- deploy/deploy.sh && bash -n deploy/deploy.sh && echo "deploy.sh clean"
  ```
  Expected: no findings (the escaped-`\$` heredoc is understood by shellcheck); `deploy.sh clean`.

- [ ] **`--dry-run` against a locally-assembled release dir** (reuses Task 1's binaries; `DEPLOY_FETCH_DIR` bypasses `gh`):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  rel="$(mktemp -d)"
  cp server/dist/ensembleworks-server "$rel/ensembleworks-server-linux-x64"
  cp cli/dist/ensembleworks "$rel/ensembleworks-linux-x64"
  cp transcriber/dist/ensembleworks-transcriber "$rel/ensembleworks-transcriber-linux-x64"
  tar czf "$rel/client-dist.tar.gz" -C "$(mktemp -d)" .   # stub bundle (no licence — machinery only)
  (cd "$rel" && sha256sum ensembleworks-* client-dist.tar.gz > ensembleworks-checksums.txt)
  DEPLOY_FETCH_DIR="$rel" deploy/deploy.sh unused@nobox 0.0.0 --dry-run
  ```
  Expected: `==> [dry-run] fetching …`, `boot-check OK`, a printed swap plan, `==> [dry-run] done (no box touched).` — and **no** ssh/scp attempt (the `unused@nobox` target is never contacted). This exercises `ew_fetch_release` (local mode) + `ew_boot_check` for real.

- [ ] **Commit:**
  ```bash
  git add deploy/deploy.sh
  git commit -m "$(cat <<'EOF'
  feat(deploy): deploy.sh fetch-verify-swap rewrite + --dry-run + era gate (slice #7)

  Replaces build-on-box (worktree + npm ci + npm run build) with ew_fetch_release
  (gh release download / local DEPLOY_FETCH_DIR, checksum-verify, per-arch re-home,
  client-dist extract), a hermetic pre-swap ew_boot_check that refuses the swap on
  failure, a posture-era stamp + ew_era_gate that blocks a cross-era current swap
  (unless EW_ALLOW_ERA_CROSS=1), and ew_prune_releases (backups/ exempt). The artifact
  layout carries no worktree, so the sandbox seed is re-homed: the CLI is now the
  ensembleworks ARTIFACT (+ ew hardlink + version self-check), the rest ride from the
  operator checkout as scp'd /tmp/ew-*. --dry-run runs the verify half locally (fetch
  + boot-check + swap plan, no box). BUILD_FROM_SOURCE=1 keeps an offline escape hatch.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — The three systemd unit rewrites

Re-point `ExecStart` to the absolute binary paths, `WorkingDirectory` to the release root, `CLIENT_DIST`/`TMUX_CONF` to the artifact layout, and `CANVAS_*` → `ENSEMBLEWORKS_*` on scribe. **`KillMode=process` on the term unit and its comment block are preserved byte-for-byte.** Only `[Service]` lines change; `[Unit]`/`[Install]`, slice membership, `MemoryLow`, `Restart` are untouched (spec §7). **Gate class:** inspection-mostly — the runnable proxy is `systemd-analyze verify` on a rendered copy + grep asserts.

### Step 1 — `deploy/systemd/prod/ensembleworks-sync.service`

- [ ] **Edit** — three `[Service]` lines (spec §7.1):
  - `WorkingDirectory=@APP_HOME@/current/server` → `WorkingDirectory=@APP_HOME@/current`
  - `Environment=CLIENT_DIST=@APP_HOME@/current/client/dist` → `Environment=CLIENT_DIST=@APP_HOME@/current/client-dist`
  - `ExecStart=/usr/local/bin/npm run start` → `ExecStart=@APP_HOME@/current/ensembleworks-server sync`

  `PORT=8788`, `DATA_DIR=…`, `EnvironmentFile=…/sync.env`, `MemoryLow=512M`, `Slice`, `Restart` unchanged. Update the header comment's mention of "serves the static client build (CLIENT_DIST)" only if it references the old `client/dist` path (it does not — leave it).

### Step 2 — `deploy/systemd/prod/ensembleworks-term.service`

- [ ] **Edit** — three `[Service]` lines (spec §7.2):
  - `WorkingDirectory=@APP_HOME@/current/server` → `WorkingDirectory=@APP_HOME@/current`
  - `Environment=TMUX_CONF=@APP_HOME@/current/deploy/tmux-ensembleworks.conf` → `Environment=TMUX_CONF=/etc/ensembleworks/tmux.conf`
  - `ExecStart=/usr/local/bin/npm run start:term` → `ExecStart=@APP_HOME@/current/ensembleworks-server term`

  **`KillMode=process` stays verbatim.** Refresh only the one comment sentence about SIGTERM forwarding — replace:
  ```
  # KillMode=process signals only the gateway
  # (npm 10 forwards SIGTERM to node, freeing :8789); the tmux server survives and the
  ```
  with:
  ```
  # KillMode=process signals only the gateway
  # (systemd signals the single binary directly, freeing :8789); the tmux server survives and the
  ```
  (spec §7.2: `ExecStart` is now the single binary, so systemd signals it directly — no `npm`→`node` hop. `TERM_RUN_AS=ensembleworks-agent`, `PORT=8789`, the rest of the comment block, and every other line unchanged.)

### Step 3 — `deploy/systemd/prod/ensembleworks-scribe.service`

- [ ] **Edit** — the `CANVAS_*` → `ENSEMBLEWORKS_*` swap (spec §7.3):
  - `WorkingDirectory=@APP_HOME@/current/transcriber` → `WorkingDirectory=@APP_HOME@/current`
  - `Environment=CANVAS_URL=http://localhost:8788` → `Environment=ENSEMBLEWORKS_URL=http://localhost:8788`
  - `Environment=CANVAS_ROOM=team` → `Environment=ENSEMBLEWORKS_ROOM=team`
  - `ExecStartPre=/bin/sh -c 'until curl -s -o /dev/null --connect-timeout 2 "${CANVAS_URL}/"; do sleep 1; done'` → `…"${ENSEMBLEWORKS_URL}/"…`
  - `ExecStart=/usr/local/bin/npm run start` → `ExecStart=@APP_HOME@/current/ensembleworks-transcriber`
  - Header comment: `${CANVAS_URL}` is-literal note → `${ENSEMBLEWORKS_URL}`.

  `STT_*`, `EnvironmentFile=…/scribe.env`, `MemoryLow=256M`, `Restart` unchanged. (The transcriber code already reads `ENSEMBLEWORKS_URL`/`_ROOM`; the lingering `CANVAS_*` env was dead — this makes the unit match the code.)

### Step 4 — RUNNABLE proxy gate + inspection asserts

- [ ] **`systemd-analyze verify` on rendered copies** (substitute the `@TOKENS@`, then parse — warnings about the not-yet-present binary path are expected; a *syntax* error is not):
  ```bash
  tmp="$(mktemp -d)"
  for u in ensembleworks-sync ensembleworks-term ensembleworks-scribe; do
    sed -e 's|@APP_USER@|ensembleworks|g' -e 's|@APP_HOME@|/home/ensembleworks|g' \
      "deploy/systemd/prod/$u.service" > "$tmp/$u.service"
    systemd-analyze verify "$tmp/$u.service" 2>&1 | grep -v -E 'Executable path|command not found|does not exist|Failed to prepare' || true
    echo "$u: parsed"
  done
  ```
  Expected: each prints `<u>: parsed` with no *syntax/directive* errors (only the expected "executable path is not absolute/exists" advisories, which are filtered).

- [ ] **grep asserts (inspection, but mechanical):**
  ```bash
  grep -q '^KillMode=process$' deploy/systemd/prod/ensembleworks-term.service && echo "ok: KillMode preserved"
  grep -q 'ExecStart=@APP_HOME@/current/ensembleworks-server term' deploy/systemd/prod/ensembleworks-term.service && echo "ok: term ExecStart binary"
  grep -q 'ExecStart=@APP_HOME@/current/ensembleworks-server sync' deploy/systemd/prod/ensembleworks-sync.service && echo "ok: sync ExecStart binary"
  grep -q 'ENSEMBLEWORKS_URL=http://localhost:8788' deploy/systemd/prod/ensembleworks-scribe.service && echo "ok: scribe env renamed"
  ! grep -q 'CANVAS_' deploy/systemd/prod/ensembleworks-scribe.service && echo "ok: no CANVAS_* left in scribe"
  ! grep -q '/usr/local/bin/npm' deploy/systemd/prod/*.service && echo "ok: no npm ExecStart left"
  ```
  Expected: all six `ok:` lines.

- [ ] **Full green gate** (units are inert here, but keep the suite green for the branch):
  ```bash
  bun run typecheck && bun run test
  ```
  Expected: typecheck 0; 58 suites.

- [ ] **Commit:**
  ```bash
  git add deploy/systemd/prod/ensembleworks-sync.service deploy/systemd/prod/ensembleworks-term.service deploy/systemd/prod/ensembleworks-scribe.service
  git commit -m "$(cat <<'EOF'
  feat(deploy): repoint prod systemd units to the compiled binaries (slice #7)

  ExecStart -> the absolute ensembleworks-server sync|term / ensembleworks-transcriber
  artifacts; WorkingDirectory -> @APP_HOME@/current; sync CLIENT_DIST -> the extracted
  current/client-dist; term TMUX_CONF -> the box-wide /etc/ensembleworks/tmux.conf.
  scribe's dead CANVAS_URL/CANVAS_ROOM env (the binary already reads ENSEMBLEWORKS_*)
  is renamed to match the code, ExecStartPre polls ${ENSEMBLEWORKS_URL}. The term
  unit's KillMode=process (tmux survival) is byte-for-byte preserved — only the
  SIGTERM-forwarding comment updates (systemd now signals the single binary directly).
  systemd-analyze verify parses all three; no npm ExecStart remains.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 6 — `deploy/cutover.sh` + `cutover-dataload-check.sh` + `cutover-reseed.sh`

The one-time Phase-3 choreography as concrete, independently `shellcheck`-able scripts (spec §8). **Gate class:** `shellcheck` + `bash -n` all three are runnable; `cutover-reseed.sh` is runnable against a fake env dir; the ssh choreography and the on-box data-load check are inspection-only (need a box + real data).

### Step 1 — `deploy/cutover.sh`

- [ ] **Create `deploy/cutover.sh`** (spec §8, verbatim; TAB-indented; `chmod +x`):
  ```bash
  #!/usr/bin/env bash
  # deploy/cutover.sh <ssh-target> <version>
  # One-time Phase-3 cutover: prove production data loads under the new binaries,
  # back up DATA_DIR (era-exempt), reseed env + SKILL files, then cross the era
  # boundary via a normal deploy. Run ONCE; afterwards use deploy/deploy.sh.
  set -euo pipefail
  cd "$(git rev-parse --show-toplevel)"
  SSH_TARGET="${1:?usage: cutover.sh <ssh-target> <version>}"
  VERSION="${2:?usage: cutover.sh <ssh-target> <version>}"
  VERSION="${VERSION#v}"; TAG="v${VERSION}"

  # lib.sh rides to the box so the on-box helpers (ew_fetch_release / ew_free_port /
  # ew_poll_health) are available to the data-load check.
  scp -q deploy/lib.sh "${SSH_TARGET}:/tmp/ew-lib.sh"

  # 1. DATA-LOAD CHECK against production copies. Boot the fetched server binary
  #    against a COPY of the live DATA_DIR (not a scratch one) — every room must load
  #    (keel 1, spec §7.1). ABORT on any file the new world cannot read.
  ssh "$SSH_TARGET" 'bash -s' -- "$VERSION" < deploy/cutover-dataload-check.sh

  # 2. DATA_DIR BACKUP — outside ~/releases so KEEP never prunes it (spec D8, keel 3).
  ssh "$SSH_TARGET" "bash -s" <<'EOF'
  set -euo pipefail
  APP_HOME="$(getent passwd ensembleworks | cut -d: -f6)"
  ts="$(date +%Y%m%dT%H%M%S)"
  sudo -u ensembleworks mkdir -p "$APP_HOME/backups"
  sudo -u ensembleworks cp -a --reflink=auto \
    "$APP_HOME/.local/share/ensembleworks" "$APP_HOME/backups/pre-cutover-$ts"
  echo "backed up DATA_DIR -> ~/backups/pre-cutover-$ts (rollback across the era boundary)"
  EOF

  # 3. ENV + SKILL RESEED. Rewrite ~/.config/ensembleworks/*.env CANVAS_* -> ENSEMBLEWORKS_*
  #    and install the #4-authored SKILL.md set into the sandbox. Files ride from this
  #    operator checkout (scp), matching the tag.
  scp -q deploy/cutover-reseed.sh "${SSH_TARGET}:/tmp/ew-reseed.sh"
  ssh "$SSH_TARGET" 'bash /tmp/ew-reseed.sh'

  # 4. Cross the era boundary via a normal deploy (the ONE sanctioned crossing).
  EW_ALLOW_ERA_CROSS=1 deploy/deploy.sh "$SSH_TARGET" "$VERSION"

  # 5. MANUAL CANVAS-RENDER GATE (mandatory — no automated layer covers it, spec §4.3).
  cat >&2 <<'CHECK'
  ==> cutover deployed. BEFORE declaring success, do this by hand:
      1. Open the prod canvas URL in a browser (hard-refresh / incognito).
      2. Confirm the tldraw editor RENDERS — toolbar + shapes visible, NOT a
         blank white frame. A blank frame == the VITE_TLDRAW_LICENSE_KEY secret
         was missing/expired at CI build time (spec §4.3); re-run release-cli.yml
         with the secret set, then redeploy. Do NOT declare cutover done on a blank canvas.
      3. Restart terminal agents; users hard-refresh. Rollback = ~/backups/pre-cutover-*.
  CHECK
  ```

### Step 2 — `deploy/cutover-dataload-check.sh` (runs on the box; spec §8 step 1)

- [ ] **Create `deploy/cutover-dataload-check.sh`** (TAB-indented; the concrete form of design §7.1's "pre-deploy check confirms every room/roadmap/transcript file loads"):
  ```bash
  #!/usr/bin/env bash
  # Runs ON the box (piped by cutover.sh). $1 = version. Fetch the server binary,
  # boot it against a COPY of the live DATA_DIR, and assert /api/health lists every
  # room the DATA_DIR carries. ABORT (exit 1) if any room fails to load.
  set -euo pipefail
  VERSION="${1:?usage: cutover-dataload-check.sh <version>}"
  . /tmp/ew-lib.sh
  APP_USER=ensembleworks
  REPO_SLUG="${REPO_SLUG:-lean-software-production/ensembleworks}"
  RUN="sudo -u ${APP_USER}"
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  DATA_DIR="${APP_HOME}/.local/share/ensembleworks"

  echo "==> fetching v${VERSION} server binary for the data-load check"
  fetchdir="$(${RUN} mktemp -d)"
  ew_fetch_release "${VERSION}" "${fetchdir}" "${REPO_SLUG}" "${RUN}"

  echo "==> booting against a copy of the live DATA_DIR"
  work="$(${RUN} mktemp -d)"; cdir="$(${RUN} mktemp -d)"
  ${RUN} cp -a "${DATA_DIR}/." "${work}/"
  port="$(ew_free_port)"
  ${RUN} env PORT="$port" DATA_DIR="$work" CLIENT_DIST="$cdir" \
    "${fetchdir}/ensembleworks-server" sync >/tmp/ew-dataload.log 2>&1 & pid=$!
  ew_poll_health "http://127.0.0.1:$port/api/health" "$pid" || { echo "ABORT: server did not come up on the copied DATA_DIR" >&2; kill "$pid" 2>/dev/null; exit 1; }

  # Cross-check: every rooms/<room>.sqlite must appear in /api/health's rooms[].
  loaded="$(curl -s "http://127.0.0.1:$port/api/health")"
  echo "    /api/health: ${loaded}"
  rc=0
  if ${RUN} test -d "${work}/rooms"; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      room="$(basename "$f" .sqlite)"
      case "$loaded" in
      *"\"$room\""*) echo "    ok: room '$room' loaded" ;;
      *) echo "    FAIL: room '$room' did NOT load under the new binary" >&2; rc=1 ;;
      esac
    done < <(${RUN} bash -c "ls '${work}/rooms'/*.sqlite 2>/dev/null || true")
  fi
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  ${RUN} rm -rf "$fetchdir" "$work" "$cdir"
  [ "$rc" = 0 ] || { echo "ABORT: data-load check failed — do NOT cut over" >&2; exit 1; }
  echo "==> data-load check passed: every room loads under v${VERSION}"
  ```
  (Roadmaps/transcripts are files under `DATA_DIR` that the sync server reads lazily; the room-list assertion is the load-bearing keel-1 proof — a corrupt sqlite fails `/api/health`'s room enumeration. Extend with roadmap/transcript reads if the #6/#7 data harness lands a richer probe; the room check is the committed floor.)

- [ ] **`chmod +x deploy/cutover-dataload-check.sh`.**

### Step 3 — `deploy/cutover-reseed.sh` (spec §8 step 3)

- [ ] **Create `deploy/cutover-reseed.sh`** (TAB-indented; runs on the box, but the env-rewrite is testable against any dir):
  ```bash
  #!/usr/bin/env bash
  # Runs ON the box (piped by cutover.sh as /tmp/ew-reseed.sh). Idempotent env rename:
  # rewrite CANVAS_URL/CANVAS_ROOM -> ENSEMBLEWORKS_URL/ENSEMBLEWORKS_ROOM in the app
  # + service env files so the renamed scribe unit (Task 5) and the CLI (#4) agree.
  # The SKILL.md reseed is carried by the deploy.sh sandbox seed (AGENTS.md/CLAUDE.md);
  # this script only re-homes the env tokens the cutover renames.
  set -euo pipefail
  APP_USER=ensembleworks
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  AGENT_USER=ensembleworks-agent

  rewrite_env() { # $1 = env file path, $2 = run-as user
    local f="$1" as="$2"
    sudo -u "$as" test -f "$f" || return 0
    sudo -u "$as" sed -i -e 's/^CANVAS_URL=/ENSEMBLEWORKS_URL=/' -e 's/^CANVAS_ROOM=/ENSEMBLEWORKS_ROOM=/' "$f"
    echo "    rewrote CANVAS_* -> ENSEMBLEWORKS_* in $f"
  }

  # app-user service env files
  for f in "${APP_HOME}/.config/ensembleworks/scribe.env" "${APP_HOME}/.config/ensembleworks/sync.env"; do
    rewrite_env "$f" "$APP_USER"
  done
  # sandbox-user term env
  if id -u "$AGENT_USER" >/dev/null 2>&1; then
    AGENT_HOME="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
    rewrite_env "${AGENT_HOME}/.config/ensembleworks/term.env" "$AGENT_USER"
  fi
  echo "==> env reseed complete (CANVAS_* -> ENSEMBLEWORKS_*)"
  ```

- [ ] **`chmod +x deploy/cutover-reseed.sh`.**

### Step 4 — Gate: `shellcheck` + `bash -n` + a runnable reseed test

- [ ] **`shellcheck` + parse all three:**
  ```bash
  for s in deploy/cutover.sh deploy/cutover-dataload-check.sh deploy/cutover-reseed.sh; do
    nix run nixpkgs#shellcheck -- "$s" && bash -n "$s" && echo "$s clean"
  done
  ```
  Expected: three `… clean` lines, no findings.

- [ ] **Runnable reseed test** (drive the `rewrite_env` logic against a throwaway env file — no box; extract the sed to prove the token rename):
  ```bash
  f="$(mktemp)"; printf 'CANVAS_URL=http://localhost:8788\nCANVAS_ROOM=team\nSTT_MODEL=x\n' > "$f"
  sed -i -e 's/^CANVAS_URL=/ENSEMBLEWORKS_URL=/' -e 's/^CANVAS_ROOM=/ENSEMBLEWORKS_ROOM=/' "$f"
  grep -q '^ENSEMBLEWORKS_URL=' "$f" && grep -q '^ENSEMBLEWORKS_ROOM=' "$f" && ! grep -q '^CANVAS_' "$f" \
    && echo "ok: reseed renames CANVAS_* -> ENSEMBLEWORKS_*" || echo "FAIL"
  ```
  Expected: `ok: reseed renames …`.
- [ ] **Inspection-only note:** `cutover.sh`'s ssh choreography and `cutover-dataload-check.sh`'s on-box fetch+boot cannot run without the live box + real `DATA_DIR`; they are `shellcheck`/`bash -n`-proven here and exercised for real by #8. State this in the report.

- [ ] **Commit:**
  ```bash
  git add deploy/cutover.sh deploy/cutover-dataload-check.sh deploy/cutover-reseed.sh
  git commit -m "$(cat <<'EOF'
  feat(deploy): cutover.sh one-time choreography + dataload-check + reseed helpers (slice #7)

  deploy/cutover.sh runs ONCE for #8: (1) data-load check — boot the fetched binary
  against a COPY of the live DATA_DIR and assert every room loads (keel 1), abort
  otherwise; (2) DATA_DIR backup to ~/backups/pre-cutover-<ts> (outside releases/, so
  KEEP never prunes it — keel 3); (3) env reseed CANVAS_* -> ENSEMBLEWORKS_*; (4) the
  ONE sanctioned era crossing via EW_ALLOW_ERA_CROSS=1 deploy.sh; (5) a mandatory manual
  canvas-render gate (the licence bake no automated layer can catch, spec §4.3). Steps
  1 and 3 are independently shellcheck-able helpers. Machinery only — #7 runs nothing
  against prod.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 7 — `.github/workflows/release-cli.yml` (+ delete `release-termgw.yml`)

The release CI workflow (spec §4): cross-compile CLI + server from x64, build the transcriber natively per arch, build `client-dist.tar.gz` with the licence-key secret + fail-loud guard, boot-check the compiled binaries in a smoke job, then assemble/checksum/upload. **Gate class: INSPECTION-ONLY for CI** (GitHub Actions can't run locally). Runnable proxies: YAML parse, `shellcheck` of the extracted `run:` blocks, and the compile matrix commands already dry-run in Task 1.

### Step 1 — Write the workflow

- [ ] **Delete `.github/workflows/release-termgw.yml`** (`git rm`) — the one retirement #7 makes; its `termgw-linux-*` artifact is replaced by `ensembleworks-<os>-<arch>`.

- [ ] **Create `.github/workflows/release-cli.yml`** (spec §4.2, expanded to complete jobs; 2-space YAML):
  ```yaml
  name: release-cli
  on:
    push:
      tags: ['v*']
  permissions:
    contents: write
  jobs:
    lint:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: shellcheck the shipped deploy scripts (spec §10.1)
          run: |
            set -euo pipefail
            sudo apt-get update -qq && sudo apt-get install -y shellcheck
            shellcheck deploy/lib.sh deploy/deploy.sh deploy/install.sh \
              deploy/cutover.sh deploy/cutover-dataload-check.sh deploy/cutover-reseed.sh \
              deploy/test/fake-release.sh

    binaries:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: 1.3.14 }
        - run: bun install --frozen-lockfile
        - name: Compile CLI + server (cross-compiled from x64)
          run: |
            set -euo pipefail
            mkdir -p out
            for pair in linux-x64 linux-arm64 darwin-arm64; do
              EW_TARGET="bun-$pair" bun --cwd cli run build:binary
              cp cli/dist/ensembleworks "out/ensembleworks-$pair"
              case "$pair" in
              linux-*) # server ships linux only
                EW_TARGET="bun-$pair" bun --cwd server run build:binary
                cp server/dist/ensembleworks-server "out/ensembleworks-server-$pair" ;;
              esac
            done
        - uses: actions/upload-artifact@v4
          with: { name: binaries, path: out/ }

    transcriber-x64:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: 1.3.14 }
        - run: bun install --frozen-lockfile
        - name: Compile the transcriber natively (x64; addon resolved for this host)
          run: |
            set -euo pipefail
            mkdir -p out
            EW_TARGET=bun-linux-x64 bun --cwd transcriber run build:binary
            cp transcriber/dist/ensembleworks-transcriber out/ensembleworks-transcriber-linux-x64
        - uses: actions/upload-artifact@v4
          with: { name: transcriber-x64, path: out/ }

    transcriber-arm64:
      runs-on: ubuntu-24.04-arm
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: 1.3.14 }
        - run: bun install --frozen-lockfile
        - name: Compile the transcriber natively (arm64; addon resolved for this host)
          run: |
            set -euo pipefail
            mkdir -p out
            EW_TARGET=bun-linux-arm64 bun --cwd transcriber run build:binary
            cp transcriber/dist/ensembleworks-transcriber out/ensembleworks-transcriber-linux-arm64
        - uses: actions/upload-artifact@v4
          with: { name: transcriber-arm64, path: out/ }

    client-dist:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: oven-sh/setup-bun@v2
          with: { bun-version: 1.3.14 }
        - run: bun install --frozen-lockfile
        - name: Build the client bundle (licence key baked in — spec §4.3)
          env:
            # Build-time Vite var; tldraw enforces its licence on real prod domains,
            # so it MUST be present or the shipped bundle renders a blank editor.
            VITE_TLDRAW_LICENSE_KEY: ${{ secrets.VITE_TLDRAW_LICENSE_KEY }}
          run: |
            set -euo pipefail
            : "${VITE_TLDRAW_LICENSE_KEY:?FATAL: VITE_TLDRAW_LICENSE_KEY secret is unset — refusing to ship a blank-canvas bundle (spec §4.3)}"
            bun --bun run --filter @ensembleworks/client build
            tar czf client-dist.tar.gz -C client/dist .
        - uses: actions/upload-artifact@v4
          with: { name: client-dist, path: client-dist.tar.gz }

    smoke:
      needs: [binaries, transcriber-x64]
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/download-artifact@v4
          with: { path: dl }
        - name: Boot-check the compiled x64 binaries (the deploy.sh gate — spec §6.3/§4.2)
          run: |
            set -euo pipefail
            . deploy/lib.sh
            dir="$(mktemp -d)/smoke"; mkdir -p "$dir/client-dist"
            cp dl/binaries/ensembleworks-server-linux-x64 "$dir/ensembleworks-server"
            cp dl/transcriber-x64/ensembleworks-transcriber-linux-x64 "$dir/ensembleworks-transcriber"
            chmod +x "$dir"/ensembleworks-*
            ew_boot_check "$dir" ""   # server sync + term + transcriber --check, all 200/exit0

    publish:
      needs: [lint, binaries, transcriber-x64, transcriber-arm64, client-dist, smoke]
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/download-artifact@v4
          with: { path: dl }
        - name: Assemble, checksum, install.sh
          run: |
            set -euo pipefail
            mkdir rel
            find dl -type f \( -name 'ensembleworks-*' -o -name 'client-dist.tar.gz' \) -exec cp {} rel/ \;
            cp deploy/install.sh rel/install.sh
            ( cd rel && sha256sum ensembleworks-* client-dist.tar.gz > ensembleworks-checksums.txt )
        - uses: softprops/action-gh-release@v2
          with:
            tag_name: ${{ github.ref_name }}
            generate_release_notes: true
            files: rel/*
  ```
  (Asset name mapping `bun-linux-x64`→`linux-x64` etc. is `strip the bun- prefix`; `x64`/`arm64` already match `deploy.sh`'s `uname -m` map and `install.sh` — spec R4. The `smoke` job reuses the *same* `ew_boot_check` `deploy.sh` runs, so the boot-check is proven identically in CI and on the box.)

### Step 2 — INSPECTION gate + runnable proxies

- [ ] **YAML parses:**
  ```bash
  python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release-cli.yml')); print('release-cli.yml: valid YAML')"
  test ! -e .github/workflows/release-termgw.yml && echo "release-termgw.yml: removed"
  ```
  Expected: `release-cli.yml: valid YAML`; `release-termgw.yml: removed`.

- [ ] **`shellcheck` the embedded `run:` blocks** (extract each multi-line `run:` to a temp script — the `binaries`/`smoke`/`publish`/`client-dist` blocks are the load-bearing shell; they use `set -euo pipefail`). Minimal proxy — lint the `smoke` block, which is the one that sources `lib.sh`:
  ```bash
  cat > /tmp/ew-smoke-block.sh <<'SH'
  set -euo pipefail
  . deploy/lib.sh
  dir="$(mktemp -d)/smoke"; mkdir -p "$dir/client-dist"
  cp dl/binaries/ensembleworks-server-linux-x64 "$dir/ensembleworks-server"
  cp dl/transcriber-x64/ensembleworks-transcriber-linux-x64 "$dir/ensembleworks-transcriber"
  chmod +x "$dir"/ensembleworks-*
  ew_boot_check "$dir" ""
  SH
  nix run nixpkgs#shellcheck -x -- /tmp/ew-smoke-block.sh && echo "smoke run-block clean"
  ```
  Expected: `smoke run-block clean` (SC2154 for lib.sh functions is resolved by `-x` sourcing).

- [ ] **Compile-command dry-run** — the matrix's compile step is the exact `bun --cwd … run build:binary` already proven green in Task 1 for the host target; the arm64/darwin cross-targets were proven on this branch (spec §10.4). No further local run is possible for the arm64 *transcriber native* job (needs an arm runner). **State plainly in the report: the workflow is inspection-only; CI is its only true exercise.**

- [ ] **Commit:**
  ```bash
  git add .github/workflows/release-cli.yml
  git rm .github/workflows/release-termgw.yml
  git commit -m "$(cat <<'EOF'
  ci: release-cli.yml — compile + boot-check + publish the unified binaries; retire release-termgw (slice #7)

  On every v* tag: cross-compile CLI (linux-x64/arm64 + darwin-arm64) + server
  (linux-x64/arm64) from one x64 runner; build the transcriber NATIVELY per arch
  (x64 on ubuntu-latest, arm64 on ubuntu-24.04-arm — its @livekit addon does not
  cross-compile); build client-dist.tar.gz with VITE_TLDRAW_LICENSE_KEY + the :?
  fail-loud guard (a missing secret aborts the job, never ships a blank canvas); a
  smoke job runs the SAME ew_boot_check deploy.sh runs on the compiled x64 binaries;
  publish assembles + sha256sums + uploads the binaries, client-dist, install.sh and
  ensembleworks-checksums.txt. A lint job shellchecks every shipped deploy script.
  Retires release-termgw.yml (its termgw-linux-* artifact is replaced).

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 8 — `deploy/test/fake-release.sh` — the integration proof (+ README note)

The #7 dry-run proof and #8's stand-in (spec §10.3): a committed, no-ssh, no-sudo, no-licence-key round-trip that fakes a GitHub release locally and drives lib.sh's fetch→verify→boot→era→prune machinery end to end, with negative cases. **This is THE runnable integration proof for the slice.**

### Step 1 — Write the script

- [ ] **Create `deploy/test/fake-release.sh`** (TAB-indented; `chmod +x`):
  ```bash
  #!/usr/bin/env bash
  # deploy/test/fake-release.sh — the #7 dry-run proof (spec §10.3). Fakes a GitHub
  # release from locally-compiled host binaries and drives deploy/lib.sh's
  # fetch/verify/boot-check/era-gate/prune functions against a throwaway HOME tree —
  # no ssh, no sudo, launcher prefix "". Proves the machinery, NOT the licence bake
  # (no VITE_TLDRAW_LICENSE_KEY off-CI, so client-dist is an empty-dir stub, spec §4.3).
  #
  # Run from the repo root, after the three build:binary targets have been built:
  #   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  #   deploy/test/fake-release.sh
  set -euo pipefail
  cd "$(git rev-parse --show-toplevel)"
  . deploy/lib.sh

  fail=0
  ok()  { echo "ok  : $1"; }
  bad() { echo "FAIL: $1" >&2; fail=1; }

  ARCH="$(uname -m)"; case "$ARCH" in x86_64) PAIR=linux-x64;; aarch64) PAIR=linux-arm64;; *) echo "unsupported arch $ARCH" >&2; exit 1;; esac

  # --- build the host binaries if missing ---------------------------------------
  for w in server cli transcriber; do
    bin="$w/dist/$( [ "$w" = server ] && echo ensembleworks-server || { [ "$w" = cli ] && echo ensembleworks || echo ensembleworks-transcriber; } )"
    [ -x "$bin" ] || (cd "$w" && bun run build:binary)
  done

  # --- fake a release directory (the fetch source) ------------------------------
  rel="$(mktemp -d)"
  cp server/dist/ensembleworks-server "$rel/ensembleworks-server-$PAIR"
  cp cli/dist/ensembleworks "$rel/ensembleworks-$PAIR"
  cp transcriber/dist/ensembleworks-transcriber "$rel/ensembleworks-transcriber-$PAIR"
  stub="$(mktemp -d)"; tar czf "$rel/client-dist.tar.gz" -C "$stub" .   # empty-dir bundle (machinery only)
  ( cd "$rel" && sha256sum ensembleworks-* client-dist.tar.gz > ensembleworks-checksums.txt )

  # --- (1) fetch + checksum verify (and a byte-flip must FAIL) -------------------
  home="$(mktemp -d)"; NEW="$home/releases/1.0.0"
  DEPLOY_FETCH_DIR="$rel" ew_fetch_release 1.0.0 "$NEW" - "" \
    && [ -x "$NEW/ensembleworks-server" ] && [ -d "$NEW/client-dist" ] \
    && ok "fetch: assets re-homed + client-dist extracted" || bad "fetch"
  # byte-flip: corrupt a copy, re-checksum -c must fail
  bad_rel="$(mktemp -d)"; cp "$rel"/* "$bad_rel"/
  printf 'x' | dd of="$bad_rel/ensembleworks-$PAIR" bs=1 seek=8 count=1 conv=notrunc 2>/dev/null
  if ( cd "$bad_rel" && sha256sum -c ensembleworks-checksums.txt --ignore-missing >/dev/null 2>&1 ); then
    bad "byte-flip should have failed checksum"
  else ok "checksum: a byte-flipped binary fails -c"; fi

  # --- (2) boot-check passes; a truncated server binary FAILS -------------------
  cp deploy/posture-era "$NEW/.ew-era"
  ew_boot_check "$NEW" "" && ok "boot-check: sync + term + transcriber --check pass" || bad "boot-check pass"
  trunc="$home/releases/1.0.1"; mkdir -p "$trunc/client-dist"
  head -c 4096 "$NEW/ensembleworks-server" > "$trunc/ensembleworks-server"; chmod +x "$trunc/ensembleworks-server"
  cp "$NEW/ensembleworks-transcriber" "$trunc/"
  if ew_boot_check "$trunc" "" 2>/dev/null; then bad "truncated server should have failed boot-check"; else ok "boot-check: a truncated server binary fails (the check gates)"; fi

  # --- (3) era stamp ------------------------------------------------------------
  [ "$(cat "$NEW/.ew-era")" = "$(cat deploy/posture-era)" ] && ok "era: .ew-era stamped from deploy/posture-era" || bad "era stamp"

  # --- (4) era gate: fresh / same / cross / override ----------------------------
  ew_era_gate "$NEW/.ew-era" "$home/current" "" && ok "era-gate: fresh tree (no current) allowed" || bad "era-gate fresh"
  ln -sfn "$NEW" "$home/current"
  ew_era_gate "$NEW/.ew-era" "$home/current" "" && ok "era-gate: same-era swap allowed" || bad "era-gate same"
  legacy="$home/releases/0.9.0"; mkdir -p "$legacy"   # no .ew-era -> legacy era
  ln -sfn "$legacy" "$home/current"
  if ew_era_gate "$NEW/.ew-era" "$home/current" ""; then bad "era-gate should block legacy->unified-1"; else ok "era-gate: cross-era swap blocked"; fi
  EW_ALLOW_ERA_CROSS=1 ew_era_gate "$NEW/.ew-era" "$home/current" "" && ok "era-gate: EW_ALLOW_ERA_CROSS=1 unblocks the crossing" || bad "era-gate override"

  # --- (5) prune keeps KEEP newest; ~/backups is exempt -------------------------
  mkdir -p "$home/releases/1.0.2" "$home/backups/pre-cutover-x"
  touch -d '5 days ago' "$home/releases/0.9.0"; touch -d '4 days ago' "$home/releases/1.0.0"
  touch -d '3 days ago' "$home/releases/1.0.1"; touch -d '1 day ago' "$home/releases/1.0.2"
  ln -sfn "$home/releases/1.0.2" "$home/current"
  ew_prune_releases "$home/releases" 2 "$home/releases/1.0.2" ""
  { [ -d "$home/releases/1.0.2" ] && [ -d "$home/releases/1.0.1" ] && [ ! -d "$home/releases/0.9.0" ] && [ -d "$home/backups/pre-cutover-x" ]; } \
    && ok "prune: keeps 2 newest, drops the oldest, backups/ exempt" || bad "prune"

  rm -rf "$rel" "$bad_rel" "$stub" "$home"
  echo "----"
  [ "$fail" = 0 ] && echo "fake-release: ALL PASS" || { echo "fake-release: FAILURES" >&2; exit 1; }
  ```

- [ ] **`chmod +x deploy/test/fake-release.sh`.**

### Step 2 — README note (spec §10.3: "documented in the README Development")

- [ ] **`README.md`** — under the `## Development` section, add a short paragraph documenting the two deploy proofs (place it near the existing smoke-test guidance):
  ```markdown
  ### Deploy machinery proofs (no box required)

  The fetch-verify-swap deploy path is proven locally without a production box:

  - `deploy/deploy.sh <target> <ver> --dry-run` runs the *verify half*: it fetches
    the tag's release assets (or a local `DEPLOY_FETCH_DIR`), verifies checksums, runs
    the real hermetic boot-check of the fetched server + transcriber, and prints the
    swap plan — no ssh, no swap, no restart.
  - `deploy/test/fake-release.sh` is the end-to-end round-trip: it compiles the host
    binaries, fakes a GitHub release, and drives `deploy/lib.sh`'s
    fetch/verify/boot-check/era-gate/prune functions against a throwaway tree, with
    byte-flip + truncated-binary negative cases. Neither validates the tldraw licence
    bake (no `VITE_TLDRAW_LICENSE_KEY` off-CI) — that is CI's `client-dist` job + the
    manual canvas-render gate in `deploy/cutover.sh`.
  ```

### Step 3 — RUNNABLE gate: the integration proof + `shellcheck`

- [ ] **`shellcheck` + run the round-trip:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  nix run nixpkgs#shellcheck -x -- deploy/test/fake-release.sh && echo "fake-release.sh clean"
  deploy/test/fake-release.sh
  ```
  Expected: `fake-release.sh clean`; then every proof prints `ok  :` and the run ends `fake-release: ALL PASS`.

- [ ] **Final branch green gate:**
  ```bash
  bun run typecheck && bun run test && bun run build
  ```
  Expected: typecheck 0; `all 58 suites passed` (unchanged); build 0.

- [ ] **Commit:**
  ```bash
  git add deploy/test/fake-release.sh README.md
  git commit -m "$(cat <<'EOF'
  test(deploy): fake-release.sh — the #7 fetch->verify->boot->era->prune dry-run proof (slice #7)

  A committed, no-ssh/no-sudo/no-licence-key round-trip: compiles the host binaries,
  fakes a GitHub release, and drives deploy/lib.sh end to end against a throwaway HOME
  tree. Asserts: fetch re-homes + extracts; sha256sum -c verifies AND a byte-flipped
  binary fails; ew_boot_check passes on sync+term+transcriber --check AND a truncated
  server fails (the check gates); .ew-era is stamped; the era gate allows fresh + same-
  era, blocks cross-era, and EW_ALLOW_ERA_CROSS=1 unblocks it; prune keeps KEEP newest
  with ~/backups exempt. This is #8's stand-in — the machinery demonstrated without a
  prod box or licence key. Not a *.test.ts (suite count stays 58). README documents it.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Final self-review (spec coverage, placeholder scan, gate reality)

Before declaring the slice done, confirm:

- **Spec coverage.** Every §2 decision (D1–D9) landed: D1 `main.ts` dispatcher (T1), D2 asset names (T7 + `install.sh` T3), D3 build matrix / native transcriber (T7), D4 per-binary hermetic boot-check (T1/T2), D5 `gh` fetch + `--build-from-source` (T4), D6 `client-dist` alongside (T2 `ew_fetch_release` + T5 sync unit), D7 posture-era file/gate (T2/T4), D8 backups exempt from prune (T2/T6), D9 58→58 (all). Every §6.4 re-homed source (canvas→artifact CLI, gh-app-token.bash, ensembleworks-gh-token, tmux.conf, the five agent-home files, posture-era) is scp'd + install-sourced from `/tmp/ew-*` (T4). All three §7 unit diffs incl. `KillMode=process` preserved (T5). §4.3 licence-key secret + `:?` guard + manual render gate (T7 + T6). §10.1–10.4 proofs (shellcheck everywhere, `--dry-run`, `fake-release.sh`, the reproduced §10.4 probes) (T1/T2/T4/T8).
- **Placeholder scan.** No `TODO`, no `<...>`, no "sketch" — every script/unit/workflow/`.ts` block is complete and copy-paste-ready.
- **Every script has `shellcheck`** (`lib.sh`, `deploy.sh`, `install.sh`, `cutover.sh` + 2 helpers, `fake-release.sh`, and the CI `run:` blocks via the lint job + the T7 extract).
- **The runnable proofs are real commands** that pass on this host: T1 compile+boot (reproduces §10.4), T2 function unit-tests, T4 `--dry-run`, T8 `fake-release.sh ALL PASS`, T5 `systemd-analyze verify`. Inspection-only surfaces (the CI workflow run, `install.sh`'s curl path, `cutover.sh`'s ssh choreography, the arm64 native transcriber job) are called out as such — CI and #8 are their only true exercise.
- **Suite count is 58** at every task end (no `*.test.ts` added); `bun run test` / `typecheck` / `build` stay green because `main.ts` + the transcriber `--check` are new product code.
- **#7/#8 boundary respected:** no deletion of `gateway-go/`/`connect.sh`/`bin/canvas`/node-pty/Node, no devcontainer-feature rewrite, no route/Caddy change; `release-termgw.yml` is the single retirement.
