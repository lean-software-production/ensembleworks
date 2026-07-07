# The `ensembleworks-cli` devcontainer feature — repackaging termgw onto the Bun CLI (slice #8-must-do #1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new, self-contained devcontainer feature at
`deploy/features/ensembleworks-cli/` that installs the `ensembleworks` CLI (#7's
release binary) and runs `ensembleworks terminal connect` under the same
background-supervisor pattern the retired Go termgw feature used — a faithful
repackaging with **no new behaviour**. Plus the **one** `contracts/` change this
slice forces: a connector-side token scrub in `canvasTmuxSpawnSpec` so a hosted
canvas terminal can never read the machine's CF-Access service-token (the net-new
credential this feature creates). After the slice `bun run typecheck` and
`bun run build` are green, the scrub test passes, and the full runner still
reports **`all 59 suites passed`** (the scrub is a new *case* inside the existing
`contracts/src/session-manager.test.ts`, not a new suite *file* — see the
suite-count reconciliation below).

**Spec:** `docs/superpowers/specs/2026-07-07-ensembleworks-cli-feature-design.md`
— panel 3/3 + r2-verified; implement it exactly. Its `feature.json` (§3.1),
`install.sh` (§5), `entrypoint.sh`/`supervisor.sh` (§6), the token scrub (§4.2),
and the V1–V7 verification plan (§8) are authoritative.
**Charter:** `docs/superpowers/specs/2026-07-06-plugin-architecture-track-charter.md`,
§"#5 — Connector / #6 — Transcriber" + §"#7 — Distribution / #8 — Cutover" +
"Standing conventions".

**Scope boundary (spec §1 — do not cross it):** this slice builds the new
feature dir + the §4.2 scrub only. It does **NOT** delete
`gateway-go/termgw-feature/` (that retires with the rest of `gateway-go/` in the
cutover runbook's Phase E), does **NOT** change `cli/` or `deploy/install.sh`
(they are consumed verbatim; the CLI's `stableGatewayId` is the gateway-id
default), and does **NOT** touch this repo's own `.devcontainer/` (the feature is
a deploy artifact remote boxes reference, hence its home under `deploy/`). **The
one `contracts/` change** is the scrub in `canvasTmuxSpawnSpec` — a hardening
no-op wherever the credential vars are unset, so it changes no existing behaviour.

---

## Environment & conventions (read before starting)

1. **Bun version.** The default PATH `bun` is too old. Before any `bun` command:
   ```bash
   export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
   bun --version   # must print 1.3.14
   ```
2. **shellcheck.** The system `shellcheck` is broken in this environment. Use the
   nix-provided one for every V2/lint gate:
   ```bash
   nix run nixpkgs#shellcheck -- <files…>
   ```
3. **Indentation.** `contracts/src/session-manager.ts`'s newer helpers
   (`clampTmuxGrid`, `canvasTmuxSpawnSpec`) are **tab**-indented — the edits in
   Task 1 add tab-indented code to match. `session-manager.test.ts` is a
   self-running script whose body is mostly top-level statements; the one nested
   loop below is tab-indented. The shell scripts (`install.sh`, `entrypoint.sh`,
   `supervisor.sh`) use **tabs**, matching the Go feature they replace. Every
   verbatim block below is written the way the target file wants it; preserve it.
4. **Test convention.** Self-running `bun src/<x>.test.ts` scripts, discovered by
   `scripts/run-tests.ts`'s `**/src/**/*.test.ts` glob (it counts matching
   **files** — currently 59). The devcontainer scripts add **no** bun test file;
   the scrub is a new *case* appended inside `session-manager.test.ts`.
5. **CRITICAL — the scrub assertions go BEFORE the file's `process.exit(0)`.**
   `contracts/src/session-manager.test.ts` ends with
   `console.log('ok: TmuxSession primitive')` then `process.exit(0)` (line 59).
   The new scrub case MUST be inserted **before** that `process.exit(0)` — code
   appended *after* it never runs, silently passing while asserting nothing.
6. **Commit trailer, exactly** (this repo's `git` runs through a direnv wrapper —
   commit exactly as shown):
   ```
   Co-Authored-By: Claude <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
   ```

### Suite-count reconciliation (documented, not escalated)

