# Distribution & artifact deploy — CI-compiled binaries, fetch-verify-swap `deploy.sh`, the cutover choreography

**Phase 3, sub-project #7 — distribution + artifact deploy.** One CI workflow
(`release-cli.yml`, retiring `release-termgw.yml`) that cross-compiles the
`ensembleworks` CLI, the `ensembleworks-server`, and the
`ensembleworks-transcriber` into standalone Bun binaries on every `v*` tag and
uploads them to the GitHub release alongside `client-dist.tar.gz`, `install.sh`
and `ensembleworks-checksums.txt`; a rewritten `deploy/deploy.sh` that
**fetches** those artifacts instead of building on the box, **verifies** them
(checksum + a hermetic pre-swap boot-check of the fetched server binary), then
does the atomic `current` symlink swap + `systemctl restart` it does today; the
three prod systemd units re-pointed from `npm run …` to absolute binary paths
with `CANVAS_*` → `ENSEMBLEWORKS_*` env (the term unit's `KillMode=process`
tmux-survival preserved verbatim); a separate one-shot `deploy/cutover.sh` for
the one-time data-load-check + `DATA_DIR` backup + env/SKILL reseed that then
calls `deploy.sh`; and a posture-era guard that stops `deploy.sh` swapping
`current` across the Phase-3 boundary.

