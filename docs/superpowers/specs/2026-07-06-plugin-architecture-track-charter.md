# Plugin-architecture track charter

**Settled with the user 2026-07-06.** This is the constitution for the
autonomous track defined in
`2026-07-06-plugin-architecture-track-design.md`. Every subagent spec/plan
must conform; a decision not covered here that is (a) a product choice or
(b) a cross-slice convention is **out of charter → escalate to the user**.
Produced by a 6-agent mining sweep over `docs/unified-architecture-design.md`,
existing specs, and code; recommendations arbitrated by the user.

## Scope amendment (user, 2026-07-06)

**Phase 5 (memory service) is DEFERRED out of the track.** Queue is now:
Phase 3 remainder → #8 cutover (manual) → Phase 4 → Phase 6. The two
memory-specific decisions (embedding default, memoryHooks versioning) are
parked, to be settled if/when Phase 5 is picked up.

## User-arbitrated decisions

1. **Connector ships in the cutover.** #5 (native Bun `terminal connect`) is
   built as its own reviewed slice pre-cutover; #8 retires `gateway-go/`,
   `connect.sh`, and the standalone termgw artifact. This **supersedes** the
   CLI miner's defer-past-cutover recommendation.
2. **Terminal plane stays a separate process.** The :8789 gateway keeps its
   process boundary (TERM_RUN_AS privilege separation, one-static-binary
   deploy) but its routes relabel to `/api/terminal/*`; Caddy splits the
   prefix between :8788 (relay plane) and :8789 (local plane). Client/CLI
   see one namespace.
3. **`ensembleworks` is the canonical documented spelling** (help, errors,
   SKILL.md); `ew` is a convenience hardlink mentioned once at install.
4. **Phase 5 deferred** (above).
5. **Attribution bundle pinned** (see 3c below).
6. **Transcriber gate:** compiled Bun binary must complete a real
   `room.connect()` → subscribe → segment → STT → `POST /api/transcript`
   end-to-end; **no Node fallback**. Failure blocks the slice and escalates.
7. **All remaining decisions pinned to the mined recommendations** (below);
   the user may amend any line before the first autonomous slice starts.

## 3a — Clean per-plugin routes

- **The pinned route table** (old → new; no aliases survive):
  - `av` plugin: `GET /api/livekit-token` → `GET /api/av/token`;
    `POST /api/kick` → `POST /api/av/kick`; `POST /api/pulse` → `POST /api/av/pulse`.
  - `canvas` plugin (stickies/frames): `POST /api/sticky` → `POST /api/canvas/sticky`;
    `POST /api/shape` → `POST /api/canvas/shape`; `GET /api/frames` → `GET /api/canvas/frames`;
    `GET /api/frame` → `GET /api/canvas/frame`.
  - `roadmap` plugin: `GET/POST /api/roadmap` → `/api/roadmap/…` (leaf names
    per slice plan, prefix pinned).
  - `scribe` plugin: `GET/POST /api/transcript` → `/api/scribe/transcript`.
  - `terminal` plugin: `POST /api/terminal-status` → `POST /api/terminal/status`;
    `GET /api/gateway/list` → `GET /api/terminal/list`;
    WS `/api/gateway/connect` → WS `/api/terminal/connect`;
    WS `/api/term/relay` → WS `/api/terminal/relay`; and on :8789
    `GET /term/health` → `GET /api/terminal/health`;
    `GET/DELETE /term/sessions[/:id]` → `/api/terminal/sessions[/:id]`;
    WS `/term/ws` → WS `/api/terminal/ws`.
  - **Kernel-reserved (unprefixed):** `/api/health`, `/api/whoami`,
    `/api/participants` (moved off the av router — it reads kernel presence,
    not AV state), `/api/tools` (Phase 4), `/mcp` (Phase 4),
    WS `/sync/:roomId`, `GET /*` static.
  - **Blobs:** `PUT/GET /uploads/:id` **stays top-level** as a kernel blob
    service — the path is embedded in persisted tldraw asset URLs (keel:
    rooms load unchanged) and must dodge the `/api` JSON parser.