The spec (§1, §8) says the suite moves **59 → 60**. That counts `ok:` **cases**
(the scrub adds one `ok:` line inside `session-manager.test.ts`). It does **not**
mean the runner's file-based count changes: `scripts/run-tests.ts` prints
`all ${files.length} suites passed`, and `files` is the set of files matching
`**/src/**/*.test.ts` — currently **59**. Adding a case to an *existing* file
leaves that count at 59. So the end gate's expected line is **`all 59 suites
passed`**, and `contracts/src/session-manager.test.ts` prints **two** `ok:` lines
(the existing `ok: TmuxSession primitive` and the new
`ok: canvasTmuxSpawnSpec scrubs …`). Both facts are true simultaneously; do not
"fix" the runner to read 60.

### Which gates are runnable now vs release-gated

- **Runnable now (the merge gate): V1–V6.** All cheap, deterministic, no network
  — JSON validity (V1), shellcheck (V2), `bash -n` (V3), the tmux-conf diff (V4),
  the scrub test (V5, RED-first), and the `--dry-run` contract check (V6, which
  runs against the CLI on this branch and needs no published release).
- **Release-gated (deferred): V7.** The real `devcontainer build` needs a
  published `ensembleworks-<arch>` release asset (present after #7's
  `release-cli.yml` has run for any tag). If no release exists at execution time,
  the slice lands on V1–V6 with V7 documented as the first-post-#7-tag follow-up.

### Gating policy — per task vs at the end

- **Per task: `bun run typecheck` MUST stay green**, and each task's own
  gate (its shellcheck + `bash -n`, or its test) MUST be at the declared state
  (RED at a written-test checkpoint, GREEN at the task's end).
- **No task may leave a red suite at its end.**
- **End only (Task 6): the full V1–V6 gate, `bun run typecheck`,
  `bun run test` (`all 59 suites passed`), and `bun run build`.**

---

## Task 1 — The token scrub in `contracts/src/session-manager.ts` (TDD: RED → GREEN)

The one `contracts/` change, sequenced first and test-driven. `canvasTmuxSpawnSpec`
currently spreads the whole parent `process.env` into the spawned tmux env, so a
hosted canvas terminal inherits the connector's `ENSEMBLEWORKS_TOKEN_*` and any
teammate on that box can exfiltrate the machine's write-credential. Strip the
credential keys from a shallow copy before the spread — a no-op wherever they are
unset (so every existing test stays green), hardening both the server gateway and
the connector at once.

### Step 1 — Write the failing case (RED)

- [ ] **Extend the test import** in `contracts/src/session-manager.test.ts` —
  replace:
  ```ts
  import { openTmuxSession } from './session-manager.js'
  ```
  with:
  ```ts
  import { canvasTmuxSpawnSpec, openTmuxSession } from './session-manager.js'
  ```

- [ ] **Insert the scrub case BEFORE `process.exit(0)`** (§note 5) — the file
  currently ends:
  ```ts
  console.log('ok: TmuxSession primitive')
  process.exit(0)
  ```
  Replace that with (the new block sits between the two existing lines):
  ```ts
  console.log('ok: TmuxSession primitive')

  // Token scrub (spec §4.2): canvasTmuxSpawnSpec must strip the connector's
  // service-token credential vars from the spawned terminal env so a hosted
  // canvas terminal can never read them — while preserving TERM and WITHOUT
  // mutating process.env (a shallow copy is scrubbed, not the live env).
  process.env.ENSEMBLEWORKS_TOKEN_ID = 'id-xxx'
  process.env.ENSEMBLEWORKS_TOKEN_SECRET = 'shhh-machine-cred'
  process.env.CF_ACCESS_CLIENT_ID = 'cf-id'
  process.env.CF_ACCESS_CLIENT_SECRET = 'cf-secret'
  const scrubbed = canvasTmuxSpawnSpec({ sessionId: 't1' })
  for (const k of ['ENSEMBLEWORKS_TOKEN_ID', 'ENSEMBLEWORKS_TOKEN_SECRET', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
  	assert.equal(k in scrubbed.env, false, `${k} must not leak into the spawn env`)
  }
  assert.equal(scrubbed.env.TERM, 'xterm-256color', 'scrub must not clobber TERM')
  assert.equal(process.env.ENSEMBLEWORKS_TOKEN_SECRET, 'shhh-machine-cred', 'process.env must NOT be mutated (shallow copy scrubbed)')
  delete process.env.ENSEMBLEWORKS_TOKEN_ID
  delete process.env.ENSEMBLEWORKS_TOKEN_SECRET
  delete process.env.CF_ACCESS_CLIENT_ID
  delete process.env.CF_ACCESS_CLIENT_SECRET
  console.log('ok: canvasTmuxSpawnSpec scrubs the service-token from the spawned terminal env')

  process.exit(0)
  ```
  (`assert` is already imported at the top as `node:assert/strict`; no timers, no
  boot, so no extra teardown is needed beyond the existing `process.exit(0)`.)

- [ ] **RED checkpoint — run it, expect failure (the bare spread still leaks):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun contracts/src/session-manager.test.ts
  ```
  Expected: **fails** at the first scrub assertion —
  `ENSEMBLEWORKS_TOKEN_ID must not leak into the spawn env` (the current
  implementation spreads it in, so `'ENSEMBLEWORKS_TOKEN_ID' in scrubbed.env` is
  `true`). The `ok: TmuxSession primitive` line prints first; the scrub `ok:` line
  does **not**.

### Step 2 — Write the scrub (GREEN)

- [ ] **`contracts/src/session-manager.ts`** — two edits inside the existing
  `canvasTmuxSpawnSpec` region. Do **not** touch `openTmuxSession`,
  `clampTmuxGrid`, or the interfaces.

  - **Add the exported `SPAWN_ENV_SCRUB` constant** immediately before
    `export function canvasTmuxSpawnSpec` (after the `CanvasTmuxSpawnOptions`
    interface):
    ```ts
    /** Credential env vars the connector/gateway hold to authenticate, that a
     *  hosted canvas terminal must never inherit (it would let any terminal user
     *  exfiltrate the machine's service-token). Stripped in canvasTmuxSpawnSpec. */
    export const SPAWN_ENV_SCRUB = [
    	'ENSEMBLEWORKS_TOKEN_ID',
    	'ENSEMBLEWORKS_TOKEN_SECRET',
    	'CF_ACCESS_CLIENT_ID', // belt-and-suspenders: the pre-clean-break spelling
    	'CF_ACCESS_CLIENT_SECRET',
    ] as const
    ```

  - **Replace the bare spread** inside `canvasTmuxSpawnSpec`. Replace:
    ```ts
    	const env: Record<string, string> = {
    		...(process.env as Record<string, string>),
    		TERM: 'xterm-256color',
    		COLORFGBG: '0;15', // light-bg hint for tmux < 3.4 (drops OSC 11 queries)
    	}
    	if (opts.tmuxConf) env.ENSEMBLEWORKS_TMUX_CONF = opts.tmuxConf // the `q` reload binding reads this
    ```
    with:
    ```ts
    	const parentEnv = { ...(process.env as Record<string, string>) }
    	for (const k of SPAWN_ENV_SCRUB) delete parentEnv[k]
    	const env: Record<string, string> = {
    		...parentEnv,
    		TERM: 'xterm-256color',
    		COLORFGBG: '0;15', // light-bg hint for tmux < 3.4 (drops OSC 11 queries)
    	}
    	if (opts.tmuxConf) env.ENSEMBLEWORKS_TMUX_CONF = opts.tmuxConf // the `q` reload binding reads this
    ```
    **CRITICAL (spec §4.2 note b): keep the `if (opts.tmuxConf) …` line** — the
    spec's illustrative snippet omits it; dropping it would silently break the
    tmux `q`-reload binding. The scrub copies `process.env` **shallowly**, deletes
    the four keys **from the copy**, and builds the returned `env` from that copy;
    `process.env` itself is never mutated (the test's last assertion pins this).

### Step 3 — GREEN gate + commit

- [ ] **Run the case + typecheck:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun contracts/src/session-manager.test.ts
  bun run typecheck
  ```
  Expected: the file prints **both** `ok: TmuxSession primitive` and
  `ok: canvasTmuxSpawnSpec scrubs the service-token from the spawned terminal
  env`, exit 0; `typecheck` exits 0.

- [ ] **Commit:**
  ```bash
  git add contracts/src/session-manager.ts contracts/src/session-manager.test.ts
  git commit -m "$(cat <<'EOF'
  feat(contracts): scrub CF-Access service-token from canvasTmuxSpawnSpec env (ensembleworks-cli #8)

  canvasTmuxSpawnSpec spread the whole parent process.env into the spawned tmux
  env, so a hosted canvas terminal inherited the connector's ENSEMBLEWORKS_TOKEN_*
  and any teammate on the box could exfiltrate the machine's write-credential — a
  net-new exposure created by the ensembleworks-cli devcontainer feature (which is
  what makes the token exist). New exported SPAWN_ENV_SCRUB lists the four
  credential keys (ENSEMBLEWORKS_TOKEN_ID/_SECRET + the pre-clean-break
  CF_ACCESS_CLIENT_ID/_SECRET); the helper now shallow-copies process.env, deletes
  those keys from the copy, then builds the returned env (TERM/COLORFGBG/tmuxConf
  preserved, process.env unmutated). A no-op wherever the vars are unset, so every
  existing suite stays green; session-manager.test.ts gains the scrub case.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 2 — Feature dir scaffold + `devcontainer-feature.json` + `README.md`

Create the self-contained feature directory and its manifest. The manifest's
`entrypoint` + `containerEnv.TMUX_CONF` and the option→env/flag mapping are the
clean break from the old anonymous termgw feature (spec §3).

### Step 1 — Create the directory + manifest (verbatim from spec §3.1)

- [ ] **Create the dir:**
  ```bash
  mkdir -p deploy/features/ensembleworks-cli
  ```

- [ ] **`deploy/features/ensembleworks-cli/devcontainer-feature.json`** (create
  it — verbatim; tab-indented JSON to match the repo's Go feature manifest style):
  ```json
  {
  	"id": "ensembleworks-cli",
  	"version": "1.0.0",
  	"name": "EnsembleWorks CLI + terminal connector",
  	"description": "Installs the `ensembleworks` CLI and runs `ensembleworks terminal connect`, so this container hosts canvas terminal shapes via the EnsembleWorks relay. Replaces the retired Go termgw feature.",
  	"options": {
  		"version": {
  			"type": "string",
  			"default": "latest",
  			"description": "Which ensembleworks release to install (e.g. 0.11.0), or 'latest'."
  		},
  		"url": {
  			"type": "string",
  			"default": "",
  			"description": "EnsembleWorks instance base URL the connector dials -> ENSEMBLEWORKS_URL, e.g. https://canvas.example.com. Required unless supplied at runtime."
  		},
  		"gatewayLabel": {
  			"type": "string",
  			"default": "",
  			"description": "Human label shown in the New-terminal picker -> --label (defaults to the container hostname)."
  		},
  		"gatewayId": {
  			"type": "string",
  			"default": "",
  			"description": "Stable gateway id -> --gateway-id. Leave empty to let the CLI derive a stable per-box id (hostname + machine-id); set only to pin a friendly id."
  		},
  		"tokenId": {
  			"type": "string",
  			"default": "",
  			"description": "CF Access service-token id -> ENSEMBLEWORKS_TOKEN_ID. SECURITY: a value here is BAKED INTO THE IMAGE LAYER (readable by anyone with the image). Only for trusted or throwaway images; prefer runtime injection (see README)."
  		},
  		"tokenSecret": {
  			"type": "string",
  			"default": "",
  			"description": "CF Access service-token secret -> ENSEMBLEWORKS_TOKEN_SECRET. SECURITY: same image-layer warning as tokenId. Prefer runtime injection."
  		}
  	},
  	"entrypoint": "/usr/local/share/ensembleworks-connect/entrypoint.sh",
  	"containerEnv": {
  		"TMUX_CONF": "/usr/local/share/ensembleworks-connect/tmux-ensembleworks.conf"
  	}
  }
  ```

### Step 2 — The consumer README (spec §9 + §4.3)

- [ ] **`deploy/features/ensembleworks-cli/README.md`** (create it):
  ```markdown
  # ensembleworks-cli (devcontainer feature)

  Installs the `ensembleworks` CLI and runs `ensembleworks terminal connect` under
  a background supervisor, so this container hosts canvas terminal shapes via the
  EnsembleWorks relay. Replaces the retired Go `termgw` feature.

  ## Usage — strict-prod path (no baked secret, recommended)

  ```jsonc
  {
    "features": {
      "ghcr.io/lean-software-production/ensembleworks/ensembleworks-cli:1": {
        "url": "https://canvas.example.com",
        "gatewayLabel": "workshops box",
        "version": "0.11.0"
      }
    },
    // token via a runtime secret (Codespaces secret / --env-file / -e), NOT remoteEnv:
    "containerEnv": {
      "ENSEMBLEWORKS_TOKEN_ID": "${localEnv:ENSEMBLEWORKS_TOKEN_ID}",
      "ENSEMBLEWORKS_TOKEN_SECRET": "${localEnv:ENSEMBLEWORKS_TOKEN_SECRET}"
    }
  }
  ```

  `containerEnv` (not `remoteEnv`) is used for the token so it reaches the
  init-chained supervisor: `remoteEnv` is applied only to interactive/exec
  sessions and lifecycle hooks, not to the container's backgrounded entrypoint.
  On an anonymous/dev instance, omit the token entirely.

  ## Options

  | Option | Delivered as | Notes |
  |---|---|---|
  | `version` | which release `install.sh` fetches | **Pin it** (e.g. `0.11.0`). `latest` bakes a non-reproducible layer — fine only for throwaway boxes. |
  | `url` | env `ENSEMBLEWORKS_URL` | Not a secret; baked freely. Required (or inject at runtime) or the supervisor fails loud. |
  | `gatewayLabel` | `--label` | Empty ⇒ the CLI defaults to the container hostname. |
  | `gatewayId` | `--gateway-id` | Empty ⇒ the CLI derives a stable per-box id. Set only to pin a friendly id. |
  | `tokenId` / `tokenSecret` | env in `/etc/ensembleworks-connect.env` | **SECURITY: baked into the image layer.** Escape hatch for trusted/throwaway images only — prefer runtime injection above. |

  ## Defaults & footguns

  - **Single room (`team`).** The feature has no room option. A multi-room operator
    adds `ENSEMBLEWORKS_ROOM` to the same runtime `containerEnv` block.
  - **Runtime env overrides a baked value.** The supervisor sources the baked
    env file key-by-key, skipping any key already set at container runtime — so
    rotating `-e ENSEMBLEWORKS_TOKEN_SECRET=…` needs no image rebuild.
  ```

- [ ] **typecheck stays green** (no TS touched here, but keep the discipline):
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  ```
  Expected: exit 0.

- [ ] **Commit** (the manifest + README; the scripts arrive in Tasks 3–5):
  ```bash
  git add deploy/features/ensembleworks-cli/devcontainer-feature.json deploy/features/ensembleworks-cli/README.md
  git commit -m "$(cat <<'EOF'
  feat(deploy): scaffold ensembleworks-cli devcontainer feature — manifest + README (#8)

  New self-contained feature dir deploy/features/ensembleworks-cli/. The manifest
  (devcontainer-feature.json, version 1.0.0) declares the version/url/gatewayLabel/
  gatewayId/tokenId/tokenSecret options, chains entrypoint.sh as the feature
  entrypoint, and bakes TMUX_CONF via containerEnv. README leads with the strict-
  prod runtime-token path (containerEnv, not remoteEnv) and the image-layer warning
  for the baked-token escape hatch, plus the single-room / pin-version / runtime-
  overrides-baked footguns.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 3 — `install.sh` (root, image-build; adapts `deploy/install.sh`)

The build-time root installer: arch-detect + checksum-verify (adapted from
`deploy/install.sh`, but installing system-wide to `/usr/local/bin` as root),
tmux install, ships the supervisor/entrypoint/conf under
`/usr/local/share/ensembleworks-connect/`, and bakes the non-secret connector
config into a `0600` `/etc/ensembleworks-connect.env`.

### Step 1 — Write the script (verbatim from spec §5)

- [ ] **`deploy/features/ensembleworks-cli/install.sh`** (create it — tabs;
  `chmod +x` after writing):
  ```bash
  #!/usr/bin/env bash
  # ensembleworks-cli devcontainer feature installer. Runs at image build as root,
  # feature dir as cwd. Option values arrive as uppercased env vars
  # (url->URL, gatewayLabel->GATEWAYLABEL, gatewayId->GATEWAYID,
  #  tokenId->TOKENID, tokenSecret->TOKENSECRET, version->VERSION).
  set -euo pipefail

  REPO="lean-software-production/ensembleworks"
  VER="${VERSION:-latest}"
  SHARE="/usr/local/share/ensembleworks-connect"

  # 1. tmux (the connector spawns tmux sessions; same as the old feature).
  if ! command -v tmux >/dev/null; then
  	apt-get update && apt-get install -y --no-install-recommends tmux ca-certificates curl
  	rm -rf /var/lib/apt/lists/*
  fi

  # 2. Fetch + checksum-verify the ensembleworks binary for THIS container's arch
  #    (Linux only inside a container). Adapted from deploy/install.sh; installs
  #    system-wide as root instead of ~/.local/bin as the user.
  case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) A=linux-x64 ;;
  Linux-aarch64) A=linux-arm64 ;;
  *) echo "ensembleworks-cli: unsupported container platform $(uname -sm)" >&2; exit 1 ;;
  esac
  base="https://github.com/$REPO/releases/latest/download"
  [ "$VER" = latest ] || base="https://github.com/$REPO/releases/download/v$VER"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/ensembleworks-$A" -o "$tmp/ew"
  curl -fsSL "$base/ensembleworks-checksums.txt" -o "$tmp/sums"
  (cd "$tmp" && grep " ensembleworks-$A\$" sums | sed "s/ensembleworks-$A/ew/" | sha256sum -c -)
  install -D -m 0755 "$tmp/ew" /usr/local/bin/ensembleworks
  ln -f /usr/local/bin/ensembleworks /usr/local/bin/ew

  # 3. Ship the supervisor, entrypoint, and tmux conf (self-contained: the conf is
  #    a committed copy of deploy/tmux-ensembleworks.conf — spec §5.1).
  install -D -m 0755 ./supervisor.sh "$SHARE/supervisor.sh"
  install -D -m 0755 ./entrypoint.sh "$SHARE/entrypoint.sh"
  install -D -m 0644 ./tmux-ensembleworks.conf "$SHARE/tmux-ensembleworks.conf"

  # 4. Bake the NON-SECRET connector config into an env file the supervisor
  #    sources at runtime. Options are baked at BUILD time (no reliance on
  #    remoteEnv reaching a backgrounded daemon — spec §4).
  #    emit KEY='value', single-quoting so labels with spaces survive `.` sourcing
  #    (the old feature's lesson: an unquoted space ran the tail as a command).
  emit() {
  	[ -n "$2" ] || return 0
  	printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")"
  }
  {
  	echo "# generated by ensembleworks-cli feature install.sh"
  	emit ENSEMBLEWORKS_URL "${URL:-}"
  	emit EW_LABEL "${GATEWAYLABEL:-}"
  	emit EW_GATEWAY_ID "${GATEWAYID:-}"
  	# SECURITY (spec §4): only baked when the operator set the option. Prefer
  	# runtime env injection — a baked secret is readable in the image layer.
  	emit ENSEMBLEWORKS_TOKEN_ID "${TOKENID:-}"
  	emit ENSEMBLEWORKS_TOKEN_SECRET "${TOKENSECRET:-}"
  	emit TMUX_CONF "$SHARE/tmux-ensembleworks.conf"
  } >/etc/ensembleworks-connect.env
  # 0600, root-owned: this file CAN carry a baked token (spec §4 escape hatch) on
  # a box that hosts arbitrary canvas terminals. 0600 keeps a terminal user from
  # reading it. The URL isn't sensitive, but always-0600 is harmless and removes a
  # mode-branch. The supervisor runs as root (entrypoint is root at container
  # init), so root ownership is the correct run-as owner.
  chmod 0600 /etc/ensembleworks-connect.env

  echo "ensembleworks-cli feature installed (version=${VER}, arch=${A}, url=${URL:-<runtime>})"
  ```

- [ ] **Make it executable:**
  ```bash
  chmod +x deploy/features/ensembleworks-cli/install.sh
  ```

### Step 2 — Task gate (shellcheck + `bash -n`)

- [ ] **Lint + parse:**
  ```bash
  nix run nixpkgs#shellcheck -- deploy/features/ensembleworks-cli/install.sh
  bash -n deploy/features/ensembleworks-cli/install.sh
  ```
  Expected: both exit 0, no shellcheck findings (the env-file is written by
  redirection, not sourced here, so there is no SC1091 to suppress).

- [ ] **Commit:**
  ```bash
  git add deploy/features/ensembleworks-cli/install.sh
  git commit -m "$(cat <<'EOF'
  feat(deploy): ensembleworks-cli feature install.sh — root build installer (#8)

  Adapts deploy/install.sh's arch-detect + sha256 checksum-verify to a system-wide
  root install (/usr/local/bin/ensembleworks + ew hardlink) at image build, ensures
  tmux + ca-certificates + curl, ships supervisor.sh/entrypoint.sh/tmux-ensemble
  works.conf under /usr/local/share/ensembleworks-connect/, and bakes the non-secret
  connector config into a 0600 root-owned /etc/ensembleworks-connect.env via the
  emit guard (nothing baked for an empty option; single-quoted so spaced labels
  survive sourcing). shellcheck + bash -n clean.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 4 — `entrypoint.sh` + `supervisor.sh` (same pattern, new command)

The entrypoint (chained ahead of the container's main command as persistent init)
launches the supervisor once in the background via `setsid`, then `exec "$@"`. The
supervisor sources the baked env file **key-by-key, skipping keys already set at
runtime** (so a rotated runtime token wins), fails loud on missing URL, and runs
`ensembleworks terminal connect` with the conditional `--label` / `--gateway-id`
flags. Only paths, process name, and the command-under-supervision change from the
Go feature.

### Step 1 — Write the entrypoint (verbatim from spec §6.1)

- [ ] **`deploy/features/ensembleworks-cli/entrypoint.sh`** (create it — tabs):
  ```bash
  #!/usr/bin/env bash
  # ensembleworks-cli feature entrypoint. The devcontainer CLI chains feature
  # entrypoints ahead of the container's main command, so this runs as part of the
  # container's persistent init (unlike a postStartCommand daemon, which the CLI
  # reaps when its exec returns). Launch the connector supervisor in the
  # background, then exec the original command so the container behaves normally.
  set -u

  # Liveness check (not a flag file): /tmp survives `docker stop`/`start` but the
  # processes do not, so a flag would leave the connector dead after a restart.
  # Idempotent if the entrypoint is re-invoked live.
  if ! pgrep -f ensembleworks-connect/supervisor.sh >/dev/null 2>&1; then
  	setsid /usr/local/share/ensembleworks-connect/supervisor.sh \
  		>>/tmp/ensembleworks-connect.log 2>&1 </dev/null &
  fi

  exec "$@"
  ```

### Step 2 — Write the supervisor (verbatim from spec §6.2)

- [ ] **`deploy/features/ensembleworks-cli/supervisor.sh`** (create it — tabs):
  ```bash
  #!/usr/bin/env bash
  # Restart-on-exit supervisor for the ensembleworks connector (spike-grade;
  # systemd is not available inside devcontainers). Config is baked into
  # /etc/ensembleworks-connect.env at feature-install time from the feature
  # options (URL/label/id, and optionally a token) — no reliance on remoteEnv
  # reaching this backgrounded process. A token may instead arrive via the
  # container's runtime env (spec §4); either way it is in this process's environment.
  set -u

  # Source the baked file KEY-BY-KEY, setting only keys NOT already in the
  # environment — so a token rotated at container runtime (spec §4) always wins over
  # a stale build-baked value. A plain `. file` would clobber runtime env with the
  # baked value; this makes the baked file a fallback, not an override.
  if [ -f /etc/ensembleworks-connect.env ]; then
  	while IFS='=' read -r key val; do
  		case "$key" in ''|'#'*) continue ;; esac   # skip blanks + the header comment
  		[ -n "${!key:-}" ] && continue             # runtime value present — keep it
  		val=${val#\'}; val=${val%\'}               # strip the single-quotes emit() added
  		export "$key=$val"
  	done < /etc/ensembleworks-connect.env
  fi

  # Fail loudly once instead of an infinite 2s crash loop when unconfigured.
  if [ -z "${ENSEMBLEWORKS_URL:-}" ]; then
  	echo "[ensembleworks-connect] ENSEMBLEWORKS_URL unset — set the 'url' feature option or inject it at runtime" >&2
  	exit 1
  fi

  # label/gateway-id are FLAGS (no env form). Pass --label ONLY when non-empty:
  # resolveConnectConfig uses `label = flags.label ?? hostname()`, so --label ""
  # would set an EMPTY label, NOT fall back to hostname. Omitting the flag is what
  # gives the hostname default. Likewise pass --gateway-id ONLY when pinned — an
  # empty id lets the CLI derive its stable per-box id (spec §4.1).
  args=(terminal connect)
  [ -n "${EW_LABEL:-}" ] && args+=(--label "$EW_LABEL")
  [ -n "${EW_GATEWAY_ID:-}" ] && args+=(--gateway-id "$EW_GATEWAY_ID")

  while true; do
  	ensembleworks "${args[@]}"
  	echo "[ensembleworks-connect] connector exited ($?), restarting in 2s" >&2
  	sleep 2
  done
  ```

- [ ] **Make both executable:**
  ```bash
  chmod +x deploy/features/ensembleworks-cli/entrypoint.sh deploy/features/ensembleworks-cli/supervisor.sh
  ```

### Step 3 — Task gate (shellcheck + `bash -n`)

- [ ] **Lint + parse both:**
  ```bash
  nix run nixpkgs#shellcheck -- deploy/features/ensembleworks-cli/entrypoint.sh deploy/features/ensembleworks-cli/supervisor.sh
  for f in entrypoint supervisor; do bash -n deploy/features/ensembleworks-cli/$f.sh; done
  ```
  Expected: both exit 0, no shellcheck findings — the supervisor reads the env
  file with `read` (no `.`/`source`), so there is no SC1091, and the `args=(…)`
  bash array + `${!key}` indirect expansion are valid under the `bash` shebang.

- [ ] **Commit:**
  ```bash
  git add deploy/features/ensembleworks-cli/entrypoint.sh deploy/features/ensembleworks-cli/supervisor.sh
  git commit -m "$(cat <<'EOF'
  feat(deploy): ensembleworks-cli feature entrypoint + supervisor (#8)

  entrypoint.sh chains ahead of the container's main command as persistent init:
  setsid-launches supervisor.sh in the background (pgrep liveness check, not a flag
  file), then exec "$@". supervisor.sh sources /etc/ensembleworks-connect.env
  KEY-BY-KEY skipping keys already set at runtime (rotated runtime token wins over
  a stale baked one), fails loud once on missing ENSEMBLEWORKS_URL instead of a 2s
  crash-loop, and runs `ensembleworks terminal connect` with --label / --gateway-id
  appended ONLY when non-empty (so the CLI's hostname / stable-per-box-id defaults
  apply). Same background pattern as the retired Go termgw feature. shellcheck +
  bash -n clean.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 5 — `tmux-ensembleworks.conf` committed copy + byte-identical diff check

A devcontainer feature ships self-contained (spec §2, §5.1): it cannot reach
`../../tmux-ensembleworks.conf` at install time, so it carries its own committed
copy, kept byte-identical to the canonical `deploy/tmux-ensembleworks.conf` by the
V4 diff gate. Copy the file — do not retype it — so the copy is byte-exact.

### Step 1 — Copy the canonical conf + verify it is byte-identical (V4)

- [ ] **Copy it:**
  ```bash
  cp deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf
  ```

- [ ] **V4 — byte-identical diff check:**
  ```bash
  diff deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf && echo "V4 OK: byte-identical"
  ```
  Expected: no diff output, prints `V4 OK: byte-identical`, exit 0.

- [ ] **Commit:**
  ```bash
  git add deploy/features/ensembleworks-cli/tmux-ensembleworks.conf
  git commit -m "$(cat <<'EOF'
  feat(deploy): ensembleworks-cli feature — committed byte-identical tmux conf (#8)

  A devcontainer feature ships self-contained (spec §5.1) and cannot reach the
  repo-root deploy/tmux-ensembleworks.conf at install time, so it carries its own
  committed copy. Kept byte-identical to the canonical conf by the V4 diff gate;
  containerEnv.TMUX_CONF (manifest) points the connector at the installed copy.

  Co-Authored-By: Claude <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC
  EOF
  )"
  ```

---

## Task 6 — Final gate: V1–V6 + typecheck + full suite + build

Run the whole merge gate as one evidence-producing pass. V1–V6 are the hard,
runnable-now gate; V7 is release-gated and documented, not run (unless a release
asset exists).

### Step 1 — V1–V6 (the runnable merge gate)

- [ ] **V1 — manifest is valid JSON:**
  ```bash
  jq . deploy/features/ensembleworks-cli/devcontainer-feature.json >/dev/null && echo "V1 OK"
  ```
  Expected: `V1 OK`, exit 0.

- [ ] **V2 — shell scripts lint clean:**
  ```bash
  nix run nixpkgs#shellcheck -- \
    deploy/features/ensembleworks-cli/install.sh \
    deploy/features/ensembleworks-cli/entrypoint.sh \
    deploy/features/ensembleworks-cli/supervisor.sh && echo "V2 OK"
  ```
  Expected: `V2 OK`, exit 0, no findings.

- [ ] **V3 — shell scripts parse:**
  ```bash
  for f in install entrypoint supervisor; do bash -n deploy/features/ensembleworks-cli/$f.sh; done && echo "V3 OK"
  ```
  Expected: `V3 OK`, exit 0.

- [ ] **V4 — tmux conf in sync (byte-identical):**
  ```bash
  diff deploy/tmux-ensembleworks.conf deploy/features/ensembleworks-cli/tmux-ensembleworks.conf && echo "V4 OK"
  ```
  Expected: no diff, `V4 OK`, exit 0.

- [ ] **V5 — token scrub (TDD, §4.2):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun contracts/src/session-manager.test.ts
  ```
  Expected: prints `ok: TmuxSession primitive` **and**
  `ok: canvasTmuxSpawnSpec scrubs the service-token from the spawned terminal env`,
  exit 0.

- [ ] **V6 — connect invocation matches real flags (contract check):**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun cli/src/main.ts --url https://x.test terminal connect --label demo --gateway-id demo-1 --dry-run
  ```
  Expected: prints the `ConnectConfig` JSON below and exits 0 — proving the
  supervisor's invocation (`terminal connect --label … [--gateway-id …]`, URL via
  `--url`/env) is exactly what `parseConnectFlags`/`resolveConnectConfig` accept:
  ```json
  {
    "url": "https://x.test",
    "wsUrl": "wss://x.test/api/terminal/connect?gatewayId=demo-1&label=demo",
    "room": "team",
    "gatewayId": "demo-1",
    "label": "demo",
    "authMethod": "none"
  }
  ```
  (Spec §8 phrases V6 against "the built CLI"; running the source entry
  `cli/src/main.ts` on this branch is equivalent for the flag-contract check and
  needs no `bun run build` first. If you prefer the built binary, run
  `bun run build` first and invoke `dist/ensembleworks` — same output.)

### Step 2 — Repo-wide gate

- [ ] **typecheck + full suite + build:**
  ```bash
  export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"
  bun run typecheck
  bun run test
  bun run build
  ```
  Expected: `typecheck` exit 0; `bun run test` ends **`all 59 suites passed`**
  (the scrub is a new *case* inside `session-manager.test.ts`, which the runner
  counts as one suite file — see the suite-count reconciliation at the top; the
  `contracts/src/session-manager.test.ts` block in the run output shows both
  `ok:` lines); `bun run build` exit 0.

### Step 3 — V7 (release-gated — document, do not gate on it)

- [ ] **V7 — feature builds + installs (smoke). Run ONLY if a published
  `ensembleworks-<arch>` release asset exists** (present after #7's
  `release-cli.yml` has run for any tag). Otherwise skip and record V7 as the
  first-post-#7-tag follow-up.
  ```bash
  # In a throwaway dir with a minimal devcontainer.json referencing the feature
  # with a PINNED version, e.g.:
  #   { "features": { "<repo>/deploy/features/ensembleworks-cli": { "url": "https://x.test", "version": "0.11.0" } } }
  devcontainer build --workspace-folder <throwaway>
  devcontainer exec --workspace-folder <throwaway> ensembleworks --version
  # then confirm the supervisor started (it loops dialing https://x.test — the
  # expected "configured but no server" behaviour):
  devcontainer exec --workspace-folder <throwaway> cat /tmp/ensembleworks-connect.log
  ```
  Expected (when a release exists): the binary is present and prints its version;
  `/tmp/ensembleworks-connect.log` shows the supervisor started and is retrying
  the dial. Point `url` at a real instance to see it register.

### Step 4 — Finish

- [ ] **No further commit** — Tasks 1–5 already committed each deliverable. If any
  final-gate step required a fix, commit that fix with the standard trailer before
  declaring the slice done.
- [ ] **Report** the merge-gate result: V1–V6 green (runnable now); V7 green if a
  release asset exists, else documented as the release-gated follow-up. The full
  suite reports `all 59 suites passed`; `bun run build` green. The slice does
  **not** delete `gateway-go/termgw-feature/` (Phase E owns that).