Conforms to the plugin-architecture track charter
(`2026-07-06-plugin-architecture-track-charter.md`) §"#7 — Distribution / #8 —
Cutover" and to `docs/unified-architecture-design.md` §6.5 (CI-compiled
artifacts) + §7 (the Phase-3 row + §7.1 keels). Consumes the compile-compat
contracts the CLI (#4), connector (#5) and transcriber (#6) already owe #7
(static imports, real-FS paths, an existing `build:binary`). House style follows
`2026-07-06-connector-design.md`.

**The core compile/boot claims were proven** on this branch with Bun 1.3.14
before writing (§10.4 records exactly which probes ran vs which are specified but
unrun): the single `ensembleworks-server` binary compiles both entrypoints
(561 modules) and its **sync** mode boot-checks green (`GET /api/health` →
`200 {"ok":true,"rooms":[]}` from the compiled binary on a scratch
`DATA_DIR`/`CLIENT_DIST`/port); CLI + server cross-compile to all targets from one
x64 runner; the transcriber's native addon does **not** cross-compile
(§4.2).

---

## 1. Scope boundary — what #7 is and is not

**#7 IS:**

- **The release CI workflow.** `.github/workflows/release-cli.yml` (replacing
  `release-termgw.yml`), triggered by the same `v*` tag `release.sh` already
  pushes: a build matrix that cross-compiles the three binaries per os/arch,
  builds `client-dist.tar.gz`, generates `install.sh` + `ensembleworks-checksums.txt`,
  and uploads all of them to the tag's GitHub release.
- **The three compile entries/scripts.** `server/src/main.ts` (a 5-line
  subcommand dispatcher so ONE `ensembleworks-server` binary runs both `sync`
  and `term` — §3.1); a `build:binary` npm script per workspace
  (`server`, `cli`, `transcriber`) with the per-target `--target` flags; a
  `--check` flag added to `transcriber/src/transcriber.ts` so the addon-linked
  binary is hermetically boot-checkable (§3.3).
- **The `deploy.sh` rewrite** from build-on-box to fetch-verify-swap: download
  the tag's assets into `~/releases/<ver>/`, verify checksums, extract
  `client-dist.tar.gz` alongside, run the pre-swap boot-check, stamp the
  posture-era marker, swap `current`, restart the units, prune to `KEEP` — the
  preflight/sandbox-seed/Caddy/`current`-symlink skeleton is preserved.
- **The three prod systemd unit rewrites** (`deploy/systemd/prod/*.service`):
  `ExecStart` → absolute binary paths, `WorkingDirectory` → the release dir,
  `CANVAS_*` → `ENSEMBLEWORKS_*` on the scribe unit, `CLIENT_DIST` → the
  extracted `client-dist/`. **`KillMode=process` on the term unit is untouched.**
- **`deploy/cutover.sh`** — the one-time choreography as a concrete script:
  data-load check against production copies, `DATA_DIR` backup (era-exempt),
  env + SKILL reseed, then `EW_ALLOW_ERA_CROSS=1 deploy/deploy.sh …`.
- **The posture-era guard** — a `deploy/posture-era` committed marker, stamped
  into each release dir as `.ew-era`; `deploy.sh` refuses a `current` swap
  across eras unless `EW_ALLOW_ERA_CROSS=1` (the cutover path).
- **`install.sh`** — the remote-box CLI bootstrap asset (arch-detect, checksum
  verify, `~/.local/bin/` install with the `ew` hardlink) the design §6.5
  bootstrap curls.

**#7 is NOT:**

- **The production cutover RUN.** Executing `cutover.sh` against the live box,
  restarting the real terminal agents, and having users hard-refresh is **#8**
  (the user's operation). #7 delivers the *machinery* and a **dry-run proof**
  (§10.3, the local fake-release round-trip) — nothing is run against prod.
- **Retiring `gateway-go/`, `connect.sh`, `bin/canvas`, node-pty, or Node on
  hosts.** Those deletions are **#8** (charter §7 Phase-3 "Retires" column).
  `release-termgw.yml` is the one retirement #7 makes (its artifact is replaced
  by `ensembleworks-<os>-<arch>`); everything else lands *alongside*.
- **The devcontainer feature rewrite** (`termgw-feature` → `ensembleworks-cli`
  feature). #8 (charter §"#5", connector spec §1). #7 only ships `install.sh`
  and the CLI artifact the feature will exec.
- **Any product/route/schema change.** The `/api/<plugin>/…` route table (3a),
  Caddy prefix split (3a), attribution (3c), manifest (3b) are done; `#7` moves
  no route and edits no Caddyfile.
- **New auth, gateway-id, or connector behaviour.** #4/#5 pinned those; #7 only
  compiles them.
- **musl / Alpine targets.** Deferred until an Alpine box exists (charter §7;
  the shipped addon is `-gnu` only — §4.2).

---

## 2. Decisions settled in this spec

| # | Decision | § |
|---|---|---|
| D1 | **One `ensembleworks-server` binary, two subcommands.** A new `server/src/main.ts` dispatcher (`process.argv[2]` → `sync`\|`term`, literal-specifier dynamic `import()` so only the selected entrypoint's top-level runs) is the single server compile entry. No refactor of `sync-server.ts` / `terminal-gateway.ts` — their load-bearing bodies (incl. tmux survival) are untouched. Ran: 561-module compile of the real dispatcher + sync-mode boot-check green; the toy dispatcher confirmed only-selected-module execution for both modes. | 3.1 |
| D2 | **Asset names follow design §6.5 exactly:** CLI = `ensembleworks-<os>-<arch>` (the eponymous artifact — its "component" is the base name), server = `ensembleworks-server-<os>-<arch>`, transcriber = `ensembleworks-transcriber-<os>-<arch>`; plus `client-dist.tar.gz`, `install.sh`, `ensembleworks-checksums.txt`. `<arch>` ∈ {`x64`,`arm64`} (Bun-native spelling, matches `--target bun-linux-x64`). | 3.2 |
| D3 | **Build matrix:** server + CLI cross-compile from a single `ubuntu-latest` (x64) runner to all targets (linux-x64, linux-arm64; CLI also darwin-arm64). The **transcriber is built natively per arch** — x64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm` — because its embedded `@livekit/rtc-ffi-bindings` `.node` addon is resolved for the *build host* and does not cross-compile. | 4 |
| D4 | **Boot-check is per-binary and hermetic.** Server: run `ensembleworks-server sync` on a scratch `DATA_DIR`/`CLIENT_DIST`/ephemeral port, poll `GET /api/health` → `200`, kill; then `ensembleworks-server term` on a scratch port (no `TERM_RUN_AS`), poll `GET /api/terminal/health` → `200`, kill. Transcriber: `ensembleworks-transcriber --check` (new flag: addon links + config parses → exit 0). No routine deploy exercises the LiveKit pipeline — that stays the #6 e2e-gate, run at cutover/CI-smoke. | 3.3, 6.3 |
| D5 | **`deploy.sh` fetches with `gh release download`** (the `gh` CLI is already a host requirement class; falls back to `curl` from the release download URL). A `--build-from-source` escape hatch (design §6.5) re-runs the old worktree+build path for unpushed branches/dev boxes. | 6.1 |
| D6 | **`CLIENT_DIST` ships alongside, extracted** — `client-dist.tar.gz` → `~/releases/<ver>/client-dist/`; the sync unit's `CLIENT_DIST` points there. Not embedded in the binary (Spike A: the compiled server needs an explicit `CLIENT_DIST`). | 6.2, 7.1 |
| D7 | **Posture-era guard = a `deploy/posture-era` file** (contents e.g. `unified-1`), copied to `~/releases/<ver>/.ew-era`. Absent = the implicit `legacy` era (pre-cutover dirs). `deploy.sh` refuses to swap `current` when `new-era ≠ live-era` unless `EW_ALLOW_ERA_CROSS=1`. | 9 |
| D8 | **The cutover `DATA_DIR` backup lives OUTSIDE `~/releases/`** (`~/backups/pre-cutover-<ts>/`), so the releases-only `KEEP` prune can never touch it — no sentinel needed. | 8, 9 |
| D9 | **Suite count unchanged: 58 → 58.** #7 is scripts + CI + units + a 5-line dispatcher + a `--check` guard; deploy scripts are not `bun`-runner unit tests. Verification is `shellcheck`, a `deploy.sh --dry-run`, and a local fake-release round-trip (§10). | 10 |

---

## 3. The compile entries & scripts

### 3.1 `ensembleworks-server` — one binary, `sync`\|`term` (D1)

The two server processes stay two processes (charter: three units), but they
ship as **one binary** dispatched by a subcommand — matching design §6.5's single
`ensembleworks-server` asset and avoiding any edit to the two entrypoint bodies.
New file:

```ts
// server/src/main.ts — the ensembleworks-server compile entry.
// `ensembleworks-server sync` (default) runs the sync/kernel server; `… term`
// runs the terminal gateway. Literal-specifier dynamic import() means bun bundles
// BOTH entrypoints into the binary but only the selected one's top-level executes
// (ES modules evaluate on first import) — so exactly one server.listen() fires.
const mode = process.argv[2] ?? 'sync'
if (mode === 'term') await import('./terminal-gateway.ts')
else if (mode === 'sync') await import('./sync-server.ts')
else {
	console.error(`ensembleworks-server: unknown mode '${mode}' (expected sync|term)`)
	process.exit(2)
}
```

`sync-server.ts` and `terminal-gateway.ts` are **not modified** — they keep their
top-level `server.listen(PORT, …)` and their `PORT`/`DATA_DIR`/`CLIENT_DIST`/
`TMUX_CONF` env reads. In a compiled binary the `import.meta.dirname` fallbacks
resolve into the bundle's virtual FS, so the units set every path env explicitly
(§7) — Spike A's `CLIENT_DIST` finding, generalised.

> **Deliberate exception to the connector spec's "static imports only" compile
> rule (#5 §8) — do NOT "fix" this to top-level `import` statements.** The two
> `import()` calls are **statically bundlable**: their specifiers are string
> *literals*, so `bun build --compile` resolves and embeds **both** modules into
> the binary at bundle time (the 561-module count includes both entrypoints) —
> there is no runtime path resolution, which is the thing #5 §8's rule actually
> guards against. What the dynamic form buys that a static top-level `import`
> cannot: **deferred evaluation.** A top-level `import './sync-server.ts'` +
> `import './terminal-gateway.ts'` would evaluate *both* modules at startup and
> fire *both* `server.listen()` calls (double-bind, instant crash). ES modules
> evaluate on first `import()`, so awaiting exactly one runs exactly one listener.
> This is the one place in the codebase where a literal dynamic import is correct
> by design; it is proven (§10.4) and load-bearing.

### 3.2 The per-workspace `build:binary` scripts (D2)

`transcriber/package.json` already has the pattern
(`bun build --compile --sourcemap src/transcriber.ts --outfile dist/…`). #7 adds
the matching scripts to `server` and `cli`, each parameterised by an env target so
the CI matrix picks the arch (default = the host, for a dev `bun run build:binary`):

```jsonc
// server/package.json
"build:binary": "bun build --compile --sourcemap --target=${EW_TARGET:-bun-linux-x64} src/main.ts --outfile dist/ensembleworks-server"
// cli/package.json
"build:binary": "bun build --compile --sourcemap --target=${EW_TARGET:-bun-linux-x64} src/main.ts --outfile dist/ensembleworks"
// transcriber/package.json (generalise the existing script)
"build:binary": "bun build --compile --sourcemap --target=${EW_TARGET:-bun-linux-x64} src/transcriber.ts --outfile dist/ensembleworks-transcriber"
```

(`bun run` executes scripts via a shell that expands `${EW_TARGET:-…}`.) The CI
job renames `dist/<name>` → `<name>-<os>-<arch>` before upload (§4). Binaries are
~90–116 MB, glibc-only, sourcemap-embedded (`--sourcemap`; the emitted external
`.map` is a build byproduct, not shipped).

### 3.3 The transcriber `--check` flag (D4 boot-check)

The transcriber has no HTTP surface and cannot reach a real SFU hermetically, so
its deploy boot-check proves the one thing a *fetched* binary can go wrong on —
addon/arch integrity — not the pipeline. A guard added immediately after the
top-level `@livekit/rtc-node` import (which has already linked the native addon
by the time the line runs) and config read:

```ts
// transcriber/src/transcriber.ts — after the readScribeEndpoint(...) / STT_* reads:
if (process.argv.includes('--check')) {
	// The rtc-node import above has loaded the embedded native addon; the config
	// reads above have parsed the env. Reaching here == the binary is intact for
	// this arch. No room.connect() — pipeline correctness is the #6 e2e-gate's job.
	console.log(`scribe --check ok (${SYNC_ROOM} @ ${SYNC_URL})`)
	process.exit(0)
}
```

The full-pipeline gate is unchanged: `transcriber/src/e2e-gate.ts --strict`
against a live SFU (charter user-decision 6), run in the CI smoke job (§4) and by
`cutover.sh` (§8), never by a routine deploy.

---

## 4. The release CI workflow (`.github/workflows/release-cli.yml`)

Replaces `release-termgw.yml` (deleted). Same trigger — `push: tags: ['v*']` —
so `release.sh`'s existing flow is unchanged: it bumps + tags + pushes, the tag
fires this workflow, the artifacts land on the release, `deploy.sh` fetches them.

### 4.1 Why two runner classes (D3)

Proven on this branch: `bun build --compile --target=bun-{linux-x64,linux-arm64,darwin-arm64}`
of the **CLI** and **server** all succeed from one linux-x64 host (pure JS; the
darwin runtime is fetched, ~6 s). The **transcriber cannot cross-compile**:
`node_modules/@livekit/` carries only `rtc-ffi-bindings-linux-x64-gnu/…​.node`
(the host's prebuild); a `--target=bun-linux-arm64` transcriber build *succeeds*
but silently embeds the **x64** addon → it would fault on arm64. So each
transcriber arch is built on a native runner, where `bun install` resolves that
arch's `@livekit/rtc-ffi-bindings-<arch>-gnu` addon.

### 4.2 The matrix

| Job | Runner | `bun install` | Produces (`EW_TARGET`) |
|---|---|---|---|
| `binaries` | `ubuntu-latest` | root install | CLI + server for `bun-linux-x64`, `bun-linux-arm64`; CLI for `bun-darwin-arm64` (5 files) |
| `transcriber-x64` | `ubuntu-latest` | root install | transcriber `bun-linux-x64` |
| `transcriber-arm64` | `ubuntu-24.04-arm` | root install | transcriber `bun-linux-arm64` |
| `client-dist` | `ubuntu-latest` | root install | `bun --bun run build` (client) → `client-dist.tar.gz` |
| `smoke` | `ubuntu-latest` | — | boots the x64 server binary, asserts `/api/health` + a room sync (design §6.5); runs the transcriber `--check` |
| `publish` | `ubuntu-latest` | — | rename to `<name>-<os>-<arch>`, generate `install.sh` + `ensembleworks-checksums.txt`, upload |

`<os>-<arch>` spelling maps `bun-linux-x64`→`linux-x64`, `bun-darwin-arm64`→
`darwin-arm64` (strip the `bun-` prefix; `x64`/`arm64` already match). Sketch of
the core job:

```yaml
name: release-cli
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  binaries:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Compile CLI + server (cross-compiled)
        run: |
          set -euo pipefail
          mkdir -p out
          for pair in linux-x64 linux-arm64 darwin-arm64; do
            EW_TARGET="bun-$pair" bun --cwd cli run build:binary
            cp cli/dist/ensembleworks "out/ensembleworks-$pair"
            case "$pair" in linux-*)   # server ships linux only
              EW_TARGET="bun-$pair" bun --cwd server run build:binary
              cp server/dist/ensembleworks-server "out/ensembleworks-server-$pair" ;;
            esac
          done
      - uses: actions/upload-artifact@v4
        with: { name: binaries, path: out/ }
  # transcriber-x64 / transcriber-arm64: identical but a single native EW_TARGET,
  #   `bun --cwd transcriber run build:binary`, upload ensembleworks-transcriber-<pair>.
  client-dist:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.14 }
      - run: bun install --frozen-lockfile
      - name: Build the client bundle (license key baked in — §4.3)
        env:
          # Build-time Vite var; tldraw enforces its licence on real prod domains,
          # so it MUST be present or the shipped bundle renders a blank editor.
          VITE_TLDRAW_LICENSE_KEY: ${{ secrets.VITE_TLDRAW_LICENSE_KEY }}
        run: |
          set -euo pipefail
          : "${VITE_TLDRAW_LICENSE_KEY:?FATAL: VITE_TLDRAW_LICENSE_KEY secret is unset — refusing to ship a blank-canvas bundle (§4.3)}"
          bun --bun run --filter @ensembleworks/client build
          tar czf client-dist.tar.gz -C client/dist .
      - uses: actions/upload-artifact@v4
        with: { name: client-dist, path: client-dist.tar.gz }
  publish:
    needs: [binaries, transcriber-x64, transcriber-arm64, client-dist, smoke]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { path: dl }
      - name: Assemble, checksum, install.sh
        run: |
          set -euo pipefail
          mkdir rel && find dl -type f \( -name 'ensembleworks-*' -o -name 'client-dist.tar.gz' \) -exec cp {} rel/ \;
          cp deploy/install.sh rel/install.sh            # committed template (§5)
          ( cd rel && sha256sum ensembleworks-* client-dist.tar.gz > ensembleworks-checksums.txt )
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          generate_release_notes: true
          files: rel/*
```

The `smoke` job is the design §6.5 requirement — it boots the **compiled** x64
binaries (not source-under-Bun), the same boot-check `deploy.sh` runs (§6.3),
plus a room-sync WS assertion, and `ensembleworks-transcriber --check`.

### 4.3 The tldraw licence key — the one build-time secret (BLOCKING gap closed)

Moving the client build from the box into CI moves it **away from the box-local
`~/.config/ensembleworks/build.env`** that the old build-on-box path sourced
(deploy.sh:138–141) to bake `VITE_TLDRAW_LICENSE_KEY` into the bundle. `VITE_*`
vars are **build-time baked**: tldraw enforces its licence on real production
domains, and without the key the editor renders **blank** (README:406–407) — the
entire product. No downstream layer catches this: the boot-check only asserts
`/api/health` 200 + that static files serve; the CI `smoke` job boots the
*server* + a sync-WS assertion; neither renders the licence-gated canvas. So the
key must be wired at the one place the bundle is built:

- **The key is a GitHub Actions secret** `VITE_TLDRAW_LICENSE_KEY`, injected into
  the `client-dist` job's build `env` (above). It never enters a binary, a
  checksum, or the box — it lives only in the client bundle inside
  `client-dist.tar.gz`.
- **A release built without the secret fails the CI job loudly, not silently.**
  The `: "${VITE_TLDRAW_LICENSE_KEY:?…}"` guard aborts the `client-dist` job (and
  therefore `publish`, which `needs` it) before producing a bundle — there is no
  path that uploads a blank-canvas `client-dist.tar.gz`. Fork/PR builds without
  the secret fail here by design; that is the intended fail-closed behaviour.
- **The local fake-release / `--dry-run` path CANNOT validate this** — no key is
  present off-CI, so a locally-built `client-dist.tar.gz` is a blank bundle by
  construction. §10 states this explicitly: the local round-trip proves the
  fetch/verify/boot/swap *machinery*, never the licence bake.
- **Because no automated layer can catch a blank canvas, the cutover checklist
  carries an explicit manual gate** (§8, step 5): after the swap, load the prod
  canvas in a browser and confirm the editor **renders** (shapes/toolbar visible,
  not a blank frame). This is the only check that exercises the licence path end
  to end, so it is mandatory and manual.

---

## 5. `install.sh` (remote-box CLI bootstrap)

A committed `deploy/install.sh`, uploaded verbatim as a release asset, is what
the design §6.5 one-liner curls. It absorbs `connect.sh`'s habits: arch-detect,
`ENSEMBLEWORKS_VERSION` pin (default `latest`), checksum-verify against
`ensembleworks-checksums.txt`, install to `~/.local/bin/ensembleworks` + the `ew`
hardlink. CLI-only (a box that connects a terminal needs only the CLI; the server/
transcriber binaries are deploy-side).

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO="lean-software-production/ensembleworks"
VER="${ENSEMBLEWORKS_VERSION:-latest}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  A=linux-x64 ;;  Linux-aarch64) A=linux-arm64 ;;
  Darwin-arm64)  A=darwin-arm64 ;;
  *) echo "unsupported platform $(uname -sm)" >&2; exit 1 ;;
esac
base="https://github.com/$REPO/releases/${VER/latest/latest/download}"
[ "$VER" = latest ] || base="https://github.com/$REPO/releases/download/v$VER"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/ensembleworks-$A" -o "$tmp/ew"
curl -fsSL "$base/ensembleworks-checksums.txt" -o "$tmp/sums"
( cd "$tmp" && grep " ensembleworks-$A\$" sums | sed "s/ensembleworks-$A/ew/" | sha256sum -c - )
install -D -m0755 "$tmp/ew" "$HOME/.local/bin/ensembleworks"
ln -f "$HOME/.local/bin/ensembleworks" "$HOME/.local/bin/ew"
echo "installed ensembleworks ($A) → ~/.local/bin (ew hardlink). Next: ensembleworks auth login"
```

---

## 6. The `deploy.sh` rewrite — fetch → verify → swap

The current script's skeleton is **kept**: local support-file `scp`, the remote
preflight (host-dep manifest, app/agent users, launcher, sudoers), the
sandbox-user seed, the Caddyfile install, the `current` symlink swap +
`daemon-reload`/`restart`, the `KEEP` prune, the readiness poll. What changes is
the **release-build stage** (worktree + `npm ci` + `npm run build`) → **fetch +
verify**, and the addition of the boot-check + era stamp.

### 6.1 Fetch (replaces the worktree/build block, D5)

```bash
# ---- fetch the tag's artifacts (was: git worktree + npm ci + npm run build) --
NEW="${RELEASES}/${VERSION}"
if asapp test -f "${NEW}/.ew-verified"; then
  echo "==> ${VERSION} already fetched+verified — swapping (rollback path)"
else
  asapp mkdir -p "${NEW}"
  echo "==> fetching v${VERSION} artifacts"
  # gh (host-provisioned, authed via the app user's token) into the release dir;
  # --build-from-source re-runs the legacy worktree+build path (design §6.5).
  asapp env GH_TOKEN="…" gh release download "v${VERSION}" -R "${REPO_SLUG}" \
    -D "${NEW}" --clobber \
    -p 'ensembleworks-*' -p 'client-dist.tar.gz' -p 'ensembleworks-checksums.txt'
  echo "==> verifying checksums"
  asapp bash -c "cd '${NEW}' && sha256sum -c ensembleworks-checksums.txt --ignore-missing"
  # keep the three linux-<arch> binaries this box needs; drop the other arch/os.
  ARCH="$(asapp uname -m)"; case "$ARCH" in x86_64) A=linux-x64;; aarch64) A=linux-arm64;; esac
  asapp mv "${NEW}/ensembleworks-server-$A"      "${NEW}/ensembleworks-server"
  asapp mv "${NEW}/ensembleworks-transcriber-$A" "${NEW}/ensembleworks-transcriber"
  asapp mv "${NEW}/ensembleworks-$A"             "${NEW}/ensembleworks"
  asapp chmod +x "${NEW}"/ensembleworks*
  asapp mkdir -p "${NEW}/client-dist"
  asapp tar xzf "${NEW}/client-dist.tar.gz" -C "${NEW}/client-dist"   # CLIENT_DIST alongside (D6)
fi
```

### 6.2 Extract & stamp

`client-dist.tar.gz` → `~/releases/<ver>/client-dist/`; the sync unit's
`CLIENT_DIST` points there (§7.1). The posture-era marker (§9) is stamped from
the scp'd `deploy/posture-era` **before** the swap: `asapp cp /tmp/ew-posture-era
"${NEW}/.ew-era"`.

### 6.3 Pre-swap boot-check (D4) — the verify half of the charter's contract

Before touching `current`, boot the fetched binaries hermetically. **This whole
function lives in `deploy/lib.sh` (a shell function, not inline in the remote
heredoc), so `--dry-run` and `fake-release.sh` can source and run it against a
locally-fetched release dir (§10.2–10.3)** — the remote heredoc calls
`ew_boot_check "${NEW}"` after sourcing `/tmp/ew-lib.sh` (already scp'd). Ports
are genuinely ephemeral (a free port is picked per boot, matching D4's wording);
a collision-losing bind just fails the check closed (`code≠200` → refuse swap).

```bash
# deploy/lib.sh — sourced on the box AND locally by --dry-run / fake-release.sh.
# NOTE: prod hosts carry NO JS runtime (the whole point of artifact deploys), so
# the free-port finder is shell-native (ss/iproute2, present on the glibc boxes).
ew_free_port() {   # first high port with no listener; fail-closed if none in range
  local p
  for p in $(seq 8790 8890); do
    ss -ltnH "sport = :$p" 2>/dev/null | grep -q . || { echo "$p"; return 0; }
  done
  echo 8798   # exhausted: the server bind then loses → ew_poll_health fails closed
}
ew_poll_health() { # $1 url  -> 0 iff it goes 200 before the pid ($2) dies / times out
  local url="$1" pid="$2" code=000
  for _ in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || true)"
    [ "$code" = 200 ] && return 0
    kill -0 "$pid" 2>/dev/null || return 1
    sleep 0.25
  done
  return 1
}
# $1 = release dir; $2 = a launcher prefix ("" locally, "sudo -u $APP_USER" on the box).
ew_boot_check() {
  local NEW="$1" run="${2:-}" ddir cdir port pid ok=1
  ddir="$($run mktemp -d)"; cdir="$($run mktemp -d)"
  # --- server sync mode: /api/health must go 200 ---
  port="$(ew_free_port)"
  $run env PORT="$port" DATA_DIR="$ddir" CLIENT_DIST="$cdir" \
    "${NEW}/ensembleworks-server" sync >/tmp/ew-bootcheck-sync.log 2>&1 & pid=$!
  ew_poll_health "http://127.0.0.1:$port/api/health" "$pid" || { echo "boot-check FAILED: server sync" >&2; ok=0; }
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  # --- server term mode: /api/terminal/health must go 200 (NO TERM_RUN_AS: the
  #     health handler never spawns tmux, so this is side-effect-free) ---
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
```

On the box the swap block calls it and refuses the swap on failure:

```bash
if ! ew_boot_check "${NEW}" "sudo -u ${APP_USER}"; then
  echo "==> refusing to swap: boot-check failed on v${VERSION}" >&2; exit 1
fi
asapp touch "${NEW}/.ew-verified"
```

The CLI binary is boot-checked by the sandbox-seed step (`ensembleworks version`
exit 0 after install, §6.4) rather than in `ew_boot_check`, since it is installed
to `/usr/local/bin`, not run as a unit.

### 6.4 Sandbox seed & swap — every worktree source re-homed (exhaustive)

The fetch-verify-swap release dir is **artifacts-only** (three binaries +
`client-dist/`), so **every** file the old deploy.sh installed from `${NEW}/bin/`
or `${NEW}/deploy/` (deploy.sh:187–221) loses its source and must be re-homed.
The complete mapping — nothing omitted:

| Old source (worktree `${NEW}/…`) | Destination | New source |
|---|---|---|
| `bin/canvas` | `/usr/local/bin/canvas` (retired) → `/usr/local/bin/ensembleworks` + `ew` hardlink | **release artifact** `${NEW}/ensembleworks` |
| `bin/gh-app-token.bash` | `/usr/local/bin/gh-app-token.bash` | scp → `/tmp/ew-gh-app-token.bash` |
| `deploy/ensembleworks-gh-token` | `/usr/local/bin/ensembleworks-gh-token` | scp → `/tmp/ew-ensembleworks-gh-token` |
| `deploy/tmux-ensembleworks.conf` | `/etc/ensembleworks/tmux.conf` | scp → `/tmp/ew-tmux.conf` |
| `deploy/agent-home/AGENTS.md` | `${AGENT_HOME}/AGENTS.md` | scp → `/tmp/ew-agent-home/AGENTS.md` |
| `deploy/agent-home/.claude/CLAUDE.md` | `${AGENT_HOME}/.claude/CLAUDE.md` | scp → `/tmp/ew-agent-home/.claude/CLAUDE.md` |
| `deploy/agent-home/term.env.example` | `${AGENT_HOME}/.config/ensembleworks/term.env` (create-only) | scp → `/tmp/ew-agent-home/term.env.example` |
| `deploy/agent-home/term-env.bashrc` | appended to `${AGENT_HOME}/.bashrc` (marker-gated) | scp → `/tmp/ew-agent-home/term-env.bashrc` |
| `deploy/agent-home/gh-helper.bashrc` | appended to `${AGENT_HOME}/.bashrc` (marker-gated) | scp → `/tmp/ew-agent-home/gh-helper.bashrc` |
| `deploy/posture-era` (new, §9) | `${NEW}/.ew-era` | scp → `/tmp/ew-posture-era` |

So the CLI install line becomes:

```bash
# was: sudo install -m0755 "${NEW}/bin/canvas" /usr/local/bin/canvas
sudo install -m0755 "${NEW}/ensembleworks" /usr/local/bin/ensembleworks
sudo ln -f /usr/local/bin/ensembleworks /usr/local/bin/ew
sudo -u "${AGENT_USER}" /usr/local/bin/ensembleworks version >/dev/null || \
  echo "    warn: installed CLI failed 'version' self-check" >&2
```

and every other `install`/`tee` in that block flips its source from `${NEW}/…`
to the matching `/tmp/ew-…` path above (mechanical — the install *targets*,
modes, owners, and marker-gated `.bashrc` appends are unchanged). The full
canvas/conversation-map/minutes/debugging-roadmap-control **SKILL reseed** is
`cutover.sh`'s job (§8); routine deploys keep re-seeding the AGENTS.md/CLAUDE.md
guidance from the scp'd copies above.

**The scp manifest (deploy.sh:46–57 check list + :271–277 copies) grows
accordingly.** Today it scp's `lib.sh`, `runtime-requirements`, `Caddyfile.prod`,
the three unit templates + the shared-browser slice. It adds, from the operator
checkout: `deploy/posture-era`, `deploy/tmux-ensembleworks.conf`,
`deploy/ensembleworks-gh-token`, `bin/gh-app-token.bash`, and the five
`deploy/agent-home/**` files (a recursive `scp -r deploy/agent-home
"$SSH_TARGET:/tmp/ew-agent-home"`). The existence-check `for f` loop keeps every
one of these (it already lists the agent-home set); only the *copy* stage and the
*install source* change. This is the same operator-checkout-vs-tag skew deploy.sh
already accepts for the unit templates (R2).

---

## 7. The three systemd unit diffs

Only `[Service]` lines change. `[Unit]`/`[Install]`, slice membership,
`MemoryLow`, `Restart`, and — critically — the term unit's `KillMode=process`
block are **byte-for-byte preserved**.

### 7.1 `ensembleworks-sync.service`

```diff
 WorkingDirectory=@APP_HOME@/current/server
+WorkingDirectory=@APP_HOME@/current
 Environment=DATA_DIR=@APP_HOME@/.local/share/ensembleworks
-Environment=CLIENT_DIST=@APP_HOME@/current/client/dist
+Environment=CLIENT_DIST=@APP_HOME@/current/client-dist
-ExecStart=/usr/local/bin/npm run start
+ExecStart=@APP_HOME@/current/ensembleworks-server sync
```

`CLIENT_DIST` → the extracted tarball dir (D6); the `PORT=8788` /
`EnvironmentFile=…/sync.env` lines are unchanged.

### 7.2 `ensembleworks-term.service`

```diff
 WorkingDirectory=@APP_HOME@/current/server
+WorkingDirectory=@APP_HOME@/current
-Environment=TMUX_CONF=@APP_HOME@/current/deploy/tmux-ensembleworks.conf
+Environment=TMUX_CONF=/etc/ensembleworks/tmux.conf
-ExecStart=/usr/local/bin/npm run start:term
+ExecStart=@APP_HOME@/current/ensembleworks-server term
```

**`KillMode=process` and its entire comment block stay.** `npm 10 forwards
SIGTERM to node` in that comment becomes literally truer — `ExecStart` is now the
single binary, so systemd signals it directly (no `npm`→`node` hop), and the
tmux server in the cgroup still survives the restart. `TMUX_CONF` re-points at the
box-wide `/etc/ensembleworks/tmux.conf` `deploy.sh` already installs (there is no
`current/deploy/` in the artifact layout); `PORT=8789` and `TERM_RUN_AS=…` are
unchanged.

### 7.3 `ensembleworks-scribe.service` (the `CANVAS_*` → `ENSEMBLEWORKS_*` swap)

```diff
 WorkingDirectory=@APP_HOME@/current/transcriber
+WorkingDirectory=@APP_HOME@/current
-Environment=CANVAS_URL=http://localhost:8788
-Environment=CANVAS_ROOM=team
+Environment=ENSEMBLEWORKS_URL=http://localhost:8788
+Environment=ENSEMBLEWORKS_ROOM=team
-ExecStartPre=/bin/sh -c 'until curl -s -o /dev/null --connect-timeout 2 "${CANVAS_URL}/"; do sleep 1; done'
+ExecStartPre=/bin/sh -c 'until curl -s -o /dev/null --connect-timeout 2 "${ENSEMBLEWORKS_URL}/"; do sleep 1; done'
-ExecStart=/usr/local/bin/npm run start
+ExecStart=@APP_HOME@/current/ensembleworks-transcriber
```

The transcriber code already reads `ENSEMBLEWORKS_URL`/`_ROOM` (#6); the unit's
lingering `CANVAS_*` env was dead (the binary ignored it, working only by the
localhost/`team` default coincidence) — this makes the env match the code. `STT_*`
lines + `EnvironmentFile=…/scribe.env` unchanged. The header comment's
`${CANVAS_URL}`-is-literal note updates to `${ENSEMBLEWORKS_URL}`.

`deploy.sh`'s unit-install loop (`for u in ensembleworks-sync ensembleworks-term
ensembleworks-scribe`) is untouched — still three units, sed-substituting
`@APP_USER@`/`@APP_HOME@`. Its own two `${CANVAS_URL}`-is-literal comments
(deploy.sh:~149–150 and ~270, explaining the systemd-expands-not-sed rule for the
scribe unit) refresh to `${ENSEMBLEWORKS_URL}` alongside the unit env rename —
they go stale otherwise. The `deploy/agent-home/AGENTS.md` `CANVAS_ROOM`/`CANVAS_URL`
reference is reseed/#4 territory (env rename + `canvas`→`ensembleworks` verb),
carried by `cutover.sh`'s SKILL/guidance reseed (§8), not routine deploys.

---

## 8. `deploy/cutover.sh` — the one-time choreography

A one-shot the operator runs **once** for #8, in front of a normal deploy. It does
the heavy pre-flight the charter keeps *out* of routine deploys, then hands off.

```bash
#!/usr/bin/env bash
# deploy/cutover.sh <ssh-target> <version>
# One-time Phase-3 cutover: prove production data loads under the new binaries,
# back up DATA_DIR (era-exempt), reseed env + SKILL files, then cross the era
# boundary via a normal deploy. Run ONCE; afterwards use deploy/deploy.sh.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SSH_TARGET="${1:?usage: cutover.sh <ssh-target> <version>}"
VERSION="${2#v}"; TAG="v${VERSION}"

# 1. DATA-LOAD CHECK against production copies. Pull rooms/roadmaps/transcripts
#    snapshots to a scratch dir and boot the fetched server binary against THEM
#    (not a scratch DATA_DIR) — every room/roadmap/transcript must load (keel 1,
#    §7.1). Reuses the #7 data-load harness (a bun script that opens each
#    rooms/<room>.sqlite + reads each roadmaps/*.json + tails each transcript
#    jsonl through the compiled binary's /api/health room list). ABORT on any
#    file the new world cannot read.
ssh "$SSH_TARGET" 'bash -s' < deploy/cutover-dataload-check.sh "$VERSION"

# 2. DATA_DIR BACKUP — outside ~/releases so KEEP never prunes it (D8, keel 3).
ssh "$SSH_TARGET" "bash -s" <<'EOF'
  APP_HOME="$(getent passwd ensembleworks | cut -d: -f6)"
  ts="$(date +%Y%m%dT%H%M%S)"
  sudo -u ensembleworks cp -a --reflink=auto \
    "$APP_HOME/.local/share/ensembleworks" "$APP_HOME/backups/pre-cutover-$ts"
  echo "backed up DATA_DIR -> ~/backups/pre-cutover-$ts (rollback across the era boundary)"
EOF

# 3. ENV + SKILL RESEED. Rewrite ~/.config/ensembleworks/*.env CANVAS_* -> ENSEMBLEWORKS_*
#    in the agent + service env files, and install the #4-authored SKILL.md set
#    (canvas, conversation-map, minutes, debugging-roadmap-control) into the
#    sandbox. Files ride from this operator checkout (scp), matching the tag.
scp deploy/cutover-reseed.sh "$SSH_TARGET:/tmp/ew-reseed.sh"
ssh "$SSH_TARGET" 'bash /tmp/ew-reseed.sh'

# 4. Cross the era boundary via a normal deploy (the ONE sanctioned crossing).
EW_ALLOW_ERA_CROSS=1 deploy/deploy.sh "$SSH_TARGET" "$VERSION"

# 5. MANUAL CANVAS-RENDER GATE (mandatory — no automated layer covers it, §4.3).
#    The tldraw licence is baked into client-dist at CI time; a missing/expired
#    key ships a bundle that serves 200 but renders a BLANK editor, and neither
#    the boot-check nor the CI smoke exercises the licence-gated canvas.
cat >&2 <<'CHECK'
==> cutover deployed. BEFORE declaring success, do this by hand:
    1. Open the prod canvas URL in a browser (hard-refresh / incognito).
    2. Confirm the tldraw editor RENDERS — toolbar + shapes visible, NOT a
       blank white frame. A blank frame == the VITE_TLDRAW_LICENSE_KEY secret
       was missing/expired at CI build time (§4.3); re-run release-cli.yml with
       the secret set, then redeploy. Do NOT declare cutover done on a blank canvas.
    3. Restart terminal agents; users hard-refresh. Rollback = ~/backups/pre-cutover-*.
CHECK
```

Steps 1 and 3 factor into small committed helpers (`cutover-dataload-check.sh`,
`cutover-reseed.sh`) so each is independently `shellcheck`-able and testable
against a fake DATA_DIR. The data-load check is the concrete form of design
§7.1's "pre-deploy check confirms every room/roadmap/transcript file loads."
Step 5 is manual by necessity — §4.3 explains why the licence bake cannot be
validated by any automated layer (the local round-trip has no key; the boot/smoke
checks never render the canvas).

---

## 9. The posture-era guard (D7, D8)

**Mechanism.** A committed `deploy/posture-era` file holds the current era token
(`unified-1` for the post-cutover world). `deploy.sh` scp's it and copies it into
each release dir as `~/releases/<ver>/.ew-era` (§6.2). Pre-cutover release dirs —
built by the old `deploy.sh` — have **no** `.ew-era`, which reads as the implicit
`legacy` era.

**The gate**, evaluated just before the `ln -sfn … current` swap. A **fresh box
has no `current`**, which is not an era crossing — a first deploy must always be
allowed. So the guard fires only when there is a *present* live era that
*differs* from the new one; an absent `current` short-circuits to "allowed":

```bash
new_era="$(asapp cat "${NEW}/.ew-era" 2>/dev/null || echo legacy)"
live_target="$(asapp readlink -f "${APP_HOME}/current" 2>/dev/null || true)"
if [ -z "${live_target}" ]; then
  echo "==> first deploy (no current symlink) — era gate not applicable"
else
  live_era="$(asapp cat "${live_target}/.ew-era" 2>/dev/null || echo legacy)"
  if [ "$new_era" != "$live_era" ] && [ "${EW_ALLOW_ERA_CROSS:-0}" != 1 ]; then
    echo "REFUSING era-crossing swap: live='${live_era}' new='${new_era}'." >&2
    echo "  Rollback across the Phase-3 boundary is unsupported (keel 3)." >&2
    echo "  The one-time forward crossing is deploy/cutover.sh (sets EW_ALLOW_ERA_CROSS=1)." >&2
    exit 1
  fi
fi
```

Fail-closed applies only to a **real MISMATCH between two present eras** — never
to a bootstrap. This makes the two dangerous swaps fail loudly: a
`legacy`→`unified-1` forward swap by a hand-run `deploy.sh` on an *already-deployed*
box (must go through `cutover.sh`), and a
`unified-1`→`legacy` **rollback** past the cutover (unsupported — the mitigation
is the `~/backups/pre-cutover-*` copy, D8/keel 3). Swaps *within* an era
(post-cutover `unified-1`→`unified-1` rollback among retained releases) pass
untouched — keel 3's "rollback works within a posture era." Later posture-changing
releases bump `deploy/posture-era`; the same guard then protects that boundary.

The pre-cutover `DATA_DIR` backup is exempt from `KEEP` pruning **structurally**:
it lives in `~/backups/`, and the prune only walks `~/releases/*/` (D8) — no
sentinel or special-case in the prune loop.

---

## 10. Testing — what is realistic

Deploy scripts are not `bun`-runner unit tests, so the suite count is **58 → 58**
(D9). Verification is three concrete, runnable layers:

### 10.1 `shellcheck` on every shipped script

`deploy/deploy.sh`, `install.sh`, `cutover.sh`, and the two cutover helpers pass
`shellcheck` in CI (a lint step in `release-cli.yml`, or the existing lint job).
This catches the quoting/`set -euo pipefail` classes that bite deploy scripts.

### 10.2 `deploy.sh --dry-run`

The refactor in §6.1/§6.3 is what makes this possible: the **fetch and the
`ew_boot_check` function live in `deploy/lib.sh`, not inside the `ssh` remote
heredoc**, so they run locally without a box. A `--dry-run` flag (mirroring
`release.sh`'s `RELEASE_DRY_RUN` and the connector's `--dry-run`) sources
`deploy/lib.sh`, fetches into a local scratch release dir, verifies checksums,
runs `ew_boot_check "$dir" ""` (empty launcher prefix = run as the current user,
no `sudo`), and prints the resolved swap plan (release dir, era tokens, units to
restart, prune set) **without** the `scp`, the `ssh`, the swap, or the restart.
This is the honest unit of "does the verify half work." It exercises the real
`ew_boot_check` on the server + transcriber; it does **not** validate the client
bundle (no licence key locally — §4.3).

### 10.3 The local fake-release round-trip (the #7 dry-run proof, #8's stand-in)

A committed `deploy/test/fake-release.sh` (the repo already has a `deploy/test/`
dir). What it fakes and what it asserts, concretely:

- **Fakes a GitHub release locally.** `bun --cwd {server,cli,transcriber} run
  build:binary` for the host arch; renames to `ensembleworks-server-<pair>`,
  `ensembleworks-<pair>`, `ensembleworks-transcriber-<pair>`; builds a **stub**
  `client-dist.tar.gz` (an empty dir tar — the round-trip proves extraction +
  `CLIENT_DIST` wiring, **not** the licence bake, which it cannot, §4.3);
  `sha256sum … > ensembleworks-checksums.txt`. This `rel/` dir is the fetch
  source (a `file://` path / a local dir the fetch step reads instead of `gh`).