- **Prefix rule:** prefix = plugin id from design §3 (`canvas`, `scribe`,
  `terminal`), even where it differs from the historical noun; the noun
  survives only as leaf/CLI verb.

## 3c — Attribution (the pinned bundle)

- Server stamps **structured `meta.author`** from `Whoami` (authoritative)
  AND renders the visible `🤖 <identity>: ` text prefix; bin/canvas → CLI
  stops client-side prefixing.
- New **optional `body.author`** field on mutating canvas routes; `--author`
  sends it; no more prefix-baked-into-text on the wire.
- **Credentialed writes: caller-supplied author is IGNORED** — server always
  stamps `Whoami.identity` (roadmap.ts precedent). No must-match 4xx class.
- **Anonymous/dev writes stamp nothing**; on "none" instances the voluntary
  `--author` passes through unchanged. Never fabricate an `anonymous`/`dev`
  author label.
- One **shared stamp helper** applied uniformly to canvas content-write
  routes (sticky, shape, roadmap). **No backfill** of existing records.

## #4 — The `ensembleworks` CLI

- Spelling: per user decision 3 above.
- **hosts.toml:** top-level `default_instance` key set by the last
  `auth login`; env vars merge **per-variable** over the resolved instance
  (the GH_TOKEN pattern) — a lone `ENSEMBLEWORKS_URL` does not discard file
  credentials. hosts.toml is an **auth-only** file (no gateway identity).
- **auth login:** paste-from-CF-dashboard now (collect id+secret, verify via
  `/api/whoami`); documented seam for a mint/admin flow later. The
  common_name → identity mapping stays server-side in `service-tokens.toml`.
- **Manifest cache:** fetch on cache-miss only + explicit `--refresh` /
  `tools refresh`; never auto-refetch on hit.
- **MVP scope:** full — all bin/canvas verbs 1:1, `auth login/status/logout`,
  and native `terminal connect` (user decision 1).
- **SKILL.md reseed:** the CLI slice owns rewriting all four skill files
  (canvas, conversation-map, minutes, debugging-roadmap-control) atomically
  with the binary — nothing lands until skills match.

## #5 — Connector / #6 — Transcriber

- **Env mapping (clean break):** `CANVAS_URL` → `ENSEMBLEWORKS_URL`;
  `CF_ACCESS_CLIENT_ID/SECRET` → `ENSEMBLEWORKS_TOKEN_ID/_TOKEN_SECRET`.
  `--gateway-id` / `--label` flags; gateway-id defaults to a **stable
  per-box id (not bare hostname** — hostname collisions would trip
  `resolveGatewayOwner` binding); label defaults to hostname.
- **Relay parity contract pinned in `contracts/`** (+ test coverage beyond
  relay-loopback): 1s base / 30s cap exponential backoff with 0.8–1.2×
  jitter (exponent `min(attempt-1,5)`); 30s healthy-duration counter reset;
  20s ping loop (matches splicer heartbeat); 1 MiB read limit; 64-deep
  per-channel queues that shed rather than block.
