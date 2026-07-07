# #8 Cutover readiness packet

**The autonomous plugin-architecture track is complete.** Every pre-cutover
slice is merged on `unified-architecture-migration` (suite 59 green). This is
the packet the track owes before the **#8 cutover — the production deploy,
which is the operator's (your) decision and run**. Produced by a 4-lens
phase-boundary review (correctness/integration, security posture, data-keel
integrity, charter-drift) 2026-07-07; the blocking + cheap track-owned
findings were fixed (merge `eb6d6d5`); the rest are your runbook items below.

## Readiness verdict

**Ready to schedule #8, with the operator prerequisites below.** Three of four
lenses returned ready-with-notes; the keel lens's one blocking finding (the
data-load pre-flight couldn't actually load a room) is **fixed and verified**
— `EW_WARM_ROOMS=1` now forces every `rooms/<room>.sqlite` through the
`@tldraw` schema at boot, so `cutover-dataload-check.sh` genuinely proves prod
rooms import under the new binary (a corrupt/incompatible sqlite fails the
boot-check and aborts the cutover, fail-closed).

## What the track already fixed (merge `eb6d6d5`)

1. **Data-load check works** — `EW_WARM_ROOMS` eager warm-load (`server/src/app.ts`),
   wired into `deploy/cutover-dataload-check.sh`; regression test
   `server/src/warm-rooms.test.ts`.
2. **Auth posture is observable** — `sync-server.ts` now logs
   `auth posture: verified | header-trust` at boot, so you can confirm from the
   log which mode production came up in (see prerequisite 2).
3. **Agent guidance reseeded** — `deploy/agent-home/AGENTS.md` rewritten from
   the retired `canvas <verb>` / `CANVAS_*` to `ensembleworks …` /
   `ENSEMBLEWORKS_*` (the four `.claude/skills/*/SKILL.md` were already done in #4).

## Operator prerequisites — MUST do before/at #8

1. **Provision the connector service token (else remote terminals silently
   vanish).** On the authenticated prod instance the terminal gateway flips
   from anonymous to requiring identity: `resolveGatewayOwner` returns null for
   an unmapped caller → the WS registration is refused with only a server-side
   `console.warn`. **Before restarting terminal agents:** add the connector's
   CF Access service-token `common_name` → identity (+ write-scope) to
   `~/.config/ensembleworks/service-tokens.toml` on the prod box, and verify via
   `GET /api/whoami` with that token. Nothing in `cutover.sh` seeds this file.
2. **Confirm `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` survive the env reseed.**
   These two vars are the single switch behind the ENTIRE fail-closed posture
   (JWT signature verification AND strict gateway rejection). `cutover-reseed.sh`
   only rewrites `CANVAS_*`→`ENSEMBLEWORKS_*` in `sync.env`; it does not assert
   CF_ACCESS_* are present. After the reseed, check the new sync-server boot log
   reads **`auth posture: verified`** — if it says `header-trust`, production is
   trusting edge headers unverified (only the Cloudflare tunnel stripping
   inbound `Cf-Access-*` stands between that and spoofing). Do not proceed until
   it reads `verified`.
3. **Manual canvas-render check (tldraw license key).** No automated layer can
   catch a blank-canvas bundle (the license key is build-time baked; boot-check
   only asserts health+static). `cutover.sh` step 5 prompts for it — after the
   swap, load the prod canvas and confirm the editor renders, not blank. The CI
   `client-dist` job fails loudly if `VITE_TLDRAW_LICENSE_KEY` is absent, and the
   `BUILD_FROM_SOURCE` path now sources `build.env` + warns if absent.

## #8 must-do (work the charter assigned to the cutover, not yet built)

1. **Create the `ensembleworks-cli` devcontainer feature; retire
   `gateway-go/termgw-feature/`.** Charter §#5 assigns this to #8. #7 shipped
   `install.sh` only. Remote boxes/Codespaces that bootstrap a terminal via the
   devcontainer feature need a feature that installs `ensembleworks` and runs
   `ensembleworks terminal connect` (same entrypoint/supervisor pattern as the
   Go termgw-feature). Local `.devcontainer/` does not depend on it (not a
   local-dev blocker).
2. **Confirm where prod canvas agents load skills from.** #4 reseeded the repo's
   four `.claude/skills/*/SKILL.md`; if prod agents run from a repo checkout they
   get them for free, but if they load from the agent sandbox home, the four
   skills must be shipped there too (only `AGENTS.md` + `CLAUDE.md` are seeded by
   `deploy.sh` today). Verify the topology; add the skills to the sandbox seed if
   needed.

## #8 must-delete (retired at cutover — all verified still present, boundary held)

- `gateway-go/` (the Go connector + `termgw-feature/`) — superseded by the Bun
  connector (#5).
- `sample-remote-terminal/connect.sh` — superseded by `ensembleworks terminal connect`.
- `bin/canvas` — superseded by the `ensembleworks` CLI (#4).
- `.github/workflows/release-termgw.yml` — already deleted by #7.
- node-pty, Node host/engine pins — already gone.

## Awareness (acceptable-by-design, but know it)

- **Remote terminals are a team-wide surface, not per-user sandboxes.**
  `/api/terminal/list` returns all gateways to any authenticated caller and
  `/api/terminal/relay` performs no owner-vs-caller check — any teammate past CF
  Access who knows a `gatewayId`+`sessionId` can attach to any terminal. The
  connect-side identity binding (#5) only governs who can *register* a gateway,
  not who can *attach*. Fine for a single trusted team behind CF Access; a
  per-identity attach check would be a future slice if that changes.

## The routine deploy vs the cutover

- `deploy/deploy.sh <target> <version>` — the routine fetch-verify-swap (checksum
  + pre-swap boot-check + era-gate + KEEP=3). Refuses a cross-era swap without
  `EW_ALLOW_ERA_CROSS=1`; a fresh box is allowed.
- `deploy/cutover.sh` — the one-shot: data-load check → DATA_DIR backup
  (`~/backups/`, KEEP-exempt) → env/SKILL reseed → `EW_ALLOW_ERA_CROSS=1 deploy.sh`
  → the manual canvas-render prompt. This is the sanctioned era crossing.
- `deploy/test/fake-release.sh` — the local, no-box integration proof of the
  whole machinery (verify/boot-check/era-gate/prune, incl. negative cases).
  Green.

## After #8

Phase 4 (docStore generalisation + routes-as-tools + `/mcp`) is queued on the
branch (gated). Phase 5 (memory) is deferred out of the track. Phase 6 (plugin
packages) is gated. See the charter's Phase-4/6 sections (conventions
pre-pinned) and the track-state doc.