- **Drives the machinery** by sourcing `deploy/lib.sh` and calling its functions
  directly against a throwaway `$HOME`-like tree (`releases/`, `backups/`, a
  `current` symlink) — no `ssh`, no `sudo`, launcher prefix `""`.
- **Asserts:** (1) `sha256sum -c` verifies; a byte-flipped binary makes it fail.
  (2) `ew_boot_check` passes on server sync + term + transcriber `--check`; a
  truncated server binary makes it fail (proves the check actually gates).
  (3) `.ew-era` is stamped from `deploy/posture-era`. (4) the era gate **allows**
  a fresh tree (no `current`), **allows** a same-era swap, **blocks** a
  synthesised cross-era `current` (`legacy` vs `unified-1`), and
  `EW_ALLOW_ERA_CROSS=1` unblocks it. (5) `KEEP` pruning removes the oldest
  releases and never the `~/backups/pre-cutover-*` dir.

**This is the "dry-run proof" #7 owes** — the fetch→verify→boot→era→prune
machinery demonstrated end to end without a production box or a licence key. It
is not a `*.test.ts` (so it does not move the 58-suite count); it is a
`bin/dev`-style scripted smoke, run by hand / in the CI lint job, documented in
the README "Development".

### 10.4 Probes already run (this branch, Bun 1.3.14)