- **Shared tmux policy helper in contracts** (e.g. `canvasTmuxSpawnSpec`):
  `canvas-` prefix, `new-session -A`, conf-exists check, TERM=xterm-256color
  — consumed by both server gateway and connector (kills the "must match
  terminal-gateway.ts" comment class).
- **Packaging: single `ensembleworks` binary only.** Devcontainer feature
  installs it and runs `terminal connect`; retire connect.sh + standalone
  artifact.
- **Transcriber:** gate per user decision 6. Env rename only
  (`ENSEMBLEWORKS_URL/_ROOM`); the scribe is a co-located localhost "none"
  worker (no service token, not in hosts.toml); write-scope passing
  anonymous covers it.

## #7 — Distribution / #8 — Cutover

- **Artifacts:** `ensembleworks-<component>-<os>-<arch>` with Bun-native
  `x64`/`arm64` spelling (matches `--target bun-linux-x64`); ship
  server+CLI+transcriber for linux-{x64,arm64} plus CLI darwin-arm64;
  **musl stays deferred** until an Alpine box exists.
- **deploy.sh verify = checksum + pre-swap boot-check** (run the fetched
  binary against a scratch port/DATA_DIR before touching `current`); the
  heavier data-load pre-flight belongs to the cutover script, not routine
  deploys.
- **systemd: keep exactly three units** (`sync`, `term`, `scribe`); only
  swap ExecStart to absolute binary paths and `CANVAS_*` →
  `ENSEMBLEWORKS_*`. The term unit's `KillMode=process` tmux-survival
  choreography is **load-bearing and must survive**.
- **CLIENT_DIST ships alongside** (`client-dist.tar.gz` extracted into the
  release dir; unit points CLIENT_DIST at it) — not embedded in the binary.
- **Cutover choreography lives in a separate one-shot `deploy/cutover.sh`**
  (data-load check against prod copies + DATA_DIR backup + env/SKILL.md
  reseed) that then calls the normal deploy.sh.
- **Era guard:** stamp each release dir with a posture-era marker;
  deploy.sh refuses to swap `current` across eras. The pre-cutover DATA_DIR
  backup is exempt from KEEP pruning.

## Phase 4 — Registry + MCP (gated slice; conventions pre-pinned)

- **Tool definitions:** `contracts/src/tools/<plugin>.ts`, each verb
  `{ id, zodInput, zodOutput, http: {method, path}, help }`; a kernel tool
  registry mounts HTTP, serves `/api/tools`, and backs `/mcp`. **Exempt from
  tool-hood:** health, static, uploads binary, WS upgrades, `/mcp` itself.
- **MCP write scoping:** binary read-only/read-write stays the v1 default;
  optional **per-token tool-id allowlist** enforced at registry dispatch,
  falling back to the coarse scope when absent.
- **docStore envelope:** `{ rev, updated, schemaVersion, data }`
  byte-compatible with today's roadmap files (absent schemaVersion = v0);
  extract the duplicated rev-fan-out as the one shared mechanism;
  terminal-status becomes an **ephemeral (non-persisted)** docStore sharing
  only the fan-out.

### Ratified extensions (user, 2026-07-06, via 3b panel escalation)

- **ToolDef has a 6th field `plugin`** (beyond the five pinned above) —
  required for globally-unique MCP tool names `${plugin}.${id}`.
- **The `/api/tools` envelope:** flat `tools[]` of
  `{plugin, id, method, path, help, input, output}` (input/output are JSON
  Schema via zod's native `z.toJSONSchema`), plus `version: 1` (format
  version the CLI cache keys on) and an informational `server` build string.
  Grouping is client-side; the shape matches a future MCP `tools/list`.

## Phase 6 — Plugin packages (gated slice; conventions pre-pinned)

- **`ensembleworks.config.ts`:** typed
  `defineConfig({ plugins: [...], profiles: { default, ... } })`; per-plugin
  config validated by each plugin's Zod schema (ctx.config); the default
  profile lists **exactly the Phase-3 plugin set** (keel: unmodified
  deploy.sh run is a no-op upgrade).
- **Seed layouts stay code** (client menu entries) in v1; revisit only if
  non-developers need to author layouts.

## Standing conventions (unchanged, restated for agent briefings)

Bun 1.3.14 only (`export PATH="$HOME/.local/share/mise/installs/bun/1.3.14/bin:$PATH"`);
tabs in `server/src/*`; self-running `bun src/x.test.ts` test scripts ending
`console.log('ok: …')` discovered by `scripts/run-tests.ts`; commit trailer
`Co-Authored-By: Claude <noreply@anthropic.com>` +
`Claude-Session: https://claude.ai/code/session_01HfDBiUzPoSUBADt5QpaVTC`;
worktrees under `.worktrees/<slice>`; merges `--no-ff` into
`unified-architecture-migration`, full suite green on the merged result;
sonnet implementers, opus for spec/plan/review judgment.
