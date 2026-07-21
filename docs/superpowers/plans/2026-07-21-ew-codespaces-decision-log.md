# EW Codespaces — orchestration decision log

Running log of high-level choices made under delegated authority during the
autonomous implementation of
`docs/superpowers/specs/2026-07-21-ew-codespaces-coexistence-design.md`.
One dated entry per decision; newest last.

- **2026-07-21 — Orchestration structure.** One workflow per sub-project,
  tasks strictly sequential (shared working tree, same branch). Per task:
  Sonnet implements (TDD per the plan), Opus adversarially reviews (re-runs
  tests itself, never trusts the implementer's report), Sonnet fixes, max 3
  review rounds. Fable (main session) gates between sub-projects and authors
  the next plan. All commits to `docs/ew-codespaces-design` (PR #53) per
  owner instruction.
- **2026-07-21 — Bun-compat spike runs early, in parallel with sub-project 1.**
  The spike gates sub-project 2's embedding approach; running it first
  converts the riskiest unknown into a plan input before the plan is written.
  Spike works only in the scratchpad, never the repo tree.
- **2026-07-21 — INCIDENT: spike agent deleted 11 unrelated devcontainers.**
  During cleanup the spike agent ran `docker ps -a --filter
  "label=devcontainer.local_folder" -q | xargs docker rm -f` — the filter
  matched every devcontainer on the host, not just its test container.
  Deleted: ensembleworks, ensembleworks-zoom, ensembleworks-t3code,
  ensembleworks-opencode-web, ensembleworks-ghosttyweb, agentic-business-os,
  finrisk-demo-nix, wctf, laingville, a gateway-go feature-build container.
  Source files are untouched (host bind mounts); named volumes intact; lost is
  only per-container writable-layer state (ad-hoc installs, running
  processes). Decision: NO automatic restoration — recreating other projects'
  containers can trigger builds/postCreate hooks; left to the owner
  (`devcontainer up --workspace-folder <path>` per project, or `bin/dev up`
  for ensembleworks). Spike continues under a new hygiene rule: destructive
  commands only against explicitly enumerated IDs the agent itself created.
- **2026-07-21 — Bun-compat spike verdict: PASS. Embedding approach B
  confirmed.** `@devcontainers/cli@0.87.0` under Bun 1.3.14: `--help`,
  `read-configuration`, `up`, `exec`, `build` all pass against real Docker,
  no code changes. The npm package is one self-contained esbuild bundle
  (1.9MB total, zero runtime node_modules — proven by running an isolated
  copy). Decision: pin 0.87.0, embed the two files as compiled-binary assets,
  extract on first run, exec via `bun <path>/devcontainer.js`. No fallback
  path built (design doc §2.2 fallbacks stay theoretical). Residual risks
  accepted: two dynamic-require edge paths (devcontainer.json `extends` →
  node package; NODE_PATH fallback) untested; OCI Features not exercised
  end-to-end — covered later by the conformance smoke test's features-heavy
  repo. Spike report: scratchpad `bun-spike/bun-spike-report.md`.
- **2026-07-21 — SP3 design decisions (from recon findings):**
  1. *Container = `BaseBoxShapeUtil` + explicit `parentId` on child creation*,
     not `BaseFrameLikeShapeUtil` — children transform with any parent in
     tldraw 5; drag-to-reparent-by-drop is deferred (YAGNI).
  2. *Live state (status/owner/inputPolicy) is NOT stored in synced shape
     props* — deviation from the spec's §5 prop list. The gateway registry is
     the single source of truth; the shape polls `GET /api/terminal/list`
     (~5s while mounted) and renders status dot/owner/lock from it. Avoids
     building a registry→tldraw-store push channel (recon confirmed
     connect/disconnect events currently only log). Shape props carry only
     identity: `gatewayId`, `repo`, `branch`.
  3. *Input-policy defaults*: a registration carrying `repo` metadata is a
     codespace → defaults `locked`; a plain gateway (bare `terminal
     connect`) defaults `shared` — preserving today's behavior exactly.
     Policy state lives in the registry keyed by gatewayId, survives
     reconnects within a server lifetime, resets to default on server
     restart (safe direction: resets to locked for codespaces).
  4. *Enforcement*: viewer identity resolved via `resolveGatewayOwner` at
     relay attach (the seam recon identified — relay currently does zero
     identity resolution); channels map carries viewer identity; when locked
     and viewer ≠ owner, `input` frames dropped at the relay, `resize`
     still allowed. No new wire message types — the client derives its
     read-only state from list() + whoami and disables stdin locally
     (server remains the authority).
  5. *ux-contract: opt-out.* The CI gate's prefixes and CLAUDE.md's list both
     cover only canvas-v2 surfaces (`canvas-editor/src/tools/`,
     `canvas-react/src/`, `client/src/canvas-v2/`); the legacy-tldraw
     codespace shape is outside both, and the contract runners drive the
     canvas-v2 stack. PR body will record: `ux-contract: none — legacy
     tldraw shape; contract runners target the canvas-v2 stack; obligations
     attach at the v2 port`.
  6. *Plans for SP2–SP5 are authored by fable-model Plan subagents* from my
     briefs + recon files, reviewed by me before their workflows launch —
     preserves main-loop context across the whole program.
- **2026-07-21 — SP2 design decisions (spike + flag verification in hand):**
  1. *Vendor, don't fetch:* the pinned `@devcontainers/cli@0.87.0` bundle
     (`devcontainer.js` + `dist/spec-node/devContainersSpecCLI.js`, 1.9MB
     total, zero runtime deps — spike-proven) is committed under
     `cli/vendor/devcontainers-cli/` with a re-vendoring script; version
     bumps are deliberate acts gated by the conformance smoke test.
  2. *Runner unification via `BUN_BE_BUN=1`* (spike-verified): dev mode runs
     `bun <vendored path>`; a compiled `ew` re-invokes ITSELF with
     `BUN_BE_BUN=1` as the runtime for the extracted bundle — no bun install
     needed on target machines. Container id comes from `up`'s stdout JSON
     (`{outcome, containerId, remoteUser, remoteWorkspaceFolder}`).
  3. *Injection:* `up --mount type=bind,source=<staged runtime
     dir>,target=/ew` (read-only staging dir under the state root), connector
     started via `devcontainer exec` with creds passed `--remote-env`
     (accepted v1: env values briefly visible in host process listings).
     Connector binary resolution: `EW_CONNECTOR_BIN` env override →
     `process.execPath` when running compiled → clear error telling the user
     to build (tests set the override).
  4. *`ew codespace up` is a foreground supervisor in v1* — build → inject →
     run connector with restart/backoff until Ctrl-C. Daemonization belongs
     to SP4's reconciler.
  5. *Per-checkout identity in `~/.config/ensembleworks/codespaces.json`*
     (grows into SP4's desired-state store): gatewayId `cs-<dirname>-<hash>`
     keyed by the checkout's real path, plus last containerId for `stop`.
  6. *`stop` = docker stop by exact stored containerId; `rebuild` = `up
     --remove-existing-container`; `list` = store + registry liveness.*
     (Exact-ID-only rule from the incident is design policy now.)
  7. *Conformance smoke = repo-level script `scripts/codespace-conformance.ts`*,
     excluded from the default test glob (needs Docker + network): two local
     fixture devcontainers (plain debian-based image; features-heavy) booted
     through the real `ew codespace up` against an ephemeral `createSyncApp`,
     asserting a terminal echo round-trips via the relay.
  8. *Arch boundary accepted:* the connector is a bun-compiled glibc x64
     binary — musl (alpine) and non-x64 containers are documented
     out-of-scope for v1; conformance fixtures use debian-based images.
- **2026-07-21 — SP1 gate: PASS.** Workflow completed all 6 tasks, 0 fix
  rounds, 12 agents. Orchestrator independently re-ran
  `session-manager.test.ts`, `spawn-spec.test.ts`, and the booted
  `connector-pty-loopback.test.ts` — all green; diff (95b0bec..f1ad02e)
  matches the plan's file map exactly. `--backend pty` is live behind the
  unchanged `tmux` default.
- **2026-07-21 — Unattributed commit observed on the branch:** `e5bb4ef
  docs(netguard): egress-proxy spec` appeared mid-run — not produced by this
  orchestration (workflow commit list is complete without it; planners are
  no-commit). Presumed to be a parallel session of the owner's. Left
  untouched; explicitly NOT added to the implementation scope — the
  program remains the five coexistence sub-projects unless the owner says
  otherwise.