Recorded so the reviewer needn't re-derive them. **These are the checks that were
actually executed** — the term boot-check and transcriber `--check` are new code
(§3.1/§3.3) whose *shape* is specified but which were **not** run as probes:

- **Ran, green:** the `server/src/main.ts` dispatcher compiles both entrypoints
  into one binary (561 modules); `… sync` and `… term` each execute only their
  own listener. Compiled `ensembleworks-server sync` on scratch
  `DATA_DIR`+`CLIENT_DIST`+`PORT` → `GET /api/health` returned
  `200 {"ok":true,"rooms":[]}`.
- **Ran, green:** CLI + server cross-compile to
  `bun-{linux-x64,linux-arm64,darwin-arm64}` / `{linux-x64,linux-arm64}` from one
  x64 host; the transcriber compiles for x64 but only the `-linux-x64-gnu` addon
  exists locally (⇒ D3's native-runner rule).
- **Specified, NOT yet probed:** the `term`-mode `/api/terminal/health` boot-check
  and `ensembleworks-transcriber --check` depend on the new dispatcher subcommand
  and the new `--check` guard; their design is above but they are implementation
  (and `fake-release.sh`) work, not recorded probe results. The framing elsewhere
  in this spec claims only the sync boot-check as "proven."

---

## 11. Risks

- **R1 — transcriber arch integrity is only *checked*, not *exercised*, by a
  routine deploy.** `--check` proves the addon links for the box's arch; it does
  not prove `room.connect()`. Accepted: the pipeline gate is the #6 e2e-gate
  (CI smoke + `cutover.sh` step 1), and the scribe is an optional unit restarted
  only when already enabled. A corrupt/mismatched arm64 addon is caught by
  `--check` (it would fault on load) before the swap.
- **R2 — support-file skew (operator checkout vs the tag).** Units, `tmux.conf`,
  `posture-era`, and agent-home docs ride from the operator's *local* `deploy/`,
  not the release asset — the same property `deploy.sh` already has for unit
  templates. Mitigation: run `deploy.sh` from a checkout at the deployed tag; a
  future slice may ship a `deploy-assets.tar.gz` to close it. Flagged, not fixed.
- **R3 — `gh release download` auth on the box.** Fetching a public release needs
  no token, but rate limits / private-repo futures want one; `deploy.sh` reuses
  the app user's GitHub token seam (already present for the gh-app-token path)
  and falls back to `curl` of the public download URL. `--build-from-source`
  covers an offline/unpushed box.
- **R4 — `--target` string drift.** The Bun-native `x64`/`arm64` asset spelling
  must match `deploy.sh`'s `uname -m` mapping (`x86_64→linux-x64`,
  `aarch64→linux-arm64`) and `install.sh`'s. Pinned in one table per script;
  a mismatch fails the checksum step loudly, not silently.
- **R5 — the era token is a convention, not enforced by content.** Nothing stops
  a mis-edited `deploy/posture-era`. Mitigation: it is a single committed file
  reviewed like code; the gate fails *closed* (any mismatch blocks), so the
  failure mode is a refused deploy, never a silent cross-era swap.
```
